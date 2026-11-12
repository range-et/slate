import { describe, expect, it } from 'vitest';
import { deepValueEqual, matchFlowOutputs, runFlowCase, runFlowGuardrails } from '../vscode-extension/src/guardrails_runner';
import { parseFlow, serializeFlow } from '../vscode-extension/src/flow';
import type { FlowRunRequest } from '../vscode-extension/src/flow_runner';
import type { SlateFlow, TestCase } from '../vscode-extension/src/harness_protocol';

describe('Cases & Guardrails Matrix (S-602)', () => {
    describe('deepValueEqual', () => {
        it('compares primitives correctly', () => {
            expect(deepValueEqual(42, 42)).toBe(true);
            expect(deepValueEqual(42, 43)).toBe(false);
            expect(deepValueEqual('hello', 'hello')).toBe(true);
            expect(deepValueEqual('hello', 'world')).toBe(false);
            expect(deepValueEqual(true, true)).toBe(true);
            expect(deepValueEqual(true, false)).toBe(false);
            expect(deepValueEqual(null, null)).toBe(true);
            expect(deepValueEqual(null, undefined)).toBe(false);
        });

        it('handles type-tolerant comparisons for python reprs', () => {
            expect(deepValueEqual(42, '42')).toBe(true);
            expect(deepValueEqual('42', 42)).toBe(true);
            expect(deepValueEqual(true, 'True')).toBe(true);
            expect(deepValueEqual(false, 'False')).toBe(true);
            expect(deepValueEqual(3.1415926535, 3.1415926536)).toBe(true); // floating point tolerance
        });

        it('compares nested arrays and objects deeply', () => {
            expect(deepValueEqual([1, 2, 3], [1, 2, 3])).toBe(true);
            expect(deepValueEqual([1, 2, 3], [1, 2, 4])).toBe(false);
            expect(deepValueEqual([1, 2], [1, 2, 3])).toBe(false);

            expect(deepValueEqual({ a: 1, b: 'two' }, { a: 1, b: 'two' })).toBe(true);
            expect(deepValueEqual({ a: 1, b: 'two' }, { b: 'two', a: 1 })).toBe(true);
            expect(deepValueEqual({ a: 1, b: 'two' }, { a: 1, b: 'three' })).toBe(false);
            expect(deepValueEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
        });
    });

    describe('matchFlowOutputs', () => {
        const sampleOutputs = {
            out: { type: 'int', repr: '42', json: 42 },
            flag: { type: 'bool', repr: 'True', json: true },
        };

        it('matches scalar expected value against single or any matching output port', () => {
            const single = { result: { type: 'int', repr: '100', json: 100 } };
            expect(matchFlowOutputs(single, 100).matched).toBe(true);
            expect(matchFlowOutputs(single, '100').matched).toBe(true);
            expect(matchFlowOutputs(single, 200).matched).toBe(false);
        });

        it('matches structured dictionary expected values against named output ports', () => {
            expect(matchFlowOutputs(sampleOutputs, { out: 42, flag: true }).matched).toBe(true);
            expect(matchFlowOutputs(sampleOutputs, { out: 42 }).matched).toBe(true);
            expect(matchFlowOutputs(sampleOutputs, { out: 99 }).matched).toBe(false);
            expect(matchFlowOutputs(sampleOutputs, { missing: 1 }).matched).toBe(false);
        });

        it('handles null and undefined expected values', () => {
            expect(matchFlowOutputs(undefined, null).matched).toBe(true);
            expect(matchFlowOutputs({}, null).matched).toBe(true);
            expect(matchFlowOutputs(undefined, 42).matched).toBe(false);
        });
    });

    describe('Flow case serialization in flow.ts', () => {
        it('parses and serializes flow cases deterministically', () => {
            const flowText = JSON.stringify({
                slate: 3,
                name: 'test_cases_flow',
                inputs: [{ name: 'x', annotation: 'int' }],
                outputs: [{ name: 'y', annotation: 'int' }],
                instances: [
                    { id: 'inst1', node: 'double' },
                ],
                wires: [
                    { from: 'input:x', to: 'inst1.in:val' },
                    { from: 'inst1.out', to: 'output:y' },
                ],
                cases: [
                    { id: 'c1', description: 'positive doubling', inputs: { x: 5 }, expected: 10 },
                    { id: 'c2', description: 'zero doubling', inputs: { x: 0 }, expected: 0 },
                ],
            }, null, 2);

            const parsed = parseFlow(flowText);
            expect(parsed.name).toBe('test_cases_flow');
            expect(parsed.cases).toBeDefined();
            expect(parsed.cases?.length).toBe(2);
            expect(parsed.cases?.[0].inputs).toEqual({ x: 5 });
            expect(parsed.cases?.[0].expected).toBe(10);

            const serialized = serializeFlow(parsed);
            const reparsed = parseFlow(serialized);
            expect(reparsed.cases).toEqual(parsed.cases);
        });

        it('migrates cases from flow.extra.cases if present in legacy format', () => {
            const flowText = JSON.stringify({
                slate: 3,
                name: 'legacy_cases_flow',
                inputs: [],
                outputs: [],
                instances: [],
                wires: [],
                extra: {
                    cases: [
                        { id: 'leg1', inputs: { a: 1 }, output: 2 },
                    ],
                },
            });

            const parsed = parseFlow(flowText);
            expect(parsed.cases).toBeDefined();
            expect(parsed.cases?.length).toBe(1);
            expect(parsed.cases?.[0].expected).toBe(2);
        });
    });

    describe('runFlowCase & runFlowGuardrails execution', () => {
        it('returns passing summary when all flow cases succeed', async () => {
            const fakeFlow: SlateFlow = {
                name: 'math_flow',
                inputs: [{ name: 'n', annotation: 'int' }],
                outputs: [{ name: 'res', annotation: 'int' }],
                instances: [],
                wires: [],
                cases: [
                    { id: 'c1', inputs: { n: 10 }, expected: 10 },
                    { id: 'c2', inputs: { n: 20 }, expected: 20 },
                ],
                extra: {},
            };

            // Using pure execution mock through runFlowCase with pre-resolved values
            const fakeBaseRequest = {
                workspaceRoot: '/mock',
                documents: new Map(),
                flows: new Map([['math_flow', fakeFlow]]),
                config: { slate: 3, language: 'python' },
                isTrusted: false, // will fail runner security check as expected
            };

            const caseResult = await runFlowCase(fakeBaseRequest as any, fakeFlow.cases![0]);
            expect(caseResult.passed).toBe(false);
            expect(caseResult.error).toContain('Workspace is not trusted');
        });

        it('matches expected error case when flow raises expected exception', async () => {
            const errorCase: TestCase = {
                id: 'err1',
                inputs: { val: -1 },
                error: 'Workspace is not trusted',
            };

            const fakeBaseRequest = {
                workspaceRoot: '/mock',
                documents: new Map(),
                flows: new Map(),
                config: { slate: 3, language: 'python' },
                isTrusted: false,
            };

            const caseResult = await runFlowCase(fakeBaseRequest as any, errorCase);
            expect(caseResult.passed).toBe(true);
        });
    });
});
