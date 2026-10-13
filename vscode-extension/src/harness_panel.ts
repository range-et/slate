import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

import { BoardNote, HarnessDocument, HarnessSnapshot, ParsedUnit, SourceProposal } from './harness_protocol';
import { buildGenerationPacket, GenerationPacket, stripModelEnvelope } from './generation';
import { streamLlamaCompletion } from './llama_transport';
import { DESCRIBE_OUTPUT_TOKENS, DESCRIBE_SYSTEM, describeNodes } from './port/describe';
import { compileSlateFolder, slateOutput } from './port_compile_host';
import { PythonAdapter } from './python_adapter';
import { searchUnits } from './search';
import { checkNodeCode, codeLines, nodeFromSignature, nodeIdForPath } from './slate_folder';
import { SlateFolderHost } from './slate_folder_host';

function nonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let index = 0; index < 32; index++) {
        value += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return value;
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
    private refreshGeneration = 0;
    private revision = 0;
    private generation: AbortController | undefined;
    private describeRun: AbortController | undefined;
    private pendingProposal: {
        id: string;
        packet: GenerationPacket;
        proposal: SourceProposal;
        candidate: string;
        path: string;
    } | undefined;
    private lastAcceptedUnitId: string | undefined;

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
        // Custom editor panels arrive without options; createWebviewPanel ones already match.
        panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')] };
        panel.webview.html = buildHtml(context, panel.webview);
        panel.onDidDispose(() => this.dispose(), null, this.disposables);
        panel.webview.onDidReceiveMessage(message => this.handleMessage(message), null, this.disposables);

        const watcher = vscode.workspace.createFileSystemWatcher(folder.nodePattern());
        watcher.onDidCreate(() => this.scheduleRefresh(), null, this.disposables);
        watcher.onDidChange(() => this.scheduleRefresh(), null, this.disposables);
        watcher.onDidDelete(() => this.scheduleRefresh(), null, this.disposables);
        this.disposables.push(
            watcher,
            vscode.workspace.onDidChangeTextDocument(event => {
                if (this.folder.nodeId(event.document.uri) !== null) this.scheduleRefresh();
            }),
            vscode.window.onDidChangeTextEditorSelection(event => this.selectFromEditor(event.textEditor)),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) this.selectFromEditor(editor);
            }),
        );
        this.scheduleRefresh(0);
    }

    private scheduleRefresh(delay = 250): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.refresh();
        }, delay);
    }

    private async refresh(): Promise<void> {
        const folder = this.folder;
        const generation = ++this.refreshGeneration;
        try {
            const index = await folder.index();
            if (generation !== this.refreshGeneration) return;
            this.sources = index.sources;
            this.snapshot = {
                revision: ++this.revision,
                projectName: index.config.name,
                documents: index.documents.map(document => ({ ...document, source: index.sources.get(document.path) })),
                notes: folder.layout.notes,
                contextEdges: [],
                layout: folder.layout.positions,
            };
            await this.panel.webview.postMessage({ type: 'snapshot', snapshot: this.snapshot });
        } catch (error) {
            if (generation !== this.refreshGeneration) return;
            this.postCommandResult(false, `Slate folder: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async handleMessage(message: unknown): Promise<void> {
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
                await this.panel.webview.postMessage({ type: 'searchResults', query: value.query, results: [], stale: true });
                return;
            }
            await this.panel.webview.postMessage({
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
            await this.generate(value.unitId);
            return;
        }
        if (value.type === 'cancelGeneration') {
            this.generation?.abort();
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

    private validUnitId(id: string): boolean {
        return this.snapshot?.documents.some(document => document.units.some(unit => unit.id === id)) ?? false;
    }

    private postCommandResult(ok: boolean, message: string): void {
        void this.panel.webview.postMessage({ type: 'commandResult', ok, message });
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

    private packet(unitId: string): GenerationPacket {
        if (!this.snapshot) throw new Error('The graph is not indexed yet.');
        const settings = this.generationSettings();
        return buildGenerationPacket(
            this.snapshot,
            this.sources,
            unitId,
            settings.contextWindowTokens,
            settings.outputTokens,
        );
    }

    private postPacketPreview(unitId: string): void {
        try {
            const packet = this.packet(unitId);
            void this.panel.webview.postMessage({
                type: 'packetPreview',
                unitId,
                packet: {
                    items: packet.items.map(({ source, ...item }) => ({ ...item, characters: source.length })),
                    estimatedInputTokens: packet.estimatedInputTokens,
                    inputBudgetTokens: packet.inputBudgetTokens,
                    outputBudgetTokens: packet.outputBudgetTokens,
                },
            });
        } catch (error) {
            void this.panel.webview.postMessage({
                type: 'packetPreview', unitId, error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private async generate(unitId: string): Promise<void> {
        if (this.generation) {
            this.postCommandResult(false, 'A llama.cpp generation is already running.');
            return;
        }
        try {
            const packet = this.packet(unitId);
            const target = this.resolveUnit(unitId);
            const settings = this.generationSettings();
            const controller = new AbortController();
            this.generation = controller;
            this.pendingProposal = undefined;
            await this.panel.webview.postMessage({
                type: 'generationStarted', unitId,
                message: `Sent ${packet.items.length} exact source unit${packet.items.length === 1 ? '' : 's'} (${packet.estimatedInputTokens}/${packet.inputBudgetTokens} estimated input tokens) to ${settings.endpoint}.`,
            });
            let received = 0;
            const raw = await streamLlamaCompletion(packet.prompt, settings, controller.signal, token => {
                received += token.length;
                void this.panel.webview.postMessage({ type: 'generationProgress', unitId, receivedCharacters: received });
            });
            const candidate = stripModelEnvelope(raw);
            const proposal = await this.adapter.replaceUnit({
                source: this.sources.get(target.document.path) ?? '',
                path: target.document.path,
                expectedHash: packet.items[0].sourceHash,
                unitId,
                replacement: candidate,
                nodeId: nodeIdForPath(target.document.path) ?? undefined,
            });
            const id = randomUUID();
            this.pendingProposal = { id, packet, proposal, candidate, path: target.document.path };
            await this.panel.webview.postMessage({
                type: 'proposalReady',
                proposal: {
                    id, unitId, path: target.document.path, candidate,
                    checks: ['Valid Python', 'Exactly one function', 'Name and signature preserved', 'Edit confined to owned function'],
                },
            });
        } catch (error) {
            await this.panel.webview.postMessage({
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
            await this.panel.webview.postMessage({
                type: 'proposalStale', proposalId,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private async acceptFolderProposal(
        folder: SlateFolderHost,
        pending: NonNullable<HarnessPanel['pendingProposal']>,
    ): Promise<void> {
        for (const item of pending.packet.items) {
            const current = (await folder.readNode(nodeIdForPath(item.path)!)).code.join('\n') + '\n';
            if ((await this.adapter.parseModule(current, item.path)).sourceHash !== item.sourceHash) {
                throw new Error(`${item.qualifiedName} changed after generation. The draft was preserved; regenerate against current code.`);
            }
        }
        const nodeId = nodeIdForPath(pending.path)!;
        const node = await folder.readNode(nodeId);
        node.code = codeLines(pending.proposal.proposedSource);
        await folder.writeNode(nodeId, node);
        this.lastAcceptedUnitId = pending.packet.targetId;
        this.pendingProposal = undefined;
        await this.panel.webview.postMessage({ type: 'proposalAccepted', unitId: this.lastAcceptedUnitId });
        this.postCommandResult(true, `Wrote the candidate into ${pending.path}. Use Undo to revert it.`);
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
        const validIds = new Set(this.snapshot.documents.flatMap(document => document.units.map(unit => unit.id))
            .concat(this.snapshot.documents.filter(document => document.nodeKind).map(document => nodeIdForPath(document.path)!))
            .concat(folder.layout.notes.map(note => note.id)));
        let changed = false;
        for (const [id, point] of Object.entries(message.positions)) {
            const { x, y } = (point ?? {}) as { x?: unknown; y?: unknown };
            if (!validIds.has(id) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
            folder.layout.positions[id] = { x: x as number, y: y as number };
            changed = true;
        }
        // Layout is canvas-only: a plain file write, no re-index, no revision bump.
        if (changed) await folder.writeLayout();
    }

    private async updateFolderNotes(folder: SlateFolderHost, message: Record<string, unknown>): Promise<void> {
        const attachment = message.attachedTo === null || message.attachedTo === undefined
            ? null
            : typeof message.attachedTo === 'string' && this.validUnitId(message.attachedTo) ? message.attachedTo : null;
        try {
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
            if (select) await this.panel.webview.postMessage({ type: 'selectUnit', unitId: select });
            this.postCommandResult(true, 'NOTE: saved to slate/layout.json');
        } catch (error) {
            this.postCommandResult(false, `NOTE: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async handleFolderAction(folder: SlateFolderHost, action: Record<string, unknown>): Promise<void> {
        try {
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
                const intent = await vscode.window.showInputBox({ title: 'New Slate node', prompt: 'Intent (what it should do)' }) ?? '';
                const nodeId = await folder.createNode(nodeFromSignature(signature, intent), { x: action.x as number, y: action.y as number });
                await this.refresh();
                await this.panel.webview.postMessage({ type: 'selectUnit', unitId: nodeId });
                this.postCommandResult(true, `Created slate/nodes/${nodeId}.json`);
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
                node.code = codeLines(action.code);
            } else {
                throw new Error('That action is not available for slate/ node folders.');
            }
            await folder.writeNode(nodeId, node);
            this.scheduleRefresh(0);
            this.postCommandResult(true, `Saved slate/nodes/${nodeId}.json`);
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
        void this.panel.webview.postMessage({ type: 'describeState', running: true });
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
            void this.panel.webview.postMessage({ type: 'describeState', running: false });
        }
    }

    private async undoAccepted(): Promise<void> {
        if (!this.lastAcceptedUnitId) {
            this.postCommandResult(false, 'There is no accepted Slate proposal to undo.');
            return;
        }
        await this.revealUnit(this.lastAcceptedUnitId, true);
        await vscode.commands.executeCommand('undo');
        this.lastAcceptedUnitId = undefined;
        this.postCommandResult(true, 'UNDO: reverted the last accepted WorkspaceEdit');
        this.scheduleRefresh(0);
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
        if (nodeId && this.validUnitId(nodeId)) void this.panel.webview.postMessage({ type: 'selectUnit', unitId: nodeId });
    }

    dispose(): void {
        if (HarnessPanel.current !== this) return;
        HarnessPanel.current = undefined;
        this.panel.dispose();
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.generation?.abort();
        this.describeRun?.abort();
        this.refreshGeneration++;
        while (this.disposables.length) this.disposables.pop()?.dispose();
    }
}
