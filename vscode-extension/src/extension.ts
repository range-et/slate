import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { scanWorkspace } from './python_scan';

const STATE_KEY = 'slate.persistedState';

interface PersistedState {
    [k: string]: string;
}

const STARTER_PROJECT = (name: string) => ({
    id: undefined,
    name,
    docs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    docCount: 0,
    totalCards: 0
});

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('slate.openPanel', () => SlatePanel.createOrShow(context)),
        vscode.commands.registerCommand('slate.compile', () => {
            const panel = SlatePanel.current;
            if (!panel) {
                vscode.window.showWarningMessage('Open the Slate panel first (Slate: Open Panel).');
                return;
            }
            panel.postMessage({ type: 'compile-current' });
        }),
        vscode.commands.registerCommand('slate.toggleCodeCard', () => {
            const panel = SlatePanel.current;
            if (!panel) {
                vscode.window.showWarningMessage('Open the Slate panel first (Slate: Open Panel).');
                return;
            }
            panel.postMessage({ type: 'toggle-code' });
        }),
        vscode.commands.registerCommand('slate.newProject', () => createNewSlateProject()),
        vscode.commands.registerCommand('slate.scanWorkspace', () => scanWorkspaceToFile()),
        vscode.window.registerWebviewViewProvider('slate.launcher', new SlateLauncherView(context)),
        vscode.window.registerCustomEditorProvider(
            'slate.editor',
            new SlateEditorProvider(context),
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false
            }
        )
    );
}

export function deactivate() {
    SlatePanel.current?.dispose();
}

/**
 * Create a fresh `.slate.json` file in the active workspace folder and open it
 * in the slate custom editor.
 */
async function createNewSlateProject() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage('Open a workspace folder first; slate writes its project file there.');
        return;
    }
    const name = await vscode.window.showInputBox({
        prompt: 'Slate project name',
        placeHolder: 'my-app',
        validateInput: (v) => v && /^[A-Za-z0-9_-]+$/.test(v) ? null : 'Use letters, numbers, _ or -'
    });
    if (!name) return;
    const target = vscode.Uri.joinPath(folder.uri, `${name}.slate.json`);
    try {
        await vscode.workspace.fs.stat(target);
        vscode.window.showWarningMessage(`${name}.slate.json already exists. Opening it.`);
    } catch {
        const starter = JSON.stringify(STARTER_PROJECT(name), null, 2);
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(starter));
    }
    await vscode.commands.executeCommand('vscode.openWith', target, 'slate.editor');
}

/**
 * Walk the active workspace for *.py files, extract top-level symbols into a
 * slate project, write `<workspace_name>.slate.json`, and open it.
 */
async function scanWorkspaceToFile() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage('Open a workspace folder first.');
        return;
    }
    const projectName = folder.name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'project';
    const target = vscode.Uri.joinPath(folder.uri, `${projectName}.slate.json`);

    let overwrite = true;
    try {
        await vscode.workspace.fs.stat(target);
        const choice = await vscode.window.showWarningMessage(
            `${projectName}.slate.json exists. Replace it with a fresh scan?`,
            { modal: true },
            'Replace'
        );
        overwrite = choice === 'Replace';
    } catch {
        // Doesn't exist — we'll create it.
    }
    if (!overwrite) return;

    const project = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Slate: scanning Python workspace…', cancellable: false },
        async () => scanWorkspace(folder.uri.fsPath, projectName)
    );

    if (project.totalCards === 0) {
        vscode.window.showWarningMessage('Slate: no top-level Python symbols found. Wrote an empty project file.');
    } else {
        vscode.window.showInformationMessage(`Slate: scanned ${project.docCount} files, ${project.totalCards} symbols.`);
    }

    const data = new TextEncoder().encode(JSON.stringify(project, null, 2));
    await vscode.workspace.fs.writeFile(target, data);
    await vscode.commands.executeCommand('vscode.openWith', target, 'slate.editor');
}

/**
 * Build the slate webview HTML, rewriting all asset URIs into webview URIs and
 * applying a strict CSP. Optionally bakes an initial project JSON string into
 * the page so slate can hydrate synchronously on first paint.
 */
function buildSlateHtml(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    initialProjectJson?: string
): string {
    const distRoot = vscode.Uri.joinPath(context.extensionUri, 'dist');
    const indexFsPath = path.join(distRoot.fsPath, 'index.html');
    if (!fs.existsSync(indexFsPath)) {
        return `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem;color:#eee;background:#222;">
            <h2>Slate UI bundle missing</h2>
            <p>Expected to find <code>${indexFsPath}</code>.</p>
            <p>From the slate repo root, run <code>npm run build</code> and copy <code>dist/</code> into <code>vscode-extension/dist/</code> (or symlink it).</p>
        </body>`;
    }

    let html = fs.readFileSync(indexFsPath, 'utf8');

    const rewrite = (input: string, attr: 'href' | 'src') => {
        const re = new RegExp(`${attr}="([^"]+)"`, 'g');
        return input.replace(re, (match, url: string) => {
            if (/^https?:\/\//.test(url) || url.startsWith('data:') || url.startsWith('#') || url.startsWith('blob:')) {
                return match;
            }
            const stripped = url.replace(/^\/+/, '');
            const onDisk = vscode.Uri.joinPath(distRoot, stripped);
            const webviewUri = webview.asWebviewUri(onDisk);
            return `${attr}="${webviewUri.toString()}"`;
        });
    };
    html = rewrite(html, 'href');
    html = rewrite(html, 'src');

    const nonce = makeNonce();
    const cspSource = webview.cspSource;
    const csp = [
        `default-src 'none'`,
        `img-src ${cspSource} data: https:`,
        `style-src ${cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
        `font-src ${cspSource} https://fonts.gstatic.com`,
        `script-src 'nonce-${nonce}' ${cspSource}`,
        `connect-src ${cspSource} https://api.openai.com https://generativelanguage.googleapis.com http://localhost:* http://127.0.0.1:*`
    ].join('; ');

    html = html.replace(/<script\b/g, `<script nonce="${nonce}"`);

    const initialState = (context.globalState.get<PersistedState>(STATE_KEY) ?? {});
    const bridgeJs = fs.readFileSync(path.join(context.extensionPath, 'out', 'state-bridge.js'), 'utf8');

    const initialProjectScript = initialProjectJson
        ? `<script nonce="${nonce}">window.__slateInitialProject = ${JSON.stringify(initialProjectJson)};</script>\n`
        : '';

    const headInjection =
        `<meta http-equiv="Content-Security-Policy" content="${csp}">\n` +
        `<script nonce="${nonce}">window.__slateInitialState = ${JSON.stringify(initialState)};</script>\n` +
        initialProjectScript +
        `<script nonce="${nonce}">${bridgeJs}</script>\n`;

    return html.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}>\n${headInjection}`);
}

/**
 * Write a compiled file at `targetDir/filename`, prompting before overwriting,
 * and surface it to the user. Used by both the freestanding SlatePanel
 * (writes to workspace root) and the custom editor (writes alongside the
 * `.slate.json` file).
 */
async function writeCompiledFile(targetDir: vscode.Uri, filename: unknown, source: unknown) {
    if (typeof filename !== 'string' || typeof source !== 'string') {
        vscode.window.showErrorMessage('Slate: invalid compile message.');
        return;
    }
    const safeName = path.basename(filename);
    if (safeName !== filename || safeName.includes('/') || safeName.includes('\\')) {
        vscode.window.showErrorMessage(`Slate: refusing to write file with unsafe name "${filename}".`);
        return;
    }
    const target = vscode.Uri.joinPath(targetDir, safeName);
    try {
        await vscode.workspace.fs.stat(target);
        const choice = await vscode.window.showWarningMessage(
            `${safeName} already exists. Overwrite?`,
            { modal: true },
            'Overwrite'
        );
        if (choice !== 'Overwrite') return;
    } catch {
        // Does not exist — proceed.
    }
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(source));
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.showInformationMessage(`Slate: wrote ${safeName}`);
}

async function persistStateWrite(context: vscode.ExtensionContext, key: unknown, value: unknown) {
    if (typeof key !== 'string') return;
    const state = (context.globalState.get<PersistedState>(STATE_KEY) ?? {});
    if (value === null || typeof value === 'undefined') {
        delete state[key];
    } else if (typeof value === 'string') {
        state[key] = value;
    } else {
        state[key] = String(value);
    }
    await context.globalState.update(STATE_KEY, state);
}

/**
 * The freestanding slate panel: an ephemeral editor not bound to any file.
 * Compile output lands in the workspace root.
 */
class SlatePanel {
    static current: SlatePanel | undefined;
    static readonly viewType = 'slate.panel';

    private readonly panel: vscode.WebviewPanel;
    private readonly context: vscode.ExtensionContext;
    private disposables: vscode.Disposable[] = [];

    static createOrShow(context: vscode.ExtensionContext) {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        if (SlatePanel.current) {
            SlatePanel.current.panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            SlatePanel.viewType,
            'Slate',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'dist'),
                    vscode.Uri.joinPath(context.extensionUri, 'out')
                ]
            }
        );
        SlatePanel.current = new SlatePanel(panel, context);
    }

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
        this.panel = panel;
        this.context = context;

        this.panel.webview.html = buildSlateHtml(this.context, this.panel.webview);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg), null, this.disposables);
    }

    postMessage(msg: unknown) {
        this.panel.webview.postMessage(msg);
    }

    dispose() {
        SlatePanel.current = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }

    private async handleMessage(msg: any) {
        if (!msg || typeof msg.type !== 'string') return;
        switch (msg.type) {
            case 'compile': {
                const folder = vscode.workspace.workspaceFolders?.[0];
                if (!folder) {
                    vscode.window.showErrorMessage('Slate: open a workspace folder before compiling.');
                    return;
                }
                await writeCompiledFile(folder.uri, msg.filename, msg.source);
                break;
            }
            case 'state-write':
                await persistStateWrite(this.context, msg.key, msg.value);
                break;
            // 'state-changed' is only meaningful in the custom-editor flow; ignored here.
            default:
                break;
        }
    }
}

/**
 * The activity-bar entry. Auto-opens the main slate panel the first time the
 * user reveals it, then shows a friendly placeholder with launcher buttons so
 * the icon is always a one-click entry point.
 */
class SlateLauncherView implements vscode.WebviewViewProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    resolveWebviewView(view: vscode.WebviewView) {
        view.webview.options = { enableScripts: true };
        view.webview.html = this.renderHtml(view.webview);
        view.webview.onDidReceiveMessage(msg => {
            if (!msg) return;
            if (msg.type === 'open') vscode.commands.executeCommand('slate.openPanel');
            else if (msg.type === 'new-project') vscode.commands.executeCommand('slate.newProject');
            else if (msg.type === 'scan') vscode.commands.executeCommand('slate.scanWorkspace');
        });
        // Don't auto-open here anymore — with `.slate.json` files driving the
        // primary flow, the activity bar is just a launcher menu.
    }

    private renderHtml(webview: vscode.Webview): string {
        const nonce = makeNonce();
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');
        return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; line-height: 1.5; }
  h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.8; }
  p { margin: 0 0 12px; font-size: 12px; opacity: 0.75; }
  button { width: 100%; padding: 6px 10px; margin-bottom: 8px; font: inherit; cursor: pointer;
           background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  small { font-size: 11px; opacity: 0.6; display: block; margin-top: 8px; }
</style>
</head>
<body>
  <h3>Slate</h3>
  <p>Architect a Python app as a graph of cards. Compile to <code>.py</code>; run in VS Code.</p>
  <button id="new">New Slate Project…</button>
  <button id="scan">Scan Python Workspace</button>
  <button id="open" class="secondary">Open Empty Panel</button>
  <small>Existing <code>*.slate.json</code> files open in the slate editor automatically.</small>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('new').addEventListener('click', () => vscode.postMessage({ type: 'new-project' }));
    document.getElementById('scan').addEventListener('click', () => vscode.postMessage({ type: 'scan' }));
    document.getElementById('open').addEventListener('click', () => vscode.postMessage({ type: 'open' }));
  </script>
</body>
</html>`;
    }
}

/**
 * Custom editor for `*.slate.json` files. Hydrates slate from the document's
 * text and pushes slate state-changes back as WorkspaceEdits so VS Code's
 * standard dirty/save flow Just Works.
 */
class SlateEditorProvider implements vscode.CustomTextEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel) {
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
                vscode.Uri.joinPath(this.context.extensionUri, 'out')
            ]
        };
        panel.webview.html = buildSlateHtml(this.context, panel.webview, document.getText());

        // Track whether the next textDocument change came from us (to avoid feedback loops).
        let suppressNextEcho = false;

        const subs: vscode.Disposable[] = [];

        subs.push(panel.webview.onDidReceiveMessage(async (msg: any) => {
            if (!msg || typeof msg.type !== 'string') return;
            switch (msg.type) {
                case 'state-changed': {
                    if (typeof msg.state !== 'string') return;
                    if (msg.state === document.getText()) return;
                    suppressNextEcho = true;
                    const edit = new vscode.WorkspaceEdit();
                    const fullRange = new vscode.Range(
                        document.positionAt(0),
                        document.positionAt(document.getText().length)
                    );
                    edit.replace(document.uri, fullRange, msg.state);
                    await vscode.workspace.applyEdit(edit);
                    break;
                }
                case 'compile': {
                    const targetDir = vscode.Uri.file(path.dirname(document.uri.fsPath));
                    await writeCompiledFile(targetDir, msg.filename, msg.source);
                    break;
                }
                case 'state-write':
                    await persistStateWrite(this.context, msg.key, msg.value);
                    break;
            }
        }));

        // External edits (file changed on disk, another editor, undo/redo elsewhere).
        subs.push(vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() !== document.uri.toString()) return;
            if (suppressNextEcho) {
                suppressNextEcho = false;
                return;
            }
            panel.webview.postMessage({ type: 'load-state', state: e.document.getText() });
        }));

        panel.onDidDispose(() => subs.forEach(s => s.dispose()));
    }
}

function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
}
