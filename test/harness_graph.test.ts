import { describe, expect, it } from 'vitest';

import { demoSnapshot } from '../src/harness/demo';
import { buildGraph, typeColor, typesMismatch } from '../src/harness/graph';

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

it('merges explicit context edges and attaches notes only to existing nodes', () => {
    const snapshot = structuredClone(demoSnapshot);
    snapshot.contextEdges = [{ kind: 'context', sourceId: 'clamp', targetId: 'scoring/normalize_score' },
        { kind: 'context', sourceId: 'missing', targetId: 'clamp' }];
    snapshot.notes = [{ id: 'attached', title: 'Explain', body: 'Details', attachedTo: 'clamp' },
        { id: 'orphan', title: '', body: '', attachedTo: 'missing' }];
    const graph = buildGraph(snapshot);
    expect(graph.edges.filter(edge => edge.id === 'context:clamp:scoring/normalize_score')).toHaveLength(1);
    expect(graph.edges).toContainEqual(expect.objectContaining({ id: 'note:attached:clamp', source: 'attached', target: 'clamp', selectable: false }));
    expect(graph.edges.some(edge => edge.source === 'missing' || edge.target === 'missing')).toBe(false);
});

it('renders unreadable definitions and comment-only module tails without invented metadata', () => {
    const base = structuredClone(demoSnapshot.documents[0]);
    const snapshot = { revision: 1, projectName: 'partial', documents: [
        { ...base, id: 'empty', path: 'slate/nodes/empty.json', units: [], source: undefined, valid: false, diagnostics: [{ code: 'bad', message: 'Broken file', range: base.units[0].ranges.declaration }] },
        { ...base, id: 'tail', path: 'slate/nodes/tail.json', units: [], nodeKind: 'epilogue' as const, source: '# comment only' },
        { ...base, id: 'state', path: 'slate/nodes/state.json', units: [], nodeKind: 'prelude' as const, source: undefined },
    ] };
    const graph = buildGraph(snapshot);
    expect(graph.nodes.find(node => node.id === 'empty')?.data).toMatchObject({ label: 'empty', detail: 'unreadable node', kind: 'document', invalid: true, problem: 'Broken file', inputs: [], outputs: [], editableIntent: false });
    expect(graph.nodes.find(node => node.id === 'tail')?.data).toMatchObject({ label: 'module tail', detail: '' });
    expect(graph.nodes.find(node => node.id === 'state')?.data).toMatchObject({ label: 'module state', detail: '' });
    expect(buildGraph(snapshot, { view: 'map', flow: null }).nodes.filter(node => node.data.kind === 'folder')).toHaveLength(1);
});

it('uses saved positions and resolves references to flows and library classes', () => {
    const snapshot = structuredClone(demoSnapshot);
    const library = snapshot.library![0];
    const libraryUnit = library.units[0];
    libraryUnit.kind = 'class';
    libraryUnit.signature = undefined;
    snapshot.refs = [{ id: 'library-call', target: libraryUnit.id }, { id: 'flow-call', target: 'report' }];
    snapshot.layout = { 'library-call': { x: 15, y: 25 }, 'flow-call': { x: 35, y: 45 }, 'scoring/Grader.grade': { x: 7, y: 9 } };
    const method = snapshot.documents.flatMap(document => document.units).find(unit => unit.id === 'scoring/Grader.grade')!;
    method.signature = undefined;
    const graph = buildGraph(snapshot);
    expect(graph.nodes.find(node => node.id === 'library-call')).toMatchObject({ position: { x: 15, y: 25 }, data: { broken: false, path: '', groupColor: '#9da5ad' } });
    expect(graph.nodes.find(node => node.id === 'flow-call')).toMatchObject({ position: { x: 35, y: 45 }, data: { broken: false, flowId: 'report', groupColor: '#f6c453' } });
    expect(graph.nodes.find(node => node.id === method.id)).toMatchObject({ position: { x: 7, y: 9 }, data: { detail: method.qualifiedName } });
});

it('keeps nested flow values and untyped named wires usable when optional layout and values are absent', () => {
    const snapshot = structuredClone(demoSnapshot);
    snapshot.flowPositions = undefined;
    snapshot.flows = [{ id: 'child', flow: { name: 'child', inputs: [{ name: 'input', annotation: null }], outputs: [{ name: 'result', annotation: null }], extra: {},
        instances: [{ id: 'literal', kind: 'value' }, { id: 'nested', node: 'grandchild' }],
        wires: [{ from: 'input:input', to: 'nested.in:x' }, { from: 'literal.out', to: 'output:result' }],
    } }, { id: 'grandchild', flow: { name: 'grandchild', inputs: [{ name: 'x', annotation: null }], outputs: [], instances: [], wires: [], extra: {} } }];
    const graph = buildGraph(snapshot, { view: 'compose', flow: 'child' });
    expect(graph.nodes.find(node => node.id === 'literal')?.data).toMatchObject({ kind: 'value', value: '' });
    expect(graph.nodes.find(node => node.id === 'nested')?.data).toMatchObject({ kind: 'instance', flowId: 'grandchild', detail: 'grandchild' });
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.every(edge => edge.style?.stroke === '#7d8590')).toBe(true);
});

it('keeps unreadable flows visible and omits dangling data wires on the root canvas', () => {
    const snapshot = structuredClone(demoSnapshot);
    snapshot.layout = {};
    snapshot.flows = [
        { id: 'broken', flow: null, problem: 'Invalid JSON' },
        { id: 'main', flow: { name: 'main', inputs: [], outputs: [], extra: {},
            instances: [{ id: 'literal', kind: 'value' }],
            wires: [
                { from: 'literal.out', to: 'clamp.in:value' },
                { from: 'missing.out', to: 'clamp.in:lower' },
                { from: 'literal.out', to: 'missing.in:value' },
            ],
        } },
    ];
    const graph = buildGraph(snapshot);
    expect(graph.nodes.find(node => node.id === 'flow:broken')?.data).toMatchObject({
        label: 'broken', detail: 'unreadable: Invalid JSON', invalid: true,
        inputs: [], outputs: [],
    });
    expect(graph.nodes.find(node => node.id === 'literal')).toMatchObject({
        position: { x: 760, y: 600 }, data: { kind: 'value', value: '' },
    });
    expect(graph.edges.filter(edge => edge.id.startsWith('data:')).map(edge => edge.id))
        .toEqual(['data:literal.out->clamp.in:value']);
    expect(buildGraph(snapshot, { view: 'compose', flow: 'broken' })).toEqual({ nodes: [], edges: [] });
});

it('filters context links on demand while preserving totalContextEdges count', () => {
    const none = buildGraph(demoSnapshot, { view: 'compose', flow: null }, { contextFilter: 'none' });
    expect(none.edges.filter(edge => edge.id.startsWith('context:'))).toEqual([]);
    expect(none.totalContextEdges).toBe(1);

    const unrelated = buildGraph(demoSnapshot, { view: 'compose', flow: null }, { contextFilter: new Set(['scoring/Grader']) });
    expect(unrelated.edges.filter(edge => edge.id.startsWith('context:'))).toEqual([]);
    expect(unrelated.totalContextEdges).toBe(1);

    const focusedSource = buildGraph(demoSnapshot, { view: 'compose', flow: null }, { contextFilter: new Set(['clamp']) });
    expect(focusedSource.edges.filter(edge => edge.id.startsWith('context:')).map(edge => edge.id))
        .toEqual(['context:clamp:scoring/normalize_score']);

    const focusedTarget = buildGraph(demoSnapshot, { view: 'compose', flow: null }, { contextFilter: new Set(['scoring/normalize_score']) });
    expect(focusedTarget.edges.filter(edge => edge.id.startsWith('context:')).map(edge => edge.id))
        .toEqual(['context:clamp:scoring/normalize_score']);
});

it('marks type-mismatched data wires with warning metadata and styling without blocking the wire', () => {
    const snapshot = structuredClone(demoSnapshot);
    const reportFlow = snapshot.flows!.find(item => item.id === 'report')!.flow!;
    reportFlow.wires.push({ from: 'shout.out', to: 'normalize_score.in:maximum' });

    const graph = buildGraph(snapshot, { view: 'compose', flow: 'report' });
    const mismatched = graph.edges.find(edge => edge.id === 'data:shout.out->normalize_score.in:maximum')!;
    expect(mismatched).toBeDefined();
    expect(mismatched.className).toContain('slate-edge--mismatch');
    expect(mismatched.label).toBe('⚠ str → int');
    expect(mismatched.data).toMatchObject({
        from: 'shout.out',
        to: 'normalize_score.in:maximum',
        sourceAnnotation: 'str',
        targetAnnotation: 'int',
        mismatch: true,
        warning: 'str → int',
    });

    const compatible = graph.edges.find(edge => edge.id === 'data:input:score->normalize_score.in:score')!;
    expect(compatible.className).not.toContain('slate-edge--mismatch');
    expect(compatible.data).toMatchObject({ mismatch: false });
    expect((compatible.data as { warning?: string }).warning).toBeUndefined();
    expect(typesMismatch('str', 'int')).toBe(true);
    expect(typesMismatch('int', 'float')).toBe(false);
});
