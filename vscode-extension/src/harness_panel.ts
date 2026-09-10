import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { HarnessDocument, HarnessSnapshot, ParseModuleResult, SourceRange } from './harness_protocol';
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

    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly worker: PythonWorker,
        private readonly panel: vscode.WebviewPanel,
    ) {
        panel.webview.html = buildHtml(context, panel.webview);
        panel.onDidDispose(() => this.dispose(), null, this.disposables);
        panel.webview.onDidReceiveMessage(message => this.handleMessage(message), null, this.disposables);

        const root = this.workspaceRoot();
        const watcher = vscode.workspace.createFileSystemWatcher(
            root ? new vscode.RelativePattern(root, '**/*.py') : '**/*.py'
        );
        watcher.onDidCreate(() => this.scheduleRefresh(), null, this.disposables);
        watcher.onDidChange(() => this.scheduleRefresh(), null, this.disposables);
        watcher.onDidDelete(() => this.scheduleRefresh(), null, this.disposables);
        this.disposables.push(
            watcher,
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document.languageId === 'python') this.scheduleRefresh();
            }),
            vscode.window.onDidChangeTextEditorSelection(event => this.selectFromEditor(event.textEditor)),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) this.selectFromEditor(editor);
            }),
        );
    }

    private workspaceRoot(): vscode.WorkspaceFolder | undefined {
        return vscode.workspace.workspaceFolders?.[0];
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
                new vscode.RelativePattern(root, '**/*.py'),
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
