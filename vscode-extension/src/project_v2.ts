import * as path from 'path';

export type ProjectCardRef = {
    id: string;
    kind: 'function' | 'class' | 'method' | 'nested_function' | 'nested_class' | 'note';
};

export type ProjectDocument = {
    id: string;
    path: string;
    cards: ProjectCardRef[];
};

export type ProjectNote = {
    id: string;
    title: string;
    body: string;
    attachedTo: string | null;
};

export type ProjectV2 = {
    schemaVersion: 2;
    id: string;
    name: string;
    root: string;
    documents: ProjectDocument[];
    notes: ProjectNote[];
    layout: Record<string, { x: number; y: number }>;
    queue: {
        scope: 'project' | 'selection' | 'subgraph';
        entries: Array<{ cardId: string; status: 'pending' | 'active' | 'blocked' | 'skipped' }>;
    };
};

export type ProjectLoadResult = {
    project: ProjectV2;
    migrated: boolean;
    readOnly: boolean;
    warnings: string[];
};

export class ProjectFormatError extends Error {}

const CARD_KINDS = new Set<ProjectCardRef['kind']>([
    'function', 'class', 'method', 'nested_function', 'nested_class', 'note',
]);

function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ProjectFormatError(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
    if (typeof value !== 'string') throw new ProjectFormatError(`${label} must be a string`);
    return value;
}

function nonEmptyString(value: unknown, label: string): string {
    const parsed = string(value, label);
    if (!parsed) throw new ProjectFormatError(`${label} must not be empty`);
    return parsed;
}

function finite(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ProjectFormatError(`${label} must be a finite number`);
    }
    return value;
}

function array(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) throw new ProjectFormatError(`${label} must be an array`);
    return value;
}

function assertKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
    const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
    if (unexpected.length) throw new ProjectFormatError(`${label} has unsupported fields: ${unexpected.join(', ')}`);
}

function relativePath(value: unknown, label: string, extension?: string): string {
    const candidate = string(value, label).replace(/\\/g, '/');
    if (!candidate || candidate.startsWith('/') || /^[A-Za-z]:\//.test(candidate)) {
        throw new ProjectFormatError(`${label} must be a relative path`);
    }
    const normalized = path.posix.normalize(candidate);
    if (normalized === '..' || normalized.startsWith('../') || (extension && !normalized.endsWith(extension))) {
        throw new ProjectFormatError(`${label} must be a safe project-relative${extension ? ` ${extension}` : ''} path`);
    }
    return normalized;
}

function parseLayout(value: unknown): ProjectV2['layout'] {
    const layout = record(value, 'layout');
    const parsed: ProjectV2['layout'] = {};
    for (const [id, rawPosition] of Object.entries(layout)) {
        const position = record(rawPosition, `layout.${id}`);
        assertKeys(position, ['x', 'y'], `layout.${id}`);
        parsed[id] = {
            x: finite(position.x, `layout.${id}.x`),
            y: finite(position.y, `layout.${id}.y`),
        };
    }
    return parsed;
}

export function createProjectV2(name: string, documents: ProjectDocument[] = []): ProjectV2 {
    return {
        schemaVersion: 2,
        id: globalThis.crypto.randomUUID(),
        name,
        root: '.',
        documents,
        notes: [],
        layout: {},
        queue: { scope: 'project', entries: [] },
    };
}

export function parseProjectV2(value: unknown): ProjectV2 {
    const project = record(value, 'project');
    assertKeys(project, ['schemaVersion', 'id', 'name', 'root', 'documents', 'notes', 'layout', 'queue'], 'project');
    if (project.schemaVersion !== 2) throw new ProjectFormatError(`unsupported project schema version ${String(project.schemaVersion)}`);
    const documents = array(project.documents, 'documents').map((entry, documentIndex): ProjectDocument => {
        const document = record(entry, `documents[${documentIndex}]`);
        assertKeys(document, ['id', 'path', 'cards'], `documents[${documentIndex}]`);
        const cards = array(document.cards, `documents[${documentIndex}].cards`).map((cardValue, cardIndex): ProjectCardRef => {
            const card = record(cardValue, `documents[${documentIndex}].cards[${cardIndex}]`);
            assertKeys(card, ['id', 'kind'], `documents[${documentIndex}].cards[${cardIndex}]`);
            const kind = string(card.kind, `documents[${documentIndex}].cards[${cardIndex}].kind`);
            if (!CARD_KINDS.has(kind as ProjectCardRef['kind'])) {
                throw new ProjectFormatError(`unsupported card kind ${kind}`);
            }
            return { id: nonEmptyString(card.id, 'card.id'), kind: kind as ProjectCardRef['kind'] };
        });
        return {
            id: nonEmptyString(document.id, `documents[${documentIndex}].id`),
            path: relativePath(document.path, `documents[${documentIndex}].path`, '.py'),
            cards,
        };
    });
    const paths = new Set<string>();
    for (const document of documents) {
        if (paths.has(document.path)) throw new ProjectFormatError(`duplicate document path ${document.path}`);
        paths.add(document.path);
    }
    const notes = (project.notes === undefined ? [] : array(project.notes, 'notes')).map((noteValue, index): ProjectNote => {
        const note = record(noteValue, `notes[${index}]`);
        assertKeys(note, ['id', 'title', 'body', 'attachedTo'], `notes[${index}]`);
        return {
            id: nonEmptyString(note.id, `notes[${index}].id`),
            title: nonEmptyString(note.title, `notes[${index}].title`),
            body: string(note.body, `notes[${index}].body`),
            attachedTo: note.attachedTo === null ? null : nonEmptyString(note.attachedTo, `notes[${index}].attachedTo`),
        };
    });
    if (new Set(notes.map(note => note.id)).size !== notes.length) {
        throw new ProjectFormatError('note ids must be unique');
    }
    const queue = record(project.queue, 'queue');
    assertKeys(queue, ['scope', 'entries'], 'queue');
    const scope = string(queue.scope, 'queue.scope');
    if (!['project', 'selection', 'subgraph'].includes(scope)) throw new ProjectFormatError(`unsupported queue scope ${scope}`);
    const entries = array(queue.entries, 'queue.entries').map((entryValue, index) => {
        const entry = record(entryValue, `queue.entries[${index}]`);
        assertKeys(entry, ['cardId', 'status'], `queue.entries[${index}]`);
        const status = string(entry.status, `queue.entries[${index}].status`);
        if (!['pending', 'active', 'blocked', 'skipped'].includes(status)) {
            throw new ProjectFormatError(`unsupported queue status ${status}`);
        }
        return {
            cardId: nonEmptyString(entry.cardId, `queue.entries[${index}].cardId`),
            status: status as ProjectV2['queue']['entries'][number]['status'],
        };
    });
    return {
        schemaVersion: 2,
        id: nonEmptyString(project.id, 'project.id'),
        name: nonEmptyString(project.name, 'project.name'),
        root: project.root === '.' ? '.' : relativePath(project.root, 'project.root'),
        documents,
        notes,
        layout: parseLayout(project.layout),
        queue: { scope: scope as ProjectV2['queue']['scope'], entries },
    };
}

function migrateLegacy(value: Record<string, unknown>): ProjectLoadResult {
    const docs = array(value.docs, 'legacy docs');
    const documents: ProjectDocument[] = docs.map((entry, index) => {
        const document = record(entry, `legacy docs[${index}]`);
        const title = string(document.title, `legacy docs[${index}].title`).replace(/[^A-Za-z0-9_.-]/g, '_');
        const destination = typeof document.destination === 'string'
            ? document.destination.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
            : '';
        const documentPath = relativePath(`${destination ? `${destination}/` : ''}${title}.py`, `legacy docs[${index}] path`, '.py');
        const cards: ProjectCardRef[] = Array.isArray(document.cards)
            ? document.cards.flatMap((cardValue): ProjectCardRef[] => {
                const card = record(cardValue, 'legacy card');
                if (typeof card.id !== 'string' || card.kind === 'header') return [];
                return [{ id: card.id, kind: 'function' }];
            })
            : [];
        return {
            id: typeof document.id === 'string' ? document.id : `legacy-document-${index + 1}`,
            path: documentPath,
            cards,
        };
    });
    const project = createProjectV2(typeof value.name === 'string' ? value.name : 'Migrated Slate project', documents);
    if (typeof value.id === 'string') project.id = value.id;
    return {
        project,
        migrated: true,
        readOnly: false,
        warnings: ['Legacy project metadata was migrated in memory. Save the project to persist schema v2.'],
    };
}

export function loadProject(text: string): ProjectLoadResult {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new ProjectFormatError(`project is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const object = record(value, 'project');
    if (object.schemaVersion === 2) {
        return { project: parseProjectV2(object), migrated: false, readOnly: false, warnings: [] };
    }
    if (Array.isArray(object.docs)) return migrateLegacy(object);
    if (typeof object.schemaVersion === 'number' && object.schemaVersion > 2) {
        const documents: ProjectDocument[] = Array.isArray(object.documents)
            ? object.documents.flatMap((entry, index): ProjectDocument[] => {
                try {
                    const document = record(entry, `documents[${index}]`);
                    return [{
                        id: typeof document.id === 'string' && document.id ? document.id : `future-document-${index + 1}`,
                        path: relativePath(document.path, `documents[${index}].path`, '.py'),
                        cards: [],
                    }];
                } catch {
                    return [];
                }
            })
            : [];
        const project = createProjectV2(
            typeof object.name === 'string' && object.name ? object.name : 'Unsupported Slate project',
            documents,
        );
        if (typeof object.id === 'string' && object.id) project.id = object.id;
        if (object.root === '.') project.root = '.';
        else if (typeof object.root === 'string') project.root = relativePath(object.root, 'project.root');
        return {
            project,
            migrated: false,
            readOnly: true,
            warnings: [`Project schema v${object.schemaVersion} is newer than this extension. Source is read-only.`],
        };
    }
    throw new ProjectFormatError(`unsupported project schema version ${String(object.schemaVersion ?? 'missing')}`);
}

export function serializeProject(project: ProjectV2): string {
    return `${JSON.stringify(parseProjectV2(project), null, 2)}\n`;
}
