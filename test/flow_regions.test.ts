import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Ajv from 'ajv';
import flowSchema from '../contracts/slate-flow.schema.json';
import { describe, expect, it } from 'vitest';
import {
    FlowFormatError,
    addRegion,
    emptyFlow,
    flowSignature,
    groupIntoRegion,
    parseFlow,
    regionPorts,
    removeRegion,
    repairRegionCallerPorts,
    renameFlowPort,
    deleteFlowPort,
    serializeFlow,
    type Port,
} from '../vscode-extension/src/flow';
import { compilePython, flowToNode } from '../vscode-extension/src/compile/python';
import { runFlow } from '../vscode-extension/src/flow_runner';
import { buildGraph } from '../src/harness/graph';
import type {
    FlowBranchRegion,
    FlowForeachRegion,
    FlowInstance,
    FlowRepeatRegion,
    HarnessSnapshot,
    SlateFlow,
} from '../vscode-extension/src/harness_protocol';
import type { SlateConfig, SlateNode } from '../vscode-extension/src/slate_folder';

describe('flow regions schema and validation (S-800 Slice 1)', () => {
    it('enforces the same required region fields as the flow loader', () => {
        const validate = new Ajv().compile(flowSchema);
        for (const region of [
            { id: 'r', kind: 'branch' },
            { id: 'r', kind: 'branch', thenFlow: '' },
            { id: 'r', kind: 'foreach' },
            { id: 'r', kind: 'repeat', bodyFlow: 'child' },
            { id: 'r', kind: 'repeat', bodyFlow: 'child', maxIterations: 0 },
        ]) {
            const flow = { slate: 3, name: 'sample', regions: [region] };
            expect(validate(flow), JSON.stringify(region)).toBe(false);
            expect(() => parseFlow(JSON.stringify(flow))).toThrow(FlowFormatError);
        }
        const valid = { slate: 3, name: 'sample', regions: [
            { id: 'b', kind: 'branch', thenFlow: 'child' },
            { id: 'f', kind: 'foreach', bodyFlow: 'child' },
            { id: 'r', kind: 'repeat', bodyFlow: 'child', maxIterations: 1 },
        ] };
        expect(validate(valid)).toBe(true);
        expect(parseFlow(JSON.stringify(valid)).regions).toHaveLength(3);
    });

    it('repairs region role names and removes only wires to the deleted child port', () => {
        const child = { ...emptyFlow('body'), inputs: [{ name: 'item', annotation: 'int' }, { name: 'offset', annotation: 'int' }],
            outputs: [{ name: 'result', annotation: 'int' }, { name: 'debug', annotation: 'int' }] };
        const caller: SlateFlow = { ...emptyFlow('parent'), regions: [{ id: 'loop', kind: 'foreach', bodyFlow: 'body' }],
            wires: [{ from: 'input:values', to: 'loop.in:items' }, { from: 'input:bias', to: 'loop.in:offset' },
                { from: 'loop.out:result', to: 'output:result' }, { from: 'loop.out:debug', to: 'output:debug' }] };
        const renamed = renameFlowPort(child, 'input', 'item', 'value');
        const fixed = repairRegionCallerPorts(caller, 'body', child, renamed, () => undefined, 'input', 'item', 'value');
        expect(fixed.regions?.[0]).toMatchObject({ itemPort: 'value' });
        expect(fixed.wires).toEqual(caller.wires);
        const deleted = deleteFlowPort(renamed, 'output', 'debug');
        const final = repairRegionCallerPorts(fixed, 'body', renamed, deleted, () => undefined, 'output', 'debug');
        expect(final.wires).toEqual([...caller.wires.slice(0, 2), { from: 'loop.out', to: 'output:result' }]);
    });
    it('parses and round-trips branch, foreach, and repeat regions', () => {
        const flowData: SlateFlow = {
            name: 'pipeline',
            inputs: [{ name: 'val', annotation: 'int' }],
            outputs: [{ name: 'out', annotation: 'int' }],
            instances: [
                { id: 'start', node: 'math/double' },
            ],
            wires: [
                { from: 'input:val', to: 'start.in:x' },
                { from: 'start.out', to: 'branch_1.in:val' },
                { from: 'branch_1.out', to: 'output:out' },
            ],
            regions: [
                {
                    id: 'branch_1',
                    kind: 'branch',
                    label: 'Check Sign',
                    thenFlow: 'pos_flow',
                    elseFlow: 'neg_flow',
                    conditionPort: 'is_pos',
                },
                {
                    id: 'foreach_1',
                    kind: 'foreach',
                    label: 'Batch Transform',
                    bodyFlow: 'process_item',
                    collectionPort: 'records',
                    itemPort: 'elem',
                    indexPort: 'idx',
                    maxIterations: 50,
                },
                {
                    id: 'repeat_1',
                    kind: 'repeat',
                    label: 'Iterate Convergence',
                    bodyFlow: 'step_flow',
                    maxIterations: 100,
                    statePorts: ['current_val', 'loss'],
                    conditionPort: 'continue_loop',
                },
            ],
            extra: { meta: 'test' },
        };

        const serialized = serializeFlow(flowData);
        const parsed = parseFlow(serialized);

        expect(parsed.name).toBe('pipeline');
        expect(parsed.regions).toHaveLength(3);
        expect(parsed.regions![0]).toEqual({
            id: 'branch_1',
            kind: 'branch',
            label: 'Check Sign',
            thenFlow: 'pos_flow',
            elseFlow: 'neg_flow',
            conditionPort: 'is_pos',
        });
        expect(parsed.regions![1]).toEqual({
            id: 'foreach_1',
            kind: 'foreach',
            label: 'Batch Transform',
            bodyFlow: 'process_item',
            collectionPort: 'records',
            itemPort: 'elem',
            indexPort: 'idx',
            maxIterations: 50,
        });
        expect(parsed.regions![2]).toEqual({
            id: 'repeat_1',
            kind: 'repeat',
            label: 'Iterate Convergence',
            bodyFlow: 'step_flow',
            maxIterations: 100,
            statePorts: ['current_val', 'loss'],
            conditionPort: 'continue_loop',
        });

        // Round-trip equivalence
        expect(parseFlow(serializeFlow(parsed))).toEqual(parsed);
    });

    it('rejects invalid regions array or region IDs', () => {
        expect(() => parseFlow(JSON.stringify({ slate: 3, name: 'f', regions: 'not-a-list' }))).toThrow(
            /regions must be a list/,
        );
        expect(() =>
            parseFlow(JSON.stringify({ slate: 3, name: 'f', regions: [{ id: 'bad.dot', kind: 'branch', thenFlow: 'a' }] })),
        ).toThrow(/regions need an id without dots/);
        expect(() =>
            parseFlow(JSON.stringify({ slate: 3, name: 'f', regions: [{ id: '', kind: 'branch', thenFlow: 'a' }] })),
        ).toThrow(/regions need an id without dots/);
        expect(() =>
            parseFlow(JSON.stringify({ slate: 3, name: 'f', regions: [{ id: 'r1', kind: 'unknown' }] })),
        ).toThrow(/kind must be branch, foreach, or repeat/);
        expect(() =>
            parseFlow(
                JSON.stringify({
                    slate: 3,
                    name: 'f',
                    regions: [
                        { id: 'r1', kind: 'branch', thenFlow: 'a' },
                        { id: 'r1', kind: 'branch', thenFlow: 'b' },
                    ],
                }),
            ),
        ).toThrow(/region ids must be unique/);
        expect(() =>
            parseFlow(
                JSON.stringify({
                    slate: 3,
                    name: 'f',
                    instances: [{ id: 'node_1', node: 'x' }],
                    regions: [{ id: 'node_1', kind: 'branch', thenFlow: 'a' }],
                }),
            ),
        ).toThrow(/collides with an instance id/);
    });

    it('validates branch region parameters', () => {
        expect(() =>
            parseFlow(JSON.stringify({ slate: 3, name: 'f', regions: [{ id: 'b', kind: 'branch' }] })),
        ).toThrow(/needs a thenFlow/);
        expect(() =>
            parseFlow(JSON.stringify({ slate: 3, name: 'f', regions: [{ id: 'b', kind: 'branch', thenFlow: 'a', elseFlow: '' }] })),
        ).toThrow(/elseFlow must be a non-empty string/);
        expect(() =>
            parseFlow(JSON.stringify({ slate: 3, name: 'f', regions: [{ id: 'b', kind: 'branch', thenFlow: 'a', conditionPort: '123bad' }] })),
        ).toThrow(/conditionPort must be an identifier/);
    });

    it('validates foreach region parameters', () => {
        expect(() =>
            parseFlow(JSON.stringify({ slate: 3, name: 'f', regions: [{ id: 'fe', kind: 'foreach' }] })),
        ).toThrow(/needs a bodyFlow/);
        expect(() =>
            parseFlow(JSON.stringify({ slate: 3, name: 'f', regions: [{ id: 'fe', kind: 'foreach', bodyFlow: 'a', collectionPort: 'bad-port' }] })),
        ).toThrow(/collectionPort must be an identifier/);
        expect(() =>
            parseFlow(JSON.stringify({ slate: 3, name: 'f', regions: [{ id: 'fe', kind: 'foreach', bodyFlow: 'a', maxIterations: -5 }] })),
        ).toThrow(/maxIterations must be a positive integer/);
        expect(() =>
            parseFlow(JSON.stringify({ slate: 3, name: 'f', regions: [{ id: 'fe', kind: 'foreach', bodyFlow: 'a', maxIterations: 1.5 }] })),
        ).toThrow(/maxIterations must be a positive integer/);
    });

    it('validates repeat region parameters', () => {
        expect(() =>
            parseFlow(JSON.stringify({ slate: 3, name: 'f', regions: [{ id: 'rp', kind: 'repeat' }] })),
        ).toThrow(/needs a bodyFlow/);
        expect(() =>
            parseFlow(JSON.stringify({ slate: 3, name: 'f', regions: [{ id: 'rp', kind: 'repeat', bodyFlow: 'a' }] })),
        ).toThrow(/needs a positive integer maxIterations/);
        expect(() =>
            parseFlow(JSON.stringify({ slate: 3, name: 'f', regions: [{ id: 'rp', kind: 'repeat', bodyFlow: 'a', maxIterations: 0 }] })),
        ).toThrow(/needs a positive integer maxIterations/);
        expect(() =>
            parseFlow(JSON.stringify({ slate: 3, name: 'f', regions: [{ id: 'rp', kind: 'repeat', bodyFlow: 'a', maxIterations: 10, statePorts: ['good', 'bad-id'] }] })),
        ).toThrow(/statePorts must be a list of identifiers/);
    });
});

describe('region boundary ports extraction (regionPorts)', () => {
    const childFlows = new Map<string, SlateFlow>([
        ['pos_flow', {
            name: 'pos_flow',
            inputs: [{ name: 'x', annotation: 'int' }, { name: 'scale', annotation: 'float' }],
            outputs: [{ name: 'result', annotation: 'float' }],
            instances: [],
            wires: [],
            extra: {},
        }],
        ['neg_flow', {
            name: 'neg_flow',
            inputs: [{ name: 'x', annotation: 'int' }, { name: 'offset', annotation: 'int' }],
            outputs: [{ name: 'result', annotation: 'float' }],
            instances: [],
            wires: [],
            extra: {},
        }],
        ['item_transform', {
            name: 'item_transform',
            inputs: [
                { name: 'item', annotation: 'str' },
                { name: 'index', annotation: 'int' },
                { name: 'prefix', annotation: 'str' },
            ],
            outputs: [
                { name: 'label', annotation: 'str' },
                { name: 'score', annotation: 'float' },
            ],
            instances: [],
            wires: [],
            extra: {},
        }],
        ['single_item_flow', {
            name: 'single_item_flow',
            inputs: [{ name: 'item', annotation: 'int' }],
            outputs: [{ name: 'doubled', annotation: 'int' }],
            instances: [],
            wires: [],
            extra: {},
        }],
        ['converge_flow', {
            name: 'converge_flow',
            inputs: [
                { name: 'state', annotation: 'float' },
                { name: 'learning_rate', annotation: 'float' },
            ],
            outputs: [
                { name: 'state', annotation: 'float' },
            ],
            instances: [],
            wires: [],
            extra: {},
        }],
    ]);

    const lookup = (id: string) => childFlows.get(id);

    it('extracts branch region ports with condition and merged child inputs', () => {
        const branchRegion: FlowBranchRegion = {
            id: 'br',
            kind: 'branch',
            thenFlow: 'pos_flow',
            elseFlow: 'neg_flow',
        };
        const ports = regionPorts(branchRegion, lookup);

        expect(ports.inputs).toEqual([
            { id: 'in:condition', name: 'condition', annotation: 'bool', optional: false },
            { id: 'in:x', name: 'x', annotation: 'int', optional: false },
            { id: 'in:scale', name: 'scale', annotation: 'float', optional: false },
            { id: 'in:offset', name: 'offset', annotation: 'int', optional: true },
        ]);
        expect(ports.outputs).toEqual([
            { id: 'out', name: 'result', annotation: 'float' },
        ]);
    });

    it('throws when branch child flows are missing', () => {
        const missingThen: FlowBranchRegion = { id: 'br', kind: 'branch', thenFlow: 'nonexistent' };
        expect(() => regionPorts(missingThen, lookup)).toThrow(/referenced thenFlow 'nonexistent' not found/);

        const missingElse: FlowBranchRegion = { id: 'br', kind: 'branch', thenFlow: 'pos_flow', elseFlow: 'nonexistent' };
        expect(() => regionPorts(missingElse, lookup)).toThrow(/referenced elseFlow 'nonexistent' not found/);
    });

    it('extracts foreach region ports wrapping outputs and items in list types', () => {
        const foreachRegion: FlowForeachRegion = {
            id: 'fe',
            kind: 'foreach',
            bodyFlow: 'item_transform',
            collectionPort: 'entries',
            itemPort: 'item',
            indexPort: 'index',
        };
        const ports = regionPorts(foreachRegion, lookup);

        expect(ports.inputs).toEqual([
            { id: 'in:entries', name: 'entries', annotation: 'List[str]', optional: false },
            { id: 'in:prefix', name: 'prefix', annotation: 'str', optional: false },
        ]);
        expect(ports.outputs).toEqual([
            { id: 'out:label', name: 'label', annotation: 'List[str]' },
            { id: 'out:score', name: 'score', annotation: 'List[float]' },
        ]);

        // Single output child flow gets 'out' port
        const singleFe: FlowForeachRegion = {
            id: 'single_fe',
            kind: 'foreach',
            bodyFlow: 'single_item_flow',
        };
        const singlePorts = regionPorts(singleFe, lookup);
        expect(singlePorts.inputs).toEqual([
            { id: 'in:items', name: 'items', annotation: 'List[int]', optional: false },
        ]);
        expect(singlePorts.outputs).toEqual([
            { id: 'out', name: 'doubled', annotation: 'List[int]' },
        ]);
    });

    it('extracts repeat region ports with state carrying and finite bound', () => {
        const repeatRegion: FlowRepeatRegion = {
            id: 'rp',
            kind: 'repeat',
            bodyFlow: 'converge_flow',
            maxIterations: 100,
        };
        const ports = regionPorts(repeatRegion, lookup);

        expect(ports.inputs).toEqual([
            { id: 'in:state', name: 'state', annotation: 'float', optional: false },
            { id: 'in:learning_rate', name: 'learning_rate', annotation: 'float', optional: false },
        ]);
        expect(ports.outputs).toEqual([
            { id: 'out', name: 'state', annotation: 'float' },
        ]);
    });
});

describe('region flow manipulation (add, remove, groupIntoRegion)', () => {
    it('adds and removes regions and unplugs boundary wires', () => {
        let f = emptyFlow('calc');
        const region: FlowBranchRegion = {
            id: 'branch_cond',
            kind: 'branch',
            thenFlow: 'then_sub',
        };
        f = addRegion(f, region);
        expect(f.regions).toHaveLength(1);

        // Attempting to add with existing ID fails
        expect(() => addRegion(f, region)).toThrow(/already exists/);

        // Add wires connecting into and out of the region
        f = {
            ...f,
            instances: [{ id: 'src', node: 'num' }, { id: 'dst', node: 'print' }],
            wires: [
                { from: 'src.out', to: 'branch_cond.in:condition' },
                { from: 'branch_cond.out', to: 'dst.in:val' },
                { from: 'src.out', to: 'dst.in:other' }, // unrelated wire
            ],
        };

        // Remove region
        f = removeRegion(f, 'branch_cond');
        expect(f.regions).toHaveLength(0);
        // Only unrelated wire survives
        expect(f.wires).toEqual([{ from: 'src.out', to: 'dst.in:other' }]);
    });

    it('groups instances into a foreach region', () => {
        const parent = {
            name: 'main',
            inputs: [{ name: 'xs', annotation: 'List[int]' }],
            outputs: [{ name: 'results', annotation: 'List[int]' }],
            instances: [
                { id: 'pre', node: 'start' },
                { id: 'target_op', node: 'double' },
                { id: 'post', node: 'end' },
            ],
            wires: [
                { from: 'input:xs', to: 'target_op.in:x' },
                { from: 'target_op.out', to: 'post.in:val' },
                { from: 'pre.out', to: 'post.in:trigger' },
            ],
            extra: {},
        };

        const portsOf = (inst: FlowInstance): { inputs: Port[]; outputs: Port[] } => ({
            inputs: [{ id: 'in:x', name: 'x', annotation: 'int' }],
            outputs: [{ id: 'out', name: 'out', annotation: 'int' }],
        });

        const { parent: updatedParent, child } = groupIntoRegion(
            parent,
            ['target_op'],
            {
                regionId: 'loop_region',
                childId: 'child_flow',
                childName: 'child_flow',
                region: {
                    kind: 'foreach',
                    collectionPort: 'items',
                    itemPort: 'x',
                    maxIterations: 500,
                },
            },
            portsOf,
        );

        expect(child.instances.map(i => i.id)).toEqual(['target_op']);
        expect(updatedParent.instances.map(i => i.id)).toEqual(['pre', 'post']);
        expect(updatedParent.regions).toHaveLength(1);
        expect(updatedParent.regions![0]).toEqual({
            id: 'loop_region',
            kind: 'foreach',
            bodyFlow: 'child_flow',
            collectionPort: 'items',
            itemPort: 'x',
            maxIterations: 500,
        });

        // Wires routed to the new region
        expect(updatedParent.wires).toEqual(expect.arrayContaining([
            { from: 'input:xs', to: 'loop_region.in:items' },
            { from: 'loop_region.out', to: 'post.in:val' },
            { from: 'pre.out', to: 'post.in:trigger' },
        ]));
    });
});

function makeNode(name: string, code: string[]): SlateNode {
    return {
        name,
        intent: `Node ${name}`,
        contract: '',
        context: [],
        examples: [],
        locked: false,
        order: 0,
        imports: [],
        uses: [],
        code,
        extra: {},
    };
}

const DEFAULT_CONFIG: SlateConfig = {
    name: 'region_test_proj',
    language: 'python',
    target: 'dist',
    library: [],
    extra: {},
};

describe('deterministic Python compilation and execution of regions (S-800)', () => {
    it('returns named branch results even when else declares them in reverse order', async () => {
        const outputs = [{ name: 'first', annotation: 'int' }, { name: 'second', annotation: 'int' }];
        const makeBranch = (name: string, reverse: boolean): SlateFlow => ({
            ...emptyFlow(name), outputs: reverse ? [...outputs].reverse() : outputs,
            instances: [{ id: 'one', kind: 'value', value: 1 }, { id: 'two', kind: 'value', value: 2 }],
            wires: [{ from: 'one.out', to: 'output:first' }, { from: 'two.out', to: 'output:second' }],
        });
        const main: SlateFlow = {
            ...emptyFlow('main'), outputs, inputs: [{ name: 'flag', annotation: 'bool' }],
            regions: [{ id: 'pick', kind: 'branch', thenFlow: 'left', elseFlow: 'right' }],
            wires: [{ from: 'input:flag', to: 'pick.in:condition' },
                ...outputs.map(port => ({ from: 'pick.out:' + port.name, to: 'output:' + port.name }))],
        };
        const flows = new Map([['main', main], ['left', makeBranch('left', false)], ['right', makeBranch('right', true)]]);
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-branch-output-'));
        try {
            const result = await runFlow({ workspaceRoot: tmp, flowId: 'main', documents: new Map(), flows,
                config: DEFAULT_CONFIG, inputs: { flag: false }, isTrusted: true });
            expect(result.status, result.error).toBe('completed');
            expect(result.flowOutputs?.first.json).toBe(1);
            expect(result.flowOutputs?.second.json).toBe(2);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
        const right = flows.get('right')!;
        flows.set('right', { ...right, outputs: [outputs[0]], wires: [right.wires[0]] });
        expect(compilePython(new Map(), DEFAULT_CONFIG, flows).diagnostics).toContainEqual({
            severity: 'error', message: 'flows/main: pick branches must expose compatible outputs by name.',
        });
    });
    it('compiles branch region to if/else and only executes the selected branch', async () => {
        const nodes = new Map<string, SlateNode>([
            ['safe_double', makeNode('safe_double', ['def safe_double(x: int) -> int:', '    return x * 2'])],
            ['explode_branch', makeNode('explode_branch', ['def explode_branch(x: int) -> int:', '    raise RuntimeError("unselected branch must not execute")'])],
            ['add_ten', makeNode('add_ten', ['def add_ten(x: int) -> int:', '    return x + 10'])],
        ]);

        const thenFlow: SlateFlow = {
            name: 'then_flow',
            inputs: [{ name: 'x', annotation: 'int' }],
            outputs: [{ name: 'result', annotation: 'int' }],
            instances: [{ id: 'dbl', node: 'safe_double' }],
            wires: [
                { from: 'input:x', to: 'dbl.in:x' },
                { from: 'dbl.out', to: 'output:result' },
            ],
            extra: {},
        };

        const elseFlow: SlateFlow = {
            name: 'else_flow',
            inputs: [{ name: 'x', annotation: 'int' }],
            outputs: [{ name: 'result', annotation: 'int' }],
            instances: [{ id: 'boom', node: 'explode_branch' }],
            wires: [
                { from: 'input:x', to: 'boom.in:x' },
                { from: 'boom.out', to: 'output:result' },
            ],
            extra: {},
        };

        const mainFlow: SlateFlow = {
            name: 'main',
            inputs: [
                { name: 'flag', annotation: 'bool' },
                { name: 'val', annotation: 'int' },
            ],
            outputs: [{ name: 'final', annotation: 'int' }],
            instances: [{ id: 'post', node: 'add_ten' }],
            regions: [
                {
                    id: 'br_1',
                    kind: 'branch',
                    thenFlow: 'then_flow',
                    elseFlow: 'else_flow',
                    conditionPort: 'cond',
                },
            ],
            wires: [
                { from: 'input:flag', to: 'br_1.in:cond' },
                { from: 'input:val', to: 'br_1.in:x' },
                { from: 'br_1.out', to: 'post.in:x' },
                { from: 'post.out', to: 'output:final' },
            ],
            extra: {},
        };

        const flows = new Map<string, SlateFlow>([
            ['then_flow', thenFlow],
            ['else_flow', elseFlow],
            ['main', mainFlow],
        ]);

        const compiled = compilePython(nodes, DEFAULT_CONFIG, flows);
        expect(compiled.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
        const pyCode = compiled.files.get('region_test_proj.py')!;
        expect(pyCode).toContain('if flag:');
        expect(pyCode).toContain('v_br_1 = then_flow(x=val)');
        expect(pyCode).toContain('else:');
        expect(pyCode).toContain('v_br_1 = else_flow(x=val)');

        // Execute with flag=True: else_flow raises RuntimeError if called, proving only then_flow runs!
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-branch-test-'));
        try {
            const snap = await runFlow({
                workspaceRoot: tmpDir,
                flowId: 'main',
                documents: nodes,
                flows,
                config: DEFAULT_CONFIG,
                inputs: { flag: true, val: 21 },
                isTrusted: true,
            });

            expect(snap.status).toBe('completed');
            expect(snap.flowOutputs?.final?.json).toBe(52); // (21 * 2) + 10

            const regionObs = snap.observations.find(o => o.instanceId === 'br_1');
            expect(regionObs?.status).toBe('executed');
            expect(regionObs?.outputs.out?.json).toBe(42);

            const thenChildObs = snap.observations.find(o => o.instanceId === 'dbl');
            expect(thenChildObs?.status).toBe('executed');
            expect(thenChildObs?.path).toEqual(['br_1', 'then']);

            const elseChildObs = snap.observations.find(o => o.instanceId === 'boom');
            expect(elseChildObs?.status).toBe('not_executed');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('defaults branch region output to None when elseFlow is omitted and condition is false', async () => {
        const nodes = new Map<string, SlateNode>([
            ['inc', makeNode('inc', ['def inc(x: int) -> int:', '    return x + 1'])],
        ]);
        const thenFlow: SlateFlow = {
            name: 'then_only',
            inputs: [{ name: 'x', annotation: 'int' }],
            outputs: [{ name: 'out', annotation: 'int' }],
            instances: [{ id: 'step', node: 'inc' }],
            wires: [
                { from: 'input:x', to: 'step.in:x' },
                { from: 'step.out', to: 'output:out' },
            ],
            extra: {},
        };
        const mainFlow: SlateFlow = {
            name: 'main',
            inputs: [
                { name: 'cond', annotation: 'bool' },
                { name: 'x', annotation: 'int' },
            ],
            outputs: [{ name: 'res', annotation: 'int | None' }],
            instances: [],
            regions: [{ id: 'opt_branch', kind: 'branch', thenFlow: 'then_only' }],
            wires: [
                { from: 'input:cond', to: 'opt_branch.in:condition' },
                { from: 'input:x', to: 'opt_branch.in:x' },
                { from: 'opt_branch.out', to: 'output:res' },
            ],
            extra: {},
        };
        const flows = new Map<string, SlateFlow>([
            ['then_only', thenFlow],
            ['main', mainFlow],
        ]);

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-branch-none-'));
        try {
            const snap = await runFlow({
                workspaceRoot: tmpDir,
                flowId: 'main',
                documents: nodes,
                flows,
                config: DEFAULT_CONFIG,
                inputs: { cond: false, x: 10 },
                isTrusted: true,
            });
            expect(snap.status).toBe('completed');
            expect(snap.flowOutputs?.res?.json).toBeNull();
            const stepObs = snap.observations.find(o => o.instanceId === 'step');
            expect(stepObs?.status).toBe('not_executed');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('compiles and executes foreach region with item, index, broadcast inputs, and maxIterations bound', async () => {
        const nodes = new Map<string, SlateNode>([
            [
                'weighted_shift',
                makeNode('weighted_shift', [
                    'def weighted_shift(val: int, idx: int, bias: int) -> int:',
                    '    return val * (idx + 1) + bias',
                ]),
            ],
        ]);

        const bodyFlow: SlateFlow = {
            name: 'item_body',
            inputs: [
                { name: 'elem', annotation: 'int' },
                { name: 'idx', annotation: 'int' },
                { name: 'bias', annotation: 'int' },
            ],
            outputs: [{ name: 'out', annotation: 'int' }],
            instances: [{ id: 'calc', node: 'weighted_shift' }],
            wires: [
                { from: 'input:elem', to: 'calc.in:val' },
                { from: 'input:idx', to: 'calc.in:idx' },
                { from: 'input:bias', to: 'calc.in:bias' },
                { from: 'calc.out', to: 'output:out' },
            ],
            extra: {},
        };

        const mainFlow: SlateFlow = {
            name: 'main',
            inputs: [
                { name: 'nums', annotation: 'list[int]' },
                { name: '_item', annotation: 'int' },
            ],
            outputs: [{ name: 'results', annotation: 'list[int]' }],
            instances: [],
            regions: [
                {
                    id: 'fe_loop',
                    kind: 'foreach',
                    bodyFlow: 'item_body',
                    collectionPort: 'records',
                    itemPort: 'elem',
                    indexPort: 'idx',
                    maxIterations: 3,
                },
            ],
            wires: [
                { from: 'input:nums', to: 'fe_loop.in:records' },
                { from: 'input:_item', to: 'fe_loop.in:bias' },
                { from: 'fe_loop.out', to: 'output:results' },
            ],
            extra: {},
        };

        const flows = new Map<string, SlateFlow>([
            ['item_body', bodyFlow],
            ['main', mainFlow],
        ]);

        const compiled = compilePython(nodes, DEFAULT_CONFIG, flows);
        expect(compiled.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
        const pyCode = compiled.files.get('region_test_proj.py')!;
        expect(pyCode).toContain('for _idx, _item_2 in enumerate(nums):');
        expect(pyCode).toContain('if _idx >= 3:');
        expect(pyCode).toContain('item_body(elem=_item_2, idx=_idx, bias=_item)');

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-foreach-test-'));
        try {
            const snap = await runFlow({
                workspaceRoot: tmpDir,
                flowId: 'main',
                documents: nodes,
                flows,
                config: DEFAULT_CONFIG,
                inputs: { nums: [10, 20, 30, 40, 50], _item: 5 },
                isTrusted: true,
            });

            expect(snap.status).toBe('completed');
            // Bounded to first 3 items:
            // idx 0: 10 * 1 + 5 = 15
            // idx 1: 20 * 2 + 5 = 45
            // idx 2: 30 * 3 + 5 = 95
            expect(snap.flowOutputs?.results?.json).toEqual([15, 45, 95]);

            const iterObs = snap.observations.filter(o => o.instanceId === 'calc');
            expect(iterObs).toHaveLength(3);
            expect(iterObs.map(o => o.path)).toEqual([
                ['fe_loop', 'iter:0'],
                ['fe_loop', 'iter:1'],
                ['fe_loop', 'iter:2'],
            ]);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('compiles and executes repeat region with loop-carried state and early condition termination', async () => {
        const nodes = new Map<string, SlateNode>([
            [
                'step_fn',
                makeNode('step_fn', [
                    'def step_fn(acc: int, step: int) -> int:',
                    '    return acc + step',
                ]),
            ],
            [
                'keep_going',
                makeNode('keep_going', [
                    'def keep_going(acc: int, limit: int) -> bool:',
                    '    return acc < limit',
                ]),
            ],
        ]);

        const bodyFlow: SlateFlow = {
            name: 'repeat_body',
            inputs: [
                { name: 'acc', annotation: 'int' },
                { name: 'step', annotation: 'int' },
                { name: 'limit', annotation: 'int' },
            ],
            outputs: [
                { name: 'acc', annotation: 'int' },
                { name: 'cont', annotation: 'bool' },
            ],
            instances: [
                { id: 'advance', node: 'step_fn' },
                { id: 'check', node: 'keep_going' },
            ],
            wires: [
                { from: 'input:acc', to: 'advance.in:acc' },
                { from: 'input:step', to: 'advance.in:step' },
                { from: 'advance.out', to: 'check.in:acc' },
                { from: 'input:limit', to: 'check.in:limit' },
                { from: 'advance.out', to: 'output:acc' },
                { from: 'check.out', to: 'output:cont' },
            ],
            extra: {},
        };

        const mainFlow: SlateFlow = {
            name: 'main',
            inputs: [
                { name: 'init_acc', annotation: 'int' },
                { name: 'step', annotation: 'int' },
                { name: 'limit', annotation: 'int' },
            ],
            outputs: [{ name: 'final_acc', annotation: 'int' }],
            instances: [],
            regions: [
                {
                    id: 'rep_1',
                    kind: 'repeat',
                    bodyFlow: 'repeat_body',
                    maxIterations: 20,
                    statePorts: ['acc'],
                    conditionPort: 'cont',
                },
            ],
            wires: [
                { from: 'input:init_acc', to: 'rep_1.in:acc' },
                { from: 'input:step', to: 'rep_1.in:step' },
                { from: 'input:limit', to: 'rep_1.in:limit' },
                { from: 'rep_1.out', to: 'output:final_acc' },
            ],
            extra: {},
        };

        const flows = new Map<string, SlateFlow>([
            ['repeat_body', bodyFlow],
            ['main', mainFlow],
        ]);

        const compiled = compilePython(nodes, DEFAULT_CONFIG, flows);
        expect(compiled.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
        const pyCode = compiled.files.get('region_test_proj.py')!;
        expect(pyCode).toContain('for _iter in range(20):');
        expect(pyCode).toContain('if not _cond_rep_1:');
        expect(pyCode).toContain('break');

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-repeat-test-'));
        try {
            // Early break: starts at 0, adds 4 each iter, stops when acc >= 10 (after 3 iterations -> 12)
            const earlySnap = await runFlow({
                workspaceRoot: tmpDir,
                flowId: 'main',
                documents: nodes,
                flows,
                config: DEFAULT_CONFIG,
                inputs: { init_acc: 0, step: 4, limit: 10 },
                isTrusted: true,
            });
            expect(earlySnap.status).toBe('completed');
            expect(earlySnap.flowOutputs?.final_acc?.json).toBe(12);
            const earlyIters = earlySnap.observations.filter(o => o.instanceId === 'advance');
            expect(earlyIters).toHaveLength(3);

            // MaxIterations bound: limit=1000 so cont is always True; stops at maxIterations=20 -> 0 + 20*4 = 80
            const boundSnap = await runFlow({
                workspaceRoot: tmpDir,
                flowId: 'main',
                documents: nodes,
                flows,
                config: DEFAULT_CONFIG,
                inputs: { init_acc: 0, step: 4, limit: 1000 },
                isTrusted: true,
            });
            expect(boundSnap.status).toBe('completed');
            expect(boundSnap.flowOutputs?.final_acc?.json).toBe(80);
            const boundIters = boundSnap.observations.filter(o => o.instanceId === 'advance');
            expect(boundIters).toHaveLength(20);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('buildGraph region rendering (S-800)', () => {
    it('renders region nodes on the flow canvas with boundary ports, badges, child flow labels, and wires', () => {
        const thenFlow: SlateFlow = {
            name: 'pos_flow',
            inputs: [{ name: 'x', annotation: 'int' }],
            outputs: [{ name: 'out', annotation: 'int' }],
            instances: [],
            wires: [],
            extra: {},
        };
        const bodyFlow: SlateFlow = {
            name: 'loop_body',
            inputs: [
                { name: 'item', annotation: 'str' },
                { name: 'prefix', annotation: 'str' },
            ],
            outputs: [{ name: 'formatted', annotation: 'str' }],
            instances: [],
            wires: [],
            extra: {},
        };
        const pipelineFlow: SlateFlow = {
            name: 'pipeline',
            inputs: [
                { name: 'cond', annotation: 'bool' },
                { name: 'val', annotation: 'int' },
                { name: 'words', annotation: 'List[str]' },
                { name: 'tag', annotation: 'str' },
            ],
            outputs: [
                { name: 'num_out', annotation: 'int' },
                { name: 'list_out', annotation: 'List[str]' },
            ],
            instances: [],
            regions: [
                {
                    id: 'br_node',
                    kind: 'branch',
                    label: 'Positive Guard',
                    thenFlow: 'pos_flow',
                },
                {
                    id: 'fe_node',
                    kind: 'foreach',
                    label: 'Format Words',
                    bodyFlow: 'loop_body',
                    maxIterations: 25,
                },
            ],
            wires: [
                { from: 'input:cond', to: 'br_node.in:condition' },
                { from: 'input:val', to: 'br_node.in:x' },
                { from: 'br_node.out', to: 'output:num_out' },
                { from: 'input:words', to: 'fe_node.in:items' },
                { from: 'input:tag', to: 'fe_node.in:prefix' },
                { from: 'fe_node.out', to: 'output:list_out' },
            ],
            extra: {},
        };

        const snapshot: HarnessSnapshot = {
            revision: 1,
            projectName: 'demo',
            documents: [],
            flows: [
                { id: 'pos_flow', flow: thenFlow },
                { id: 'loop_body', flow: bodyFlow },
                { id: 'pipeline', flow: pipelineFlow },
            ],
        };

        const graph = buildGraph(snapshot, { view: 'compose', flow: 'pipeline' });
        const brNode = graph.nodes.find(n => n.id === 'br_node');
        expect(brNode).toBeDefined();
        expect(brNode!.data.kind).toBe('region');
        expect(brNode!.data.regionBadge).toBe('BRANCH');
        expect(brNode!.data.label).toBe('Positive Guard');
        expect(brNode!.data.childFlows).toEqual(['pos_flow']);
        expect(brNode!.data.inputs).toEqual([
            { id: 'in:condition', name: 'condition', annotation: 'bool', optional: false },
            { id: 'in:x', name: 'x', annotation: 'int', optional: false },
        ]);
        expect(brNode!.data.outputs).toEqual([
            { id: 'out', name: 'out', annotation: 'int' },
        ]);

        const feNode = graph.nodes.find(n => n.id === 'fe_node');
        expect(feNode).toBeDefined();
        expect(feNode!.data.kind).toBe('region');
        expect(feNode!.data.regionBadge).toBe('FOREACH');
        expect(feNode!.data.label).toBe('Format Words');
        expect(feNode!.data.childFlows).toEqual(['loop_body']);
        expect(feNode!.data.inputs).toEqual([
            { id: 'in:items', name: 'items', annotation: 'List[str]', optional: false },
            { id: 'in:prefix', name: 'prefix', annotation: 'str', optional: false },
        ]);
        expect(feNode!.data.outputs).toEqual([
            { id: 'out', name: 'formatted', annotation: 'List[str]' },
        ]);

        // All 6 wires connect cleanly without type mismatch
        expect(graph.edges).toHaveLength(6);
        expect(graph.edges.every(e => !(e.data as any)?.mismatch)).toBe(true);
    });
});
