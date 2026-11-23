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

        it('supports expectedError alias, float pytest.approx matching, numeric tolerance, and approx:false override', () => {
            const floatLines = formatCasesAsPython('sin_deg', [
                { name: 'thirty', input: { degrees: 30 }, expected: 0.5 },
                { name: 'custom_tol', input: { degrees: 60 }, expected: 0.5, approx: 0.001 },
                { name: 'exact_override', input: { degrees: 0 }, expected: 0, approx: false },
                { name: 'err_alias', input: { degrees: 'bad' }, expectedError: 'TypeError' },
            ], { returnAnnotation: 'float' });
            expect(floatLines).toContain('    assert sin_deg(degrees=30) == pytest.approx(0.5, rel=1e-9, abs=1e-12)');
            expect(floatLines).toContain('    assert sin_deg(degrees=60) == pytest.approx(0.5, abs=0.001)');
            expect(floatLines).toContain('    assert sin_deg(degrees=0) == 0');
            expect(floatLines).toContain('    with pytest.raises(TypeError):');
            expect(floatLines).toContain('        sin_deg(degrees="bad")');

            const intLines = formatCasesAsPython('add', [
                { a: 1, b: 2, expected: 3, expectedError: undefined },
            ], { returnAnnotation: 'int' });
            expect(intLines).toContain('    assert add(a=1, b=2) == 3');

            const tsLines = formatCasesAsTs(makeNode({
                name: 'scale',
                language: 'typescript',
                code: ['export function scale(x: number): number {', '    return x * 0.5;', '}'],
            }), [
                { name: 'approx_bool', input: { x: 1 }, expected: 0.5, approx: true },
                { name: 'approx_num', input: { x: 2 }, expected: 1, approx: 0.01 },
                { name: 'exact', input: { x: 4 }, expected: 2, approx: false },
                { name: 'err_alias', input: { x: -1 }, expectedError: 'RangeError' },
            ], 'typescript');
            expect(tsLines.some(l => l.includes('expect(scale(1)).toBeCloseTo(0.5, 6);'))).toBe(true);
            expect(tsLines.some(l => l.includes('expect(Math.abs((scale(2)) - (1))).toBeLessThanOrEqual(0.01);'))).toBe(true);
            expect(tsLines.some(l => l.includes('expect(scale(4)).toEqual(2);'))).toBe(true);
            expect(tsLines.some(l => l.includes('expect(() => { scale(-1); }).toThrow("RangeError");'))).toBe(true);
        });
    });

    describe('generateVerificationFiles', () => {
        it('generates pydantic validation wrapper and pytest check when checks and cases are present', () => {
            const node = makeNode();
            const { moduleContent, testContent, hasChecks } = generateVerificationFiles(node);
            expect(hasChecks).toBe(true);
            expect(moduleContent).toContain('from pydantic import ConfigDict, validate_call');
            expect(moduleContent).toContain('clamp = validate_call(config=ConfigDict(strict=True), validate_return=True)(clamp)');
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
                imports: ['import math'],
                code: ['def helper_func(x: int) -> int:', '    return int(math.fabs(x)) * 2'],
            });
            const deps = new Map([['math/helper_func', depNode]]);
            const node = makeNode({ imports: ['import math', 'from decimal import Decimal'] });
            const { moduleContent } = generateVerificationFiles(node, deps, 'math/clamp');
            expect(moduleContent).toContain('def helper_func(x: int) -> int:');
            expect(moduleContent.match(/^import math$/gm)).toHaveLength(1);
            expect(moduleContent.indexOf('import math')).toBeLessThan(moduleContent.indexOf('def helper_func'));
            expect(moduleContent).toContain('from decimal import Decimal');
        });

        it('imports non-prelude dependency symbols into test file unless already bound in node.check (#55)', () => {
            const depValidate = makeNode({
                name: 'validate_grid',
                code: ['def validate_grid(g: list[list[int]]) -> bool:', '    return True'],
            });
            const depCopy = makeNode({
                name: 'copy_grid',
                code: ['def copy_grid(g: list[list[int]]) -> list[list[int]]:', '    return [list(r) for r in g]'],
            });
            const depAlreadyInCheck = makeNode({
                name: 'local_helper',
                code: ['def local_helper() -> int:', '    return 1'],
            });
            const preludeNode = makeNode({
                name: 'GRID_CONST',
                kind: 'prelude',
                code: ['GRID_CONST = 9'],
            });
            const deps = new Map([
                ['sudoku/validate_grid', depValidate],
                ['sudoku/copy_grid', depCopy],
                ['sudoku/local_helper', depAlreadyInCheck],
                ['sudoku/GRID_CONST', preludeNode],
            ]);
            const target = makeNode({
                name: 'solve_sudoku',
                code: ['def solve_sudoku(grid: list[list[int]]) -> int:', '    return 0'],
                check: [
                    'def local_helper() -> int:',
                    '    return 2',
                    'def test_solve_sudoku():',
                    '    assert solve_sudoku([[0]]) == 0',
                    '    assert validate_grid([[0]]) is True',
                ],
                cases: undefined,
            });
            const { testContent } = generateVerificationFiles(target, deps, 'sudoku/solve_sudoku');
            expect(testContent).toContain('from solve_sudoku_impl import solve_sudoku');
            expect(testContent).toContain('from solve_sudoku_impl import copy_grid, validate_grid');
            expect(testContent).not.toContain('from solve_sudoku_impl import copy_grid, local_helper');
            expect(testContent).not.toContain('GRID_CONST');
        });

        it('enforces strict Pydantic bool-vs-int rejection while preserving int-to-float promotion in real pytest', async () => {
            const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-strict-pydantic-'));
            try {
                const factNode = makeNode({
                    name: 'factorial',
                    check: ['def test_fact():', '    assert factorial(5) == 120'],
                    cases: [
                        { name: 'zero', input: { n: 0 }, expected: 1 },
                        { name: 'reject_bool', input: { n: true }, error: 'ValueError' },
                    ],
                    code: [
                        'def factorial(n: int) -> int:',
                        '    if isinstance(n, bool) or n < 0:',
                        '        raise ValueError("invalid")',
                        '    out = 1',
                        '    for k in range(2, n + 1):',
                        '        out *= k',
                        '    return out',
                    ],
                });
                const factRes = await runNodeVerification({
                    workspaceRoot: tmpWorkspace,
                    node: factNode,
                    nodeId: 'factorial',
                    isTrusted: true,
                });
                expect(factRes.state, factRes.traceback).toBe('passed');
                expect(factRes.pydanticValid).toBe(true);

                const sqrtDep = makeNode({
                    name: 'square_root',
                    imports: ['import math'],
                    code: ['def square_root(x: float) -> float:', '    return math.sqrt(x)'],
                });
                const hypotNode = makeNode({
                    name: 'hypotenuse',
                    context: ['scientific/square_root'],
                    cases: [
                        { name: 'int_inputs_to_float', input: { a: 3, b: 4 }, expected: 5 },
                    ],
                    check: undefined,
                    code: [
                        'def hypotenuse(a: float, b: float) -> float:',
                        '    return square_root(a * a + b * b)',
                    ],
                });
                const hypotRes = await runNodeVerification({
                    workspaceRoot: tmpWorkspace,
                    node: hypotNode,
                    nodeId: 'scientific/hypotenuse',
                    dependencies: new Map([['scientific/square_root', sqrtDep]]),
                    isTrusted: true,
                });
                expect(hypotRes.state, hypotRes.traceback).toBe('passed');
                expect(hypotRes.pydanticValid).toBe(true);
            } finally {
                fs.rmSync(tmpWorkspace, { recursive: true, force: true });
            }
        }, 20_000);

        it('imports test_* and Test* dependency helpers without exposing them to pytest collection or blocking subclasses (#55 PR #56)', async () => {
            const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-test-helper-dep-'));
            try {
                const helperFn = makeNode({
                    name: 'test_bit',
                    code: ['def test_bit(value: int) -> bool:', '    return (value & 1) == 1'],
                });
                const helperClass = makeNode({
                    name: 'TestMask',
                    kind: 'class',
                    code: [
                        'class TestMask:',
                        '    def __init__(self, mask: int) -> None:',
                        '        self.mask = mask',
                    ],
                });
                const baseClass = makeNode({
                    name: 'TestBase',
                    kind: 'class',
                    code: [
                        'class TestBase:',
                        '    def expected_mask(self) -> int:',
                        '        return 5',
                    ],
                });
                const target = makeNode({
                    name: 'has_bit',
                    context: ['bits/test_bit', 'bits/TestMask', 'bits/TestBase'],
                    check: [
                        'class TestSolver(TestBase):',
                        '    def test_inherited_case(self):',
                        '        assert self.expected_mask() == 5',
                        '        assert has_bit(3) is True',
                        'def test_has_bit():',
                        '    assert has_bit(3) is True',
                        '    assert test_bit(2) is False',
                        '    assert TestMask(5).mask == 5',
                    ],
                    cases: undefined,
                    code: [
                        'def has_bit(value: int) -> bool:',
                        '    return test_bit(value)',
                    ],
                });
                const res = await runNodeVerification({
                    workspaceRoot: tmpWorkspace,
                    node: target,
                    nodeId: 'bits/has_bit',
                    dependencies: new Map([
                        ['bits/test_bit', helperFn],
                        ['bits/TestMask', helperClass],
                        ['bits/TestBase', baseClass],
                    ]),
                    isTrusted: true,
                });
                expect(res.state, res.traceback).toBe('passed');
                expect(res.testsPassed).toBe(2);
                expect(res.testsTotal).toBe(2);

                const failingInherited = makeNode({
                    ...target,
                    check: [
                        'class TestFailing(TestBase):',
                        '    def test_fails(self):',
                        '        assert False',
                    ],
                });
                const failRes = await runNodeVerification({
                    workspaceRoot: tmpWorkspace,
                    node: failingInherited,
                    nodeId: 'bits/has_bit_fail',
                    dependencies: new Map([
                        ['bits/test_bit', helperFn],
                        ['bits/TestBase', baseClass],
                    ]),
                    isTrusted: true,
                });
                expect(failRes.state).toBe('failed');

                // User symbols literally named _slate_mark_helper or _SlateNonTestClass must not be overwritten (#55 PR #56)
                const clashHelperClass = makeNode({
                    name: '_SlateNonTestClass',
                    kind: 'class',
                    code: [
                        'class _SlateNonTestClass:',
                        '    value = 99',
                    ],
                });
                const clashTarget = makeNode({
                    name: '_slate_mark_helper',
                    context: ['bits/test_bit', 'bits/_SlateNonTestClass'],
                    check: [
                        'def test_clash_safe():',
                        '    assert _slate_mark_helper(3) == 102',
                        '    assert _SlateNonTestClass.value == 99',
                        '    assert test_bit(2) is False',
                    ],
                    cases: undefined,
                    code: [
                        'def _slate_mark_helper(value: int) -> int:',
                        '    return _SlateNonTestClass.value + (3 if test_bit(value) else 0)',
                    ],
                });
                const clashRes = await runNodeVerification({
                    workspaceRoot: tmpWorkspace,
                    node: clashTarget,
                    nodeId: 'bits/_slate_mark_helper',
                    dependencies: new Map([
                        ['bits/test_bit', helperFn],
                        ['bits/_SlateNonTestClass', clashHelperClass],
                    ]),
                    isTrusted: true,
                });
                expect(clashRes.state, clashRes.traceback).toBe('passed');
                expect(clashRes.testsPassed).toBe(1);
                expect(clashRes.testsTotal).toBe(1);
            } finally {
                fs.rmSync(tmpWorkspace, { recursive: true, force: true });
            }
        }, 20_000);
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

            // Top-level declarations inside node.check shadow exported _prelude symbols without duplicate import injection
            const shadowPreludeNode = makeNode({
                name: 'helper_prelude',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Prelude constant exported to helpers',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                cases: undefined,
                code: ['export const LIMIT = 10;'],
            });
            const usePreludeLimitNode = makeNode({
                name: 'scaleWithLimit',
                language: 'typescript',
                intent: 'Multiply value by prelude LIMIT',
                contract: '',
                context: ['helper_prelude'],
                imports: [],
                uses: ['helper_prelude'],
                cases: undefined,
                code: [
                    'export function scaleWithLimit(n: number): number {',
                    '    return n * LIMIT;',
                    '}',
                ],
                check: [
                    'const LIMIT = 99;',
                    "test('shadows prelude LIMIT in check body without duplicate import', () => {",
                    '    expect(LIMIT).toBe(99);',
                    '    expect(scaleWithLimit(2)).toBe(20);',
                    '});',
                ],
            });
            const shadowRes = await runNodeVerification({
                workspaceRoot,
                node: usePreludeLimitNode,
                nodeId: 'scaleWithLimit',
                dependencies: new Map([['helper_prelude', shadowPreludeNode]]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(shadowRes.state, shadowRes.traceback).toBe('passed');
            expect(shadowRes.pydanticValid).toBe(true);

            // PR #51 P1 (#discussion_r4661835679): Local type/value shadowing respects TypeScript namespace separation
            const depNamespacesNode = makeNode({
                name: 'ns_prelude',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Prelude exporting value LIMIT, interface ScaleCfg, and class Box',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                cases: undefined,
                code: [
                    'export const LIMIT = 10;',
                    'export interface ScaleCfg { factor: number; }',
                    'export class Box { v = 1; }',
                ],
            });
            const localTypeShadowsValueNode = makeNode({
                name: 'useValueWithLocalType',
                language: 'typescript',
                intent: 'Check body declares type LIMIT without suppressing dep value LIMIT import',
                contract: '',
                context: ['ns_prelude'],
                imports: [],
                uses: ['ns_prelude'],
                cases: undefined,
                code: ['export function useValueWithLocalType(n: number): number {', '    return n * LIMIT;', '}'],
                check: [
                    'type LIMIT = number;',
                    "test('local type LIMIT still imports dep value LIMIT', () => {",
                    '    const x: LIMIT = LIMIT;',
                    '    expect(x).toBe(10);',
                    '    expect(useValueWithLocalType(2)).toBe(20);',
                    '});',
                ],
            });
            const localTypeRes = await runNodeVerification({
                workspaceRoot,
                node: localTypeShadowsValueNode,
                nodeId: 'useValueWithLocalType',
                dependencies: new Map([['ns_prelude', depNamespacesNode]]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(localTypeRes.state, localTypeRes.traceback).toBe('passed');
            expect(localTypeRes.pydanticValid).toBe(true);

            const localValueShadowsTypeNode = makeNode({
                name: 'useInterfaceWithLocalValue',
                language: 'typescript',
                intent: 'Check body declares const ScaleCfg without suppressing dep interface ScaleCfg import',
                contract: '',
                context: ['ns_prelude'],
                imports: [],
                uses: ['ns_prelude'],
                cases: undefined,
                code: ['export function useInterfaceWithLocalValue(cfg: ScaleCfg): number {', '    return cfg.factor;', '}'],
                check: [
                    'const ScaleCfg = 3;',
                    "test('local const ScaleCfg still imports dep interface ScaleCfg', () => {",
                    '    const cfg: ScaleCfg = { factor: ScaleCfg };',
                    '    expect(cfg.factor).toBe(3);',
                    '    expect(useInterfaceWithLocalValue(cfg)).toBe(3);',
                    '});',
                ],
            });
            const localValueRes = await runNodeVerification({
                workspaceRoot,
                node: localValueShadowsTypeNode,
                nodeId: 'useInterfaceWithLocalValue',
                dependencies: new Map([['ns_prelude', depNamespacesNode]]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(localValueRes.state, localValueRes.traceback).toBe('passed');
            expect(localValueRes.pydanticValid).toBe(true);

            const localTypeShadowsClassNode = makeNode({
                name: 'useWithLocalTypeBox',
                language: 'typescript',
                intent: 'Check body declares type Box, suppressing conflicting dual class Box import',
                contract: '',
                context: ['ns_prelude'],
                imports: [],
                uses: ['ns_prelude'],
                cases: undefined,
                code: ['export function useWithLocalTypeBox(): number {', '    return new Box().v;', '}'],
                check: [
                    'type Box = number;',
                    "test('local type Box suppresses conflicting dual class Box import', () => {",
                    '    const b: Box = 42;',
                    '    expect(b).toBe(42);',
                    '    expect(useWithLocalTypeBox()).toBe(1);',
                    '});',
                ],
            });
            const localClassShadowRes = await runNodeVerification({
                workspaceRoot,
                node: localTypeShadowsClassNode,
                nodeId: 'useWithLocalTypeBox',
                dependencies: new Map([['ns_prelude', depNamespacesNode]]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(localClassShadowRes.state, localClassShadowRes.traceback).toBe('passed');
            expect(localClassShadowRes.pydanticValid).toBe(true);

            // PR #51 P1 (#discussion_r4662023802): import / import type bindings stay reserved across both value & type sets (no TS2300 duplicate imports)
            const configTypesDir = path.join(workspaceRoot, 'node_modules', 'config_types');
            fs.mkdirSync(configTypesDir, { recursive: true });
            fs.writeFileSync(path.join(configTypesDir, 'package.json'), JSON.stringify({ name: 'config_types', types: 'index.d.ts' }), 'utf8');
            fs.writeFileSync(path.join(configTypesDir, 'index.d.ts'), 'export type LIMIT = number;\n', 'utf8');

            const importTypeTargetNode = makeNode({
                name: 'acceptLimit',
                language: 'typescript',
                intent: 'Use type-only LIMIT import in target signature even when context prelude exports const LIMIT',
                contract: '',
                context: ['ns_prelude'],
                imports: ["import type { LIMIT } from 'config_types';"],
                uses: [],
                check: undefined,
                cases: [{ name: 'inc', input: { x: 4 }, expected: 5 }],
                code: ['export function acceptLimit(x: LIMIT): number {', '    return x + 1;', '}'],
            });
            const acceptLimitRes = await runNodeVerification({
                workspaceRoot,
                node: importTypeTargetNode,
                nodeId: 'acceptLimit',
                dependencies: new Map([['ns_prelude', depNamespacesNode]]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(acceptLimitRes.state, acceptLimitRes.traceback).toBe('passed');
            expect(acceptLimitRes.pydanticValid).toBe(true);

            const importTypeCheckNode = makeNode({
                name: 'targetUsesDepLimit',
                language: 'typescript',
                intent: 'Target uses dep const LIMIT while check uses import type LIMIT from config_types',
                contract: '',
                context: ['ns_prelude'],
                imports: [],
                uses: ['ns_prelude'],
                cases: undefined,
                code: ['export function targetUsesDepLimit(n: number): number {', '    return n * LIMIT;', '}'],
                check: [
                    "import type { LIMIT } from 'config_types';",
                    "test('check-body import type LIMIT suppresses duplicate value import', () => {",
                    '    const v: LIMIT = 7;',
                    '    expect(v).toBe(7);',
                    '    expect(targetUsesDepLimit(2)).toBe(20);',
                    '});',
                ],
            });
            const importTypeCheckRes = await runNodeVerification({
                workspaceRoot,
                node: importTypeCheckNode,
                nodeId: 'targetUsesDepLimit',
                dependencies: new Map([['ns_prelude', depNamespacesNode]]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(importTypeCheckRes.state, importTypeCheckRes.traceback).toBe('passed');
            expect(importTypeCheckRes.pydanticValid).toBe(true);

            const depSharedVal = makeNode({
                name: 'depSharedVal',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Exports value SHARED',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export const SHARED = 7;'],
            });
            const depSharedType = makeNode({
                name: 'depSharedType',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Exports type SHARED',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export type SHARED = string;'],
            });
            const consumeSharedVal = makeNode({
                name: 'getShared',
                language: 'typescript',
                intent: 'Consumes SHARED value from first matching dep without duplicate import from second dep',
                contract: '',
                context: ['depSharedVal', 'depSharedType'],
                imports: [],
                uses: ['depSharedVal'],
                check: undefined,
                cases: [{ name: 'shared', inputs: {}, expected: 7 }],
                code: ['export function getShared(): number {', '    return SHARED;', '}'],
            });
            const sharedDepsRes = await runNodeVerification({
                workspaceRoot,
                node: consumeSharedVal,
                nodeId: 'getShared',
                dependencies: new Map([
                    ['depSharedVal', depSharedVal],
                    ['depSharedType', depSharedType],
                ]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(sharedDepsRes.state, sharedDepsRes.traceback).toBe('passed');
            expect(sharedDepsRes.pydanticValid).toBe(true);

            // PR #51 P1 (#discussion_r4663312534): Exported functions do not spuriously import same-named prelude interfaces;
            // default-exported functions + legitimate same-name parameter types emit `import type` without clobbering CJS exports;
            // helper modules with same-named interface prelude also avoid conflicting imports.
            const depInterfaceFoo = makeNode({
                name: 'depInterfaceFoo',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Prelude exporting interface Foo',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export interface Foo { a: number; }'],
            });
            const exportFnFooNode = makeNode({
                name: 'Foo',
                language: 'typescript',
                intent: 'Exported function Foo ignoring same-named prelude interface Foo',
                contract: '',
                context: ['depInterfaceFoo'],
                imports: [],
                uses: [],
                check: undefined,
                cases: [{ name: 'inc', input: { x: 2 }, expected: 3 }],
                code: ['export function Foo(x: number): number {', '    return x + 1;', '}'],
            });
            const exportFnFooRes = await runNodeVerification({
                workspaceRoot,
                node: exportFnFooNode,
                nodeId: 'Foo',
                dependencies: new Map([['depInterfaceFoo', depInterfaceFoo]]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(exportFnFooRes.state, exportFnFooRes.traceback).toBe('passed');
            expect(exportFnFooRes.pydanticValid).toBe(true);

            const defaultFnFooNode = makeNode({
                name: 'Foo',
                language: 'typescript',
                intent: 'Default-exported function Foo executed via CJS import { Foo } alongside prelude interface Foo',
                contract: '',
                context: ['depInterfaceFoo'],
                imports: [],
                uses: [],
                check: undefined,
                cases: [{ name: 'inc_default', input: { x: 2 }, expected: 3 }],
                code: ['export default function Foo(x: number): number {', '    return x + 1;', '}'],
            });
            const defaultFnFooRes = await runNodeVerification({
                workspaceRoot,
                node: defaultFnFooNode,
                nodeId: 'FooDefault',
                dependencies: new Map([['depInterfaceFoo', depInterfaceFoo]]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(defaultFnFooRes.state, defaultFnFooRes.traceback).toBe('passed');
            expect(defaultFnFooRes.pydanticValid).toBe(true);

            const fnUsingSameNameIfaceNode = makeNode({
                name: 'Foo',
                language: 'typescript',
                intent: 'Exported function Foo accepting prelude interface Foo parameter emits import type cleanly',
                contract: '',
                context: ['depInterfaceFoo'],
                imports: [],
                uses: ['depInterfaceFoo'],
                check: undefined,
                cases: [{ name: 'use_iface', input: { x: { a: 4 } }, expected: 5 }],
                code: ['export function Foo(x: Foo): number {', '    return x.a + 1;', '}'],
            });
            const fnUsingSameNameIfaceRes = await runNodeVerification({
                workspaceRoot,
                node: fnUsingSameNameIfaceNode,
                nodeId: 'FooUsesSameIface',
                dependencies: new Map([['depInterfaceFoo', depInterfaceFoo]]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(fnUsingSameNameIfaceRes.state, fnUsingSameNameIfaceRes.traceback).toBe('passed');
            expect(fnUsingSameNameIfaceRes.pydanticValid).toBe(true);

            const depIfaceHelper = makeNode({
                name: 'depIfaceHelper',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Exports interface Helper',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export interface Helper { a: number; }'],
            });
            const depFnHelper = makeNode({
                name: 'Helper',
                language: 'typescript',
                intent: 'Helper function named Helper alongside interface Helper prelude',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export function Helper(x: number): number {', '    return x + 1;', '}'],
            });
            const callHelperTarget = makeNode({
                name: 'callHelper',
                language: 'typescript',
                intent: 'Calls Helper function without helper-to-helper import conflict',
                contract: '',
                context: ['depIfaceHelper', 'Helper'],
                imports: [],
                uses: ['Helper'],
                check: undefined,
                cases: [{ name: 'call', input: { x: 9 }, expected: 10 }],
                code: ['export function callHelper(x: number): number {', '    return Helper(x);', '}'],
            });
            const helperConflictRes = await runNodeVerification({
                workspaceRoot,
                node: callHelperTarget,
                nodeId: 'callHelper',
                dependencies: new Map([
                    ['depIfaceHelper', depIfaceHelper],
                    ['Helper', depFnHelper],
                ]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(helperConflictRes.state, helperConflictRes.traceback).toBe('passed');
            expect(helperConflictRes.pydanticValid).toBe(true);

            // PR #51 P1 (#discussion_r4663480771): `export type { Config }` and `export { type Config }` and `export { Config }`
            // collect type references accurately, while re-exports with `moduleSpecifier` (`from '...'`) never inject local imports.
            const depConfigIface = makeNode({
                name: 'depConfigIface',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Prelude exporting interface Config',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export interface Config { ok: boolean; }'],
            });
            const exportTypeReexportNode = makeNode({
                name: 'fnExportType',
                language: 'typescript',
                intent: 'Check body contains standalone export type { Config }',
                contract: '',
                context: ['depConfigIface'],
                imports: [],
                uses: ['depConfigIface'],
                cases: undefined,
                code: ['export function fnExportType(): number {', '    return 1;', '}'],
                check: [
                    'export type { Config };',
                    "test('export type Config re-exports prelude interface cleanly', () => {",
                    '    expect(fnExportType()).toBe(1);',
                    '});',
                ],
            });
            const exportTypeRes = await runNodeVerification({
                workspaceRoot,
                node: exportTypeReexportNode,
                nodeId: 'fnExportType',
                dependencies: new Map([['depConfigIface', depConfigIface]]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(exportTypeRes.state, exportTypeRes.traceback).toBe('passed');
            expect(exportTypeRes.pydanticValid).toBe(true);

            const exportInlineTypeNode = makeNode({
                name: 'fnExportInlineType',
                language: 'typescript',
                intent: 'Check body contains inline export { type Config }',
                contract: '',
                context: ['depConfigIface'],
                imports: [],
                uses: ['depConfigIface'],
                cases: undefined,
                code: ['export function fnExportInlineType(): number {', '    return 2;', '}'],
                check: [
                    'export { type Config };',
                    "test('export { type Config } re-exports prelude interface cleanly', () => {",
                    '    expect(fnExportInlineType()).toBe(2);',
                    '});',
                ],
            });
            const exportInlineTypeRes = await runNodeVerification({
                workspaceRoot,
                node: exportInlineTypeNode,
                nodeId: 'fnExportInlineType',
                dependencies: new Map([['depConfigIface', depConfigIface]]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(exportInlineTypeRes.state, exportInlineTypeRes.traceback).toBe('passed');
            expect(exportInlineTypeRes.pydanticValid).toBe(true);

            const helperReexportNamed = makeNode({
                name: 'helperReexportCfg',
                language: 'typescript',
                intent: 'Helper module re-exporting interface Config via export { Config }',
                contract: '',
                context: ['depConfigIface'],
                imports: [],
                uses: ['depConfigIface'],
                check: undefined,
                cases: undefined,
                code: [
                    'export { Config };',
                    'export function helperReexportCfg(): number {',
                    '    return 3;',
                    '}',
                ],
            });
            const externalModuleReexportTarget = makeNode({
                name: 'callReexportHelper',
                language: 'typescript',
                intent: 'Calls helper re-exporting Config while target itself re-exports external config_types LIMIT without colliding with depNamespacesNode const LIMIT',
                contract: '',
                context: ['depConfigIface', 'helperReexportCfg', 'ns_prelude'],
                imports: [],
                uses: ['helperReexportCfg'],
                cases: undefined,
                code: [
                    "export type { LIMIT } from 'config_types';",
                    'export function callReexportHelper(): number {',
                    '    return helperReexportCfg();',
                    '}',
                ],
                check: [
                    'export { Config };',
                    "test('helper and check re-exports compile cleanly without external from-reexport collision', () => {",
                    '    expect(callReexportHelper()).toBe(3);',
                    '});',
                ],
            });
            const reexportCombinedRes = await runNodeVerification({
                workspaceRoot,
                node: externalModuleReexportTarget,
                nodeId: 'callReexportHelper',
                dependencies: new Map([
                    ['depConfigIface', depConfigIface],
                    ['helperReexportCfg', helperReexportNamed],
                    ['ns_prelude', depNamespacesNode],
                ]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(reexportCombinedRes.state, reexportCombinedRes.traceback).toBe('passed');
            expect(reexportCombinedRes.pydanticValid).toBe(true);
        }, 40_000);

        it('prioritizes dual and value dep providers before earlier type-only imports across deps, target, and tests', async () => {
            const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-vr-ts-priority-'));
            tempDirs.push(workspaceRoot);

            const depSharedType = makeNode({
                name: 'depSharedType',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Exports type SHARED',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export type SHARED = string;'],
            });
            const depSharedVal = makeNode({
                name: 'depSharedVal',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Exports value SHARED',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export const SHARED = 7;'],
            });

            // Case 1: `[depSharedType, depSharedVal]` (`type` FIRST, `value` SECOND) with value + `export { SHARED }` re-export
            const namedReexportTarget = makeNode({
                name: 'pickSharedNamed',
                language: 'typescript',
                intent: 'Checks combined value + named re-export reference resolves SHARED value even when depSharedType comes first',
                contract: '',
                context: ['depSharedType', 'depSharedVal'],
                imports: [],
                uses: [],
                cases: undefined,
                code: ['export function pickSharedNamed(): number {', '    return 1;', '}'],
                check: [
                    'export { SHARED };',
                    "test('picks value over earlier type for combined value+reexport refs', () => {",
                    '    expect(SHARED).toBe(7);',
                    '    expect(pickSharedNamed()).toBe(1);',
                    '});',
                ],
            });
            const namedReexportRes = await runNodeVerification({
                workspaceRoot,
                node: namedReexportTarget,
                nodeId: 'pickSharedNamed',
                dependencies: new Map([
                    ['depSharedType', depSharedType],
                    ['depSharedVal', depSharedVal],
                ]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(namedReexportRes.state, namedReexportRes.traceback).toBe('passed');
            expect(namedReexportRes.pydanticValid).toBe(true);

            // Case 2: `[depSharedType, depSharedVal]` (`type` FIRST, `value` SECOND) with value + `export default SHARED`
            const defaultReexportTarget = makeNode({
                name: 'pickSharedDefault',
                language: 'typescript',
                intent: 'Checks combined value + export default reference resolves SHARED value even when depSharedType comes first',
                contract: '',
                context: ['depSharedType', 'depSharedVal'],
                imports: [],
                uses: [],
                cases: undefined,
                code: ['export function pickSharedDefault(): number {', '    return 1;', '}'],
                check: [
                    'export default SHARED;',
                    "test('picks value over earlier type for export default refs', () => {",
                    '    expect(SHARED).toBe(7);',
                    '    expect(pickSharedDefault()).toBe(1);',
                    '});',
                ],
            });
            const defaultReexportRes = await runNodeVerification({
                workspaceRoot,
                node: defaultReexportTarget,
                nodeId: 'pickSharedDefault',
                dependencies: new Map([
                    ['depSharedType', depSharedType],
                    ['depSharedVal', depSharedVal],
                ]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(defaultReexportRes.state, defaultReexportRes.traceback).toBe('passed');
            expect(defaultReexportRes.pydanticValid).toBe(true);

            // Case 3: Dual provider (`export class Box`) beats earlier value-only provider (`export const Box = 1`)
            // across dep helper module, target impl module, and test module when both value & type refs exist.
            const depBoxVal = makeNode({
                name: 'depBoxVal',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Prelude exporting value-only Box',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export const Box = 1;'],
            });
            const depBoxClass = makeNode({
                name: 'depBoxClass',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Prelude exporting dual value+type class Box',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export class Box { v = 5; }'],
            });
            const helperBoxNode = makeNode({
                name: 'helperReadBox',
                language: 'typescript',
                intent: 'Helper using Box as both type annotation and constructor',
                contract: '',
                context: ['depBoxVal', 'depBoxClass'],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: [
                    'export function helperReadBox(): number {',
                    '    const b: Box = new Box();',
                    '    return b.v;',
                    '}',
                ],
            });
            const dualBoxTarget = makeNode({
                name: 'useDualBox',
                language: 'typescript',
                intent: 'Target using Box as both type annotation and constructor alongside helperReadBox',
                contract: '',
                context: ['depBoxVal', 'depBoxClass', 'helperReadBox'],
                imports: [],
                uses: ['helperReadBox'],
                cases: undefined,
                code: [
                    'export function useDualBox(): number {',
                    '    const b: Box = new Box();',
                    '    return b.v + helperReadBox();',
                    '}',
                ],
                check: [
                    "test('selects dual class Box over earlier value-only Box across deps, target, and test', () => {",
                    '    const b: Box = new Box();',
                    '    expect(b.v).toBe(5);',
                    '    expect(useDualBox()).toBe(10);',
                    '});',
                ],
            });
            const dualBoxRes = await runNodeVerification({
                workspaceRoot,
                node: dualBoxTarget,
                nodeId: 'useDualBox',
                dependencies: new Map([
                    ['depBoxVal', depBoxVal],
                    ['depBoxClass', depBoxClass],
                    ['helperReadBox', helperBoxNode],
                ]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(dualBoxRes.state, dualBoxRes.traceback).toBe('passed');
            expect(dualBoxRes.pydanticValid).toBe(true);
        }, 40_000);

        it('excludes locally shadowed parameters, variables, shorthand bindings, and type parameters from dep import selection', async () => {
            const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-vr-ts-scope-'));
            tempDirs.push(workspaceRoot);

            const depClassBox = makeNode({
                name: 'depClassBox',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Prelude exporting dual value+type class Box',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export class Box { v = 5; }'],
            });

            // Test A (PR #51 P1 #discussion_r4663796585): Parameter `Box: number` satisfies local value reference
            // in `return { a: Box }`, so earlier `interface Box` is selected over later `class Box`.
            const depInterfaceBox = makeNode({
                name: 'depInterfaceBox',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Prelude exporting interface Box { a: number }',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export interface Box { a: number; }'],
            });
            const paramShadowTarget = makeNode({
                name: 'wrapParamBox',
                language: 'typescript',
                intent: 'Uses Box parameter in value position and outer interface Box as return type',
                contract: '',
                context: ['depInterfaceBox', 'depClassBox'],
                imports: [],
                uses: [],
                cases: undefined,
                code: [
                    'export function wrapParamBox(Box: number): Box {',
                    '    return { a: Box };',
                    '}',
                ],
                check: [
                    "test('local parameter Box selects interface Box rather than later class Box', () => {",
                    '    expect(wrapParamBox(9)).toEqual({ a: 9 });',
                    '});',
                ],
            });
            const paramShadowRes = await runNodeVerification({
                workspaceRoot,
                node: paramShadowTarget,
                nodeId: 'wrapParamBox',
                dependencies: new Map([
                    ['depInterfaceBox', depInterfaceBox],
                    ['depClassBox', depClassBox],
                ]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(paramShadowRes.state, paramShadowRes.traceback).toBe('passed');
            expect(paramShadowRes.pydanticValid).toBe(true);

            // Test B: Local `const Box` + shorthand property `{ Box }` must not register an outer value ref.
            const depInterfaceBoxShorthand = makeNode({
                name: 'depInterfaceBoxShorthand',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Prelude exporting interface Box { Box: number }',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export interface Box { Box: number; }'],
            });
            const shorthandLocalTarget = makeNode({
                name: 'shorthandLocalBox',
                language: 'typescript',
                intent: 'Uses local const Box in shorthand object literal with outer interface Box return type',
                contract: '',
                context: ['depInterfaceBoxShorthand', 'depClassBox'],
                imports: [],
                uses: [],
                cases: undefined,
                code: [
                    'export function shorthandLocalBox(n: number): Box {',
                    '    const Box = n + 1;',
                    '    return { Box };',
                    '}',
                ],
                check: [
                    "test('local shorthand binding selects interface Box rather than later class Box', () => {",
                    '    expect(shorthandLocalBox(4)).toEqual({ Box: 5 });',
                    '});',
                ],
            });
            const shorthandLocalRes = await runNodeVerification({
                workspaceRoot,
                node: shorthandLocalTarget,
                nodeId: 'shorthandLocalBox',
                dependencies: new Map([
                    ['depInterfaceBoxShorthand', depInterfaceBoxShorthand],
                    ['depClassBox', depClassBox],
                ]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(shorthandLocalRes.state, shorthandLocalRes.traceback).toBe('passed');
            expect(shorthandLocalRes.pydanticValid).toBe(true);

            // Test C: Symmetric type-parameter `<Box>` shadowing leaves only outer value ref `Box` (`const Box = 7`),
            // selecting value-only `depBoxVal` rather than later dual `depClassBox`.
            const depBoxVal = makeNode({
                name: 'depBoxVal',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Prelude exporting value Box = 7',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export const Box = 7;'],
            });
            const genericTypeShadowTarget = makeNode({
                name: 'genericBoxValue',
                language: 'typescript',
                intent: 'Type parameter Box shadows outer type while body reads outer value Box',
                contract: '',
                context: ['depBoxVal', 'depClassBox'],
                imports: [],
                uses: ['depBoxVal'],
                cases: undefined,
                code: [
                    'export function genericBoxValue<Box>(x: Box): [Box, number] {',
                    '    return [x, Box];',
                    '}',
                ],
                check: [
                    "test('type parameter Box shadows outer type so outer const Box is selected', () => {",
                    "    expect(genericBoxValue('ok')).toEqual(['ok', 7]);",
                    '});',
                ],
            });
            const genericTypeShadowRes = await runNodeVerification({
                workspaceRoot,
                node: genericTypeShadowTarget,
                nodeId: 'genericBoxValue',
                dependencies: new Map([
                    ['depBoxVal', depBoxVal],
                    ['depClassBox', depClassBox],
                ]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(genericTypeShadowRes.state, genericTypeShadowRes.traceback).toBe('passed');
            expect(genericTypeShadowRes.pydanticValid).toBe(true);

            // Test D: Parameter default initializer `x: number = Box` is NOT shadowed by body `const Box = 1`,
            // so `depBoxVal` (`const Box = 7`) must still be imported.
            const defaultParamOuterTarget = makeNode({
                name: 'defaultParamOuterBox',
                language: 'typescript',
                intent: 'Reads outer Box in parameter default while shadowing Box in function body',
                contract: '',
                context: ['depBoxVal'],
                imports: [],
                uses: ['depBoxVal'],
                cases: undefined,
                code: [
                    'export function defaultParamOuterBox(x: number = Box): number {',
                    '    const Box = 1;',
                    '    return x + Box;',
                    '}',
                ],
                check: [
                    "test('parameter default reads outer Box before body shadow', () => {",
                    '    expect(defaultParamOuterBox()).toBe(8);',
                    '});',
                ],
            });
            const defaultParamOuterRes = await runNodeVerification({
                workspaceRoot,
                node: defaultParamOuterTarget,
                nodeId: 'defaultParamOuterBox',
                dependencies: new Map([['depBoxVal', depBoxVal]]),
                isTrusted: true,
                language: 'typescript',
            });
            expect(defaultParamOuterRes.state, defaultParamOuterRes.traceback).toBe('passed');
            expect(defaultParamOuterRes.pydanticValid).toBe(true);
        }, 40_000);

        it('ignores named tuple labels and import() type qualifiers while importing element and argument types', async () => {
            const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-vr-ts-tuple-import-'));
            tempDirs.push(workspaceRoot);

            const pkgDir = path.join(workspaceRoot, 'node_modules', 'slate-ext-pkg');
            fs.mkdirSync(pkgDir, { recursive: true });
            fs.writeFileSync(path.join(pkgDir, 'index.d.ts'), 'export type Box<T> = { wrapped: T };\n', 'utf8');

            const depBoxVal = makeNode({
                name: 'depBoxVal',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Prelude exporting value Box = 7',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export const Box = 7;'],
            });
            const depClassBox = makeNode({
                name: 'depClassBox',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Prelude exporting dual value+type class Box',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export class Box { v = 5; }'],
            });
            const depItemType = makeNode({
                name: 'depItemType',
                language: 'typescript',
                kind: 'prelude',
                intent: 'Prelude exporting interface Item',
                contract: '',
                context: [],
                imports: [],
                uses: [],
                check: undefined,
                cases: undefined,
                code: ['export interface Item { n: number; }'],
            });

            const deps = new Map([
                ['depBoxVal', depBoxVal],
                ['depClassBox', depClassBox],
                ['depItemType', depItemType],
            ]);

            // Test 1: Named tuple label `Box:` does not count as a type ref (so depBoxVal is chosen over depClassBox),
            // while element type `Item` is imported.
            const tupleTarget = makeNode({
                name: 'sumNamedTuple',
                language: 'typescript',
                intent: 'Sums tuple element Item.n, tuple number, and outer const Box with a Box tuple label',
                contract: '',
                context: ['depBoxVal', 'depClassBox', 'depItemType'],
                imports: [],
                uses: ['depBoxVal'],
                cases: undefined,
                code: [
                    'export function sumNamedTuple(pair: [Box: Item, extra: number]): number {',
                    '    return pair[0].n + pair[1] + Box;',
                    '}',
                ],
                check: [
                    "test('named tuple label Box does not trigger class Box while element type Item is imported', () => {",
                    '    expect(sumNamedTuple([{ n: 3 }, 5])).toBe(15);',
                    '});',
                ],
            });
            const tupleRes = await runNodeVerification({
                workspaceRoot,
                node: tupleTarget,
                nodeId: 'sumNamedTuple',
                dependencies: deps,
                isTrusted: true,
                language: 'typescript',
            });
            expect(tupleRes.state, tupleRes.traceback).toBe('passed');
            expect(tupleRes.pydanticValid).toBe(true);

            // Test 2: `import('slate-ext-pkg').Box<Item>` ignores qualifier `.Box` while importing `<Item>`,
            // so `+ Box` still selects `depBoxVal` over `depClassBox`.
            const importTypeTarget = makeNode({
                name: 'unwrapImportType',
                language: 'typescript',
                intent: 'Unwraps import() type whose qualifier matches depClassBox while reading outer const Box',
                contract: '',
                context: ['depBoxVal', 'depClassBox', 'depItemType'],
                imports: [],
                uses: ['depBoxVal'],
                cases: undefined,
                code: [
                    "export function unwrapImportType(x: import('slate-ext-pkg').Box<Item>): number {",
                    '    return x.wrapped.n + Box;',
                    '}',
                ],
                check: [
                    "test('import() type qualifier Box does not trigger class Box while type argument Item is imported', () => {",
                    '    expect(unwrapImportType({ wrapped: { n: 4 } })).toBe(11);',
                    '});',
                ],
            });
            const importTypeRes = await runNodeVerification({
                workspaceRoot,
                node: importTypeTarget,
                nodeId: 'unwrapImportType',
                dependencies: deps,
                isTrusted: true,
                language: 'typescript',
            });
            expect(importTypeRes.state, importTypeRes.traceback).toBe('passed');
            expect(importTypeRes.pydanticValid).toBe(true);

            // Test 3: Function-type parameter label `(Box: number) => Item` stays ignored while external
            // shorthand property `{ Box }` still imports `depBoxVal` (`const Box = 7`).
            const shorthandFnTypeTarget = makeNode({
                name: 'shorthandAndFnType',
                language: 'typescript',
                intent: 'Uses Box as function-type param name and external shorthand object property',
                contract: '',
                context: ['depBoxVal', 'depClassBox', 'depItemType'],
                imports: [],
                uses: ['depBoxVal'],
                cases: undefined,
                code: [
                    'export type Mapper = (Box: number) => Item;',
                    'export function shorthandAndFnType(fn: Mapper): { Box: number; n: number } {',
                    '    return { Box, n: fn(Box).n };',
                    '}',
                ],
                check: [
                    "test('function type param label stays ignored and external shorthand imports const Box', () => {",
                    '    expect(shorthandAndFnType((v) => ({ n: v + 1 }))).toEqual({ Box: 7, n: 8 });',
                    '});',
                ],
            });
            const shorthandFnTypeRes = await runNodeVerification({
                workspaceRoot,
                node: shorthandFnTypeTarget,
                nodeId: 'shorthandAndFnType',
                dependencies: deps,
                isTrusted: true,
                language: 'typescript',
            });
            expect(shorthandFnTypeRes.state, shorthandFnTypeRes.traceback).toBe('passed');
            expect(shorthandFnTypeRes.pydanticValid).toBe(true);
        }, 40_000);
    });
});
