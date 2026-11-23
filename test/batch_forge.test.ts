import * as fs from 'fs/promises';
import { createServer, type Server } from 'node:http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { batchForgeWorkspace } from '../vscode-extension/src/batch_forge';
import { parseNode, serializeNode, type SlateNode } from '../vscode-extension/src/slate_folder';

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
            llmOverride: { endpoint: activeServer.url },
            env: { SLATE_TEST_KEY: 'fake-batch-token' },
            executeCommand: mockExec,
            onNodeForged: id => { forgedIds.push(id); },
        });

        expect(result.ok).toBe(true);
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
            llmOverride: { endpoint: activeServer.url },
            maxRevisions: 3,
        });

        expect(result.ok).toBe(true);
        expect(result.forgedCount).toBe(1);
        expect(result.results[0].attempts).toBe(3);
        expect(result.results[0].verification?.state).toBe('passed');
        expect(prompts[1]).toContain('Candidate validation failed');
        expect(prompts[2]).toContain('Bounded Retry Feedback');

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
            nodeIds: ['../../evil'],
            llmOverride: { endpoint: activeServer.url },
        })).rejects.toThrow(/Path traversal rejected/);

        const dryRun = await batchForgeWorkspace({
            workspaceRoot: tmpDir,
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
});
