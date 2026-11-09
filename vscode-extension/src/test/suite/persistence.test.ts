import * as assert from 'assert';
import * as http from 'http';
import * as vscode from 'vscode';
import type { HarnessSnapshot } from '../../harness_protocol';

const candidate = 'def normalize(score: int, maximum: int) -> int:\n    return score * 100 // maximum';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n');
const post = (message: unknown) => vscode.commands.executeCommand('slate.test.postMessage', message);
const act = (action: Record<string, unknown>) => post({ type: 'action', action });
type Message = { type: string; message?: string; ok?: boolean; proposal?: { id: string; candidate: string }; proposalId?: string; unitId?: string };
const messages = async () => await vscode.commands.executeCommand<Message[]>('slate.test.takeMessages') ?? [];

async function eventually(check: () => Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 8000;
    while (!await check()) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 30));
    }
}

suite('Slate native persistence and proposal QA', () => {
    let root: vscode.Uri;
    let server: http.Server;
    let oldEndpoint: string | undefined;
    let requests: string[];
    let restores: Array<() => void>;
    const uri = (...parts: string[]) => vscode.Uri.joinPath(root, ...parts);
    const read = async (...parts: string[]) => JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri(...parts))));
    const nodePath = (name: string) => ['slate', 'nodes', `${name}.json`];
    const snapshot = async () => (await vscode.commands.executeCommand<HarnessSnapshot>('slate.test.getSnapshot'))!;

    function replaceMethod(object: object, key: string, replacement: unknown): void {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
        Object.defineProperty(object, key, { ...descriptor, value: replacement });
        restores.push(() => Object.defineProperty(object, key, descriptor));
    }
    async function open(): Promise<void> {
        await vscode.commands.executeCommand('vscode.openWith', uri('slate', 'slate.json'), 'slate.editor');
        await eventually(async () => (await snapshot())?.projectName === root.path.split('/').pop(), 'fixture indexed');
        await act({ kind: 'refreshIndex' });
        await messages();
    }
    async function propose(): Promise<string> {
        await messages();
        await post({ type: 'generate', unitId: 'normalize' });
        const output = await messages();
        const ready = output.find(message => message.type === 'proposalReady');
        assert.ok(ready?.proposal, JSON.stringify(output));
        assert.equal(ready.proposal.candidate, candidate);
        return ready.proposal.id;
    }
    async function editBuffer(name: string, transform: (node: any) => void): Promise<vscode.TextDocument> {
        const document = await vscode.workspace.openTextDocument(uri(...nodePath(name)));
        const value = JSON.parse(document.getText());
        transform(value);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), new TextDecoder().decode(encode(value)));
        assert.ok(await vscode.workspace.applyEdit(edit));
        return document;
    }

    setup(async () => {
        restores = [];
        requests = [];
        const workspace = vscode.workspace.workspaceFolders![0].uri;
        root = vscode.Uri.joinPath(workspace, `qa-persistence-${Date.now()}`);
        await vscode.workspace.fs.createDirectory(uri('slate', 'nodes'));
        await vscode.workspace.fs.writeFile(uri('slate', 'slate.json'), encode({ slate: 3, name: root.path.split('/').pop(), language: 'python' }));
        await vscode.workspace.fs.writeFile(uri('slate', 'layout.json'), encode({ positions: {}, notes: [] }));
        for (const name of ['clamp', 'normalize']) {
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspace, 'folder_project', ...nodePath(name)));
            await vscode.workspace.fs.writeFile(uri(...nodePath(name)), bytes);
        }
        server = http.createServer((request, response) => {
            let body = '';
            request.on('data', chunk => { body += chunk; });
            request.on('end', () => {
                requests.push(JSON.parse(body).messages[1].content);
                response.writeHead(200, { 'content-type': 'text/event-stream' });
                response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: candidate } }] })}\n\n`);
                response.end('data: [DONE]\n\n');
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const config = vscode.workspace.getConfiguration('slate.llama');
        oldEndpoint = config.inspect<string>('endpoint')?.globalValue;
        await config.update('endpoint', `http://127.0.0.1:${(server.address() as { port: number }).port}`, vscode.ConfigurationTarget.Global);
        await open();
    });

    teardown(async () => {
        for (const restore of restores.reverse()) restore();
        for (const document of vscode.workspace.textDocuments.filter(item => item.isDirty && item.uri.fsPath.startsWith(root.fsPath))) {
            await vscode.window.showTextDocument(document);
            await vscode.commands.executeCommand('workbench.action.files.revert');
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.workspace.getConfiguration('slate.llama').update('endpoint', oldEndpoint, vscode.ConfigurationTarget.Global);
        await new Promise<void>(resolve => server.close(() => resolve()));
        await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false });
    });

    test('accepts the real streamed proposal, persists it, reloads it, and natively undoes then saves the original', async () => {
        const before = await read(...nodePath('normalize'));
        const dependency = await read(...nodePath('clamp'));
        const proposalId = await propose();
        assert.equal(requests.length, 1);
        assert.ok(requests[0].includes('def clamp(value: int, lower: int, upper: int) -> int:'));
        assert.deepEqual(await read(...nodePath('normalize')), before, 'generation alone cannot write');
        await post({ type: 'acceptProposal', proposalId });
        assert.ok((await messages()).some(message => message.type === 'proposalAccepted' && message.unitId === 'normalize'));
        assert.deepEqual(await read(...nodePath('normalize')), { ...before, code: candidate.split('\n') });
        assert.deepEqual(await read(...nodePath('clamp')), dependency, 'required context remains unchanged');
        await act({ kind: 'refreshIndex' });
        assert.equal((await snapshot()).documents.find(item => item.units[0]?.id === 'normalize')!.source, candidate + '\n');

        // The Slate button must invoke real VS Code Undo in the target editor.
        await post({ type: 'undoAccepted' });
        const document = await vscode.workspace.openTextDocument(uri(...nodePath('normalize')));
        await eventually(async () => JSON.parse(document.getText()).code[1] === before.code[1], 'native undo restored code');
        assert.deepEqual(JSON.parse(document.getText()), before);
        assert.ok(document.isDirty, 'native Undo restores the buffer; Save persists it');
        await act({ kind: 'saveWorkspace' });
        assert.deepEqual(await read(...nodePath('normalize')), before);
        await act({ kind: 'refreshIndex' });
        assert.equal((await snapshot()).documents.find(item => item.units[0]?.id === 'normalize')!.source, before.code.join('\n') + '\n');
        await messages();
        await post({ type: 'undoAccepted' });
        assert.ok((await messages()).some(message => message.ok === false && message.message?.includes('no accepted')));
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await open();
        assert.deepEqual(await read(...nodePath('normalize')), before, 'reopening retains the undone file');
    });

    for (const name of ['normalize', 'clamp']) for (const dirty of [false, true]) {
        test(`rejects proposal when ${name} changed in ${dirty ? 'dirty buffer' : 'saved file'}, preserving both files`, async () => {
            const proposalId = await propose();
            const changed = await editBuffer(name, node => { node.code.push('    # changed after generation'); });
            if (!dirty) assert.ok(await changed.save());
            const diskBefore = await read(...nodePath('normalize'));
            const bufferBefore = changed.getText();
            await post({ type: 'acceptProposal', proposalId });
            assert.ok((await messages()).some(message => message.type === 'proposalStale' && message.proposalId === proposalId
                && message.message?.includes('changed after generation')));
            assert.deepEqual(await read(...nodePath('normalize')), diskBefore);
            assert.equal(changed.getText(), bufferBefore);
            assert.equal(changed.isDirty, dirty);
        });
    }

    test('preserves metadata changed after generation and rejects reused or unknown proposal IDs', async () => {
        const proposalId = await propose();
        await act({ kind: 'setAnnotationField', target: 'normalize', field: 'intent', text: 'Human reviewed intent' });
        await post({ type: 'acceptProposal', proposalId: 'not-the-proposal' });
        assert.ok((await messages()).some(message => message.ok === false && message.message?.includes('no longer active')));
        await post({ type: 'acceptProposal', proposalId });
        const accepted = await read(...nodePath('normalize'));
        assert.equal(accepted.intent, 'Human reviewed intent');
        assert.equal(accepted.describedBy, 'human');
        assert.deepEqual(accepted.code, candidate.split('\n'));
        await messages();
        await post({ type: 'acceptProposal', proposalId });
        assert.ok((await messages()).some(message => message.ok === false && message.message?.includes('no longer active')));
        assert.deepEqual(await read(...nodePath('normalize')), accepted);
    });

    test('rejects a proposal after its target is deleted without recreating it', async () => {
        const proposalId = await propose();
        await vscode.workspace.fs.delete(uri(...nodePath('normalize')));
        await post({ type: 'acceptProposal', proposalId });
        assert.ok((await messages()).some(message => message.type === 'proposalStale'));
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(uri(...nodePath('normalize')))));
    });

    test('does not undo a subsequent human edit when Undo accepted edit is requested', async () => {
        await post({ type: 'acceptProposal', proposalId: await propose() });
        const document = await editBuffer('normalize', node => { node.intent = 'Keep this subsequent human edit'; });
        const text = document.getText();
        await messages();
        await post({ type: 'undoAccepted' });
        assert.equal(document.getText(), text, 'Undo accepted must not undo a different edit');
        assert.ok((await messages()).some(message => message.ok === false && message.message?.includes('changed since')));
    });

    test('does not accept a proposal after the target is locked', async () => {
        const proposalId = await propose();
        await act({ kind: 'setLock', target: 'normalize', locked: true });
        const before = await read(...nodePath('normalize'));
        await post({ type: 'acceptProposal', proposalId });
        assert.deepEqual(await read(...nodePath('normalize')), before);
        assert.ok((await messages()).some(message => message.type === 'proposalStale' && message.message?.includes('locked')));
    });

    test('adds library files through the chooser boundary and preserves them across reopen without duplicates', async () => {
        await vscode.workspace.fs.createDirectory(uri('vendor'));
        await vscode.workspace.fs.writeFile(uri('vendor', 'tools.py'), new TextEncoder().encode('def double(x: int) -> int:\n    return x * 2\n'));
        replaceMethod(vscode.window, 'showOpenDialog', async (options: vscode.OpenDialogOptions) => {
            assert.equal(options.openLabel, 'Add to library');
            assert.ok(options.canSelectFiles && options.canSelectFolders && options.canSelectMany);
            return [uri('vendor', 'tools.py')];
        });
        await act({ kind: 'addLibrary' });
        await act({ kind: 'addLibrary' });
        assert.deepEqual((await read('slate', 'slate.json')).library, ['vendor/tools.py']);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await open();
        assert.equal((await snapshot()).library?.[0].units[0].id, 'lib:vendor/tools.py:double');
        replaceMethod(vscode.window, 'showOpenDialog', async () => undefined);
        const before = await read('slate', 'slate.json');
        await act({ kind: 'addLibrary' });
        assert.deepEqual(await read('slate', 'slate.json'), before);
    });

    test('persists root and flow values and layout scopes independently across reopen', async () => {
        await act({ kind: 'createFlow', name: 'pipe', x: 10, y: 20 });
        await act({ kind: 'addInstance', value: '1', x: 30, y: 40 });
        await act({ kind: 'addInstance', flow: 'pipe', value: '2', x: 50, y: 60 });
        await act({ kind: 'setValue', id: 'value', value: '123' });
        await act({ kind: 'setValue', flow: 'pipe', id: 'value', value: '456' });
        for (const [scope, id, point] of [[undefined, 'value', { x: 1, y: 2 }], ['map', 'normalize', { x: 3, y: 4 }], ['pipe', 'value', { x: 5, y: 6 }]] as const) {
            await post({ type: 'layout', scope, positions: { [id]: point, missing: { x: 9, y: 9 } } });
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await open();
        assert.equal((await read('slate', 'flows', 'main.json')).instances[0].value, '123');
        assert.equal((await read('slate', 'flows', 'pipe.json')).instances[0].value, '456');
        const layout = await read('slate', 'layout.json');
        assert.deepEqual(layout.positions.value, { x: 1, y: 2 });
        assert.deepEqual(layout.mapPositions, { normalize: { x: 3, y: 4 } });
        assert.deepEqual(layout.flowPositions, { pipe: { value: { x: 5, y: 6 } } });
        assert.equal(layout.positions.missing, undefined);
        const current = await snapshot();
        assert.equal(current.flows?.find(item => item.id === 'pipe')?.flow?.instances[0].value, '456');
    });

    test('flow deletion respects confirmation and removes saved layout only after confirmation', async () => {
        await act({ kind: 'createFlow', name: 'pipe', x: 10, y: 20 });
        const before = await read('slate', 'layout.json');
        replaceMethod(vscode.window, 'showWarningMessage', async (message: string, options: { modal: boolean }, choice: string) => {
            assert.ok(message.includes('slate/flows/pipe.json'));
            assert.equal(options.modal, true);
            assert.equal(choice, 'Delete');
            return undefined;
        });
        await act({ kind: 'deleteFlow', id: 'pipe' });
        assert.equal((await read('slate', 'flows', 'pipe.json')).name, 'pipe');
        assert.deepEqual(await read('slate', 'layout.json'), before);
        replaceMethod(vscode.window, 'showWarningMessage', async () => 'Delete');
        await act({ kind: 'deleteFlow', id: 'pipe' });
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(uri('slate', 'flows', 'pipe.json'))));
        assert.equal((await read('slate', 'layout.json')).positions['flow:pipe'], undefined);
        assert.ok(!(await snapshot()).flows?.some(item => item.id === 'pipe'));
    });

    for (const kind of ['createNode', 'createPlaceholder', 'createFlow']) {
        test(`cancelled ${kind} validates its prompt and writes nothing`, async () => {
            const before = await read('slate', 'layout.json');
            let asked = false;
            replaceMethod(vscode.window, 'showInputBox', async (options: vscode.InputBoxOptions) => {
                asked = true;
                assert.ok(await options.validateInput?.('not valid !!'), 'invalid input rejected');
                assert.equal(await options.validateInput?.(kind === 'createNode' ? 'def sample(x: int) -> int' : 'sample'), null);
                return undefined;
            });
            await act({ kind, x: 100, y: 200 });
            assert.ok(asked);
            assert.deepEqual(await read('slate', 'layout.json'), before);
            assert.deepEqual((await vscode.workspace.fs.readDirectory(uri('slate', 'nodes'))).map(([name]) => name).sort(), ['clamp.json', 'normalize.json']);
            await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(uri('slate', 'flows', 'sample.json'))));
        });
    }

    test('cancelling the second new-node prompt does not create a node', async () => {
        let prompt = 0;
        replaceMethod(vscode.window, 'showInputBox', async () => ++prompt === 1 ? 'def sample(x: int) -> int' : undefined);
        await act({ kind: 'createNode', x: 100, y: 200 });
        assert.equal(prompt, 2);
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(uri(...nodePath('sample')))));
        assert.deepEqual((await read('slate', 'layout.json')).positions, {});
    });

    test('rejects a failed WorkspaceEdit without accepting the proposal or changing disk', async () => {
        const before = await read(...nodePath('normalize'));
        const proposalId = await propose();
        replaceMethod(vscode.workspace, 'applyEdit', async () => false);
        await post({ type: 'acceptProposal', proposalId });
        const output = await messages();
        assert.ok(output.some(message => message.type === 'proposalStale' && message.message?.includes('rejected')));
        assert.ok(!output.some(message => message.type === 'proposalAccepted'));
        assert.deepEqual(await read(...nodePath('normalize')), before);
    });

    test('does not report acceptance when VS Code cannot save the edited node', async () => {
        const before = await read(...nodePath('normalize'));
        const proposalId = await propose();
        const document = await vscode.workspace.openTextDocument(uri(...nodePath('normalize')));
        const originalOpen = vscode.workspace.openTextDocument;
        replaceMethod(vscode.workspace, 'openTextDocument', async (requested: vscode.Uri) => {
            const opened = await originalOpen(requested);
            if (opened.uri.toString() !== document.uri.toString()) return opened;
            // VS Code freezes TextDocument methods. Simulate a refused save at the
            // API boundary while all reads and WorkspaceEdits use the real document.
            return Object.create(opened, { save: { value: async () => false } });
        });
        await post({ type: 'acceptProposal', proposalId });
        const output = await messages();
        assert.ok(!output.some(message => message.type === 'proposalAccepted'));
        assert.ok(output.some(message => message.type === 'proposalStale' && message.message?.includes('save')));
        assert.deepEqual(await read(...nodePath('normalize')), before, 'failed save leaves disk untouched');
        assert.ok(document.isDirty, 'unsaved buffer remains available for recovery');
    });

    test('closing the canvas cancels queued refresh replies without rejecting pending host commands', async () => {
        const before = await read(...nodePath('normalize'));
        const original = vscode.workspace.findFiles;
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { release = resolve; });
        let intercepted = false;
        replaceMethod(vscode.workspace, 'findFiles', async (...args: Parameters<typeof original>) => {
            if (!intercepted) {
                intercepted = true;
                await waiting;
            }
            return original(...args);
        });
        const first = act({ kind: 'refreshIndex' });
        const second = act({ kind: 'refreshIndex' });
        // Attach handlers immediately so the regression cannot leak an unhandled rejection.
        const results = Promise.allSettled([first, second]);
        try {
            await eventually(async () => intercepted, 'refresh paused at filesystem boundary');
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        } finally {
            release();
        }
        const settled = await results;
        assert.deepEqual(settled.map(result => result.status), ['fulfilled', 'fulfilled'],
            settled.map(result => result.status === 'rejected' ? String(result.reason) : result.status).join('; '));
        assert.deepEqual(await read(...nodePath('normalize')), before, 'cancelled refresh cannot change node data');
        assert.equal(await vscode.commands.executeCommand('slate.test.getSnapshot'), undefined);
    });


    test('background refresh waits for an in-progress canvas edit before reloading layout', async () => {
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { release = resolve; });
        let prompted = false;
        let released = false;
        const indexedAfterRelease: boolean[] = [];
        const original = vscode.workspace.findFiles;
        replaceMethod(vscode.workspace, 'findFiles', async (...args: Parameters<typeof original>) => {
            // Ignore indexing that legitimately completed before the edit began,
            // and searches belonging to other extensions or fixture roots.
            if (prompted && typeof args[0] !== 'string' && args[0].baseUri.toString() === root.toString()) {
                indexedAfterRelease.push(released);
            }
            return original(...args);
        });
        replaceMethod(vscode.window, 'showInputBox', async () => {
            prompted = true;
            await waiting;
            return 'queued_placeholder';
        });
        const pending = act({ kind: 'createPlaceholder', x: 123, y: 456 });
        try {
            await eventually(async () => prompted, 'edit paused at native prompt');
            // A ready message schedules an immediate background refresh outside the edit queue.
            await post({ type: 'ready' });
            await new Promise(resolve => setTimeout(resolve, 100));
            assert.deepEqual((await read('slate', 'layout.json')).placeholders ?? [], []);
        } finally {
            released = true;
            release();
            await pending;
        }
        await act({ kind: 'refreshIndex' });
        assert.ok(indexedAfterRelease.length > 0, 'refreshes actually indexed the folder');
        assert.ok(indexedAfterRelease.every(Boolean), 'background indexing must not reload layout while an edit owns the queue');
        const layout = await read('slate', 'layout.json');
        assert.equal(layout.placeholders.length, 1);
        assert.equal(layout.placeholders[0].name, 'queued_placeholder');
        assert.deepEqual(layout.positions[layout.placeholders[0].id], { x: 123, y: 456 });
    });


    test('background refresh and subsequent layout edits recover after a filesystem write failure', async () => {
        const before = await read('slate', 'layout.json');
        const layout = uri('slate', 'layout.json');
        const backup = uri('slate', 'layout.backup.json');
        await vscode.workspace.fs.rename(layout, backup);
        try {
            await vscode.workspace.fs.createDirectory(layout);
            await assert.rejects(Promise.resolve(post({ type: 'layout', positions: { normalize: { x: 7, y: 8 } } })));
        } finally {
            await vscode.workspace.fs.delete(layout, { recursive: true, useTrash: false });
            await vscode.workspace.fs.rename(backup, layout);
        }
        const revision = (await snapshot()).revision;
        await post({ type: 'ready' });
        await eventually(async () => (await snapshot()).revision > revision, 'background refresh recovered after rejection');
        assert.deepEqual(await read('slate', 'layout.json'), before);
        await post({ type: 'layout', positions: { normalize: { x: 9, y: 10 } } });
        assert.deepEqual((await read('slate', 'layout.json')).positions.normalize, { x: 9, y: 10 });
    });

});
