import { HarnessDocument, HarnessSnapshot, ParsedUnit, SourcePosition } from './harness_protocol';
import { parseModule } from './python_adapter';

export const FORGE_INPUT_BUDGET_TOKENS = 600;
export const JPL60_MAX_LINES = 60;

export interface PacketItem {
    id: string;
    path: string;
    qualifiedName: string;
    role: 'target' | 'required-context';
    sourceHash: `sha256:${string}`;
    source: string;
}

export interface NeighborSignatureContext {
    id: string;
    path: string;
    qualifiedName: string;
    signature: string;
    intent: string;
    sourceHash: `sha256:${string}`;
}

export interface TargetFingerprint {
    targetId: string;
    sourceHash: string;
    code: string[];
    intent: string;
    contract: string;
    locked: boolean;
    cases?: unknown[];
    imports: string[];
    context: string[];
    uses: string[];
    neighborSignatures: Record<string, { signature: string; sourceHash: string }>;
}

export interface GenerationPacket {
    targetId: string;
    intent: string;
    contract: string;
    cases?: unknown[];
    retryFeedback?: string;
    items: PacketItem[];
    neighbors?: NeighborSignatureContext[];
    omittedNeighbors?: string[];
    estimatedInputTokens: number;
    inputBudgetTokens: number;
    outputBudgetTokens: number;
    prompt: string;
    fingerprint?: TargetFingerprint;
    boundInputs?: boolean;
}

export interface ForgeOptions {
    forge?: boolean;
    cases?: unknown[];
    retryFeedback?: string;
    inputBudgetTokens?: number;
    boundInputs?: boolean;
    neighbors?: Array<{ id: string; signature: string; intent: string }>;
}

export interface ForgeCandidate {
    implementation: string;
    check?: string;
}

export interface CandidateValidationResult {
    valid: boolean;
    lineCount: number;
    checkLineCount?: number;
    diagnostics: string[];
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

function formatCases(cases: unknown[]): string {
    return cases.map((c, i) => {
        if (typeof c === 'string') return `- Case ${i + 1}: ${c}`;
        if (c && typeof c === 'object') {
            const rec = c as Record<string, unknown>;
            const name = typeof rec.name === 'string' ? rec.name : `case_${i + 1}`;
            const input = rec.input !== undefined ? JSON.stringify(rec.input) : undefined;
            const expected = rec.expected !== undefined ? JSON.stringify(rec.expected) : undefined;
            let line = `- Case "${name}":`;
            if (input !== undefined) line += ` input=${input}`;
            if (expected !== undefined) line += ` expected=${expected}`;
            return line;
        }
        return `- Case ${i + 1}: ${JSON.stringify(c)}`;
    }).join('\n');
}

function cleanLines(text: string): string[] {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    return lines;
}

export function buildGenerationPacket(
    snapshot: HarnessSnapshot,
    sources: ReadonlyMap<string, string>,
    targetId: string,
    contextWindowTokens: number,
    outputBudgetTokens: number,
    options?: ForgeOptions,
): GenerationPacket {
    const target = findUnit(snapshot, targetId);
    if (target.unit.identity !== 'durable' || !target.unit.annotation) {
        throw new PacketError('Generation works on a node function; select the node itself.');
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

    const contract = textField(target.unit, 'contract');
    const cases = options?.cases ?? (Array.isArray(target.unit.annotation.cases) ? target.unit.annotation.cases : undefined);
    const retryFeedback = typeof options?.retryFeedback === 'string' ? options.retryFeedback.trim() : undefined;
    const targetImports = Array.isArray(target.unit.annotation.imports)
        ? (target.unit.annotation.imports as string[])
        : [];
    const targetContext = Array.isArray(target.unit.annotation.context)
        ? (target.unit.annotation.context as string[])
        : dependencies;
    const targetUses = Array.isArray(target.unit.annotation.uses)
        ? (target.unit.annotation.uses as string[])
        : [];

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

    if (options?.forge) {
        const inputBudgetTokens = options.inputBudgetTokens ?? Math.min(contextWindowTokens - outputBudgetTokens, FORGE_INPUT_BUDGET_TOKENS);
        if (inputBudgetTokens <= 0) throw new PacketError('The output budget must be smaller than the context window.');

        const casesFormatted = cases && cases.length > 0 ? formatCases(cases) : '';
        const feedbackFormatted = retryFeedback ? `### Bounded Retry Feedback (revised code must fix these issues):\n${retryFeedback}` : '';

        const formatForgePrompt = (neighborList: NeighborSignatureContext[]): string => {
            const neighborSection = neighborList.length > 0
                ? `### Reference neighbor signatures:\n${neighborList.map(n =>
                    `### Dependency: ${n.qualifiedName} (${n.path})\nSignature: ${n.signature}${n.intent ? `\nIntent: ${n.intent}` : ''}`
                ).join('\n\n')}`
                : '';

            const promptParts = [
                `You are a constrained local component forge engine. Follow JPL-60 rules strictly.`,
                `Implement exactly the Python function below and forge its corresponding pytest unit check.`,
                `Intent: ${intent}`,
                contract ? `Contract: ${contract}` : '',
                casesFormatted ? `Structured Cases:\n${casesFormatted}` : '',
                feedbackFormatted,
                `Rules:`,
                `- Preserve decorators, function name, signature, and parameter/return type annotations.`,
                `- The implementation MUST be <=60 lines, strictly typed, with bounded control flow (JPL-60).`,
                `- The unit check MUST be a pytest function (def test_${target.unit.name}(): ...) verifying the contract and cases.`,
                neighborSection,
                `### Target stub: ${target.unit.qualifiedName} (${target.document.path})\n\`\`\`python\n${items[0].source}\n\`\`\``,
                `Output format (use these exact section headers):`,
                `### Implementation`,
                `\`\`\`python`,
                `def ${target.unit.name}(...):`,
                `    ...`,
                `\`\`\``,
                `### Unit Check`,
                `\`\`\`python`,
                `def test_${target.unit.name}():`,
                `    ...`,
                `\`\`\``,
            ].filter(Boolean);

            return promptParts.join('\n\n');
        };

        const basePrompt = formatForgePrompt([]);
        const coreTokens = Math.ceil(basePrompt.length / 4);
        if (coreTokens > inputBudgetTokens) {
            throw new PacketError(`Target stub, cases, and feedback require about ${coreTokens} tokens, which exceeds the micro-packet budget of ${inputBudgetTokens}. Refusing oversized target.`);
        }

        const neighbors: NeighborSignatureContext[] = [];
        const omittedNeighbors: string[] = [];
        const neighborSignatures: Record<string, { signature: string; sourceHash: string }> = {};

        for (const dependencyId of dependencies) {
            const dependency = findUnit(snapshot, dependencyId);
            const source = sources.get(dependency.document.path);
            if (source === undefined) throw new PacketError(`Required context ${dependency.unit.qualifiedName} is unavailable.`);
            const depUnit = dependency.unit;
            let sig = depUnit.signature;
            if (!sig) {
                const params = depUnit.parameters ?? '';
                const ret = depUnit.returnAnnotation ? ` -> ${depUnit.returnAnnotation}` : '';
                sig = `def ${depUnit.name}(${params})${ret}`;
            }
            if (sig.endsWith(':')) sig = sig.slice(0, -1).trimEnd();
            const promptSig = `${sig}:`;
            const depIntent = textField(depUnit, 'intent');
            neighborSignatures[dependencyId] = { signature: sig, sourceHash: dependency.document.sourceHash };

            const candidateNeighbor: NeighborSignatureContext = {
                id: dependency.unit.id,
                path: dependency.document.path,
                qualifiedName: depUnit.qualifiedName,
                signature: promptSig,
                intent: depIntent,
                sourceHash: dependency.document.sourceHash,
            };

            const testPrompt = formatForgePrompt([...neighbors, candidateNeighbor]);
            if (Math.ceil(testPrompt.length / 4) <= inputBudgetTokens) {
                neighbors.push(candidateNeighbor);
            } else {
                omittedNeighbors.push(depUnit.qualifiedName);
            }
        }

        const prompt = formatForgePrompt(neighbors);
        const estimatedInputTokens = Math.ceil(prompt.length / 4);

        const fingerprint: TargetFingerprint = {
            targetId,
            sourceHash: target.document.sourceHash,
            code: cleanLines(targetSource),
            intent,
            contract,
            locked: target.unit.annotation.locked === true,
            cases,
            imports: targetImports,
            context: targetContext,
            uses: targetUses,
            neighborSignatures,
        };

        return {
            targetId,
            intent,
            contract,
            cases,
            retryFeedback,
            items,
            neighbors,
            omittedNeighbors,
            estimatedInputTokens,
            inputBudgetTokens,
            outputBudgetTokens,
            prompt,
            fingerprint,
            boundInputs: options.boundInputs ?? true,
        };
    }

    // Standard / legacy generation packet behavior
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

    const neighborSignatures: Record<string, { signature: string; sourceHash: string }> = {};
    for (const item of items.slice(1)) {
        let sig = item.source.split('\n')[0] ?? '';
        if (sig.endsWith(':')) sig = sig.slice(0, -1).trimEnd();
        neighborSignatures[item.id] = { signature: sig, sourceHash: item.sourceHash };
    }

    const fingerprint: TargetFingerprint = {
        targetId,
        sourceHash: target.document.sourceHash,
        code: cleanLines(targetSource),
        intent,
        contract,
        locked: target.unit.annotation.locked === true,
        cases,
        imports: targetImports,
        context: targetContext,
        uses: targetUses,
        neighborSignatures,
    };

    return {
        targetId,
        intent,
        contract,
        cases,
        retryFeedback,
        items,
        estimatedInputTokens,
        inputBudgetTokens,
        outputBudgetTokens,
        prompt,
        fingerprint,
        boundInputs: options?.boundInputs ?? false,
    };
}

export function buildForgePacket(
    snapshot: HarnessSnapshot,
    sources: ReadonlyMap<string, string>,
    targetId: string,
    options?: ForgeOptions,
): GenerationPacket {
    return buildGenerationPacket(
        snapshot,
        sources,
        targetId,
        FORGE_INPUT_BUDGET_TOKENS + 768,
        768,
        { forge: true, inputBudgetTokens: FORGE_INPUT_BUDGET_TOKENS, boundInputs: true, ...options },
    );
}

export function stripModelEnvelope(value: string): string {
    const trimmed = value.trim();
    const fenced = trimmed.match(/^```(?:python)?\s*\n([\s\S]*?)\n```$/i);
    return (fenced?.[1] ?? trimmed).trim();
}

export function parseForgeCandidate(raw: string): ForgeCandidate {
    const text = raw.trim();

    // 1. Check for explicit section headers: ### Implementation ... ### Unit Check ...
    const implHeaderRegex = /(?:^|\n)###\s*(?:Implementation|Function|Code)[\s\S]*?(?=(?:\n###\s*(?:Unit\s*Check|Check|Test|Tests|Pytest)|$))/i;
    const checkHeaderRegex = /(?:^|\n)###\s*(?:Unit\s*Check|Check|Test|Tests|Pytest)([\s\S]*)$/i;

    const implMatch = text.match(implHeaderRegex);
    const checkMatch = text.match(checkHeaderRegex);

    if (implMatch && checkMatch) {
        const rawImpl = implMatch[0].replace(/(?:^|\n)###\s*(?:Implementation|Function|Code)\s*/i, '').trim();
        const rawCheck = checkMatch[1].trim();
        return {
            implementation: stripModelEnvelope(rawImpl),
            check: stripModelEnvelope(rawCheck) || undefined,
        };
    }

    // 2. Check for multiple markdown code fences: ```python ... ``` followed by ```python ... ```
    const fences = [...text.matchAll(/```(?:python)?\s*\n([\s\S]*?)\n```/gi)].map(m => m[1].trim());
    if (fences.length >= 2) {
        return {
            implementation: fences[0],
            check: fences[1],
        };
    }

    // 3. Check for single block with both def <target> and def test_...
    const stripped = stripModelEnvelope(text);
    const testSplit = stripped.search(/\n(?=(?:async\s+)?def\s+test_)/i);
    if (testSplit !== -1) {
        const impl = stripped.slice(0, testSplit).trim();
        const check = stripped.slice(testSplit).trim();
        return {
            implementation: impl,
            check: check || undefined,
        };
    }

    // 4. Fallback: single implementation
    return {
        implementation: stripped,
    };
}

export function validateForgeCandidate(
    targetUnit: ParsedUnit,
    candidate: ForgeCandidate,
): CandidateValidationResult {
    const diagnostics: string[] = [];

    // 1. Implementation syntax & single function definition
    const implText = candidate.implementation.endsWith('\n') ? candidate.implementation : `${candidate.implementation}\n`;
    const parsedImpl = parseModule(implText, '<candidate>', targetUnit.name);
    if (!parsedImpl.valid) {
        diagnostics.push('Candidate implementation is not valid Python.');
    }

    const implUnits = parsedImpl.units.filter(u => u.parentId === null);
    if (implUnits.length !== 1 || implUnits[0].name !== targetUnit.name) {
        diagnostics.push(`Candidate must contain exactly one function definition named "${targetUnit.name}".`);
    }

    let lineCount = 0;
    const implLines = candidate.implementation.replace(/\r\n?/g, '\n').split('\n');
    while (implLines.length > 0 && implLines[implLines.length - 1].trim() === '') {
        implLines.pop();
    }
    lineCount = implLines.length;

    // JPL-60 line count check
    if (lineCount > JPL60_MAX_LINES) {
        diagnostics.push(`Candidate exceeds JPL-60 limit of 60 lines (${lineCount} lines).`);
    }

    // Signature match check
    if (implUnits.length === 1 && implUnits[0].name === targetUnit.name) {
        const generatedUnit = implUnits[0];

        // Parameters match
        if (targetUnit.params && generatedUnit.params) {
            if (generatedUnit.params.length !== targetUnit.params.length) {
                diagnostics.push(`Candidate parameter count does not match target stub (expected ${targetUnit.params.length}, got ${generatedUnit.params.length}).`);
            } else {
                for (let i = 0; i < targetUnit.params.length; i++) {
                    const tp = targetUnit.params[i];
                    const gp = generatedUnit.params[i];
                    if (gp.name !== tp.name) {
                        diagnostics.push(`Candidate parameter ${i + 1} named "${gp.name}" does not match target parameter "${tp.name}".`);
                    }
                    if ((gp.annotation ?? '').trim() !== (tp.annotation ?? '').trim()) {
                        diagnostics.push(`Candidate parameter "${tp.name}" type annotation "${gp.annotation ?? ''}" does not match target "${tp.annotation ?? ''}".`);
                    }
                }
            }
        }

        // Return annotation match
        const expectedRet = (targetUnit.returnAnnotation ?? '').trim();
        const actualRet = (generatedUnit.returnAnnotation ?? '').trim();
        if (expectedRet !== actualRet) {
            diagnostics.push(`Candidate return type annotation "${actualRet}" does not match target "${expectedRet}".`);
        }
    }

    // 2. Unit check validation if present
    let checkLineCount: number | undefined;
    if (candidate.check) {
        const checkText = candidate.check.endsWith('\n') ? candidate.check : `${candidate.check}\n`;
        const parsedCheck = parseModule(checkText, '<check>');
        if (!parsedCheck.valid) {
            diagnostics.push('Candidate unit check is not valid Python.');
        } else {
            const hasTestFunction = parsedCheck.units.some(u =>
                (u.parentId === null && (u.kind === 'function' || u.kind === 'method') && (u.name.startsWith('test_') || u.name.startsWith('test')))
                || (u.kind === 'class' && u.name.startsWith('Test'))
            );
            if (!hasTestFunction) {
                diagnostics.push('Candidate unit check must define at least one top-level pytest test function (e.g. def test_...(): ...).');
            }
        }

        const checkLines = candidate.check.replace(/\r\n?/g, '\n').split('\n');
        while (checkLines.length > 0 && checkLines[checkLines.length - 1].trim() === '') {
            checkLines.pop();
        }
        checkLineCount = checkLines.length;
        if (checkLineCount > JPL60_MAX_LINES) {
            diagnostics.push(`Candidate unit check exceeds 60 lines (${checkLineCount} lines).`);
        }
    }

    return {
        valid: diagnostics.length === 0,
        lineCount,
        checkLineCount,
        diagnostics,
    };
}
