import { describe, expect, it } from 'vitest';

import type { CanvasRef, HarnessDocument, HarnessFlow } from '../vscode-extension/src/harness_protocol';
import { buildUsageIndex, isSharedDefinition } from '../vscode-extension/src/usage_index';

function makeDoc(name: string, uses?: string[], contextDeps?: string[]): HarnessDocument {
    return {
        id: `slate/nodes/${name}.json`,
        path: `slate/nodes/${name}.json`,
        version: 1,
        stale: false,
        valid: true,
        diagnostics: [],
        units: [{
            id: name,
            name,
            kind: 'function',
            qualifiedName: name,
            parentId: null,
            decorators: [],
            parameters: '()',
            returnType: null,
            signature: `def ${name}()`,
            annotation: contextDeps ? { dependencies: contextDeps } : undefined,
            ranges: {
                declaration: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
                name: { start: { line: 0, character: 4 }, end: { line: 0, character: 4 + name.length } },
                code: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
            },
        }],
        uses,
    };
}

function makeFlow(id: string, instances: Array<{ id: string; node?: string; kind?: 'value' }>): HarnessFlow {
    return {
        id,
        flow: {
            name: id,
            inputs: [],
            outputs: [],
            instances,
            wires: [],
        },
    };
}

describe('Derived Usage Index matrix (S-502)', () => {
    it('returns empty record for empty documents and flows', () => {
        const usages = buildUsageIndex([], []);
        expect(usages).toEqual({});
    });

    it('indexes unreferenced node definition with zero uses', () => {
        const doc = makeDoc('standalone');
        const usages = buildUsageIndex([doc], []);
        expect(usages.standalone).toBeDefined();
        expect(usages.standalone.totalUses).toBe(0);
        expect(usages.standalone.instanceCount).toBe(0);
        expect(usages.standalone.dependencyCount).toBe(0);
        expect(usages.standalone.contextCount).toBe(0);
        expect(usages.standalone.callSites).toEqual([]);
        expect(isSharedDefinition(usages.standalone)).toBe(false);
    });

    it('indexes root call instances in main.json', () => {
        const doc = makeDoc('normalize');
        const flow = makeFlow('main', [
            { id: 'norm_1', node: 'normalize' },
            { id: 'norm_2', node: 'normalize' },
        ]);
        const usages = buildUsageIndex([doc], [flow]);
        const info = usages.normalize;
        expect(info).toBeDefined();
        expect(info.instanceCount).toBe(2);
        expect(info.dependencyCount).toBe(0);
        expect(info.totalUses).toBe(2);
        expect(isSharedDefinition(info)).toBe(true);
        expect(info.callSites).toHaveLength(2);
        expect(info.callSites[0]).toEqual({
            kind: 'root_instance',
            instanceId: 'norm_1',
            label: 'Root canvas (norm_1)',
        });
        expect(info.callSites[1]).toEqual({
            kind: 'root_instance',
            instanceId: 'norm_2',
            label: 'Root canvas (norm_2)',
        });
    });

    it('indexes nested flow instances across multiple flows', () => {
        const doc = makeDoc('clamp');
        const flow1 = makeFlow('math_ops', [
            { id: 'clamp_inst_1', node: 'clamp' },
        ]);
        const flow2 = makeFlow('report_gen', [
            { id: 'clamp_inst_2', node: 'clamp' },
        ]);
        const usages = buildUsageIndex([doc], [flow1, flow2]);
        const info = usages.clamp;
        expect(info).toBeDefined();
        expect(info.instanceCount).toBe(2);
        expect(info.totalUses).toBe(2);
        expect(isSharedDefinition(info)).toBe(true);
        expect(info.callSites).toEqual([
            { kind: 'flow_instance', flowId: 'math_ops', instanceId: 'clamp_inst_1', label: 'Flow "math_ops" (clamp_inst_1)' },
            { kind: 'flow_instance', flowId: 'report_gen', instanceId: 'clamp_inst_2', label: 'Flow "report_gen" (clamp_inst_2)' },
        ]);
    });

    it('indexes compiler-resolved code dependencies in doc.uses', () => {
        const targetDoc = makeDoc('helper');
        const caller1 = makeDoc('caller1', ['helper']);
        const caller2 = makeDoc('caller2', ['helper']);
        const usages = buildUsageIndex([targetDoc, caller1, caller2], []);
        const info = usages.helper;
        expect(info).toBeDefined();
        expect(info.instanceCount).toBe(0);
        expect(info.dependencyCount).toBe(2);
        expect(info.totalUses).toBe(2);
        expect(isSharedDefinition(info)).toBe(true);
        expect(info.callSites).toContainEqual({
            kind: 'code_dependency',
            nodeId: 'caller1',
            label: 'Code reference in caller1',
        });
        expect(info.callSites).toContainEqual({
            kind: 'code_dependency',
            nodeId: 'caller2',
            label: 'Code reference in caller2',
        });
    });

    it('indexes prompt context dependencies separately without inflating totalUses', () => {
        const targetDoc = makeDoc('target');
        const promptUserDoc = makeDoc('prompt_user', undefined, ['target']);
        const usages = buildUsageIndex([targetDoc, promptUserDoc], []);
        const info = usages.target;
        expect(info).toBeDefined();
        expect(info.instanceCount).toBe(0);
        expect(info.dependencyCount).toBe(0);
        // Crucial invariant: prompt-only context is not a runtime call/dependency
        expect(info.totalUses).toBe(0);
        expect(info.contextCount).toBe(1);
        expect(info.contextUsers).toEqual(['prompt_user']);
        expect(isSharedDefinition(info)).toBe(false);
    });

    it('avoids double-counting legacy layout.refs during migration when present in main.json', () => {
        const doc = makeDoc('migrated');
        const main = makeFlow('main', [
            { id: 'ref_1', node: 'migrated' },
        ]);
        const legacyRefs: CanvasRef[] = [
            { id: 'ref_1', target: 'migrated' }, // already in main
            { id: 'ref_2', target: 'migrated' }, // un-migrated legacy ref
        ];
        const usages = buildUsageIndex([doc], [main], legacyRefs);
        const info = usages.migrated;
        expect(info.instanceCount).toBe(2); // ref_1 counted once, ref_2 counted once
        expect(info.totalUses).toBe(2);
        expect(info.callSites).toHaveLength(2);
    });

    it('ignores self references in uses or prompt context', () => {
        const doc = makeDoc('recursive', ['recursive'], ['recursive']);
        const usages = buildUsageIndex([doc], []);
        const info = usages.recursive;
        expect(info.totalUses).toBe(0);
        expect(info.dependencyCount).toBe(0);
        expect(info.contextCount).toBe(0);
    });

    it('combines instances, code dependencies, and prompt contexts accurately', () => {
        const mathDoc = makeDoc('math_util');
        const main = makeFlow('main', [{ id: 'inst_root', node: 'math_util' }]);
        const subflow = makeFlow('sub', [{ id: 'inst_sub', node: 'math_util' }]);
        const codeCaller = makeDoc('code_caller', ['math_util']);
        const promptContext = makeDoc('prompt_helper', undefined, ['math_util']);

        const usages = buildUsageIndex([mathDoc, codeCaller, promptContext], [main, subflow]);
        const info = usages.math_util;
        expect(info.instanceCount).toBe(2);
        expect(info.dependencyCount).toBe(1);
        expect(info.totalUses).toBe(3); // 2 instances + 1 code dependency
        expect(info.contextCount).toBe(1);
        expect(info.contextUsers).toEqual(['prompt_helper']);
        expect(isSharedDefinition(info)).toBe(true);
        expect(info.callSites).toHaveLength(3);
    });
});
