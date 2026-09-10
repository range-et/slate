import { MarkerType } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';

import type { HarnessSnapshot, HarnessUnit } from './types';

export type SlateNodeData = {
    label: string;
    detail: string;
    kind: 'document' | HarnessUnit['kind'];
    identity?: HarnessUnit['identity'];
    invalid?: boolean;
    stale?: boolean;
    path: string;
    unit?: HarnessUnit;
};

export function buildGraph(snapshot: HarnessSnapshot): { nodes: Node<SlateNodeData>[]; edges: Edge[] } {
    const nodes: Node<SlateNodeData>[] = [];
    const edges: Edge[] = [];
    let documentY = 60;
    snapshot.documents.forEach(document => {
        const documentId = `document:${document.path}`;
        nodes.push({
            id: documentId,
            type: 'slate',
            position: { x: 80, y: documentY },
            data: {
                label: document.path.split('/').pop() ?? document.path,
                detail: document.path,
                kind: 'document',
                invalid: !document.valid,
                stale: document.stale,
                path: document.path,
            },
        });
        document.units.forEach((unit, unitIndex) => {
            const depth = unit.qualifiedName.split('.').length - 1;
            nodes.push({
                id: unit.id,
                type: 'slate',
                position: { x: 400 + depth * 320, y: documentY + unitIndex * 116 },
                data: {
                    label: unit.name,
                    detail: unit.signature ?? unit.qualifiedName,
                    kind: unit.kind,
                    identity: unit.identity,
                    stale: document.stale,
                    path: document.path,
                    unit,
                },
            });
            edges.push({
                id: `contains:${unit.parentId ?? documentId}:${unit.id}`,
                source: unit.parentId ?? documentId,
                target: unit.id,
                type: 'smoothstep',
                markerEnd: { type: MarkerType.ArrowClosed },
                className: 'slate-edge slate-edge--contains',
            });
        });
        documentY += Math.max(220, document.units.length * 116 + 80);
    });
    return { nodes, edges };
}
