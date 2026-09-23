import * as assert from 'assert';
import * as path from 'path';

import * as vscode from 'vscode';

type Snapshot = {
    documents: Array<{
        path: string;
        units: Array<{ id: string; name: string }>;
    }>;
};

async function waitForSnapshot(predicate: (snapshot: Snapshot) => boolean): Promise<Snapshot> {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
        const snapshot = await vscode.commands.executeCommand<Snapshot | undefined>('slate.test.getSnapshot');
        if (snapshot && predicate(snapshot)) return snapshot;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for the Slate harness snapshot.');
}

suite('Slate Extension Host', () => {
    test('indexes dirty buffers, reveals exact units, and preserves native undo', async () => {
        const extension = vscode.extensions.getExtension('indrajeet-haldar.slate-code');
        assert.ok(extension, 'Slate extension is installed in the test host');
        await extension.activate();

        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(root, 'fixture workspace is open');
        const sourceUri = vscode.Uri.joinPath(root, 'sample.py');
        const projectUri = vscode.Uri.joinPath(root, 'fixture.slate.json');
        const source = await vscode.workspace.openTextDocument(sourceUri);
        const editor = await vscode.window.showTextDocument(source);
        await editor.edit(builder => builder.insert(new vscode.Position(source.lineCount, 0), '\ndef dirty_only(value: int) -> int:\n    return value + 1\n'));
        assert.equal(source.isDirty, true);

        await vscode.commands.executeCommand('vscode.openWith', projectUri, 'slate.editor');
        const snapshot = await waitForSnapshot(value =>
            value.documents.some(document => document.units.some(unit => unit.name === 'dirty_only'))
        );
        const unit = snapshot.documents.flatMap(document => document.units).find(candidate => candidate.name === 'dirty_only');
        assert.ok(unit, 'dirty-buffer function is indexed');

        await vscode.commands.executeCommand('slate.test.revealUnit', unit.id);
        assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), sourceUri.toString());
        assert.equal(vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection), 'dirty_only');

        const current = vscode.window.activeTextEditor!.document;
        const returnOffset = current.getText().indexOf('return name.upper()');
        assert.ok(returnOffset >= 0);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(current.uri, new vscode.Range(
            current.positionAt(returnOffset),
            current.positionAt(returnOffset + 'return name.upper()'.length),
        ), 'return name.lower()');
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        assert.ok(current.getText().includes('return name.lower()'));
        await vscode.commands.executeCommand('undo');
        assert.ok(current.getText().includes('return name.upper()'));
    });
});
