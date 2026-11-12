import { describe, expect, it, vi } from 'vitest';
import {
    formatCasesAsPython,
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
});
