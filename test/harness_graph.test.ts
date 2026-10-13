import { describe, expect, it } from 'vitest';

import { demoSnapshot } from '../src/harness/demo';
import { buildGraph } from '../src/harness/graph';

describe('Python harness graph', () => {
    it('creates one free node per node file; classes contain their methods; module state is a small node', () => {
        const graph = buildGraph(demoSnapshot);

        expect(graph.nodes.map(node => node.id)).toEqual([
            'clamp',
            'scoring/normalize_score',
            'scoring/_prelude',
            'scoring/Grader',
            'scoring/Grader.grade',
            'board-note-port',
        ]);
        expect(graph.nodes.find(node => node.id === 'clamp')?.parentId).toBeUndefined();
        expect(graph.nodes.find(node => node.id === 'scoring/Grader.grade')).toMatchObject({ parentId: 'scoring/Grader', extent: 'parent' });
        expect(graph.nodes.find(node => node.id === 'scoring/Grader')?.data.container).toBe(true);
        expect(graph.nodes.find(node => node.id === 'scoring/_prelude')?.data).toMatchObject({
            kind: 'module', label: 'module state', detail: 'CUTOFFS = {90: "A", 80: "B", 70: "C"}', path: 'scoring/_prelude',
        });
    });

    it('draws context wires from the context node to its consumer', () => {
        const graph = buildGraph(demoSnapshot);
        const edge = graph.edges.find(item => item.id.startsWith('context:'));

        expect(edge).toMatchObject({
            source: 'clamp',
            target: 'scoring/normalize_score',
            animated: true,
            className: 'slate-edge slate-edge--context',
        });
        expect(edge?.markerEnd).toBeUndefined();
    });

    it('preserves stale and invalid states on the corresponding nodes', () => {
        const snapshot = structuredClone(demoSnapshot);
        const grader = snapshot.documents.find(document => document.path === 'slate/nodes/scoring/Grader.json')!;
        grader.valid = false;
        grader.stale = true;

        const nodes = buildGraph(snapshot).nodes;

        expect(nodes.find(node => node.id === 'scoring/Grader')?.data).toMatchObject({ invalid: true, stale: true });
        expect(nodes.find(node => node.id === 'scoring/Grader.grade')?.data).toMatchObject({ stale: true });
    });

    it('uses persisted node positions instead of regenerating their layout', () => {
        const snapshot = structuredClone(demoSnapshot);
        snapshot.layout = { clamp: { x: 901, y: 407 } };

        expect(buildGraph(snapshot).nodes.find(node => node.id === 'clamp')?.position).toEqual({ x: 901, y: 407 });
    });
});
