import { describe, expect, it } from 'vitest';
import {
    buildForgePacket,
    buildGenerationPacket,
    FORGE_INPUT_BUDGET_TOKENS,
    getOccurrenceNeighbors,
    PacketError,
} from '../vscode-extension/src/generation';
import { indexNode } from '../vscode-extension/src/slate_folder';
import type { HarnessSnapshot, SlateFlow } from '../vscode-extension/src/harness_protocol';

function makeSnapshotWithFlows(): {
    snapshot: HarnessSnapshot;
    sources: Map<string, string>;
} {
    const clampNode = indexNode(
        'slate/nodes/clamp.json',
        JSON.stringify({
            slate: 3,
            name: 'clamp',
            intent: 'Clamp value between lower and upper bounds',
            contract: 'lower <= value <= upper',
            code: [
                'def clamp(value: int, lower: int, upper: int) -> int:',
                '    return max(lower, min(value, upper))',
            ],
        }),
        'python',
        1,
    );

    const addNode = indexNode(
        'slate/nodes/add.json',
        JSON.stringify({
            slate: 3,
            name: 'add',
            intent: 'Add two integers',
            contract: 'a + b',
            code: [
                'def add(a: int, b: int) -> int:',
                '    return a + b',
            ],
        }),
        'python',
        1,
    );

    const scaleNode = indexNode(
        'slate/nodes/scale.json',
        JSON.stringify({
            slate: 3,
            name: 'scale',
            intent: 'Scale value by factor',
            contract: 'value * factor',
            code: [
                'def scale(value: int, factor: int) -> int:',
                '    return value * factor',
            ],
        }),
        'python',
        1,
    );

    const logNode = indexNode(
        'slate/nodes/log_val.json',
        JSON.stringify({
            slate: 3,
            name: 'log_val',
            intent: 'Log value and return it',
            contract: 'logs value',
            code: [
                'def log_val(value: int) -> int:',
                '    return value',
            ],
        }),
        'python',
        1,
    );

    // Flow 1: 'flow_alpha' has instance1 (clamp), instance2 (add) connected to clamp, and instance3 (scale)
    const flowAlpha: SlateFlow = {
        name: 'flow_alpha',
        inputs: [{ name: 'x', annotation: 'int' }],
        outputs: [{ name: 'out', annotation: 'int' }],
        instances: [
            { id: 'inst_clamp_1', node: 'clamp' },
            { id: 'inst_add_1', node: 'add' },
            { id: 'inst_scale_1', node: 'scale' },
        ],
        wires: [
            { from: 'input:x', to: 'inst_clamp_1.in:value' },
            { from: 'inst_clamp_1.out', to: 'inst_add_1.in:a' },
            { from: 'inst_add_1.out', to: 'output:out' },
            // inst_scale_1 is unconnected to clamp
        ],
        extra: {},
    };

    // Flow 2: 'flow_beta' has another instance of clamp connected to log_val
    const flowBeta: SlateFlow = {
        name: 'flow_beta',
        inputs: [{ name: 'in_b', annotation: 'int' }],
        outputs: [{ name: 'out_b', annotation: 'int' }],
        instances: [
            { id: 'inst_clamp_2', node: 'clamp' },
            { id: 'inst_log_1', node: 'log_val' },
        ],
        wires: [
            { from: 'inst_log_1.out', to: 'inst_clamp_2.in:value' },
            { from: 'inst_clamp_2.out', to: 'output:out_b' },
        ],
        extra: {},
    };

    const snapshot: HarnessSnapshot = {
        revision: 1,
        projectName: 'occurrence_test',
        documents: [
            clampNode.document,
            addNode.document,
            scaleNode.document,
            logNode.document,
        ],
        flows: [
            { id: 'flow_alpha', flow: flowAlpha },
            { id: 'flow_beta', flow: flowBeta },
        ],
    };

    const sources = new Map<string, string>([
        [clampNode.document.path, clampNode.code],
        [addNode.document.path, addNode.code],
        [scaleNode.document.path, scaleNode.code],
        [logNode.document.path, logNode.code],
    ]);

    return { snapshot, sources };
}

describe('Occurrence-aware micro packets matrix (S-700)', () => {
    it('extracts immediate incoming and outgoing occurrence neighbors from specific flow wires', () => {
        const { snapshot } = makeSnapshotWithFlows();

        // In flow_alpha, inst_clamp_1 is wired to inst_add_1 (outgoing) and input:x (ignored)
        const alphaNeighbors = getOccurrenceNeighbors(snapshot, {
            flowId: 'flow_alpha',
            instanceId: 'inst_clamp_1',
        });
        expect(alphaNeighbors).toEqual(['add']);

        // In flow_beta, inst_clamp_2 is wired from inst_log_1 (incoming)
        const betaNeighbors = getOccurrenceNeighbors(snapshot, {
            flowId: 'flow_beta',
            instanceId: 'inst_clamp_2',
        });
        expect(betaNeighbors).toEqual(['log_val']);
    });

    it('never aggregates neighbors across occurrences or flows', () => {
        const { snapshot, sources } = makeSnapshotWithFlows();

        // When building packet for clamp in flow_alpha
        const packetAlpha = buildForgePacket(snapshot, sources, 'clamp', {
            occurrence: { flowId: 'flow_alpha', instanceId: 'inst_clamp_1' },
        });

        expect(packetAlpha.occurrence).toEqual({ flowId: 'flow_alpha', instanceId: 'inst_clamp_1' });
        expect(packetAlpha.fingerprint?.occurrence).toEqual({ flowId: 'flow_alpha', instanceId: 'inst_clamp_1' });
        expect(packetAlpha.neighbors?.map(n => n.id)).toEqual(['add']);
        expect(packetAlpha.prompt).toContain('Dependency: add');
        expect(packetAlpha.prompt).not.toContain('log_val');
        expect(packetAlpha.prompt).not.toContain('scale');

        // When building packet for clamp in flow_beta
        const packetBeta = buildForgePacket(snapshot, sources, 'clamp', {
            occurrence: { flowId: 'flow_beta', instanceId: 'inst_clamp_2' },
        });

        expect(packetBeta.occurrence).toEqual({ flowId: 'flow_beta', instanceId: 'inst_clamp_2' });
        expect(packetBeta.neighbors?.map(n => n.id)).toEqual(['log_val']);
        expect(packetBeta.prompt).toContain('Dependency: log_val');
        expect(packetBeta.prompt).not.toContain('add');
        expect(packetBeta.prompt).not.toContain('scale');
    });

    it('enforces micro-context discipline: neighbor signatures + intent + contract without full bodies in prompt', () => {
        const { snapshot, sources } = makeSnapshotWithFlows();

        const packet = buildForgePacket(snapshot, sources, 'clamp', {
            occurrence: { flowId: 'flow_alpha', instanceId: 'inst_clamp_1' },
        });

        // Items contains target and occurrence neighbor for hash pinning
        expect(packet.items.map(i => i.id)).toEqual(['clamp', 'add']);
        expect(packet.items[0].role).toBe('target');
        expect(packet.items[1].role).toBe('required-context');

        // Prompt includes bounded neighbor signature and intent
        expect(packet.prompt).toContain('### Reference neighbor signatures:');
        expect(packet.prompt).toContain('Signature: def add(a: int, b: int) -> int:');
        expect(packet.prompt).toContain('Intent: Add two integers');
        expect(packet.prompt).toContain('Contract: a + b');
        // Does not contain full function body definition of neighbor
        expect(packet.prompt).not.toContain('return a + b');
    });

    it('includes full dependency bodies only when explicitly requested in fullContextIds', () => {
        const { snapshot, sources } = makeSnapshotWithFlows();

        const packet = buildForgePacket(snapshot, sources, 'clamp', {
            occurrence: { flowId: 'flow_alpha', instanceId: 'inst_clamp_1' },
            fullContextIds: ['add'],
        });

        // Target + explicit full context dependency
        expect(packet.items).toHaveLength(2);
        expect(packet.items[1].id).toBe('add');
        expect(packet.items[1].role).toBe('required-context');
        expect(packet.items[1].source).toContain('return a + b');
    });

    it('formats structured test cases in the micro-packet prompt', () => {
        const { snapshot, sources } = makeSnapshotWithFlows();

        const structuredCases = [
            {
                id: 'case_normal',
                description: 'Within bounds',
                inputs: { value: 5, lower: 0, upper: 10 },
                expected: 5,
            },
            {
                id: 'case_lower',
                description: 'Below lower bound',
                inputs: { value: -5, lower: 0, upper: 10 },
                expected: 0,
            },
            {
                id: 'case_err',
                description: 'Invalid bounds',
                inputs: { value: 5, lower: 10, upper: 0 },
                error: 'ValueError',
            },
        ];

        const packet = buildForgePacket(snapshot, sources, 'clamp', {
            occurrence: { flowId: 'flow_alpha', instanceId: 'inst_clamp_1' },
            cases: structuredCases,
        });

        expect(packet.prompt).toContain('Structured Cases:');
        expect(packet.prompt).toContain('- Case "Within bounds": inputs={"value":5,"lower":0,"upper":10} expected=5');
        expect(packet.prompt).toContain('- Case "Below lower bound": inputs={"value":-5,"lower":0,"upper":10} expected=0');
        expect(packet.prompt).toContain('- Case "Invalid bounds": inputs={"value":5,"lower":10,"upper":0} error="ValueError"');
        expect(packet.cases).toEqual(structuredCases);
    });

    it('refuses oversized targets whose stub + cases + retry feedback alone exceed 600 tokens without truncating', () => {
        const { snapshot, sources } = makeSnapshotWithFlows();

        // 30 large test cases pushing prompt > 600 tokens
        const hugeCases = Array.from({ length: 30 }, (_, i) => ({
            id: `case_${i}`,
            description: `Extremely verbose case description explaining scenario ${i} `.repeat(5),
            inputs: { value: i, lower: 0, upper: 100 },
            expected: i,
        }));

        expect(() => buildForgePacket(snapshot, sources, 'clamp', {
            cases: hugeCases,
        })).toThrow(PacketError);

        expect(() => buildForgePacket(snapshot, sources, 'clamp', {
            cases: hugeCases,
        })).toThrow(/Refusing oversized target/);
    });

    it('trims neighbor signatures first when nearing 600 tokens and populates omittedNeighbors', () => {
        const { snapshot, sources } = makeSnapshotWithFlows();

        // Add 6 neighbor instances to flow_alpha connected to inst_clamp_1
        const flowAlpha = snapshot.flows![0].flow!;
        const newNeighborIds: string[] = [];
        for (let i = 1; i <= 6; i++) {
            const name = `heavy_neighbor_${i}`;
            newNeighborIds.push(name);
            const node = indexNode(
                `slate/nodes/${name}.json`,
                JSON.stringify({
                    slate: 3,
                    name,
                    intent: `Detailed specification of heavy neighbor ${i} operations `.repeat(6),
                    contract: `contracts and preconditions for heavy neighbor ${i}`,
                    code: [`def ${name}(arg_${i}: int) -> int:`, '    return arg'],
                }),
                'python',
                1,
            );
            snapshot.documents.push(node.document);
            sources.set(node.document.path, node.code);
            flowAlpha.instances.push({ id: `inst_heavy_${i}`, node: name });
            flowAlpha.wires.push({ from: `inst_heavy_${i}.out`, to: 'inst_clamp_1.in:value' });
        }

        const packet = buildForgePacket(snapshot, sources, 'clamp', {
            occurrence: { flowId: 'flow_alpha', instanceId: 'inst_clamp_1' },
        });

        expect(packet.estimatedInputTokens).toBeLessThanOrEqual(FORGE_INPUT_BUDGET_TOKENS);
        expect(packet.neighbors).toBeDefined();
        expect(packet.omittedNeighbors).toBeDefined();
        expect(packet.omittedNeighbors!.length).toBeGreaterThan(0);
        // Included neighbors + omitted equals total neighbors connected
        const total = (packet.neighbors?.length ?? 0) + (packet.omittedNeighbors?.length ?? 0);
        expect(total).toBe(1 + 6); // add + 6 heavy neighbors
    });
});
