import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    formatCasesAsPython,
    formatCasesAsTs,
    generateVerificationFiles,
    isVerificationStale,
    runNodeVerification,
    runRevisionLoop,
} from '../vscode-extension/src/verification_runner';
import type { SlateNode } from '../vscode-extension/src/slate_folder';
import type { NodeVerificationResult } from '../vscode-extension/src/harness_protocol';

function makeNode(overrides?: Partial<SlateNode>): SlateNode {
    return {
        name: 'clamp',
        intent: 'Clamps value between lower and upper bounds',
        contract: 'lower <= upper; returns lower when value < lower, upper when value > upper',
        context: [],
        imports: [],
        uses: [],
        code: [
            'def clamp(value: int, lower: int, upper: int) -> int:',
            '    if value < lower:',
            '        return lower',
            '    if value > upper:',
            '        return upper',
            '    return value',
        ],
        cases: [
            { inputs: { value: 5, lower: 0, upper: 10 }, expected: 5 },
            { inputs: { value: -2, lower: 0, upper: 10 }, expected: 0 },
            { inputs: { value: 15, lower: 0, upper: 10 }, expected: 10 },
        ],
        check: [
            'def test_clamp():',
            '    assert clamp(5, 0, 10) == 5',
            '    assert clamp(-2, 0, 10) == 0',
            '    assert clamp(15, 0, 10) == 10',
        ],
        examples: [],
        locked: false,
        extra: {},
        ...overrides,
    };
}

describe('S-513 Verification Runner & Mutation Matrix', () => {
    describe('formatCasesAsPython', () => {
        it('formats structured object cases with inputs and expected', () => {
            const cases = [
                { inputs: { score: 50, maximum: 100 }, expected: 50 },
                { args: [120, 100], expected: 100 },
            ];
            const lines = formatCasesAsPython('normalize', cases);
            expect(lines[0]).toBe('def test_structured_cases_normalize():');
            expect(lines.some(l => l.includes('assert normalize(score=50, maximum=100) == 50'))).toBe(true);
            expect(lines.some(l => l.includes('assert normalize(120, 100) == 100'))).toBe(true);
        });

        it('formats plain string assertion cases', () => {
            const cases = ['assert clamp(0, 0, 10) == 0', 'clamp(10, 0, 5) == 5'];
            const lines = formatCasesAsPython('clamp', cases);
            expect(lines.some(l => l.includes('assert clamp(0, 0, 10) == 0'))).toBe(true);
            expect(lines.some(l => l.includes('assert clamp(10, 0, 5) == 5'))).toBe(true);
        });

        it('handles empty cases array gracefully with pass', () => {
            const lines = formatCasesAsPython('foo', []);
            expect(lines).toEqual(['def test_structured_cases_foo():', '    pass']);
        });

        it('formats MCP input cases, Python booleans/None literals, and expected errors', () => {
            const lines = formatCasesAsPython('check_item', [
                { name: 'mcp_case', input: { flag: true, empty: null }, expected: false },
                { name: 'raises_case', input: { flag: false, empty: null }, error: 'ValueError' },
            ]);
            expect(lines).toContain('    assert check_item(flag=True, empty=None) == False');
            expect(lines).toContain('    with pytest.raises(ValueError):');
            expect(lines).toContain('        check_item(flag=False, empty=None)');
        });
    });

    describe('generateVerificationFiles', () => {
        it('generates pydantic validation wrapper and pytest check when checks and cases are present', () => {
            const node = makeNode();
            const { moduleContent, testContent, hasChecks } = generateVerificationFiles(node);
            expect(hasChecks).toBe(true);
            expect(moduleContent).toContain('from pydantic import validate_call');
            expect(moduleContent).toContain('clamp = validate_call(validate_return=True)(clamp)');
            expect(moduleContent).toContain('def clamp(value: int, lower: int, upper: int) -> int:');

            expect(testContent).toContain('import pytest');
            expect(testContent).toContain('from clamp_impl import clamp');
            expect(testContent).toContain('def test_clamp():');
            expect(testContent).toContain('def test_structured_cases_clamp():');
        });

        it('returns hasChecks: false when node has neither check nor cases', () => {
            const node = makeNode({ check: undefined, cases: undefined });
            const { hasChecks, moduleContent, testContent } = generateVerificationFiles(node);
            expect(hasChecks).toBe(false);
            expect(moduleContent).toBe('');
            expect(testContent).toBe('');
        });

        it('includes dependency node code in module when context dependencies are provided', () => {
            const depNode = makeNode({
                name: 'helper_func',
                code: ['def helper_func(x: int) -> int:', '    return x * 2'],
            });
            const deps = new Map([['helper_func', depNode]]);
            const node = makeNode();
            const { moduleContent } = generateVerificationFiles(node, deps);
            expect(moduleContent).toContain('def helper_func(x: int) -> int:');
        });
    });

    describe('runNodeVerification execution', () => {
        it('refuses execution when workspace is not trusted', async () => {
            const node = makeNode();
            const res = await runNodeVerification({
                workspaceRoot: '/test/workspace',
                node,
                nodeId: 'clamp',
                isTrusted: false,
            });
            expect(res.state).toBe('failed');
            expect(res.diagnostics?.[0]).toContain('Workspace is not trusted');
        });

        it('marks node as untested when it lacks both check and cases', async () => {
            const node = makeNode({ check: [], cases: [] });
            const res = await runNodeVerification({
                workspaceRoot: '/test/workspace',
                node,
                nodeId: 'clamp',
                isTrusted: true,
            });
            expect(res.state).toBe('untested');
            expect(res.diagnostics?.[0]).toContain('Node has no check or cases');
        });

        it('handles pytest execution timeout gracefully', async () => {
            const node = makeNode();
            const mockExec = vi.fn().mockResolvedValue({
                code: -1,
                stdout: '',
                stderr: '',
                timedOut: true,
            });

            const res = await runNodeVerification({
                workspaceRoot: './tmp/test_verify',
                node,
                nodeId: 'clamp',
                isTrusted: true,
                timeoutMs: 5000,
                executeCommand: mockExec,
            });

            expect(res.state).toBe('failed');
            expect(res.diagnostics?.[0]).toContain('Verification timed out');
        });

        it('detects pytest failure and extracts failure traceback', async () => {
            const node = makeNode();
            const mockExec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
                if (args.includes('pytest')) {
                    return Promise.resolve({
                        code: 1,
                        stdout: '=== FAILURES ===\n__ test_clamp __\nassert clamp(-2, 0, 10) == 0\nFAILED test_clamp.py::test_clamp\n=== 1 failed, 2 passed in 0.12s ===',
                        stderr: '',
                        timedOut: false,
                    });
                }
                return Promise.resolve({ code: 0, stdout: '', stderr: '' });
            });

            const res = await runNodeVerification({
                workspaceRoot: './tmp/test_verify',
                node,
                nodeId: 'clamp',
                isTrusted: true,
                executeCommand: mockExec,
            });

            expect(res.state).toBe('failed');
            expect(res.testsPassed).toBe(2);
            expect(res.testsTotal).toBe(3);
            expect(res.traceback).toContain('assert clamp(-2, 0, 10) == 0');
            expect(res.diagnostics?.[0]).toContain('Pytest check failed');
        });

        it('detects pydantic ValidationError failure', async () => {
            const node = makeNode();
            const mockExec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
                if (args.includes('pytest')) {
                    return Promise.resolve({
                        code: 1,
                        stdout: 'pydantic_core._pydantic_core.ValidationError: 1 validation error for clamp\nvalue\n  Input should be a valid integer [type=int_type, input_value="bad", input_type=str]',
                        stderr: '',
                        timedOut: false,
                    });
                }
                return Promise.resolve({ code: 0, stdout: '', stderr: '' });
            });

            const res = await runNodeVerification({
                workspaceRoot: './tmp/test_verify',
                node,
                nodeId: 'clamp',
                isTrusted: true,
                executeCommand: mockExec,
            });

            expect(res.state).toBe('failed');
            expect(res.pydanticValid).toBe(false);
            expect(res.diagnostics?.[0]).toContain('Pydantic contract/type validation failed');
        });

        it('passes and runs mutmut; reports passed when 0 mutants survive', async () => {
            const node = makeNode();
            const mockExec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
                if (args.includes('pytest')) {
                    return Promise.resolve({
                        code: 0,
                        stdout: '=== 3 passed in 0.05s ===',
                        stderr: '',
                        timedOut: false,
                    });
                }
                if (args.includes('--version') && args.includes('mutmut')) {
                    return Promise.resolve({ code: 0, stdout: 'mutmut 2.4.4', stderr: '' });
                }
                if (args.includes('run') && args.includes('mutmut')) {
                    return Promise.resolve({
                        code: 0,
                        stdout: 'Legend for output:\n🎉 4 killed and 0 survived mutants',
                        stderr: '',
                    });
                }
                return Promise.resolve({ code: 0, stdout: '', stderr: '' });
            });

            const res = await runNodeVerification({
                workspaceRoot: './tmp/test_verify',
                node,
                nodeId: 'clamp',
                isTrusted: true,
                executeCommand: mockExec,
            });

            expect(res.state).toBe('passed');
            expect(res.testsPassed).toBe(3);
            expect(res.survivingMutants).toBe(0);
            expect(res.totalMutants).toBe(4);
        });

        it('detects surviving mutants from mutmut and surfaces mutant_survived with diff', async () => {
            const node = makeNode();
            const mockExec = vi.fn().mockImplementation((cmd: string, args: string[]) => {
                if (args.includes('pytest')) {
                    return Promise.resolve({
                        code: 0,
                        stdout: '=== 3 passed in 0.05s ===',
                        stderr: '',
                        timedOut: false,
                    });
                }
                if (args.includes('--version') && args.includes('mutmut')) {
                    return Promise.resolve({ code: 0, stdout: 'mutmut 2.4.4', stderr: '' });
                }
                if (args.includes('run') && args.includes('mutmut')) {
                    return Promise.resolve({
                        code: 0,
                        stdout: 'Legend for output:\n⏰ 0 timeout, 1 survived, 3 killed',
                        stderr: '',
                    });
                }
                if (args.includes('show')) {
                    return Promise.resolve({
                        code: 0,
                        stdout: '- if value < lower:\n+ if value <= lower:',
                        stderr: '',
                    });
                }
                return Promise.resolve({ code: 0, stdout: '', stderr: '' });
            });

            const res = await runNodeVerification({
                workspaceRoot: './tmp/test_verify',
                node,
                nodeId: 'clamp',
                isTrusted: true,
                executeCommand: mockExec,
            });

            expect(res.state).toBe('mutant_survived');
            expect(res.survivingMutants).toBe(1);
            expect(res.totalMutants).toBe(4);
            expect(res.mutantDiff).toContain('+ if value <= lower:');
            expect(res.diagnostics?.[0]).toContain('surviving mutant(s) detected');
        });
    });

    describe('isVerificationStale', () => {
        it('detects staleness when node code changes after verification', () => {
            const node = makeNode();
            const result: NodeVerificationResult = {
                nodeId: 'clamp',
                state: 'passed',
                timestamp: Date.now(),
                sourceHash: 'sha256:oldhash',
            };

            expect(isVerificationStale(result, node)).toBe(true);

            // With matching hash
            const currentHashResult: NodeVerificationResult = {
                ...result,
                sourceHash: 'sha256:b5161f5b08ec8bb67c3bd2944fa70c55f30cb7dfc4f0bdcd62e78702c2e9b8aa',
            };
            expect(isVerificationStale(undefined, node)).toBe(false);
        });
    });

    describe('runRevisionLoop (bounded retry up to 3 revisions)', () => {
        it('returns success on attempt 0 if node is already passing', async () => {
            const node = makeNode();
            const passResult: NodeVerificationResult = {
                nodeId: 'clamp',
                state: 'passed',
                timestamp: Date.now(),
                sourceHash: 'sha256:test',
            };

            const forgeMock = vi.fn();
            const loop = await runRevisionLoop({
                nodeId: 'clamp',
                node,
                maxRevisions: 3,
                forgeCandidate: forgeMock,
                verifyCandidate: vi.fn().mockResolvedValue(passResult),
            });

            expect(loop.success).toBe(true);
            expect(loop.attempts.length).toBe(1);
            expect(forgeMock).not.toHaveBeenCalled();
        });

        it('feeds failure feedback to forge and stops when revision passes', async () => {
            const node = makeNode();
            const failResult: NodeVerificationResult = {
                nodeId: 'clamp',
                state: 'failed',
                timestamp: Date.now(),
                sourceHash: 'sha256:test',
                traceback: 'AssertionError: assert clamp(-2, 0, 10) == 0',
            };

            const passResult: NodeVerificationResult = {
                nodeId: 'clamp',
                state: 'passed',
                timestamp: Date.now(),
                sourceHash: 'sha256:newhash',
            };

            let call = 0;
            const forgeMock = vi.fn().mockImplementation((feedback: string) => {
                expect(feedback).toContain('AssertionError');
                return Promise.resolve({
                    implementation: 'def clamp(value: int, lower: int, upper: int) -> int:\n    return min(max(value, lower), upper)',
                    check: 'def test_clamp():\n    assert clamp(-2, 0, 10) == 0',
                });
            });

            const verifyMock = vi.fn().mockImplementation(() => {
                call++;
                if (call === 1) return Promise.resolve(failResult);
                return Promise.resolve(passResult);
            });

            const loop = await runRevisionLoop({
                nodeId: 'clamp',
                node,
                maxRevisions: 3,
                forgeCandidate: forgeMock,
                verifyCandidate: verifyMock,
            });

            expect(loop.success).toBe(true);
            expect(loop.attempts.length).toBe(2);
            expect(loop.finalResult.state).toBe('passed');
            expect(loop.finalResult.retryCount).toBe(1);
        });

        it('respects maxRevisions boundary and stops after 3 failed attempts', async () => {
            const node = makeNode();
            const failResult: NodeVerificationResult = {
                nodeId: 'clamp',
                state: 'failed',
                timestamp: Date.now(),
                sourceHash: 'sha256:test',
                traceback: 'Persistent failure',
            };

            const forgeMock = vi.fn().mockResolvedValue({
                implementation: 'def clamp(...): pass',
            });

            const loop = await runRevisionLoop({
                nodeId: 'clamp',
                node,
                maxRevisions: 3,
                forgeCandidate: forgeMock,
                verifyCandidate: vi.fn().mockResolvedValue(failResult),
            });

            expect(loop.success).toBe(false);
            expect(forgeMock).toHaveBeenCalledTimes(3);
            expect(loop.attempts.length).toBe(4); // attempt 0 + 3 revisions
            expect(loop.finalResult.state).toBe('failed');
            expect(loop.finalResult.retryCount).toBe(3);
        });
    });

    describe('TypeScript and JavaScript verification runner', () => {
        const tempDirs: string[] = [];
        afterEach(() => {
            while (tempDirs.length > 0) {
                fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
            }
        });

        function makeTempWorkspace(): string {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-ts-verify-'));
            tempDirs.push(dir);
            return dir;
        }

        it('runs strict tsc check and executes real Node unit check and structured cases', async () => {
            const workspaceRoot = makeTempWorkspace();
            const helperNode: SlateNode = {
                name: 'doubleIt',
                language: 'typescript',
                intent: 'Double input',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                code: ['function doubleIt(x: number): number {', '    return x * 2;', '}'],
                extra: {},
            };
            const targetNode: SlateNode = {
                name: 'quadruple',
                language: 'typescript',
                intent: 'Quadruple integer',
                contract: 'Returns 4 * x',
                context: ['doubleIt'],
                imports: [],
                uses: [],
                code: ['export function quadruple(x: number): number {', '    return doubleIt(doubleIt(x));', '}'],
                cases: [{ name: 'basic', inputs: { x: 3 }, expected: 12 }],
                check: [
                    "import { expect, test } from 'vitest';",
                    "import { quadruple } from './quadruple';",
                    "test('quadruple zero and negative', () => {",
                    '    expect(quadruple(0)).toBe(0);',
                    '    expect(quadruple(-2)).toBe(-8);',
                    '});',
                ],
                extra: {},
            };

            const deps = new Map<string, SlateNode>([['doubleIt', helperNode]]);
            const res = await runNodeVerification({
                workspaceRoot,
                node: targetNode,
                nodeId: 'quadruple',
                dependencies: deps,
                isTrusted: true,
                language: 'typescript',
            });

            expect(res.state).toBe('passed');
            expect(res.pydanticValid).toBe(true);
            expect(res.testsPassed).toBe(2);
            expect(res.testsTotal).toBe(2);
        }, 20_000);

        it('fails with strict tsc diagnostics when TS types are invalid', async () => {
            const workspaceRoot = makeTempWorkspace();
            const badTypeNode: SlateNode = {
                name: 'badReturn',
                language: 'typescript',
                intent: 'Bad return type',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                code: ['export function badReturn(x: number): number {', '    return String(x);', '}'],
                check: ["test('bad', () => { expect(badReturn(1)).toBe(1); });"],
                extra: {},
            };

            const res = await runNodeVerification({
                workspaceRoot,
                node: badTypeNode,
                nodeId: 'badReturn',
                isTrusted: true,
                language: 'typescript',
            });

            expect(res.state).toBe('failed');
            expect(res.pydanticValid).toBe(false);
            expect(res.traceback).toContain('TS2322');
        }, 20_000);

        it('fails runtime assertion and returns traceback + formatted cases support', async () => {
            const workspaceRoot = makeTempWorkspace();
            const buggyNode: SlateNode = {
                name: 'buggySum',
                language: 'typescript',
                intent: 'Sum two numbers',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                code: ['export function buggySum(a: number, b: number): number {', '    return a - b;', '}'],
                cases: [{ name: 'sum', inputs: [2, 3], expected: 5 }],
                extra: {},
            };

            expect(formatCasesAsTs(buggyNode, buggyNode.cases!, 'typescript').join('\n')).toContain('expect(buggySum(2, 3)).toEqual(5)');

            const res = await runNodeVerification({
                workspaceRoot,
                node: buggyNode,
                nodeId: 'buggySum',
                isTrusted: true,
                language: 'typescript',
            });

            expect(res.state).toBe('failed');
            expect(res.pydanticValid).toBe(true);
            expect(res.testsPassed).toBe(0);
            expect(res.traceback).toContain('Expected deep equal 5');
        }, 20_000);

        it('executes JavaScript node verification and returns untested when no checks exist', async () => {
            const workspaceRoot = makeTempWorkspace();
            const noChecksNode: SlateNode = {
                name: 'plainJs',
                language: 'javascript',
                intent: 'Plain JS',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                code: ['export function plainJs(x) { return x + 1; }'],
                extra: {},
            };

            const untested = await runNodeVerification({
                workspaceRoot,
                node: noChecksNode,
                nodeId: 'plainJs',
                isTrusted: true,
                language: 'javascript',
            });
            expect(untested.state).toBe('untested');

            const checkedNode: SlateNode = {
                ...noChecksNode,
                cases: [{ name: 'inc', inputs: [4], expected: 5 }],
            };
            const passed = await runNodeVerification({
                workspaceRoot,
                node: checkedNode,
                nodeId: 'plainJs',
                isTrusted: true,
                language: 'javascript',
            });
            expect(passed.state).toBe('passed');
            expect(passed.testsPassed).toBe(1);
        }, 20_000);

        it('verifies self-closing JSX (#11), merges dependency imports (#12), isolates concurrent colliding slugs (#13), and handles null/async/optional TS cases (#16-#18)', async () => {
            const workspaceRoot = makeTempWorkspace();

            // #11: Self-closing JSX component passes strict TSX compilation and Node execution
            const jsxNode: SlateNode = {
                name: 'SelfTag',
                language: 'typescript',
                intent: 'Render self-closing span',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                code: [
                    'export function SelfTag(id: string) {',
                    '    return <span data-id={id} />;',
                    '}',
                ],
                check: [
                    "test('SelfTag returns jsx element props', () => {",
                    "    const el = SelfTag('abc');",
                    "    expect(el.type).toBe('span');",
                    "    expect(el.props['data-id']).toBe('abc');",
                    '});',
                ],
                extra: { extension: '.tsx' },
            };
            const jsxRes = await runNodeVerification({
                workspaceRoot,
                node: jsxNode,
                nodeId: 'SelfTag',
                isTrusted: true,
                language: 'typescript',
            });
            expect(jsxRes.state).toBe('passed');
            expect(jsxRes.pydanticValid).toBe(true);

            // #12: Target depending on helper whose imports bring in an external module merges helper imports cleanly
            const helperPkgDir = path.join(workspaceRoot, 'node_modules', 'slate_helper_pkg');
            fs.mkdirSync(helperPkgDir, { recursive: true });
            fs.writeFileSync(path.join(helperPkgDir, 'package.json'), JSON.stringify({ name: 'slate_helper_pkg', main: 'index.js', types: 'index.d.ts' }), 'utf8');
            fs.writeFileSync(path.join(helperPkgDir, 'index.js'), 'exports.joinWithSlash = (a, b) => `${a}/${b}`;\n', 'utf8');
            fs.writeFileSync(path.join(helperPkgDir, 'index.d.ts'), 'export declare function joinWithSlash(a: string, b: string): string;\n', 'utf8');

            const pathHelper: SlateNode = {
                name: 'joinSafe',
                language: 'typescript',
                intent: 'Join POSIX path segments',
                contract: '',
                context: [],
                imports: ["import { joinWithSlash } from 'slate_helper_pkg';"],
                uses: [],
                code: ['function joinSafe(a: string, b: string): string {', '    return joinWithSlash(a, b);', '}'],
                extra: {},
            };
            const depConsumer: SlateNode = {
                name: 'buildKey',
                language: 'typescript',
                intent: 'Build storage key',
                contract: '',
                context: ['joinSafe'],
                imports: [],
                uses: [],
                code: ['export function buildKey(dir: string, file: string): string {', '    return joinSafe(dir, file);', '}'],
                cases: [{ name: 'key', input: { dir: 'nodes', file: 'a.json' }, expected: 'nodes/a.json' }],
                extra: {},
            };
            const depRes = await runNodeVerification({
                workspaceRoot,
                node: depConsumer,
                nodeId: 'buildKey',
                dependencies: new Map([['joinSafe', pathHelper]]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(depRes.state).toBe('passed');

            // #13: Concurrent verifications on colliding sanitized slugs ('a/b/f' vs 'a_b/f') never race
            const nodeLeft: SlateNode = {
                name: 'f',
                language: 'typescript',
                intent: 'Return 11',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                code: ['export function f(x: number): number { return x + 11; }'],
                cases: [{ name: 'c1', input: { x: 1 }, expected: 12 }],
                extra: {},
            };
            const nodeRight: SlateNode = {
                name: 'f',
                language: 'typescript',
                intent: 'Return 22',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                code: ['export function f(x: number): number { return x + 22; }'],
                cases: [{ name: 'c1', input: { x: 1 }, expected: 23 }],
                extra: {},
            };
            const [resLeft, resRight] = await Promise.all([
                runNodeVerification({ workspaceRoot, node: nodeLeft, nodeId: 'a/b/f', isTrusted: true, language: 'typescript' }),
                runNodeVerification({ workspaceRoot, node: nodeRight, nodeId: 'a_b/f', isTrusted: true, language: 'typescript' }),
            ]);
            expect(resLeft.state).toBe('passed');
            expect(resRight.state).toBe('passed');

            // #16: expected: null is preserved and checked rigorously
            const nullNode: SlateNode = {
                name: 'findMissing',
                language: 'typescript',
                intent: 'Return null when absent',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                code: ['export function findMissing(flag: boolean): string | null {', "    return flag ? 'ok' : null;", '}'],
                cases: [{ name: 'returns_null', input: { flag: false }, expected: null }],
                extra: {},
            };
            expect(formatCasesAsTs(nullNode, nullNode.cases!, 'typescript').join('\n')).toContain('.toEqual(null)');
            expect((await runNodeVerification({
                workspaceRoot,
                node: nullNode,
                nodeId: 'findMissing',
                isTrusted: true,
                language: 'typescript',
            })).state).toBe('passed');
            const nullMismatch = await runNodeVerification({
                workspaceRoot,
                node: { ...nullNode, code: ['export function findMissing(_flag: boolean): string | null {', "    return 'unexpected';", '}'] },
                nodeId: 'findMissingMismatch',
                isTrusted: true,
                language: 'typescript',
            });
            expect(nullMismatch.state).toBe('failed');

            // #17: async functions await result and handle rejected Promise error cases
            const asyncNode: SlateNode = {
                name: 'loadScore',
                language: 'typescript',
                intent: 'Resolve or reject async score',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                code: [
                    'export async function loadScore(id: number): Promise<number> {',
                    "    if (id < 0) throw new Error('invalid id');",
                    '    return id * 10;',
                    '}',
                ],
                cases: [
                    { name: 'ok', input: { id: 3 }, expected: 30 },
                    { name: 'neg_rejects', input: { id: -1 }, error: 'invalid id' },
                ],
                extra: {},
            };
            const formattedAsync = formatCasesAsTs(asyncNode, asyncNode.cases!, 'typescript').join('\n');
            expect(formattedAsync).toContain('async () =>');
            expect(formattedAsync).toContain('await loadScore(');
            expect((await runNodeVerification({
                workspaceRoot,
                node: asyncNode,
                nodeId: 'loadScore',
                isTrusted: true,
                language: 'typescript',
            })).state).toBe('passed');

            // #18: Partial object inputs with omitted leading optional parameters pad `undefined`
            const optNode: SlateNode = {
                name: 'addWithDefaults',
                language: 'typescript',
                intent: 'Add optional defaults',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                code: ['export function addWithDefaults(a: number = 1, b: number = 2): number {', '    return a + b;', '}'],
                cases: [{ name: 'only_b', input: { b: 7 }, expected: 8 }],
                extra: {},
            };
            expect(formatCasesAsTs(optNode, optNode.cases!, 'typescript').join('\n')).toContain('addWithDefaults(undefined, 7)');
            expect((await runNodeVerification({
                workspaceRoot,
                node: optNode,
                nodeId: 'addWithDefaults',
                isTrusted: true,
                language: 'typescript',
            })).state).toBe('passed');

            // Follow-up (#1 on df3ab41): Helper and caller with conflicting local import names (`format`) + quote-variant dupes compile & run in isolation
            const pkgAlphaDir = path.join(workspaceRoot, 'node_modules', 'pkg_alpha');
            const pkgBetaDir = path.join(workspaceRoot, 'node_modules', 'pkg_beta');
            fs.mkdirSync(pkgAlphaDir, { recursive: true });
            fs.mkdirSync(pkgBetaDir, { recursive: true });
            fs.writeFileSync(path.join(pkgAlphaDir, 'package.json'), JSON.stringify({ name: 'pkg_alpha', main: 'index.js', types: 'index.d.ts' }), 'utf8');
            fs.writeFileSync(path.join(pkgAlphaDir, 'index.js'), 'exports.format = (s) => `A:${s}`;\n', 'utf8');
            fs.writeFileSync(path.join(pkgAlphaDir, 'index.d.ts'), 'export declare function format(s: string): string;\n', 'utf8');
            fs.writeFileSync(path.join(pkgBetaDir, 'package.json'), JSON.stringify({ name: 'pkg_beta', main: 'index.js', types: 'index.d.ts' }), 'utf8');
            fs.writeFileSync(path.join(pkgBetaDir, 'index.js'), 'exports.format = (s) => `B:${s}`;\n', 'utf8');
            fs.writeFileSync(path.join(pkgBetaDir, 'index.d.ts'), 'export declare function format(s: string): string;\n', 'utf8');

            const helperFmt: SlateNode = {
                name: 'helperFmt',
                language: 'typescript',
                intent: 'Format via pkg_alpha',
                contract: '',
                context: [],
                imports: ["import { format } from 'pkg_alpha';"],
                uses: [],
                code: ['export function helperFmt(v: string): string {', '    return format(v);', '}'],
                extra: {},
            };
            const callerFmt: SlateNode = {
                name: 'callerFmt',
                language: 'typescript',
                intent: 'Combine helperFmt and pkg_beta format without identifier collision',
                contract: '',
                context: ['helperFmt'],
                imports: ["import { format } from 'pkg_beta';", 'import { format } from "pkg_beta";'],
                uses: [],
                code: ['export function callerFmt(v: string): string {', "    return `${helperFmt(v)}|${format(v)}`;", '}'],
                cases: [{ name: 'isolated', input: { v: 'ok' }, expected: 'A:ok|B:ok' }],
                extra: {},
            };
            const isolatedFmtRes = await runNodeVerification({
                workspaceRoot,
                node: callerFmt,
                nodeId: 'callerFmt',
                dependencies: new Map([['helperFmt', helperFmt]]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(isolatedFmtRes.state, isolatedFmtRes.traceback).toBe('passed');
            expect(isolatedFmtRes.pydanticValid).toBe(true);

            // CI regression: rapid consecutive same-byte-length Python retries + concurrent colliding slugs do not hit stale .pyc or collide
            const pyWrong: SlateNode = makeNode({
                name: 'triple',
                language: 'python',
                code: ['def triple(x: int) -> int:', '    return x * 2'],
                cases: [{ name: 'c1', input: { x: 4 }, expected: 12 }],
                check: ['def test_triple():', '    assert triple(4) == 8'],
            });
            const pyRight: SlateNode = makeNode({
                name: 'triple',
                language: 'python',
                code: ['def triple(x: int) -> int:', '    return x * 3'],
                cases: [{ name: 'c1', input: { x: 4 }, expected: 12 }],
                check: ['def test_triple():', '    assert triple(4) == 12'],
            });
            const r1 = await runNodeVerification({ workspaceRoot, node: pyWrong, nodeId: 'py_retry', isTrusted: true, language: 'python' });
            const r2 = await runNodeVerification({ workspaceRoot, node: pyRight, nodeId: 'py_retry', isTrusted: true, language: 'python' });
            expect(r1.state).toBe('failed');
            expect(r2.state, r2.traceback || r2.diagnostics?.join('; ')).toBe('passed');

            const pyLeft = makeNode({
                name: 'p',
                language: 'python',
                code: ['def p(x: int) -> int:', '    return x + 1'],
                cases: [{ name: 'c1', input: { x: 1 }, expected: 2 }],
                check: ['def test_p():', '    assert p(1) == 2'],
            });
            const pyRightConc = makeNode({
                name: 'p',
                language: 'python',
                code: ['def p(x: int) -> int:', '    return x + 2'],
                cases: [{ name: 'c1', input: { x: 1 }, expected: 3 }],
                check: ['def test_p():', '    assert p(1) == 3'],
            });
            const [pyConcA, pyConcB] = await Promise.all([
                runNodeVerification({ workspaceRoot, node: pyLeft, nodeId: 'a/b/p', isTrusted: true, language: 'python' }),
                runNodeVerification({ workspaceRoot, node: pyRightConc, nodeId: 'a_b/p', isTrusted: true, language: 'python' }),
            ]);
            expect(pyConcA.state, pyConcA.traceback).toBe('passed');
            expect(pyConcB.state, pyConcB.traceback).toBe('passed');

            // Follow-up (#1 on e53821e): _prelude module constants and interfaces are exported/imported by actual bindings (not `_prelude`)
            const preludeNode: SlateNode = {
                name: '_prelude',
                kind: 'prelude',
                language: 'typescript',
                intent: 'Module constants and config type',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                code: [
                    'const LIMIT = 10;',
                    'export const SCALE = 2;',
                    'interface ClampCfg { offset: number; }',
                ],
                extra: {},
            };
            const usePreludeNode: SlateNode = {
                name: 'clampScaled',
                language: 'typescript',
                intent: 'Scale value up to LIMIT plus offset',
                contract: '',
                context: ['_prelude'],
                imports: [],
                uses: ['_prelude'],
                code: [
                    'export function clampScaled(x: number, cfg: ClampCfg): number {',
                    '    return Math.min(LIMIT, x * SCALE) + cfg.offset;',
                    '}',
                ],
                cases: [
                    { name: 'below_limit', input: { x: 4, cfg: { offset: 3 } }, expected: 11 },
                    { name: 'capped', input: { x: 20, cfg: { offset: 3 } }, expected: 13 },
                ],
                extra: {},
            };
            const preludeRes = await runNodeVerification({
                workspaceRoot,
                node: usePreludeNode,
                nodeId: 'clampScaled',
                dependencies: new Map([['_prelude', preludeNode]]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(preludeRes.state, preludeRes.traceback).toBe('passed');
            expect(preludeRes.pydanticValid).toBe(true);

            // Follow-up (#2 on e53821e): Mutually recursive helper (`isOdd`) calling target (`isEven`) resolves target import cleanly
            const isOddNode: SlateNode = {
                name: 'isOdd',
                language: 'typescript',
                intent: 'Odd parity via mutual recursion',
                contract: '',
                context: [],
                imports: ["import { isEven } from './isEven';"],
                uses: ['isEven'],
                code: [
                    'export function isOdd(n: number): boolean {',
                    '    if (n === 0) return false;',
                    '    return isEven(n - 1);',
                    '}',
                ],
                extra: {},
            };
            const isEvenNode: SlateNode = {
                name: 'isEven',
                language: 'typescript',
                intent: 'Even parity via mutual recursion',
                contract: '',
                context: ['isOdd'],
                imports: ["import { isOdd } from './isOdd';"],
                uses: ['isOdd'],
                code: [
                    'export function isEven(n: number): boolean {',
                    '    if (n === 0) return true;',
                    '    return isOdd(n - 1);',
                    '}',
                ],
                cases: [
                    { name: 'four_even', input: { n: 4 }, expected: true },
                    { name: 'five_odd', input: { n: 5 }, expected: false },
                ],
                extra: {},
            };
            const mutualRes = await runNodeVerification({
                workspaceRoot,
                node: isEvenNode,
                nodeId: 'isEven',
                dependencies: new Map([['isOdd', isOddNode]]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(mutualRes.state, mutualRes.traceback).toBe('passed');
            expect(mutualRes.pydanticValid).toBe(true);
        }, 40_000);
    });
});
