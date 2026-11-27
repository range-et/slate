import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
    buildForgePacket,
    PacketError,
    parseForgeCandidate,
    validateForgeCandidate,
    type GenerationPacket,
} from './generation';
import type { HarnessDocument, HarnessSnapshot, NodeVerificationResult, ParsedUnit } from './harness_protocol';
import {
    clampForgeConcurrency,
} from './forge_concurrency';
import {
    evaluateProjectCredentialAccess,
    resolveLlmConfig,
    streamLlamaCompletion,
    validateLlmEndpointUrl,
    type LlmConfigInput,
} from './llama_transport';
import { tryNormalizeLanguage } from './language_types';
import { sourceHash } from './python_adapter';
import {
    assertSafeNodeId as assertSafeRelativeNodeId,
    codeLines,
    codeText,
    CONFIG_PATH,
    indexNode,
    nodeIdForPath,
    NODES_DIR,
    parseConfig,
    parseNode,
    pathForNodeId,
    serializeNode,
    validateNodeStub,
    type SlateConfig,
    type SlateLlmProvider,
    type SlateNode,
} from './slate_folder';
import { collectExpandedDependencies, runNodeVerification, type VerificationOptions } from './verification_runner';

export const BATCH_FORGE_SYSTEM_PROMPT =
    'You are a constrained local Python component forge engine. Follow JPL-60 rules strictly, provide concise implementation and pytest check (no docstrings or prose), and never import from slate.* or redefine dependencies already in scope.';

export const TS_BATCH_FORGE_SYSTEM_PROMPT =
    'You are a constrained local TypeScript/JavaScript component forge engine. Follow JPL-60 rules strictly and provide a concise typed implementation and standalone test() unit check (no JSDoc, prose, or redefinition of dependencies already in scope).';

type BatchForgeLanguage = 'python' | 'typescript' | 'javascript';

function batchForgeLanguage(lang?: string): BatchForgeLanguage | null {
    const norm = lang ? tryNormalizeLanguage(lang) : 'python';
    if (norm === 'python' || norm === 'typescript' || norm === 'javascript') return norm;
    return null;
}

export interface BatchForgeOptions {
    workspaceRoot: string;
    nodeIds?: string[];
    allStubs?: boolean;
    concurrency?: number;
    maxRevisions?: number;
    verify?: boolean;
    write?: boolean;
    overwrite?: boolean;
    llmOverride?: LlmConfigInput;
    fallbackLlm?: LlmConfigInput;
    env?: Readonly<Record<string, string | undefined>>;
    verifyTimeoutMs?: number;
    pythonPath?: string;
    isTrusted?: boolean;
    approvedCredentialPairings?: ReadonlySet<string> | readonly string[];
    executeCommand?: VerificationOptions['executeCommand'];
    signal?: AbortSignal;
    onNodeForged?: (nodeId: string) => Promise<void> | void;
}

export interface BatchForgeNodeResult {
    nodeId: string;
    status: 'forged' | 'failed' | 'skipped';
    reason?: string;
    attempts: number;
    lineCount?: number;
    checkLineCount?: number;
    estimatedInputTokens?: number;
    verification?: NodeVerificationResult;
    written: boolean;
    durationMs: number;
    proposedCode?: string;
    proposedCheck?: string;
    proposedImports?: string[];
}

export interface BatchForgeResult {
    ok: boolean;
    provider: SlateLlmProvider;
    endpoint: string;
    model: string;
    hasApiKey: boolean;
    concurrency: number;
    waves: number;
    total: number;
    forgedCount: number;
    failedCount: number;
    skippedCount: number;
    totalAttempts: number;
    totalDurationMs: number;
    results: BatchForgeNodeResult[];
}

interface IndexedTarget {
    nodeId: string;
    relPath: string;
    fullPath: string;
    node: SlateNode;
    unit: ParsedUnit;
    initialHash: string;
    initialInputFingerprint: string;
    language: BatchForgeLanguage;
}

interface WaveForgeContext {
    waveStartNodes: ReadonlyMap<string, SlateNode>;
    waveWrittenText: Map<string, string>;
}

function collectTransitiveDependencies(
    rootId: string,
    rootNode: SlateNode,
    nodesById: ReadonlyMap<string, SlateNode>,
): { dependencies: Map<string, SlateNode>; missingDeps: string[] } {
    return collectExpandedDependencies(rootId, rootNode, nodesById);
}

/**
 * Partitions targets into topological execution waves across transitive `context` + `uses` dependencies
 * (including chains passing through already-implemented non-target nodes when `allNodesById` is supplied).
 * Cycles are broken deterministically into a final wave sorted by `nodeId`.
 */
export function partitionTargetsIntoWaves<T extends { target: { nodeId: string; node: SlateNode } }>(
    items: readonly T[],
    allNodesById?: ReadonlyMap<string, SlateNode>,
): T[][] {
    if (items.length === 0) return [];
    const byId = new Map<string, T>();
    const lookupNodes = new Map<string, SlateNode>(allNodesById ?? []);
    for (const item of items) {
        byId.set(item.target.nodeId, item);
        lookupNodes.set(item.target.nodeId, item.target.node);
    }
    const initTargetByOwner = new Map<string, string>();
    for (const item of items) {
        if (item.target.node.classOwner && item.target.node.name === '__init__') {
            initTargetByOwner.set(item.target.node.classOwner, item.target.nodeId);
        }
    }
    const remaining = new Set<string>(byId.keys());
    const depsById = new Map<string, Set<string>>();
    for (const item of items) {
        const transitive = collectTransitiveDependencies(item.target.nodeId, item.target.node, lookupNodes);
        const internalDeps = new Set<string>();
        for (const depId of transitive.dependencies.keys()) {
            if (depId !== item.target.nodeId && byId.has(depId)) {
                const depNode = lookupNodes.get(depId);
                // Sibling non-__init__ methods should not block each other or cycle; only __init__ runs in an earlier wave.
                if (
                    item.target.node.classOwner
                    && depNode?.classOwner === item.target.node.classOwner
                    && depNode.name !== '__init__'
                ) {
                    continue;
                }
                internalDeps.add(depId);
            }
        }
        if (item.target.node.classOwner && item.target.node.name !== '__init__') {
            const initId = initTargetByOwner.get(item.target.node.classOwner);
            if (initId && initId !== item.target.nodeId) {
                internalDeps.add(initId);
            }
        }
        depsById.set(item.target.nodeId, internalDeps);
    }

    const waves: T[][] = [];
    while (remaining.size > 0) {
        const readyIds: string[] = [];
        for (const id of remaining) {
            const deps = depsById.get(id)!;
            let hasUnmet = false;
            for (const depId of deps) {
                if (remaining.has(depId)) {
                    hasUnmet = true;
                    break;
                }
            }
            if (!hasUnmet) {
                readyIds.push(id);
            }
        }
        readyIds.sort((a, b) => a.localeCompare(b));
        if (readyIds.length === 0) {
            const cycleIds = Array.from(remaining).sort((a, b) => a.localeCompare(b));
            waves.push(cycleIds.map(id => byId.get(id)!));
            break;
        }
        waves.push(readyIds.map(id => byId.get(id)!));
        for (const id of readyIds) {
            remaining.delete(id);
        }
    }
    return waves;
}

/** Compacts verbose pytest/validation tracebacks for low-token Frontier Architect replies. */
export function compactFailureReason(raw: string, maxChars = 360): string {
    const clean = raw
        .replace(/\u001b\[[0-9;]*m/g, '')
        .replace(/\r\n?/g, '\n')
        .trim();
    if (!clean) return 'Verification failed.';

    const lines = clean
        .split('\n')
        .map(line => line
            .replace(/[A-Za-z]:\\[^\s:]*?\.slate[\\/]+build[\\/]+verify[\\/]+[^\s:]+/g, '<verify>')
            .replace(/\/[^\s:]*?\.slate\/build\/verify\/[^\s:]+/g, '<verify>')
            .trimEnd())
        .filter(line => {
            const trimmed = line.trim();
            if (!trimmed) return false;
            if (/^=+$/.test(trimmed) || /^_+$/.test(trimmed) || /^-+$/.test(trimmed)) return false;
            if (/^=+\s*(?:FAILURES|ERRORS|short test summary info|test session starts)\s*=+$/i.test(trimmed)) return false;
            return true;
        });

    const signalRe = /^(?:FAILED\s|ERROR\s|E\s{2,}|Candidate\s|>?\s*assert\s|Input should be\b|.*(?:AssertionError|ValueError|TypeError|ZeroDivisionError|ModuleNotFoundError|ImportError|NameError|ValidationError|SyntaxError))/;
    const prioritized = lines.filter(l => signalRe.test(l.trim()));
    const chosen = prioritized.length > 0 ? prioritized : lines.slice(-10);
    let compact = chosen.join('\n').trim();
    if (!compact) compact = clean;
    if (compact.length > maxChars) {
        compact = `${compact.slice(0, maxChars - 3).trimEnd()}...`;
    }
    return compact;
}

/** Formats a compact batch forge summary omitting raw tracebacks and already-written code payloads. */
export function compactBatchForgeResult(result: BatchForgeResult): Record<string, unknown> {
    return {
        ok: result.ok,
        provider: result.provider,
        endpoint: result.endpoint,
        model: result.model,
        hasApiKey: result.hasApiKey,
        concurrency: result.concurrency,
        waves: result.waves,
        total: result.total,
        forgedCount: result.forgedCount,
        failedCount: result.failedCount,
        skippedCount: result.skippedCount,
        totalAttempts: result.totalAttempts,
        totalDurationMs: result.totalDurationMs,
        results: result.results.map(item => {
            const verification = item.verification
                ? {
                    state: item.verification.state,
                    ...(item.verification.pydanticValid !== undefined ? { pydanticValid: item.verification.pydanticValid } : {}),
                    ...(item.verification.testsPassed !== undefined ? { testsPassed: item.verification.testsPassed } : {}),
                    ...(item.verification.testsTotal !== undefined ? { testsTotal: item.verification.testsTotal } : {}),
                    ...(item.verification.survivingMutants !== undefined ? { survivingMutants: item.verification.survivingMutants } : {}),
                    ...(item.verification.totalMutants !== undefined ? { totalMutants: item.verification.totalMutants } : {}),
                }
                : undefined;
            return {
                nodeId: item.nodeId,
                status: item.status,
                attempts: item.attempts,
                written: item.written,
                durationMs: item.durationMs,
                ...(item.lineCount !== undefined ? { lineCount: item.lineCount } : {}),
                ...(item.checkLineCount !== undefined ? { checkLineCount: item.checkLineCount } : {}),
                ...(item.estimatedInputTokens !== undefined ? { estimatedInputTokens: item.estimatedInputTokens } : {}),
                ...(verification ? { verification } : {}),
                ...(item.status !== 'forged' && item.reason ? { reason: compactFailureReason(item.reason) } : {}),
                ...(!item.written && item.status === 'forged' && item.proposedCode !== undefined ? { proposedCode: item.proposedCode } : {}),
                ...(!item.written && item.status === 'forged' && item.proposedCheck !== undefined ? { proposedCheck: item.proposedCheck } : {}),
                ...(!item.written && item.status === 'forged' && item.proposedImports !== undefined ? { proposedImports: item.proposedImports } : {}),
            };
        }),
    };
}

function computeForgeInputFingerprint(
    node: SlateNode,
    dependencies: ReadonlyMap<string, SlateNode>,
    missingDependencyIds: readonly string[] = [],
): string {
    const depPayload = Array.from(dependencies.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([depId, dep]) => [
            depId,
            {
                language: dep.language ?? null,
                intent: dep.intent,
                contract: dep.contract,
                imports: dep.imports,
                code: codeLines(codeText(dep)),
            },
        ]);
    const payload = {
        language: node.language ?? null,
        kind: node.kind ?? null,
        classOwner: node.classOwner ?? null,
        intent: node.intent,
        contract: node.contract,
        cases: node.cases ?? [],
        check: node.check ?? [],
        context: node.context,
        uses: node.uses,
        imports: node.imports,
        locked: node.locked,
        code: codeLines(codeText(node)),
        dependencies: depPayload,
        missingDependencies: [...missingDependencyIds].sort(),
    };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(value)));
}

function assertSafeNodeId(workspaceRoot: string, rawId: string): { nodeId: string; relPath: string; fullPath: string } {
    const normalized = assertSafeRelativeNodeId(rawId);
    const relPath = pathForNodeId(normalized);
    const nodesRoot = path.resolve(workspaceRoot, NODES_DIR);
    const fullPath = path.resolve(workspaceRoot, relPath);
    const rel = path.relative(nodesRoot, fullPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Path traversal rejected: "${rawId}" escapes "${NODES_DIR}".`);
    }
    return { nodeId: normalized, relPath, fullPath };
}

async function discoverNodeFiles(workspaceRoot: string): Promise<string[]> {
    const nodesRoot = path.join(workspaceRoot, ...NODES_DIR.split('/'));
    const results: string[] = [];

    async function walk(dir: string): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else if (entry.isFile() && entry.name.endsWith('.json')) {
                results.push(path.relative(workspaceRoot, full).replace(/\\/g, '/'));
            }
        }
    }

    await walk(nodesRoot);
    return results.sort();
}

function buildBoundedForgePacket(
    snapshot: HarnessSnapshot,
    sources: ReadonlyMap<string, string>,
    nodeId: string,
    retryFeedback?: string,
    language?: BatchForgeLanguage,
): GenerationPacket {
    if (!retryFeedback?.trim()) {
        return buildForgePacket(snapshot, sources, nodeId, language ? { language } : undefined);
    }
    let current = retryFeedback.trim();
    if (current.length > 600) {
        current = `...${current.slice(-597)}`;
    }
    while (current.length >= 40) {
        try {
            return buildForgePacket(snapshot, sources, nodeId, { retryFeedback: current, language });
        } catch (error) {
            if (!(error instanceof PacketError) || !error.message.includes('micro-packet budget')) {
                throw error;
            }
            const nextLen = Math.floor(current.length / 2);
            if (nextLen < 40) break;
            current = `...${current.slice(-nextLen)}`;
        }
    }
    return buildForgePacket(snapshot, sources, nodeId, language ? { language } : undefined);
}

function summarizeVerificationFailure(verification: NodeVerificationResult): string {
    if (verification.state === 'mutant_survived') {
        const detail = verification.mutantDiff || verification.diagnostics?.join('; ') || 'Mutant survived.';
        return `Mutmut detected surviving mutant:\n${detail}`;
    }
    return verification.traceback || verification.diagnostics?.join('; ') || 'Verification failed.';
}

async function forgeSingleTarget(
    target: IndexedTarget,
    snapshot: HarnessSnapshot,
    sources: ReadonlyMap<string, string>,
    nodesById: ReadonlyMap<string, SlateNode>,
    llm: ReturnType<typeof resolveLlmConfig>,
    config: SlateConfig,
    options: BatchForgeOptions,
    maxRevisions: number,
    waveContext: WaveForgeContext,
): Promise<BatchForgeNodeResult> {
    const startMs = Date.now();
    const shouldVerify = options.verify !== false;
    const shouldWrite = options.write !== false;

    const { dependencies } = collectTransitiveDependencies(target.nodeId, target.node, nodesById);

    let retryFeedback: string | undefined;
    let lastReason = 'Forge did not produce a valid candidate.';
    let lastVerification: NodeVerificationResult | undefined;
    let lastEstimatedTokens: number | undefined;
    let attemptsRun = 0;

    for (let attempt = 1; attempt <= maxRevisions; attempt++) {
        if (options.signal?.aborted) {
            return {
                nodeId: target.nodeId,
                status: 'failed',
                reason: 'Batch forge cancelled.',
                attempts: attemptsRun,
                written: false,
                durationMs: Date.now() - startMs,
            };
        }

        attemptsRun = attempt;
        let packet: GenerationPacket;
        try {
            packet = buildBoundedForgePacket(snapshot, sources, target.nodeId, retryFeedback, target.language);
            lastEstimatedTokens = packet.estimatedInputTokens;
        } catch (error) {
            lastReason = error instanceof Error ? error.message : String(error);
            break;
        }

        let raw: string;
        let finishReason: string | undefined;
        try {
            raw = await streamLlamaCompletion(
                packet.prompt,
                {
                    endpoint: llm.endpoint,
                    model: llm.model,
                    outputTokens: llm.outputTokens,
                    timeoutMs: llm.timeoutMs,
                    apiKey: llm.apiKey,
                    system: target.language === 'python' ? BATCH_FORGE_SYSTEM_PROMPT : TS_BATCH_FORGE_SYSTEM_PROMPT,
                    onFinishReason: reason => { finishReason = reason; },
                },
                options.signal ?? new AbortController().signal,
                () => {},
            );
        } catch (error) {
            lastReason = error instanceof Error ? error.message : String(error);
            if (options.signal?.aborted) break;
            continue;
        }

        const candidate = parseForgeCandidate(raw, target.language);
        const validation = validateForgeCandidate(target.unit, candidate, target.language);
        if (finishReason === 'length') {
            const detail = validation.valid
                ? 'Response hit max_tokens before completing both Implementation and Unit Check.'
                : validation.diagnostics.join('; ');
            lastReason = `Output truncated at max_tokens=${llm.outputTokens} (finish_reason=length): ${detail}`;
            retryFeedback = `Previous output was truncated at max_tokens=${llm.outputTokens} before finishing. Omit docstrings/comments and write compact, programmatic unit tests (e.g. comprehensions instead of large literal grids). ${validation.valid ? 'Ensure both sections finish cleanly.' : `Validation error: ${detail}`}`;
            continue;
        }
        if (!validation.valid) {
            lastReason = validation.diagnostics.join('; ');
            retryFeedback = `Candidate validation failed:\n${lastReason}`;
            continue;
        }

        const normalizedImpl = validation.normalizedImplementation ?? candidate.implementation;
        const hoistedImports = validation.hoistedImports ?? [];
        const mergedTargetImports = Array.from(new Set([...target.node.imports, ...hoistedImports]));

        let verification: NodeVerificationResult | undefined;
        if (shouldVerify) {
            const candidateNode: SlateNode = {
                ...target.node,
                imports: mergedTargetImports,
                code: codeLines(normalizedImpl),
                check: candidate.check ? codeLines(candidate.check) : target.node.check,
            };
            verification = await runNodeVerification({
                workspaceRoot: options.workspaceRoot,
                node: candidateNode,
                nodeId: target.nodeId,
                dependencies,
                isTrusted: options.isTrusted === true,
                timeoutMs: options.verifyTimeoutMs ?? 30000,
                pythonPath: options.pythonPath ?? config.pythonPath,
                language: target.language,
                executeCommand: options.executeCommand,
                signal: options.signal,
            });
            lastVerification = verification;

            if (verification.state === 'failed' || verification.state === 'mutant_survived') {
                const failureSummary = summarizeVerificationFailure(verification);
                lastReason = failureSummary;
                retryFeedback = verification.state === 'mutant_survived'
                    ? failureSummary
                    : compactFailureReason(failureSummary, 480);
                continue;
            }
        }

        let written = false;
        if (shouldWrite) {
            let diskNode: SlateNode;
            try {
                const currentText = await fs.promises.readFile(target.fullPath, 'utf8');
                diskNode = parseNode(currentText);
            } catch (error) {
                return {
                    nodeId: target.nodeId,
                    status: 'failed',
                    reason: `Cannot re-read "${target.relPath}" before writing: ${error instanceof Error ? error.message : String(error)}`,
                    attempts: attemptsRun,
                    lineCount: validation.lineCount,
                    checkLineCount: validation.checkLineCount,
                    estimatedInputTokens: lastEstimatedTokens,
                    verification,
                    written: false,
                    durationMs: Date.now() - startMs,
                };
            }

            if (diskNode.locked) {
                return {
                    nodeId: target.nodeId,
                    status: 'skipped',
                    reason: 'Node was locked on disk while forging.',
                    attempts: attemptsRun,
                    written: false,
                    durationMs: Date.now() - startMs,
                };
            }

            const currentDeps = new Map<string, SlateNode>();
            const currentMissing = new Set<string>();
            const diskVisiting = new Set<string>([target.nodeId]);
            const diskVisited = new Set<string>();
            const visitDiskDep = async (depId: string): Promise<void> => {
                if (depId === target.nodeId || diskVisiting.has(depId) || diskVisited.has(depId)) return;
                let depNode: SlateNode;
                try {
                    const safeDep = assertSafeNodeId(options.workspaceRoot, depId);
                    const depText = await fs.promises.readFile(safeDep.fullPath, 'utf8');
                    const waveOwnedText = waveContext.waveWrittenText.get(depId);
                    const waveBaseline = waveContext.waveStartNodes.get(depId);
                    depNode = (waveOwnedText !== undefined && waveOwnedText === depText && waveBaseline)
                        ? waveBaseline
                        : parseNode(depText);
                } catch {
                    currentMissing.add(depId);
                    diskVisited.add(depId);
                    return;
                }
                diskVisiting.add(depId);
                for (const subId of [...depNode.context, ...depNode.uses]) {
                    await visitDiskDep(subId);
                }
                if (depNode.kind === 'class') {
                    for (const [candidateId, candidateNode] of waveContext.waveStartNodes) {
                        if (candidateNode.classOwner === depId) {
                            await visitDiskDep(candidateId);
                        }
                    }
                }
                if (depNode.classOwner) {
                    await visitDiskDep(depNode.classOwner);
                }
                diskVisiting.delete(depId);
                diskVisited.add(depId);
                currentDeps.set(depId, depNode);
            };
            const diskExtraSeeds: string[] = [];
            if (diskNode.classOwner) {
                diskExtraSeeds.push(diskNode.classOwner);
                for (const [candidateId, candidateNode] of waveContext.waveStartNodes) {
                    if (candidateNode.classOwner === diskNode.classOwner && candidateId !== target.nodeId) {
                        diskExtraSeeds.push(candidateId);
                    }
                }
            }
            for (const depId of [...diskNode.context, ...diskNode.uses, ...diskExtraSeeds]) {
                await visitDiskDep(depId);
            }
            const currentHash = sourceHash(codeText(diskNode));
            const currentFingerprint = computeForgeInputFingerprint(diskNode, currentDeps, Array.from(currentMissing).sort());
            if (currentHash !== target.initialHash || currentFingerprint !== target.initialInputFingerprint) {
                return {
                    nodeId: target.nodeId,
                    status: 'failed',
                    reason: `Node "${target.nodeId}" or its verification inputs/dependencies changed on disk while forging; skipped write to avoid overwriting concurrent edits.`,
                    attempts: attemptsRun,
                    lineCount: validation.lineCount,
                    checkLineCount: validation.checkLineCount,
                    estimatedInputTokens: lastEstimatedTokens,
                    verification,
                    written: false,
                    durationMs: Date.now() - startMs,
                    proposedCode: normalizedImpl,
                    proposedCheck: candidate.check,
                    ...(mergedTargetImports.length > 0 ? { proposedImports: mergedTargetImports } : {}),
                };
            }

            diskNode.code = codeLines(normalizedImpl);
            diskNode.imports = Array.from(new Set([...diskNode.imports, ...hoistedImports]));
            if (candidate.check) {
                diskNode.check = codeLines(candidate.check);
            }
            if (verification) {
                diskNode.verification = {
                    ...verification,
                    sourceHash: sourceHash(codeText(diskNode)),
                    ...(attemptsRun > 1 ? { retryCount: attemptsRun - 1 } : {}),
                };
            }
            const serialized = serializeNode(diskNode);
            await fs.promises.writeFile(target.fullPath, serialized, 'utf8');
            waveContext.waveWrittenText.set(target.nodeId, serialized);
            written = true;
            await options.onNodeForged?.(target.nodeId);
        }

        return {
            nodeId: target.nodeId,
            status: 'forged',
            attempts: attemptsRun,
            lineCount: validation.lineCount,
            checkLineCount: validation.checkLineCount,
            estimatedInputTokens: lastEstimatedTokens,
            verification,
            written,
            durationMs: Date.now() - startMs,
            ...(shouldWrite ? {} : {
                proposedCode: normalizedImpl,
                proposedCheck: candidate.check,
                ...(mergedTargetImports.length > 0 ? { proposedImports: mergedTargetImports } : {}),
            }),
        };
    }

    return {
        nodeId: target.nodeId,
        status: 'failed',
        reason: lastReason,
        attempts: attemptsRun,
        estimatedInputTokens: lastEstimatedTokens,
        verification: lastVerification,
        written: false,
        durationMs: Date.now() - startMs,
    };
}

/**
 * Statelessly batch-forges atomic stubs using bounded micro-packets (`<= 600` tokens),
 * JPL-60 validation, optional Pydantic+pytest verification, and bounded revision retries.
 */
export async function batchForgeWorkspace(options: BatchForgeOptions): Promise<BatchForgeResult> {
    const configPath = path.join(options.workspaceRoot, ...CONFIG_PATH.split('/'));
    let configText: string;
    try {
        configText = await fs.promises.readFile(configPath, 'utf8');
    } catch (error) {
        throw new Error(`Cannot read ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const config = parseConfig(configText);
    const llm = resolveLlmConfig(
        config.llm,
        options.fallbackLlm,
        options.env ?? process.env,
        options.llmOverride,
    );
    validateLlmEndpointUrl(llm.endpoint);
    const trusted = options.isTrusted === true;
    const access = evaluateProjectCredentialAccess({
        projectLlm: config.llm,
        override: options.llmOverride,
        fallback: options.fallbackLlm,
        resolved: llm,
        isTrusted: trusted,
        approvedPairings: options.approvedCredentialPairings,
    });
    if (!access.allowRequest) {
        throw new Error(access.reason ?? 'Workspace is not trusted; refusing request to configured LLM endpoint.');
    }
    if (access.requiresApproval && !access.allowCredential) {
        throw new Error(access.reason ?? 'Explicit user approval required before sending credentials to configured LLM endpoint.');
    }
    if (options.verify !== false && !trusted) {
        throw new Error('Workspace is not trusted; refusing to run batch forge verification in an untrusted workspace.');
    }

    const concurrency = clampForgeConcurrency(options.concurrency, clampForgeConcurrency(llm.concurrency, 3));
    const maxRevisions = clampInt(options.maxRevisions, 1, 5, 3);

    const requestedIds = Array.isArray(options.nodeIds)
        ? Array.from(new Set(options.nodeIds.map(id => id.trim()).filter(Boolean)))
        : [];
    const safeRequested = requestedIds.map(raw => assertSafeNodeId(options.workspaceRoot, raw));

    const nodeFiles = await discoverNodeFiles(options.workspaceRoot);
    const documents: HarnessDocument[] = [];
    const sources = new Map<string, string>();
    const nodesById = new Map<string, SlateNode>();
    const docById = new Map<string, HarnessDocument>();
    const parseErrors = new Map<string, string>();

    for (const relPath of nodeFiles) {
        const nodeId = nodeIdForPath(relPath);
        if (!nodeId) continue;
        const fullPath = path.join(options.workspaceRoot, ...relPath.split('/'));
        const text = await fs.promises.readFile(fullPath, 'utf8');
        const indexed = indexNode(relPath, text, config.language, null);
        documents.push(indexed.document);
        sources.set(relPath, indexed.code);
        docById.set(nodeId, indexed.document);
        if (indexed.node) {
            nodesById.set(nodeId, indexed.node);
        } else {
            parseErrors.set(
                nodeId,
                indexed.document.diagnostics[0]?.message ?? `Failed to parse "${relPath}".`,
            );
        }
    }

    const snapshot: HarnessSnapshot = {
        revision: 1,
        projectName: config.name,
        documents,
    };

    const results: BatchForgeNodeResult[] = [];
    const activeTargets: Array<{ resultIndex: number; target: IndexedTarget }> = [];

    if (safeRequested.length > 0) {
        for (const req of safeRequested) {
            const parseErr = parseErrors.get(req.nodeId);
            if (parseErr) {
                results.push({
                    nodeId: req.nodeId,
                    status: 'failed',
                    reason: parseErr,
                    attempts: 0,
                    written: false,
                    durationMs: 0,
                });
                continue;
            }

            const node = nodesById.get(req.nodeId);
            const doc = docById.get(req.nodeId);
            if (!node || !doc) {
                results.push({
                    nodeId: req.nodeId,
                    status: 'failed',
                    reason: `Node "${req.nodeId}" does not exist.`,
                    attempts: 0,
                    written: false,
                    durationMs: 0,
                });
                continue;
            }

            const nodeLang = node.language ?? config.language;
            const canonicalLang = batchForgeLanguage(nodeLang);
            if (node.kind) {
                results.push({
                    nodeId: req.nodeId,
                    status: 'skipped',
                    reason: node.kind === 'class'
                        ? 'Class frame node cannot be forged directly; forge its owned method nodes instead.'
                        : `Module ${node.kind} node cannot be forged as an atomic function.`,
                    attempts: 0,
                    written: false,
                    durationMs: 0,
                });
                continue;
            }
            if (!canonicalLang) {
                results.push({
                    nodeId: req.nodeId,
                    status: 'skipped',
                    reason: `Language "${nodeLang}" is not supported by batch forge.`,
                    attempts: 0,
                    written: false,
                    durationMs: 0,
                });
                continue;
            }
            if (node.locked) {
                results.push({
                    nodeId: req.nodeId,
                    status: 'skipped',
                    reason: 'Node is locked.',
                    attempts: 0,
                    written: false,
                    durationMs: 0,
                });
                continue;
            }

            if (!options.overwrite) {
                const stubCheck = validateNodeStub(node, canonicalLang);
                if (!stubCheck.valid) {
                    results.push({
                        nodeId: req.nodeId,
                        status: 'skipped',
                        reason: 'Node already has an implementation (set overwrite: true to regenerate).',
                        attempts: 0,
                        written: false,
                        durationMs: 0,
                    });
                    continue;
                }
            }

            const unit = doc.units.find(u => u.id === req.nodeId);
            if (!unit || unit.identity !== 'durable' || !['function', 'method'].includes(unit.kind)) {
                results.push({
                    nodeId: req.nodeId,
                    status: 'failed',
                    reason: `Node "${req.nodeId}" does not define a valid durable function or method.`,
                    attempts: 0,
                    written: false,
                    durationMs: 0,
                });
                continue;
            }

            const resultIndex = results.length;
            results.push({
                nodeId: req.nodeId,
                status: 'failed',
                attempts: 0,
                written: false,
                durationMs: 0,
            });
            const initialDeps = collectTransitiveDependencies(req.nodeId, node, nodesById);
            activeTargets.push({
                resultIndex,
                target: {
                    nodeId: req.nodeId,
                    relPath: req.relPath,
                    fullPath: req.fullPath,
                    node,
                    unit,
                    initialHash: doc.sourceHash,
                    initialInputFingerprint: computeForgeInputFingerprint(node, initialDeps.dependencies, initialDeps.missingDeps),
                    language: canonicalLang,
                },
            });
        }
    } else if (options.allStubs !== false) {
        const sortedIds = Array.from(nodesById.keys()).sort();
        for (const nodeId of sortedIds) {
            const node = nodesById.get(nodeId)!;
            const doc = docById.get(nodeId)!;
            const nodeLang = node.language ?? config.language;
            const canonicalLang = batchForgeLanguage(nodeLang);
            if (node.kind || !canonicalLang || node.locked) continue;
            const unit = doc.units.find(u => u.id === nodeId);
            if (!unit || unit.identity !== 'durable' || !['function', 'method'].includes(unit.kind)) continue;
            if (!validateNodeStub(node, canonicalLang).valid) continue;

            const safe = assertSafeNodeId(options.workspaceRoot, nodeId);
            const resultIndex = results.length;
            results.push({
                nodeId,
                status: 'failed',
                attempts: 0,
                written: false,
                durationMs: 0,
            });
            const initialDeps = collectTransitiveDependencies(nodeId, node, nodesById);
            activeTargets.push({
                resultIndex,
                target: {
                    nodeId,
                    relPath: safe.relPath,
                    fullPath: safe.fullPath,
                    node,
                    unit,
                    initialHash: doc.sourceHash,
                    initialInputFingerprint: computeForgeInputFingerprint(node, initialDeps.dependencies, initialDeps.missingDeps),
                    language: canonicalLang,
                },
            });
        }
    }

    const batchStartMs = Date.now();
    const waves = partitionTargetsIntoWaves(activeTargets, nodesById);
    const activeTargetIds = new Set(activeTargets.map(a => a.target.nodeId));
    const resultById = new Map<string, BatchForgeNodeResult>();

    for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
        const wave = waves[waveIdx];
        const runnableWave: typeof wave = [];

        for (const item of wave) {
            const transitive = collectTransitiveDependencies(item.target.nodeId, item.target.node, nodesById);
            let blockedBy: string | undefined;
            if (waveIdx > 0) {
                for (const depId of transitive.dependencies.keys()) {
                    if (!activeTargetIds.has(depId)) continue;
                    const depResult = resultById.get(depId);
                    if (depResult && depResult.status !== 'forged') {
                        const depNode = nodesById.get(depId);
                        const depLang = depNode ? batchForgeLanguage(depNode.language ?? config.language) : null;
                        if (!depNode || !depLang || validateNodeStub(depNode, depLang).valid) {
                            blockedBy = depId;
                            break;
                        }
                    }
                }
            }

            if (blockedBy) {
                const skipped: BatchForgeNodeResult = {
                    nodeId: item.target.nodeId,
                    status: 'skipped',
                    reason: `Skipped because required dependency "${blockedBy}" did not forge in an earlier wave.`,
                    attempts: 0,
                    written: false,
                    durationMs: 0,
                };
                results[item.resultIndex] = skipped;
                resultById.set(item.target.nodeId, skipped);
                continue;
            }

            if (waveIdx > 0) {
                item.target.initialInputFingerprint = computeForgeInputFingerprint(
                    item.target.node,
                    transitive.dependencies,
                    transitive.missingDeps,
                );
            }
            runnableWave.push(item);
        }

        const waveContext: WaveForgeContext = {
            waveStartNodes: new Map<string, SlateNode>(nodesById),
            waveWrittenText: new Map<string, string>(),
        };

        let cursor = 0;
        const workerCount = Math.min(concurrency, runnableWave.length);
        const workers = Array.from({ length: workerCount }, async () => {
            while (cursor < runnableWave.length) {
                const item = runnableWave[cursor++];
                if (!item) break;
                const nodeResult = await forgeSingleTarget(
                    item.target,
                    snapshot,
                    sources,
                    nodesById,
                    llm,
                    config,
                    options,
                    maxRevisions,
                    waveContext,
                );
                results[item.resultIndex] = nodeResult;
                resultById.set(item.target.nodeId, nodeResult);
            }
        });
        await Promise.all(workers);

        // Refresh forged nodes in snapshot/sources/nodesById before the next wave runs.
        if (waveIdx + 1 < waves.length) {
            let refreshedAny = false;
            for (const item of runnableWave) {
                const res = resultById.get(item.target.nodeId);
                if (!res || res.status !== 'forged') continue;

                let nextText: string | null = null;
                if (options.write !== false) {
                    try {
                        nextText = await fs.promises.readFile(item.target.fullPath, 'utf8');
                    } catch {
                        nextText = null;
                    }
                } else if (res.proposedCode !== undefined) {
                    const nextNode: SlateNode = {
                        ...item.target.node,
                        code: codeLines(res.proposedCode),
                        ...(res.proposedImports ? { imports: res.proposedImports } : {}),
                        ...(res.proposedCheck ? { check: codeLines(res.proposedCheck) } : {}),
                    };
                    nextText = serializeNode(nextNode);
                }
                if (!nextText) continue;

                const indexed = indexNode(item.target.relPath, nextText, config.language, null);
                if (indexed.node) {
                    nodesById.set(item.target.nodeId, indexed.node);
                }
                docById.set(item.target.nodeId, indexed.document);
                sources.set(item.target.relPath, indexed.code);
                const docIdx = documents.findIndex(d => d.path === item.target.relPath);
                if (docIdx >= 0) {
                    documents[docIdx] = indexed.document;
                } else {
                    documents.push(indexed.document);
                }
                refreshedAny = true;
            }
            if (refreshedAny) {
                snapshot.revision += 1;
            }
        }
    }

    const forgedCount = results.filter(r => r.status === 'forged').length;
    const failedCount = results.filter(r => r.status === 'failed').length;
    const skippedCount = results.filter(r => r.status === 'skipped').length;
    const totalAttempts = results.reduce((sum, r) => sum + r.attempts, 0);
    const totalDurationMs = Date.now() - batchStartMs;

    return {
        ok: failedCount === 0,
        provider: llm.provider,
        endpoint: llm.endpoint,
        model: llm.model,
        hasApiKey: llm.hasApiKey,
        concurrency,
        waves: waves.length,
        total: results.length,
        forgedCount,
        failedCount,
        skippedCount,
        totalAttempts,
        totalDurationMs,
        results,
    };
}
