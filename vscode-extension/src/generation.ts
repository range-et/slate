import { HarnessDocument, HarnessSnapshot, ParsedUnit, SourcePosition } from './harness_protocol';

export interface PacketItem {
    id: string;
    path: string;
    qualifiedName: string;
    role: 'target' | 'required-context';
    sourceHash: `sha256:${string}`;
    source: string;
}

export interface GenerationPacket {
    targetId: string;
    intent: string;
    contract: string;
    items: PacketItem[];
    estimatedInputTokens: number;
    inputBudgetTokens: number;
    outputBudgetTokens: number;
    prompt: string;
}

export class PacketError extends Error {}

function offsetAt(source: string, position: SourcePosition): number {
    let line = 0;
    let offset = 0;
    while (line < position.line && offset < source.length) {
        const next = source.indexOf('\n', offset);
        if (next < 0) return source.length;
        offset = next + 1;
        line++;
    }
    return Math.min(source.length, offset + position.character);
}

function unitSource(source: string, unit: ParsedUnit): string {
    return source.slice(offsetAt(source, unit.ranges.declaration.start), offsetAt(source, unit.ranges.declaration.end)).trimEnd();
}

function findUnit(snapshot: HarnessSnapshot, id: string): { document: HarnessDocument; unit: ParsedUnit } {
    const matches = snapshot.documents.flatMap(document => document.units
        .filter(unit => unit.id === id)
        .map(unit => ({ document, unit })));
    if (matches.length !== 1) throw new PacketError(`Unit ${id} resolved to ${matches.length} declarations.`);
    return matches[0];
}

function textField(unit: ParsedUnit, key: 'intent' | 'contract'): string {
    const value = unit.annotation?.[key];
    return typeof value === 'string' ? value.trim() : '';
}

export function buildGenerationPacket(
    snapshot: HarnessSnapshot,
    sources: ReadonlyMap<string, string>,
    targetId: string,
    contextWindowTokens: number,
    outputBudgetTokens: number,
): GenerationPacket {
    const target = findUnit(snapshot, targetId);
    if (target.unit.identity !== 'durable' || !target.unit.annotation) {
        throw new PacketError('Adopt this function with an intent before generation.');
    }
    if (!['function', 'method'].includes(target.unit.kind)) {
        throw new PacketError('Generation currently supports top-level functions and methods.');
    }
    if (!target.unit.returnAnnotation || !target.unit.parameters) {
        throw new PacketError('Generation requires a typed parameter list and return annotation.');
    }
    if (target.unit.annotation.locked === true) throw new PacketError('This function is locked.');
    const intent = textField(target.unit, 'intent');
    if (!intent) throw new PacketError('Add an intent before generation.');
    const dependencies = Array.isArray(target.unit.annotation.dependencies)
        ? target.unit.annotation.dependencies.filter((value): value is string => typeof value === 'string')
        : [];
    const targetSource = sources.get(target.document.path);
    if (targetSource === undefined) throw new PacketError(`Source for ${target.document.path} is unavailable.`);
    const items: PacketItem[] = [{
        id: target.unit.id,
        path: target.document.path,
        qualifiedName: target.unit.qualifiedName,
        role: 'target',
        sourceHash: target.document.sourceHash,
        source: unitSource(targetSource, target.unit),
    }];
    for (const dependencyId of dependencies) {
        const dependency = findUnit(snapshot, dependencyId);
        const source = sources.get(dependency.document.path);
        if (source === undefined) throw new PacketError(`Required context ${dependency.unit.qualifiedName} is unavailable.`);
        items.push({
            id: dependency.unit.id,
            path: dependency.document.path,
            qualifiedName: dependency.unit.qualifiedName,
            role: 'required-context',
            sourceHash: dependency.document.sourceHash,
            source: unitSource(source, dependency.unit),
        });
    }
    const contract = textField(target.unit, 'contract');
    const context = items.slice(1).map(item =>
        `### Required context: ${item.qualifiedName} (${item.path})\n\`\`\`python\n${item.source}\n\`\`\``
    ).join('\n\n');
    const prompt = [
        `Implement exactly the Python function below.`,
        `Intent: ${intent}`,
        contract ? `Contract: ${contract}` : '',
        `Preserve its decorators, name, signature, and type annotations.`,
        `Return only one complete Python function, with no Markdown fence, imports, module statements, tests, or explanation.`,
        `Context is reference material; it does not imply an import or call dependency.`,
        context,
        `### Target: ${target.unit.qualifiedName} (${target.document.path})\n\`\`\`python\n${items[0].source}\n\`\`\``,
    ].filter(Boolean).join('\n\n');
    const estimatedInputTokens = Math.ceil(prompt.length / 4);
    const inputBudgetTokens = contextWindowTokens - outputBudgetTokens;
    if (inputBudgetTokens <= 0) throw new PacketError('The output budget must be smaller than the context window.');
    if (estimatedInputTokens > inputBudgetTokens) {
        throw new PacketError(`Packet needs about ${estimatedInputTokens} tokens but the input budget is ${inputBudgetTokens}. Required context was not truncated.`);
    }
    return { targetId, intent, contract, items, estimatedInputTokens, inputBudgetTokens, outputBudgetTokens, prompt };
}

export function stripModelEnvelope(value: string): string {
    const trimmed = value.trim();
    const fenced = trimmed.match(/^```(?:python)?\s*\n([\s\S]*?)\n```$/i);
    return (fenced?.[1] ?? trimmed).trim();
}
