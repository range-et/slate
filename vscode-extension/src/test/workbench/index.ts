import * as vscode from 'vscode';

export async function run(): Promise<void> {
    await vscode.commands.executeCommand('slate.openHarness');
    await new Promise(resolve => setTimeout(resolve, 60_000));
}
