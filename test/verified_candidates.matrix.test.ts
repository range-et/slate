import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkLlamaHealth } from '../vscode-extension/src/llama_transport';
import {
    parseForgeCandidate,
    validateForgeCandidate,
    buildForgePacket,
    buildGenerationPacket,
} from '../vscode-extension/src/generation';
import {
    checkJpl60,
    checkNodeCode,
    indexNode,
    nodeFromSignature,
    parseNode,
} from '../vscode-extension/src/slate_folder';
import type { HarnessSnapshot, ParsedUnit } from '../vscode-extension/src/harness_protocol';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('S-701 Verified Candidates, Revision Loop & Local LLM Health Matrix', () => {
    describe('checkLlamaHealth reachability and configuration', () => {
        it('reports healthy when /v1/models returns JSON model list', async () => {
            const fetchMock = vi.fn(async (url: string | URL | Request) => {
                const urlStr = String(url);
                if (urlStr.endsWith('/v1/models') || urlStr.endsWith('/models')) {
                    return new Response(JSON.stringify({
                        data: [{ id: 'qwen2.5-coder' }, { id: 'deepseek-coder' }],
                    }), { status: 200, headers: { 'content-type': 'application/json' } });
                }
                return new Response('Not found', { status: 404 });
            });
            vi.stubGlobal('fetch', fetchMock);

            const result = await checkLlamaHealth('http://127.0.0.1:8080', 'qwen2.5-coder', 1000);
            expect(result.ok).toBe(true);
            expect(result.endpoint).toBe('http://127.0.0.1:8080');
            expect(result.model).toBe('qwen2.5-coder');
            expect(result.statusText).toContain('Connected (2 model(s) available)');
            expect(result.models).toEqual(['qwen2.5-coder', 'deepseek-coder']);
        });

        it('falls back to /health endpoint when /v1/models returns 404', async () => {
            const fetchMock = vi.fn(async (url: string | URL | Request) => {
                const urlStr = String(url);
                if (urlStr.endsWith('/health')) {
                    return new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });
                }
                return new Response('Not found', { status: 404 });
            });
            vi.stubGlobal('fetch', fetchMock);

            const result = await checkLlamaHealth('http://127.0.0.1:11434', 'local', 1000);
            expect(result.ok).toBe(true);
            expect(result.endpoint).toBe('http://127.0.0.1:11434');
            expect(result.statusText).toContain('Connected');
        });

        it('reports unhealthy when endpoint returns HTTP 500 error', async () => {
            const fetchMock = vi.fn(async () => new Response('Internal error', { status: 500, statusText: 'Internal Server Error' }));
            vi.stubGlobal('fetch', fetchMock);

            const result = await checkLlamaHealth('http://127.0.0.1:8080', 'local', 1000);
            expect(result.ok).toBe(false);
            expect(result.statusText).toContain('HTTP 500');
        });

        it('reports unreachable when fetch connection is refused', async () => {
            const fetchMock = vi.fn(async () => { throw new Error('ECONNREFUSED 127.0.0.1:8080'); });
            vi.stubGlobal('fetch', fetchMock);

            const result = await checkLlamaHealth('http://127.0.0.1:8080', 'local', 1000);
            expect(result.ok).toBe(false);
            expect(result.statusText).toContain('ECONNREFUSED');
        });

        it('reports timed out when health check exceeds timeout', async () => {
            const fetchMock = vi.fn(async (_url, options?: RequestInit) => {
                return new Promise<Response>((_resolve, reject) => {
                    if (options?.signal?.aborted) {
                        reject(new Error('Connection timed out'));
                        return;
                    }
                    options?.signal?.addEventListener('abort', () => reject(new Error('Connection timed out')));
                });
            });
            vi.stubGlobal('fetch', fetchMock);

            const result = await checkLlamaHealth('http://127.0.0.1:8080', 'local', 20);
            expect(result.ok).toBe(false);
            expect(result.statusText).toContain('timed out');
        });
    });

    describe('candidate validation, editing and JPL-60 constraints', () => {
        const targetUnit: ParsedUnit = {
            id: 'clamp',
            name: 'clamp',
            qualifiedName: 'clamp',
            identity: 'durable',
            kind: 'function',
            parentId: null,
            ranges: {
                name: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } },
                declaration: { start: { line: 0, character: 0 }, end: { line: 2, character: 41 } },
            },
            annotation: null,
            decorators: [],
            params: [
                { name: 'val', annotation: 'int', default: null, kind: 'positional' },
                { name: 'low', annotation: 'int', default: null, kind: 'positional' },
                { name: 'high', annotation: 'int', default: null, kind: 'positional' },
            ],
            returnAnnotation: 'int',
            signature: 'def clamp(val: int, low: int, high: int) -> int',
        };

        it('validates a compliant candidate with implementation and unit check', () => {
            const raw = `\`\`\`python
def clamp(val: int, low: int, high: int) -> int:
    return max(low, min(val, high))
\`\`\`

\`\`\`python
def test_clamp() -> None:
    assert clamp(5, 0, 10) == 5
    assert clamp(-5, 0, 10) == 0
    assert clamp(15, 0, 10) == 10
\`\`\``;
            const parsed = parseForgeCandidate(raw);
            expect(parsed.implementation).toContain('def clamp');
            expect(parsed.check).toContain('def test_clamp');

            const val = validateForgeCandidate(targetUnit, parsed);
            expect(val.valid).toBe(true);
            expect(val.lineCount).toBeLessThanOrEqual(60);
        });

        it('rejects an edited candidate that alters the function name', () => {
            const parsed = {
                implementation: 'def renamed_clamp(val: int, low: int, high: int) -> int:\n    return val',
                check: 'def test_clamp(): assert True',
            };
            const val = validateForgeCandidate(targetUnit, parsed);
            expect(val.valid).toBe(false);
            expect(val.diagnostics.join('; ')).toContain('named "clamp"');
        });

        it('rejects an edited candidate that exceeds the 60-line JPL-60 limit', () => {
            const longBody = Array.from({ length: 65 }, (_, i) => `    x_${i} = ${i}`).join('\n');
            const candidate = `def clamp(val: int, low: int, high: int) -> int:\n${longBody}\n    return val`;
            const parsed = { implementation: candidate };

            const val = validateForgeCandidate(targetUnit, parsed);
            expect(val.valid).toBe(false);
            expect(val.diagnostics.join('; ')).toContain('exceeds JPL-60 limit');
        });

        it('rejects an edited candidate that removes typed parameter annotations', () => {
            const untyped = 'def clamp(val, low, high) -> int:\n    return val';
            const parsed = { implementation: untyped };

            const val = validateForgeCandidate(targetUnit, parsed);
            expect(val.valid).toBe(false);
            expect(val.diagnostics.join('; ')).toContain('does not match target');
        });

        it('rejects an edited candidate that removes the return type annotation', () => {
            const noReturn = 'def clamp(val: int, low: int, high: int):\n    return val';
            const parsed = { implementation: noReturn };

            const val = validateForgeCandidate(targetUnit, parsed);
            expect(val.valid).toBe(false);
            expect(val.diagnostics.join('; ')).toContain('does not match target');
        });
    });

    describe('typed stub generation from wire drop and add-node search', () => {
        it('creates a typed atomic stub from signature and intent', () => {
            const node = nodeFromSignature('def calculate_tax(amount: float, rate: float) -> float', 'Calculate total tax');
            expect(node.name).toBe('calculate_tax');
            expect(node.intent).toBe('Calculate total tax');
            expect(node.code).toEqual([
                'def calculate_tax(amount: float, rate: float) -> float:',
                '    raise NotImplementedError',
            ]);
            expect(node.locked).toBe(false);
        });

        it('infers typed input parameter when wire is dropped from an output port', () => {
            const droppedAnnotation = 'dict[str, Any]';
            const sig = `def parse_config(data: ${droppedAnnotation}) -> object`;
            const node = nodeFromSignature(sig, 'Parse configuration dictionary');
            expect(node.name).toBe('parse_config');
            expect(node.code[0]).toContain(`(data: ${droppedAnnotation}) -> object:`);
        });

        it('infers typed return annotation when wire is dropped into an input port', () => {
            const expectedAnnotation = 'list[int]';
            const sig = `def generate_ids() -> ${expectedAnnotation}`;
            const node = nodeFromSignature(sig, 'Generate sequential IDs');
            expect(node.name).toBe('generate_ids');
            expect(node.code[0]).toContain(`() -> ${expectedAnnotation}:`);
        });

        it('strictly refuses arbitrary statements in new atomic stubs', () => {
            expect(() => nodeFromSignature('def bad() -> int:\n    return 42', 'intent'))
                .toThrow(/enter one function signature/);
        });
    });

    describe('acceptance binding and fingerprint verification', () => {
        function makeFixture() {
            const clampNode = indexNode(
                'slate/nodes/clamp.json',
                JSON.stringify({
                    slate: 3,
                    name: 'clamp',
                    intent: 'Clamp value between lower and upper bounds',
                    contract: 'lower <= value <= upper',
                    context: ['helper'],
                    cases: [{ id: 'c1', inputs: { value: 5, lower: 0, upper: 10 }, expected: 5 }],
                    code: [
                        'def clamp(value: int, lower: int, upper: int) -> int:',
                        '    return max(lower, min(value, upper))',
                    ],
                }),
                'python',
                1,
            );

            const helperNode = indexNode(
                'slate/nodes/helper.json',
                JSON.stringify({
                    slate: 3,
                    name: 'helper',
                    intent: 'Helper utility',
                    contract: 'none',
                    code: [
                        'def helper(x: int) -> int:',
                        '    return x * 2',
                    ],
                }),
                'python',
                1,
            );

            const snapshot: HarnessSnapshot = {
                revision: 1,
                projectName: 'test',
                documents: [clampNode.document, helperNode.document],
                layout: {},
                flows: [{
                    id: 'main',
                    flow: {
                        name: 'main',
                        inputs: [],
                        outputs: [],
                        instances: [
                            { id: 'inst_clamp', node: 'clamp' },
                            { id: 'inst_helper', node: 'helper' },
                        ],
                        wires: [
                            { from: 'inst_helper.out', to: 'inst_clamp.in:value' },
                        ],
                        extra: {},
                    },
                }],
            };

            const sources = new Map<string, string>([
                ['slate/nodes/clamp.json', clampNode.code],
                ['slate/nodes/helper.json', helperNode.code],
            ]);

            return { snapshot, sources };
        }

        it('binds acceptance to target code, intent, contract, cases and neighbor signatures', () => {
            const { snapshot, sources } = makeFixture();
            const packet = buildForgePacket(snapshot, sources, 'clamp', 4096, 768, {
                forge: true,
                boundInputs: true,
            });

            expect(packet.boundInputs).toBe(true);
            expect(packet.fingerprint).toBeDefined();
            const fp = packet.fingerprint!;
            expect(fp.code).toEqual([
                'def clamp(value: int, lower: int, upper: int) -> int:',
                '    return max(lower, min(value, upper))',
            ]);
            expect(fp.intent).toBe('Clamp value between lower and upper bounds');
            expect(fp.contract).toBe('lower <= value <= upper');
            expect(fp.cases).toHaveLength(1);
            expect(fp.neighborSignatures['helper']).toBeDefined();
            expect(fp.neighborSignatures['helper'].signature).toContain('def helper(x: int) -> int');
        });

        it('includes retry feedback in micro-packet while maintaining JPL-60 budget (<=600 tokens)', () => {
            const { snapshot, sources } = makeFixture();
            const feedback = 'Handle boundary case when lower == upper without crashing.';
            const packet = buildForgePacket(snapshot, sources, 'clamp', {
                retryFeedback: feedback,
            });

            expect(packet.retryFeedback).toBe(feedback);
            expect(packet.prompt).toContain('Bounded Retry Feedback');
            expect(packet.prompt).toContain(feedback);
            expect(packet.estimatedInputTokens).toBeLessThanOrEqual(600);
        });
    });
});
