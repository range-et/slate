import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

import { HarnessDocument, HarnessSnapshot, ParsedUnit, ParseModuleResult, SourceProposal, SourceRange } from './harness_protocol';
import { legacyContextEdges, readProjectBinding, readProjectLayout, writeProjectLayout } from './legacy_project';
import { PythonWorker } from './python_worker';

const PYTHON_EXCLUDE = '**/{.git,.venv,venv,node_modules,__pycache__,dist,build}/**';

function nonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let index = 0; index < 32; index++) {
        value += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return value;
}

function isPosition(value: unknown): value is { line: number; character: number } {
    if (!value || typeof value !== 'object') return false;
    const position = value as Record<string, unknown>;
    return Number.isInteger(position.line) && (position.line as number) >= 0
        && Number.isInteger(position.character) && (position.character as number) >= 0;
}

function isRange(value: unknown): value is SourceRange {
    if (!value || typeof value !== 'object') return false;
    const range = value as Record<string, unknown>;
    return isPosition(range.start) && isPosition(range.end);
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
    private snapshot: HarnessSnapshot | undefined;
    private refreshTimer: NodeJS.Timeout | undefined;
    private refreshGeneration = 0;
    private revision = 0;

    static createOrShow(context: vscode.ExtensionContext, worker: PythonWorker): HarnessPanel {
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
        HarnessPanel.current = new HarnessPanel(context, worker, panel);
        return HarnessPanel.current;
    }

    static attachToProject(
        context: vscode.ExtensionContext,
        worker: PythonWorker,
        panel: vscode.WebviewPanel,
        projectDocument: vscode.TextDocument,
    ): HarnessPanel {
        HarnessPanel.current?.dispose();
        const projectDirectory = path.dirname(projectDocument.uri.fsPath);
        const binding = readProjectBinding(projectDocument.getText());
        const rootUri = vscode.Uri.file(path.resolve(projectDirectory, binding.root));
        HarnessPanel.current = new HarnessPanel(context, worker, panel, {
            uri: rootUri,
            name: binding.name ?? path.basename(rootUri.fsPath),
        }, projectDocument);
        return HarnessPanel.current;
    }

    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly worker: PythonWorker,
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
            const uris = await vscode.workspace.findFiles(
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
            for (const uri of uris) {
                if (generation !== this.refreshGeneration) return;
                const relativePath = path.relative(root.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
                const open = openDocuments.get(uri.toString());
                const source = open
                    ? open.getText()
                    : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
                const parsed = await this.worker.parseModule(source, relativePath);
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
            documents.sort((left, right) => left.path.localeCompare(right.path));
            this.snapshot = {
                revision: ++this.revision,
                projectName: root.name,
                documents,
                contextEdges: this.projectDocument
                    ? legacyContextEdges(this.projectDocument.getText(), documents)
                    : [],
                layout: this.projectDocument
                    ? readProjectLayout(this.projectDocument.getText())
                    : this.context.workspaceState.get(this.layoutKey(root), {}),
            };
            await this.panel.webview.postMessage({ type: 'snapshot', snapshot: this.snapshot });
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
        if (value.type === 'command') {
            await this.handleCommand(value);
            return;
        }
        if (value.type !== 'reveal' || typeof value.path !== 'string' || !isRange(value.range)) return;
        const root = this.workspaceRoot();
        if (!root) return;
        const target = vscode.Uri.joinPath(root.uri, ...value.path.split('/'));
        const relative = path.relative(root.uri.fsPath, target.fsPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) return;
        const document = await vscode.workspace.openTextDocument(target);
        const editor = await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        const range = new vscode.Range(
            value.range.start.line,
            value.range.start.character,
            value.range.end.line,
            value.range.end.character,
        );
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    private layoutKey(root: { uri: vscode.Uri }): string {
        return `slate.harness.layout:${root.uri.toString()}`;
    }

    private async updateLayout(message: Record<string, unknown>): Promise<void> {
        const root = this.workspaceRoot();
        if (!root || !this.snapshot || message.revision !== this.snapshot.revision
            || !message.positions || typeof message.positions !== 'object') return;
        const validIds = new Set(this.snapshot.documents.flatMap(document => [
            document.id,
            ...document.units.map(unit => unit.id),
        ]));
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

        const replacement = writeProjectLayout(this.projectDocument.getText(), positions);
        if (replacement === null || replacement === this.projectDocument.getText()) return;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            this.projectDocument.uri,
            new vscode.Range(
                this.projectDocument.positionAt(0),
                this.projectDocument.positionAt(this.projectDocument.getText().length),
            ),
            replacement,
        );
        const applied = await vscode.workspace.applyEdit(edit);
        if (applied) await this.projectDocument.save();
    }

    private postCommandResult(ok: boolean, message: string): void {
        void this.panel.webview.postMessage({ type: 'commandResult', ok, message });
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
                const proposal = await this.worker.insertStub({
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
                    ? await this.worker.updateAnnotation(params)
                    : await this.worker.adoptUnit(params);
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
                    ? await this.worker.updateAnnotation(params)
                    : await this.worker.adoptUnit(params);
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
                    ? await this.worker.updateAnnotation(params)
                    : await this.worker.adoptUnit(params);
                const edit = new vscode.WorkspaceEdit();
                this.addProposal(edit, document, proposal);
                if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the source edit.');
                this.postCommandResult(true, `LOCK: ${target.unit.qualifiedName} ${args[1].toUpperCase()}`);
                return;
            }
            if (command === 'REASSIGN') {
                const args = parts.length > 1 ? parts : rawArgs.trim().split(/\s+/);
                if (args.length !== 2) throw new Error('Usage: REASSIGN unit :: target.py');
                const source = this.resolveUnit(args[0]);
                const target = this.resolveDocument(args[1]);
                const sourceDocument = await this.sourceDocument(source.document.path);
                const targetDocument = await this.sourceDocument(target.path);
                const proposal = await this.worker.moveUnit({
                    source: sourceDocument.getText(), sourcePath: source.document.path,
                    expectedSourceHash: source.document.sourceHash,
                    targetSource: targetDocument.getText(), targetPath: target.path,
                    expectedTargetHash: target.sourceHash, unitId: source.unit.id,
                    annotation: this.annotation(source.unit),
                });
                const edit = new vscode.WorkspaceEdit();
                this.addProposal(edit, sourceDocument, proposal.source);
                this.addProposal(edit, targetDocument, proposal.target);
                if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the source edit.');
                this.postCommandResult(true, `REASSIGN: moved ${source.unit.qualifiedName} to ${target.path}`);
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
        this.refreshGeneration++;
        while (this.disposables.length) this.disposables.pop()?.dispose();
    }
}
