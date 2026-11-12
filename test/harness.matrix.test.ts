import { describe, expect, it } from 'vitest';
import { buildGraph, callables, nodeIdOf, typeColor, typesMismatch } from '../src/harness/graph';
import { rankPalette, scoreMatch } from '../src/harness/palette';
import { searchUnits } from '../vscode-extension/src/search';
import { indexNode } from '../vscode-extension/src/slate_folder';
import { emptyFlow } from '../vscode-extension/src/flow';
import { demoSnapshot } from '../src/harness/demo';

describe('palette and search matrix', () => {
    it.each([
        ['Run', ' run ', 100], ['run task', 'run', 99.5], ['my_run', 'run', 80],
        ['outrun', 'run', 60], ['return', 'rtn', 37], ['run', 'z', null], ['', 'x', null], ['anything', ' ', 1],
    ])('scores %j for %j', (text, query, expected) => expect(scoreMatch(text, query)).toBe(expected));
    it.each(['_', '/', ':', '-', '.', ' ', '(', ')'])('recognizes word boundary %j', separator => {
        expect(scoreMatch(`my${separator}run`, 'run')).toBe(80);
    });
    it('orders ties deterministically without mutating the input', () => {
        const items = [{ label: 'Beta', group: 'node' as const }, { label: 'Alpha', group: 'node' as const },
            { label: 'Search', group: 'search' as const, always: true }];
        expect(rankPalette(items, '').map(item => item.label)).toEqual(['Alpha', 'Beta', 'Search']);
        expect(items.map(item => item.label)).toEqual(['Beta', 'Alpha', 'Search']);
        expect(rankPalette(items, 'absent')).toEqual([items[2]]);
    });
    const target = indexNode('slate/nodes/pkg/calculate.json', JSON.stringify({ slate: 3, name: 'calculate',
        intent: 'Combine quantities', contract: 'Preserve precision',
        code: ['def calculate(amount: float) -> float:', '    return amount * 17'] }), 'python', null);
    const sources = new Map([[target.document.path, target.code]]);
    it.each([
        [' CALCULATE ', 'exact name', 100], ['pkg/calculate', 'exact name', 100],
        ['calc', 'name', 90], ['culate', 'name', 82], ['float', 'signature', 72],
        ['combine', 'annotation', 62], ['precision', 'annotation', 62], ['* 17', 'source', 52], ['slate/nodes', 'path', 42],
    ])('searches %j with provenance', (query, reason, score) => {
        expect(searchUnits([target.document], sources, query)).toEqual([expect.objectContaining({
            unitId: 'pkg/calculate', path: target.document.path, qualifiedName: 'calculate', reason, score,
        })]);
    });
    it.each(['', '  ', 'nonexistent'])('returns no hits for %j', query => {
        expect(searchUnits([target.document], sources, query)).toEqual([]);
    });
    it('respects limits and searches metadata without source text', () => {
        expect(searchUnits([target.document], sources, 'calculate', 0)).toEqual([]);
        const hits = searchUnits([target.document], new Map(), 'calculate', 1);
        expect(hits).toHaveLength(1);
        expect(hits[0].snippet).toBe('def calculate(amount: float) -> float');
    });
});

describe('canvas helper matrix', () => {
    it.each([null, undefined, '', 'Any', 'any', '  '])('colors untyped %j grey', annotation => {
        expect(typeColor(annotation)).toBe('#7d8590');
    });
    it.each(['int', 'str', 'list[int]', 'dict[str,int]'])('normalizes whitespace for %s colors', annotation => {
        expect(typeColor(` ${annotation.split('').join(' ')} `)).toBe(typeColor(annotation));
        expect(typeColor(annotation)).toMatch(/^hsl\(\d+ 70% 62%\)$/);
    });
    it.each([['slate/nodes/pkg/run.json', 'pkg/run'], ['run.json', 'run'], ['lib.py', 'lib.py']])('maps document %s', (path, expected) => {
        expect(nodeIdOf(path)).toBe(expected);
    });
    it.each(['compose', 'map'] as const)('builds an empty %s canvas', view => {
        const snapshot = { revision: 1, projectName: 'empty', documents: [] };
        expect(buildGraph(snapshot, { view, flow: null })).toEqual({ nodes: [], edges: [] });
        expect(callables(snapshot).size).toBe(0);
    });
    it('omits main and invalid flows while retaining named callable flows', () => {
        const targets = callables({ revision: 1, projectName: 'empty', documents: [], flows: [
            { id: 'main', flow: emptyFlow('main') },
            { id: 'child', flow: emptyFlow('child') },
            { id: 'broken', flow: null, problem: 'Invalid JSON' },
        ] });
        expect([...targets.keys()]).toEqual(['child']);
        expect(targets.get('child')).toMatchObject({ group: 'flow', signature: { name: 'child', params: [], outputs: [] } });
    });
    it.each([{ view: 'compose', flow: null }, { view: 'map', flow: null }, { view: 'compose', flow: 'missing' }] as const)
        ('builds scope %j without mutating the snapshot', scope => {
            const snapshot = structuredClone(demoSnapshot);
            const before = structuredClone(snapshot);
            const graph = buildGraph(snapshot, scope);
            expect(snapshot).toEqual(before);
            expect(new Set(graph.nodes.map(node => node.id)).size).toBe(graph.nodes.length);
            if (scope.flow === 'missing') expect(graph).toEqual({ nodes: [], edges: [] });
        });
    it.each([
        ['int', 'int', false],
        [' int ', 'int', false],
        [null, 'int', false],
        ['str', undefined, false],
        ['Any', 'int', false],
        ['dict[str, int]', 'any', false],
        ['int', 'float', false],
        ['bool', 'int', false],
        ['bool', 'float', false],
        ['float', 'int', true],
        ['int', 'int | None', false],
        ['int', 'Optional[int]', false],
        ['int', 'Union[int, str]', false],
        ['int | str', 'int', true],
        ['list[int]', 'list', false],
        ['list', 'list[int]', false],
        ['list[int]', 'list[str]', true],
        ['typing.List[int]', 'list[int]', false],
        ['dict[str, int]', 'dict[int, int]', true],
        ['int', 'str', true],
        ['str', 'float', true],
        ['bool', 'str', true],
    ] as const)('evaluates typesMismatch(%j, %j) -> %s', (source, target, expected) => {
        expect(typesMismatch(source, target)).toBe(expected);
    });
});
