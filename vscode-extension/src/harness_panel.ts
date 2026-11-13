import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

import { BoardNote, FlowExecutionSnapshot, FlowInstance, HarnessDocument, HarnessSnapshot, LiveModeState, NodeGuardrailsReport, NodeVerificationResult, ParsedUnit, SlateFlow, SourceProposal, TestCase } from './harness_protocol';
import { buildForgePacket, buildGenerationPacket, ForgeOptions, GenerationPacket, parseForgeCandidate, stripModelEnvelope, validateForgeCandidate } from './generation';
import { streamLlamaCompletion } from './llama_transport';
import { DESCRIBE_OUTPUT_TOKENS, DESCRIBE_SYSTEM, describeNodes } from './port/describe';
import { compileSlateFolder, slateOutput } from './port_compile_host';
import { PythonAdapter, sourceHash } from './python_adapter';
import { searchUnits } from './search';
import {
    connect, deleteFlowPort, disconnect, emptyFlow, extractFlow, flowIdForPath, flowSignature, inputPorts, MAIN_FLOW, outputPorts, parseEndpoint, parseValueLiteral, pathForFlowId,
    removeInstances, removeNodeReferences, renameFlowPort, repairCallerWiresOnPortDelete, repairCallerWiresOnPortRename, serializeFlow, uniqueName, unitSignature, type CallableSignature, type Port,
} from './flow';
import { checkNodeCode, codeLines, codeText, CONFIG_PATH, LAYOUT_PATH, nodeFromSignature, nodeIdForPath, pathForNodeId, serializeNode, type SlateNode } from './slate_folder';
import { SlateFolderHost } from './slate_folder_host';
import { runNodeVerification, runRevisionLoop, isVerificationStale, resolvePythonPath } from './verification_runner';
import { buildUsageIndex } from './usage_index';
import { runFlow } from './flow_runner';
import { runNodeGuardrails } from './guardrails_runner';

function nonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let index = 0; index < 32; index++) {
        value += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return value;
}

/** A placeholder name resolves to the node whose id or last path segment equals it, when exactly one does. */
export function resolvePlaceholder(name: string, nodeIds: string[]): string | null {
    const matches = nodeIds.filter(id => id === name || id.split('/').pop() === name);
    return matches.length === 1 ? matches[0] : null;
}

function buildHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
    const distRoot = vscode.Uri.joinPath(context.extensionUri, 'dist');
    const htmlPath = path.join(distRoot.fsPath, 'harness.html');
    if (!fs.existsSync(htmlPath)) {
        return '<!doctype html><body>Slate Harness bundle missing. Run npm run build and sync the extension dist.</body>';
    }
    let html = fs.readFileSync(htmlPath, 'utf8');
    for (const attribute of ['href', 'src'] as const) {
        const pattern = new RegExp(`${attribute}="([^"]+)"`, 'g');
        html = html.replace(pattern, (match, url: string) => {
            if (/^https?:\/\//.test(url) || url.startsWith('data:') || url.startsWith('#')) return match;
            const diskUri = vscode.Uri.joinPath(distRoot, url.replace(/^\/+/, ''));
            return `${attribute}="${webview.asWebviewUri(diskUri)}"`;
        });
    }
    const scriptNonce = nonce();
    html = html.replace(/<script\b/g, `<script nonce="${scriptNonce}"`);
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource}`,
        `img-src ${webview.cspSource} data:`,
        `script-src 'nonce-${scriptNonce}' ${webview.cspSource}`,
    ].join('; ');
    return html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
}

export class HarnessPanel implements vscode.Disposable {
    static current: HarnessPanel | undefined;

    private readonly disposables: vscode.Disposable[] = [];
    private sources = new Map<string, string>();
    private snapshot: HarnessSnapshot | undefined;
    private refreshTimer: NodeJS.Timeout | undefined;
    /** Bumped on dispose so in-flight refreshes stop posting. */
    private refreshGeneration = 0;
    private disposed = false;
    private refreshChain: Promise<void> = Promise.resolve();
    private mutations: Promise<void> = Promise.resolve();
    private revision = 0;
    private generation: AbortController | undefined;
    private describeRun: AbortController | undefined;
    private pendingProposal: {
        id: string;
        packet: GenerationPacket;
        proposal: SourceProposal;
        candidate: string;
        implementation?: string;
        check?: string;
        path: string;
    } | undefined;
    private lastAcceptedUnitId: string | undefined;
    private lastAcceptedVersion: number | undefined;
    private readonly testMessages: unknown[] | undefined;
    private bridgeServer: http.Server | undefined;
    private bridgePort: number | undefined;
    private verifications = new Map<string, NodeVerificationResult>();
    private activeVerifications = new Map<string, AbortController>();
    private activeRunController: AbortController | undefined;
    private currentExecution: FlowExecutionSnapshot | undefined;
    private liveMode: LiveModeState = {
        enabled: false,
        consented: false,
        flowId: MAIN_FLOW,
    };
    private liveDebounceTimer: NodeJS.Timeout | undefined;

    static async createOrShow(context: vscode.ExtensionContext, adapter: PythonAdapter): Promise<HarnessPanel | undefined> {
        if (HarnessPanel.current) {
            HarnessPanel.current.panel.reveal();
            HarnessPanel.current.scheduleRefresh(0);
            return HarnessPanel.current;
        }
        const workspace = vscode.workspace.workspaceFolders?.[0];
        if (!workspace || !await SlateFolderHost.detect(workspace.uri)) {
            const choice = await vscode.window.showInformationMessage(
                'This workspace has no slate/ project yet.', 'New Project', 'Port Python Project…',
            );
            if (choice === 'New Project') await vscode.commands.executeCommand('slate.newProject');
            if (choice === 'Port Python Project…') await vscode.commands.executeCommand('slate.portProject');
            return undefined;
        }
        const panel = vscode.window.createWebviewPanel(
            'slate.harness',
            'Slate Harness',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
            },
        );
        HarnessPanel.current = new HarnessPanel(context, adapter, panel, new SlateFolderHost(workspace.uri));
        return HarnessPanel.current;
    }

    /** Custom editor on slate/slate.json: the decoupled folder whose parent is the project root. */
    static attachToFolder(
        context: vscode.ExtensionContext,
        adapter: PythonAdapter,
        panel: vscode.WebviewPanel,
        configDocument: vscode.TextDocument,
    ): HarnessPanel {
        HarnessPanel.current?.dispose();
        const root = vscode.Uri.file(path.dirname(path.dirname(configDocument.uri.fsPath)));
        HarnessPanel.current = new HarnessPanel(context, adapter, panel, new SlateFolderHost(root));
        return HarnessPanel.current;
    }

    private constructor(
        context: vscode.ExtensionContext,
        private readonly adapter: PythonAdapter,
        private readonly panel: vscode.WebviewPanel,
        private readonly folder: SlateFolderHost,
    ) {
        this.testMessages = context.extensionMode === vscode.ExtensionMode.Test ? [] : undefined;
        // Custom editor panels arrive without options; createWebviewPanel ones already match.
        panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')] };
        panel.webview.html = buildHtml(context, panel.webview);
        panel.onDidDispose(() => this.dispose(), null, this.disposables);
        panel.webview.onDidReceiveMessage(message => this.handleMessage(message), null, this.disposables);

        for (const pattern of [folder.nodePattern(), folder.flowPattern()]) {
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            watcher.onDidCreate(() => { this.scheduleRefresh(); this.triggerLiveRerun('file created'); }, null, this.disposables);
            watcher.onDidChange(() => { this.scheduleRefresh(); this.triggerLiveRerun('file changed'); }, null, this.disposables);
            watcher.onDidDelete(() => { this.scheduleRefresh(); this.triggerLiveRerun('file deleted'); }, null, this.disposables);
            this.disposables.push(watcher);
        }
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                const relative = this.folder.relative(event.document.uri);
                if (this.folder.nodeId(event.document.uri) !== null || flowIdForPath(relative) !== null) {
                    this.scheduleRefresh();
                    this.triggerLiveRerun('text document change');
                }
            }),
            vscode.window.onDidChangeTextEditorSelection(event => this.selectFromEditor(event.textEditor)),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) this.selectFromEditor(editor);
            }),
        );
        this.startBridgeServer();
        this.scheduleRefresh(0);
    }

    scheduleRefresh(delay = 250): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            // Background indexing reloads layout; serialize it with writes so a
            // delayed read cannot replace layout while an edit is saving it.
            this.mutations = this.mutations.then(() => this.refresh(), () => this.refresh());
        }, delay);
    }

    /**
     * Refreshes run one at a time, so awaiting refresh() guarantees the snapshot
     * reflects every write made before the call (actions rely on that).
     */
    private refresh(): Promise<void> {
        this.refreshChain = this.refreshChain.then(() => this.refreshNow(), () => this.refreshNow());
        return this.refreshChain;
    }

    private async refreshNow(): Promise<void> {
        if (this.disposed) return;
        const folder = this.folder;
        const generation = this.refreshGeneration;
        try {
            const index = await folder.index();
            if (generation !== this.refreshGeneration) return;
            this.sources = index.sources;
            const verifications: Record<string, NodeVerificationResult> = {};
            for (const document of index.documents) {
                const nodeId = nodeIdForPath(document.path);
                if (!nodeId) continue;
                let v = this.verifications.get(nodeId) ?? document.verification;
                if (v) {
                    if (v.sourceHash && v.sourceHash !== document.sourceHash) {
                        v = { ...v, state: 'stale' };
                        this.verifications.set(nodeId, v);
                    }
                    verifications[nodeId] = v;
                }
            }

            const usages = buildUsageIndex(index.documents, index.flows, folder.layout.refs);

            this.snapshot = {
                revision: ++this.revision,
                projectName: index.config.name,
                documents: index.documents.map(document => {
                    const nodeId = nodeIdForPath(document.path);
                    const v = nodeId ? (verifications[nodeId] ?? document.verification) : document.verification;
                    const u = nodeId ? usages[nodeId] : undefined;
                    return {
                        ...document,
                        source: index.sources.get(document.path),
                        verification: v,
                        usage: u,
                    };
                }),
                notes: folder.layout.notes,
                contextEdges: [],
                layout: folder.layout.positions,
                mapPositions: folder.layout.mapPositions,
                flowPositions: folder.layout.flowPositions,
                refs: folder.layout.refs,
                placeholders: folder.layout.placeholders,
                flows: index.flows,
                library: index.library,
                verifications,
                usages,
                execution: this.currentExecution,
                guardrails: this.snapshot?.guardrails,
                liveMode: { ...this.liveMode },
            };
            await this.postMessage({ type: 'snapshot', snapshot: this.snapshot });
        } catch (error) {
            if (generation !== this.refreshGeneration) return;
            this.postCommandResult(false, `Slate folder: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** Edits run one at a time; long-running work (generate, describe) and cancels do not queue. */
    private handleMessage(message: unknown): Promise<void> {
        const value = (message && typeof message === 'object' ? message : {}) as Record<string, unknown>;
        const kind = (value.action as Record<string, unknown> | undefined)?.kind;
        const queued = ['layout', 'noteCreate', 'noteUpdate', 'noteDelete', 'acceptProposal', 'undoAccepted'].includes(value.type as string)
            || (value.type === 'action' && kind !== 'describeNodes' && kind !== 'cancelDescribe' && kind !== 'verifyNode' && kind !== 'cancelVerification' && kind !== 'tryRevisions' && kind !== 'runFlow' && kind !== 'stopFlow');
        if (!queued) return this.handleMessageNow(message);
        this.mutations = this.mutations.then(() => this.handleMessageNow(message), () => this.handleMessageNow(message));
        return this.mutations;
    }

    private async handleMessageNow(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object') return;
        const value = message as Record<string, unknown>;
        if (value.type === 'ready') {
            this.scheduleRefresh(0);
            return;
        }
        if (value.type === 'layout') {
            await this.updateFolderLayout(this.folder, value);
            return;
        }
        if (['noteCreate', 'noteUpdate', 'noteDelete'].includes(value.type as string)) {
            await this.updateFolderNotes(this.folder, value);
            return;
        }
        if (value.type === 'search' && typeof value.query === 'string') {
            if (!this.snapshot || value.revision !== this.snapshot.revision) {
                await this.postMessage({ type: 'searchResults', query: value.query, results: [], stale: true });
                return;
            }
            await this.postMessage({
                type: 'searchResults',
                query: value.query,
                results: searchUnits(this.snapshot.documents, this.sources, value.query),
                stale: false,
            });
            return;
        }
        if (value.type === 'packetPreview' && typeof value.unitId === 'string') {
            this.postPacketPreview(value.unitId);
            return;
        }
        if (value.type === 'generate' && typeof value.unitId === 'string') {
            await this.generate(value.unitId, {
                forge: (value as { forge?: boolean }).forge,
                boundInputs: (value as { boundInputs?: boolean }).boundInputs,
                retryFeedback: typeof (value as { retryFeedback?: unknown }).retryFeedback === 'string'
                    ? (value as { retryFeedback: string }).retryFeedback
                    : undefined,
            });
            return;
        }
        if (value.type === 'cancelGeneration') {
            this.generation?.abort();
            return;
        }
        if (value.type === 'verifyNode') {
            const target = typeof value.nodeId === 'string' ? value.nodeId : typeof value.unitId === 'string' ? value.unitId : null;
            if (target) {
                await this.verifyNode(this.folderNodeId(target));
            }
            return;
        }
        if (value.type === 'cancelVerification') {
            const target = typeof value.nodeId === 'string' ? value.nodeId : typeof value.unitId === 'string' ? value.unitId : undefined;
            this.cancelVerification(target ? this.folderNodeId(target) : undefined);
            return;
        }
        if (value.type === 'tryRevisions') {
            const target = typeof value.nodeId === 'string' ? value.nodeId : typeof value.unitId === 'string' ? value.unitId : null;
            if (target) {
                await this.tryRevisions(this.folderNodeId(target), typeof value.maxRevisions === 'number' ? value.maxRevisions : 3);
            }
            return;
        }
        if (value.type === 'runFlow') {
            const flowId = typeof value.flowId === 'string' ? value.flowId : undefined;
            const inputs = value.inputs && typeof value.inputs === 'object' ? value.inputs as Record<string, unknown> : undefined;
            await this.executeFlow(flowId, inputs);
            return;
        }
        if (value.type === 'stopFlow') {
            this.stopFlow();
            return;
        }
        if (value.type === 'setLiveMode') {
            const enabled = Boolean(value.enabled);
            const consented = typeof value.consented === 'boolean' ? value.consented : undefined;
            const flowId = typeof value.flowId === 'string' ? value.flowId : undefined;
            await this.setLiveMode(enabled, consented, flowId);
            return;
        }
        if (value.type === 'toggleLiveMode') {
            const flowId = typeof value.flowId === 'string' ? value.flowId : undefined;
            const targetEnabled = !this.liveMode.enabled;
            const consented = typeof value.consented === 'boolean' ? value.consented : undefined;
            await this.setLiveMode(targetEnabled, consented, flowId);
            return;
        }
        if (value.type === 'acceptProposal' && typeof value.proposalId === 'string') {
            await this.acceptProposal(value.proposalId);
            return;
        }
        if (value.type === 'undoAccepted') {
            await this.undoAccepted();
            return;
        }
        if (value.type === 'action' && value.action && typeof value.action === 'object') {
            await this.handleFolderAction(this.folder, value.action as Record<string, unknown>);
            return;
        }
        if (value.type === 'reveal' && typeof value.unitId === 'string') {
            await this.revealUnit(value.unitId, value.focus === true);
        }
    }

    async postMessageForTest(message: unknown): Promise<void> {
        await this.handleMessage(message);
    }

    /** Observe the actual outbound protocol in Extension Host tests, not private proposal state. */
    takeMessagesForTest(): unknown[] {
        return this.testMessages?.splice(0) ?? [];
    }

    private postMessage(message: unknown): Thenable<boolean> {
        if (this.disposed) return Promise.resolve(false);
        if (this.testMessages) {
            this.testMessages.push(message);
            if (this.testMessages.length > 200) this.testMessages.shift();
        }
        return this.panel.webview.postMessage(message);
    }

    private validUnitId(id: string): boolean {
        return this.snapshot?.documents.some(document => document.units.some(unit => unit.id === id)) ?? false;
    }

    private postCommandResult(ok: boolean, message: string): void {
        void this.postMessage({ type: 'commandResult', ok, message });
    }

    private generationSettings(): {
        endpoint: string;
        model: string;
        contextWindowTokens: number;
        outputTokens: number;
        timeoutMs: number;
    } {
        const config = vscode.workspace.getConfiguration('slate.llama');
        return {
            endpoint: config.get('endpoint', 'http://127.0.0.1:8080'),
            model: config.get('model', 'local'),
            contextWindowTokens: config.get('contextWindow', 4096),
            outputTokens: config.get('outputTokens', 768),
            timeoutMs: config.get('timeoutSeconds', 120) * 1000,
        };
    }

    private packet(unitId: string, options?: ForgeOptions): GenerationPacket {
        if (!this.snapshot) throw new Error('The graph is not indexed yet.');
        const settings = this.generationSettings();
        return buildGenerationPacket(
            this.snapshot,
            this.sources,
            unitId,
            settings.contextWindowTokens,
            settings.outputTokens,
            options,
        );
    }

    private postPacketPreview(unitId: string): void {
        try {
            const packet = this.packet(unitId, { forge: true });
            void this.postMessage({
                type: 'packetPreview',
                unitId,
                packet: {
                    items: packet.items.map(({ source, ...item }) => ({ ...item, characters: source.length })),
                    estimatedInputTokens: packet.estimatedInputTokens,
                    inputBudgetTokens: packet.inputBudgetTokens,
                    outputBudgetTokens: packet.outputBudgetTokens,
                    omittedNeighbors: packet.omittedNeighbors,
                },
            });
        } catch (error) {
            void this.postMessage({
                type: 'packetPreview', unitId, error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private async generate(unitId: string, options?: { forge?: boolean; boundInputs?: boolean; retryFeedback?: string }): Promise<void> {
        if (this.generation) {
            this.postCommandResult(false, 'A llama.cpp generation is already running.');
            return;
        }
        try {
            const config = vscode.workspace.getConfiguration('slate.llama');
            const isForge = options?.forge !== false;
            const boundInputs = typeof options?.boundInputs === 'boolean'
                ? options.boundInputs
                : config.get<boolean>('boundInputs', false);
            const packet = this.packet(unitId, {
                forge: isForge,
                boundInputs,
                retryFeedback: options?.retryFeedback,
            });
            const target = this.resolveUnit(unitId);
            const settings = this.generationSettings();
            const controller = new AbortController();
            this.generation = controller;
            this.pendingProposal = undefined;
            await this.postMessage({
                type: 'generationStarted', unitId,
                message: `Sent ${packet.items.length} exact source unit${packet.items.length === 1 ? '' : 's'} (${packet.estimatedInputTokens}/${packet.inputBudgetTokens} estimated input tokens) to ${settings.endpoint}.`,
            });
            let received = 0;
            const raw = await streamLlamaCompletion(packet.prompt, {
                ...settings,
                system: isForge
                    ? 'You are a constrained local component forge engine. Follow JPL-60 rules strictly and provide both implementation and unit check.'
                    : undefined,
            }, controller.signal, token => {
                received += token.length;
                void this.postMessage({ type: 'generationProgress', unitId, receivedCharacters: received });
            });

            const forgeCandidate = parseForgeCandidate(raw);
            const validation = validateForgeCandidate(target.unit, forgeCandidate);
            if (!validation.valid) {
                throw new Error(validation.diagnostics.join('; '));
            }

            const candidateSource = forgeCandidate.check
                ? `# Implementation:\n${forgeCandidate.implementation}\n\n# Unit Check:\n${forgeCandidate.check}`
                : forgeCandidate.implementation;

            const proposal = await this.adapter.replaceUnit({
                source: this.sources.get(target.document.path) ?? '',
                path: target.document.path,
                expectedHash: packet.items[0].sourceHash,
                unitId,
                replacement: forgeCandidate.implementation,
                nodeId: nodeIdForPath(target.document.path) ?? undefined,
            });
            const id = randomUUID();
            this.pendingProposal = {
                id,
                packet,
                proposal,
                candidate: candidateSource,
                implementation: forgeCandidate.implementation,
                check: forgeCandidate.check,
                path: target.document.path,
            };
            const checks = [
                'Valid Python',
                'Exactly one function',
                'Name and signature preserved',
                'Edit confined to owned function',
                `JPL-60 compliant (${validation.lineCount} lines, typed)`,
                forgeCandidate.check ? 'Pytest unit check generated' : 'Check generated',
            ];
            await this.postMessage({
                type: 'proposalReady',
                proposal: {
                    id, unitId, path: target.document.path,
                    candidate: candidateSource,
                    implementation: forgeCandidate.implementation,
                    check: forgeCandidate.check,
                    checks,
                },
            });
        } catch (error) {
            await this.postMessage({
                type: 'generationFailed', unitId,
                message: error instanceof Error ? error.message : String(error),
            });
        } finally {
            this.generation = undefined;
        }
    }

    private async acceptProposal(proposalId: string): Promise<void> {
        const pending = this.pendingProposal;
        if (!pending || pending.id !== proposalId) {
            this.postCommandResult(false, 'That proposal is no longer active.');
            return;
        }
        try {
            await this.acceptFolderProposal(this.folder, pending);
        } catch (error) {
            await this.postMessage({
                type: 'proposalStale', proposalId,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private async acceptFolderProposal(
        folder: SlateFolderHost,
        pending: NonNullable<HarnessPanel['pendingProposal']>,
    ): Promise<void> {
        if (pending.packet.boundInputs && pending.packet.fingerprint) {
            const fp = pending.packet.fingerprint;
            const targetNodeId = nodeIdForPath(pending.path)!;
            const currentNode = await folder.readNode(targetNodeId);
            if (currentNode.locked) {
                throw new Error('This function is locked. Unlock it before accepting a proposal.');
            }
            const currentCode = codeLines(currentNode.code.join('\n')).join('\n');
            const fpCode = codeLines(fp.code.join('\n')).join('\n');
            if (currentCode !== fpCode) {
                throw new Error(`${targetNodeId} code changed after generation. The draft was preserved; regenerate against current code.`);
            }
            if (currentNode.intent !== fp.intent) {
                throw new Error(`${targetNodeId} intent changed after generation. The draft was preserved; regenerate against current code.`);
            }
            if (currentNode.contract !== fp.contract) {
                throw new Error(`${targetNodeId} contract changed after generation. The draft was preserved; regenerate against current code.`);
            }
            if (JSON.stringify(currentNode.cases ?? []) !== JSON.stringify(fp.cases ?? [])) {
                throw new Error(`${targetNodeId} cases changed after generation. The draft was preserved; regenerate against current code.`);
            }
            if (JSON.stringify(currentNode.context ?? []) !== JSON.stringify(fp.context ?? [])) {
                throw new Error(`${targetNodeId} context changed after generation. The draft was preserved; regenerate against current code.`);
            }
            if (JSON.stringify(currentNode.uses ?? []) !== JSON.stringify(fp.uses ?? [])) {
                throw new Error(`${targetNodeId} uses changed after generation. The draft was preserved; regenerate against current code.`);
            }
            if (JSON.stringify(currentNode.imports ?? []) !== JSON.stringify(fp.imports ?? [])) {
                throw new Error(`${targetNodeId} imports changed after generation. The draft was preserved; regenerate against current code.`);
            }
            for (const [neighborId, expected] of Object.entries(fp.neighborSignatures)) {
                try {
                    const neighborNode = await folder.readNode(neighborId);
                    const neighborCode = neighborNode.code.join('\n');
                    const parsed = await this.adapter.parseModule(neighborCode + '\n', neighborId);
                    const rawCurrentSig = parsed.units[0]?.signature ?? neighborNode.code[0] ?? '';
                    const currentSig = rawCurrentSig.endsWith(':') ? rawCurrentSig.slice(0, -1).trimEnd() : rawCurrentSig.trim();
                    const expectedSig = expected.signature.endsWith(':') ? expected.signature.slice(0, -1).trimEnd() : expected.signature.trim();
                    if (currentSig !== expectedSig) {
                        throw new Error(`Neighbor ${neighborId} signature changed after generation. The draft was preserved; regenerate against current code.`);
                    }
                } catch (e) {
                    if (e instanceof Error && e.message.includes('changed after generation')) throw e;
                    throw new Error(`Neighbor ${neighborId} is no longer available. The draft was preserved; regenerate against current code.`);
                }
            }
        } else {
            for (const item of pending.packet.items) {
                const current = (await folder.readNode(nodeIdForPath(item.path)!)).code.join('\n') + '\n';
                if ((await this.adapter.parseModule(current, item.path)).sourceHash !== item.sourceHash) {
                    throw new Error(`${item.qualifiedName} changed after generation. The draft was preserved; regenerate against current code.`);
                }
            }
        }
        const nodeId = nodeIdForPath(pending.path)!;
        const node = await folder.readNode(nodeId);
        if (node.locked) throw new Error('This function is locked. Unlock it before accepting a proposal.');

        // Guardrails check (S-602): If node or affected flows have cases, test candidate before accepting!
        const proposedCode = codeLines(pending.proposal.proposedSource);
        const originalCode = [...node.code];
        const originalCheck = node.check ? [...node.check] : undefined;
        node.code = proposedCode;
        if (pending.check) {
            node.check = codeLines(pending.check);
        }

        const pythonPath = resolvePythonPath(vscode.workspace.getConfiguration('slate.python').get<string>('path'));
        const guardrailReport = await runNodeGuardrails({
            nodeId,
            folder: this.folder,
            workspaceRoot: this.folder.root.fsPath,
            nodeOverride: node,
            pythonPath,
            isTrusted: vscode.workspace.isTrusted,
        });

        if (!guardrailReport.passed) {
            node.code = originalCode;
            node.check = originalCheck;
            const failingFlow = guardrailReport.affectedFlows.find(f => f.failedCases > 0);
            const detail = failingFlow?.failures[0]?.error || guardrailReport.nodeCases.failures[0] || 'A saved case failed';
            throw new Error(`Guardrail failure: ${failingFlow ? `Flow "${failingFlow.flowId}"` : `Node "${nodeId}"`} failed: ${detail}. The proposal was rejected to protect existing guardrails.`);
        }

        const appliedVersion = await folder.writeNode(nodeId, node);
        this.lastAcceptedUnitId = pending.packet.targetId;
        this.lastAcceptedVersion = appliedVersion;
        this.pendingProposal = undefined;
        await this.postMessage({ type: 'proposalAccepted', unitId: this.lastAcceptedUnitId });
        this.postCommandResult(true, `Wrote the candidate into ${pending.path}. Use Undo to revert it.`);
        this.triggerLiveRerun('acceptProposal');
    }

    private cancelVerification(nodeId?: string): void {
        if (nodeId) {
            const controller = this.activeVerifications.get(nodeId);
            if (controller) {
                controller.abort();
                this.activeVerifications.delete(nodeId);
                this.postCommandResult(true, `Cancelled verification for ${nodeId}.`);
            }
        } else {
            for (const controller of this.activeVerifications.values()) {
                controller.abort();
            }
            this.activeVerifications.clear();
            this.postCommandResult(true, 'Cancelled all in-flight verifications.');
        }
    }

    private async verifyNode(nodeId: string): Promise<void> {
        if (this.activeVerifications.has(nodeId)) {
            this.postCommandResult(false, `Verification for ${nodeId} is already running.`);
            return;
        }

        const controller = new AbortController();
        this.activeVerifications.set(nodeId, controller);

        const runningResult: NodeVerificationResult = {
            nodeId,
            state: 'running',
            timestamp: Date.now(),
            sourceHash: '',
        };
        await this.postMessage({ type: 'verificationStatus', result: runningResult });

        try {
            const node = await this.folder.readNode(nodeId);
            runningResult.sourceHash = sourceHash(codeText(node));

            const dependencies = new Map<string, SlateNode>();
            for (const depId of node.context) {
                try {
                    const depNode = await this.folder.readNode(depId);
                    dependencies.set(depId, depNode);
                } catch {}
            }

            const pythonPath = resolvePythonPath(vscode.workspace.getConfiguration('slate.python').get<string>('path'));
            const result = await runNodeVerification({
                workspaceRoot: this.folder.root.fsPath,
                node,
                nodeId,
                dependencies,
                isTrusted: vscode.workspace.isTrusted,
                timeoutMs: 15000,
                signal: controller.signal,
                pythonPath,
            });

            this.verifications.set(nodeId, result);
            node.verification = result;
            await this.folder.writeNode(nodeId, node);

            await this.postMessage({ type: 'verificationStatus', result });
            this.postCommandResult(
                result.state === 'passed',
                result.state === 'passed'
                    ? `Verification passed for ${nodeId}.`
                    : result.state === 'mutant_survived'
                        ? `Verification warning: ${result.survivingMutants} mutant(s) survived for ${nodeId}.`
                        : `Verification failed for ${nodeId}.`,
            );
        } catch (error) {
            const failResult: NodeVerificationResult = {
                nodeId,
                state: 'failed',
                timestamp: Date.now(),
                sourceHash: runningResult.sourceHash,
                diagnostics: [error instanceof Error ? error.message : String(error)],
            };
            this.verifications.set(nodeId, failResult);
            await this.postMessage({ type: 'verificationStatus', result: failResult });
            this.postCommandResult(false, `Verification error: ${failResult.diagnostics![0]}`);
        } finally {
            this.activeVerifications.delete(nodeId);
        }
    }

    private async tryRevisions(nodeId: string, maxRevisions = 3): Promise<void> {
        if (this.activeVerifications.has(nodeId) || this.generation) {
            this.postCommandResult(false, `Operation already running for ${nodeId}.`);
            return;
        }

        const controller = new AbortController();
        this.activeVerifications.set(nodeId, controller);

        try {
            const node = await this.folder.readNode(nodeId);
            this.postCommandResult(true, `Starting bounded revision loop for ${nodeId} (up to ${maxRevisions} revisions)...`);

            const loopResult = await runRevisionLoop({
                nodeId,
                node,
                maxRevisions,
                forgeCandidate: async (feedback: string) => {
                    if (controller.signal.aborted) return null;
                    const settings = this.generationSettings();
                    const packet = this.packet(nodeId, {
                        forge: true,
                        boundInputs: true,
                        retryFeedback: feedback,
                    });

                    const raw = await streamLlamaCompletion(
                        packet.prompt,
                        {
                            ...settings,
                            system: 'You are a constrained local component forge engine. Follow JPL-60 rules strictly and provide both implementation and unit check.',
                        },
                        controller.signal,
                        () => {},
                    );

                    const parsed = parseForgeCandidate(raw);
                    const target = this.resolveUnit(nodeId);
                    if (target) {
                        const validation = validateForgeCandidate(target.unit, parsed);
                        if (!validation.valid) {
                            throw new Error(`Candidate invalid: ${validation.diagnostics.join('; ')}`);
                        }
                    }

                    return parsed;
                },
                verifyCandidate: async (candidateNode: SlateNode) => {
                    const deps = new Map<string, SlateNode>();
                    for (const depId of candidateNode.context) {
                        try {
                            deps.set(depId, await this.folder.readNode(depId));
                        } catch {}
                    }
                    const pythonPath = resolvePythonPath(vscode.workspace.getConfiguration('slate.python').get<string>('path'));
                    return runNodeVerification({
                        workspaceRoot: this.folder.root.fsPath,
                        node: candidateNode,
                        nodeId,
                        dependencies: deps,
                        isTrusted: vscode.workspace.isTrusted,
                        timeoutMs: 15000,
                        signal: controller.signal,
                        pythonPath,
                    });
                },
            });

            this.verifications.set(nodeId, loopResult.finalResult);
            await this.postMessage({ type: 'verificationStatus', result: loopResult.finalResult });

            if (loopResult.lastCandidate) {
                const candidateCode = loopResult.lastCandidate.implementation;
                const candidateCheck = loopResult.lastCandidate.check;
                const fullCandidateText = candidateCheck
                    ? `# Implementation:\n${candidateCode}\n\n# Unit Check:\n${candidateCheck}`
                    : candidateCode;

                const target = this.resolveUnit(nodeId);
                const proposal = await this.adapter.replaceUnit({
                    source: this.sources.get(target.document.path) ?? '',
                    path: target.document.path,
                    expectedHash: target.document.sourceHash,
                    unitId: nodeId,
                    replacement: candidateCode,
                    nodeId: nodeIdForPath(target.document.path) ?? undefined,
                });

                const checks = [
                    '<=60 lines (JPL-60 compliant)',
                    `Revision ${loopResult.finalResult.retryCount ?? 1} of ${maxRevisions}`,
                    loopResult.success ? 'Verified: Pydantic & Pytest tests passed' : 'Verification failed on revisions',
                ];

                const packet = this.packet(nodeId, {
                    forge: true,
                    boundInputs: true,
                });

                const id = randomUUID();
                this.pendingProposal = {
                    id,
                    packet,
                    proposal,
                    candidate: fullCandidateText,
                    implementation: candidateCode,
                    check: candidateCheck,
                    path: target.document.path,
                };

                await this.postMessage({
                    type: 'proposalReady',
                    proposal: {
                        id,
                        unitId: nodeId,
                        path: target.document.path,
                        candidate: fullCandidateText,
                        implementation: candidateCode,
                        check: candidateCheck,
                        checks,
                    },
                });
            }

            this.postCommandResult(
                loopResult.success,
                loopResult.success
                    ? `Revision loop passed on attempt ${loopResult.finalResult.retryCount ?? 0}. Review and accept the proposal.`
                    : `Revision loop completed (${loopResult.attempts.length - 1} revisions attempted). Remaining issues exist.`,
            );
        } catch (error) {
            this.postCommandResult(false, `Revision loop failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.activeVerifications.delete(nodeId);
        }
    }

    private async runGuardrails(nodeId: string): Promise<NodeGuardrailsReport> {
        const pythonPath = resolvePythonPath(vscode.workspace.getConfiguration('slate.python').get<string>('path'));
        const report = await runNodeGuardrails({
            nodeId,
            folder: this.folder,
            workspaceRoot: this.folder.root.fsPath,
            pythonPath,
            isTrusted: vscode.workspace.isTrusted,
        });

        if (this.snapshot) {
            this.snapshot.guardrails = { ...this.snapshot.guardrails, [nodeId]: report };
        }

        await this.postMessage({ type: 'guardrailsStatus', report });
        const totalFlowCases = report.affectedFlows.reduce((sum, f) => sum + f.totalCases, 0);
        const passedFlowCases = report.affectedFlows.reduce((sum, f) => sum + f.passedCases, 0);
        this.postCommandResult(
            report.passed,
            report.passed
                ? `Guardrails passed for ${nodeId} (${report.nodeCases.passed} node check(s), ${passedFlowCases}/${totalFlowCases} flow case(s) across ${report.affectedFlows.length} flow(s)).`
                : `Guardrails failed for ${nodeId}. A test case or affected flow broke.`,
        );
        return report;
    }

    private async executeFlow(flowId?: string, inputs?: Record<string, unknown>): Promise<void> {
        if (this.activeRunController) {
            this.activeRunController.abort();
            this.activeRunController = undefined;
        }

        const targetFlowId = flowId || MAIN_FLOW;
        const controller = new AbortController();
        this.activeRunController = controller;

        const initialSnapshot: FlowExecutionSnapshot = {
            runId: 'pending',
            flowId: targetFlowId,
            status: 'running',
            observations: [],
            valuesByUse: {},
        };
        this.currentExecution = initialSnapshot;
        await this.postMessage({ type: 'executionStatus', execution: initialSnapshot });

        try {
            const index = await this.folder.index();
            const { config, nodes } = await this.folder.readNodes();
            const flowMap = new Map<string, SlateFlow>();
            for (const hf of index.flows) {
                if (hf.flow) flowMap.set(hf.id, hf.flow);
            }
            const library = await this.folder.readLibrary(config);
            const libraryMap = new Map<string, CallableSignature>();
            for (const doc of library) {
                for (const u of doc.units) {
                    if (u.signature) {
                        const sig = unitSignature(u, doc.units);
                        if (sig) libraryMap.set(u.id, sig);
                    }
                }
            }

            const configuredPython = vscode.workspace.getConfiguration('slate.python').get<string>('path');

            const result = await runFlow({
                workspaceRoot: this.folder.root.fsPath,
                flowId: targetFlowId,
                documents: nodes,
                flows: flowMap,
                config,
                library: libraryMap,
                pythonPath: configuredPython,
                inputs,
                isTrusted: vscode.workspace.isTrusted,
                signal: controller.signal,
            });

            this.currentExecution = result;
            await this.postMessage({ type: 'executionStatus', execution: result });
            this.postCommandResult(
                result.status === 'completed',
                result.status === 'completed'
                    ? `Run ${result.flowId} completed in ${((result.durationMs ?? 0) / 1000).toFixed(2)}s.`
                    : `Run ${result.flowId} ${result.status}: ${result.error || result.stderr || 'see output'}`,
            );
            this.scheduleRefresh(0);
        } catch (error) {
            const failResult: FlowExecutionSnapshot = {
                runId: '',
                flowId: targetFlowId,
                status: 'failed',
                durationMs: 0,
                exitCode: null,
                error: error instanceof Error ? error.message : String(error),
                observations: [],
                valuesByUse: {},
            };
            this.currentExecution = failResult;
            await this.postMessage({ type: 'executionStatus', execution: failResult });
            this.postCommandResult(false, `Run failed: ${failResult.error}`);
            this.scheduleRefresh(0);
        } finally {
            if (this.activeRunController === controller) {
                this.activeRunController = undefined;
            }
        }
    }

    private stopFlow(): void {
        if (this.activeRunController) {
            this.activeRunController.abort();
            this.activeRunController = undefined;
            this.postCommandResult(true, 'Flow execution stopped.');
        } else {
            this.postCommandResult(false, 'No flow is currently running.');
        }
    }

    public getLiveMode(): LiveModeState {
        return { ...this.liveMode };
    }

    public async setLiveMode(enabled: boolean, consented?: boolean, flowId?: string): Promise<boolean> {
        if (enabled) {
            if (!vscode.workspace.isTrusted) {
                this.postCommandResult(false, 'Live mode requires a trusted workspace.');
                return false;
            }
            if (!consented && !this.liveMode.consented) {
                this.postCommandResult(false, 'Live mode requires explicit side-effect consent before running.');
                return false;
            }
            if (consented) {
                this.liveMode.consented = true;
            }
            this.liveMode.enabled = true;
            if (flowId) this.liveMode.flowId = flowId;
            if (this.snapshot) {
                this.snapshot.liveMode = { ...this.liveMode };
            }
            await this.postMessage({ type: 'liveModeStatus', liveMode: { ...this.liveMode } });
            this.postCommandResult(true, `Live mode enabled for flow ${this.liveMode.flowId}. Edits will rerun side effects.`);
            void this.executeFlow(this.liveMode.flowId);
            return true;
        } else {
            this.liveMode.enabled = false;
            if (this.liveDebounceTimer) {
                clearTimeout(this.liveDebounceTimer);
                this.liveDebounceTimer = undefined;
            }
            if (this.snapshot) {
                this.snapshot.liveMode = { ...this.liveMode };
            }
            await this.postMessage({ type: 'liveModeStatus', liveMode: { ...this.liveMode } });
            this.postCommandResult(true, 'Live mode disabled.');
            return true;
        }
    }

    public triggerLiveRerun(reason?: string): void {
        if (!this.liveMode.enabled || !this.liveMode.consented) return;
        if (!vscode.workspace.isTrusted) return;
        if (this.liveDebounceTimer) clearTimeout(this.liveDebounceTimer);
        this.liveDebounceTimer = setTimeout(() => {
            this.liveDebounceTimer = undefined;
            const targetFlow = this.liveMode.flowId || MAIN_FLOW;
            void this.executeFlow(targetFlow);
        }, 300);
    }

    private folderNodeId(target: unknown): string {
        const document = typeof target === 'string'
            ? this.snapshot?.documents.find(item => item.units.some(unit => unit.id === target && unit.parentId === null)
                || (item.nodeKind && nodeIdForPath(item.path) === target))
            : undefined;
        const nodeId = document ? nodeIdForPath(document.path) : null;
        if (!nodeId) throw new Error('Metadata belongs to a node; select a node.');
        return nodeId;
    }

    private async updateFolderLayout(folder: SlateFolderHost, message: Record<string, unknown>): Promise<void> {
        if (!this.snapshot || !message.positions || typeof message.positions !== 'object') return;
        await folder.syncDirtyLayout();
        // scope: undefined = root canvas, 'map' = Map view, otherwise a flow id.
        const scope = typeof message.scope === 'string' ? message.scope : null;
        const flow = scope && scope !== 'map' ? this.flow(scope) : null;
        const validIds = new Set(scope === 'map'
            ? this.snapshot.documents.map(document => nodeIdForPath(document.path)!)
            : flow ? [...flow.instances.map(instance => instance.id), '__input', '__output']
                : this.rootCanvasIds());
        const target = scope === 'map' ? folder.layout.mapPositions
            : flow ? (folder.layout.flowPositions[scope!] ??= {}) : folder.layout.positions;
        let changed = false;
        for (const [id, point] of Object.entries(message.positions)) {
            const { x, y } = (point ?? {}) as { x?: unknown; y?: unknown };
            if (!validIds.has(id) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
            target[id] = { x: x as number, y: y as number };
            changed = true;
        }
        // Layout is canvas-only: a plain file write, no re-index, no revision bump.
        if (changed) await folder.writeLayout();
    }

    /** Ids that can sit on the root canvas. */
    private rootCanvasIds(): string[] {
        const snapshot = this.snapshot!;
        return [
            ...snapshot.documents.flatMap(document => document.units.map(unit => unit.id)),
            ...snapshot.documents.filter(document => document.nodeKind).map(document => nodeIdForPath(document.path)!),
            ...this.folder.layout.notes.map(note => note.id),
            ...this.folder.layout.refs.map(ref => ref.id),
            ...this.folder.layout.placeholders.map(item => item.id),
            ...(snapshot.flows ?? []).filter(item => item.id !== MAIN_FLOW).map(item => `flow:${item.id}`),
            ...this.flow(MAIN_FLOW).instances.map(instance => instance.id),
        ];
    }

    /** Current flow (main defaults to empty until first written). */
    private flow(flowId: string): SlateFlow {
        const found = this.snapshot?.flows?.find(item => item.id === flowId);
        if (found && !found.flow) throw new Error(`flows/${flowId}.json is unreadable: ${found.problem}`);
        if (!found && flowId !== MAIN_FLOW) throw new Error(`Flow ${flowId} does not exist.`);
        return found?.flow ?? emptyFlow(MAIN_FLOW);
    }

    /** Whether a target (node id, flow id, or library id) can be called. */
    private targetExists(target: string): boolean {
        const snapshot = this.snapshot!;
        return snapshot.documents.some(document => document.units.some(unit => unit.id === target && unit.parentId === null))
            || (snapshot.flows ?? []).some(item => item.id === target && target !== MAIN_FLOW)
            || (snapshot.library ?? []).some(document => document.units.some(unit => unit.id === target));
    }

    /** Input and output ports of an instance, from the target's signature. */
    private portsOf(instance: FlowInstance): { inputs: Port[]; outputs: Port[] } {
        if (instance.kind === 'viewer') return { inputs: [{ id: 'in', name: 'in', annotation: null }], outputs: [] };
        if (instance.kind === 'value' || !instance.node) return { inputs: [], outputs: [{ id: 'out', name: 'value', annotation: null }] };
        const snapshot = this.snapshot!;
        const flow = snapshot.flows?.find(item => item.id === instance.node)?.flow;
        if (flow) return { inputs: inputPorts(flowSignature(flow)), outputs: outputPorts(flowSignature(flow)) };
        const units = [...snapshot.documents, ...(snapshot.library ?? [])].map(document => document.units)
            .find(list => list.some(unit => unit.id === instance.node && unit.parentId === null));
        const unit = units?.find(item => item.id === instance.node)!;
        if (!unit) return { inputs: [], outputs: [] };
        const signature = unitSignature(unit, units!);
        return { inputs: inputPorts(signature), outputs: outputPorts(signature) };
    }

    /** Resolve a root canvas endpoint to an explicit main-flow instance without turning definitions into uses. */
    private resolveRootEndpoint(flow: SlateFlow, scope: string | null, endpoint: string): { flow: SlateFlow; endpoint: string } {
        const { instance, port } = parseEndpoint(endpoint);
        if (scope !== null || instance === null || flow.instances.some(item => item.id === instance)) {
            return { flow, endpoint };
        }
        const ref = this.folder.layout.refs.find(item => item.id === instance);
        if (ref) {
            return {
                flow: { ...flow, instances: [...flow.instances, { id: ref.id, node: ref.target }] },
                endpoint,
            };
        }
        const target = instance.startsWith('flow:') ? instance.slice('flow:'.length) : instance;
        if (!this.targetExists(target)) throw new Error(`${instance} cannot be wired.`);
        const short = (target.startsWith('lib:') ? target.split(':').pop()! : target.split('/').pop()!) || 'call';
        const id = uniqueName(`ref_${short}`, [...this.rootCanvasIds(), ...flow.instances.map(item => item.id)]);
        const basePosition = this.folder.layout.positions[instance];
        if (basePosition && !this.folder.layout.positions[id]) {
            this.folder.layout.positions[id] = { x: basePosition.x + 320, y: basePosition.y };
        }
        return {
            flow: { ...flow, instances: [...flow.instances, { id, node: target }] },
            endpoint: `${id}.${port}`,
        };
    }

    private placeAt(scope: string | null, id: string, x: unknown, y: unknown): void {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const point = { x: x as number, y: y as number };
        if (scope === null) this.folder.layout.positions[id] = point;
        else (this.folder.layout.flowPositions[scope] ??= {})[id] = point;
    }

    /** Canvas actions for refs, placeholders, flows, and data wires. Returns false when not one of them. */
    private async handleCanvasAction(action: Record<string, unknown>): Promise<boolean> {
        if (![
            'createRef', 'createPlaceholder', 'placeholderToRef', 'placeholderToNode',
            'addInstance', 'setValue', 'connectData', 'disconnectData', 'deleteItems',
            'createFlow', 'extractFlow', 'deleteFlow', 'addLibrary',
            'pasteItems', 'makeUnique', 'forkDefinition', 'renameFlowPort', 'deleteFlowPort',
            'addViewer', 'pinViewer', 'captureCase', 'runGuardrails', 'saveCase', 'deleteCase',
        ].includes(String(action.kind))) {
            return false;
        }
        const folder = this.folder;
        if (folder.hasUnsyncedDirtyFlow()) await this.refresh();
        await folder.syncDirtyLayout();
        const layout = folder.layout;
        const scope = typeof action.flow === 'string' && action.flow !== MAIN_FLOW ? action.flow : null;
        const flowId = scope ?? MAIN_FLOW;
        if (flowId !== MAIN_FLOW && (!this.snapshot?.flows?.some(item => item.id === flowId))) {
            await this.refresh();
        }
        const finish = async (message: string, select?: string) => {
            await folder.writeLayout();
            await this.refresh();
            if (select) await this.postMessage({ type: 'selectUnit', unitId: select });
            this.postCommandResult(true, message);
        };
        const saveFlow = async (id: string, flow: SlateFlow) => {
            await folder.writeFlow(id, flow);
        };
        const ask = async (title: string, value = '', validate?: (text: string) => string | null) =>
            vscode.window.showInputBox({ title, value, validateInput: text => validate?.(text.trim()) ?? null });
        const flowName = (text: string) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? 'Use a Python identifier'
            : this.snapshot?.flows?.some(item => item.id === text) || this.targetExists(text) ? `${text} already exists` : null;

        switch (action.kind) {
            case 'createRef': {
                const target = String(action.target);
                if (!this.targetExists(target)) throw new Error(`${target} does not exist.`);
                const id = `ref-${randomUUID().slice(0, 8)}`;
                const main = this.flow(MAIN_FLOW);
                await saveFlow(MAIN_FLOW, { ...main, instances: [...main.instances, { id, node: target }] });
                this.placeAt(null, id, action.x, action.y);
                await finish(`Added a reference to ${target}.`, id);
                return true;
            }
            case 'createPlaceholder': {
                const name = typeof action.name === 'string' && action.name.trim() ? action.name.trim()
                    : (await ask('New placeholder', '', text => /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? null : 'Use a Python identifier'))?.trim();
                if (!name) return true;
                const id = `placeholder-${randomUUID().slice(0, 8)}`;
                layout.placeholders.push({ id, name });
                this.placeAt(null, id, action.x, action.y);
                await finish(`Added placeholder ${name}.`, id);
                return true;
            }
            case 'placeholderToRef':
            case 'placeholderToNode': {
                const placeholder = layout.placeholders.find(item => item.id === action.id);
                if (!placeholder) throw new Error('That placeholder no longer exists.');
                const position = layout.positions[placeholder.id] ?? { x: 0, y: 0 };
                if (action.kind === 'placeholderToRef') {
                    const target = resolvePlaceholder(placeholder.name, this.snapshot!.documents.map(document => nodeIdForPath(document.path)!));
                    if (!target) throw new Error(`No single node is named ${placeholder.name}.`);
                    const id = `ref-${randomUUID().slice(0, 8)}`;
                    const main = this.flow(MAIN_FLOW);
                    await saveFlow(MAIN_FLOW, { ...main, instances: [...main.instances, { id, node: target }] });
                    layout.positions[id] = position;
                    layout.placeholders = layout.placeholders.filter(item => item !== placeholder);
                    delete layout.positions[placeholder.id];
                    await finish(`${placeholder.name} now references ${target}.`, id);
                    return true;
                }
                const signature = await ask(`Create node ${placeholder.name}`, placeholder.signature ?? `def ${placeholder.name}() -> None`, text => {
                    try { nodeFromSignature(text, ''); return null; } catch (error) { return (error as Error).message; }
                });
                if (!signature) return true;
                const nodeId = await folder.createNode(nodeFromSignature(signature, ''), position);
                layout.placeholders = layout.placeholders.filter(item => item !== placeholder);
                delete layout.positions[placeholder.id];
                await finish(`Created slate/nodes/${nodeId}.json`, nodeId);
                return true;
            }
            case 'addInstance': {
                let flow = this.flow(flowId);
                let id: string;
                if (typeof action.value === 'string') {
                    id = uniqueName('value', flow.instances.map(instance => instance.id));
                    flow = { ...flow, instances: [...flow.instances, { id, kind: 'value', value: action.value || '0' }] };
                } else {
                    const target = String(action.target);
                    if (!this.targetExists(target)) throw new Error(`${target} does not exist.`);
                    if (scope === null) {
                        id = `ref-${randomUUID().slice(0, 8)}`;
                    } else {
                        if (target === scope) throw new Error('A flow cannot contain itself.');
                        id = uniqueName(target.split(/[/:]/).pop()!, flow.instances.map(instance => instance.id));
                    }
                    flow = { ...flow, instances: [...flow.instances, { id, node: target }] };
                }
                this.placeAt(scope, id, action.x, action.y);
                const connectFrom = typeof action.connectFrom === 'string' ? action.connectFrom : null;
                const connectTo = typeof action.connectTo === 'string' ? action.connectTo : null;
                if (connectFrom || connectTo) {
                    const instance = flow.instances.find(item => item.id === id)!;
                    const ports = this.portsOf(instance);
                    // The webview picks the type-matching port; fall back to the first one.
                    const pick = (list: Port[]) => list.find(item => item.id === action.connectPort) ?? list[0];
                    if (connectFrom) {
                        const port = pick(ports.inputs);
                        if (port) {
                            const resolved = this.resolveRootEndpoint(flow, scope, connectFrom);
                            flow = connect(resolved.flow, resolved.endpoint, `${id}.${port.id}`);
                        }
                    } else if (pick(ports.outputs)) {
                        const resolved = this.resolveRootEndpoint(flow, scope, connectTo!);
                        flow = connect(resolved.flow, `${id}.${pick(ports.outputs).id}`, resolved.endpoint);
                    }
                }
                await saveFlow(flowId, flow);
                await finish(`Added ${id}.`, id);
                return true;
            }
            case 'setValue': {
                const flow = this.flow(flowId);
                let finalVal: unknown = action.value;
                if (typeof finalVal === 'string') {
                    const parsed = parseValueLiteral(finalVal);
                    if (!parsed.error && parsed.type !== 'expr') {
                        finalVal = parsed.value;
                    }
                }
                await saveFlow(flowId, { ...flow, instances: flow.instances.map(instance =>
                    instance.id === action.id && instance.kind === 'value' ? { ...instance, value: finalVal } : instance) });
                await finish('Saved value.');
                return true;
            }
            case 'addViewer':
            case 'pinViewer': {
                let flow = this.flow(flowId);
                const id = uniqueName('viewer', flow.instances.map(inst => inst.id));
                flow = { ...flow, instances: [...flow.instances, { id, kind: 'viewer', pinned: true }] };
                this.placeAt(scope, id, action.x, action.y);
                const from = typeof action.from === 'string' ? action.from : null;
                if (from) {
                    const resolved = this.resolveRootEndpoint(flow, scope, from);
                    flow = connect(resolved.flow, resolved.endpoint, `${id}.in`);
                }
                await saveFlow(flowId, flow);
                await finish(`Pinned viewer ${id}.`, id);
                return true;
            }
            case 'runGuardrails': {
                const target = String(action.targetNodeId || action.target || action.id || '');
                if (!target) throw new Error('runGuardrails requires target');
                const targetNodeId = this.folderNodeId(target);
                await this.runGuardrails(targetNodeId);
                return true;
            }
            case 'captureCase': {
                const inputs = (action.inputs && typeof action.inputs === 'object' && !Array.isArray(action.inputs)) ? action.inputs as Record<string, unknown> : {};
                const expected = action.output ?? action.expected;
                const description = typeof action.description === 'string' ? action.description : undefined;
                const error = typeof action.error === 'string' ? action.error : undefined;
                const targetNode = typeof action.targetNodeId === 'string' ? action.targetNodeId : null;
                const caseId = typeof action.id === 'string' ? action.id : `case_${Date.now().toString(36)}`;
                const newCase: TestCase = { id: caseId, inputs, expected, description, error };

                if (targetNode) {
                    const targetNodeId = this.folderNodeId(targetNode);
                    const nodeData = await this.folder.readNode(targetNodeId);
                    const existingCases = Array.isArray(nodeData.cases) ? [...nodeData.cases] : [];
                    existingCases.push(newCase);
                    await this.folder.writeNode(targetNodeId, { ...nodeData, cases: existingCases });
                    await finish(`Captured case for node ${targetNodeId}.`);
                    return true;
                }
                const flow = this.flow(flowId);
                const existingCases = Array.isArray(flow.cases) ? [...flow.cases] : (Array.isArray((flow.extra as Record<string, unknown>)?.cases) ? [...(flow.extra as Record<string, unknown>).cases as TestCase[]] : []);
                existingCases.push(newCase);
                await saveFlow(flowId, { ...flow, cases: existingCases });
                await finish(`Captured case for flow ${flowId}.`);
                return true;
            }
            case 'saveCase': {
                const targetCase = action.case as TestCase;
                if (!targetCase || typeof targetCase !== 'object') throw new Error('saveCase requires case object');
                const targetNode = typeof action.targetNodeId === 'string' ? action.targetNodeId : null;
                if (targetNode) {
                    const targetNodeId = this.folderNodeId(targetNode);
                    const nodeData = await this.folder.readNode(targetNodeId);
                    const cases = Array.isArray(nodeData.cases) ? [...nodeData.cases] as TestCase[] : [];
                    const idx = cases.findIndex(c => c && typeof c === 'object' && (c as TestCase).id === targetCase.id);
                    if (idx >= 0) {
                        cases[idx] = targetCase;
                    } else {
                        cases.push(targetCase);
                    }
                    await this.folder.writeNode(targetNodeId, { ...nodeData, cases });
                    await finish(`Saved case for node ${targetNodeId}.`);
                    return true;
                }
                const flow = this.flow(flowId);
                const cases = Array.isArray(flow.cases) ? [...flow.cases] : [];
                const idx = cases.findIndex(c => c.id === targetCase.id);
                if (idx >= 0) {
                    cases[idx] = targetCase;
                } else {
                    cases.push(targetCase);
                }
                await saveFlow(flowId, { ...flow, cases });
                await finish(`Saved case for flow ${flowId}.`);
                return true;
            }
            case 'deleteCase': {
                const caseId = String(action.caseId);
                const targetNode = typeof action.targetNodeId === 'string' ? action.targetNodeId : null;
                if (targetNode) {
                    const targetNodeId = this.folderNodeId(targetNode);
                    const nodeData = await this.folder.readNode(targetNodeId);
                    const cases = (Array.isArray(nodeData.cases) ? nodeData.cases : []).filter(c => !c || typeof c !== 'object' || (c as TestCase).id !== caseId);
                    await this.folder.writeNode(targetNodeId, { ...nodeData, cases });
                    await finish(`Deleted case from node ${targetNodeId}.`);
                    return true;
                }
                const flow = this.flow(flowId);
                const cases = (flow.cases ?? []).filter(c => c.id !== caseId);
                await saveFlow(flowId, { ...flow, cases });
                await finish(`Deleted case from flow ${flowId}.`);
                return true;
            }
            case 'connectData':
            case 'disconnectData': {
                let from = String(action.from);
                let to = String(action.to);
                let flow = this.flow(flowId);
                if (action.kind === 'disconnectData') {
                    await saveFlow(flowId, disconnect(flow, from, to));
                    await finish(`Removed wire ${from} → ${to}.`);
                    return true;
                }
                if (parseEndpoint(from).instance !== null && parseEndpoint(from).instance === parseEndpoint(to).instance) throw new Error('A node cannot feed itself.');
                const fromResolved = this.resolveRootEndpoint(flow, scope, from);
                flow = fromResolved.flow;
                from = fromResolved.endpoint;
                const toResolved = this.resolveRootEndpoint(flow, scope, to);
                flow = toResolved.flow;
                to = toResolved.endpoint;
                // Dropping on the group's empty slot creates a port named after the other end.
                if (from === 'input:+') {
                    const target = parseEndpoint(to);
                    const port = this.portsOf(flow.instances.find(item => item.id === target.instance)!).inputs.find(item => item.id === target.port);
                    const name = uniqueName(target.port.replace(/^in:/, ''), flow.inputs.map(input => input.name));
                    flow = { ...flow, inputs: [...flow.inputs, { name, annotation: port?.annotation ?? null }] };
                    from = `input:${name}`;
                }
                if (to === 'output:+') {
                    const source = parseEndpoint(from);
                    const instance = flow.instances.find(item => item.id === source.instance);
                    const port = instance ? this.portsOf(instance).outputs.find(item => item.id === source.port) : undefined;
                    const base = source.instance === null ? source.port.replace(/^input:/, '') : source.port === 'out' ? instance?.node?.split(/[/:]/).pop() ?? source.instance : source.port.slice(4);
                    const name = uniqueName(base, flow.outputs.map(output => output.name));
                    flow = { ...flow, outputs: [...flow.outputs, { name, annotation: port?.annotation ?? null }] };
                    to = `output:${name}`;
                }
                await saveFlow(flowId, connect(flow, from, to));
                await finish(`Wired ${from} → ${to}.`);
                return true;
            }
            case 'deleteItems': {
                const rawIds = Array.isArray(action.ids) ? action.ids.map(String) : [];
                if (!rawIds.length) return true;
                const currentFlow = this.flow(flowId);
                const isRoot = scope === null;
                const flowInstances = new Map(currentFlow.instances.map(inst => [inst.id, inst]));

                let mode = typeof action.mode === 'string' ? action.mode : null;
                const wantsPrompt = action.prompt === true || mode === 'prompt';

                const allDocuments = this.snapshot?.documents ?? [];
                const definitionIds = new Set(allDocuments.map(doc => nodeIdForPath(doc.path)!));

                if (wantsPrompt) {
                    const firstId = rawIds[0];
                    const inst = flowInstances.get(firstId);
                    const isDef = definitionIds.has(firstId) || !inst;
                    const label = inst ? (inst.kind === 'value' ? 'value' : inst.node ?? firstId) : firstId;

                    if (inst && (inst.kind === 'value' || inst.id.startsWith('placeholder-'))) {
                        const choice = await vscode.window.showWarningMessage(
                            `Delete ${label}?`,
                            { modal: true },
                            'Delete',
                        );
                        if (choice !== 'Delete') return true;
                        mode = 'removeInstance';
                    } else if (inst && inst.node && definitionIds.has(inst.node)) {
                        const choice = await vscode.window.showWarningMessage(
                            `Delete ${label}?`,
                            { modal: true },
                            'Remove call instance',
                            'Delete node file',
                        );
                        if (!choice) return true;
                        mode = choice === 'Delete node file' ? 'deleteDefinition' : 'removeInstance';
                    } else if (isDef && definitionIds.has(firstId)) {
                        const choice = await vscode.window.showWarningMessage(
                            `Delete slate/nodes/${firstId}.json from disk?`,
                            { modal: true },
                            'Delete node file',
                        );
                        if (choice !== 'Delete node file') return true;
                        mode = 'deleteDefinition';
                    } else {
                        const choice = await vscode.window.showWarningMessage(
                            `Delete ${label}?`,
                            { modal: true },
                            'Remove call instance',
                        );
                        if (choice !== 'Remove call instance') return true;
                        mode = 'removeInstance';
                    }
                }

                if (mode === 'deleteDefinition') {
                    const nodeIdsToDelete = new Set<string>();
                    for (const id of rawIds) {
                        const inst = flowInstances.get(id);
                        if (inst?.node) {
                            nodeIdsToDelete.add(inst.node);
                        } else if (definitionIds.has(id)) {
                            nodeIdsToDelete.add(id);
                        }
                    }

                    const deletes: vscode.Uri[] = [];
                    for (const targetNodeId of nodeIdsToDelete) {
                        deletes.push(folder.uri(pathForNodeId(targetNodeId)));
                        delete layout.positions[targetNodeId];
                    }

                    const allFlows = await folder.readFlows();
                    const flowsMap = new Map<string, SlateFlow>();
                    for (const f of allFlows) {
                        if (f.flow) flowsMap.set(f.id, f.flow);
                    }
                    flowsMap.set(MAIN_FLOW, this.flow(MAIN_FLOW));

                    for (const targetNodeId of nodeIdsToDelete) {
                        for (const [fId, flowObj] of flowsMap.entries()) {
                            const cleanedFlow = removeNodeReferences(flowObj, targetNodeId);
                            if (cleanedFlow !== flowObj) {
                                flowsMap.set(fId, cleanedFlow);
                                const removedInstIds = flowObj.instances
                                    .filter(item => !cleanedFlow.instances.some(c => c.id === item.id))
                                    .map(item => item.id);
                                for (const instId of removedInstIds) {
                                    if (fId === MAIN_FLOW) {
                                        delete layout.positions[instId];
                                        layout.refs = layout.refs.filter(ref => ref.id !== instId);
                                        folder.removeDeferredRefs([instId]);
                                    } else if (layout.flowPositions[fId]) {
                                        delete layout.flowPositions[fId][instId];
                                    }
                                }
                            }
                        }
                    }

                    for (const [fId, flowObj] of flowsMap.entries()) {
                        await folder.writeFlow(fId, flowObj);
                    }

                    for (const del of deletes) {
                        await vscode.workspace.fs.delete(del, { useTrash: false });
                    }

                    await finish(`Deleted ${nodeIdsToDelete.size} node file(s).`);
                    return true;
                }

                const ids = new Set(rawIds);
                if (isRoot) {
                    layout.refs = layout.refs.filter(ref => !ids.has(ref.id));
                    layout.placeholders = layout.placeholders.filter(item => !ids.has(item.id));
                    folder.removeDeferredRefs(ids);
                    for (const id of ids) delete layout.positions[id];
                } else {
                    for (const id of ids) delete layout.flowPositions[scope]?.[id];
                }

                const next = removeInstances(currentFlow, ids);
                if (scope !== null || this.snapshot?.flows?.some(item => item.id === MAIN_FLOW) || currentFlow.instances.length > 0 || currentFlow.wires.length > 0) {
                    await saveFlow(flowId, next);
                }
                await finish(`Removed ${ids.size} item(s).`);
                return true;
            }
            case 'pasteItems': {
                const mode = action.mode === 'duplicate' ? 'duplicate' : 'linked';
                const items = Array.isArray(action.items) ? action.items as Array<Record<string, unknown>> : [];
                if (!items.length) return true;

                let flow = this.flow(flowId);
                const isRoot = scope === null;
                let firstNewId: string | undefined;

                const baseOffsetX = typeof action.x === 'number' ? action.x : undefined;
                const baseOffsetY = typeof action.y === 'number' ? action.y : undefined;

                const allocatedFlowNames = new Set((this.snapshot?.flows ?? []).map(f => f.id));
                const allocatedNodeNames = new Set((this.snapshot?.documents ?? []).map(doc => nodeIdForPath(doc.path)!));

                for (let index = 0; index < items.length; index++) {
                    const item = items[index];
                    const originalTarget = String(item.node ?? item.target ?? item.id);
                    const itemX = typeof item.x === 'number' ? item.x : 100;
                    const itemY = typeof item.y === 'number' ? item.y : 100;
                    const posX = baseOffsetX !== undefined ? baseOffsetX + index * 40 : itemX + 40;
                    const posY = baseOffsetY !== undefined ? baseOffsetY + index * 40 : itemY + 40;

                    if (item.kind === 'value') {
                        const id = uniqueName('value', flow.instances.map(inst => inst.id));
                        if (!firstNewId) firstNewId = id;
                        flow = { ...flow, instances: [...flow.instances, { id, kind: 'value', value: String(item.value ?? '0') }] };
                        this.placeAt(scope, id, posX, posY);
                        continue;
                    }

                    if (mode === 'linked') {
                        const short = originalTarget.split(/[/:]/).pop() || 'call';
                        const id = isRoot
                            ? uniqueName(`ref_${short}`, [...this.rootCanvasIds(), ...flow.instances.map(inst => inst.id)])
                            : uniqueName(short, flow.instances.map(inst => inst.id));
                        if (!firstNewId) firstNewId = id;
                        flow = { ...flow, instances: [...flow.instances, { id, node: originalTarget }] };
                        this.placeAt(scope, id, posX, posY);
                    } else {
                        if (this.snapshot?.flows?.some(f => f.id === originalTarget)) {
                            const sourceFlow = this.flow(originalTarget);
                            const newFlowName = uniqueName(`${sourceFlow.name}_copy`, allocatedFlowNames);
                            allocatedFlowNames.add(newFlowName);
                            const duplicatedFlow: SlateFlow = {
                                ...sourceFlow,
                                name: newFlowName,
                                wires: [...sourceFlow.wires],
                            };
                            await folder.writeFlow(newFlowName, duplicatedFlow);
                            const instId = isRoot
                                ? uniqueName(`ref_${newFlowName}`, [...this.rootCanvasIds(), ...flow.instances.map(inst => inst.id)])
                                : uniqueName(newFlowName, flow.instances.map(inst => inst.id));
                            if (!firstNewId) firstNewId = instId;
                            flow = { ...flow, instances: [...flow.instances, { id: instId, node: newFlowName }] };
                            this.placeAt(scope, instId, posX, posY);
                        } else {
                            const sourceNode = await folder.readNode(originalTarget);
                            const baseName = sourceNode.name.replace(/_copy\d*$/, '') + '_copy';
                            const newNodeName = uniqueName(baseName, allocatedNodeNames);
                            allocatedNodeNames.add(newNodeName);
                            const escapedOldName = sourceNode.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            const selfRefRegex = new RegExp(`\\b${escapedOldName}\\b`, 'g');
                            const clonedNode: SlateNode = {
                                ...sourceNode,
                                name: newNodeName,
                                code: sourceNode.code.map(line => line.replace(selfRefRegex, newNodeName)),
                            };
                            await folder.createNode(clonedNode, { x: posX, y: posY });
                            const instId = isRoot
                                ? uniqueName(`ref_${newNodeName}`, [...this.rootCanvasIds(), ...flow.instances.map(inst => inst.id)])
                                : uniqueName(newNodeName, flow.instances.map(inst => inst.id));
                            if (!firstNewId) firstNewId = instId;
                            flow = { ...flow, instances: [...flow.instances, { id: instId, node: newNodeName }] };
                            this.placeAt(scope, instId, posX, posY);
                        }
                    }
                }

                await saveFlow(flowId, flow);
                await finish(`Pasted ${items.length} item(s) (${mode}).`, firstNewId);
                return true;
            }
            case 'makeUnique': {
                const id = String(action.id);
                let flow = this.flow(flowId);
                const instance = flow.instances.find(inst => inst.id === id);
                if (!instance || instance.kind === 'value' || !instance.node) {
                    throw new Error('Select a node instance to make unique.');
                }
                const targetNodeId = instance.node;
                if (targetNodeId.startsWith('lib:')) {
                    vscode.window.showWarningMessage(`Cannot fork library reference "${targetNodeId}".`);
                    return true;
                }
                const sourceNode = await folder.readNode(targetNodeId);
                const existingNodes = (this.snapshot?.documents ?? []).map(doc => nodeIdForPath(doc.path)!);
                const baseName = sourceNode.name.replace(/_copy\d*$/, '') + '_copy';
                const newNodeName = uniqueName(baseName, existingNodes);
                const escapedOldName = sourceNode.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const selfRefRegex = new RegExp(`\\b${escapedOldName}\\b`, 'g');
                const clonedNode: SlateNode = {
                    ...sourceNode,
                    name: newNodeName,
                    code: sourceNode.code.map(line => line.replace(selfRefRegex, newNodeName)),
                };
                const pos = (scope === null ? layout.positions[id] : layout.flowPositions[scope]?.[id]) ?? { x: 100, y: 100 };
                await folder.createNode(clonedNode, pos);
                flow = {
                    ...flow,
                    instances: flow.instances.map(inst => inst.id === id ? { ...inst, node: newNodeName } : inst),
                };
                await saveFlow(flowId, flow);
                await finish(`Forked ${targetNodeId} into independent ${newNodeName}.`, id);
                return true;
            }
            case 'forkDefinition': {
                const target = this.folderNodeId(String(action.target));
                const sourceNode = await folder.readNode(target);
                const existingNodes = (this.snapshot?.documents ?? []).map(doc => nodeIdForPath(doc.path)!);
                const baseName = sourceNode.name.replace(/_copy\d*$/, '') + '_copy';
                const newNodeName = uniqueName(baseName, existingNodes);
                const escapedOldName = sourceNode.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const selfRefRegex = new RegExp(`\\b${escapedOldName}\\b`, 'g');
                const clonedNode: SlateNode = {
                    ...sourceNode,
                    name: newNodeName,
                    code: sourceNode.code.map(line => line.replace(selfRefRegex, newNodeName)),
                };
                const oldPos = layout.positions[target] ?? { x: 100, y: 100 };
                const newPos = { x: oldPos.x + 40, y: oldPos.y + 40 };
                await folder.createNode(clonedNode, newPos);
                await finish(`Forked definition ${target} into ${newNodeName}.`, newNodeName);
                return true;
            }
            case 'renameFlowPort': {
                const targetFlowId = typeof action.flow === 'string' && action.flow ? action.flow : flowId;
                const direction = action.direction === 'output' ? 'output' : 'input';
                const oldName = String(action.oldName);
                const givenName = typeof action.newName === 'string' ? action.newName.trim() : null;
                const newName = givenName ?? (await ask(`Rename ${direction} port ${oldName}`, oldName, text =>
                    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? 'Use a Python identifier' : null
                ))?.trim();
                if (!newName || newName === oldName) return true;

                const targetFlow = this.flow(targetFlowId);
                const updatedTargetFlow = renameFlowPort(targetFlow, direction, oldName, newName);

                const allFlows = await folder.readFlows();
                const flowsMap = new Map<string, SlateFlow>();
                for (const f of allFlows) {
                    if (f.flow) flowsMap.set(f.id, f.flow);
                }
                flowsMap.set(MAIN_FLOW, this.flow(MAIN_FLOW));
                flowsMap.set(targetFlowId, updatedTargetFlow);

                for (const [fId, flowObj] of flowsMap.entries()) {
                    if (fId === targetFlowId) continue;
                    const repaired = repairCallerWiresOnPortRename(flowObj, targetFlowId, direction, oldName, newName, targetFlow.outputs.length);
                    if (repaired !== flowObj) {
                        flowsMap.set(fId, repaired);
                    }
                }

                for (const [fId, flowObj] of flowsMap.entries()) {
                    await folder.writeFlow(fId, flowObj);
                }

                await finish(`Renamed port ${oldName} → ${newName}.`);
                return true;
            }
            case 'deleteFlowPort': {
                const targetFlowId = typeof action.flow === 'string' && action.flow ? action.flow : flowId;
                const direction = action.direction === 'output' ? 'output' : 'input';
                const name = String(action.name);
                if (action.prompt !== false) {
                    const choice = await vscode.window.showWarningMessage(
                        `Delete ${direction} port "${name}" from flow ${targetFlowId}?`,
                        { modal: true },
                        'Delete',
                    );
                    if (choice !== 'Delete') return true;
                }

                const targetFlow = this.flow(targetFlowId);
                const updatedTargetFlow = deleteFlowPort(targetFlow, direction, name);

                const allFlows = await folder.readFlows();
                const flowsMap = new Map<string, SlateFlow>();
                for (const f of allFlows) {
                    if (f.flow) flowsMap.set(f.id, f.flow);
                }
                flowsMap.set(MAIN_FLOW, this.flow(MAIN_FLOW));
                flowsMap.set(targetFlowId, updatedTargetFlow);

                const survivingOutput = updatedTargetFlow.outputs.length === 1 ? updatedTargetFlow.outputs[0].name : undefined;
                for (const [fId, flowObj] of flowsMap.entries()) {
                    if (fId === targetFlowId) continue;
                    const repaired = repairCallerWiresOnPortDelete(
                        flowObj,
                        targetFlowId,
                        direction,
                        name,
                        updatedTargetFlow.outputs.length,
                        survivingOutput,
                    );
                    if (repaired !== flowObj) {
                        flowsMap.set(fId, repaired);
                    }
                }

                for (const [fId, flowObj] of flowsMap.entries()) {
                    await folder.writeFlow(fId, flowObj);
                }

                await finish(`Deleted port ${name}.`);
                return true;
            }
            case 'createFlow':
            case 'extractFlow': {
                const given = typeof action.name === 'string' ? action.name.trim() : null;
                if (given && flowName(given)) throw new Error(flowName(given)!);
                const name = given ?? (await ask(action.kind === 'createFlow' ? 'New flow' : 'Group selection into flow', '', flowName))?.trim();
                if (!name) return true;
                if (action.kind === 'createFlow') {
                    await folder.writeFlow(name, emptyFlow(name));
                    this.placeAt(null, `flow:${name}`, action.x, action.y);
                    await finish(`Created slate/flows/${name}.json`, `flow:${name}`);
                    return true;
                }
                let parent = this.flow(flowId);
                const ids = (Array.isArray(action.ids) ? action.ids.map(String) : []);
                const mappedIds: string[] = [];
                for (const id of ids) {
                    if (scope === null && !parent.instances.some(item => item.id === id)) {
                        try {
                            const resolved = this.resolveRootEndpoint(parent, null, `${id}.out`);
                            parent = resolved.flow;
                            const instId = parseEndpoint(resolved.endpoint).instance;
                            if (instId) mappedIds.push(instId);
                        } catch { /* notes, placeholders */ }
                    } else if (parent.instances.some(item => item.id === id)) {
                        mappedIds.push(id);
                    }
                }
                const selected = mappedIds.filter(id => parent.instances.some(item => item.id === id));
                if (!selected.length) throw new Error('Select nodes, references, or values to group.');
                const instanceId = scope === null
                    ? uniqueName(`ref_${name}`, [...this.rootCanvasIds(), ...parent.instances.map(item => item.id)])
                    : uniqueName(name, parent.instances.map(item => item.id));
                const result = extractFlow(parent, selected, { id: name, name, instanceId }, instance => this.portsOf(instance));
                const positions = scope === null ? layout.positions : layout.flowPositions[scope] ?? {};
                const points = selected.map(id => positions[id]).filter(Boolean);
                layout.flowPositions[name] = Object.fromEntries(selected.filter(id => positions[id]).map(id => [id, positions[id]]));
                if (points.length) {
                    const avgX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
                    const avgY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
                    this.placeAt(scope, instanceId, avgX, avgY);
                    if (scope === null) this.placeAt(null, `flow:${name}`, avgX + 320, avgY);
                }
                for (const id of selected) delete positions[id];
                await folder.writeFlow(name, result.child);
                await saveFlow(flowId, result.parent);
                await finish(`Grouped ${selected.length} item(s) into flow ${name}.`, instanceId);
                return true;
            }
            case 'deleteFlow': {
                const id = String(action.id);
                const choice = await vscode.window.showWarningMessage(`Delete slate/flows/${id}.json?`, { modal: true }, 'Delete');
                if (choice !== 'Delete') return true;
                await vscode.workspace.fs.delete(folder.uri(pathForFlowId(id)));
                delete layout.positions[`flow:${id}`];
                delete layout.flowPositions[id];
                await finish(`Deleted flow ${id}.`);
                return true;
            }
            case 'addLibrary': {
                const picked = await vscode.window.showOpenDialog({
                    canSelectFiles: true, canSelectFolders: true, canSelectMany: true, defaultUri: folder.root,
                    filters: { Python: ['py'] }, openLabel: 'Add to library',
                });
                if (!picked?.length) return true;
                const config = await folder.readConfigText();
                const value = JSON.parse(config) as Record<string, unknown>;
                const library = new Set(Array.isArray(value.library) ? value.library as string[] : []);
                for (const uri of picked) library.add(folder.relative(uri));
                value.library = [...library];
                await vscode.workspace.fs.writeFile(folder.uri(CONFIG_PATH), new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));
                await finish(`Library: ${[...library].join(', ')}`);
                return true;
            }
            default:
                return false;
        }
    }

    private async updateFolderNotes(folder: SlateFolderHost, message: Record<string, unknown>): Promise<void> {
        const attachment = message.attachedTo === null || message.attachedTo === undefined
            ? null
            : typeof message.attachedTo === 'string' && this.validUnitId(message.attachedTo) ? message.attachedTo : null;
        try {
            await folder.syncDirtyLayout();
            let select: string | null = null;
            if (message.type === 'noteCreate') {
                if (!Number.isFinite(message.x) || !Number.isFinite(message.y)) throw new Error('invalid board position');
                const note: BoardNote = { id: randomUUID(), title: 'New note', body: '', attachedTo: attachment };
                folder.layout.notes.push(note);
                folder.layout.positions[note.id] = { x: message.x as number, y: message.y as number };
                select = note.id;
            } else if (message.type === 'noteUpdate') {
                const index = folder.layout.notes.findIndex(note => note.id === message.noteId);
                if (index < 0 || typeof message.title !== 'string' || !message.title.trim() || typeof message.body !== 'string') {
                    throw new Error('invalid or missing note');
                }
                folder.layout.notes[index] = { id: folder.layout.notes[index].id, title: message.title.trim(), body: message.body, attachedTo: attachment };
                select = folder.layout.notes[index].id;
            } else {
                folder.layout.notes = folder.layout.notes.filter(note => note.id !== message.noteId);
                delete folder.layout.positions[message.noteId as string];
            }
            await folder.writeLayout();
            await this.refresh();
            if (select) await this.postMessage({ type: 'selectUnit', unitId: select });
            this.postCommandResult(true, 'NOTE: saved to slate/layout.json');
        } catch (error) {
            this.postCommandResult(false, `NOTE: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async handleFolderAction(folder: SlateFolderHost, action: Record<string, unknown>): Promise<void> {
        try {
            if (await this.handleCanvasAction(action)) {
                if (action.kind !== 'runGuardrails') {
                    this.triggerLiveRerun(String(action.kind));
                }
                return;
            }
            if (action.kind === 'runFlow') {
                const flowId = typeof action.flowId === 'string' ? action.flowId : typeof action.flow === 'string' ? action.flow : undefined;
                const inputs = action.inputs && typeof action.inputs === 'object' ? action.inputs as Record<string, unknown> : undefined;
                await this.executeFlow(flowId, inputs);
                return;
            }
            if (action.kind === 'stopFlow') {
                this.stopFlow();
                return;
            }
            if (action.kind === 'setLiveMode') {
                const enabled = Boolean(action.enabled);
                const consented = typeof action.consented === 'boolean' ? action.consented : undefined;
                const flowId = typeof action.flowId === 'string' ? action.flowId : undefined;
                await this.setLiveMode(enabled, consented, flowId);
                return;
            }
            if (action.kind === 'toggleLiveMode') {
                const flowId = typeof action.flowId === 'string' ? action.flowId : undefined;
                const targetEnabled = !this.liveMode.enabled;
                const consented = typeof action.consented === 'boolean' ? action.consented : undefined;
                await this.setLiveMode(targetEnabled, consented, flowId);
                return;
            }
            if (action.kind === 'refreshIndex') {
                await this.refresh();
                const invalid = this.snapshot?.documents.filter(document => !document.valid || document.diagnostics.length > 0).length ?? 0;
                this.postCommandResult(invalid === 0, invalid === 0 ? 'All nodes are valid.' : `${invalid} node(s) have problems.`);
                return;
            }
            if (action.kind === 'compile') {
                const result = await compileSlateFolder(folder.root);
                const errors = result.diagnostics.filter(item => item.severity === 'error').length;
                this.postCommandResult(errors === 0, errors === 0
                    ? `Compiled ${result.files.length} file(s)${result.diagnostics.length ? ` with ${result.diagnostics.length} warning(s)` : ''}.`
                    : `Compile stopped with ${errors} error(s); see Output → Slate.`);
                return;
            }
            if (action.kind === 'describeNodes') {
                await this.describe(folder);
                return;
            }
            if (action.kind === 'cancelDescribe') {
                this.describeRun?.abort();
                return;
            }
            if (action.kind === 'verifyNode' && typeof action.target === 'string') {
                await this.verifyNode(this.folderNodeId(action.target));
                return;
            }
            if (action.kind === 'tryRevisions' && typeof action.target === 'string') {
                await this.tryRevisions(this.folderNodeId(action.target), typeof action.maxRevisions === 'number' ? action.maxRevisions : 3);
                return;
            }
            if (action.kind === 'cancelVerification') {
                this.cancelVerification(typeof action.target === 'string' ? this.folderNodeId(action.target) : undefined);
                return;
            }
            if (action.kind === 'saveWorkspace') {
                await vscode.commands.executeCommand('workbench.action.files.saveAll');
                this.postCommandResult(true, 'Saved.');
                return;
            }
            if (action.kind === 'createNode' && Number.isFinite(action.x) && Number.isFinite(action.y)) {
                const signature = await vscode.window.showInputBox({
                    title: 'New Slate node',
                    prompt: 'Typed function signature',
                    placeHolder: 'def clamp(value: int, lower: int, upper: int) -> int',
                    validateInput: value => {
                        try { nodeFromSignature(value, ''); return null; } catch (error) { return (error as Error).message; }
                    },
                });
                if (!signature) return;
                const intent = await vscode.window.showInputBox({ title: 'New Slate node', prompt: 'Intent (what it should do)' });
                if (intent === undefined) return;
                const nodeId = await folder.createNode(nodeFromSignature(signature, intent), { x: action.x as number, y: action.y as number });
                await this.refresh();
                await this.postMessage({ type: 'selectUnit', unitId: nodeId });
                this.postCommandResult(true, `Created slate/nodes/${nodeId}.json`);
                this.triggerLiveRerun(`create node ${nodeId}`);
                return;
            }
            const nodeId = this.folderNodeId(action.target ?? action.consumer);
            const node = await folder.readNode(nodeId);
            if (action.kind === 'setAnnotationField' && typeof action.text === 'string'
                && (action.field === 'intent' || action.field === 'contract')) {
                node[action.field] = action.text.trim();
                if (action.field === 'intent') node.describedBy = 'human';
            } else if (action.kind === 'setContext' && typeof action.dependency === 'string' && typeof action.enabled === 'boolean') {
                const dependency = this.folderNodeId(action.dependency);
                if (dependency === nodeId) throw new Error('A node cannot be its own context.');
                node.context = action.enabled
                    ? [...new Set([...node.context, dependency])]
                    : node.context.filter(item => item !== dependency);
            } else if (action.kind === 'setLock' && typeof action.locked === 'boolean') {
                node.locked = action.locked;
            } else if (action.kind === 'setNodeCode' && typeof action.code === 'string') {
                const current = `${node.code.join('\n')}\n`;
                if ((await this.adapter.parseModule(current, nodeId)).sourceHash !== action.baseHash) {
                    throw new Error('The node changed since you started editing; your draft is kept. Reload the node and reapply.');
                }
                checkNodeCode(node, nodeId, action.code);
                const candidateNode: SlateNode = { ...node, code: codeLines(action.code) };
                if (action.force !== true && (node.cases?.length || node.check?.length)) {
                    const pythonPath = resolvePythonPath(vscode.workspace.getConfiguration('slate.python').get<string>('path'));
                    const guardrailReport = await runNodeGuardrails({
                        nodeId,
                        folder: this.folder,
                        workspaceRoot: this.folder.root.fsPath,
                        nodeOverride: candidateNode,
                        pythonPath,
                        isTrusted: vscode.workspace.isTrusted,
                    });
                    if (!guardrailReport.passed) {
                        const failingFlow = guardrailReport.affectedFlows.find(f => f.failedCases > 0);
                        const detail = failingFlow?.failures[0]?.error || guardrailReport.nodeCases.failures[0] || 'A saved case failed';
                        throw new Error(`Guardrail failure: ${failingFlow ? `Flow "${failingFlow.flowId}"` : `Node "${nodeId}"`} failed: ${detail}. Edit rejected to protect existing guardrails.`);
                    }
                }
                node.code = candidateNode.code;
            } else {
                throw new Error('That action is not available for slate/ node folders.');
            }
            await folder.writeNode(nodeId, node);
            this.scheduleRefresh(0);
            this.postCommandResult(true, `Saved slate/nodes/${nodeId}.json`);
            this.triggerLiveRerun(`edit node ${nodeId}`);
        } catch (error) {
            this.postCommandResult(false, error instanceof Error ? error.message : String(error));
        }
    }

    /** Describe pass: one llama.cpp request per undescribed node, leaves first. */
    private async describe(folder: SlateFolderHost): Promise<void> {
        if (this.describeRun) {
            this.postCommandResult(false, 'Describing is already running.');
            return;
        }
        const controller = new AbortController();
        this.describeRun = controller;
        void this.postMessage({ type: 'describeState', running: true });
        try {
            const settings = this.generationSettings();
            const { nodes } = await folder.readNodes();
            const report = await describeNodes({
                nodes,
                complete: (prompt, signal) => streamLlamaCompletion(
                    prompt, { ...settings, outputTokens: DESCRIBE_OUTPUT_TOKENS, system: DESCRIBE_SYSTEM }, signal, () => {},
                ),
                write: async (nodeId, described) => {
                    const node = await folder.readNode(nodeId);
                    if (node.intent.trim()) return; // Someone described it meanwhile; theirs wins.
                    node.intent = described.intent;
                    if (!node.contract.trim()) node.contract = described.contract;
                    node.describedBy = 'llama';
                    await folder.writeNode(nodeId, node);
                    this.scheduleRefresh(0);
                },
                onProgress: message => this.postCommandResult(true, message),
                signal: controller.signal,
                hardLimitTokens: settings.contextWindowTokens - DESCRIBE_OUTPUT_TOKENS,
            });
            if (report.skipped.length) {
                const output = slateOutput();
                output.appendLine(`Describe skipped ${report.skipped.length} node(s):`);
                for (const item of report.skipped) output.appendLine(`  - ${item.nodeId}: ${item.reason}`);
            }
        } catch (error) {
            this.postCommandResult(false, `Describe: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.describeRun = undefined;
            void this.postMessage({ type: 'describeState', running: false });
        }
    }

    private async undoAccepted(): Promise<void> {
        if (!this.lastAcceptedUnitId) {
            this.postCommandResult(false, 'There is no accepted Slate proposal to undo.');
            return;
        }
        const document = await vscode.workspace.openTextDocument(this.folder.uri(pathForNodeId(this.lastAcceptedUnitId)));
        if (document.version !== this.lastAcceptedVersion) {
            this.postCommandResult(false, 'The node changed since the accepted edit. Use native Undo in its editor to review subsequent edits first.');
            return;
        }
        await this.revealUnit(this.lastAcceptedUnitId, true);
        await vscode.commands.executeCommand('undo');
        this.lastAcceptedUnitId = undefined;
        this.lastAcceptedVersion = undefined;
        this.postCommandResult(true, 'UNDO: reverted the last accepted WorkspaceEdit');
        this.scheduleRefresh(0);
        this.triggerLiveRerun('undo');
    }

    private resolveUnit(query: string): { document: HarnessDocument; unit: ParsedUnit } {
        if (!this.snapshot) throw new Error('The graph is not indexed yet.');
        const normalized = query.toLowerCase();
        const matches = this.snapshot.documents.flatMap(document => document.units
            .filter(unit => unit.id.toLowerCase() === normalized
                || unit.qualifiedName.toLowerCase() === normalized
                || unit.name.toLowerCase() === normalized)
            .map(unit => ({ document, unit })));
        if (matches.length !== 1) throw new Error(`Unit ${query || '<empty>'} resolved to ${matches.length} nodes.`);
        return matches[0];
    }

    async revealUnit(unitId: string, focus = false): Promise<void> {
        if (!this.snapshot) throw new Error('The graph is not indexed yet.');
        const document = this.snapshot.documents.find(item => item.units.some(unit => unit.id === unitId));
        if (!document) throw new Error(`Node ${unitId} is not indexed.`);
        const text = await vscode.workspace.openTextDocument(this.folder.uri(document.path));
        const editor = await vscode.window.showTextDocument(text, {
            preview: false, preserveFocus: !focus, viewColumn: vscode.ViewColumn.Beside,
        });
        const line = SlateFolderHost.codeLine(text.getText());
        editor.selection = new vscode.Selection(line, 0, line, 0);
        editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    /** Project root (the parent of slate/). */
    get folderRoot(): vscode.Uri {
        return this.folder.root;
    }

    snapshotForTest(): HarnessSnapshot | undefined {
        return this.snapshot;
    }

    private selectFromEditor(editor: vscode.TextEditor): void {
        const nodeId = this.folder.nodeId(editor.document.uri);
        if (nodeId && this.validUnitId(nodeId)) void this.postMessage({ type: 'selectUnit', unitId: nodeId });
    }

    async focusCamera(options: {
        target?: string;
        region?: { x: number; y: number; width?: number; height?: number };
        zoom?: number;
        duration?: number;
    }): Promise<boolean> {
        if (this.disposed) return false;
        return (await this.postMessage({
            type: 'focus',
            target: options.target,
            region: options.region,
            zoom: options.zoom,
            duration: options.duration,
        })) ?? false;
    }

    private startBridgeServer(): void {
        try {
            const server = http.createServer((req, res) => {
                if (req.method === 'POST' && req.url === '/focus') {
                    let body = '';
                    let bodyLength = 0;
                    const MAX_BODY_BYTES = 64 * 1024; // 64KB
                    req.on('data', chunk => {
                        bodyLength += chunk.length;
                        if (bodyLength > MAX_BODY_BYTES) {
                            res.writeHead(413, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: 'Payload Too Large' }));
                            req.destroy();
                            return;
                        }
                        body += chunk;
                    });
                    req.on('end', async () => {
                        if (bodyLength > MAX_BODY_BYTES) return;
                        try {
                            const parsed = JSON.parse(body || '{}');
                            await this.focusCamera(parsed);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: true }));
                        } catch (err) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ ok: false, error: String(err) }));
                        }
                    });
                    return;
                }
                res.writeHead(404);
                res.end();
            });
            server.listen(0, '127.0.0.1', () => {
                const addr = server.address();
                if (addr && typeof addr === 'object') {
                    this.bridgePort = addr.port;
                    const bridgeFile = vscode.Uri.joinPath(this.folder.root, '.slate', 'live_bridge.json');
                    const info = JSON.stringify({ port: this.bridgePort, pid: process.pid });
                    void vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.folder.root, '.slate'))
                        .then(() => vscode.workspace.fs.writeFile(bridgeFile, new TextEncoder().encode(info)))
                        .then(undefined, () => {});
                }
            });
            server.on('error', () => {
                this.bridgeServer = undefined;
            });
            this.bridgeServer = server;
        } catch {
            this.bridgeServer = undefined;
        }
    }

    dispose(): void {
        if (HarnessPanel.current !== this) return;
        this.disposed = true;
        HarnessPanel.current = undefined;
        this.panel.dispose();
        if (this.bridgeServer) {
            this.bridgeServer.close();
            this.bridgeServer = undefined;
            const bridgeFile = vscode.Uri.joinPath(this.folder.root, '.slate', 'live_bridge.json');
            void vscode.workspace.fs.delete(bridgeFile).then(undefined, () => {});
        }
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        if (this.liveDebounceTimer) {
            clearTimeout(this.liveDebounceTimer);
            this.liveDebounceTimer = undefined;
        }
        this.generation?.abort();
        this.describeRun?.abort();
        if (this.activeRunController) {
            this.activeRunController.abort();
            this.activeRunController = undefined;
        }
        this.refreshGeneration++;
        while (this.disposables.length) this.disposables.pop()?.dispose();
    }
}
