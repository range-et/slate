import { describe, expect, it } from 'vitest';

import { demoSnapshot } from '../src/harness/demo';
import { buildGraph } from '../src/harness/graph';

describe('Python harness graph', () => {
    it('creates one node per file and declaration with correct containment edges', () => {
        const graph = buildGraph(demoSnapshot);

        expect(graph.nodes.map(node => node.id)).toEqual([
            'document:calculator.py',
            'durable-run',
            'provisional-main',
            'document:operations.py',
            'durable-operations',
            'durable-add',
            'provisional-divide',
        ]);
        expect(graph.edges.filter(edge => edge.id.startsWith('contains:')).map(edge => [edge.source, edge.target])).toEqual([
            ['document:calculator.py', 'durable-run'],
            ['document:calculator.py', 'provisional-main'],
            ['document:operations.py', 'durable-operations'],
            ['durable-operations', 'durable-add'],
            ['durable-operations', 'provisional-divide'],
        ]);
        expect(graph.nodes.find(node => node.id === 'durable-add')?.position.x)
            .toBeGreaterThan(graph.nodes.find(node => node.id === 'durable-operations')?.position.x ?? 0);
    });

    it('keeps generation context distinct from structural containment', () => {
        const graph = buildGraph(demoSnapshot);
        const edge = graph.edges.find(item => item.id.startsWith('context:'));

        expect(edge).toMatchObject({
            source: 'durable-run',
            target: 'provisional-main',
            animated: true,
            className: 'slate-edge slate-edge--context',
        });
    });

    it('preserves stale and invalid states on the corresponding nodes', () => {
        const snapshot = structuredClone(demoSnapshot);
        snapshot.documents[0].valid = false;
        snapshot.documents[0].stale = true;

        const graph = buildGraph(snapshot);

        expect(graph.nodes[0].data).toMatchObject({ invalid: true, stale: true });
        expect(graph.nodes[1].data).toMatchObject({ stale: true });
    });

    it('uses persisted node positions instead of regenerating their layout', () => {
        const snapshot = structuredClone(demoSnapshot);
        snapshot.layout = { 'durable-run': { x: 901, y: 407 } };

        expect(buildGraph(snapshot).nodes.find(node => node.id === 'durable-run')?.position)
            .toEqual({ x: 901, y: 407 });
    });
});
