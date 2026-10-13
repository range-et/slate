import * as vscode from 'vscode';

import { HarnessPanel } from './harness_panel';
import { compileSlateFolder, portPythonFolder } from './port_compile_host';
import { PythonAdapter } from './python_adapter';
import { CONFIG_PATH, LAYOUT_PATH, NODES_DIR, serializeLayout } from './slate_folder';
import { SlateFolderHost } from './slate_folder_host';

let pythonAdapter: PythonAdapter | undefined;

export function activate(context: vscode.ExtensionContext): void {
    pythonAdapter = new PythonAdapter();
    const subscriptions: vscode.Disposable[] = [
        vscode.commands.registerCommand('slate.openHarness', () => {
            if (pythonAdapter) void HarnessPanel.createOrShow(context, pythonAdapter);
        }),
        vscode.commands.registerCommand('slate.newProject', () => createNewSlateProject()),
        vscode.commands.registerCommand('slate.portProject', (source?: vscode.Uri) => portProject(source)),
        vscode.commands.registerCommand('slate.compile', () => compileProject()),
        vscode.window.registerWebviewViewProvider('slate.launcher', new SlateLauncherView()),
        vscode.window.registerCustomEditorProvider(
            'slate.editor',
            new HarnessEditorProvider(context, pythonAdapter),
            { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
        ),
    ];
    if (context.extensionMode === vscode.ExtensionMode.Test) {
        subscriptions.push(
            vscode.commands.registerCommand('slate.test.getSnapshot', () => HarnessPanel.current?.snapshotForTest()),
            vscode.commands.registerCommand('slate.test.revealUnit', (unitId: string) => HarnessPanel.current?.revealUnit(unitId, true)),
            vscode.commands.registerCommand('slate.test.postMessage', (message: unknown) => HarnessPanel.current?.postMessageForTest(message)),
        );
    }
    context.subscriptions.push(...subscriptions);
}

export function deactivate(): void {
    HarnessPanel.current?.dispose();
    pythonAdapter?.dispose();
    pythonAdapter = undefined;
}

async function createNewSlateProject(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage('Open a workspace folder first; Slate creates its slate/ folder there.');
        return;
    }
    const config = vscode.Uri.joinPath(folder.uri, ...CONFIG_PATH.split('/'));
    try {
        await vscode.workspace.fs.stat(config);
        vscode.window.showWarningMessage(`${CONFIG_PATH} already exists. Opening it.`);
    } catch {
        const name = await vscode.window.showInputBox({
            prompt: 'Slate project name',
            value: folder.name,
            validateInput: value => value && /^[A-Za-z0-9_-]+$/.test(value) ? null : 'Use letters, numbers, _ or -',
        });
        if (!name) return;
        const encoder = new TextEncoder();
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ...NODES_DIR.split('/')));
        await vscode.workspace.fs.writeFile(config, encoder.encode(`${JSON.stringify({ slate: 3, name, language: 'python' }, null, 2)}\n`));
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(folder.uri, ...LAYOUT_PATH.split('/')),
            encoder.encode(serializeLayout({ positions: {}, notes: [] })),
        );
    }
    await vscode.commands.executeCommand('vscode.openWith', config, 'slate.editor');
}

async function portProject(source?: vscode.Uri): Promise<number> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage('Open a workspace folder first; Slate writes its slate/ folder there.');
        return 0;
    }
    const count = await portPythonFolder(folder.uri, source);
    if (count > 0) await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(folder.uri, ...CONFIG_PATH.split('/')), 'slate.editor');
    return count;
}

async function compileProject(): Promise<Awaited<ReturnType<typeof compileSlateFolder>> | undefined> {
    const root = HarnessPanel.current?.folderRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root || !await SlateFolderHost.detect(root)) {
        vscode.window.showErrorMessage(`No ${CONFIG_PATH} found. Create or port a Slate project first.`);
        return undefined;
    }
    return compileSlateFolder(root);
}

class SlateLauncherView implements vscode.WebviewViewProvider {
    resolveWebviewView(view: vscode.WebviewView): void {
        view.webview.options = { enableScripts: true };
        const nonce = makeNonce();
        const csp = `default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'`;
        view.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px;line-height:1.5}h3{margin:0 0 8px;font-size:13px;letter-spacing:.06em}p{font-size:12px;opacity:.75}button{width:100%;padding:7px 10px;margin-bottom:8px;font:inherit;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}</style></head><body>
<h3>Slate</h3><p>Compose Python as nodes in a slate/ folder, with a local llama.cpp server as helper.</p>
<button id="open">Open Slate Canvas</button><button class="secondary" id="new">New Slate Project…</button><button class="secondary" id="port">Port Python Project…</button><button class="secondary" id="compile">Compile Project</button>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();for(const id of ['open','new','port','compile'])document.getElementById(id).addEventListener('click',()=>vscode.postMessage({type:id}));</script>
</body></html>`;
        view.webview.onDidReceiveMessage(message => {
            const command = { open: 'slate.openHarness', new: 'slate.newProject', port: 'slate.portProject', compile: 'slate.compile' }[message?.type as string];
            if (command) void vscode.commands.executeCommand(command);
        });
    }
}

class HarnessEditorProvider implements vscode.CustomTextEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext, private readonly adapter: PythonAdapter) {}

    // Registered only for slate/slate.json (see package.json customEditors).
    resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
        HarnessPanel.attachToFolder(this.context, this.adapter, panel, document);
    }
}

function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let index = 0; index < 32; index++) value += chars.charAt(Math.floor(Math.random() * chars.length));
    return value;
}
