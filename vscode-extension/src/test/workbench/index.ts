import * as vscode from 'vscode';

export async function run(): Promise<void> {
    if (process.env.SLATE_QA_LLAMA_ENDPOINT) {
        await vscode.workspace.getConfiguration('slate.llama').update('endpoint', process.env.SLATE_QA_LLAMA_ENDPOINT, vscode.ConfigurationTarget.Global);
    }
    const root = vscode.workspace.workspaceFolders![0].uri;
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(root, 'folder_project', 'slate', 'slate.json'), 'slate.editor');
    await new Promise(resolve => setTimeout(resolve, 60_000));
}
