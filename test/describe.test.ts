import { afterEach, describe, expect, it } from 'vitest';

import { streamLlamaCompletion } from '../vscode-extension/src/llama_transport';
import { buildDescribePacket, describeNodes, parseDescribeReply } from '../vscode-extension/src/port/describe';
import type { SlateNode } from '../vscode-extension/src/slate_folder';
import { startFakeLlamaServer, type FakeLlamaReply, type FakeLlamaServer } from './support/fake_llama_server';

function node(name: string, uses: string[] = [], intent = '', code?: string[]): SlateNode {
    return {
        name, intent, contract: '', context: [], examples: [], locked: false, imports: [], uses, extra: {},
        code: code ?? [`def ${name}(x: int) -> int:`, `    return x`],
    };
}

// main → helper → leaf; ring_a ↔ ring_b form a cycle; done is already described; _prelude is module state.
function project(): Map<string, SlateNode> {
    return new Map([
        ['app/main', node('main', ['app/helper', 'app/_prelude'])],
        ['app/helper', node('helper', ['lib/leaf'])],
        ['lib/leaf', node('leaf')],
        ['ring/ring_b', node('ring_b', ['ring/ring_a'])],
        ['ring/ring_a', node('ring_a', ['ring/ring_b'])],
        ['lib/done', node('done', [], 'Already described by a human')],
        ['app/_prelude', { ...node('_prelude'), kind: 'prelude', code: ['LIMIT = 3'] }],
    ]);
}

const targetOf = (request: Record<string, unknown>) => {
    const prompt = (request.messages as Array<{ content: string }>)[1].content;
    return prompt.match(/```python\n(?:def|class) (\w+)/)![1];
};

let server: FakeLlamaServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function run(reply: FakeLlamaReply, options: { nodes?: Map<string, SlateNode>; delayMs?: number; timeoutMs?: number; abortAfterMs?: number; abortAfterWrites?: number } = {}) {
    server = await startFakeLlamaServer(reply, { delayMs: options.delayMs });
    const nodes = options.nodes ?? project();
    const writes: Array<[string, { intent: string; contract: string }]> = [];
    const progress: string[] = [];
    const controller = new AbortController();
    if (options.abortAfterMs !== undefined) setTimeout(() => controller.abort(), options.abortAfterMs);
    const report = await describeNodes({
        nodes,
        complete: (prompt, signal) => streamLlamaCompletion(prompt, {
            endpoint: server!.url, model: 'local', outputTokens: 120, timeoutMs: options.timeoutMs ?? 2000,
        }, signal, () => {}),
        write: async (nodeId, described) => {
            writes.push([nodeId, described]);
            if (writes.length === options.abortAfterWrites) controller.abort();
        },
        onProgress: message => progress.push(message),
        signal: controller.signal,
        hardLimitTokens: 4000,
    });
    return { report, writes, progress, nodes, requests: server.requests };
}

describe('describe pass', () => {
    it('describes leaves first, breaks cycles by id, skips described nodes, and shows used intents', async () => {
        const { report, writes, requests } = await run(request => [`intent: Describes ${targetOf(request)}\n`, 'contract: returns x\n']);
        expect(requests.map(targetOf)).toEqual(['leaf', 'helper', 'main', 'ring_b', 'ring_a']);
        expect(writes.map(([nodeId]) => nodeId)).toEqual(['lib/leaf', 'app/helper', 'app/main', 'ring/ring_b', 'ring/ring_a']);
        expect(writes[0][1]).toEqual({ intent: 'Describes leaf', contract: 'returns x' });
        // helper's packet carries leaf's signature and the intent written moments earlier.
        const helperPrompt = (requests[1].messages as Array<{ content: string }>)[1].content;
        expect(helperPrompt).toContain('- def leaf(x: int) -> int — Describes leaf');
        expect(helperPrompt).not.toContain('return x\n```\n\n```');
        expect(report).toEqual({ described: writes.map(([nodeId]) => nodeId), skipped: [], cancelled: false });
    });

    it('resumes where a cancelled run stopped', async () => {
        const first = await run(['intent: Done\n'], { abortAfterWrites: 2 });
        expect(first.report.cancelled).toBe(true);
        expect(first.writes.map(([nodeId]) => nodeId)).toEqual(['lib/leaf', 'app/helper']);
        await server!.close();
        server = undefined;
        // The panel re-reads node files, so described nodes now carry intents.
        const second = await run(request => [`intent: Again ${targetOf(request)}\n`], { nodes: first.nodes });
        expect(second.requests.map(targetOf)).toEqual(['main', 'ring_b', 'ring_a']);
    });

    it('retries a malformed reply once, then skips the node and keeps going', async () => {
        const { report, writes, requests } = await run((request, index) => {
            const target = targetOf(request);
            if (target === 'leaf') return ['Sure! This function returns x.\n'];
            if (target === 'helper' && index === 3) return ['intent: Fixed on retry\n'];
            return target === 'helper' ? ['intent: one\nintent: two\n'] : ['intent: ok\n'];
        });
        expect(requests.map(targetOf).slice(0, 4)).toEqual(['leaf', 'leaf', 'helper', 'helper']);
        expect(report.skipped).toEqual([{ nodeId: 'lib/leaf', reason: 'malformed reply' }]);
        expect(writes.find(([nodeId]) => nodeId === 'app/helper')![1].intent).toBe('Fixed on retry');
        expect(report.described).toHaveLength(4);
    });

    it('skips a node whose request times out without retrying it', async () => {
        const { report, requests } = await run(['intent: late\n'], { delayMs: 400, timeoutMs: 100, nodes: new Map([['a', node('a')], ['b', node('b')]]) });
        expect(requests).toHaveLength(2);
        expect(report.skipped).toEqual([
            { nodeId: 'a', reason: 'llama.cpp request timed out.' },
            { nodeId: 'b', reason: 'llama.cpp request timed out.' },
        ]);
    });

    it('stops on cancel during a request and writes nothing', async () => {
        const { report, writes, requests, progress } = await run(['intent: late\n'], { delayMs: 300, abortAfterMs: 50 });
        expect(report.cancelled).toBe(true);
        expect(writes).toEqual([]);
        expect(requests).toHaveLength(1);
        expect(progress.at(-1)).toBe('Described 0 node(s); cancelled.');
    });

    it('accepts only one-line intent and contract replies', () => {
        expect(parseDescribeReply('```\nIntent: Adds two numbers\n```')).toEqual({ intent: 'Adds two numbers', contract: '' });
        expect(parseDescribeReply('contract: x\nintent: y')).toEqual({ intent: 'y', contract: 'x' });
        expect(parseDescribeReply('contract: only a contract')).toBeNull();
        expect(parseDescribeReply('intent: ok\nAnd some explanation')).toBeNull();
        expect(parseDescribeReply(`intent: ${'x'.repeat(241)}`)).toBeNull();
    });

    it('trims used-node context to the micro budget and refuses code beyond the hard limit', () => {
        const nodes = new Map<string, SlateNode>([['big', node('big', ['a', 'b'])], ['a', node('a', [], 'short')], ['b', node('b', [], 'x'.repeat(2400))]]);
        const prompt = buildDescribePacket('big', nodes, 4000);
        expect(prompt).toContain('- def a(x: int) -> int — short');
        expect(prompt).not.toContain('def b(');
        const huge = new Map([['huge', node('huge', [], '', ['def huge():', ...Array(400).fill('    x = 1')])]]);
        expect(() => buildDescribePacket('huge', huge, 1000)).toThrow(/too large/);
    });
});
