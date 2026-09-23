import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

import { BoardNote, HarnessDocument, HarnessSnapshot, ParsedUnit, ParseModuleResult, SourceProposal, SourceRange } from './harness_protocol';
import { buildGenerationPacket, GenerationPacket, stripModelEnvelope } from './generation';
import { streamLlamaCompletion } from './llama_transport';
import { PythonAdapter } from './python_adapter';
import { loadProject, serializeProject } from './project_v2';
import { searchUnits } from './search';

const PYTHON_EXCLUDE = '**/{.git,.venv,venv,node_modules,__pycache__,dist,build}/**';

function nonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let index = 0; index < 32; index++) {
        value += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return value;
}

function contains(range: SourceRange, position: vscode.Position): boolean {
    const start = new vscode.Position(range.start.line, range.start.character);
    const end = new vscode.Position(range.end.line, range.end.character);
    return position.isAfterOrEqual(start) && position.isBeforeOrEqual(end);
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
    private readonly lastGood = new Map<string, ParseModuleResult>();
    private sources = new Map<string, string>();
    private snapshot: HarnessSnapshot | undefined;
    private refreshTimer: NodeJS.Timeout | undefined;
    private refreshGeneration = 0;
    private revision = 0;
    private projectWarningsShown = false;
    private generation: AbortController | undefined;
    private pendingProposal: {
        id: string;
        packet: GenerationPacket;
        proposal: SourceProposal;
        candidate: string;
        path: string;
    } | undefined;
    private lastAcceptedUnitId: string | undefined;

    static createOrShow(context: vscode.ExtensionContext, adapter: PythonAdapter): HarnessPanel {
        if (HarnessPanel.current) {
            HarnessPanel.current.panel.reveal();
            HarnessPanel.current.scheduleRefresh(0);
            return HarnessPanel.current;
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
        HarnessPanel.current = new HarnessPanel(context, adapter, panel);
        return HarnessPanel.current;
    }

    static attachToProject(
        context: vscode.ExtensionContext,
        adapter: PythonAdapter,
        panel: vscode.WebviewPanel,
        projectDocument: vscode.TextDocument,
    ): HarnessPanel {
        HarnessPanel.current?.dispose();
        const projectDirectory = path.dirname(projectDocument.uri.fsPath);
        let projectName = path.basename(projectDocument.uri.fsPath, '.slate.json');
        try {
            projectName = loadProject(projectDocument.getText()).project.name;
        } catch {
            // The panel reports the complete validation error during refresh.
        }
        let projectRoot = '.';
        try {
            projectRoot = loadProject(projectDocument.getText()).project.root;
        } catch {
            // Refresh reports malformed metadata.
        }
        const rootUri = vscode.Uri.file(path.resolve(projectDirectory, projectRoot));
        HarnessPanel.current = new HarnessPanel(context, adapter, panel, {
            uri: rootUri,
            name: projectName,
        }, projectDocument);
        return HarnessPanel.current;
    }

    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly adapter: PythonAdapter,
        private readonly panel: vscode.WebviewPanel,
        private readonly projectRoot?: { uri: vscode.Uri; name: string },
        private readonly projectDocument?: vscode.TextDocument,
    ) {
        panel.webview.html = buildHtml(context, panel.webview);
        panel.onDidDispose(() => this.dispose(), null, this.disposables);
        panel.webview.onDidReceiveMessage(message => this.handleMessage(message), null, this.disposables);

        const root = this.workspaceRoot();
        const watcher = vscode.workspace.createFileSystemWatcher(
            root ? new vscode.RelativePattern(root.uri.fsPath, '**/*.py') : '**/*.py'
        );
        watcher.onDidCreate(() => this.scheduleRefresh(), null, this.disposables);
        watcher.onDidChange(() => this.scheduleRefresh(), null, this.disposables);
        watcher.onDidDelete(() => this.scheduleRefresh(), null, this.disposables);
        this.disposables.push(
            watcher,
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document.languageId === 'python'
                    || event.document.uri.toString() === this.projectDocument?.uri.toString()) {
                    this.scheduleRefresh();
                }
            }),
            vscode.window.onDidChangeTextEditorSelection(event => this.selectFromEditor(event.textEditor)),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) this.selectFromEditor(editor);
            }),
        );
        this.scheduleRefresh(0);
    }

    private workspaceRoot(): { uri: vscode.Uri; name: string } | undefined {
        return this.projectRoot ?? vscode.workspace.workspaceFolders?.[0];
    }

    private scheduleRefresh(delay = 250): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.refresh();
        }, delay);
    }

    private async refresh(): Promise<void> {
        const root = this.workspaceRoot();
        if (!root) {
            this.snapshot = { revision: ++this.revision, projectName: 'No workspace', documents: [] };
            await this.panel.webview.postMessage({ type: 'snapshot', snapshot: this.snapshot });
            return;
        }
        const generation = ++this.refreshGeneration;
        try {
            const project = this.projectDocument ? loadProject(this.projectDocument.getText()) : undefined;
            const uris = project
                ? project.project.documents.map(document => vscode.Uri.joinPath(root.uri, ...document.path.split('/')))
                : await vscode.workspace.findFiles(
                    new vscode.RelativePattern(root.uri.fsPath, '**/*.py'),
                    PYTHON_EXCLUDE,
                    5000,
                );
            const openDocuments = new Map(
                vscode.workspace.textDocuments
                    .filter(document => document.languageId === 'python')
                    .map(document => [document.uri.toString(), document]),
            );
            const documents: HarnessDocument[] = [];
            const sources = new Map<string, string>();
            for (const uri of uris) {
                if (generation !== this.refreshGeneration) return;
                const relativePath = path.relative(root.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
                const open = openDocuments.get(uri.toString());
                let source: string;
                try {
                    source = open
                        ? open.getText()
                        : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
                } catch {
                    const empty = await this.adapter.parseModule('', relativePath);
                    documents.push({
                        ...empty,
                        id: `document:${relativePath}`,
                        path: relativePath,
                        version: null,
                        valid: false,
                        stale: false,
                        diagnostics: [{
                            code: 'missing-document',
                            message: `Tracked Python document ${relativePath} does not exist.`,
                            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                        }],
                    });
                    continue;
                }
                sources.set(relativePath, source);
                const parsed = await this.adapter.parseModule(source, relativePath);
                const previous = this.lastGood.get(relativePath);
                if (parsed.valid) this.lastGood.set(relativePath, parsed);
                const visible = parsed.valid || !previous ? parsed : { ...parsed, units: previous.units };
                documents.push({
                    ...visible,
                    id: `document:${relativePath}`,
                    path: relativePath,
                    version: open?.version ?? null,
                    stale: !parsed.valid && Boolean(previous),
                });
            }
            if (generation !== this.refreshGeneration) return;
            const durableIds = new Map<string, Array<{ document: HarnessDocument; unit: ParsedUnit }>>();
            for (const document of documents) {
                for (const unit of document.units.filter(candidate => candidate.identity === 'durable')) {
                    durableIds.set(unit.id, [...(durableIds.get(unit.id) ?? []), { document, unit }]);
                }
            }
            for (const [id, matches] of durableIds) {
                if (matches.length < 2) continue;
                for (const match of matches) {
                    match.document.valid = false;
                    match.document.diagnostics.push({
                        code: 'duplicate-project-slate-id',
                        message: `Slate id ${id} is duplicated across ${matches.length} project declarations.`,
                        range: match.unit.ranges.annotation ?? match.unit.ranges.name,
                    });
                }
            }
            documents.sort((left, right) => left.path.localeCompare(right.path));
            this.sources = sources;
            this.snapshot = {
                revision: ++this.revision,
                projectName: project?.project.name ?? root.name,
                documents,
                notes: project
                    ? project.project.notes
                    : this.context.workspaceState.get(this.notesKey(root), []),
                contextEdges: [],
                layout: project
                    ? project.project.layout
                    : this.context.workspaceState.get(this.layoutKey(root), {}),
            };
            await this.panel.webview.postMessage({ type: 'snapshot', snapshot: this.snapshot });
            if (project && project.warnings.length > 0 && !this.projectWarningsShown) {
                this.projectWarningsShown = true;
                this.postCommandResult(false, project.warnings.join(' '));
            }
            const active = vscode.window.activeTextEditor;
            if (active) this.selectFromEditor(active);
        } catch (error) {
            if (generation !== this.refreshGeneration) return;
            vscode.window.showErrorMessage(
                `Slate could not index Python source: ${error instanceof Error ? error.message : String(error)}`
            );
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
            await this.updateLayout(value);
            return;
        }
        if (value.type === 'noteCreate') {
            await this.createNote(value);
            return;
        }
        if (value.type === 'noteUpdate') {
            await this.updateNote(value);
            return;
        }
        if (value.type === 'noteDelete') {
            await this.deleteNote(value);
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
            await this.handleAction(value.action as Record<string, unknown>, value.revision);
            return;
        }
        if (value.type === 'reveal' && typeof value.unitId === 'string') {
            await this.revealUnit(value.unitId, value.focus === true);
        }
    }

    async postMessageForTest(message: unknown): Promise<void> {
        await this.handleMessage(message);
    }

    private layoutKey(root: { uri: vscode.Uri }): string {
        return `slate.harness.layout:${root.uri.toString()}`;
    }

    private notesKey(root: { uri: vscode.Uri }): string {
        return `slate.harness.notes:${root.uri.toString()}`;
    }

    private validUnitId(id: string): boolean {
        return this.snapshot?.documents.some(document => document.units.some(unit => unit.id === id)) ?? false;
    }

    private async writeProject(project: ReturnType<typeof loadProject>['project']): Promise<void> {
        if (!this.projectDocument) throw new Error('No bound project document.');
        const replacement = serializeProject(project);
        if (replacement === this.projectDocument.getText()) return;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            this.projectDocument.uri,
            new vscode.Range(
                this.projectDocument.positionAt(0),
                this.projectDocument.positionAt(this.projectDocument.getText().length),
            ),
            replacement,
        );
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the board update.');
        await this.projectDocument.save();
    }

    private async createNote(message: Record<string, unknown>): Promise<void> {
        const root = this.workspaceRoot();
        if (!root || !this.snapshot || message.revision !== this.snapshot.revision) {
            this.postCommandResult(false, 'ADD NOTE: board changed; try again');
            return;
        }
        const x = message.x;
        const y = message.y;
        const attachedTo = message.attachedTo === null || message.attachedTo === undefined
            ? null
            : typeof message.attachedTo === 'string' && this.validUnitId(message.attachedTo)
                ? message.attachedTo
                : undefined;
        if (!Number.isFinite(x) || !Number.isFinite(y) || attachedTo === undefined) {
            this.postCommandResult(false, 'ADD NOTE: invalid board position or attachment');
            return;
        }
        const note: BoardNote = { id: randomUUID(), title: 'New note', body: '', attachedTo };
        try {
            if (this.projectDocument) {
                const loaded = loadProject(this.projectDocument.getText());
                if (loaded.readOnly) throw new Error(loaded.warnings.join(' '));
                loaded.project.notes.push(note);
                loaded.project.layout[note.id] = { x: x as number, y: y as number };
                await this.writeProject(loaded.project);
            } else {
                const notes = this.context.workspaceState.get<BoardNote[]>(this.notesKey(root), []);
                const layout = this.context.workspaceState.get<Record<string, { x: number; y: number }>>(this.layoutKey(root), {});
                await this.context.workspaceState.update(this.notesKey(root), [...notes, note]);
                await this.context.workspaceState.update(this.layoutKey(root), { ...layout, [note.id]: { x: x as number, y: y as number } });
            }
            await this.refresh();
            await this.panel.webview.postMessage({ type: 'selectUnit', unitId: note.id });
            this.postCommandResult(true, attachedTo ? 'NOTE: attached to source unit' : 'NOTE: added to board');
        } catch (error) {
            this.postCommandResult(false, `ADD NOTE: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async updateNote(message: Record<string, unknown>): Promise<void> {
        const root = this.workspaceRoot();
        if (!root || !this.snapshot || message.revision !== this.snapshot.revision
            || typeof message.noteId !== 'string' || typeof message.title !== 'string'
            || typeof message.body !== 'string' || !message.title.trim()) {
            this.postCommandResult(false, 'SAVE NOTE: invalid or stale note');
            return;
        }
        const replacement: BoardNote = {
            id: message.noteId,
            title: message.title.trim(),
            body: message.body,
            attachedTo: message.attachedTo === null || message.attachedTo === undefined
                ? null
                : typeof message.attachedTo === 'string' && this.validUnitId(message.attachedTo)
                    ? message.attachedTo
                    : null,
        };
        try {
            if (this.projectDocument) {
                const loaded = loadProject(this.projectDocument.getText());
                if (loaded.readOnly) throw new Error(loaded.warnings.join(' '));
                const index = loaded.project.notes.findIndex(note => note.id === replacement.id);
                if (index < 0) throw new Error('note no longer exists');
                loaded.project.notes[index] = replacement;
                await this.writeProject(loaded.project);
            } else {
                const notes = this.context.workspaceState.get<BoardNote[]>(this.notesKey(root), []);
                if (!notes.some(note => note.id === replacement.id)) throw new Error('note no longer exists');
                await this.context.workspaceState.update(this.notesKey(root), notes.map(note => note.id === replacement.id ? replacement : note));
            }
            await this.refresh();
            await this.panel.webview.postMessage({ type: 'selectUnit', unitId: replacement.id });
            this.postCommandResult(true, 'NOTE: saved to board metadata; source was not changed');
        } catch (error) {
            this.postCommandResult(false, `SAVE NOTE: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async deleteNote(message: Record<string, unknown>): Promise<void> {
        const root = this.workspaceRoot();
        if (!root || !this.snapshot || message.revision !== this.snapshot.revision || typeof message.noteId !== 'string') {
            this.postCommandResult(false, 'DELETE NOTE: invalid or stale note');
            return;
        }
        try {
            if (this.projectDocument) {
                const loaded = loadProject(this.projectDocument.getText());
                if (loaded.readOnly) throw new Error(loaded.warnings.join(' '));
                loaded.project.notes = loaded.project.notes.filter(note => note.id !== message.noteId);
                delete loaded.project.layout[message.noteId];
                await this.writeProject(loaded.project);
            } else {
                const notes = this.context.workspaceState.get<BoardNote[]>(this.notesKey(root), []);
                const layout = this.context.workspaceState.get<Record<string, { x: number; y: number }>>(this.layoutKey(root), {});
                delete layout[message.noteId];
                await this.context.workspaceState.update(this.notesKey(root), notes.filter(note => note.id !== message.noteId));
                await this.context.workspaceState.update(this.layoutKey(root), layout);
            }
            await this.refresh();
            this.postCommandResult(true, 'NOTE: removed from board; source was not changed');
        } catch (error) {
            this.postCommandResult(false, `DELETE NOTE: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async updateLayout(message: Record<string, unknown>): Promise<void> {
        const root = this.workspaceRoot();
        if (!root || !this.snapshot || message.revision !== this.snapshot.revision
            || !message.positions || typeof message.positions !== 'object') return;
        const validIds = new Set(this.snapshot.documents.flatMap(document => [
            document.id,
            ...document.units.map(unit => unit.id),
        ]).concat((this.snapshot.notes ?? []).map(note => note.id)));
        const positions: Record<string, { x: number; y: number }> = {};
        for (const [id, point] of Object.entries(message.positions)) {
            if (!validIds.has(id) || !point || typeof point !== 'object') continue;
            const { x, y } = point as { x?: unknown; y?: unknown };
            if (Number.isFinite(x) && Number.isFinite(y)) {
                positions[id] = { x: x as number, y: y as number };
            }
        }
        if (Object.keys(positions).length === 0) return;

        if (!this.projectDocument) {
            const current = this.context.workspaceState.get<Record<string, { x: number; y: number }>>(
                this.layoutKey(root),
                {},
            );
            await this.context.workspaceState.update(this.layoutKey(root), { ...current, ...positions });
            return;
        }

        const loaded = loadProject(this.projectDocument.getText());
        if (loaded.readOnly) {
            this.postCommandResult(false, loaded.warnings.join(' '));
            return;
        }
        const project = loaded.project;
        project.layout = { ...project.layout, ...positions };
        await this.writeProject(project);
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
            const document = await this.sourceDocument(target.document.path);
            const proposal = await this.adapter.replaceUnit({
                source: document.getText(),
                path: target.document.path,
                expectedHash: packet.items[0].sourceHash,
                unitId,
                replacement: candidate,
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
            for (const item of pending.packet.items) {
                const document = await this.sourceDocument(item.path);
                const parsed = await this.adapter.parseModule(document.getText(), item.path);
                if (parsed.sourceHash !== item.sourceHash) {
                    throw new Error(`${item.qualifiedName} changed after generation. The draft was preserved; regenerate against current source.`);
                }
            }
            const document = await this.sourceDocument(pending.path);
            const edit = new vscode.WorkspaceEdit();
            this.addProposal(edit, document, pending.proposal);
            if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the proposal edit.');
            this.lastAcceptedUnitId = pending.packet.targetId;
            this.pendingProposal = undefined;
            await this.panel.webview.postMessage({ type: 'proposalAccepted', unitId: this.lastAcceptedUnitId });
            this.postCommandResult(true, 'Proposal accepted as one WorkspaceEdit. Use Undo to revert it.');
        } catch (error) {
            await this.panel.webview.postMessage({
                type: 'proposalStale', proposalId,
                message: error instanceof Error ? error.message : String(error),
            });
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

    private async handleAction(action: Record<string, unknown>, revision: unknown): Promise<void> {
        const invoke = (command: string, args: string[]) => this.handleCommand({ command, args, revision });
        if (action.kind === 'refreshIndex') return invoke('COMPILE', []);
        if (action.kind === 'saveWorkspace') return invoke('SAVE', []);
        if (action.kind === 'createStub'
            && typeof action.target === 'string' && typeof action.signature === 'string' && typeof action.intent === 'string') {
            return invoke('STUB', [action.target, '::', action.signature, '::', action.intent]);
        }
        if (action.kind === 'setAnnotationField' && typeof action.target === 'string'
            && typeof action.text === 'string' && (action.field === 'intent' || action.field === 'contract')) {
            return invoke(action.field.toUpperCase(), [action.target, '::', action.text]);
        }
        if (action.kind === 'setContext' && typeof action.consumer === 'string'
            && typeof action.dependency === 'string' && typeof action.enabled === 'boolean') {
            return invoke(action.enabled ? 'CONTEXT' : 'UNCONTEXT', [action.consumer, '::', action.dependency]);
        }
        if (action.kind === 'setLock' && typeof action.target === 'string' && typeof action.locked === 'boolean') {
            return invoke('LOCK', [action.target, action.locked ? 'ON' : 'OFF']);
        }
        this.postCommandResult(false, 'The webview sent an invalid typed action.');
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

    private resolveDocument(query: string): HarnessDocument {
        if (!this.snapshot) throw new Error('The graph is not indexed yet.');
        const normalized = query.replace(/\\/g, '/').toLowerCase();
        const matches = this.snapshot.documents.filter(document =>
            document.path.toLowerCase() === normalized
            || path.basename(document.path).toLowerCase() === normalized
        );
        if (matches.length !== 1) throw new Error(`File ${query || '<empty>'} resolved to ${matches.length} groups.`);
        return matches[0];
    }

    private async sourceDocument(documentPath: string): Promise<vscode.TextDocument> {
        const root = this.workspaceRoot();
        if (!root) throw new Error('Open a project first.');
        return vscode.workspace.openTextDocument(vscode.Uri.joinPath(root.uri, ...documentPath.split('/')));
    }

    async revealUnit(unitId: string, focus = false): Promise<void> {
        if (!this.snapshot) throw new Error('The graph is not indexed yet.');
        const matches = this.snapshot.documents.flatMap(document => document.units
            .filter(unit => unit.id === unitId)
            .map(unit => ({ document, unit })));
        if (matches.length !== 1) throw new Error(`Unit id ${unitId} resolved to ${matches.length} declarations.`);

        const sourceDocument = await this.sourceDocument(matches[0].document.path);
        const current = await this.adapter.parseModule(sourceDocument.getText(), matches[0].document.path);
        const currentUnits = current.units.filter(unit => unit.id === unitId);
        if (currentUnits.length !== 1) {
            throw new Error(`Unit ${matches[0].unit.qualifiedName} changed before it could be revealed.`);
        }
        const unit = currentUnits[0];
        const editor = await vscode.window.showTextDocument(sourceDocument, {
            preview: false,
            preserveFocus: !focus,
            viewColumn: vscode.ViewColumn.Beside,
        });
        const selection = new vscode.Range(
            unit.ranges.name.start.line,
            unit.ranges.name.start.character,
            unit.ranges.name.end.line,
            unit.ranges.name.end.character,
        );
        const declaration = new vscode.Range(
            unit.ranges.declaration.start.line,
            unit.ranges.declaration.start.character,
            unit.ranges.declaration.end.line,
            unit.ranges.declaration.end.character,
        );
        editor.selection = new vscode.Selection(selection.start, selection.end);
        editor.revealRange(declaration, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    snapshotForTest(): HarnessSnapshot | undefined {
        return this.snapshot;
    }

    private annotation(unit: ParsedUnit, overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            id: typeof unit.annotation?.id === 'string' ? unit.annotation.id : randomUUID(),
            intent: '',
            contract: '',
            dependencies: [],
            examples: [],
            locked: false,
            ...(unit.annotation ?? {}),
            ...overrides,
        };
    }

    private addProposal(edit: vscode.WorkspaceEdit, document: vscode.TextDocument, proposal: SourceProposal): void {
        for (const change of proposal.edits) {
            edit.replace(document.uri, new vscode.Range(
                change.range.start.line,
                change.range.start.character,
                change.range.end.line,
                change.range.end.character,
            ), change.newText);
        }
    }

    private async handleCommand(message: Record<string, unknown>): Promise<void> {
        if (!this.snapshot || typeof message.command !== 'string' || !Array.isArray(message.args)
            || !message.args.every(argument => typeof argument === 'string')) return;
        const command = message.command;
        if (message.revision !== this.snapshot.revision) {
            this.postCommandResult(false, `${command}: graph changed; run the command again`);
            return;
        }
        const rawArgs = (message.args as string[]).join(' ');
        const parts = rawArgs.split('::').map(part => part.trim());
        try {
            const sourceMutations = new Set(['STUB', 'INTENT', 'CONTRACT', 'CONTEXT', 'UNCONTEXT', 'LOCK']);
            if (this.projectDocument && sourceMutations.has(command)
                && loadProject(this.projectDocument.getText()).readOnly) {
                throw new Error('This project uses a newer schema and is read-only.');
            }
            if (command === 'COMPILE' || command === 'RECOMPILE') {
                await this.refresh();
                const invalid = this.snapshot?.documents.filter(document => !document.valid).length ?? 0;
                this.postCommandResult(invalid === 0, invalid === 0
                    ? `${command}: source graph is current; all Python modules parse`
                    : `${command}: ${invalid} invalid Python module${invalid === 1 ? '' : 's'}`);
                return;
            }
            if (command === 'SAVE') {
                const saved = await vscode.workspace.saveAll(false);
                this.postCommandResult(saved, saved ? 'SAVE: workspace files saved' : 'SAVE: one or more files were not saved');
                return;
            }
            if (command === 'STUB') {
                if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) {
                    throw new Error('Usage: STUB file.py|Class :: def name(arg: Type) -> Type :: intent');
                }
                let target: HarnessDocument;
                let parentId: string | null = null;
                try {
                    target = this.resolveDocument(parts[0]);
                } catch {
                    const parent = this.resolveUnit(parts[0]);
                    if (!['class', 'nested_class'].includes(parent.unit.kind)) {
                        throw new Error('A stub target must be a Python file or class group.');
                    }
                    target = parent.document;
                    parentId = parent.unit.id;
                }
                const document = await this.sourceDocument(target.path);
                const unitId = randomUUID();
                const proposal = await this.adapter.insertStub({
                    source: document.getText(), path: target.path, expectedHash: target.sourceHash,
                    signature: parts[1], annotation: {
                        id: unitId, intent: parts.slice(2).join(' :: '), contract: '',
                        dependencies: [], examples: [], locked: false,
                    }, parentId,
                });
                const edit = new vscode.WorkspaceEdit();
                this.addProposal(edit, document, proposal);
                if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the source edit.');
                this.postCommandResult(true, `STUB: created ${parts[1]} in ${target.path}`);
                return;
            }
            if (command === 'INTENT' || command === 'CONTRACT') {
                if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error(`Usage: ${command} unit :: text`);
                const target = this.resolveUnit(parts[0]);
                const document = await this.sourceDocument(target.document.path);
                const annotation = this.annotation(target.unit, {
                    [command === 'INTENT' ? 'intent' : 'contract']: parts.slice(1).join(' :: '),
                });
                const params = {
                    source: document.getText(), path: target.document.path,
                    expectedHash: target.document.sourceHash, unitId: target.unit.id, annotation,
                };
                const proposal = target.unit.annotation
                    ? await this.adapter.updateAnnotation(params)
                    : await this.adapter.adoptUnit(params);
                const edit = new vscode.WorkspaceEdit();
                this.addProposal(edit, document, proposal);
                if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the source edit.');
                this.postCommandResult(true, `${command}: updated ${target.unit.qualifiedName}`);
                return;
            }
            if (command === 'CONTEXT' || command === 'UNCONTEXT') {
                if (parts.length !== 2 || !parts[0] || !parts[1]) {
                    throw new Error(`Usage: ${command} consumer :: dependency`);
                }
                const consumer = this.resolveUnit(parts[0]);
                const dependency = this.resolveUnit(parts[1]);
                if (consumer.unit.id === dependency.unit.id) throw new Error('A unit cannot borrow itself.');
                if (dependency.unit.identity !== 'durable') {
                    throw new Error(`Adopt ${dependency.unit.qualifiedName} with INTENT before using it as context.`);
                }
                const document = await this.sourceDocument(consumer.document.path);
                const current = Array.isArray(consumer.unit.annotation?.dependencies)
                    ? consumer.unit.annotation.dependencies.filter(value => typeof value === 'string') as string[]
                    : [];
                const dependencies = command === 'CONTEXT'
                    ? [...new Set([...current, dependency.unit.id])]
                    : current.filter(id => id !== dependency.unit.id);
                const annotation = this.annotation(consumer.unit, { dependencies });
                const params = {
                    source: document.getText(), path: consumer.document.path,
                    expectedHash: consumer.document.sourceHash, unitId: consumer.unit.id, annotation,
                };
                const proposal = consumer.unit.annotation
                    ? await this.adapter.updateAnnotation(params)
                    : await this.adapter.adoptUnit(params);
                const edit = new vscode.WorkspaceEdit();
                this.addProposal(edit, document, proposal);
                if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the source edit.');
                this.postCommandResult(true, `${command}: ${consumer.unit.qualifiedName} ↔ ${dependency.unit.qualifiedName}`);
                return;
            }
            if (command === 'LOCK') {
                const args = rawArgs.trim().split(/\s+/);
                if (args.length !== 2 || !['ON', 'OFF'].includes(args[1].toUpperCase())) {
                    throw new Error('Usage: LOCK unit ON|OFF');
                }
                const target = this.resolveUnit(args[0]);
                const document = await this.sourceDocument(target.document.path);
                const annotation = this.annotation(target.unit, { locked: args[1].toUpperCase() === 'ON' });
                const params = {
                    source: document.getText(), path: target.document.path,
                    expectedHash: target.document.sourceHash, unitId: target.unit.id, annotation,
                };
                const proposal = target.unit.annotation
                    ? await this.adapter.updateAnnotation(params)
                    : await this.adapter.adoptUnit(params);
                const edit = new vscode.WorkspaceEdit();
                this.addProposal(edit, document, proposal);
                if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the source edit.');
                this.postCommandResult(true, `LOCK: ${target.unit.qualifiedName} ${args[1].toUpperCase()}`);
                return;
            }
        } catch (error) {
            this.postCommandResult(false, `${command}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private selectFromEditor(editor: vscode.TextEditor): void {
        const root = this.workspaceRoot();
        if (!root || !this.snapshot || editor.document.languageId !== 'python') return;
        const relativePath = path.relative(root.uri.fsPath, editor.document.uri.fsPath).replace(/\\/g, '/');
        const document = this.snapshot.documents.find(item => item.path === relativePath);
        if (!document) return;
        const position = editor.selection.active;
        const matches = document.units.filter(unit => contains(unit.ranges.declaration, position));
        matches.sort((left, right) => right.qualifiedName.split('.').length - left.qualifiedName.split('.').length);
        void this.panel.webview.postMessage({ type: 'selectUnit', unitId: matches[0]?.id ?? null });
    }

    dispose(): void {
        if (HarnessPanel.current !== this) return;
        HarnessPanel.current = undefined;
        this.panel.dispose();
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.generation?.abort();
        this.refreshGeneration++;
        while (this.disposables.length) this.disposables.pop()?.dispose();
    }
}
