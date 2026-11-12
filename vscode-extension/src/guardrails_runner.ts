import type { FlowGuardrailSummary, NodeGuardrailsReport, ObservedValue, SlateFlow, TestCase } from './harness_protocol';
import { runFlow, type FlowRunRequest } from './flow_runner';
import { runNodeVerification } from './verification_runner';
import type { SlateFolderHost } from './slate_folder_host';
import type { SlateNode } from './slate_folder';

/**
 * Deep equality for observed and expected test case values.
 * Allows type-tolerant comparison between canonical JSON and string reprs.
 */
export function deepValueEqual(actual: unknown, expected: unknown): boolean {
    if (actual === expected) return true;
    if (actual === null || expected === null || actual === undefined || expected === undefined) {
        return actual === expected;
    }
    if (typeof actual === 'number' && typeof expected === 'number') {
        return Math.abs(actual - expected) < 1e-9;
    }
    if (typeof actual === 'string' && typeof expected === 'number') {
        return Number(actual) === expected;
    }
    if (typeof actual === 'number' && typeof expected === 'string') {
        return actual === Number(expected);
    }
    if (typeof actual === 'boolean' && typeof expected === 'string') {
        return (actual ? 'True' : 'False') === expected || String(actual) === expected;
    }
    if (Array.isArray(actual) && Array.isArray(expected)) {
        if (actual.length !== expected.length) return false;
        return actual.every((item, i) => deepValueEqual(item, expected[i]));
    }
    if (typeof actual === 'object' && typeof expected === 'object') {
        const actualKeys = Object.keys(actual as Record<string, unknown>);
        const expectedKeys = Object.keys(expected as Record<string, unknown>);
        if (actualKeys.length !== expectedKeys.length) return false;
        return expectedKeys.every(k => deepValueEqual(
            (actual as Record<string, unknown>)[k],
            (expected as Record<string, unknown>)[k],
        ));
    }
    return String(actual) === String(expected);
}

/**
 * Matches actual flow execution outputs against expected case values.
 */
export function matchFlowOutputs(
    actualOutputs: Record<string, ObservedValue> | undefined,
    expected: unknown,
): { matched: boolean; reason?: string } {
    if (!actualOutputs || Object.keys(actualOutputs).length === 0) {
        if (expected === null || expected === undefined) return { matched: true };
        return { matched: false, reason: 'Flow produced no outputs.' };
    }

    if (typeof expected === 'object' && expected !== null && !Array.isArray(expected)) {
        const expObj = expected as Record<string, unknown>;
        for (const [k, expVal] of Object.entries(expObj)) {
            const obs = actualOutputs[k] ?? actualOutputs[`output:${k}`] ?? actualOutputs[`out:${k}`];
            if (!obs) {
                return {
                    matched: false,
                    reason: `Missing expected output port "${k}". Produced ports: [${Object.keys(actualOutputs).join(', ')}]`,
                };
            }
            if (!deepValueEqual(obs.json, expVal) && !deepValueEqual(obs.repr, expVal)) {
                return {
                    matched: false,
                    reason: `Port "${k}" expected ${JSON.stringify(expVal)}, got ${obs.repr || JSON.stringify(obs.json)}.`,
                };
            }
        }
        return { matched: true };
    }

    // Scalar or array expected output: match against single output port or any matching port
    const keys = Object.keys(actualOutputs);
    for (const key of keys) {
        const obs = actualOutputs[key];
        if (deepValueEqual(obs.json, expected) || deepValueEqual(obs.repr, expected)) {
            return { matched: true };
        }
    }

    const first = actualOutputs[keys[0]];
    return {
        matched: false,
        reason: `Expected output ${JSON.stringify(expected)}, got ${first.repr || JSON.stringify(first.json)}.`,
    };
}

/**
 * Runs a single flow test case via the trusted flow runner.
 */
export async function runFlowCase(
    baseRequest: Omit<FlowRunRequest, 'inputs'>,
    testCase: TestCase,
): Promise<{ passed: boolean; error?: string }> {
    const runResult = await runFlow({
        ...baseRequest,
        inputs: testCase.inputs,
    });

    if (testCase.error) {
        if (runResult.status === 'failed') {
            const errStr = runResult.error ?? '';
            if (!testCase.error || errStr.toLowerCase().includes(testCase.error.toLowerCase())) {
                return { passed: true };
            }
            return {
                passed: false,
                error: `Expected error containing "${testCase.error}", but got: "${errStr}".`,
            };
        }
        return {
            passed: false,
            error: `Expected error "${testCase.error}", but flow completed with status "${runResult.status}".`,
        };
    }

    if (runResult.status !== 'completed') {
        return {
            passed: false,
            error: `Flow execution failed with status "${runResult.status}": ${runResult.error ?? 'unknown error'}.`,
        };
    }

    if (testCase.expected !== undefined) {
        const match = matchFlowOutputs(runResult.flowOutputs, testCase.expected);
        if (!match.matched) {
            return { passed: false, error: match.reason };
        }
    }

    return { passed: true };
}

/**
 * Evaluates all cases defined on a flow.
 */
export async function runFlowGuardrails(
    flowId: string,
    flow: SlateFlow,
    baseRequest: Omit<FlowRunRequest, 'flowId'>,
): Promise<FlowGuardrailSummary> {
    const cases = flow.cases ?? (Array.isArray((flow.extra as Record<string, unknown>)?.cases) ? (flow.extra as Record<string, unknown>).cases as TestCase[] : []);
    const summary: FlowGuardrailSummary = {
        flowId,
        flowName: flow.name,
        totalCases: cases.length,
        passedCases: 0,
        failedCases: 0,
        failures: [],
    };

    if (cases.length === 0) {
        return summary;
    }

    for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        const res = await runFlowCase({ ...baseRequest, flowId }, c);
        if (res.passed) {
            summary.passedCases++;
        } else {
            summary.failedCases++;
            summary.failures.push({
                caseId: c.id ?? `case_${i + 1}`,
                description: c.description ?? `Case ${i + 1}`,
                error: res.error ?? 'Assertion failed',
            });
        }
    }

    return summary;
}

export interface NodeGuardrailsOptions {
    nodeId: string;
    folder: SlateFolderHost;
    workspaceRoot: string;
    nodeOverride?: SlateNode;
    pythonPath?: string;
    isTrusted?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
}

/**
 * Runs guardrails for an atomic node:
 * 1. Executes the node's own test cases and pytest checks via `runNodeVerification`.
 * 2. Finds all affected flows that call this node.
 * 3. Executes the test cases of all affected flows.
 * 4. Combines results into a unified `NodeGuardrailsReport`.
 */
export async function runNodeGuardrails(options: NodeGuardrailsOptions): Promise<NodeGuardrailsReport> {
    const { nodeId, folder, workspaceRoot, pythonPath, isTrusted, signal } = options;

    const node = options.nodeOverride ?? (await folder.readNode(nodeId));
    const { config, nodes } = await folder.readNodes();
    if (options.nodeOverride) {
        nodes.set(nodeId, options.nodeOverride);
    }
    const rawFlows = await folder.readFlows();

    const flowsMap = new Map<string, SlateFlow>();
    for (const hf of rawFlows) {
        if (hf.flow) flowsMap.set(hf.id, hf.flow);
    }

    // 1. Run node's own verification checks
    const dependencies = new Map<string, SlateNode>();
    for (const depId of node.context) {
        try {
            const depNode = await folder.readNode(depId);
            dependencies.set(depId, depNode);
        } catch {}
    }

    const nodeVerif = await runNodeVerification({
        nodeId,
        node,
        dependencies,
        workspaceRoot,
        pythonPath,
        isTrusted: isTrusted !== false,
        signal,
    });

    const nodeCasesFailures: string[] = [];
    if (nodeVerif.state === 'failed') {
        if (nodeVerif.diagnostics && nodeVerif.diagnostics.length > 0) {
            nodeCasesFailures.push(...nodeVerif.diagnostics);
        } else if (nodeVerif.traceback) {
            nodeCasesFailures.push(nodeVerif.traceback);
        } else {
            nodeCasesFailures.push('Node verification test failed.');
        }
    }

    const nodeCases = {
        total: (node.cases?.length ?? 0) + (node.check?.length ? 1 : 0),
        passed: nodeVerif.state === 'passed' ? ((node.cases?.length ?? 0) + (node.check?.length ? 1 : 0)) : 0,
        failed: nodeVerif.state === 'failed' ? 1 : 0,
        failures: nodeCasesFailures,
    };

    // 2. Identify affected flows calling this node
    const affectedFlowSummaries: FlowGuardrailSummary[] = [];
    const baseRequest: Omit<FlowRunRequest, 'flowId'> = {
        workspaceRoot,
        config,
        documents: nodes,
        flows: flowsMap,
        pythonPath,
        isTrusted,
        timeoutMs: options.timeoutMs ?? 15000,
        signal,
    };

    for (const [fId, flow] of flowsMap.entries()) {
        const callsNode = flow.instances.some(inst => inst.node === nodeId || inst.node === node.name);
        if (!callsNode) continue;

        const flowCases = flow.cases ?? (Array.isArray((flow.extra as Record<string, unknown>)?.cases) ? (flow.extra as Record<string, unknown>).cases as TestCase[] : []);
        if (flowCases.length === 0) continue;

        const summary = await runFlowGuardrails(fId, flow, baseRequest);
        affectedFlowSummaries.push(summary);
    }

    const allNodeCasesPass = nodeVerif.state === 'passed' || nodeVerif.state === 'untested';
    const allFlowCasesPass = affectedFlowSummaries.every(f => f.failedCases === 0);

    return {
        nodeId,
        passed: allNodeCasesPass && allFlowCasesPass,
        timestamp: Date.now(),
        nodeCases,
        affectedFlows: affectedFlowSummaries,
    };
}
