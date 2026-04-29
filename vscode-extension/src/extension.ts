import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const STATE_KEY = 'slate.persistedState';

interface PersistedState {
    [k: string]: string;
}

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
        })
    );
}

export function deactivate() {
    SlatePanel.current?.dispose();
}

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

        this.panel.webview.html = this.buildHtml();
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
            case 'compile':
                await this.writeCompiled(msg.filename, msg.source);
                break;
            case 'state-write':
                await this.persistStateWrite(msg.key, msg.value);
                break;
            default:
                // Ignore unknown messages so future-slate can extend the protocol.
                break;
        }
    }

    private async writeCompiled(filename: unknown, source: unknown) {
        if (typeof filename !== 'string' || typeof source !== 'string') {
            vscode.window.showErrorMessage('Slate: invalid compile message.');
            return;
        }
        // Guard against path traversal: filename must be a bare basename.
        const safeName = path.basename(filename);
        if (safeName !== filename || safeName.includes('/') || safeName.includes('\\')) {
            vscode.window.showErrorMessage(`Slate: refusing to write file with unsafe name "${filename}".`);
            return;
        }

        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            vscode.window.showErrorMessage('Slate: open a workspace folder before compiling.');
            return;
        }
        const target = vscode.Uri.joinPath(folder.uri, safeName);

        // Prompt before overwriting.
        try {
            await vscode.workspace.fs.stat(target);
            const choice = await vscode.window.showWarningMessage(
                `${safeName} already exists. Overwrite?`,
                { modal: true },
                'Overwrite'
            );
            if (choice !== 'Overwrite') return;
        } catch {
            // File does not exist — proceed.
        }

        const data = new TextEncoder().encode(source);
        await vscode.workspace.fs.writeFile(target, data);
        const doc = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showInformationMessage(`Slate: wrote ${safeName}`);
    }

    private async persistStateWrite(key: unknown, value: unknown) {
        if (typeof key !== 'string') return;
        const state = (this.context.globalState.get<PersistedState>(STATE_KEY) ?? {});
        if (value === null || typeof value === 'undefined') {
            delete state[key];
        } else if (typeof value === 'string') {
            state[key] = value;
        } else {
            state[key] = String(value);
        }
        await this.context.globalState.update(STATE_KEY, state);
    }

    private buildHtml(): string {
        const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
        const indexFsPath = path.join(distRoot.fsPath, 'index.html');
        if (!fs.existsSync(indexFsPath)) {
            return `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem;color:#eee;background:#222;">
                <h2>Slate UI bundle missing</h2>
                <p>Expected to find <code>${indexFsPath}</code>.</p>
                <p>From the slate repo root, run <code>npm run build</code> and copy <code>dist/</code> into <code>vscode-extension/dist/</code> (or symlink it).</p>
            </body>`;
        }

        let html = fs.readFileSync(indexFsPath, 'utf8');

        // Rewrite root-relative resource URIs (href="/x", src="/x", and bare relative)
        // into webview URIs anchored at <extension>/dist/.
        const rewrite = (input: string, attr: 'href' | 'src') => {
            const re = new RegExp(`${attr}="([^"]+)"`, 'g');
            return input.replace(re, (match, url: string) => {
                if (/^https?:\/\//.test(url) || url.startsWith('data:') || url.startsWith('#') || url.startsWith('blob:')) {
                    return match;
                }
                const stripped = url.replace(/^\/+/, '');
                const onDisk = vscode.Uri.joinPath(distRoot, stripped);
                const webviewUri = this.panel.webview.asWebviewUri(onDisk);
                return `${attr}="${webviewUri.toString()}"`;
            });
        };
        html = rewrite(html, 'href');
        html = rewrite(html, 'src');

        // Build CSP. Allow Google Fonts (used by monad design tokens) and inline styles
        // emitted by Vite's CSS injection. Scripts run with a nonce.
        const nonce = makeNonce();
        const cspSource = this.panel.webview.cspSource;
        const csp = [
            `default-src 'none'`,
            `img-src ${cspSource} data: https:`,
            `style-src ${cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
            `font-src ${cspSource} https://fonts.gstatic.com`,
            `script-src 'nonce-${nonce}' ${cspSource}`,
            `connect-src ${cspSource} https://api.openai.com https://generativelanguage.googleapis.com http://localhost:* http://127.0.0.1:*`
        ].join('; ');

        // Stamp every <script> tag with the nonce.
        html = html.replace(/<script\b/g, `<script nonce="${nonce}"`);

        // Inject CSP meta + initial state + state-bridge before any other scripts.
        const initialState = (this.context.globalState.get<PersistedState>(STATE_KEY) ?? {});
        const bridgeJs = fs.readFileSync(path.join(this.context.extensionPath, 'out', 'state-bridge.js'), 'utf8');

        const headInjection =
            `<meta http-equiv="Content-Security-Policy" content="${csp}">\n` +
            `<script nonce="${nonce}">window.__slateInitialState = ${JSON.stringify(initialState)};</script>\n` +
            `<script nonce="${nonce}">${bridgeJs}</script>\n`;

        html = html.replace(/<head([^>]*)>/i, (m, attrs) => `<head${attrs}>\n${headInjection}`);

        return html;
    }
}

function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
}
