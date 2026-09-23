import { randomUUID } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';

import { HarnessPanel } from './harness_panel';
import { createProjectV2, serializeProject } from './project_v2';
import { PythonAdapter } from './python_adapter';

let pythonAdapter: PythonAdapter | undefined;

export function activate(context: vscode.ExtensionContext): void {
    pythonAdapter = new PythonAdapter();
    const subscriptions: vscode.Disposable[] = [
        vscode.commands.registerCommand('slate.openHarness', () => {
            if (pythonAdapter) HarnessPanel.createOrShow(context, pythonAdapter);
        }),
        vscode.commands.registerCommand('slate.newProject', () => createNewSlateProject()),
        vscode.commands.registerCommand('slate.scanWorkspace', () => scanWorkspaceToFile()),
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
        vscode.window.showErrorMessage('Open a workspace folder first; Slate writes its project file there.');
        return;
    }
    const name = await vscode.window.showInputBox({
        prompt: 'Slate project name',
        placeHolder: 'my-app',
        validateInput: value => value && /^[A-Za-z0-9_-]+$/.test(value) ? null : 'Use letters, numbers, _ or -',
    });
    if (!name) return;
    const target = vscode.Uri.joinPath(folder.uri, `${name}.slate.json`);
    try {
        await vscode.workspace.fs.stat(target);
        vscode.window.showWarningMessage(`${name}.slate.json already exists. Opening it.`);
    } catch {
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(serializeProject(createProjectV2(name))));
    }
    await vscode.commands.executeCommand('vscode.openWith', target, 'slate.editor');
}

async function scanWorkspaceToFile(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !pythonAdapter) {
        vscode.window.showErrorMessage('Open a workspace folder first.');
        return;
    }
    const projectName = folder.name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'project';
    const target = vscode.Uri.joinPath(folder.uri, `${projectName}.slate.json`);
    try {
        await vscode.workspace.fs.stat(target);
        const choice = await vscode.window.showWarningMessage(
            `${projectName}.slate.json exists. Replace it with a fresh scan?`, { modal: true }, 'Replace',
        );
        if (choice !== 'Replace') return;
    } catch {
        // The scan creates a new project file.
    }
    const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*.py'),
        '**/{.git,.venv,venv,node_modules,__pycache__,dist,build}/**',
    );
    const documents = [];
    let unitCount = 0;
    for (const uri of uris) {
        const relativePath = path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
        const source = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        const parsed = await pythonAdapter.parseModule(source, relativePath);
        unitCount += parsed.units.length;
        documents.push({
            id: randomUUID(),
            path: relativePath,
            cards: parsed.units.filter(unit => unit.identity === 'durable').map(unit => ({ id: unit.id, kind: unit.kind })),
        });
    }
    const project = createProjectV2(projectName, documents);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(serializeProject(project)));
    vscode.window.showInformationMessage(`Slate: tracked ${documents.length} files and indexed ${unitCount} units.`);
    await vscode.commands.executeCommand('vscode.openWith', target, 'slate.editor');
}

class SlateLauncherView implements vscode.WebviewViewProvider {
    resolveWebviewView(view: vscode.WebviewView): void {
        view.webview.options = { enableScripts: true };
        const nonce = makeNonce();
        const csp = `default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'`;
        view.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px;line-height:1.5}h3{margin:0 0 8px;font-size:13px;letter-spacing:.06em}p{font-size:12px;opacity:.75}button{width:100%;padding:7px 10px;margin-bottom:8px;font:inherit;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}</style></head><body>
<h3>Slate</h3><p>Navigate, contextualize, and implement typed Python units with a local llama.cpp server.</p>
<button id="open">Open Python Harness</button><button class="secondary" id="new">New Slate Project…</button><button class="secondary" id="scan">Scan Python Workspace</button>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();for(const [id,type] of [['open','open'],['new','new-project'],['scan','scan']])document.getElementById(id).addEventListener('click',()=>vscode.postMessage({type}));</script>
</body></html>`;
        view.webview.onDidReceiveMessage(message => {
            if (message?.type === 'open') void vscode.commands.executeCommand('slate.openHarness');
            if (message?.type === 'new-project') void vscode.commands.executeCommand('slate.newProject');
            if (message?.type === 'scan') void vscode.commands.executeCommand('slate.scanWorkspace');
        });
    }
}

class HarnessEditorProvider implements vscode.CustomTextEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext, private readonly adapter: PythonAdapter) {}

    resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
        HarnessPanel.attachToProject(this.context, this.adapter, panel, document);
    }
}

function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let index = 0; index < 32; index++) value += chars.charAt(Math.floor(Math.random() * chars.length));
    return value;
}
