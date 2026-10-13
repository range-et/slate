import * as vscode from 'vscode';

export async function run(): Promise<void> {
    const root = vscode.workspace.workspaceFolders![0].uri;
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(root, 'folder_project', 'slate', 'slate.json'), 'slate.editor');
    await new Promise(resolve => setTimeout(resolve, 60_000));
}
