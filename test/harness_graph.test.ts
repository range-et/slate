import { describe, expect, it } from 'vitest';

import { demoSnapshot } from '../src/harness/demo';
import { buildGraph, typeColor } from '../src/harness/graph';

describe('Python harness graph', () => {
    it('creates one free node per node file; classes contain their methods; module state is a small node', () => {
        const graph = buildGraph(demoSnapshot);

        expect(graph.nodes.map(node => node.id)).toEqual([
            'clamp',
            'scoring/normalize_score',
            'scoring/_prelude',
            'scoring/Grader',
            'scoring/Grader.grade',
            'ref-clamp',
            'placeholder-letter',
            'flow:report',
            'value',
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

    it('gives definitions typed ports and context handles; refs mirror their target and break when it is gone', () => {
        const nodes = buildGraph(demoSnapshot).nodes;
        const clamp = nodes.find(node => node.id === 'clamp')!.data;
        expect(clamp.inputs?.map(port => [port.id, port.annotation])).toEqual([['in:value', 'int'], ['in:lower', 'int'], ['in:upper', 'int']]);
        expect(clamp.outputs).toEqual([{ id: 'out', name: 'out', annotation: 'int' }]);
        expect(clamp.contextPorts).toBe(true);
        const ref = nodes.find(node => node.id === 'ref-clamp')!.data;
        expect(ref).toMatchObject({ kind: 'ref', target: 'clamp', path: 'clamp', broken: false, inputs: clamp.inputs, outputs: clamp.outputs });

        const broken = structuredClone(demoSnapshot);
        broken.refs = [{ id: 'ref-gone', target: 'gone' }];
        expect(buildGraph(broken).nodes.find(node => node.id === 'ref-gone')!.data).toMatchObject({ broken: true, detail: 'missing: gone', inputs: [] });
    });

    it('resolves a placeholder only when exactly one node has its name', () => {
        const snapshot = structuredClone(demoSnapshot);
        snapshot.placeholders = [{ id: 'p1', name: 'normalize_score' }, { id: 'p2', name: 'letter_grade' }];
        const nodes = buildGraph(snapshot).nodes;
        expect(nodes.find(node => node.id === 'p1')!.data.resolvesTo).toBe('scoring/normalize_score');
        expect(nodes.find(node => node.id === 'p2')!.data.resolvesTo).toBeNull();
    });

    it('draws root data wires from main.json between canvas items, colored by type', () => {
        const edge = buildGraph(demoSnapshot).edges.find(item => item.id.startsWith('data:'))!;
        expect(edge).toMatchObject({ source: 'value', sourceHandle: 'out', target: 'scoring/normalize_score', targetHandle: 'in:score' });
        expect(edge.style?.stroke).toBe(typeColor(null));
        expect(typeColor('int')).toBe(typeColor(' int '));
        expect(typeColor('int')).not.toBe(typeColor('str'));
    });

    it('shows a flow with group input/output (plus empty slots), instances, and wires from the group', () => {
        const { nodes, edges } = buildGraph(demoSnapshot, { view: 'compose', flow: 'report' });
        expect(nodes.map(node => node.id)).toEqual(['__input', '__output', 'hundred', 'normalize_score', 'shout']);
        expect(nodes[0].data.outputs?.map(port => port.id)).toEqual(['input:score', 'input:+']);
        expect(nodes[1].data.inputs?.map(port => port.id)).toEqual(['output:text', 'output:+']);
        expect(nodes.find(node => node.id === 'shout')!.data).toMatchObject({ kind: 'instance', target: 'lib:vendor/textutil.py:shout', path: '' });
        expect(edges.map(edge => [edge.source, edge.sourceHandle, edge.target, edge.targetHandle])).toEqual([
            ['__input', 'input:score', 'normalize_score', 'in:score'],
            ['hundred', 'out', 'normalize_score', 'in:maximum'],
        ]);
    });

    it('lays out Map by folder from mapPositions, without ports, refs, or wires', () => {
        const snapshot = structuredClone(demoSnapshot);
        snapshot.mapPositions = { clamp: { x: 5, y: 6 } };
        const { nodes, edges } = buildGraph(snapshot, { view: 'map', flow: null });
        expect(edges).toEqual([]);
        expect(nodes.filter(node => node.data.kind === 'folder').map(node => node.data.label)).toEqual(['root', 'scoring/']);
        expect(nodes.find(node => node.id === 'clamp')).toMatchObject({ position: { x: 5, y: 6 }, data: { inputs: [], contextPorts: false } });
        expect(nodes.some(node => ['ref', 'placeholder', 'flow', 'note'].includes(node.data.kind))).toBe(false);
    });
});
