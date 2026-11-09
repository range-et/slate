import { describe, expect, it } from 'vitest';
import {
    FlowFormatError, connect, disconnect, emptyFlow, extractFlow, flowIdForPath,
    flowSignature, inputPorts, outputPorts, parseEndpoint, parseFlow, pathForFlowId,
    removeInstances, serializeFlow, uniqueName, unitSignature,
} from '../vscode-extension/src/flow';
import { parseModule } from '../vscode-extension/src/python_adapter';

describe('flow validation matrix', () => {
    it.each([
        ['version', { slate: 2 }, /declaring/], ['name', { name: 'a.b' }, /identifier/],
        ['instances list', { instances: {} }, /list/],
        ['instance id', { instances: [{ id: 'a.b', node: 'f' }] }, /without dots/],
        ['empty id', { instances: [{ id: '', node: 'f' }] }, /without dots/],
        ['missing target', { instances: [{ id: 'a' }] }, /needs a node/],
        ['duplicate ids', { instances: [{ id: 'a', node: 'f' }, { id: 'a', kind: 'value', value: '1' }] }, /unique/],
        ['wires list', { wires: {} }, /wires/],
        ['wire endpoint', { wires: [{ from: 'a', to: 1 }] }, /wires/],
        ...['inputs', 'outputs'].flatMap<[string, Record<string, unknown>, RegExp]>(key => [
            [`${key} list`, { [key]: {} }, /list/],
            [`${key} identifier`, { [key]: [{ name: 'bad-name' }] }, /identifier/],
            [`${key} annotation`, { [key]: [{ name: 'x', annotation: 1 }] }, /annotation/],
        ]),
    ])('rejects invalid %s', (_label, patch, error) => {
        const read = () => parseFlow(JSON.stringify({ slate: 3, name: 'run', ...(patch as object) }));
        expect(read).toThrow(FlowFormatError);
        expect(read).toThrow(error as RegExp);
    });
    it.each(['{', 'null', '[]'])('rejects document %s', text => {
        expect(() => parseFlow(text)).toThrow(FlowFormatError);
    });
    it.each([
        ['1 + 2', '1 + 2'], [42, '42'], [false, 'false'], [null, 'null'],
        [undefined, 'null'], [[1, 2], '[1,2]'],
    ])('normalizes literal %j and round-trips extras', (value, expected) => {
        const flow = parseFlow(JSON.stringify({ slate: 3, name: 'run', custom: { enabled: true },
            instances: [{ id: 'v', kind: 'value', value }] }));
        expect(flow.instances).toEqual([{ id: 'v', kind: 'value', value: expected }]);
        expect(flow.extra).toEqual({ custom: { enabled: true } });
        expect(parseFlow(serializeFlow(flow))).toEqual(flow);
    });
});

describe('flow helpers and edit matrix', () => {
    it.each([
        ['slate/flows/main.json', 'main'], ['slate\\flows\\pkg\\run.json', 'pkg/run'],
        ['flows/run.json', null], ['slate/flows/run.py', null],
    ])('maps %s', (path, id) => {
        expect(flowIdForPath(path)).toBe(id);
        if (id !== null) expect(flowIdForPath(pathForFlowId(id))).toBe(id);
    });
    it.each([
        ['input:x', null, 'input:x'], ['output:y', null, 'output:y'],
        ['a', 'a', 'out'], ['a.in:x', 'a', 'in:x'], ['a.out:result', 'a', 'out:result'],
    ])('parses endpoint %s', (value, instance, port) => {
        expect(parseEndpoint(value)).toEqual({ instance, port });
    });
    it.each([
        ['value', [], 'value'], ['', [], 'value'], ['123', [], '_123'],
        ['a/b-c', [], 'a_b_c'], ['x', ['x', 'x_2', 'x_4'], 'x_3'],
    ])('allocates %j avoiding %j', (base, taken, expected) => {
        expect(uniqueName(base, taken)).toBe(expected);
    });
    it.each([0, 1, 2])('derives signatures and ports for %i outputs', count => {
        const flow = { ...emptyFlow('run'), inputs: [{ name: 'x', annotation: 'int' }],
            outputs: ['a', 'b'].slice(0, count).map(name => ({ name, annotation: 'str' })) };
        const signature = flowSignature(flow);
        expect(signature.returns).toBe(count === 1 ? 'str' : null);
        expect(inputPorts(signature)).toEqual([{ id: 'in:x', name: 'x', annotation: 'int', optional: false }]);
        expect(outputPorts(signature)).toEqual(count === 0 ? [] : count === 1
            ? [{ id: 'out', name: 'a', annotation: 'str' }]
            : [{ id: 'out:a', name: 'a', annotation: 'str' }, { id: 'out:b', name: 'b', annotation: 'str' }]);
    });
    it.each([
        ['def run(a, /, b=0, *args, c=None, **kwargs):\n    pass\n', ['a', 'b', 'c'], [false, true, true], null],
        ['class Run:\n    pass\n', [], [], 'Run'],
        ['class Run:\n    def __init__(self, x: int = 0):\n        pass\n', ['x'], [true], 'Run'],
    ])('derives callable ports from %s', (source, names, optional, returns) => {
        const parsed = parseModule(source);
        const signature = unitSignature(parsed.units[0], parsed.units);
        expect(inputPorts(signature).map(port => port.name)).toEqual(names);
        expect(inputPorts(signature).map(port => port.optional)).toEqual(optional);
        expect(outputPorts(signature)).toEqual([{ id: 'out', name: 'out', annotation: returns }]);
    });

    const fixture = () => ({ ...emptyFlow('main'), instances: [{ id: 'a', node: 'add' }, { id: 'ab', node: 'add' }],
        wires: [{ from: 'input:x', to: 'a.in:x' }, { from: 'a.out', to: 'ab.in:x' }, { from: 'ab.out', to: 'output:y' }] });
    it.each([
        ['connect', (flow: ReturnType<typeof fixture>) => connect(flow, 'input:z', 'a.in:x'),
            [{ from: 'a.out', to: 'ab.in:x' }, { from: 'ab.out', to: 'output:y' }, { from: 'input:z', to: 'a.in:x' }]],
        ['disconnect', (flow: ReturnType<typeof fixture>) => disconnect(flow, 'a.out', 'ab.in:x'),
            [{ from: 'input:x', to: 'a.in:x' }, { from: 'ab.out', to: 'output:y' }]],
        ['disconnect absent', (flow: ReturnType<typeof fixture>) => disconnect(flow, 'input:z', 'a.in:x'), fixture().wires],
        ['remove', (flow: ReturnType<typeof fixture>) => removeInstances(flow, ['a']), [{ from: 'ab.out', to: 'output:y' }]],
        ['remove absent', (flow: ReturnType<typeof fixture>) => removeInstances(flow, ['missing']), fixture().wires],
        ['remove all', (flow: ReturnType<typeof fixture>) => removeInstances(flow, ['a', 'ab']), []],
    ] as const)('%s preserves the original and unrelated wires', (_label, edit, wires) => {
        const original = fixture();
        const before = JSON.stringify(original);
        const result = edit(original);
        expect(result).not.toBe(original);
        expect(result.wires).toEqual(wires);
        expect(JSON.stringify(original)).toBe(before);
        if (_label === 'remove') expect(result.instances).toEqual([{ id: 'ab', node: 'add' }]);
        if (_label === 'remove all') expect(result.instances).toEqual([]);
    });
    it('extracts all instances while preserving external ports and the original flow', () => {
        const original = fixture();
        const result = extractFlow(original, ['a', 'ab', 'missing'], { id: 'child', name: 'child', instanceId: 'c' },
            () => ({ inputs: [{ id: 'in:x', name: 'x', annotation: 'int' }], outputs: [{ id: 'out', name: 'out', annotation: 'int' }] }));
        expect(original).toEqual(fixture());
        expect(result.parent.instances).toEqual([{ id: 'c', node: 'child' }]);
        expect(result.parent.wires).toEqual([{ from: 'input:x', to: 'c.in:x' }, { from: 'c.out', to: 'output:y' }]);
        expect(result.child.instances).toEqual(original.instances);
        expect(result.child.inputs).toEqual([{ name: 'x', annotation: 'int' }]);
        expect(result.child.outputs).toEqual([{ name: 'add', annotation: 'int' }]);
        expect(result.child.wires).toEqual([{ from: 'a.out', to: 'ab.in:x' }, { from: 'input:x', to: 'a.in:x' }, { from: 'ab.out', to: 'output:add' }]);
    });
});
