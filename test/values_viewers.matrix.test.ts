import { describe, expect, it } from 'vitest';
import { compilePython } from '../vscode-extension/src/compile/python';
import {
    compileValueToPython,
    connect,
    emptyFlow,
    inferValueType,
    parseFlow,
    parseValueLiteral,
    serializeFlow,
} from '../vscode-extension/src/flow';
import { runFlow } from '../vscode-extension/src/flow_runner';
import type { FlowInstance, SlateFlow } from '../vscode-extension/src/harness_protocol';
import type { SlateConfig } from '../vscode-extension/src/slate_folder';

describe('inferValueType and parseValueLiteral matrix', () => {
    it.each([
        ['42', 'number'],
        ['-3.14', 'number'],
        ['1e5', 'number'],
        [100, 'number'],
        ['true', 'boolean'],
        ['false', 'boolean'],
        ['True', 'boolean'],
        ['False', 'boolean'],
        [true, 'boolean'],
        [false, 'boolean'],
        ['null', 'null'],
        ['None', 'null'],
        [null, 'null'],
        ['"hello"', 'string'],
        ["'world'", 'string'],
        ['simple text', 'string'],
        ['[1, 2, 3]', 'json'],
        ['{"key": "val"}', 'json'],
        [[1, 2], 'json'],
        [{ a: 1 }, 'json'],
        ['1 + 2', 'expr'],
        ['math.sin(x)', 'expr'],
        [{ expr: 'x * 2' }, 'expr'],
    ])('infers type correctly for %j -> %s', (input, expectedType) => {
        expect(inferValueType(input)).toBe(expectedType);
    });

    it.each([
        ['42', { type: 'number', value: 42, text: '42' }],
        ['true', { type: 'boolean', value: true, text: 'true' }],
        ['True', { type: 'boolean', value: true, text: 'true' }],
        ['null', { type: 'null', value: null, text: 'null' }],
        ['None', { type: 'null', value: null, text: 'null' }],
        ['"my string"', { type: 'string', value: 'my string', text: '"my string"' }],
        ["'single quoted'", { type: 'string', value: 'single quoted', text: "'single quoted'" }],
        ['[1, 2]', { type: 'json', value: [1, 2], text: '[1, 2]' }],
        ['1 + 2', { type: 'expr', value: { expr: '1 + 2' }, text: '1 + 2' }],
    ])('parses literal %j to expected structured value', (raw, expected) => {
        const res = parseValueLiteral(raw);
        expect(res.type).toBe(expected.type);
        expect(res.value).toEqual(expected.value);
    });

    it('flags JSON syntax errors in parseValueLiteral', () => {
        const res = parseValueLiteral('[1, 2,');
        expect(res.type).toBe('json');
        expect(res.error).toBeDefined();
    });
});

describe('compileValueToPython matrix', () => {
    it.each([
        [42, '42'],
        [-7.5, '-7.5'],
        ['42', '42'],
        ['3.14159', '3.14159'],
        [true, 'True'],
        [false, 'False'],
        ['true', 'True'],
        ['false', 'False'],
        ['True', 'True'],
        ['False', 'False'],
        [null, 'None'],
        ['null', 'None'],
        ['None', 'None'],
        ['hello', '"hello"'],
        ['"already quoted"', '"already quoted"'],
        ["'single quoted'", '"single quoted"'],
        ['[1, 2, 3]', '[1, 2, 3]'],
        [[1, true, null], '[1, True, None]'],
        [{ a: 1, b: false }, '{"a": 1, "b": False}'],
        ['1 + 2', '1 + 2'],
        ['math.sqrt(16)', 'math.sqrt(16)'],
        [{ expr: 'math.pi' }, 'math.pi'],
    ])('compiles value %j to python code %j', (input, expectedPython) => {
        expect(compileValueToPython(input)).toBe(expectedPython);
    });
});

describe('Flow parsing, viewers, and round-trip', () => {
    it('parses and preserves viewer instances with pinned status', () => {
        const flowText = JSON.stringify({
            slate: 3,
            name: 'view_flow',
            inputs: [{ name: 'x', annotation: 'int' }],
            outputs: [],
            instances: [
                { id: 'v1', kind: 'value', value: 42 },
                { id: 'view1', kind: 'viewer', pinned: true },
            ],
            wires: [
                { from: 'v1.out', to: 'view1.in' },
            ],
        });

        const flow = parseFlow(flowText);
        expect(flow.instances).toEqual([
            { id: 'v1', kind: 'value', value: '42' },
            { id: 'view1', kind: 'viewer', pinned: true },
        ]);

        const serialized = serializeFlow(flow);
        const reparsed = parseFlow(serialized);
        expect(reparsed).toEqual(flow);
    });

    it('compiles flow with viewer cleanly in untraced and traced modes', () => {
        const config: SlateConfig = {
            slate: 3,
            name: 'viewer_proj',
            language: 'python',
        };

        const flow: SlateFlow = {
            ...emptyFlow('main'),
            instances: [
                { id: 'val', kind: 'value', value: '10' },
                { id: 'view_node', kind: 'viewer' },
            ],
            wires: [
                { from: 'val.out', to: 'view_node.in' },
            ],
        };

        // Untraced compilation
        const untracedRes = compilePython(new Map(), config, new Map([['main', flow]]));
        expect(untracedRes.diagnostics).toEqual([]);
        const mainPy = untracedRes.files.get('viewer_proj.py')!;
        expect(mainPy).toContain('val = 10');
        // Untraced viewer does not inject runtime calls
        expect(mainPy).not.toContain('_slate_trace');

        // Traced compilation
        const tracedRes = compilePython(new Map(), config, new Map([['main', flow]]), new Map(), { trace: true });
        expect(tracedRes.diagnostics).toEqual([]);
        const tracedPy = tracedRes.files.get('viewer_proj.py')!;
        expect(tracedPy).toContain('with _slate_trace.scope("val"):');
        expect(tracedPy).toContain('with _slate_trace.scope("view_node"):');
        expect(tracedPy).toContain('_slate_trace.trace_input("view_node", "in", v_val)');
    });
});

describe('Live runner with viewer instances', () => {
    it('executes flow and captures live observed input on viewer', async () => {
        const config: SlateConfig = {
            slate: 3,
            name: 'live_viewer_test',
            language: 'python',
        };

        const flow: SlateFlow = {
            ...emptyFlow('main'),
            instances: [
                { id: 'const_val', kind: 'value', value: '99' },
                { id: 'my_viewer', kind: 'viewer' },
            ],
            wires: [
                { from: 'const_val.out', to: 'my_viewer.in' },
            ],
        };

        const snapshot = await runFlow({
            workspaceRoot: process.cwd(),
            config,
            documents: new Map(),
            flows: new Map([['main', flow]]),
            flowId: 'main',
            isTrusted: true,
            timeoutMs: 8000,
        });

        expect(snapshot.status).toBe('completed');
        const valObs = snapshot.observations.find(obs => obs.instanceId === 'const_val');
        expect(valObs?.status).toBe('executed');
        expect(valObs?.outputs?.out?.repr).toBe('99');

        const viewerObs = snapshot.observations.find(obs => obs.instanceId === 'my_viewer');
        expect(viewerObs).toBeDefined();
        expect(viewerObs?.status).toBe('executed');
        expect(viewerObs?.inputs?.in?.repr).toBe('99');
        expect(viewerObs?.inputs?.in?.type).toBe('int');
    });

    it('marks viewer as not_executed when upstream node fails', async () => {
        const config: SlateConfig = {
            slate: 3,
            name: 'fail_viewer_test',
            language: 'python',
        };

        const failNode = {
            slate: 3,
            name: 'exploder',
            language: 'python',
            code: [
                'def exploder() -> int:',
                '    raise RuntimeError("BOOM")',
            ],
            intent: 'Throws an exception',
            contract: 'Always raises',
            context: [],
            imports: [],
            uses: [],
            extra: {},
        };

        const flow: SlateFlow = {
            ...emptyFlow('main'),
            instances: [
                { id: 'step_boom', node: 'exploder' },
                { id: 'downstream_viewer', kind: 'viewer' },
            ],
            wires: [
                { from: 'step_boom.out', to: 'downstream_viewer.in' },
            ],
        };

        const snapshot = await runFlow({
            workspaceRoot: process.cwd(),
            config,
            documents: new Map([['exploder', failNode as any]]),
            flows: new Map([['main', flow]]),
            flowId: 'main',
            isTrusted: true,
            timeoutMs: 8000,
        });

        expect(snapshot.status).toBe('failed');
        const boomObs = snapshot.observations.find(obs => obs.instanceId === 'step_boom');
        expect(boomObs?.status).toBe('failed');
        expect(boomObs?.error).toContain('RuntimeError: BOOM');

        const viewerObs = snapshot.observations.find(obs => obs.instanceId === 'downstream_viewer');
        expect(viewerObs?.status).toBe('not_executed');
        expect(viewerObs?.inputs?.in).toBeUndefined();
    });
});
