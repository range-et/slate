import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

import { BoardNote, HarnessDocument, HarnessSnapshot, ParsedUnit, ParseModuleResult, SourceProposal, SourceRange } from './harness_protocol';
import { buildGenerationPacket, GenerationPacket, stripModelEnvelope } from './generation';
import { streamLlamaCompletion } from './llama_transport';
import { DESCRIBE_OUTPUT_TOKENS, DESCRIBE_SYSTEM, describeNodes } from './port/describe';
import { compileSlateFolder, slateOutput } from './port_compile_host';
import { PythonAdapter } from './python_adapter';
import { loadProject, serializeProject } from './project_v2';
import { searchUnits } from './search';
import { checkNodeCode, codeLines, nodeFromSignature, nodeIdForPath } from './slate_folder';
import { SlateFolderHost } from './slate_folder_host';

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
    private describeRun: AbortController | undefined;
    private pendingProposal: {
        id: string;
        packet: GenerationPacket;
        proposal: SourceProposal;
        candidate: string;
        path: string;
    } | undefined;
    private lastAcceptedUnitId: string | undefined;

    static async createOrShow(context: vscode.ExtensionContext, adapter: PythonAdapter): Promise<HarnessPanel> {
        if (HarnessPanel.current) {
            HarnessPanel.current.panel.reveal();
            HarnessPanel.current.scheduleRefresh(0);
            return HarnessPanel.current;
        }
        const workspace = vscode.workspace.workspaceFolders?.[0];
        const folder = workspace && await SlateFolderHost.detect(workspace.uri)
            ? new SlateFolderHost(workspace.uri)
            : undefined;
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
        HarnessPanel.current = folder
            ? new HarnessPanel(context, adapter, panel, { uri: folder.root, name: workspace!.name }, undefined, folder)
            : new HarnessPanel(context, adapter, panel);
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
        const folder = new SlateFolderHost(root);
        HarnessPanel.current = new HarnessPanel(context, adapter, panel, { uri: root, name: path.basename(root.fsPath) }, undefined, folder);
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
        private readonly folder?: SlateFolderHost,
    ) {
        panel.webview.html = buildHtml(context, panel.webview);
        panel.onDidDispose(() => this.dispose(), null, this.disposables);
        panel.webview.onDidReceiveMessage(message => this.handleMessage(message), null, this.disposables);

        const root = this.workspaceRoot();
        const watcher = vscode.workspace.createFileSystemWatcher(
            folder ? folder.nodePattern()
                : root ? new vscode.RelativePattern(root.uri.fsPath, '**/*.py') : '**/*.py'
        );
        watcher.onDidCreate(() => this.scheduleRefresh(), null, this.disposables);
        watcher.onDidChange(() => this.scheduleRefresh(), null, this.disposables);
        watcher.onDidDelete(() => this.scheduleRefresh(), null, this.disposables);
        this.disposables.push(
            watcher,
            vscode.workspace.onDidChangeTextDocument(event => {
                if (this.folder ? this.folder.nodeId(event.document.uri) !== null
                    : event.document.languageId === 'python'
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
        if (this.folder) return this.refreshFolder(this.folder);
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

    private async refreshFolder(folder: SlateFolderHost): Promise<void> {
        const generation = ++this.refreshGeneration;
        try {
            const index = await folder.index();
            if (generation !== this.refreshGeneration) return;
            this.sources = index.sources;
            this.snapshot = {
                revision: ++this.revision,
                projectName: index.config.name,
                mode: 'folder',
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
            await (this.folder ? this.updateFolderLayout(this.folder, value) : this.updateLayout(value));
            return;
        }
        if (this.folder && ['noteCreate', 'noteUpdate', 'noteDelete'].includes(value.type as string)) {
            await this.updateFolderNotes(this.folder, value);
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
            if (this.folder) await this.handleFolderAction(this.folder, value.action as Record<string, unknown>);
            else await this.handleAction(value.action as Record<string, unknown>, value.revision);
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
            const source = this.folder
                ? this.sources.get(target.document.path) ?? ''
                : (await this.sourceDocument(target.document.path)).getText();
            const proposal = await this.adapter.replaceUnit({
                source,
                path: target.document.path,
                expectedHash: packet.items[0].sourceHash,
                unitId,
                replacement: candidate,
                nodeId: this.folder ? nodeIdForPath(target.document.path) ?? undefined : undefined,
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
            if (this.folder) {
                await this.acceptFolderProposal(this.folder, pending);
                return;
            }
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

    private async sourceDocument(documentPath: string): Promise<vscode.TextDocument> {
        const root = this.workspaceRoot();
        if (!root) throw new Error('Open a project first.');
        return vscode.workspace.openTextDocument(vscode.Uri.joinPath(root.uri, ...documentPath.split('/')));
    }

    async revealUnit(unitId: string, focus = false): Promise<void> {
        if (!this.snapshot) throw new Error('The graph is not indexed yet.');
        if (this.folder) {
            const document = this.snapshot.documents.find(item => item.units.some(unit => unit.id === unitId));
            if (!document) throw new Error(`Node ${unitId} is not indexed.`);
            const text = await vscode.workspace.openTextDocument(this.folder.uri(document.path));
            const editor = await vscode.window.showTextDocument(text, {
                preview: false, preserveFocus: !focus, viewColumn: vscode.ViewColumn.Beside,
            });
            const line = SlateFolderHost.codeLine(text.getText());
            editor.selection = new vscode.Selection(line, 0, line, 0);
            editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            return;
        }
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

    /** Project root (parent of slate/) in folder mode. */
    get folderRoot(): vscode.Uri | undefined {
        return this.folder?.root;
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

    /** Legacy project-v2 mode: annotation edits inside Python modules (retires in S-203). */
    private async handleAction(action: Record<string, unknown>, revision: unknown): Promise<void> {
        if (!this.snapshot) return;
        const label = String(action.kind);
        if (revision !== this.snapshot.revision) {
            this.postCommandResult(false, `${label}: graph changed; try again`);
            return;
        }
        try {
            if (action.kind === 'refreshIndex') {
                await this.refresh();
                const invalid = this.snapshot?.documents.filter(document => !document.valid).length ?? 0;
                this.postCommandResult(invalid === 0, invalid === 0
                    ? 'Source graph is current; all Python modules parse.'
                    : `${invalid} invalid Python module${invalid === 1 ? '' : 's'}.`);
                return;
            }
            if (action.kind === 'saveWorkspace') {
                const saved = await vscode.workspace.saveAll(false);
                this.postCommandResult(saved, saved ? 'Saved.' : 'One or more files were not saved.');
                return;
            }
            if (this.projectDocument && loadProject(this.projectDocument.getText()).readOnly) {
                throw new Error('This project uses a newer schema and is read-only.');
            }
            let target: { document: HarnessDocument; unit: ParsedUnit };
            let overrides: Record<string, unknown>;
            if (action.kind === 'setAnnotationField' && typeof action.target === 'string' && typeof action.text === 'string'
                && (action.field === 'intent' || action.field === 'contract')) {
                target = this.resolveUnit(action.target);
                overrides = { [action.field]: action.text };
            } else if (action.kind === 'setContext' && typeof action.consumer === 'string'
                && typeof action.dependency === 'string' && typeof action.enabled === 'boolean') {
                target = this.resolveUnit(action.consumer);
                const dependency = this.resolveUnit(action.dependency);
                if (target.unit.id === dependency.unit.id) throw new Error('A unit cannot borrow itself.');
                if (dependency.unit.identity !== 'durable') {
                    throw new Error(`Give ${dependency.unit.qualifiedName} an intent before using it as context.`);
                }
                const current = Array.isArray(target.unit.annotation?.dependencies)
                    ? target.unit.annotation.dependencies.filter(value => typeof value === 'string') as string[]
                    : [];
                overrides = {
                    dependencies: action.enabled
                        ? [...new Set([...current, dependency.unit.id])]
                        : current.filter(id => id !== dependency.unit.id),
                };
            } else if (action.kind === 'setLock' && typeof action.target === 'string' && typeof action.locked === 'boolean') {
                target = this.resolveUnit(action.target);
                overrides = { locked: action.locked };
            } else {
                throw new Error('That action is not available in source-map mode.');
            }
            const document = await this.sourceDocument(target.document.path);
            const params = {
                source: document.getText(), path: target.document.path,
                expectedHash: target.document.sourceHash, unitId: target.unit.id,
                annotation: this.annotation(target.unit, overrides),
            };
            const proposal = target.unit.annotation
                ? await this.adapter.updateAnnotation(params)
                : await this.adapter.adoptUnit(params);
            const edit = new vscode.WorkspaceEdit();
            this.addProposal(edit, document, proposal);
            if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the source edit.');
            this.postCommandResult(true, `Updated ${target.unit.qualifiedName}.`);
        } catch (error) {
            this.postCommandResult(false, `${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private selectFromEditor(editor: vscode.TextEditor): void {
        if (this.folder) {
            const nodeId = this.folder.nodeId(editor.document.uri);
            if (nodeId && this.validUnitId(nodeId)) void this.panel.webview.postMessage({ type: 'selectUnit', unitId: nodeId });
            return;
        }
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
        this.describeRun?.abort();
        this.refreshGeneration++;
        while (this.disposables.length) this.disposables.pop()?.dispose();
    }
}
