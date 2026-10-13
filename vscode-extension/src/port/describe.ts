import { parseModule } from '../python_adapter';
import type { SlateNode } from '../slate_folder';

// Describe pass: ask the local model for a one-line intent per node, leaves
// first, with only the node's code plus the signature and intent of each node
// it uses. Nodes that already have an intent are skipped, so runs resume.

export const DESCRIBE_INPUT_TOKENS = 600;
export const DESCRIBE_OUTPUT_TOKENS = 120;
export const DESCRIBE_SYSTEM = 'You describe Python code in one line for a code map. Follow the reply format exactly.';
const MAX_LINE = 240;

export class DescribeError extends Error {}

export interface DescribeReport {
    described: string[];
    skipped: Array<{ nodeId: string; reason: string }>;
    cancelled: boolean;
}

const isDefinition = (node: SlateNode | undefined): node is SlateNode => Boolean(node) && !node!.kind;
const estimate = (text: string) => Math.ceil(text.length / 4);

/** Definition nodes, each after the nodes it uses; cycles are broken by node id order. */
export function describeOrder(nodes: ReadonlyMap<string, SlateNode>): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (nodeId: string) => {
        if (seen.has(nodeId)) return;
        seen.add(nodeId);
        for (const used of [...nodes.get(nodeId)!.uses].sort()) if (isDefinition(nodes.get(used))) visit(used);
        order.push(nodeId);
    };
    [...nodes.keys()].filter(nodeId => isDefinition(nodes.get(nodeId))).sort().forEach(visit);
    return order;
}

function signatureOf(node: SlateNode): string {
    const code = `${node.code.join('\n')}\n`;
    const unit = parseModule(code, '<describe>').units.find(item => item.parentId === null && item.name === node.name);
    return unit?.signature
        ?? node.code.find(line => /^(async\s+def|def|class)\s/.test(line))?.replace(/:\s*$/, '')
        ?? node.name;
}

export function buildDescribePacket(nodeId: string, nodes: ReadonlyMap<string, SlateNode>, hardLimitTokens: number): string {
    const node = nodes.get(nodeId)!;
    const kind = node.code.some(line => line.startsWith('class ')) ? 'class' : 'function';
    const head = [
        `Describe what this ${kind} does.`,
        'Reply with exactly `intent: <one line>` and optionally `contract: <one line>` (inputs, outputs, errors). Nothing else.',
    ];
    const body = `\`\`\`python\n${node.code.join('\n')}\n\`\`\``;
    const used = node.uses.filter(id => isDefinition(nodes.get(id))).map(id => {
        const other = nodes.get(id)!;
        return `- ${signatureOf(other)}${other.intent.trim() ? ` — ${other.intent.trim()}` : ''}`;
    });
    const compose = (lines: string[]) => [...head, ...(lines.length ? ['It uses:', ...lines] : []), body].join('\n\n');
    // Keep the node's own code whole; drop used-node lines to stay near the micro budget.
    while (used.length && estimate(compose(used)) > DESCRIBE_INPUT_TOKENS) used.pop();
    const prompt = compose(used);
    if (estimate(prompt) > hardLimitTokens) throw new DescribeError(`too large to describe (about ${estimate(prompt)} tokens)`);
    return prompt;
}

/** `intent: …` plus an optional `contract: …`, one line each and nothing else; otherwise null. */
export function parseDescribeReply(reply: string): { intent: string; contract: string } | null {
    const text = reply.trim().replace(/^```\w*\n([\s\S]*?)\n```$/, '$1');
    const fields: Record<string, string> = {};
    for (const line of text.split('\n').map(item => item.trim()).filter(Boolean)) {
        const match = line.match(/^(intent|contract)\s*:\s*(.+)$/i);
        if (!match) return null;
        const key = match[1].toLowerCase();
        const value = match[2].trim().replace(/^`(.*)`$/, '$1');
        if (key in fields || value.length > MAX_LINE) return null;
        fields[key] = value;
    }
    return fields.intent ? { intent: fields.intent, contract: fields.contract ?? '' } : null;
}

export async function describeNodes(options: {
    nodes: Map<string, SlateNode>;
    complete(prompt: string, signal: AbortSignal): Promise<string>;
    write(nodeId: string, described: { intent: string; contract: string }): Promise<void>;
    onProgress(message: string): void;
    signal: AbortSignal;
    hardLimitTokens: number;
}): Promise<DescribeReport> {
    const report: DescribeReport = { described: [], skipped: [], cancelled: false };
    const pending = describeOrder(options.nodes).filter(nodeId => !options.nodes.get(nodeId)!.intent.trim());
    for (const [index, nodeId] of pending.entries()) {
        if (options.signal.aborted) {
            report.cancelled = true;
            break;
        }
        options.onProgress(`Describing ${index + 1}/${pending.length}: ${nodeId}…`);
        let prompt: string;
        try {
            prompt = buildDescribePacket(nodeId, options.nodes, options.hardLimitTokens);
        } catch (error) {
            report.skipped.push({ nodeId, reason: (error as Error).message });
            continue;
        }
        let described: { intent: string; contract: string } | null = null;
        let reason = 'malformed reply';
        for (let attempt = 0; attempt < 2 && !described; attempt++) {
            try {
                described = parseDescribeReply(await options.complete(prompt, options.signal));
            } catch (error) {
                reason = error instanceof Error ? error.message : String(error);
                break;
            }
        }
        if (options.signal.aborted) {
            report.cancelled = true;
            break;
        }
        if (!described) {
            report.skipped.push({ nodeId, reason });
            continue;
        }
        await options.write(nodeId, described);
        // Later packets show this intent for nodes that use this one.
        options.nodes.set(nodeId, { ...options.nodes.get(nodeId)!, ...described, describedBy: 'llama' });
        report.described.push(nodeId);
    }
    options.onProgress(`Described ${report.described.length} node(s)${report.skipped.length ? `, skipped ${report.skipped.length}` : ''}${report.cancelled ? '; cancelled' : ''}.`);
    return report;
}
