import { describe, expect, it } from 'vitest';

import { compilePython } from '../vscode-extension/src/compile/python';
import { connect, extractFlow, inputPorts, outputPorts, parseFlow, serializeFlow, unitSignature, type Port } from '../vscode-extension/src/flow';
import type { SlateFlow } from '../vscode-extension/src/harness_protocol';
import { parseModule } from '../vscode-extension/src/python_adapter';
import type { SlateNode } from '../vscode-extension/src/slate_folder';

const config = { slate: 3 as const, name: 'demo', language: 'python' };
const node = (name: string, code: string[], imports: string[] = []): SlateNode => ({
    name, intent: '', contract: '', context: [], examples: [], locked: false, imports, uses: [], extra: {}, code,
});
const flow = (fields: Partial<SlateFlow> & { name: string }): SlateFlow => ({ inputs: [], outputs: [], instances: [], wires: [], extra: {}, ...fields });

const nodes = new Map([
    ['math/double', node('double', ['def double(x: int) -> int:', '    return x * 2'])],
    ['math/add', node('add', ['def add(a: int, b: int = 1, /) -> int:', '    return a + b'])],
    ['math/stats', node('stats', ['def stats(xs: List[int], *rest, scale: float = 1.0, **extra) -> float:', '    return sum(xs) * scale'], ['from typing import List', 'import os'])],
]);
const compile = (flows: Array<[string, SlateFlow]>, library = new Map()) => compilePython(nodes, config, new Map(flows), library);

describe('flow format and ports', () => {
    it('round-trips flows with unknown keys and rejects malformed ones', () => {
        const text = serializeFlow(parseFlow(JSON.stringify({ slate: 3, name: 'f', instances: [{ id: 'v', kind: 'value', value: 3 }], note: 'keep' })));
        expect(JSON.parse(text)).toMatchObject({ name: 'f', note: 'keep', instances: [{ id: 'v', kind: 'value', value: '3' }] });
        expect(() => parseFlow('{"slate": 3, "name": "f", "instances": [{"id": "a.b", "node": "x"}]}')).toThrow(/without dots/);
        expect(() => parseFlow('{"slate": 3, "name": "f", "instances": [{"id": "a", "node": "x"}, {"id": "a", "node": "y"}]}')).toThrow(/unique/);
    });

    it('derives ports from parameters: no ports for *args/**kwargs, optional when defaulted, class ports from __init__', () => {
        const units = parseModule('class Box:\n    def __init__(self, width: int, label: str = "") -> None:\n        pass\n', 'x').units;
        const box = unitSignature(units[0], units);
        expect(inputPorts(box)).toEqual([
            { id: 'in:width', name: 'width', annotation: 'int', optional: false },
            { id: 'in:label', name: 'label', annotation: 'str', optional: true },
        ]);
        expect(outputPorts(box)).toEqual([{ id: 'out', name: 'out', annotation: 'Box' }]);
        const stats = parseModule(nodes.get('math/stats')!.code.join('\n'), 'x').units[0];
        expect(inputPorts(unitSignature(stats, [stats])).map(port => port.id)).toEqual(['in:xs', 'in:scale']);
    });

    it('lets an input hold one wire', () => {
        const wired = connect(connect(flow({ name: 'f' }), 'a.out', 'b.in:x'), 'c.out', 'b.in:x');
        expect(wired.wires).toEqual([{ from: 'c.out', to: 'b.in:x' }]);
    });

    it('extracts a selection into a flow, turning crossing wires into shared inputs and named outputs', () => {
        const parent = flow({
            name: 'main',
            inputs: [{ name: 'n', annotation: 'int' }],
            outputs: [{ name: 'result', annotation: 'int' }],
            instances: [{ id: 'a', node: 'math/double' }, { id: 'b', node: 'math/add' }, { id: 'c', node: 'math/double' }, { id: 'd', node: 'math/double' }],
            wires: [
                { from: 'input:n', to: 'a.in:x' },
                { from: 'input:n', to: 'b.in:b' },
                { from: 'a.out', to: 'b.in:a' },
                { from: 'b.out', to: 'output:result' },
                { from: 'b.out', to: 'c.in:x' },
                { from: 'a.out', to: 'd.in:x' },
            ],
        });
        const ports = (): { inputs: Port[]; outputs: Port[] } => ({
            inputs: [{ id: 'in:x', name: 'x', annotation: 'int' }, { id: 'in:a', name: 'a', annotation: 'int' }, { id: 'in:b', name: 'b', annotation: 'int' }],
            outputs: [{ id: 'out', name: 'out', annotation: 'int' }],
        });
        const { parent: rest, child } = extractFlow(parent, ['a', 'b'], { id: 'inner', name: 'inner', instanceId: 'g' }, ports);
        // input:n feeds two inside ports through one input; a and b both leave the group, so two outputs.
        expect(child.inputs).toEqual([{ name: 'x', annotation: 'int' }]);
        expect(child.outputs).toEqual([{ name: 'add', annotation: 'int' }, { name: 'double', annotation: 'int' }]);
        expect(child.wires).toEqual(expect.arrayContaining([
            { from: 'a.out', to: 'b.in:a' }, { from: 'input:x', to: 'a.in:x' }, { from: 'input:x', to: 'b.in:b' },
            { from: 'b.out', to: 'output:add' }, { from: 'a.out', to: 'output:double' },
        ]));
        expect(rest.instances.map(instance => instance.id)).toEqual(['c', 'd', 'g']);
        expect(rest.wires).toEqual(expect.arrayContaining([
            { from: 'input:n', to: 'g.in:x' }, { from: 'g.out:add', to: 'output:result' }, { from: 'g.out:add', to: 'c.in:x' }, { from: 'g.out:double', to: 'd.in:x' },
        ]));
        expect(rest.wires).toHaveLength(4);

        // One distinct inside source → a single `out` port, even with two outside targets.
        const single = extractFlow(parent, ['b'], { id: 'one', name: 'one', instanceId: 'h' }, ports).parent;
        expect(single.wires).toEqual(expect.arrayContaining([{ from: 'h.out', to: 'output:result' }, { from: 'h.out', to: 'c.in:x' }]));
    });
});

describe('flow codegen', () => {
    it('fans out, uses defaults and positional-only parameters, imports only what the body needs', () => {
        const result = compile([['pipeline', flow({
            name: 'pipeline',
            inputs: [{ name: 'n', annotation: 'int' }, { name: 'xs', annotation: 'List[int]' }],
            outputs: [{ name: 'total', annotation: 'int' }],
            instances: [{ id: 'd', node: 'math/double' }, { id: 'p', node: 'math/add' }, { id: 's', node: 'math/stats' }],
            wires: [
                { from: 'input:n', to: 'd.in:x' },
                { from: 'd.out', to: 'p.in:a' },
                { from: 'input:xs', to: 's.in:xs' },
                { from: 'p.out', to: 'output:total' },
            ],
        })]]);
        expect(result.diagnostics).toEqual([]);
        expect(result.files.get('demo.py')).toContain([
            '# slate: flows/pipeline',
            'def pipeline(n: int, xs: List[int]) -> int:',
            '    v_d = double(x=n)',
            '    v_p = add(v_d)',
            '    v_s = stats(xs=xs)',
            '    return v_p',
        ].join('\n'));
        // stats needs `import os`, but the flow body does not.
        expect(result.files.get('demo.py')).toMatch(/^from typing import List\nfrom math import add, double, stats\n\n/m);
    });

    it('returns a tuple for several outputs and unpacks it where the flow is used, across modules', () => {
        const result = compile([
            ['math/pair', flow({
                name: 'pair', inputs: [{ name: 'n', annotation: 'int' }],
                outputs: [{ name: 'once', annotation: 'int' }, { name: 'twice', annotation: null }],
                instances: [{ id: 'd', node: 'math/double' }],
                wires: [{ from: 'input:n', to: 'output:once' }, { from: 'input:n', to: 'd.in:x' }, { from: 'd.out', to: 'output:twice' }],
            })],
            ['use', flow({
                name: 'use', inputs: [{ name: 'n', annotation: 'int' }, { name: 'unused', annotation: null }],
                outputs: [{ name: 'r', annotation: 'int' }],
                instances: [{ id: 'k', kind: 'value', value: '3' }, { id: 'x', node: 'math/pair' }],
                wires: [{ from: 'k.out', to: 'x.in:n' }, { from: 'x.out:twice', to: 'output:r' }],
            })],
        ]);
        expect(result.diagnostics).toEqual([{ severity: 'warning', message: 'flows/use: input n is unused.' }, { severity: 'warning', message: 'flows/use: input unused is unused.' }]);
        expect(result.files.get('math.py')).toContain('def pair(n: int):\n    v_d = double(x=n)\n    return (n, v_d)');
        expect(result.files.get('demo.py')).toContain('from math import pair\n');
        expect(result.files.get('demo.py')).toContain('def use(n: int, unused) -> int:\n    v_k = 3\n    v_x_once, v_x_twice = pair(n=v_k)\n    return v_x_twice');
    });

    it('calls library units through an import of their module', () => {
        const result = compile([['f', flow({ name: 'f', instances: [{ id: 's', node: 'lib:vendor/text.py:shout' }] })]],
            new Map([['lib:vendor/text.py:shout', { name: 'shout', params: [{ name: 'text', annotation: 'str', default: '""', kind: 'keyword' as const }], returns: 'str' }]]));
        expect(result.diagnostics).toEqual([]);
        expect(result.files.get('demo.py')).toContain('from vendor.text import shout\n');
        expect(result.files.get('demo.py')).toContain('def f() -> None:\n    v_s = shout()');
    });

    it('diagnoses unwired inputs and outputs, bad wires, cycles, missing targets, and name collisions', () => {
        const messages = compile([
            ['bad', flow({
                name: 'bad', outputs: [{ name: 'r', annotation: null }],
                instances: [{ id: 'a', node: 'math/double' }, { id: 'b', node: 'math/double' }, { id: 'm', node: 'gone' }, { id: 'p', node: 'math/add' }],
                wires: [{ from: 'a.out', to: 'b.in:x' }, { from: 'b.out', to: 'a.in:x' }, { from: 'a.out', to: 'b.in:nope' }, { from: 'input:zzz', to: 'p.in:b' }],
            })],
            ['names', flow({ name: 'names', instances: [{ id: 'x-1', kind: 'value', value: '1' }, { id: 'x_1', kind: 'value', value: '2' }] })],
            ['math/double', flow({ name: 'double' })],
            ['math/clash', flow({ name: 'add' })],
        ]).diagnostics.map(item => `${item.severity}: ${item.message}`).join('\n');
        expect(messages).toContain('error: flows/bad: instance m calls gone, which does not exist.');
        expect(messages).toContain('error: flows/bad: wire a.out → b.in:nope has an unknown endpoint.');
        expect(messages).toContain('error: flows/bad: wire input:zzz → p.in:b has an unknown endpoint.');
        expect(messages).toContain('error: flows/bad: instances a, b form a cycle.');
        expect(messages).toContain('error: flows/bad: p.in:a is not wired and has no default.');
        expect(messages).toContain('error: flows/bad: output r is not wired.');
        expect(messages).toContain('error: flows/names: instance x_1 needs a distinct variable name (v_x_1).');
        expect(messages).toContain('error: flows/math/double has the same id as a node.');
        expect(messages).toMatch(/error: math\.py: name collision on "add" \(node math\/(add|clash) vs node math\/(add|clash)/);
    });
});
