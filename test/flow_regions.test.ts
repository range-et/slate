import { describe, expect, it } from 'vitest';
import {
    FlowFormatError,
    addRegion,
    emptyFlow,
    groupIntoRegion,
    parseFlow,
    regionPorts,
    removeRegion,
    serializeFlow,
    type Port,
} from '../vscode-extension/src/flow';
import type {
    FlowBranchRegion,
    FlowForeachRegion,
    FlowInstance,
    FlowRepeatRegion,
    SlateFlow,
} from '../vscode-extension/src/harness_protocol';

describe('flow regions schema and validation (S-800 Slice 1)', () => {
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
            { from: 'input:xs', to: 'loop_region.in:x' },
            { from: 'loop_region.out', to: 'post.in:val' },
            { from: 'pre.out', to: 'post.in:trigger' },
        ]));
    });
});
