import { HarnessDocument, HarnessSnapshot, ParsedUnit, SourcePosition } from './harness_protocol';
import { tryNormalizeLanguage } from './language_types';
import { findForbiddenSlateImports, findNestedPythonDefinitions, hoistLeadingPythonImports, parseModule } from './python_adapter';
import { parseTsModule, containsJsxSyntax } from './ts_adapter';

export const FORGE_INPUT_BUDGET_TOKENS = 600;
export const DEFAULT_FORGE_OUTPUT_TOKENS = 1536;
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
    contract?: string;
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
    occurrence?: { flowId: string; instanceId: string };
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
    occurrence?: { flowId: string; instanceId: string };
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
    occurrence?: { flowId: string; instanceId: string };
    fullContextIds?: string[];
    language?: string;
}

type ForgeLanguageKind = 'python' | 'typescript' | 'javascript';

function forgeLanguageKind(language?: string): ForgeLanguageKind {
    const normalized = language ? tryNormalizeLanguage(language) : undefined;
    if (normalized === 'typescript' || normalized === 'javascript') return normalized;
    return 'python';
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
    hoistedImports?: string[];
    normalizedImplementation?: string;
}

/**
 * Splits leading top-level Python imports from a candidate implementation and detects forbidden `slate.*` imports.
 */
export function hoistPythonCandidateImports(
    implementation: string,
    check?: string,
): { implementation: string; imports: string[]; forbiddenImports: string[] } {
    const hoisted = hoistLeadingPythonImports(implementation);
    if (!check) {
        return hoisted;
    }
    const forbiddenSet = new Set<string>(hoisted.forbiddenImports);
    for (const bad of findForbiddenSlateImports(check)) {
        forbiddenSet.add(bad);
    }
    return {
        implementation: hoisted.implementation,
        imports: hoisted.imports,
        forbiddenImports: Array.from(forbiddenSet),
    };
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

export function getOccurrenceNeighbors(
    snapshot: HarnessSnapshot,
    occurrence: { flowId: string; instanceId: string },
): string[] {
    const targetFlow = snapshot.flows?.find(f => f.id === occurrence.flowId)?.flow;
    if (!targetFlow) return [];

    const instanceId = occurrence.instanceId;
    const neighborNodeIds = new Set<string>();

    for (const wire of targetFlow.wires) {
        const fromParts = wire.from.split('.');
        const toParts = wire.to.split('.');

        const fromInstId = fromParts[0];
        const toInstId = toParts[0];

        if (toInstId === instanceId && fromInstId && !wire.from.startsWith('input:')) {
            const srcInst = targetFlow.instances.find(i => i.id === fromInstId);
            if (srcInst?.node) neighborNodeIds.add(srcInst.node);
        }

        if (fromInstId === instanceId && toInstId && !wire.to.startsWith('output:')) {
            const dstInst = targetFlow.instances.find(i => i.id === toInstId);
            if (dstInst?.node) neighborNodeIds.add(dstInst.node);
        }
    }

    return Array.from(neighborNodeIds);
}

function findAnyUnit(snapshot: HarnessSnapshot, id: string): { document: HarnessDocument | { path: string; sourceHash: string }; unit: ParsedUnit } | undefined {
    for (const doc of snapshot.documents) {
        for (const unit of doc.units) {
            if (unit.id === id) return { document: doc, unit };
        }
    }
    if (snapshot.library) {
        for (const doc of snapshot.library) {
            for (const unit of doc.units) {
                if (unit.id === id) return { document: { path: doc.path, sourceHash: 'sha256:library' }, unit };
            }
        }
    }
    return undefined;
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
            const name = typeof rec.description === 'string' ? rec.description
                : typeof rec.name === 'string' ? rec.name
                : typeof rec.id === 'string' ? rec.id
                : `case_${i + 1}`;
            const approx = rec.approx !== undefined ? JSON.stringify(rec.approx) : undefined;
            if (typeof rec.code === 'string' && rec.code.trim()) {
                let line = `- Case "${name}": code=${JSON.stringify(rec.code.trim())}`;
                if (approx !== undefined) line += ` approx=${approx}`;
                return line;
            }
            const inputs = rec.inputs !== undefined ? JSON.stringify(rec.inputs) : undefined;
            const input = rec.input !== undefined ? JSON.stringify(rec.input) : undefined;
            const expected = rec.expected !== undefined ? JSON.stringify(rec.expected) : undefined;
            const rawError = rec.error !== undefined ? rec.error : rec.expectedError;
            const error = rawError !== undefined ? JSON.stringify(rawError) : undefined;
            let line = `- Case "${name}":`;
            if (inputs !== undefined) line += ` inputs=${inputs}`;
            else if (input !== undefined) line += ` input=${input}`;
            if (expected !== undefined) line += ` expected=${expected}`;
            if (error !== undefined) line += ` error=${error}`;
            if (approx !== undefined) line += ` approx=${approx}`;
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
    const langKind = forgeLanguageKind(options?.language);
    if (!['function', 'method'].includes(target.unit.kind)) {
        throw new PacketError('Generation currently supports top-level functions and methods.');
    }
    if (langKind === 'python') {
        if (!target.unit.returnAnnotation || !target.unit.parameters) {
            throw new PacketError('Generation requires a typed parameter list and return annotation.');
        }
    } else if (langKind === 'typescript') {
        if (!target.unit.returnAnnotation || target.unit.parameters == null) {
            throw new PacketError('Generation requires a typed parameter list and return annotation.');
        }
    } else if (target.unit.parameters == null) {
        throw new PacketError('Generation requires a parameter list.');
    }
    if (target.unit.annotation.locked === true) throw new PacketError('This function is locked.');
    const intent = textField(target.unit, 'intent');
    if (!intent) throw new PacketError('Add an intent before generation.');
    const targetSource = sources.get(target.document.path);
    if (targetSource === undefined) throw new PacketError(`Source for ${target.document.path} is unavailable.`);

    const contract = textField(target.unit, 'contract');
    const cases = options?.cases ?? (Array.isArray(target.unit.annotation.cases) ? target.unit.annotation.cases : undefined);
    const retryFeedback = typeof options?.retryFeedback === 'string' ? options.retryFeedback.trim() : undefined;
    const targetImports = Array.isArray(target.unit.annotation.imports)
        ? (target.unit.annotation.imports as string[])
        : [];
    const targetUses = Array.isArray(target.unit.annotation.uses)
        ? (target.unit.annotation.uses as string[])
        : [];
    const ownerId = target.document.classOwner
        ?? (typeof target.unit.annotation.classOwner === 'string' && target.unit.annotation.classOwner.trim()
            ? target.unit.annotation.classOwner.trim()
            : undefined);
    const ownerDoc = ownerId
        ? snapshot.documents.find(doc => doc.path === `slate/nodes/${ownerId}.json` || doc.id === `node:${ownerId}`)
        : undefined;
    const ownerUnit = ownerDoc?.units.find(u => u.parentId === null);
    const ownerSource = ownerDoc ? sources.get(ownerDoc.path) : undefined;
    const siblingDocs = ownerId
        ? snapshot.documents
            .filter(doc => doc.classOwner === ownerId && doc.path !== target.document.path)
            .sort((left, right) => {
                const lName = left.units[0]?.name ?? '';
                const rName = right.units[0]?.name ?? '';
                if (lName === '__init__' && rName !== '__init__') return -1;
                if (rName === '__init__' && lName !== '__init__') return 1;
                return left.id.localeCompare(right.id);
            })
        : [];
    const siblingSignatures = siblingDocs
        .map(doc => {
            const siblingUnit = doc.units.find(u => u.parentId === null);
            return siblingUnit?.signature ?? (siblingUnit ? `def ${siblingUnit.name}(...)` : null);
        })
        .filter((sig): sig is string => Boolean(sig));
    const occurrenceNeighbors = options?.occurrence
        ? getOccurrenceNeighbors(snapshot, options.occurrence)
        : [];
    const dependencies = options?.occurrence
        ? occurrenceNeighbors
        : Array.isArray(target.unit.annotation.dependencies)
            ? target.unit.annotation.dependencies.filter((value): value is string => typeof value === 'string')
            : targetUses;
    const targetContext = Array.isArray(target.unit.annotation.context)
        ? (target.unit.annotation.context as string[])
        : dependencies;

    const items: PacketItem[] = [{
        id: target.unit.id,
        path: target.document.path,
        qualifiedName: target.unit.qualifiedName,
        role: 'target',
        sourceHash: target.document.sourceHash,
        source: unitSource(targetSource, target.unit),
    }];

    for (const dependencyId of dependencies) {
        if (dependencyId === targetId) continue;
        if (options?.forge) {
            const dependency = findAnyUnit(snapshot, dependencyId);
            if (!dependency) continue;
            const source = sources.get(dependency.document.path);
            if (typeof source !== 'string') continue;
            items.push({
                id: dependency.unit.id,
                path: dependency.document.path,
                qualifiedName: dependency.unit.qualifiedName,
                role: 'required-context',
                sourceHash: dependency.document.sourceHash as `sha256:${string}`,
                source: unitSource(source, dependency.unit),
            });
        } else {
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
    }

    if (options?.forge) {
        const inputBudgetTokens = options.inputBudgetTokens ?? Math.min(contextWindowTokens - outputBudgetTokens, FORGE_INPUT_BUDGET_TOKENS);
        if (inputBudgetTokens <= 0) throw new PacketError('The output budget must be smaller than the context window.');

        const casesFormatted = cases && cases.length > 0 ? formatCases(cases) : '';
        const feedbackFormatted = retryFeedback ? `### Bounded Retry Feedback (revised code must fix these issues):\n${retryFeedback}` : '';
        const ownerClassName = ownerUnit?.name ?? (ownerId ? ownerId.split('/').pop() : undefined);
        const ownerFrameSection = ownerDoc && ownerSource
            ? `### Owning class frame: ${ownerClassName ?? ownerDoc.id}\n\`\`\`python\n${cleanLines(ownerSource).join('\n')}\n\`\`\``
            : '';

        const formatForgePrompt = (
            neighborList: readonly NeighborSignatureContext[],
            signatureOnlyList: readonly NeighborSignatureContext[] = [],
            includeSiblingMethods = true,
        ): string => {
            const siblingSection = includeSiblingMethods && siblingSignatures.length > 0
                ? `### Sibling methods on ${ownerClassName ?? 'class'} (signatures only):\n${siblingSignatures.map(sig => `- ${sig}`).join('\n')}`
                : '';
            const neighborSection = neighborList.length > 0
                ? `### Reference neighbor signatures:\n${neighborList.map(n =>
                    `### Dependency: ${n.qualifiedName}\nSignature: ${n.signature}${n.intent ? `\nIntent: ${n.intent}` : ''}${n.contract ? `\nContract: ${n.contract}` : ''}`
                ).join('\n\n')}`
                : '';
            const signatureOnlySection = signatureOnlyList.length > 0
                ? `### Additional dependencies in scope (signatures only):\n${signatureOnlyList.map(n => `- ${n.signature}`).join('\n')}`
                : '';

            const promptParts = langKind === 'python'
                ? [
                    `You are a constrained local component forge engine. Follow JPL-60 rules strictly.`,
                    ownerClassName
                        ? `Implement exactly the Python method below for class ${ownerClassName} and forge its corresponding pytest unit check.`
                        : `Implement exactly the Python function below and forge its corresponding pytest unit check.`,
                    `Intent: ${intent}`,
                    contract ? `Contract: ${contract}` : '',
                    targetImports.length > 0 ? `Pre-declared imports (already at module top): ${targetImports.join('; ')}` : '',
                    casesFormatted ? `Structured Cases:\n${casesFormatted}` : '',
                    feedbackFormatted,
                    [
                        `Rules:`,
                        `- Preserve decorators, ${ownerClassName ? 'method' : 'function'} name, signature, and parameter/return type annotations.`,
                        ownerClassName
                            ? `- Output ONLY the unindented \`def ${target.unit.name}(...):\` method definition (do NOT wrap it inside \`class ${ownerClassName}:\`).`
                            : '',
                        `- The implementation MUST be <=60 lines, strictly typed, with bounded control flow (JPL-60).`,
                        ownerClassName
                            ? `- Class ${ownerClassName} and listed dependencies are already imported in the test file. NEVER import from slate.* or file paths, and NEVER redefine listed dependencies inside your method.`
                            : `- Listed dependencies are already in scope inside your function; ${target.unit.name} is already imported in the test file. NEVER import from slate.* or file paths, and NEVER redefine listed dependencies inside your function.`,
                        ownerClassName
                            ? `- The unit check MUST be a pytest function (def test_${target.unit.name}(): ...) that constructs ${ownerClassName} and verifies the contract/cases (use pytest.approx for float comparisons).`
                            : `- The unit check MUST be a pytest function (def test_${target.unit.name}(): ...) verifying the contract and cases (use pytest.approx for float comparisons).`,
                    ].filter(Boolean).join('\n'),
                    ownerFrameSection,
                    siblingSection,
                    neighborSection,
                    signatureOnlySection,
                    `### Target stub: ${target.unit.qualifiedName}\n\`\`\`python\n${items[0].source}\n\`\`\``,
                    [
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
                    ].join('\n'),
                ].filter(Boolean)
                : (() => {
                    const fenceTag = langKind === 'typescript' ? 'ts' : 'js';
                    const langDisplay = langKind === 'typescript' ? 'TypeScript' : 'JavaScript';
                    const typeRule = langKind === 'typescript' ? ' type annotations' : '';
                    const strictRule = langKind === 'typescript' ? ', strictly typed,' : '';
                    const retExample = langKind === 'typescript' ? ': ...' : '';
                    return [
                        `You are a constrained local component forge engine. Follow JPL-60 rules strictly.`,
                        `Implement exactly the ${langDisplay} function below and forge its corresponding standalone unit check.`,
                        `Intent: ${intent}`,
                        contract ? `Contract: ${contract}` : '',
                        casesFormatted ? `Structured Cases:\n${casesFormatted}` : '',
                        feedbackFormatted,
                        [
                            `Rules:`,
                            `- Preserve export modifiers, function name, signature, and parameter/return${typeRule}.`,
                            `- The implementation MUST be <=60 lines${strictRule} with bounded control flow (JPL-60).`,
                            `- Only call dependencies provided in Reference neighbor signatures or standard ${langDisplay} built-ins; NEVER redefine listed dependencies locally.`,
                            `- The unit check MUST use test('${target.unit.name}', () => { ... }) with expect(...) assertions (no imports needed).`,
                        ].join('\n'),
                        neighborSection,
                        signatureOnlySection,
                        `### Target stub: ${target.unit.qualifiedName}\n\`\`\`${fenceTag}\n${items[0].source}\n\`\`\``,
                        [
                            `Output format (use these exact section headers):`,
                            `### Implementation`,
                            `\`\`\`${fenceTag}`,
                            `export function ${target.unit.name}(...)${retExample} {`,
                            `    ...`,
                            `}`,
                            `\`\`\``,
                            `### Unit Check`,
                            `\`\`\`${fenceTag}`,
                            `test('${target.unit.name}', () => {`,
                            `    ...`,
                            `});`,
                            `\`\`\``,
                        ].join('\n'),
                    ].filter(Boolean);
                })();

            return promptParts.join('\n\n');
        };

        let includeSiblingsInPrompt = true;
        let basePrompt = formatForgePrompt([], [], true);
        let coreTokens = Math.ceil(basePrompt.length / 4);
        if (coreTokens > inputBudgetTokens && siblingSignatures.length > 0) {
            includeSiblingsInPrompt = false;
            basePrompt = formatForgePrompt([], [], false);
            coreTokens = Math.ceil(basePrompt.length / 4);
        }
        if (coreTokens > inputBudgetTokens) {
            throw new PacketError(`Target stub, cases, and feedback require about ${coreTokens} tokens, which exceeds the micro-packet budget of ${inputBudgetTokens}. Refusing oversized target.`);
        }

        const allCandidates: NeighborSignatureContext[] = [];
        const neighborSignatures: Record<string, { signature: string; sourceHash: string }> = {};
        if (ownerId && ownerDoc) {
            neighborSignatures[ownerId] = {
                signature: `class ${ownerClassName ?? ownerDoc.id}`,
                sourceHash: ownerDoc.sourceHash,
            };
        }

        for (const dependencyId of dependencies) {
            if (dependencyId === targetId || dependencyId === ownerId) continue;
            const dependency = findAnyUnit(snapshot, dependencyId);
            if (!dependency) continue;
            const depUnit = dependency.unit;
            let sig = depUnit.signature;
            if (!sig) {
                const params = depUnit.parameters ?? '';
                if (langKind === 'python') {
                    const ret = depUnit.returnAnnotation ? ` -> ${depUnit.returnAnnotation}` : '';
                    sig = `def ${depUnit.name}(${params})${ret}`;
                } else {
                    const ret = depUnit.returnAnnotation ? `: ${depUnit.returnAnnotation}` : '';
                    sig = `function ${depUnit.name}(${params})${ret}`;
                }
            }
            if (langKind === 'python' && sig.endsWith(':')) sig = sig.slice(0, -1).trimEnd();
            const promptSig = langKind === 'python' ? `${sig}:` : sig;
            const depIntent = textField(depUnit, 'intent');
            const depContract = textField(depUnit, 'contract');
            neighborSignatures[dependencyId] = { signature: sig, sourceHash: dependency.document.sourceHash };

            allCandidates.push({
                id: dependency.unit.id,
                path: dependency.document.path,
                qualifiedName: depUnit.qualifiedName,
                signature: promptSig,
                intent: depIntent,
                contract: depContract || undefined,
                sourceHash: dependency.document.sourceHash as `sha256:${string}`,
            });
        }

        const fitsBudget = (
            neighborList: readonly NeighborSignatureContext[],
            sigOnlyList: readonly NeighborSignatureContext[] = [],
            withSiblings = includeSiblingsInPrompt,
        ): boolean => Math.ceil(formatForgePrompt(neighborList, sigOnlyList, withSiblings).length / 4) <= inputBudgetTokens;

        let neighbors: NeighborSignatureContext[] = [];
        const signatureOnlyNeighbors: NeighborSignatureContext[] = [];
        const omittedNeighbors: string[] = [];

        if (allCandidates.length > 0) {
            if (fitsBudget(allCandidates)) {
                neighbors = [...allCandidates];
            } else {
                const compactCandidates = allCandidates.map(c => ({ ...c, contract: undefined }));
                if (fitsBudget(compactCandidates)) {
                    neighbors = compactCandidates;
                } else {
                    if (includeSiblingsInPrompt && fitsBudget(compactCandidates, [], false)) {
                        includeSiblingsInPrompt = false;
                        neighbors = compactCandidates;
                    } else {
                        const omittedCandidates: NeighborSignatureContext[] = [];
                        for (let i = 0; i < compactCandidates.length; i++) {
                            const candidate = compactCandidates[i];
                            if (fitsBudget([...neighbors, candidate], [...omittedCandidates, ...compactCandidates.slice(i + 1)])) {
                                neighbors.push(candidate);
                            } else {
                                omittedCandidates.push(candidate);
                                omittedNeighbors.push(candidate.qualifiedName);
                            }
                        }
                        for (const candidate of omittedCandidates) {
                            if (fitsBudget(neighbors, [...signatureOnlyNeighbors, candidate])) {
                                signatureOnlyNeighbors.push(candidate);
                            }
                        }
                    }
                }
            }
        }

        const prompt = formatForgePrompt(neighbors, signatureOnlyNeighbors, includeSiblingsInPrompt);
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
            occurrence: options?.occurrence,
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
            occurrence: options?.occurrence,
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
        if (langKind === 'python' && sig.endsWith(':')) sig = sig.slice(0, -1).trimEnd();
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
        FORGE_INPUT_BUDGET_TOKENS + DEFAULT_FORGE_OUTPUT_TOKENS,
        DEFAULT_FORGE_OUTPUT_TOKENS,
        { forge: true, inputBudgetTokens: FORGE_INPUT_BUDGET_TOKENS, boundInputs: true, ...options },
    );
}

export function stripModelEnvelope(value: string, language?: string): string {
    const trimmed = value.trim();
    const langKind = language ? forgeLanguageKind(language) : 'python';
    const fenceRegex = langKind === 'python'
        ? /^```(?:python)?\s*\n([\s\S]*?)\n```$/i
        : /^```(?:typescript|tsx?|javascript|jsx?)?\s*\n([\s\S]*?)\n```$/i;
    const fenced = trimmed.match(fenceRegex);
    return (fenced?.[1] ?? trimmed).trim();
}

export function parseForgeCandidate(raw: string, language?: string): ForgeCandidate {
    const text = raw.trim();
    const langKind = language ? forgeLanguageKind(language) : 'python';
    const testSplitRegex = langKind === 'python'
        ? /\n(?=(?:async\s+)?def\s+test_)/i
        : /\n(?=(?:(?:export\s+)?(?:(?:async\s+)?function\s+test\w*|(?:test|it|describe)\s*\()))/;
    const allFencesRegex = langKind === 'python'
        ? /```(?:python)?\s*\n([\s\S]*?)\n```/gi
        : /```(?:typescript|tsx?|javascript|jsx?|python)?\s*\n([\s\S]*?)\n```/gi;

    // 1. Check for explicit section headers: ### Implementation ... ### Unit Check ...
    const implHeaderRegex = /(?:^|\n)###\s*(?:Implementation|Function|Code)[\s\S]*?(?=(?:\n###\s*(?:Unit\s*Check|Check|Test|Tests|Pytest)|$))/i;
    const checkHeaderRegex = /(?:^|\n)###\s*(?:Unit\s*Check|Check|Test|Tests|Pytest)([\s\S]*)$/i;

    const implMatch = text.match(implHeaderRegex);
    const checkMatch = text.match(checkHeaderRegex);

    const sectionFenceRegex = langKind === 'python'
        ? /(?:^|\r?\n)```(?:python)?[ \t]*\r?\n([\s\S]*?)\r?\n```(?=[ \t]*(?:\r?\n|$))/i
        : /(?:^|\r?\n)```(?:typescript|tsx?|javascript|jsx?)?[ \t]*\r?\n([\s\S]*?)\r?\n```(?=[ \t]*(?:\r?\n|$))/i;
    const extractSectionCode = (sectionText: string): string => {
        const direct = stripModelEnvelope(sectionText, language);
        if (direct !== sectionText.trim()) return direct;
        const fenced = sectionText.match(sectionFenceRegex);
        return fenced ? fenced[1].trim() : direct;
    };

    if (implMatch) {
        const rawImpl = implMatch[0].replace(/(?:^|\n)###\s*(?:Implementation|Function|Code)\s*/i, '').trim();
        const strippedImpl = extractSectionCode(rawImpl);
        if (checkMatch) {
            const rawCheck = checkMatch[1].trim();
            return {
                implementation: strippedImpl,
                check: extractSectionCode(rawCheck) || undefined,
            };
        }
        const testSplit = strippedImpl.search(testSplitRegex);
        if (testSplit !== -1) {
            return {
                implementation: strippedImpl.slice(0, testSplit).trim(),
                check: strippedImpl.slice(testSplit).trim() || undefined,
            };
        }
        return {
            implementation: strippedImpl,
        };
    }

    // 2. Check for markdown code fences
    const fences = [...text.matchAll(allFencesRegex)].map(m => m[1].trim());
    if (fences.length >= 2) {
        return {
            implementation: fences[0],
            check: fences[1],
        };
    }
    if (fences.length === 1) {
        const single = fences[0];
        const testSplit = single.search(testSplitRegex);
        if (testSplit !== -1) {
            return {
                implementation: single.slice(0, testSplit).trim(),
                check: single.slice(testSplit).trim() || undefined,
            };
        }
        return {
            implementation: single,
        };
    }

    // 3. Check for single block with both target implementation and unit check
    const stripped = stripModelEnvelope(text, language);
    const testSplit = stripped.search(testSplitRegex);
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

function tsExportKind(signature?: string | null): 'default' | 'named' | 'none' {
    const trimmed = (signature ?? '').trimStart();
    if (trimmed.startsWith('export default ')) return 'default';
    if (trimmed.startsWith('export ')) return 'named';
    return 'none';
}

function validateTsOrJsForgeCandidate(
    targetUnit: ParsedUnit,
    candidate: ForgeCandidate,
    langKind: 'typescript' | 'javascript',
): CandidateValidationResult {
    const diagnostics: string[] = [];
    const needsJsx = Boolean(
        targetUnit.returnAnnotation?.includes('JSX')
        || containsJsxSyntax(candidate.implementation),
    );
    const implExt = langKind === 'javascript' ? (needsJsx ? '.jsx' : '.js') : (needsJsx ? '.tsx' : '.ts');
    const implText = candidate.implementation.endsWith('\n') ? candidate.implementation : `${candidate.implementation}\n`;
    const parsedImpl = parseTsModule(implText, `<candidate>${implExt}`, targetUnit.name);
    const langDisplay = langKind === 'typescript' ? 'TypeScript' : 'JavaScript';
    if (!parsedImpl.valid) {
        diagnostics.push(`Candidate implementation is not valid ${langDisplay}.`);
    }

    const implUnits = parsedImpl.units.filter(u => u.parentId === null);
    if (implUnits.length !== 1 || implUnits[0].name !== targetUnit.name) {
        diagnostics.push(`Candidate must contain exactly one definition named "${targetUnit.name}".`);
    }

    const implLines = cleanLines(candidate.implementation);
    const lineCount = implLines.length;
    if (lineCount === 0) {
        diagnostics.push('Candidate implementation is empty.');
    }
    if (lineCount > JPL60_MAX_LINES) {
        diagnostics.push(`Candidate exceeds JPL-60 limit of 60 lines (${lineCount} lines).`);
    }

    if (implUnits.length === 1 && implUnits[0].name === targetUnit.name) {
        const generatedUnit = implUnits[0];
        if (Boolean(generatedUnit.async) !== Boolean(targetUnit.async)) {
            diagnostics.push(`Candidate async modifier (${Boolean(generatedUnit.async)}) does not match target (${Boolean(targetUnit.async)}).`);
        }
        const expectedExport = tsExportKind(targetUnit.signature);
        const actualExport = tsExportKind(generatedUnit.signature);
        if (expectedExport !== actualExport) {
            diagnostics.push(`Candidate export modifier "${actualExport}" does not match target "${expectedExport}".`);
        }
        const targetParams = (targetUnit.params ?? []).filter(p => p.name !== 'self' && p.name !== 'this');
        const generatedParams = (generatedUnit.params ?? []).filter(p => p.name !== 'self' && p.name !== 'this');
        if (generatedParams.length !== targetParams.length) {
            diagnostics.push(`Candidate parameter count does not match target stub (expected ${targetParams.length}, got ${generatedParams.length}).`);
        } else {
            for (let i = 0; i < targetParams.length; i++) {
                const tp = targetParams[i];
                const gp = generatedParams[i];
                if (gp.name !== tp.name) {
                    diagnostics.push(`Candidate parameter ${i + 1} named "${gp.name}" does not match target parameter "${tp.name}".`);
                }
                if ((gp.kind ?? 'keyword') !== (tp.kind ?? 'keyword')) {
                    diagnostics.push(`Candidate parameter "${tp.name}" kind "${gp.kind ?? 'keyword'}" does not match target "${tp.kind ?? 'keyword'}".`);
                }
                if ((gp.default ?? '').trim() !== (tp.default ?? '').trim()) {
                    diagnostics.push(`Candidate parameter "${tp.name}" default/optional value "${gp.default ?? ''}" does not match target "${tp.default ?? ''}".`);
                }
                if (langKind === 'typescript' && (gp.annotation ?? '').trim() !== (tp.annotation ?? '').trim()) {
                    diagnostics.push(`Candidate parameter "${tp.name}" type annotation "${gp.annotation ?? ''}" does not match target "${tp.annotation ?? ''}".`);
                }
            }
        }
        if (langKind === 'typescript') {
            const expectedRet = (targetUnit.returnAnnotation ?? '').trim();
            const actualRet = (generatedUnit.returnAnnotation ?? '').trim();
            const explicitRetRe = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\b[^(]*\([^)]*\)|const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:async\s*)?\([^)]*\))\s*:\s*JSX\.Element\b/;
            const inferredJsxFromUntypedComponent = expectedRet === '' && actualRet === 'JSX.Element' && needsJsx && !explicitRetRe.test(candidate.implementation);
            if (expectedRet !== actualRet && !inferredJsxFromUntypedComponent) {
                diagnostics.push(`Candidate return type annotation "${actualRet}" does not match target "${expectedRet}".`);
            }
        }
    }

    let checkLineCount: number | undefined;
    if (candidate.check) {
        const checkExt = langKind === 'javascript' ? '.js' : '.ts';
        const checkText = candidate.check.endsWith('\n') ? candidate.check : `${candidate.check}\n`;
        const parsedCheck = parseTsModule(checkText, `<check>${checkExt}`);
        if (!parsedCheck.valid) {
            diagnostics.push(`Candidate unit check is not valid ${langDisplay}.`);
        } else {
            const hasTestCall = /\b(?:test|it|describe)\s*\(/.test(checkText)
                || parsedCheck.units.some(u => u.parentId === null && u.kind === 'function' && u.name.startsWith('test'));
            if (!hasTestCall) {
                diagnostics.push('Candidate unit check must define at least one test case (e.g. test(...) or function test_...()).');
            }
        }
        checkLineCount = cleanLines(candidate.check).length;
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

export function validateForgeCandidate(
    targetUnit: ParsedUnit,
    candidate: ForgeCandidate,
    language?: string,
): CandidateValidationResult {
    const langKind = language ? forgeLanguageKind(language) : 'python';
    if (langKind !== 'python') {
        return validateTsOrJsForgeCandidate(targetUnit, candidate, langKind);
    }
    const diagnostics: string[] = [];
    const hoisted = hoistPythonCandidateImports(candidate.implementation, candidate.check);
    if (hoisted.forbiddenImports.length > 0) {
        diagnostics.push(
            `Candidate must not import internal Slate modules (${hoisted.forbiddenImports.join(', ')}); target and dependency functions are already in scope.`,
        );
    }

    // 1. Implementation syntax & single function definition
    const cleanImpl = hoisted.implementation;
    const implText = cleanImpl.endsWith('\n') ? cleanImpl : `${cleanImpl}\n`;
    const parsedImpl = parseModule(implText, '<candidate>', targetUnit.name);
    if (!parsedImpl.valid) {
        diagnostics.push('Candidate implementation is not valid Python.');
    }

    const rawDeps = Array.isArray(targetUnit.annotation?.dependencies)
        ? targetUnit.annotation.dependencies
        : [
            ...(Array.isArray(targetUnit.annotation?.context) ? targetUnit.annotation.context : []),
            ...(Array.isArray(targetUnit.annotation?.uses) ? targetUnit.annotation.uses : []),
        ];
    const declaredDepNames = new Set(
        rawDeps
            .filter((dep): dep is string => typeof dep === 'string')
            .map(dep => dep.split('/').pop()?.trim() ?? '')
            .filter(name => name.length > 0 && name !== targetUnit.name),
    );
    if (declaredDepNames.size > 0 && parsedImpl.valid) {
        const redefined = Array.from(new Set(
            findNestedPythonDefinitions(implText).filter(name => declaredDepNames.has(name)),
        ));
        if (redefined.length > 0) {
            diagnostics.push(
                `Candidate must call declared dependencies (${redefined.join(', ')}) already in scope instead of redefining them locally.`,
            );
        }
    }

    const implUnits = parsedImpl.units.filter(u => u.parentId === null);
    if (implUnits.length !== 1 || implUnits[0].name !== targetUnit.name) {
        diagnostics.push(`Candidate must contain exactly one function definition named "${targetUnit.name}".`);
    }

    const implLines = cleanLines(cleanImpl);
    const lineCount = implLines.length;
    if (lineCount === 0) {
        diagnostics.push('Candidate implementation is empty.');
    }

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
        ...(hoisted.imports.length > 0 ? { hoistedImports: hoisted.imports } : {}),
        normalizedImplementation: cleanImpl,
    };
}
