import type { Edge, Node } from '@xyflow/react';

import type { BoardNote, HarnessSnapshot, HarnessUnit } from './types';

const GROUP_COLORS = ['#3ecff5', '#a78bfa', '#f59e72', '#5ee0a0'];

export type SlateNodeData = {
    label: string;
    detail: string;
    kind: 'document' | 'note' | HarnessUnit['kind'];
    identity?: HarnessUnit['identity'];
    invalid?: boolean;
    stale?: boolean;
    container?: boolean;
    groupColor?: string;
    path: string;
    unit?: HarnessUnit;
    note?: BoardNote;
    /** Folder mode: the node's intent, shown under its signature. */
    intent?: string;
    /** First diagnostic, shown as a warning badge. */
    problem?: string;
};

function directChildren(units: HarnessUnit[], parentId: string): HarnessUnit[] {
    return units.filter(unit => unit.parentId === parentId);
}

/** Folder mode: every node file is one free node; classes still contain their methods. */
function buildFolderNodes(snapshot: HarnessSnapshot, nodes: Node<SlateNodeData>[]): void {
    const folders = [...new Set(snapshot.documents.map(document => folderOf(document.path)))].sort();
    const rows = new Map<string, number>();
    for (const document of snapshot.documents) {
        const folder = folderOf(document.path);
        const column = folders.indexOf(folder);
        const row = rows.get(folder) ?? 0;
        const groupColor = GROUP_COLORS[column % GROUP_COLORS.length];
        const top = document.units.find(unit => unit.parentId === null);
        const nodeId = nodeIdOf(document.path);
        const id = top?.id ?? document.id;
        const children = top ? directChildren(document.units, top.id) : [];
        const isClass = top?.kind === 'class';
        const height = isClass ? Math.max(132, children.length * 96 + 72) : 0;
        rows.set(folder, row + (isClass ? Math.ceil(height / 150) : 1));
        const intent = typeof top?.annotation?.intent === 'string' ? top.annotation.intent : '';
        nodes.push({
            id,
            type: 'slate',
            position: snapshot.layout?.[id] ?? { x: 80 + column * 340, y: 60 + row * 150 },
            style: isClass ? { width: 320, height } : undefined,
            data: {
                label: top?.name ?? nodeId,
                detail: top?.signature ?? (top ? top.qualifiedName : 'unreadable node'),
                kind: top?.kind ?? 'document',
                identity: top?.identity,
                invalid: !document.valid,
                stale: document.stale,
                container: isClass,
                groupColor,
                path: nodeId,
                unit: top,
                intent,
                problem: document.diagnostics[0]?.message,
            },
        });
        children.forEach((unit, index) => nodes.push({
            id: unit.id,
            type: 'slate',
            parentId: id,
            extent: 'parent',
            position: snapshot.layout?.[unit.id] ?? { x: 28, y: 58 + index * 96 },
            data: {
                label: unit.name,
                detail: unit.signature ?? unit.qualifiedName,
                kind: unit.kind,
                identity: unit.identity,
                stale: document.stale,
                groupColor,
                path: nodeId,
                unit,
            },
        }));
    }
}

function folderOf(documentPath: string): string {
    const nodeId = nodeIdOf(documentPath);
    return nodeId.includes('/') ? nodeId.slice(0, nodeId.lastIndexOf('/')) : '';
}

export function nodeIdOf(documentPath: string): string {
    return documentPath.replace(/^slate\/nodes\//, '').replace(/\.json$/, '');
}

export function buildGraph(snapshot: HarnessSnapshot): { nodes: Node<SlateNodeData>[]; edges: Edge[] } {
    const nodes: Node<SlateNodeData>[] = [];
    const edges: Edge[] = [];
    if (snapshot.mode === 'folder') buildFolderNodes(snapshot, nodes);
    else buildSourceMapNodes(snapshot, nodes);
    addNotesAndEdges(snapshot, nodes, edges);
    return { nodes, edges };
}

/** Legacy project-v2 mode: files → classes → functions as nested containers. */
function buildSourceMapNodes(snapshot: HarnessSnapshot, nodes: Node<SlateNodeData>[]): void {
    let documentY = 60;

    snapshot.documents.forEach((document, documentIndex) => {
        const documentId = `document:${document.path}`;
        const groupColor = GROUP_COLORS[documentIndex % GROUP_COLORS.length];
        const topLevel = document.units.filter(unit => unit.parentId === null);
        const topFunctions = topLevel.filter(unit => !unit.kind.includes('class'));
        const classes = topLevel.filter(unit => unit.kind.includes('class'));
        const classHeights = new Map(classes.map(unit => [
            unit.id,
            Math.max(132, directChildren(document.units, unit.id).length * 96 + 72),
        ]));
        const classLaneHeight = classes.reduce((height, unit) => height + classHeights.get(unit.id)! + 24, 0);
        const looseNested = document.units.filter(unit => unit.parentId !== null
            && !classes.some(parent => parent.id === unit.parentId));
        const documentHeight = Math.max(
            210,
            topFunctions.length * 106 + 96,
            classLaneHeight + 72,
            looseNested.length * 106 + 96,
        );

        nodes.push({
            id: documentId,
            type: 'slate',
            position: snapshot.layout?.[documentId] ?? { x: 80, y: documentY },
            style: { width: 1020, height: documentHeight },
            data: {
                label: document.path.split('/').pop() ?? document.path,
                detail: document.path,
                kind: 'document',
                invalid: !document.valid,
                stale: document.stale,
                container: true,
                groupColor,
                path: document.path,
            },
        });

        let functionY = 64;
        let classY = 64;
        let looseY = 64;
        for (const unit of document.units) {
            const isClass = unit.kind === 'class' || unit.kind === 'nested_class';
            const parentClass = classes.find(parent => parent.id === unit.parentId);
            let parentId = documentId;
            let position: { x: number; y: number };
            let style: { width: number; height: number } | undefined;
            let container = false;

            if (unit.parentId === null && isClass) {
                position = { x: 360, y: classY };
                style = { width: 620, height: classHeights.get(unit.id) ?? 132 };
                classY += style.height + 24;
                container = true;
            } else if (unit.parentId === null) {
                position = { x: 32, y: functionY };
                functionY += 106;
            } else if (parentClass) {
                parentId = parentClass.id;
                const siblingIndex = directChildren(document.units, parentClass.id).findIndex(child => child.id === unit.id);
                position = { x: 28, y: 58 + siblingIndex * 96 };
            } else {
                position = { x: 700, y: looseY };
                looseY += 106;
            }

            nodes.push({
                id: unit.id,
                type: 'slate',
                parentId,
                extent: 'parent',
                position: snapshot.layout?.[unit.id] ?? position,
                style,
                data: {
                    label: unit.name,
                    detail: unit.signature ?? unit.qualifiedName,
                    kind: unit.kind,
                    identity: unit.identity,
                    stale: document.stale,
                    container,
                    groupColor,
                    path: document.path,
                    unit,
                },
            });
        }
        documentY += documentHeight + 60;
    });
}

function addNotesAndEdges(snapshot: HarnessSnapshot, nodes: Node<SlateNodeData>[], edges: Edge[]): void {
    for (const [index, note] of (snapshot.notes ?? []).entries()) {
        nodes.push({
            id: note.id,
            type: 'slate',
            position: snapshot.layout?.[note.id] ?? { x: 1180, y: 60 + index * 150 },
            data: {
                label: note.title,
                detail: note.body || 'Board-only note',
                kind: 'note',
                groupColor: 'var(--strata-warning)',
                path: snapshot.mode === 'folder' ? 'Board note — slate/layout.json' : 'Board note — not written to source',
                note,
            },
        });
    }

    const nodeIds = new Set(nodes.map(node => node.id));
    const contextEdges = new Map<string, { sourceId: string; targetId: string }>();
    for (const document of snapshot.documents) {
        for (const unit of document.units) {
            const dependencies = unit.annotation?.dependencies;
            if (!Array.isArray(dependencies)) continue;
            for (const dependency of dependencies) {
                if (typeof dependency !== 'string') continue;
                contextEdges.set(`${dependency}:${unit.id}`, { sourceId: dependency, targetId: unit.id });
            }
        }
    }
    for (const edge of snapshot.contextEdges ?? []) {
        if (edge.kind === 'context') contextEdges.set(`${edge.sourceId}:${edge.targetId}`, edge);
    }
    for (const [id, edge] of contextEdges) {
        if (!nodeIds.has(edge.sourceId) || !nodeIds.has(edge.targetId)) continue;
        edges.push({
            id: `context:${id}`,
            source: edge.sourceId,
            target: edge.targetId,
            type: 'smoothstep',
            animated: true,
            className: 'slate-edge slate-edge--context',
        });
    }
    for (const note of snapshot.notes ?? []) {
        if (!note.attachedTo || !nodeIds.has(note.attachedTo)) continue;
        edges.push({
            id: `note:${note.id}:${note.attachedTo}`,
            source: note.id,
            target: note.attachedTo,
            type: 'smoothstep',
            selectable: false,
            focusable: false,
            interactionWidth: 0,
            className: 'slate-edge slate-edge--note',
        });
    }
}
