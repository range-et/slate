import type { CanvasRef, HarnessDocument, HarnessFlow, NodeUsageInfo, NodeUsageSite } from './harness_protocol';
import { MAIN_FLOW } from './flow';
import { nodeIdForPath } from './slate_folder';

/**
 * Builds a derived usage index across all flows, instances, code dependencies,
 * and prompt contexts (S-502).
 *
 * Derived, never persisted:
 * - Instances: Call occurrences in main.json and subflows.
 * - Code dependencies: Compiler-resolved references in doc.uses.
 * - Prompt context: unit.annotation.dependencies (listed separately, not in totalUses).
 * - Avoids double-counting legacy layout.refs during migration.
 */
export function buildUsageIndex(
    documents: readonly HarnessDocument[],
    flows: readonly HarnessFlow[],
    legacyRefs?: readonly CanvasRef[],
): Record<string, NodeUsageInfo> {
    const usages: Record<string, NodeUsageInfo> = {};
    const docsById = new Map<string, HarnessDocument>();

    for (const doc of documents) {
        const nodeId = nodeIdForPath(doc.path) ?? doc.units[0]?.name;
        if (!nodeId) continue;
        docsById.set(nodeId, doc);
        usages[nodeId] = {
            nodeId,
            totalUses: 0,
            instanceCount: 0,
            dependencyCount: 0,
            contextCount: 0,
            callSites: [],
            contextUsers: [],
        };
    }

    // Track seen root instance IDs so legacy refs and main.json don't double count
    const seenRootInstances = new Set<string>();

    // 1. Scan instances in all flows
    for (const flowItem of flows) {
        const flow = flowItem.flow;
        if (!flow || !Array.isArray(flow.instances)) continue;
        const isRoot = flowItem.id === MAIN_FLOW;

        for (const inst of flow.instances) {
            if (inst.kind === 'value' || !inst.node) continue;
            const targetNode = inst.node;
            const targetInfo = usages[targetNode];
            if (targetInfo) {
                if (isRoot) {
                    seenRootInstances.add(inst.id);
                }
                targetInfo.instanceCount++;
                const site: NodeUsageSite = {
                    kind: isRoot ? 'root_instance' : 'flow_instance',
                    flowId: isRoot ? undefined : flowItem.id,
                    instanceId: inst.id,
                    label: isRoot ? `Root canvas (${inst.id})` : `Flow "${flowItem.id}" (${inst.id})`,
                };
                targetInfo.callSites.push(site);
            }
        }
    }

    // 2. Scan legacy layout.refs (only if not already in main.json instances)
    if (legacyRefs && legacyRefs.length > 0) {
        for (const ref of legacyRefs) {
            if (!ref.target || seenRootInstances.has(ref.id)) continue;
            const targetInfo = usages[ref.target];
            if (targetInfo) {
                seenRootInstances.add(ref.id);
                targetInfo.instanceCount++;
                targetInfo.callSites.push({
                    kind: 'root_instance',
                    instanceId: ref.id,
                    label: `Root reference (${ref.id})`,
                });
            }
        }
    }

    // 3. Scan compiler-resolved code dependencies (uses)
    for (const [nodeId, doc] of docsById.entries()) {
        const docUses = doc.uses ?? [];
        for (const usedTarget of docUses) {
            if (!usedTarget || usedTarget === nodeId) continue;
            const targetInfo = usages[usedTarget];
            if (targetInfo) {
                // Ensure we don't duplicate code dependency sites for the same referencing node
                const alreadyRecorded = targetInfo.callSites.some(
                    site => site.kind === 'code_dependency' && site.nodeId === nodeId,
                );
                if (!alreadyRecorded) {
                    targetInfo.dependencyCount++;
                    targetInfo.callSites.push({
                        kind: 'code_dependency',
                        nodeId,
                        label: `Code reference in ${doc.units[0]?.name ?? nodeId}`,
                    });
                }
            }
        }
    }

    // 4. Scan prompt context dependencies (annotation.dependencies), kept strictly separate
    for (const [nodeId, doc] of docsById.entries()) {
        const rawDeps = doc.units[0]?.annotation?.dependencies;
        const contextDeps = Array.isArray(rawDeps) ? rawDeps : [];
        for (const dep of contextDeps) {
            if (typeof dep !== 'string' || !dep || dep === nodeId) continue;
            const targetInfo = usages[dep];
            if (targetInfo) {
                const userLabel = doc.units[0]?.name ?? nodeId;
                if (!targetInfo.contextUsers.includes(userLabel)) {
                    targetInfo.contextCount++;
                    targetInfo.contextUsers.push(userLabel);
                }
            }
        }
    }

    // 5. Total uses = instances + code dependencies (excluding pure prompt context)
    for (const info of Object.values(usages)) {
        info.totalUses = info.instanceCount + info.dependencyCount;
    }

    return usages;
}

/** Returns true if editing this definition affects more than one use across the project. */
export function isSharedDefinition(usage: NodeUsageInfo | undefined): boolean {
    return (usage?.totalUses ?? 0) > 1;
}
