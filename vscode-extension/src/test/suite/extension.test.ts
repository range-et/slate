import * as assert from 'assert';
import * as path from 'path';

import * as vscode from 'vscode';

type Snapshot = {
    revision: number;
    mode?: 'folder';
    notes?: Array<{ id: string; title: string; body: string; attachedTo: string | null }>;
    layout?: Record<string, { x: number; y: number }>;
    documents: Array<{
        path: string;
        sourceHash: string;
        diagnostics: Array<{ code: string }>;
        units: Array<{ id: string; name: string; annotation: Record<string, unknown> | null }>;
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

    test('persists board notes in project metadata without changing Python', async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(root, 'fixture workspace is open');
        const sourceUri = vscode.Uri.joinPath(root, 'sample.py');
        const projectUri = vscode.Uri.joinPath(root, 'fixture.slate.json');
        const sourceBefore = new TextDecoder().decode(await vscode.workspace.fs.readFile(sourceUri));
        const projectBefore = await vscode.workspace.fs.readFile(projectUri);

        try {
            await vscode.commands.executeCommand('vscode.openWith', projectUri, 'slate.editor');
            const initial = await waitForSnapshot(snapshot => snapshot.documents.length > 0);
            const attachedTo = initial.documents.flatMap(document => document.units)[0]?.id;
            assert.ok(attachedTo, 'fixture contains an attachable source unit');
            await vscode.commands.executeCommand('slate.test.postMessage', {
                type: 'noteCreate', revision: initial.revision, x: 321, y: 123, attachedTo,
            });
            const created = await waitForSnapshot(snapshot => snapshot.notes?.length === 1);
            const note = created.notes![0];
            await vscode.commands.executeCommand('slate.test.postMessage', {
                type: 'noteUpdate', revision: created.revision, noteId: note.id,
                title: 'Review behavior', body: 'Keep this on the board.', attachedTo,
            });
            const updated = await waitForSnapshot(snapshot => snapshot.notes?.[0]?.title === 'Review behavior');

            const project = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(projectUri)));
            assert.deepEqual(project.notes, [{ id: note.id, title: 'Review behavior', body: 'Keep this on the board.', attachedTo }]);
            assert.deepEqual(project.layout[note.id], { x: 321, y: 123 });
            assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(sourceUri)), sourceBefore);

            await vscode.commands.executeCommand('slate.test.postMessage', {
                type: 'noteDelete', revision: updated.revision, noteId: note.id,
            });
            await waitForSnapshot(snapshot => snapshot.notes?.length === 0);
            const afterDelete = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(projectUri)));
            assert.deepEqual(afterDelete.notes, []);
            assert.equal(afterDelete.layout[note.id], undefined);
            assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(sourceUri)), sourceBefore);
        } finally {
            await vscode.workspace.fs.writeFile(projectUri, projectBefore);
        }
    });

    test('edits slate/ node JSON through the folder host without re-indexing on layout', async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(root, 'fixture workspace is open');
        const folder = vscode.Uri.joinPath(root, 'folder_project', 'slate');
        const configUri = vscode.Uri.joinPath(folder, 'slate.json');
        const layoutUri = vscode.Uri.joinPath(folder, 'layout.json');
        const normalizeUri = vscode.Uri.joinPath(folder, 'nodes', 'normalize.json');
        const clampUri = vscode.Uri.joinPath(folder, 'nodes', 'clamp.json');
        const read = async (uri: vscode.Uri) => new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        const layoutBefore = await read(layoutUri);
        const normalizeBefore = await read(normalizeUri);
        const clampBefore = await read(clampUri);
        const post = (message: unknown) => vscode.commands.executeCommand('slate.test.postMessage', message);

        try {
            await vscode.commands.executeCommand('vscode.openWith', configUri, 'slate.editor');
            const initial = await waitForSnapshot(snapshot => snapshot.mode === 'folder' && snapshot.documents.length === 2);
            const normalize = initial.documents.find(document => document.path === 'slate/nodes/normalize.json');
            assert.ok(normalize, 'normalize node is indexed by its path');
            assert.deepEqual(normalize.diagnostics, []);
            assert.equal(normalize.units[0].id, 'normalize');
            assert.deepEqual(normalize.units[0].annotation?.dependencies, ['clamp']);

            // Layout is a plain write: the file changes, the revision does not.
            await post({ type: 'layout', revision: initial.revision, positions: { normalize: { x: 512, y: 256 } } });
            assert.deepEqual(JSON.parse(await read(layoutUri)).positions.normalize, { x: 512, y: 256 });
            await new Promise(resolve => setTimeout(resolve, 600));
            const afterLayout = await vscode.commands.executeCommand<Snapshot>('slate.test.getSnapshot');
            assert.equal(afterLayout?.revision, initial.revision);

            // Metadata edits touch only that field.
            await post({ type: 'action', action: { kind: 'setAnnotationField', target: 'normalize', field: 'intent', text: 'Scale a score to 0–100' } });
            const withIntent = JSON.parse(await read(normalizeUri));
            assert.equal(withIntent.intent, 'Scale a score to 0–100');
            assert.equal(withIntent.describedBy, 'human');
            assert.deepEqual(withIntent.code, JSON.parse(normalizeBefore).code);

            // Context added by a wire or the picker lands in the consumer's JSON and can be removed.
            await post({ type: 'action', action: { kind: 'setContext', consumer: 'clamp', dependency: 'normalize', enabled: true } });
            assert.deepEqual(JSON.parse(await read(clampUri)).context, ['normalize']);
            await post({ type: 'action', action: { kind: 'setContext', consumer: 'clamp', dependency: 'normalize', enabled: false } });
            assert.equal(JSON.parse(await read(clampUri)).context, undefined);

            // Code edits are rejected when stale or renamed, accepted otherwise.
            const current = await waitForSnapshot(snapshot => snapshot.documents.some(document =>
                document.units[0]?.annotation?.intent === 'Scale a score to 0–100'));
            const hash = current.documents.find(document => document.path === 'slate/nodes/normalize.json')!.sourceHash;
            const body = 'def normalize(score: int, maximum: int) -> int:\n    return score * 100 // maximum\n';
            await post({ type: 'action', action: { kind: 'setNodeCode', target: 'normalize', code: body, baseHash: 'sha256:stale' } });
            assert.deepEqual(JSON.parse(await read(normalizeUri)).code, JSON.parse(normalizeBefore).code);
            await post({ type: 'action', action: { kind: 'setNodeCode', target: 'normalize', code: body.replace('def normalize', 'def renamed'), baseHash: hash } });
            assert.deepEqual(JSON.parse(await read(normalizeUri)).code, JSON.parse(normalizeBefore).code);
            await post({ type: 'action', action: { kind: 'setNodeCode', target: 'normalize', code: body, baseHash: hash } });
            assert.deepEqual(JSON.parse(await read(normalizeUri)).code, [
                'def normalize(score: int, maximum: int) -> int:',
                '    return score * 100 // maximum',
            ]);
        } finally {
            await vscode.workspace.fs.writeFile(layoutUri, new TextEncoder().encode(layoutBefore));
            await vscode.workspace.fs.writeFile(normalizeUri, new TextEncoder().encode(normalizeBefore));
            await vscode.workspace.fs.writeFile(clampUri, new TextEncoder().encode(clampBefore));
        }
    });

    test('legacy source-map mode applies typed intent actions as one undoable source edit', async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(root, 'fixture workspace is open');
        const sourceUri = vscode.Uri.joinPath(root, 'sample.py');
        const projectUri = vscode.Uri.joinPath(root, 'fixture.slate.json');
        await vscode.commands.executeCommand('vscode.openWith', projectUri, 'slate.editor');
        const snapshot = await waitForSnapshot(value => value.mode === undefined && value.documents.length > 0);
        const unit = snapshot.documents.flatMap(document => document.units).find(candidate => candidate.annotation);
        assert.ok(unit, 'fixture has an annotated unit');
        await vscode.commands.executeCommand('slate.test.postMessage', {
            type: 'action', revision: snapshot.revision,
            action: { kind: 'setAnnotationField', target: unit.id, field: 'intent', text: 'Typed action intent' },
        });
        const source = await vscode.workspace.openTextDocument(sourceUri);
        assert.ok(source.getText().includes('## intent: Typed action intent'), 'intent written into the annotation');
        await vscode.window.showTextDocument(source);
        await vscode.commands.executeCommand('undo');
        assert.ok(!source.getText().includes('Typed action intent'), 'native undo reverts the edit');
    });
});
