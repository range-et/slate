import * as fs from 'fs/promises';
import { createServer, type Server } from 'node:http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    batchForgeWorkspace,
    compactBatchForgeResult,
    compactFailureReason,
    partitionTargetsIntoWaves,
    type BatchForgeResult,
} from '../vscode-extension/src/batch_forge';
import { credentialPairingKey } from '../vscode-extension/src/llama_transport';
import { parseNode, serializeNode, type SlateNode } from '../vscode-extension/src/slate_folder';
import { startFakeLlamaServer } from './support/fake_llama_server';

function makeStubNode(
    name: string,
    signature: string,
    intent: string,
    cases?: unknown[],
    overrides?: Partial<SlateNode>,
): SlateNode {
    return {
        name,
        intent,
        contract: 'Follow exact parameter and return types.',
        context: [],
        cases,
        examples: [],
        describedBy: 'human',
        locked: false,
        imports: [],
        uses: [],
        code: [`${signature}:`, '    raise NotImplementedError'],
        extra: {},
        ...overrides,
    };
}

async function writeProject(
    root: string,
    llmConfig: Record<string, unknown>,
    nodes: Record<string, SlateNode>,
): Promise<void> {
    await fs.mkdir(path.join(root, 'slate', 'nodes'), { recursive: true });
    await fs.writeFile(
        path.join(root, 'slate', 'slate.json'),
        JSON.stringify({ slate: 3, name: 'batch_demo', language: 'python', llm: llmConfig }, null, 2),
        'utf8',
    );
    for (const [id, node] of Object.entries(nodes)) {
        const dest = path.join(root, 'slate', 'nodes', `${id}.json`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, serializeNode(node), 'utf8');
    }
}

async function startCustomSseServer(
    handler: (
        body: { model?: string; messages?: Array<{ role: string; content: string }> },
        headers: Record<string, string | string[] | undefined>,
    ) => Promise<string> | string,
): Promise<{ url: string; close(): Promise<void> }> {
    const server: Server = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/v1/models') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'qwen/qwen3-coder-30b-a3b-instruct' }] }));
            return;
        }
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
            res.writeHead(404).end();
            return;
        }
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { raw += chunk; });
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(raw);
                const text = await handler(parsed, req.headers);
                res.writeHead(200, {
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-cache',
                    connection: 'keep-alive',
                });
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
                res.end('data: [DONE]\n\n');
            } catch (error) {
                res.writeHead(500, { 'content-type': 'text/plain' });
                res.end(error instanceof Error ? error.message : String(error));
            }
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Server failed to bind');
    return {
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((resolve, reject) => {
            server.close(err => err ? reject(err) : resolve());
            server.closeAllConnections();
        }),
    };
}

describe('Stateless batched Tier 2 forge (batch_forge.ts)', () => {
    let tmpDir: string;
    let activeServer: { url: string; close(): Promise<void> } | undefined;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-batch-forge-'));
    });

    afterEach(async () => {
        await activeServer?.close();
        activeServer = undefined;
        await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('forges all unlocked stubs in parallel using <=600-token packets and skips locked/implemented nodes', async () => {
        await writeProject(
            tmpDir,
            {
                provider: 'openai-compatible',
                model: 'qwen/qwen3-coder-30b-a3b-instruct',
                apiKeyEnv: 'SLATE_TEST_KEY',
                concurrency: 3,
            },
            {
                alpha: makeStubNode('alpha', 'def alpha(x: int) -> int', 'Add one', [{ name: 'c1', input: { x: 2 }, expected: 3 }]),
                'sub/beta': makeStubNode('beta', 'def beta(x: int) -> int', 'Double x', [{ name: 'c1', input: { x: 4 }, expected: 8 }]),
                gamma: makeStubNode('gamma', 'def gamma(x: int) -> int', 'Square x', [{ name: 'c1', input: { x: 3 }, expected: 9 }]),
                locked_fn: makeStubNode('locked_fn', 'def locked_fn(x: int) -> int', 'Locked', [], { locked: true }),
                done_fn: makeStubNode('done_fn', 'def done_fn(x: int) -> int', 'Already done', [], {
                    code: ['def done_fn(x: int) -> int:', '    return x'],
                }),
            },
        );

        let inFlight = 0;
        let maxInFlight = 0;
        const seenPrompts: string[] = [];

        activeServer = await startCustomSseServer(async (body, headers) => {
            expect(headers.authorization).toBe('Bearer fake-batch-token');
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise(resolve => setTimeout(resolve, 40));
            const prompt = body.messages?.[1]?.content ?? '';
            seenPrompts.push(prompt);
            expect(Math.ceil(prompt.length / 4)).toBeLessThanOrEqual(600);
            inFlight--;

            if (prompt.includes('def alpha(')) {
                return '### Implementation\n```python\ndef alpha(x: int) -> int:\n    return x + 1\n```\n\n### Unit Check\n```python\ndef test_alpha():\n    assert alpha(2) == 3\n```';
            }
            if (prompt.includes('def beta(')) {
                return '### Implementation\n```python\ndef beta(x: int) -> int:\n    return x * 2\n```\n\n### Unit Check\n```python\ndef test_beta():\n    assert beta(4) == 8\n```';
            }
            return '### Implementation\n```python\ndef gamma(x: int) -> int:\n    return x * x\n```\n\n### Unit Check\n```python\ndef test_gamma():\n    assert gamma(3) == 9\n```';
        });

        const forgedIds: string[] = [];
        const mockExec = vi.fn(async (_cmd: string, args: string[]) => {
            if (args.includes('mutmut')) return { code: 1, stdout: '', stderr: 'not installed' };
            return { code: 0, stdout: '2 passed in 0.01s', stderr: '' };
        });

        const result = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            approvedCredentialPairings: [credentialPairingKey(activeServer.url, 'SLATE_TEST_KEY')],
            llmOverride: { endpoint: activeServer.url },
            env: { SLATE_TEST_KEY: 'fake-batch-token' },
            executeCommand: mockExec,
            onNodeForged: id => { forgedIds.push(id); },
        });

        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result.forgedCount).toBe(3);
        expect(result.failedCount).toBe(0);
        expect(result.skippedCount).toBe(0);
        expect(maxInFlight).toBeGreaterThanOrEqual(2);
        expect(seenPrompts).toHaveLength(3);
        expect(forgedIds.sort()).toEqual(['alpha', 'gamma', 'sub/beta']);

        const alphaDisk = parseNode(await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'alpha.json'), 'utf8'));
        expect(alphaDisk.code).toEqual(['def alpha(x: int) -> int:', '    return x + 1']);
        expect(alphaDisk.check).toEqual(['def test_alpha():', '    assert alpha(2) == 3']);
        expect(alphaDisk.verification?.state).toBe('passed');

        const lockedDisk = parseNode(await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'locked_fn.json'), 'utf8'));
        expect(lockedDisk.code[1]).toBe('    raise NotImplementedError');
    });

    it('retries with bounded feedback on validation failure and real Python pytest failure', async () => {
        await writeProject(
            tmpDir,
            { provider: 'llama.cpp', model: 'qwen', concurrency: 1 },
            {
                triple: makeStubNode('triple', 'def triple(x: int) -> int', 'Multiply integer x by 3', [
                    { name: 'basic', input: { x: 4 }, expected: 12 },
                    { name: 'zero', input: { x: 0 }, expected: 0 },
                ]),
            },
        );

        let callCount = 0;
        const prompts: string[] = [];
        activeServer = await startCustomSseServer(body => {
            callCount++;
            prompts.push(body.messages?.[1]?.content ?? '');
            if (callCount === 1) {
                // Attempt 1: wrong return annotation -> fails validateForgeCandidate before pytest
                return '### Implementation\n```python\ndef triple(x: int) -> str:\n    return str(x)\n```';
            }
            if (callCount === 2) {
                // Attempt 2: valid signature, wrong logic -> fails real pytest against MCP input case!
                return '### Implementation\n```python\ndef triple(x: int) -> int:\n    return x * 2\n```\n\n### Unit Check\n```python\ndef test_triple():\n    assert triple(4) == 8\n```';
            }
            // Attempt 3: fixed implementation
            return '### Implementation\n```python\ndef triple(x: int) -> int:\n    return x * 3\n```\n\n### Unit Check\n```python\ndef test_triple():\n    assert triple(4) == 12\n```';
        });

        const result = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            llmOverride: { endpoint: activeServer.url },
            maxRevisions: 3,
        });

        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result.forgedCount).toBe(1);
        expect(result.results[0].attempts).toBe(3);
        expect(result.results[0].verification?.state).toBe('passed');
        expect(prompts[1]).toContain('Candidate validation failed');
        expect(prompts[2]).toContain('Bounded Retry Feedback');
        expect(prompts[2]).not.toContain('=====');
        expect(prompts[2]).toContain('assert triple');

        const tripleDisk = parseNode(await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'triple.json'), 'utf8'));
        expect(tripleDisk.code).toEqual(['def triple(x: int) -> int:', '    return x * 3']);
        expect(tripleDisk.verification?.retryCount).toBe(2);
    }, 20_000);

    it('supports explicit nodeIds, overwrite, write: false dry-run, missing/locked/implemented skips, and path traversal checks', async () => {
        await writeProject(
            tmpDir,
            { provider: 'llama.cpp', model: 'qwen' },
            {
                stub_a: makeStubNode('stub_a', 'def stub_a(x: int) -> int', 'Identity x'),
                done_b: makeStubNode('done_b', 'def done_b(x: int) -> int', 'Plus one', undefined, {
                    code: ['def done_b(x: int) -> int:', '    return x + 1'],
                }),
                locked_c: makeStubNode('locked_c', 'def locked_c(x: int) -> int', 'Locked', undefined, { locked: true }),
            },
        );

        activeServer = await startCustomSseServer(body => {
            const p = body.messages?.[1]?.content ?? '';
            if (p.includes('def done_b(')) {
                return '### Implementation\n```python\ndef done_b(x: int) -> int:\n    return x + 2\n```';
            }
            return '### Implementation\n```python\ndef stub_a(x: int) -> int:\n    return x\n```';
        });

        await expect(batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            nodeIds: ['../../evil'],
            llmOverride: { endpoint: activeServer.url },
        })).rejects.toThrow(/Path traversal rejected/);

        const dryRun = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            nodeIds: ['missing_node', 'locked_c', 'done_b', 'stub_a'],
            write: false,
            llmOverride: { endpoint: activeServer.url },
        });
        expect(dryRun.ok).toBe(false);
        expect(dryRun.results.map(r => [r.nodeId, r.status, r.written])).toEqual([
            ['missing_node', 'failed', false],
            ['locked_c', 'skipped', false],
            ['done_b', 'skipped', false],
            ['stub_a', 'forged', false],
        ]);
        expect(dryRun.results[3].verification?.state).toBe('untested');
        expect(dryRun.results[3].proposedCode).toContain('return x');

        const stubBefore = parseNode(await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'stub_a.json'), 'utf8'));
        expect(stubBefore.code[1]).toBe('    raise NotImplementedError');

        const overwritten = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            nodeIds: ['done_b'],
            overwrite: true,
            verify: false,
            llmOverride: { endpoint: activeServer.url },
        });
        expect(overwritten.ok).toBe(true);
        expect(overwritten.results[0].written).toBe(true);
        const doneAfter = parseNode(await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'done_b.json'), 'utf8'));
        expect(doneAfter.code[1]).toBe('    return x + 2');
    });

    it('refuses to clobber concurrent disk edits and respects cancellation', async () => {
        await writeProject(
            tmpDir,
            { provider: 'llama.cpp', model: 'qwen' },
            {
                race: makeStubNode('race', 'def race(x: int) -> int', 'Race test'),
            },
        );

        activeServer = await startCustomSseServer(async () => {
            const racePath = path.join(tmpDir, 'slate', 'nodes', 'race.json');
            const edited = parseNode(await fs.readFile(racePath, 'utf8'));
            edited.code = ['def race(x: int) -> int:', '    return x + 99'];
            await fs.writeFile(racePath, serializeNode(edited), 'utf8');
            return '### Implementation\n```python\ndef race(x: int) -> int:\n    return x\n```';
        });

        const raceResult = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            verify: false,
            llmOverride: { endpoint: activeServer.url },
        });
        expect(raceResult.ok).toBe(false);
        expect(raceResult.failedCount).toBe(1);
        expect(raceResult.results[0].written).toBe(false);
        expect(raceResult.results[0].reason).toContain('changed on disk');

        const raceDisk = parseNode(await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'race.json'), 'utf8'));
        expect(raceDisk.code[1]).toBe('    return x + 99');

        const ac = new AbortController();
        ac.abort();
        const cancelled = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            nodeIds: ['race'],
            overwrite: true,
            signal: ac.signal,
            llmOverride: { endpoint: activeServer.url },
        });
        expect(cancelled.ok).toBe(false);
        expect(cancelled.results[0].reason).toContain('cancelled');
    });

    it('detects concurrent edits to target cases/check/contract and dependency code (#14)', async () => {
        // Part A: concurrent edit to target cases (code unchanged) aborts write-back
        await writeProject(
            tmpDir,
            { provider: 'llama.cpp', model: 'qwen' },
            {
                helper: makeStubNode('helper', 'def helper(x: int) -> int', 'Double input', undefined, {
                    code: ['def helper(x: int) -> int:', '    return x * 2'],
                }),
                target_cases: makeStubNode(
                    'target_cases',
                    'def target_cases(x: int) -> int',
                    'Call helper',
                    [{ name: 'c1', inputs: { x: 2 }, expected: 4 }],
                    { context: ['helper'] },
                ),
            },
        );

        activeServer = await startCustomSseServer(async () => {
            const p = path.join(tmpDir, 'slate', 'nodes', 'target_cases.json');
            const edited = parseNode(await fs.readFile(p, 'utf8'));
            edited.cases = [{ name: 'c_new', inputs: { x: 5 }, expected: 10 }];
            await fs.writeFile(p, serializeNode(edited), 'utf8');
            return '### Implementation\n```python\ndef target_cases(x: int) -> int:\n    return helper(x)\n```';
        });

        const casesRace = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            nodeIds: ['target_cases'],
            verify: false,
            llmOverride: { endpoint: activeServer.url },
        });
        expect(casesRace.ok).toBe(false);
        expect(casesRace.failedCount).toBe(1);
        expect(casesRace.results[0].written).toBe(false);
        expect(casesRace.results[0].reason).toContain('changed on disk');
        const casesDisk = parseNode(await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'target_cases.json'), 'utf8'));
        expect(casesDisk.cases).toEqual([{ name: 'c_new', inputs: { x: 5 }, expected: 10 }]);
        expect(casesDisk.code[1]).toBe('    raise NotImplementedError');

        await activeServer.close();

        // Part B: concurrent edit to dependency node code aborts target write-back
        await writeProject(
            tmpDir,
            { provider: 'llama.cpp', model: 'qwen' },
            {
                helper: makeStubNode('helper', 'def helper(x: int) -> int', 'Double input', undefined, {
                    code: ['def helper(x: int) -> int:', '    return x * 2'],
                }),
                target_dep: makeStubNode(
                    'target_dep',
                    'def target_dep(x: int) -> int',
                    'Call helper',
                    [{ name: 'c1', inputs: { x: 2 }, expected: 4 }],
                    { context: ['helper'] },
                ),
            },
        );

        activeServer = await startCustomSseServer(async () => {
            const depPath = path.join(tmpDir, 'slate', 'nodes', 'helper.json');
            const depEdited = parseNode(await fs.readFile(depPath, 'utf8'));
            depEdited.code = ['def helper(x: int) -> int:', '    return x * 10'];
            await fs.writeFile(depPath, serializeNode(depEdited), 'utf8');
            return '### Implementation\n```python\ndef target_dep(x: int) -> int:\n    return helper(x)\n```';
        });

        const depRace = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            nodeIds: ['target_dep'],
            verify: false,
            llmOverride: { endpoint: activeServer.url },
        });
        expect(depRace.ok).toBe(false);
        expect(depRace.failedCount).toBe(1);
        expect(depRace.results[0].written).toBe(false);
        expect(depRace.results[0].reason).toContain('changed on disk');
        const depTargetDisk = parseNode(await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'target_dep.json'), 'utf8'));
        expect(depTargetDisk.code[1]).toBe('    raise NotImplementedError');
    });

    it('partitions DAG targets into topological waves and breaks cycles cleanly', () => {
        const mk = (nodeId: string, context: string[] = [], uses: string[] = []) => ({
            target: {
                nodeId,
                node: makeStubNode(nodeId.split('/').pop()!, `def ${nodeId.split('/').pop()!}(x: int) -> int`, 'op', undefined, {
                    context,
                    uses,
                }),
            },
        });
        const waves = partitionTargetsIntoWaves([
            mk('c', ['b']),
            mk('a'),
            mk('b', ['a']),
            mk('d', ['b'], ['a']),
        ]);
        expect(waves.map(w => w.map(i => i.target.nodeId))).toEqual([
            ['a'],
            ['b'],
            ['c', 'd'],
        ]);

        const cyclic = partitionTargetsIntoWaves([mk('x', ['y']), mk('y', ['x']), mk('leaf')]);
        expect(cyclic.map(w => w.map(i => i.target.nodeId))).toEqual([
            ['leaf'],
            ['x', 'y'],
        ]);

        // Transitive dependency through an already-implemented non-target helper:
        // stub_a -> impl_b -> stub_c  ==>  Wave 0: [stub_c], Wave 1: [stub_a]
        const implB = makeStubNode('impl_b', 'def impl_b(x: int) -> int', 'Uses c', undefined, {
            context: ['stub_c'],
            code: ['def impl_b(x: int) -> int:', '    return stub_c(x) * 2'],
        });
        const allNodes = new Map<string, SlateNode>([
            ['impl_b', implB],
            ['stub_a', makeStubNode('stub_a', 'def stub_a(x: int) -> int', 'Uses impl_b', undefined, { context: ['impl_b'] })],
            ['stub_c', makeStubNode('stub_c', 'def stub_c(x: int) -> int', 'Leaf stub')],
        ]);
        const transitiveWaves = partitionTargetsIntoWaves([
            mk('stub_a', ['impl_b']),
            mk('stub_c'),
        ], allNodes);
        expect(transitiveWaves.map(w => w.map(i => i.target.nodeId))).toEqual([
            ['stub_c'],
            ['stub_a'],
        ]);
    });

    it('orders stubs reached transitively through implemented helpers into separate waves', async () => {
        await writeProject(
            tmpDir,
            { provider: 'llama.cpp', model: 'qwen/qwen3-coder-30b-a3b-instruct' },
            {
                stub_c: makeStubNode(
                    'stub_c',
                    'def stub_c(x: int) -> int',
                    'Add 1',
                    [{ name: 'c1', input: { x: 2 }, expected: 3 }],
                ),
                impl_b: makeStubNode(
                    'impl_b',
                    'def impl_b(x: int) -> int',
                    'Double stub_c(x)',
                    undefined,
                    {
                        context: ['stub_c'],
                        code: ['def impl_b(x: int) -> int:', '    return stub_c(x) * 2'],
                    },
                ),
                stub_a: makeStubNode(
                    'stub_a',
                    'def stub_a(x: int) -> int',
                    'Return impl_b(x) + 10',
                    [{ name: 'a1', input: { x: 2 }, expected: 16 }],
                    { context: ['impl_b'] },
                ),
            },
        );

        const order: string[] = [];
        activeServer = await startCustomSseServer(body => {
            const prompt = String(body.messages?.[1]?.content ?? '');
            if (prompt.includes('### Target stub: stub_c')) {
                order.push('stub_c');
                return '### Implementation\n```python\ndef stub_c(x: int) -> int:\n    return x + 1\n```\n### Unit Check\n```python\ndef test_stub_c():\n    assert stub_c(2) == 3\n```';
            }
            order.push('stub_a');
            return '### Implementation\n```python\ndef stub_a(x: int) -> int:\n    return impl_b(x) + 10\n```\n### Unit Check\n```python\ndef test_stub_a():\n    assert stub_a(2) == 16\n```';
        });

        const res = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            concurrency: 2,
            llmOverride: { endpoint: activeServer.url },
        });
        expect(res.ok, JSON.stringify(res.results)).toBe(true);
        expect(res.waves).toBe(2);
        expect(res.forgedCount).toBe(2);
        expect(order).toEqual(['stub_c', 'stub_a']);
    }, 20_000);

    it('forges multi-wave dependencies in one batch (both write and dry-run) and hoists leading imports', async () => {
        await writeProject(
            tmpDir,
            { provider: 'llama.cpp', model: 'qwen/qwen3-coder-30b-a3b-instruct' },
            {
                'scientific/power': makeStubNode(
                    'power',
                    'def power(base: float, exponent: float) -> float',
                    'Raise base to exponent',
                    [{ name: 'p', input: { base: 3, exponent: 2 }, expected: 9 }],
                ),
                'scientific/square_root': makeStubNode(
                    'square_root',
                    'def square_root(x: float) -> float',
                    'Compute sqrt(x)',
                    [{ name: 's', input: { x: 25 }, expected: 5 }],
                ),
                'scientific/hypotenuse': makeStubNode(
                    'hypotenuse',
                    'def hypotenuse(a: float, b: float) -> float',
                    'Call square_root(power(a, 2.0) + power(b, 2.0))',
                    [{ name: 'h', input: { a: 3, b: 4 }, expected: 5 }],
                    { context: ['scientific/power', 'scientific/square_root'] },
                ),
            },
        );

        const callOrder: string[] = [];
        activeServer = await startCustomSseServer(body => {
            const prompt = String(body.messages?.[1]?.content ?? '');
            if (prompt.includes('### Target stub: power')) {
                callOrder.push('power');
                return [
                    '### Implementation',
                    '```python',
                    'def power(base: float, exponent: float) -> float:',
                    '    return float(base ** exponent)',
                    '```',
                    '### Unit Check',
                    '```python',
                    'def test_power():',
                    '    assert power(2.0, 3.0) == 8.0',
                    '```',
                ].join('\n');
            }
            if (prompt.includes('### Target stub: square_root')) {
                callOrder.push('square_root');
                return [
                    '### Implementation',
                    '```python',
                    'import math',
                    '',
                    'def square_root(x: float) -> float:',
                    '    return math.sqrt(x)',
                    '```',
                    '### Unit Check',
                    '```python',
                    'def test_square_root():',
                    '    assert square_root(9.0) == 3.0',
                    '```',
                ].join('\n');
            }
            callOrder.push('hypotenuse');
            expect(prompt).not.toContain('slate/nodes/');
            return [
                '### Implementation',
                '```python',
                'def hypotenuse(a: float, b: float) -> float:',
                '    return square_root(power(a, 2.0) + power(b, 2.0))',
                '```',
                '### Unit Check',
                '```python',
                'def test_hypotenuse():',
                '    assert hypotenuse(3.0, 4.0) == 5.0',
                '```',
            ].join('\n');
        });

        // Dry-run wave propagation (write: false)
        const dryRes = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            concurrency: 3,
            write: false,
            llmOverride: { endpoint: activeServer.url },
        });
        expect(dryRes.ok, JSON.stringify(dryRes.results)).toBe(true);
        expect(dryRes.waves).toBe(2);
        expect(dryRes.forgedCount).toBe(3);
        expect(callOrder.indexOf('hypotenuse')).toBeGreaterThan(callOrder.indexOf('power'));
        expect(callOrder.indexOf('hypotenuse')).toBeGreaterThan(callOrder.indexOf('square_root'));

        // Persisted single-batch multi-wave forge (write: true)
        const writeRes = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            concurrency: 3,
            write: true,
            llmOverride: { endpoint: activeServer.url },
        });
        expect(writeRes.ok).toBe(true);
        expect(writeRes.waves).toBe(2);
        expect(writeRes.forgedCount).toBe(3);

        const sqrtDisk = parseNode(await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'scientific', 'square_root.json'), 'utf8'));
        expect(sqrtDisk.imports).toContain('import math');
        expect(sqrtDisk.code[0]).toBe('def square_root(x: float) -> float:');
    }, 30_000);

    it('skips downstream Wave 2 dependents cleanly when an upstream Wave 1 dependency fails', async () => {
        await writeProject(
            tmpDir,
            { provider: 'llama.cpp', model: 'qwen/qwen3-coder-30b-a3b-instruct' },
            {
                leaf: makeStubNode(
                    'leaf',
                    'def leaf(x: int) -> int',
                    'Return x + 1',
                    [{ name: 'c', input: { x: 1 }, expected: 2 }],
                ),
                downstream: makeStubNode(
                    'downstream',
                    'def downstream(x: int) -> int',
                    'Call leaf(x)',
                    [{ name: 'c', input: { x: 1 }, expected: 2 }],
                    { context: ['leaf'] },
                ),
            },
        );

        let downstreamCalled = false;
        activeServer = await startCustomSseServer(body => {
            const prompt = String(body.messages?.[1]?.content ?? '');
            if (prompt.includes('def downstream(')) {
                downstreamCalled = true;
            }
            return 'not valid python at all';
        });

        const res = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            maxRevisions: 1,
            verify: false,
            llmOverride: { endpoint: activeServer.url },
        });
        expect(res.ok).toBe(false);
        expect(res.waves).toBe(2);
        expect(res.failedCount).toBe(1);
        expect(res.skippedCount).toBe(1);
        expect(downstreamCalled).toBe(false);
        const downResult = res.results.find(r => r.nodeId === 'downstream')!;
        expect(downResult.status).toBe('skipped');
        expect(downResult.reason).toContain('leaf');
    }, 15_000);

    it('compacts verbose verification tracebacks and forged payloads for Frontier replies', () => {
        const longTrace = [
            '\u001b[31m============================= FAILURES =============================\u001b[0m',
            'FAILED C:\\proj\\.slate\\build\\verify\\scientific\\sin_deg\\test_sin_deg.py::test_structured',
            'E       AssertionError: assert 0.49999999999999994 == 0.5',
            'noise line '.repeat(40),
        ].join('\n');
        const compacted = compactFailureReason(longTrace, 180);
        expect(compacted.length).toBeLessThanOrEqual(180);
        expect(compacted).not.toContain('\u001b');
        expect(compacted).not.toContain('============================= FAILURES');
        expect(compacted).toContain('<verify>');
        expect(compacted).toContain('AssertionError');

        const fullResult: BatchForgeResult = {
            ok: false,
            provider: 'openrouter',
            endpoint: 'https://openrouter.ai/api/v1',
            model: 'qwen/qwen3-coder-30b-a3b-instruct',
            hasApiKey: true,
            concurrency: 3,
            waves: 2,
            total: 2,
            forgedCount: 1,
            failedCount: 1,
            skippedCount: 0,
            totalAttempts: 4,
            totalDurationMs: 1200,
            results: [
                {
                    nodeId: 'ok_node',
                    status: 'forged',
                    attempts: 1,
                    lineCount: 2,
                    written: true,
                    durationMs: 100,
                    verification: {
                        nodeId: 'ok_node',
                        state: 'passed',
                        timestamp: 1,
                        sourceHash: 'sha256:abc',
                        testsPassed: 2,
                        testsTotal: 2,
                        diagnostics: ['Pytest passed; mutmut skipped'],
                        traceback: 'should be stripped',
                    },
                    proposedCode: 'should be omitted when written',
                },
                {
                    nodeId: 'bad_node',
                    status: 'failed',
                    attempts: 3,
                    written: false,
                    durationMs: 1100,
                    reason: longTrace,
                    verification: {
                        nodeId: 'bad_node',
                        state: 'failed',
                        timestamp: 1,
                        sourceHash: 'sha256:def',
                        testsPassed: 0,
                        testsTotal: 1,
                        traceback: longTrace,
                    },
                },
            ],
        };
        const compact = compactBatchForgeResult(fullResult);
        const rows = compact.results as Array<Record<string, unknown>>;
        expect(rows[0].proposedCode).toBeUndefined();
        expect((rows[0].verification as Record<string, unknown>).traceback).toBeUndefined();
        expect((rows[1].verification as Record<string, unknown>).traceback).toBeUndefined();
        expect(String(rows[1].reason)).toContain('AssertionError');
    });

    it('surfaces finish_reason=length truncation in retry feedback and failure reason (#55)', async () => {
        const truncatedReply = [
            '### Implementation',
            '```python',
            'def square(x: int) -> int:',
            '    return x * x',
            '```',
            '### Unit Check',
            '```python',
            'def test_square():',
            '    assert square(3) == ',
        ].join('\n');
        const validReply = [
            '### Implementation',
            '```python',
            'def square(x: int) -> int:',
            '    return x * x',
            '```',
            '### Unit Check',
            '```python',
            'def test_square():',
            '    assert square(3) == 9',
            '```',
        ].join('\n');

        let calls = 0;
        const server = await startFakeLlamaServer(
            () => {
                calls += 1;
                return [calls === 1 ? truncatedReply : validReply];
            },
            {
                finishReason: (_req, index) => (index === 0 ? 'length' : 'stop'),
            },
        );
        activeServer = server;

        await writeProject(tmpDir, {
            provider: 'openai-compatible',
            endpoint: server.url,
            model: 'tiny-local',
        }, {
            square: makeStubNode('square', 'def square(x: int) -> int', 'Return x squared', [
                { name: 'three', input: { x: 3 }, expected: 9 },
            ]),
        });

        const recovered = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            allStubs: true,
            verify: false,
            write: true,
            maxRevisions: 2,
        });
        expect(recovered.ok).toBe(true);
        expect(server.requests[0].max_tokens).toBe(1536);
        expect(recovered.results[0]).toMatchObject({ nodeId: 'square', status: 'forged', attempts: 2 });
        const retryMessages = server.requests[1].messages as Array<{ role: string; content: string }>;
        expect(retryMessages.find(m => m.role === 'user')?.content).toContain('truncated at max_tokens=1536');

        // Verify maxRevisions: 1 preserves the explicit truncation prefix in node result reason
        const failDir = path.join(tmpDir, 'fail_proj');
        const failServer = await startFakeLlamaServer([truncatedReply], { finishReason: 'length' });
        try {
            await writeProject(failDir, {
                provider: 'openai-compatible',
                endpoint: failServer.url,
                model: 'tiny-local',
            }, {
                square: makeStubNode('square', 'def square(x: int) -> int', 'Return x squared'),
            });
            const failed = await batchForgeWorkspace({
                workspaceRoot: failDir,
                isTrusted: true,
                allStubs: true,
                verify: false,
                write: false,
                maxRevisions: 1,
            });
            expect(failed.ok).toBe(false);
            expect(failed.results[0].status).toBe('failed');
            expect(failed.results[0].reason).toContain('Output truncated at max_tokens=1536 (finish_reason=length):');
        } finally {
            await failServer.close();
        }
    }, 15_000);

    it('rejects valid-looking replies without unit check when finish_reason=length and accepts on clean retry (#55 PR #56)', async () => {
        const implOnlyTruncated = [
            '### Implementation',
            '```python',
            'def square(x: int) -> int:',
            '    return x * x',
            '```',
        ].join('\n');
        const completeReply = [
            '### Implementation',
            '```python',
            'def square(x: int) -> int:',
            '    return x * x',
            '```',
            '### Unit Check',
            '```python',
            'def test_square():',
            '    assert square(4) == 16',
            '```',
        ].join('\n');

        const truncatedServer = await startFakeLlamaServer([implOnlyTruncated], { finishReason: 'length' });
        try {
            const failDir = path.join(tmpDir, 'truncated_valid_fail');
            await writeProject(failDir, {
                provider: 'openai-compatible',
                endpoint: truncatedServer.url,
                model: 'tiny-local',
            }, {
                square: makeStubNode('square', 'def square(x: int) -> int', 'Return x squared', [
                    { name: 'four', input: { x: 4 }, expected: 16 },
                ]),
            });
            const rejected = await batchForgeWorkspace({
                workspaceRoot: failDir,
                isTrusted: true,
                allStubs: true,
                verify: false,
                write: false,
                maxRevisions: 1,
            });
            expect(rejected.ok).toBe(false);
            expect(rejected.results[0].status).toBe('failed');
            expect(rejected.results[0].reason).toContain('Output truncated at max_tokens=1536 (finish_reason=length):');
        } finally {
            await truncatedServer.close();
        }

        let attempt = 0;
        const retryServer = await startFakeLlamaServer(
            () => {
                attempt += 1;
                return [attempt === 1 ? implOnlyTruncated : completeReply];
            },
            { finishReason: (_req, idx) => (idx === 0 ? 'length' : 'stop') },
        );
        activeServer = retryServer;
        await writeProject(tmpDir, {
            provider: 'openai-compatible',
            endpoint: retryServer.url,
            model: 'tiny-local',
        }, {
            square: makeStubNode('square', 'def square(x: int) -> int', 'Return x squared', [
                { name: 'four', input: { x: 4 }, expected: 16 },
            ]),
        });
        const forged = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            allStubs: true,
            verify: false,
            write: true,
            maxRevisions: 2,
        });
        expect(forged.ok).toBe(true);
        expect(forged.results[0]).toMatchObject({ nodeId: 'square', status: 'forged', attempts: 2 });
        const writtenNode = parseNode(await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'square.json'), 'utf8'));
        expect(writtenNode.check?.join('\n')).toContain('def test_square():');
    }, 15_000);

    it('fails closed when isTrusted is false or omitted before contacting project LLM endpoints or verifying (P0-5)', async () => {
        await writeProject(
            tmpDir,
            {
                provider: 'openai-compatible',
                endpoint: 'https://untrusted-project.example/v1',
                model: 'qwen',
            },
            {
                calc: makeStubNode('calc', 'def calc(x: int) -> int', 'Double x', [
                    { name: 'c1', input: { x: 2 }, expected: 4 },
                ]),
            },
        );

        await expect(batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: false,
            verify: false,
            write: false,
        })).rejects.toThrow(/Workspace is not trusted/);

        await expect(batchForgeWorkspace({
            workspaceRoot: tmpDir,
            verify: true,
            write: false,
            llmOverride: { endpoint: 'http://127.0.0.1:8080', model: 'local' },
        } as any)).rejects.toThrow(/Workspace is not trusted/);
    });

    it('supports concurrency up to 16 and recovers from transient HTTP 429 without polluting retryFeedback', async () => {
        const nodes: Record<string, SlateNode> = {};
        for (let i = 1; i <= 12; i++) {
            const name = `fn_${i}`;
            nodes[name] = makeStubNode(name, `def ${name}(x: int) -> int`, `Return x + ${i}`);
        }
        await writeProject(
            tmpDir,
            {
                provider: 'openai-compatible',
                model: 'qwen/qwen3-coder-next',
                concurrency: 12,
            },
            nodes,
        );

        let inFlight = 0;
        let maxInFlight = 0;
        const rateLimitedOnce = new Set<string>();
        const observedPrompts: string[] = [];

        const server: Server = createServer((req, res) => {
            if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
                res.writeHead(404).end();
                return;
            }
            let raw = '';
            req.setEncoding('utf8');
            req.on('data', chunk => { raw += chunk; });
            req.on('end', async () => {
                const parsed = JSON.parse(raw) as { messages?: Array<{ content?: string }> };
                const prompt = String(parsed.messages?.[1]?.content ?? '');
                observedPrompts.push(prompt);
                const match = prompt.match(/def (fn_\d+)\(/);
                const fnName = match?.[1] ?? 'fn_1';

                if (fnName === 'fn_1' && !rateLimitedOnce.has(fnName)) {
                    rateLimitedOnce.add(fnName);
                    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
                    res.end(JSON.stringify({ error: { message: 'Rate limited' } }));
                    return;
                }

                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise(resolve => setTimeout(resolve, 60));
                inFlight -= 1;

                const num = fnName.replace('fn_', '');
                const reply = `### Implementation\n\`\`\`python\ndef ${fnName}(x: int) -> int:\n    return x + ${num}\n\`\`\`\n\n### Unit Check\n\`\`\`python\ndef test_${fnName}():\n    assert ${fnName}(1) == ${1 + Number(num)}\n\`\`\``;
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
                res.end('data: [DONE]\n\n');
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
        const addr = server.address() as { port: number };
        activeServer = {
            url: `http://127.0.0.1:${addr.port}`,
            close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
        };

        const result = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            allStubs: true,
            concurrency: 20,
            verify: false,
            write: true,
            llmOverride: { endpoint: activeServer.url },
        });
        expect(result.ok).toBe(true);
        expect(result.concurrency).toBe(16);
        expect(result.forgedCount).toBe(12);
        expect(maxInFlight).toBeGreaterThanOrEqual(8);
        expect(observedPrompts.every(p => !p.includes('HTTP 429'))).toBe(true);
    });

    it('resolves slate.json pythonPath relative to workspaceRoot during batch forge verification', async () => {
        await writeProject(
            tmpDir,
            {
                provider: 'openai-compatible',
                model: 'tiny-local',
            },
            {
                inc: makeStubNode('inc', 'def inc(x: int) -> int', 'Increment x', [
                    { name: 'c1', input: { x: 2 }, expected: 3 },
                ]),
            },
        );
        const cfgPath = path.join(tmpDir, 'slate', 'slate.json');
        const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
        cfg.pythonPath = '.venv/bin/python';
        await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

        activeServer = await startCustomSseServer(
            () => '### Implementation\n```python\ndef inc(x: int) -> int:\n    return x + 1\n```\n\n### Unit Check\n```python\ndef test_inc():\n    assert inc(2) == 3\n```',
        );
        const observedCmds: string[] = [];
        const mockExec = vi.fn(async (cmd: string, args: string[]) => {
            observedCmds.push(cmd);
            if (args.includes('mutmut')) return { code: 1, stdout: '', stderr: 'not installed' };
            return { code: 0, stdout: '2 passed in 0.01s', stderr: '' };
        });

        const result = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            allStubs: true,
            llmOverride: { endpoint: activeServer.url },
            executeCommand: mockExec,
        });
        expect(result.ok).toBe(true);
        expect(observedCmds[0]).toBe(path.resolve(tmpDir, '.venv/bin/python'));
    });

    it('skips class frames and forges owned __init__ before dependent sibling methods across waves', async () => {
        const frame: SlateNode = {
            name: 'Counter',
            kind: 'class',
            intent: 'Bounded integer counter',
            contract: 'Maintains total count',
            context: [],
            examples: [],
            describedBy: 'human',
            locked: false,
            imports: [],
            uses: [],
            code: ['class Counter:', '    pass'],
            extra: {},
        };
        const initStub: SlateNode = {
            name: '__init__',
            classOwner: 'Counter',
            intent: 'Initialize Counter with start value',
            contract: 'Stores self.total = start',
            context: [],
            examples: [],
            describedBy: 'human',
            locked: false,
            imports: [],
            uses: [],
            cases: [{ name: 'init_ok', inputs: { start: 10 }, code: 'c = Counter(10)\nassert c.total == 10' }],
            code: ['def __init__(self, start: int) -> None:', '    raise NotImplementedError'],
            extra: {},
        };
        const stepStub: SlateNode = {
            name: 'increment',
            classOwner: 'Counter',
            intent: 'Increment self.total by delta and return it',
            contract: 'Updates and returns total',
            context: [],
            examples: [],
            describedBy: 'human',
            locked: false,
            imports: [],
            uses: [],
            cases: [{ name: 'step_ok', init: { start: 10 }, inputs: { delta: 5 }, expected: 15 }],
            code: ['def increment(self, delta: int) -> int:', '    raise NotImplementedError'],
            extra: {},
        };

        await fs.mkdir(path.join(tmpDir, 'slate', 'nodes', 'Counter'), { recursive: true });
        await fs.writeFile(
            path.join(tmpDir, 'slate', 'slate.json'),
            JSON.stringify({ slate: 3, name: 'counter_pkg', language: 'python', llm: { provider: 'openai-compatible', model: 'tiny' } }, null, 2),
            'utf8',
        );
        await fs.writeFile(path.join(tmpDir, 'slate', 'nodes', 'Counter.json'), serializeNode(frame), 'utf8');
        await fs.writeFile(path.join(tmpDir, 'slate', 'nodes', 'Counter', '__init__.json'), serializeNode(initStub), 'utf8');
        await fs.writeFile(path.join(tmpDir, 'slate', 'nodes', 'Counter', 'increment.json'), serializeNode(stepStub), 'utf8');

        const callOrder: string[] = [];
        activeServer = await startCustomSseServer(body => {
            const prompt = String(body.messages?.[1]?.content ?? '');
            if (prompt.includes('### Target stub: __init__')) {
                callOrder.push('__init__');
                return [
                    '### Implementation',
                    '```python',
                    'def __init__(self, start: int) -> None:',
                    '    self.total = start',
                    '```',
                    '### Unit Check',
                    '```python',
                    'def test___init__():',
                    '    assert Counter(4).total == 4',
                    '```',
                ].join('\n');
            }
            callOrder.push('increment');
            expect(prompt).toContain('Owning class frame: Counter');
            return [
                '### Implementation',
                '```python',
                'def increment(self, delta: int) -> int:',
                '    self.total += delta',
                '    return self.total',
                '```',
                '### Unit Check',
                '```python',
                'def test_increment():',
                '    c = Counter(2)',
                '    assert c.increment(3) == 5',
                '```',
            ].join('\n');
        });

        const res = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            allStubs: true,
            llmOverride: { endpoint: activeServer.url },
        });
        expect(res.ok, JSON.stringify(res.results)).toBe(true);
        expect(res.waves).toBe(2);
        expect(res.forgedCount).toBe(2);
        expect(callOrder).toEqual(['__init__', 'increment']);

        // Explicitly targeting class frame reports skipped cleanly
        const frameSkip = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
            isTrusted: true,
            nodeIds: ['Counter'],
            llmOverride: { endpoint: activeServer.url },
        });
        expect(frameSkip.skippedCount).toBe(1);
        expect(frameSkip.results[0].reason).toContain('Class frame node cannot be forged directly');
    }, 25_000);
});
