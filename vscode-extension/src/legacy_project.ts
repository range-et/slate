import type { HarnessDocument, HarnessGraphEdge } from './harness_protocol';

interface LegacyCard {
    title?: unknown;
    links?: unknown;
}

interface LegacyDocument {
    title?: unknown;
    destination?: unknown;
    cards?: unknown;
}

function normalizePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

export function readProjectBinding(rawProject: string): { name?: string; root: string } {
    try {
        const value = JSON.parse(rawProject) as { name?: unknown; root?: unknown };
        const root = typeof value.root === 'string'
            && !/^(?:\/|[A-Za-z]:[\\/])/.test(value.root)
            ? value.root
            : '.';
        return {
            name: typeof value.name === 'string' && value.name ? value.name : undefined,
            root,
        };
    } catch {
        return { root: '.' };
    }
}

export function readProjectLayout(rawProject: string): Record<string, { x: number; y: number }> {
    try {
        const value = JSON.parse(rawProject) as { layout?: unknown };
        if (!value || typeof value !== 'object' || !value.layout || typeof value.layout !== 'object') return {};
        return Object.fromEntries(Object.entries(value.layout).filter((entry): entry is [string, { x: number; y: number }] => {
            const point = entry[1];
            return Boolean(point) && typeof point === 'object'
                && Number.isFinite((point as { x?: unknown }).x)
                && Number.isFinite((point as { y?: unknown }).y);
        }));
    } catch {
        return {};
    }
}

export function writeProjectLayout(
    rawProject: string,
    positions: Record<string, { x: number; y: number }>,
): string | null {
    try {
        const value = JSON.parse(rawProject) as Record<string, unknown>;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        value.layout = { ...readProjectLayout(rawProject), ...positions };
        return JSON.stringify(value, null, 2) + (rawProject.endsWith('\n') ? '\n' : '');
    } catch {
        return null;
    }
}

/** Resolve old title-based @links only when both endpoints are unambiguous. */
export function legacyContextEdges(rawProject: string, documents: HarnessDocument[]): HarnessGraphEdge[] {
    let value: unknown;
    try {
        value = JSON.parse(rawProject);
    } catch {
        return [];
    }
    if (!value || typeof value !== 'object' || !Array.isArray((value as { docs?: unknown }).docs)) return [];

    const unitsByName = new Map<string, Array<{ id: string; documentPath: string }>>();
    for (const document of documents) {
        for (const unit of document.units) {
            const matches = unitsByName.get(unit.name) ?? [];
            matches.push({ id: unit.id, documentPath: document.path });
            unitsByName.set(unit.name, matches);
        }
    }

    const edges = new Map<string, HarnessGraphEdge>();
    for (const legacyDocument of (value as { docs: LegacyDocument[] }).docs) {
        if (typeof legacyDocument.title !== 'string' || !Array.isArray(legacyDocument.cards)) continue;
        const destination = typeof legacyDocument.destination === 'string' ? legacyDocument.destination : '';
        const expectedPath = normalizePath([destination, `${legacyDocument.title}.py`].filter(Boolean).join('/'));
        const candidates = documents.filter(document => normalizePath(document.path) === expectedPath);
        if (candidates.length !== 1) continue;
        const document = candidates[0];

        for (const card of legacyDocument.cards as LegacyCard[]) {
            if (typeof card.title !== 'string' || !Array.isArray(card.links)) continue;
            const targets = document.units.filter(unit => unit.name === card.title);
            if (targets.length !== 1) continue;
            for (const link of card.links) {
                if (typeof link !== 'string') continue;
                const sources = unitsByName.get(link) ?? [];
                if (sources.length !== 1) continue;
                const edge = { sourceId: sources[0].id, targetId: targets[0].id, kind: 'context' as const };
                edges.set(`${edge.sourceId}:${edge.targetId}`, edge);
            }
        }
    }
    return [...edges.values()];
}
