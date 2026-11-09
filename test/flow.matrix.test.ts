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

it('round-trips named ports and wires while stripping unexpected wire properties', () => {
    const parsed = parseFlow(JSON.stringify({ slate: 3, name: 'pipeline',
        inputs: [{ name: 'plain' }, { name: 'nullable', annotation: null }, { name: 'typed', annotation: 'int' }],
        outputs: [{ name: 'result', annotation: 'float' }],
        instances: [{ id: 'worker', node: 'calculate' }],
        wires: [{ from: 'input:typed', to: 'worker.in:value', ignored: 'not persisted' },
            { from: 'worker.out', to: 'output:result' }],
    }));
    expect(parsed.inputs).toEqual([{ name: 'plain', annotation: null }, { name: 'nullable', annotation: null }, { name: 'typed', annotation: 'int' }]);
    expect(parsed.wires).toEqual([{ from: 'input:typed', to: 'worker.in:value' }, { from: 'worker.out', to: 'output:result' }]);
    expect(parseFlow(serializeFlow(parsed))).toEqual(parsed);
});

it('uses empty optional signature metadata when a callable supplies none', () => {
    const unit = parseModule('def f():\n    pass\n', 'test.py').units[0];
    expect(unitSignature({ ...unit, params: undefined, returnAnnotation: undefined }, [unit]))
        .toEqual({ name: 'f', params: [], returns: null });
});

it('extracts value and named-output boundaries without inventing unavailable port annotations', () => {
    const parent = { ...emptyFlow('parent'),
        instances: [{ id: 'value', kind: 'value' as const, value: '1' }, { id: 'worker', node: 'worker' }, { id: 'sink', node: 'sink' }],
        wires: [{ from: 'input:external', to: 'worker.in:unknown' }, { from: 'value.out', to: 'sink.in:x' },
            { from: 'worker.out:result', to: 'sink.in:y' }],
    };
    const before = structuredClone(parent);
    const result = extractFlow(parent, ['value', 'worker'], { id: 'child', instanceId: 'group', name: 'child' }, () => ({ inputs: [], outputs: [] }));
    expect(result.child.inputs).toEqual([{ name: 'unknown', annotation: null }]);
    expect(result.child.outputs).toEqual([{ name: 'value', annotation: null }, { name: 'result', annotation: null }]);
    expect(result.parent.wires).toEqual(expect.arrayContaining([
        { from: 'input:external', to: 'group.in:unknown' }, { from: 'group.out:value', to: 'sink.in:x' }, { from: 'group.out:result', to: 'sink.in:y' },
    ]));
    expect(parent).toEqual(before);
});

describe('flow identifier type boundaries', () => {
    it.each([undefined, null, false, 1, [], ['valid_name'], {}])('rejects flow name %j as a format error', name => {
        const read = () => parseFlow(JSON.stringify({ slate: 3, name }));
        expect(read).toThrow(FlowFormatError);
        expect(read).toThrow('name must be an identifier');
    });
    it.each(['inputs', 'outputs'])('rejects non-string %s names before coercing to identifiers', field => {
        for (const name of [undefined, null, false, 1, [], ['valid_name'], {}]) {
            const read = () => parseFlow(JSON.stringify({ slate: 3, name: 'run', [field]: [{ name }] }));
            expect(read).toThrow(FlowFormatError);
            expect(read).toThrow(`${field} entries need an identifier name`);
        }
    });
    it('identifies malformed JSON and rejects non-string instance IDs', () => {
        expect(() => parseFlow('{')).toThrow(/^not valid JSON:/);
        for (const id of [undefined, null, false, 1, [], ['valid_id'], {}]) {
            const read = () => parseFlow(JSON.stringify({ slate: 3, name: 'run', instances: [{ id, node: 'run' }] }));
            expect(read).toThrow(FlowFormatError);
            expect(read).toThrow('instances need an id without dots');
        }
    });
});
