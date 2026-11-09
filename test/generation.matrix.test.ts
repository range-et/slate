import { describe, expect, it, vi } from 'vitest';
import { buildGenerationPacket, PacketError, stripModelEnvelope } from '../vscode-extension/src/generation';
import { buildDescribePacket, describeNodes, describeOrder, parseDescribeReply } from '../vscode-extension/src/port/describe';
import { indexNode, parseNode } from '../vscode-extension/src/slate_folder';

function fixture(patch: Record<string, unknown> = {}) {
    const target = indexNode('slate/nodes/run.json', JSON.stringify({ slate: 3, name: 'run', intent: ' Return x ',
        contract: ' Preserve x ', code: ['def run(x: int) -> int:', '    return x'], ...patch }), 'python', 1);
    return { target, snapshot: { revision: 1, projectName: 'demo', documents: [target.document] },
        sources: new Map([[target.document.path, target.code]]) };
}

describe('generation contract matrix', () => {
    it.each([
        ['locked', { locked: true }, /locked/], ['empty intent', { intent: ' ' }, /intent/],
        ['untyped return', { code: ['def run(x):', '    return x'] }, /typed parameter/],
        ['class', { code: ['class run:', '    pass'] }, /top-level functions/],
        ['missing context', { context: ['missing'] }, /resolved to 0/],
    ])('rejects %s', (_label, patch, error) => {
        const { snapshot, sources } = fixture(patch as Record<string, unknown>);
        expect(() => buildGenerationPacket(snapshot, sources, 'run', 4096, 512)).toThrow(error as RegExp);
    });
    it.each(['missing target', 'duplicate target', 'provisional target', 'missing source', 'missing context source'])('rejects %s', mode => {
        const { snapshot, sources, target } = fixture();
        if (mode === 'missing target') snapshot.documents = [];
        if (mode === 'duplicate target') snapshot.documents.push(target.document);
        if (mode === 'provisional target') target.document.units[0].identity = 'provisional';
        if (mode === 'missing source') sources.clear();
        if (mode === 'missing context source') {
            const dependency = indexNode('slate/nodes/helper.json', '{"slate":3,"name":"helper","code":["def helper():","    pass"]}', 'python', 1);
            snapshot.documents.push(dependency.document);
            target.document.units[0].annotation!.dependencies = ['helper'];
        }
        expect(() => buildGenerationPacket(snapshot, sources, 'run', 4096, 512)).toThrow(PacketError);
    });
    it('accepts the exact token budget and rejects one token less', () => {
        const { snapshot, sources } = fixture();
        const packet = buildGenerationPacket(snapshot, sources, 'run', 4096, 512);
        expect(packet).toMatchObject({ intent: 'Return x', contract: 'Preserve x', outputBudgetTokens: 512 });
        expect(packet.items).toHaveLength(1);
        expect(packet.items[0]).toMatchObject({ id: 'run', role: 'target', source: 'def run(x: int) -> int:\n    return x' });
        const exact = packet.estimatedInputTokens + 512;
        expect(buildGenerationPacket(snapshot, sources, 'run', exact, 512).inputBudgetTokens).toBe(packet.estimatedInputTokens);
        expect(() => buildGenerationPacket(snapshot, sources, 'run', exact - 1, 512)).toThrow(/not truncated/);
    });
    it.each([512, 511])('rejects context window %i with output budget 512', window => {
        const { snapshot, sources } = fixture();
        expect(() => buildGenerationPacket(snapshot, sources, 'run', window, 512)).toThrow(/smaller/);
    });
    it.each([
        ['  x = 1  ', 'x = 1'], ['```\nx = 1\n```', 'x = 1'], ['```PYTHON\nx = 1\n```', 'x = 1'],
        ['```javascript\nx = 1\n```', '```javascript\nx = 1\n```'],
        ['Explanation\n```python\nx = 1\n```', 'Explanation\n```python\nx = 1\n```'], ['', ''],
    ])('unwraps envelope %j', (reply, expected) => expect(stripModelEnvelope(reply)).toBe(expected));
});

describe('describe matrix', () => {
    it.each([
        ['intent: Adds values', { intent: 'Adds values', contract: '' }],
        [' INTENT: `Adds values`\nCONTRACT: Returns sum ', { intent: 'Adds values', contract: 'Returns sum' }],
        ['```text\nintent: Adds values\n```', { intent: 'Adds values', contract: '' }],
        [`intent: ${'x'.repeat(240)}`, { intent: 'x'.repeat(240), contract: '' }],
        [`intent: ${'x'.repeat(241)}`, null], ['intent: a\nIntent: b', null],
        ['intent: a\ncontract: b\ncontract: c', null], ['intent: ', null],
        ['contract: only', null], ['', null], ['intent: a\nextra: b', null],
    ])('parses reply %j', (reply, expected) => expect(parseDescribeReply(reply)).toEqual(expected));

    const makeNode = (name: string, uses: string[] = []) => parseNode(JSON.stringify({ slate: 3, name, uses, code: [`def ${name}():`, '    return 1'] }));
    it.each([
        ['empty', [], []],
        ['missing dependency', [['a', ['missing']]], ['a']],
        ['self reference', [['a', ['a']]], ['a']],
        ['diamond', [['a', ['b', 'c']], ['b', ['d']], ['c', ['d']], ['d', []]], ['d', 'b', 'c', 'a']],
        ['cycle', [['b', ['a']], ['a', ['b']]], ['b', 'a']],
    ] as const)('orders %s', (_label, entries, expected) => {
        const nodes = new Map(entries.map(([id, uses]) => [id, makeNode(id, [...uses])] as const));
        expect(describeOrder(nodes)).toEqual(expected);
    });
    it('keeps a class body and excludes module-state and missing dependencies', () => {
        const node = parseNode('{"slate":3,"name":"Box","uses":["state","missing"],"code":["class Box:","    pass"]}');
        const state = { ...makeNode('state'), kind: 'prelude' as const };
        const nodes = new Map([['Box', node], ['state', state]]);
        expect(describeOrder(nodes)).toEqual(['Box']);
        const prompt = buildDescribePacket('Box', nodes, 4096);
        expect(prompt).toContain('Describe what this class does.');
        expect(prompt).toContain('class Box:\n    pass');
        expect(prompt).not.toContain('It uses:');
    });
    it.each(['already described', 'cancelled', 'oversized'])('does no model or write work when %s', async mode => {
        const node = makeNode('run');
        if (mode === 'already described') node.intent = 'Done';
        const controller = new AbortController();
        if (mode === 'cancelled') controller.abort();
        const complete = vi.fn(async () => 'intent: Done');
        const write = vi.fn(async () => {});
        const report = await describeNodes({ nodes: new Map([['run', node]]), complete, write,
            onProgress: vi.fn(), signal: controller.signal, hardLimitTokens: mode === 'oversized' ? 1 : 4096 });
        expect(complete).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(report.described).toEqual([]);
        expect(report.cancelled).toBe(mode === 'cancelled');
        expect(report.skipped).toHaveLength(mode === 'oversized' ? 1 : 0);
    });
    it('propagates persistence errors without marking a node described', async () => {
        const node = makeNode('run');
        const nodes = new Map([['run', node]]);
        await expect(describeNodes({ nodes, complete: async () => 'intent: Done',
            write: async () => { throw new Error('disk full'); }, onProgress: () => {},
            signal: new AbortController().signal, hardLimitTokens: 4096 })).rejects.toThrow('disk full');
        expect(nodes.get('run')).toBe(node);
        expect(node.intent).toBe('');
    });
});

it('describes dependencies with fallback signatures when their named definition is unavailable', () => {
    const make = (name: string, code: string[], uses: string[] = []) => parseNode(JSON.stringify({ slate: 3, name, code, uses }));
    const nodes = new Map([
        ['target', make('target', ['def target():', '    pass'], ['renamed', 'stub', 'async_stub'])],
        ['renamed', make('renamed', ['def old_name(value):', '    pass'])],
        ['stub', make('stub', ['# pending implementation'])],
        ['async_stub', make('async_stub', ['async def old_async(value):', '    pass'])],
    ]);
    const packet = buildDescribePacket('target', nodes, 4096);
    expect(packet).toContain('- def old_name(value)');
    expect(packet).toContain('- stub');
    expect(packet).toContain('- async def old_async(value)');
    expect(packet).toContain('def target():\n    pass');
});

it('normalizes absent or nonstring optional metadata and clamps ranges to the available source', () => {
    const { snapshot, sources, target } = fixture();
    const unit = target.document.units[0];
    unit.annotation!.contract = 123;
    unit.annotation!.dependencies = null;
    sources.set(target.document.path, 'def run(x: int) -> int: return x');
    const packet = buildGenerationPacket(snapshot, sources, 'run', 4096, 512);
    expect(packet.contract).toBe('');
    expect(packet.items).toHaveLength(1);
    expect(packet.items[0].source).toBe('def run(x: int) -> int: return x');
    unit.annotation!.intent = null;
    expect(() => buildGenerationPacket(snapshot, sources, 'run', 4096, 512)).toThrow(/intent/);
});

it('reports non-Error model failures without writing or describing the node', async () => {
    const node = parseNode('{"slate":3,"name":"run","code":["def run():","    pass"]}');
    const write = vi.fn(async () => {});
    const report = await describeNodes({ nodes: new Map([['run', node]]),
        complete: async () => { throw 'connection rejected'; }, write,
        onProgress: () => {}, signal: new AbortController().signal, hardLimitTokens: 4096 });
    expect(report.skipped).toEqual([{ nodeId: 'run', reason: 'connection rejected' }]);
    expect(report.described).toEqual([]);
    expect(report.cancelled).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(node.intent).toBe('');
});
