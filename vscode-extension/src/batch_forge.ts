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
    resolveLlmConfig,
    streamLlamaCompletion,
    type LlmConfigInput,
} from './llama_transport';
import { tryNormalizeLanguage } from './language_types';
import { sourceHash } from './python_adapter';
import {
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
    type SlateLlmProvider,
    type SlateNode,
} from './slate_folder';
import { runNodeVerification, type VerificationOptions } from './verification_runner';

export const BATCH_FORGE_SYSTEM_PROMPT =
    'You are a constrained local component forge engine. Follow JPL-60 rules strictly and provide both implementation and unit check.';

export const TS_BATCH_FORGE_SYSTEM_PROMPT =
    'You are a constrained local TypeScript/JavaScript component forge engine. Follow JPL-60 rules strictly and provide both the typed implementation and a standalone test() unit check.';

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
}

export interface BatchForgeResult {
    ok: boolean;
    provider: SlateLlmProvider;
    endpoint: string;
    model: string;
    hasApiKey: boolean;
    concurrency: number;
    total: number;
    forgedCount: number;
    failedCount: number;
    skippedCount: number;
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

function collectNodeDependencies(node: SlateNode, nodesById: ReadonlyMap<string, SlateNode>): Map<string, SlateNode> {
    const deps = new Map<string, SlateNode>();
    for (const depId of [...node.context, ...node.uses]) {
        if (deps.has(depId)) continue;
        const depNode = nodesById.get(depId);
        if (depNode) deps.set(depId, depNode);
    }
    return deps;
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
    const normalized = rawId.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalized || normalized.split('/').includes('..') || path.isAbsolute(normalized)) {
        throw new Error(`Path traversal rejected: "${rawId}" is not a valid node ID.`);
    }
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
    options: BatchForgeOptions,
    maxRevisions: number,
): Promise<BatchForgeNodeResult> {
    const startMs = Date.now();
    const shouldVerify = options.verify !== false;
    const shouldWrite = options.write !== false;

    const dependencies = new Map<string, SlateNode>();
    for (const depId of [...target.node.context, ...target.node.uses]) {
        if (depId === target.nodeId || dependencies.has(depId)) continue;
        const depNode = nodesById.get(depId);
        if (depNode) dependencies.set(depId, depNode);
    }

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
                },
                options.signal ?? new AbortController().signal,
                () => {},
            );
        } catch (error) {
            lastReason = error instanceof Error ? error.message : String(error);
            if (options.signal?.aborted) break;
            retryFeedback = lastReason;
            continue;
        }

        const candidate = parseForgeCandidate(raw, target.language);
        const validation = validateForgeCandidate(target.unit, candidate, target.language);
        if (!validation.valid) {
            lastReason = validation.diagnostics.join('; ');
            retryFeedback = `Candidate validation failed:\n${lastReason}`;
            continue;
        }

        let verification: NodeVerificationResult | undefined;
        if (shouldVerify) {
            const candidateNode: SlateNode = {
                ...target.node,
                code: codeLines(candidate.implementation),
                check: candidate.check ? codeLines(candidate.check) : target.node.check,
            };
            verification = await runNodeVerification({
                workspaceRoot: options.workspaceRoot,
                node: candidateNode,
                nodeId: target.nodeId,
                dependencies,
                isTrusted: true,
                timeoutMs: options.verifyTimeoutMs ?? 15000,
                pythonPath: options.pythonPath,
                language: target.language,
                executeCommand: options.executeCommand,
                signal: options.signal,
            });
            lastVerification = verification;

            if (verification.state === 'failed' || verification.state === 'mutant_survived') {
                const failureSummary = summarizeVerificationFailure(verification);
                lastReason = failureSummary;
                retryFeedback = failureSummary;
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
            const missingDeps: string[] = [];
            for (const depId of [...diskNode.context, ...diskNode.uses]) {
                if (depId === target.nodeId || currentDeps.has(depId)) continue;
                try {
                    const safeDep = assertSafeNodeId(options.workspaceRoot, depId);
                    const depText = await fs.promises.readFile(safeDep.fullPath, 'utf8');
                    currentDeps.set(depId, parseNode(depText));
                } catch {
                    if (dependencies.has(depId)) {
                        missingDeps.push(depId);
                    }
                }
            }
            const currentHash = sourceHash(codeText(diskNode));
            const currentFingerprint = computeForgeInputFingerprint(diskNode, currentDeps, missingDeps);
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
                    proposedCode: candidate.implementation,
                    proposedCheck: candidate.check,
                };
            }

            diskNode.code = codeLines(candidate.implementation);
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
            await fs.promises.writeFile(target.fullPath, serializeNode(diskNode), 'utf8');
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
            ...(shouldWrite ? {} : { proposedCode: candidate.implementation, proposedCheck: candidate.check }),
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

    const concurrency = clampInt(options.concurrency, 1, 8, clampInt(llm.concurrency, 1, 8, 3));
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
                    reason: `Module ${node.kind} node cannot be forged as an atomic function.`,
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
            const initialDeps = collectNodeDependencies(node, nodesById);
            activeTargets.push({
                resultIndex,
                target: {
                    nodeId: req.nodeId,
                    relPath: req.relPath,
                    fullPath: req.fullPath,
                    node,
                    unit,
                    initialHash: doc.sourceHash,
                    initialInputFingerprint: computeForgeInputFingerprint(node, initialDeps),
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
            const initialDeps = collectNodeDependencies(node, nodesById);
            activeTargets.push({
                resultIndex,
                target: {
                    nodeId,
                    relPath: safe.relPath,
                    fullPath: safe.fullPath,
                    node,
                    unit,
                    initialHash: doc.sourceHash,
                    initialInputFingerprint: computeForgeInputFingerprint(node, initialDeps),
                    language: canonicalLang,
                },
            });
        }
    }

    let cursor = 0;
    const workerCount = Math.min(concurrency, activeTargets.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < activeTargets.length) {
            const item = activeTargets[cursor++];
            if (!item) break;
            results[item.resultIndex] = await forgeSingleTarget(
                item.target,
                snapshot,
                sources,
                nodesById,
                llm,
                options,
                maxRevisions,
            );
        }
    });
    await Promise.all(workers);

    const forgedCount = results.filter(r => r.status === 'forged').length;
    const failedCount = results.filter(r => r.status === 'failed').length;
    const skippedCount = results.filter(r => r.status === 'skipped').length;

    return {
        ok: failedCount === 0,
        provider: llm.provider,
        endpoint: llm.endpoint,
        model: llm.model,
        hasApiKey: llm.hasApiKey,
        concurrency,
        total: results.length,
        forgedCount,
        failedCount,
        skippedCount,
        results,
    };
}
