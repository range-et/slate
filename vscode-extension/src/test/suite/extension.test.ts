import * as assert from 'assert';
import * as http from 'http';
import * as path from 'path';

import * as vscode from 'vscode';

type Snapshot = {
    revision: number;
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
    test('indexes dirty node buffers, reveals node files, and undoes host edits natively', async () => {
        const extension = vscode.extensions.getExtension('indrajeet-haldar.slate-code');
        assert.ok(extension, 'Slate extension is installed in the test host');
        await extension.activate();

        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(root, 'fixture workspace is open');
        const folder = vscode.Uri.joinPath(root, 'folder_project', 'slate');
        const clampUri = vscode.Uri.joinPath(folder, 'nodes', 'clamp.json');
        const normalizeUri = vscode.Uri.joinPath(folder, 'nodes', 'normalize.json');
        const clampBefore = await vscode.workspace.fs.readFile(clampUri);
        const normalizeBefore = await vscode.workspace.fs.readFile(normalizeUri);
        try {
            const clamp = await vscode.workspace.openTextDocument(clampUri);
            const editor = await vscode.window.showTextDocument(clamp);
            const intentAt = clamp.getText().indexOf('Clamp an integer');
            await editor.edit(builder => builder.replace(new vscode.Range(
                clamp.positionAt(intentAt), clamp.positionAt(intentAt + 'Clamp an integer'.length),
            ), 'Dirty intent'));
            assert.equal(clamp.isDirty, true);

            await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(folder, 'slate.json'), 'slate.editor');
            await waitForSnapshot(value => value.documents.some(document =>
                document.units[0]?.annotation?.intent === 'Dirty intent to inclusive bounds'));

            await vscode.commands.executeCommand('slate.test.revealUnit', 'normalize');
            const active = vscode.window.activeTextEditor!;
            assert.equal(active?.document.uri.toString(), normalizeUri.toString());
            assert.ok(active.document.lineAt(active.selection.active.line).text.includes('"code"'), 'reveal lands on the code');

            await vscode.commands.executeCommand('slate.test.postMessage', {
                type: 'action', action: { kind: 'setAnnotationField', target: 'normalize', field: 'intent', text: 'Undoable intent' },
            });
            assert.ok(active.document.getText().includes('Undoable intent'));
            await vscode.window.showTextDocument(active.document);
            await vscode.commands.executeCommand('undo');
            const deadline = Date.now() + 5_000;
            while (active.document.getText().includes('Undoable intent') && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            assert.ok(!active.document.getText().includes('Undoable intent'), 'native undo reverts the host edit');
        } finally {
            for (const document of vscode.workspace.textDocuments.filter(item => item.isDirty)) {
                await vscode.window.showTextDocument(document);
                await vscode.commands.executeCommand('workbench.action.files.revert');
            }
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            await vscode.workspace.fs.writeFile(clampUri, clampBefore);
            await vscode.workspace.fs.writeFile(normalizeUri, normalizeBefore);
        }
    });

    test('persists board notes in layout.json without changing node files', async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(root, 'fixture workspace is open');
        const folder = vscode.Uri.joinPath(root, 'folder_project', 'slate');
        const layoutUri = vscode.Uri.joinPath(folder, 'layout.json');
        const clampUri = vscode.Uri.joinPath(folder, 'nodes', 'clamp.json');
        const read = async (uri: vscode.Uri) => new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        const layoutBefore = await read(layoutUri);
        const clampBefore = await read(clampUri);
        const post = (message: unknown) => vscode.commands.executeCommand('slate.test.postMessage', message);

        try {
            await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(folder, 'slate.json'), 'slate.editor');
            const initial = await waitForSnapshot(snapshot => snapshot.documents.length === 2);
            await post({ type: 'noteCreate', revision: initial.revision, x: 321, y: 123, attachedTo: 'clamp' });
            const created = await waitForSnapshot(snapshot => snapshot.notes?.length === 1);
            const note = created.notes![0];
            await post({
                type: 'noteUpdate', revision: created.revision, noteId: note.id,
                title: 'Review behavior', body: 'Keep this on the board.', attachedTo: 'clamp',
            });
            const updated = await waitForSnapshot(snapshot => snapshot.notes?.[0]?.title === 'Review behavior');

            const layout = JSON.parse(await read(layoutUri));
            assert.deepEqual(layout.notes, [{ id: note.id, title: 'Review behavior', body: 'Keep this on the board.', attachedTo: 'clamp' }]);
            assert.deepEqual(layout.positions[note.id], { x: 321, y: 123 });
            assert.equal(await read(clampUri), clampBefore);

            await post({ type: 'noteDelete', revision: updated.revision, noteId: note.id });
            await waitForSnapshot(snapshot => snapshot.notes?.length === 0);
            const afterDelete = JSON.parse(await read(layoutUri));
            assert.deepEqual(afterDelete.notes, []);
            assert.equal(afterDelete.positions[note.id], undefined);
        } finally {
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            await vscode.workspace.fs.writeFile(layoutUri, new TextEncoder().encode(layoutBefore));
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
            const initial = await waitForSnapshot(snapshot => snapshot.documents.length === 2);
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

    test('ports a Python folder, describes nodes with llama.cpp, and compiles them back', async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(root, 'fixture workspace is open');
        const source = vscode.Uri.joinPath(root, 'port_source');
        const slate = vscode.Uri.joinPath(root, 'slate');
        const out = vscode.Uri.joinPath(root, 'src');
        const read = async (uri: vscode.Uri) => new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        const appBefore = await read(vscode.Uri.joinPath(source, 'app.py'));
        const replies: string[] = [];
        const server = http.createServer((request, response) => {
            let body = '';
            request.on('data', chunk => { body += chunk; });
            request.on('end', () => {
                const prompt = JSON.parse(body).messages[1].content as string;
                const name = prompt.match(/```python\ndef (\w+)/)?.[1] ?? '?';
                replies.push(name);
                response.writeHead(200, { 'content-type': 'text/event-stream' });
                response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `intent: Llama says ${name}\n` } }] })}\n\n`);
                response.end('data: [DONE]\n\n');
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const llama = vscode.workspace.getConfiguration('slate.llama');
        await llama.update('endpoint', `http://127.0.0.1:${(server.address() as { port: number }).port}`, vscode.ConfigurationTarget.Global);
        try {
            const count = await vscode.commands.executeCommand<number>('slate.portProject', source);
            assert.equal(count, 4, 'ops: prelude + add; app: run + epilogue');
            const run = JSON.parse(await read(vscode.Uri.joinPath(slate, 'nodes', 'app', 'run.json')));
            assert.deepEqual(run.uses, ['ops/_prelude', 'ops/add']);
            assert.equal(run.imports, undefined);
            assert.equal(await read(vscode.Uri.joinPath(source, 'app.py')), appBefore, 'the source project is untouched');
            assert.equal(await vscode.commands.executeCommand<number>('slate.portProject', source), 0, 'refuses a non-empty slate/nodes');

            const snapshot = await waitForSnapshot(value => value.documents.length === 4);
            assert.ok(snapshot.documents.some(document => document.path === 'slate/nodes/ops/_prelude.json' && document.diagnostics.length === 0));

            // Leaves first: add before run; module state is never described.
            await vscode.commands.executeCommand('slate.test.postMessage', { type: 'action', action: { kind: 'describeNodes' } });
            assert.deepEqual(replies, ['add', 'run']);
            const described = JSON.parse(await read(vscode.Uri.joinPath(slate, 'nodes', 'app', 'run.json')));
            assert.equal(described.intent, 'Llama says run');
            assert.equal(described.describedBy, 'llama');
            await vscode.commands.executeCommand('slate.test.postMessage', { type: 'action', action: { kind: 'describeNodes' } });
            assert.deepEqual(replies, ['add', 'run'], 'a second run skips described nodes');

            await vscode.workspace.fs.createDirectory(out);
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(out, 'stale.py'), new TextEncoder().encode('# Generated by Slate from slate/nodes/old/\n'));
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(out, 'mine.py'), new TextEncoder().encode('x = 1\n'));
            const result = await vscode.commands.executeCommand<{ files: string[] }>('slate.compile');
            assert.deepEqual(result?.files, ['app.py', 'ops.py']);
            const app = await read(vscode.Uri.joinPath(out, 'app.py'));
            assert.ok(app.includes('from ops import OPS, add\n'), app);
            assert.ok(app.includes('# slate: nodes/app/run\n# intent: Llama says run\ndef run('), app);
            await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.joinPath(out, 'stale.py'))), 'stale generated file removed');
            assert.equal(await read(vscode.Uri.joinPath(out, 'mine.py')), 'x = 1\n', 'hand-written files are kept');
        } finally {
            server.close();
            await llama.update('endpoint', undefined, vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            await vscode.workspace.fs.delete(slate, { recursive: true, useTrash: false }).then(undefined, () => undefined);
            await vscode.workspace.fs.delete(out, { recursive: true, useTrash: false }).then(undefined, () => undefined);
        }
    });
});
