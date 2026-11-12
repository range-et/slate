import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compilePython, flowTarget } from '../vscode-extension/src/compile/python';
import { SLATE_TRACE_PY } from '../vscode-extension/src/compile/slate_trace';
import { makeValueKey, parseTraceLog, parseValueKey, runFlow } from '../vscode-extension/src/flow_runner';
import type { SlateFlow } from '../vscode-extension/src/harness_protocol';
import type { SlateConfig, SlateNode } from '../vscode-extension/src/slate_folder';

describe('Trusted Flow Runner & Trace Compiler Matrix (S-600)', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-runner-test-'));
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup failure
        }
    });

    describe('Value Keys and Flow Targets', () => {
        it('resolves flow targets for main, root flows, and nested subflows', () => {
            expect(flowTarget('main', 'my-proj')).toEqual({ module: 'my_proj', functionName: 'main' });
            expect(flowTarget('calc', 'my-proj')).toEqual({ module: 'my_proj', functionName: 'calc' });
            expect(flowTarget('flows/calc', 'my-proj')).toEqual({ module: 'flows', functionName: 'calc' });
            expect(flowTarget('flows/math/add', 'my-proj')).toEqual({ module: 'flows.math', functionName: 'add' });
        });

        it('formats and parses value keys round-trip across root and nested paths', () => {
            const rootKey = makeValueKey([], 'inst1', 'out');
            expect(rootKey).toBe('::inst1::out');
            expect(parseValueKey(rootKey)).toEqual({ invocationPath: [], instanceId: 'inst1', portId: 'out' });

            const nestedKey = makeValueKey(['caller_a', 'sub_inst'], 'target_inst', 'in:x');
            expect(nestedKey).toBe('caller_a/sub_inst::target_inst::in:x');
            expect(parseValueKey(nestedKey)).toEqual({
                invocationPath: ['caller_a', 'sub_inst'],
                instanceId: 'target_inst',
                portId: 'in:x',
            });
        });
    });

    describe('Trace Mode Compiler', () => {
        const config: SlateConfig = { slate: 3, name: 'demo_proj', language: 'python' };

        const addNode: SlateNode = {
            name: 'add',
            intent: 'Add two integers',
            contract: 'x: int, y: int -> int',
            context: [],
            examples: [],
            locked: true,
            imports: [],
            uses: [],
            code: [
                'def add(x: int, y: int) -> int:',
                '    return x + y',
            ],
            extra: {},
        };

        const flow: SlateFlow = {
            name: 'calc',
            inputs: [],
            outputs: [{ id: 'out:result', name: 'result', annotation: 'int' }],
            instances: [
                { id: 'val_a', kind: 'value', value: '10' },
                { id: 'val_b', kind: 'value', value: '20' },
                { id: 'inst_add', node: 'add' },
            ],
            wires: [
                { from: 'val_a.out', to: 'inst_add.in:x' },
                { from: 'val_b.out', to: 'inst_add.in:y' },
                { from: 'inst_add.out', to: 'output:result' },
            ],
            extra: {},
        };

        it('generates standard untraced code when trace is false or omitted', () => {
            const nodes = new Map<string, SlateNode>([['add', addNode]]);
            const flows = new Map<string, SlateFlow>([['flows/calc', flow]]);
            const compiled = compilePython(nodes, config, flows, new Map());

            expect(compiled.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
            expect(compiled.files.has('_slate_trace.py')).toBe(false);

            const flowFile = compiled.files.get('flows.py')!;
            expect(flowFile).toBeDefined();
            expect(flowFile).not.toContain('_slate_trace');
            expect(flowFile).toContain('v_inst_add = add(x=v_val_a, y=v_val_b)');
        });

        it('instruments flows with _slate_trace.scope and emits _slate_trace.py when trace is true', () => {
            const nodes = new Map<string, SlateNode>([['add', addNode]]);
            const flows = new Map<string, SlateFlow>([['flows/calc', flow]]);
            const compiled = compilePython(nodes, config, flows, new Map(), { trace: true });

            expect(compiled.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
            expect(compiled.files.has('_slate_trace.py')).toBe(true);
            expect(compiled.files.get('_slate_trace.py')).toBe(SLATE_TRACE_PY);

            const flowFile = compiled.files.get('flows.py')!;
            expect(flowFile).toContain('import _slate_trace');
            expect(flowFile).toContain('with _slate_trace.scope("val_a"):');
            expect(flowFile).toContain('_slate_trace.trace_output("val_a", "out", v_val_a)');
            expect(flowFile).toContain('with _slate_trace.scope("inst_add"):');
            expect(flowFile).toContain('_slate_trace.trace_input("inst_add", "in:x", v_val_a)');
            expect(flowFile).toContain('_slate_trace.trace_input("inst_add", "in:y", v_val_b)');
            expect(flowFile).toContain('_slate_trace.trace_output("inst_add", "out", v_inst_add)');
            expect(flowFile).toContain('_slate_trace.trace_flow_output("result", v_inst_add)');
            expect(flowFile).toContain('except Exception as _slate_err:');
            expect(flowFile).toContain('_slate_trace.trace_error("inst_add", f"{type(_slate_err).__name__}: {_slate_err}")');
        });
    });

    describe('Trace Log Parser', () => {
        const dummyFlow: SlateFlow = {
            name: 'test_flow',
            inputs: [],
            outputs: [],
            instances: [
                { id: 'inst1', node: 'foo' },
                { id: 'inst2', node: 'bar' },
                { id: 'inst3', node: 'baz' },
            ],
            wires: [],
            extra: {},
        };

        it('parses input and output events and marks observed instances as executed', () => {
            const logLines = [
                JSON.stringify({ kind: 'input', path: [], instance: 'inst1', port: 'in:a', val: { type: 'int', repr: '5', json: 5 } }),
                JSON.stringify({ kind: 'output', path: [], instance: 'inst1', port: 'out', val: { type: 'int', repr: '10', json: 10 } }),
                JSON.stringify({ kind: 'output', path: [], instance: 'inst2', port: 'out', val: { type: 'str', repr: "'hello'", json: 'hello' } }),
            ].join('\n');

            const { observations, valuesByUse, runError } = parseTraceLog(logLines, dummyFlow);
            expect(runError).toBeUndefined();

            const inst1 = observations.find(o => o.instanceId === 'inst1')!;
            expect(inst1).toBeDefined();
            expect(inst1.status).toBe('executed');
            expect(inst1.inputs['in:a']).toEqual({ type: 'int', repr: '5', json: 5 });
            expect(inst1.outputs['out']).toEqual({ type: 'int', repr: '10', json: 10 });

            const inst2 = observations.find(o => o.instanceId === 'inst2')!;
            expect(inst2).toBeDefined();
            expect(inst2.status).toBe('executed');
            expect(inst2.outputs['out']).toEqual({ type: 'str', repr: "'hello'", json: 'hello' });

            // inst3 was not in log: should be marked not_executed
            const inst3 = observations.find(o => o.instanceId === 'inst3')!;
            expect(inst3).toBeDefined();
            expect(inst3.status).toBe('not_executed');

            expect(valuesByUse['::inst1::in:a']).toEqual({ type: 'int', repr: '5', json: 5 });
            expect(valuesByUse['::inst1::out']).toEqual({ type: 'int', repr: '10', json: 10 });
            expect(valuesByUse['::inst2::out']).toEqual({ type: 'str', repr: "'hello'", json: 'hello' });
        });

        it('distinguishes two linked calls of the same subflow by invocation path', () => {
            const logLines = [
                JSON.stringify({ kind: 'output', path: ['call_a'], instance: 'sub_step', port: 'out', val: { type: 'int', repr: '100', json: 100 } }),
                JSON.stringify({ kind: 'output', path: ['call_b'], instance: 'sub_step', port: 'out', val: { type: 'int', repr: '200', json: 200 } }),
            ].join('\n');

            const { observations, valuesByUse } = parseTraceLog(logLines, undefined);
            expect(observations.length).toBe(2);

            const obsA = observations.find(o => o.path.join('/') === 'call_a')!;
            expect(obsA.instanceId).toBe('sub_step');
            expect(obsA.outputs['out'].json).toBe(100);

            const obsB = observations.find(o => o.path.join('/') === 'call_b')!;
            expect(obsB.instanceId).toBe('sub_step');
            expect(obsB.outputs['out'].json).toBe(200);

            expect(valuesByUse['call_a::sub_step::out'].json).toBe(100);
            expect(valuesByUse['call_b::sub_step::out'].json).toBe(200);
        });

        it('handles instance failure and extracts flow-level error', () => {
            const logLines = [
                JSON.stringify({ kind: 'output', path: [], instance: 'inst1', port: 'out', val: { type: 'int', repr: '1', json: 1 } }),
                JSON.stringify({ kind: 'error', path: [], instance: 'inst2', error: 'ZeroDivisionError: division by zero' }),
                JSON.stringify({ kind: 'flow_error', error: 'ZeroDivisionError: division by zero' }),
            ].join('\n');

            const { observations, runError } = parseTraceLog(logLines, dummyFlow);
            expect(runError).toBe('ZeroDivisionError: division by zero');

            const inst2 = observations.find(o => o.instanceId === 'inst2')!;
            expect(inst2.status).toBe('failed');
            expect(inst2.error).toBe('ZeroDivisionError: division by zero');

            const inst3 = observations.find(o => o.instanceId === 'inst3')!;
            expect(inst3.status).toBe('not_executed');
        });
    });

    describe('runFlow Guardrails and Live Execution', () => {
        const config: SlateConfig = { slate: 3, name: 'guard_proj', language: 'python' };

        const multiplyNode: SlateNode = {
            name: 'multiply',
            intent: 'Multiply two numbers',
            contract: 'a: int, b: int -> int',
            context: [],
            examples: [],
            locked: true,
            imports: [],
            uses: [],
            code: [
                'def multiply(a: int, b: int) -> int:',
                '    print("User message from inside multiply node")',
                '    return a * b',
            ],
            extra: {},
        };

        const flow: SlateFlow = {
            name: 'run_math',
            inputs: [],
            outputs: [{ id: 'out:res', name: 'res', annotation: 'int' }],
            instances: [
                { id: 'v1', kind: 'value', value: '6' },
                { id: 'v2', kind: 'value', value: '7' },
                { id: 'mul_inst', node: 'multiply' },
            ],
            wires: [
                { from: 'v1.out', to: 'mul_inst.in:a' },
                { from: 'v2.out', to: 'mul_inst.in:b' },
                { from: 'mul_inst.out', to: 'output:res' },
            ],
            extra: {},
        };

        it('refuses execution if workspace is untrusted', async () => {
            const res = await runFlow({
                workspaceRoot: tmpDir,
                flowId: 'run_math',
                documents: new Map([['multiply', multiplyNode]]),
                flows: new Map([['run_math', flow]]),
                config,
                isTrusted: false,
            });

            expect(res.status).toBe('failed');
            expect(res.error).toContain('Workspace is not trusted');
        });

        it('refuses execution if flow does not exist', async () => {
            const res = await runFlow({
                workspaceRoot: tmpDir,
                flowId: 'nonexistent',
                documents: new Map(),
                flows: new Map(),
                config,
                isTrusted: true,
            });

            expect(res.status).toBe('failed');
            expect(res.error).toContain('Flow "nonexistent" not found');
        });

        it('refuses execution if graph has compile errors (no last-good runs)', async () => {
            const brokenFlow: SlateFlow = {
                name: 'broken',
                inputs: [],
                outputs: [],
                instances: [
                    { id: 'bad_inst', node: 'missing_node' },
                ],
                wires: [],
                extra: {},
            };

            const res = await runFlow({
                workspaceRoot: tmpDir,
                flowId: 'broken',
                documents: new Map(),
                flows: new Map([['broken', brokenFlow]]),
                config,
                isTrusted: true,
            });

            expect(res.status).toBe('failed');
            expect(res.error).toContain('Refusing execution: graph has compile errors');
            expect(res.error).toContain('missing_node');
        });

        it('runs a valid flow to completion, keeping user stdout separate from trace protocol', async () => {
            const res = await runFlow({
                workspaceRoot: tmpDir,
                flowId: 'run_math',
                documents: new Map([['multiply', multiplyNode]]),
                flows: new Map([['run_math', flow]]),
                config,
                isTrusted: true,
            });

            expect(res.status).toBe('completed');
            expect(res.exitCode).toBe(0);
            expect(res.stdout).toContain('User message from inside multiply node');

            // Values keyed per use
            expect(res.valuesByUse['::v1::out']).toEqual({ type: 'int', repr: '6', json: 6 });
            expect(res.valuesByUse['::v2::out']).toEqual({ type: 'int', repr: '7', json: 7 });
            expect(res.valuesByUse['::mul_inst::in:a']).toEqual({ type: 'int', repr: '6', json: 6 });
            expect(res.valuesByUse['::mul_inst::in:b']).toEqual({ type: 'int', repr: '7', json: 7 });
            expect(res.valuesByUse['::mul_inst::out']).toEqual({ type: 'int', repr: '42', json: 42 });

            const mulObs = res.observations.find(o => o.instanceId === 'mul_inst');
            expect(mulObs?.status).toBe('executed');

            // Immutable build directory created under .slate/build/<runId>/
            const buildRoot = path.join(tmpDir, '.slate', 'build');
            expect(fs.existsSync(buildRoot)).toBe(true);
            const runs = fs.readdirSync(buildRoot);
            expect(runs.length).toBeGreaterThan(0);
            expect(runs[0]).toBe(res.runId);
        });

        it('stops execution cleanly and kills process tree when AbortSignal triggers', async () => {
            const infiniteNode: SlateNode = {
                name: 'infinite_loop',
                intent: 'Infinite loop to test stop',
                contract: '-> None',
                context: [],
                examples: [],
                locked: true,
                imports: ['import time'],
                uses: [],
                code: [
                    'def infinite_loop() -> None:',
                    '    while True:',
                    '        time.sleep(0.05)',
                ],
                extra: {},
            };

            const loopFlow: SlateFlow = {
                name: 'loop_flow',
                inputs: [],
                outputs: [],
                instances: [{ id: 'loop_inst', node: 'infinite_loop' }],
                wires: [],
                extra: {},
            };

            const abortController = new AbortController();
            setTimeout(() => abortController.abort(), 200);

            const res = await runFlow({
                workspaceRoot: tmpDir,
                flowId: 'loop_flow',
                documents: new Map([['infinite_loop', infiniteNode]]),
                flows: new Map([['loop_flow', loopFlow]]),
                config,
                isTrusted: true,
                timeoutMs: 10000,
                signal: abortController.signal,
            });

            expect(res.status).toBe('stopped');
            expect(res.error).toContain('Execution was stopped');
        });
    });
});
