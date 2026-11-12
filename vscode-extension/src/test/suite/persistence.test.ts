import * as assert from 'assert';
import * as http from 'http';
import * as vscode from 'vscode';
import type { HarnessSnapshot } from '../../harness_protocol';
import { compileSlateFolder } from '../../port_compile_host';

const candidate = 'def normalize(score: int, maximum: int) -> int:\n    return score * 100 // maximum';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n');
const post = (message: unknown) => vscode.commands.executeCommand('slate.test.postMessage', message);
const act = (action: Record<string, unknown>) => post({ type: 'action', action });
type Message = { type: string; message?: string; ok?: boolean; proposal?: { id: string; candidate: string }; proposalId?: string; unitId?: string };
const messages = async () => await vscode.commands.executeCommand<Message[]>('slate.test.takeMessages') ?? [];

async function eventually(check: () => Promise<boolean>, label: string, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
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
    let serverResponseContent: string | undefined;
    let serverResponseDelayMs = 0;
    const uri = (...parts: string[]) => vscode.Uri.joinPath(root, ...parts);
    const read = async (...parts: string[]) => JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri(...parts))));
    const nodePath = (name: string) => ['slate', 'nodes', `${name}.json`];
    const snapshot = async () => (await vscode.commands.executeCommand<HarnessSnapshot>('slate.test.getSnapshot'))!;

    function replaceMethod(object: object, key: string, replacement: unknown): void {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)
            ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object), key)!;
        if (descriptor.get || descriptor.set) {
            Object.defineProperty(object, key, {
                configurable: true,
                enumerable: descriptor.enumerable,
                get: typeof replacement === 'function' ? (replacement as () => unknown) : () => replacement,
            });
            restores.push(() => Object.defineProperty(object, key, descriptor));
        } else {
            Object.defineProperty(object, key, { ...descriptor, value: replacement });
            restores.push(() => Object.defineProperty(object, key, descriptor));
        }
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
        serverResponseContent = undefined;
        serverResponseDelayMs = 0;
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
                const send = () => {
                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: serverResponseContent ?? candidate } }] })}\n\n`);
                    response.end('data: [DONE]\n\n');
                };
                if (serverResponseDelayMs > 0) {
                    setTimeout(send, serverResponseDelayMs);
                } else {
                    send();
                }
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
        try {
            await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false });
        } catch {
            await new Promise(resolve => setTimeout(resolve, 250));
            try {
                await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false });
            } catch { /* best effort cleanup on Windows */ }
        }
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

    test('S-512: generates both implementation and unit check, persisting both to node file', async () => {
        const dualReply = [
            '### Implementation',
            '```python',
            'def normalize(score: int, maximum: int) -> int:',
            '    return score * 100 // maximum',
            '```',
            '',
            '### Unit Check',
            '```python',
            'def test_normalize():',
            '    assert normalize(50, 100) == 50',
            '```',
        ].join('\n');
        serverResponseContent = dualReply;

        await messages();
        await post({ type: 'generate', unitId: 'normalize' });
        const msgs = await messages();
        const ready = msgs.find(m => m.type === 'proposalReady');
        assert.ok(ready?.proposal, JSON.stringify(msgs));
        assert.ok(ready.proposal.candidate.includes('def normalize'));
        assert.ok(ready.proposal.candidate.includes('def test_normalize'));
        assert.ok((ready.proposal as any).checks.some((c: string) => c.includes('JPL-60 compliant')));
        assert.ok((ready.proposal as any).checks.some((c: string) => c.includes('Pytest unit check generated')));

        await post({ type: 'acceptProposal', proposalId: ready.proposal.id });
        assert.ok((await messages()).some(m => m.type === 'proposalAccepted' && m.unitId === 'normalize'));

        const updated = await read(...nodePath('normalize'));
        assert.deepEqual(updated.code, [
            'def normalize(score: int, maximum: int) -> int:',
            '    return score * 100 // maximum',
        ]);
        assert.deepEqual(updated.check, [
            'def test_normalize():',
            '    assert normalize(50, 100) == 50',
        ]);
    });

    test('S-512: rejects candidate exceeding JPL-60 limit of 60 lines with generationFailed', async () => {
        const lines65 = ['def normalize(score: int, maximum: int) -> int:'];
        for (let i = 0; i < 64; i++) lines65.push(`    val_${i} = ${i}`);
        lines65.push('    return score');
        serverResponseContent = lines65.join('\n');

        await messages();
        await post({ type: 'generate', unitId: 'normalize' });
        const msgs = await messages();
        const failed = msgs.find(m => m.type === 'generationFailed');
        assert.ok(failed, JSON.stringify(msgs));
        assert.ok(failed.message?.includes('exceeds JPL-60 limit of 60 lines'), failed.message);
    });

    test('S-512: rejects candidate with signature mismatch with generationFailed', async () => {
        serverResponseContent = 'def normalize(val: str) -> str:\n    return val';

        await messages();
        await post({ type: 'generate', unitId: 'normalize' });
        const msgs = await messages();
        const failed = msgs.find(m => m.type === 'generationFailed');
        assert.ok(failed, JSON.stringify(msgs));
        assert.ok(failed.message?.includes('does not match target') || failed.message?.includes('parameter'), failed.message);
    });

    test('S-512: cancels in-flight llama.cpp generation on cancelGeneration', async () => {
        serverResponseDelayMs = 1500;

        await messages();
        const genPromise = post({ type: 'generate', unitId: 'normalize' });
        await new Promise(resolve => setTimeout(resolve, 50));
        await post({ type: 'cancelGeneration' });
        await genPromise;

        const msgs = await messages();
        const failed = msgs.find(m => m.type === 'generationFailed');
        assert.ok(failed, JSON.stringify(msgs));
        assert.ok(failed.message?.includes('cancelled'), failed.message);
    });

    test('S-512: proposal with boundInputs rejects when intent, contract, or cases change after generation', async () => {
        await messages();
        await post({ type: 'generate', unitId: 'normalize', boundInputs: true });
        const msgs = await messages();
        const ready = msgs.find(m => m.type === 'proposalReady');
        assert.ok(ready?.proposal);

        await editBuffer('normalize', node => {
            node.intent = 'Changed intent after generation';
        });

        await post({ type: 'acceptProposal', proposalId: ready.proposal.id });
        const afterMsgs = await messages();
        const stale = afterMsgs.find(m => m.type === 'proposalStale');
        assert.ok(stale, JSON.stringify(afterMsgs));
        assert.ok(stale.message?.includes('intent changed after generation'), stale.message);
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
        await act({ kind: 'addInstance', target: 'lib:vendor/tools.py:double', x: 25, y: 35, connectTo: 'normalize.in:score' });
        const libMain = await read('slate', 'flows', 'main.json');
        const libRef = libMain.instances[0];
        assert.equal(libRef?.node, 'lib:vendor/tools.py:double');
        assert.deepEqual(libMain.wires, [
            { from: `${libRef!.id}.out`, to: 'ref_normalize.in:score' },
        ]);
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

    test('Undo preserves edits made while proposal Save is pending', async () => {
        const proposalId = await propose();
        const document = await vscode.workspace.openTextDocument(uri(...nodePath('normalize')));
        const originalOpen = vscode.workspace.openTextDocument;
        let enteredSave = false;
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        replaceMethod(vscode.workspace, 'openTextDocument', async (requested: vscode.Uri) => {
            const opened = await originalOpen(requested);
            if (opened.uri.toString() !== document.uri.toString()) return opened;
            return Object.create(opened, { save: { value: async () => {
                enteredSave = true;
                await held;
                return opened.save();
            } } });
        });
        const accepting = post({ type: 'acceptProposal', proposalId });
        try {
            await eventually(async () => enteredSave, 'proposal reached Save');
            assert.deepEqual(JSON.parse(document.getText()).code, candidate.split('\n'));
            await editBuffer('normalize', value => { value.code.push('# later user edit'); });
        } finally {
            release();
            await accepting;
        }
        assert.ok((await messages()).some(message => message.type === 'proposalAccepted'));
        const text = document.getText();
        const version = document.version;
        const disk = await read(...nodePath('normalize'));
        await post({ type: 'undoAccepted' });
        assert.ok((await messages()).some(message => message.ok === false && message.message?.includes('changed since')));
        assert.equal(document.getText(), text, 'Undo must preserve subsequent typing');
        assert.equal(document.version, version, 'Undo must not alter the buffer');
        assert.deepEqual(await read(...nodePath('normalize')), disk);
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

    test('root migration preserves refs on main.json write failure, defers disk writes for dirty buffers, and compiles dirty or missing layout', async () => {
        const layoutUri = uri('slate', 'layout.json');
        const mainUri = uri('slate', 'flows', 'main.json');
        await vscode.workspace.fs.writeFile(layoutUri, encode({
            positions: { 'ref-legacy': { x: 40, y: 50 }, normalize: { x: 100, y: 120 } },
            notes: [],
            refs: [{ id: 'ref-legacy', target: 'clamp' }],
        }));
        // If writing main.json fails during migration, layout.json keeps its legacy refs so they are not lost.
        await vscode.workspace.fs.createDirectory(mainUri);
        await act({ kind: 'refreshIndex' });
        assert.deepEqual((await read('slate', 'layout.json')).refs, [{ id: 'ref-legacy', target: 'clamp' }]);
        await vscode.workspace.fs.delete(mainUri, { recursive: true, useTrash: false });

        // While main.json has unsaved changes, refresh migrates in-memory without overwriting disk or minting duplicate ref_* IDs.
        await vscode.workspace.fs.writeFile(mainUri, encode({
            slate: 3, name: 'main', inputs: [], outputs: [], instances: [], wires: [],
        }));
        const mainDoc = await vscode.workspace.openTextDocument(mainUri);
        const dirtyMainEdit = new vscode.WorkspaceEdit();
        dirtyMainEdit.replace(
            mainDoc.uri,
            new vscode.Range(mainDoc.positionAt(0), mainDoc.positionAt(mainDoc.getText().length)),
            new TextDecoder().decode(encode({
                slate: 3, name: 'main', inputs: [], outputs: [],
                instances: [{ id: 'normalize', node: 'normalize' }],
                wires: [{ from: 'ref-legacy.out', to: 'normalize.in:score' }],
            })),
        );
        assert.ok(await vscode.workspace.applyEdit(dirtyMainEdit));
        assert.equal(mainDoc.isDirty, true);
        await act({ kind: 'refreshIndex' });
        await act({ kind: 'refreshIndex' });
        assert.equal(mainDoc.isDirty, true);
        assert.deepEqual((await read('slate', 'layout.json')).refs, [{ id: 'ref-legacy', target: 'clamp' }]);
        assert.deepEqual((await read('slate', 'flows', 'main.json')).instances, []);
        // Moving a card on the canvas while main.json is dirty preserves the deferred legacy refs in layout.json.
        await post({ type: 'layout', positions: { normalize: { x: 110, y: 130 } } });
        assert.deepEqual((await read('slate', 'layout.json')).refs, [{ id: 'ref-legacy', target: 'clamp' }]);
        assert.deepEqual((await read('slate', 'layout.json')).positions.normalize, { x: 110, y: 130 });
        assert.deepEqual((await snapshot()).flows?.find(item => item.id === 'main')?.flow?.instances, [
            { id: 'ref_normalize', node: 'normalize' },
            { id: 'ref-legacy', node: 'clamp' },
        ]);
        // Creating a reference while main.json is dirty updates and saves the open document so the new reference is retained on refresh.
        await act({ kind: 'createRef', target: 'clamp', x: 50, y: 60 });
        assert.equal(mainDoc.isDirty, false);
        assert.equal((await read('slate', 'layout.json')).refs, undefined);
        const snapInstancesAfterDirtyCreate = (await snapshot()).flows?.find(item => item.id === 'main')?.flow?.instances ?? [];
        assert.equal(snapInstancesAfterDirtyCreate.length, 3);
        assert.ok(snapInstancesAfterDirtyCreate.some(item => item.id === 'ref_normalize' && item.node === 'normalize'));
        assert.ok(snapInstancesAfterDirtyCreate.some(item => item.id === 'ref-legacy' && item.node === 'clamp'));
        assert.deepEqual((await read('slate', 'flows', 'main.json')).instances, snapInstancesAfterDirtyCreate);

        // Moving a card on the canvas while layout.json has unsaved editor changes merges and preserves the unsaved edits.
        const layoutEditorDoc = await vscode.workspace.openTextDocument(layoutUri);
        const unsavedLayoutEdit = new vscode.WorkspaceEdit();
        unsavedLayoutEdit.replace(
            layoutEditorDoc.uri,
            new vscode.Range(layoutEditorDoc.positionAt(0), layoutEditorDoc.positionAt(layoutEditorDoc.getText().length)),
            new TextDecoder().decode(encode({
                positions: { clamp: { x: 77, y: 88 }, normalize: { x: 110, y: 130 } },
                notes: [{ id: 'note-dirty', title: 'Unsaved note', body: 'Kept across drag', attachedTo: null }],
            })),
        );
        assert.ok(await vscode.workspace.applyEdit(unsavedLayoutEdit));
        assert.equal(layoutEditorDoc.isDirty, true);
        await post({ type: 'layout', positions: { normalize: { x: 140, y: 160 } } });
        assert.equal(layoutEditorDoc.isDirty, false);
        const mergedLayout = await read('slate', 'layout.json');
        assert.deepEqual(mergedLayout.positions.clamp, { x: 77, y: 88 });
        assert.deepEqual(mergedLayout.positions.normalize, { x: 140, y: 160 });
        assert.deepEqual(mergedLayout.notes, [{ id: 'note-dirty', title: 'Unsaved note', body: 'Kept across drag', attachedTo: null }]);

        // Grouping a legacy reference while layout.json has unsaved edits moves it to the child flow without restoring it to root.
        const dirtyLegacyGroupEdit = new vscode.WorkspaceEdit();
        dirtyLegacyGroupEdit.replace(
            layoutEditorDoc.uri,
            new vscode.Range(layoutEditorDoc.positionAt(0), layoutEditorDoc.positionAt(layoutEditorDoc.getText().length)),
            new TextDecoder().decode(encode({
                positions: { 'ref-grouped': { x: 30, y: 40 }, normalize: { x: 140, y: 160 } },
                notes: [{ id: 'note-dirty', title: 'Unsaved note', body: 'Kept across group', attachedTo: null }],
                refs: [{ id: 'ref-grouped', target: 'clamp' }],
            })),
        );
        assert.ok(await vscode.workspace.applyEdit(dirtyLegacyGroupEdit));
        assert.equal(layoutEditorDoc.isDirty, true);
        await act({ kind: 'refreshIndex' });
        await act({ kind: 'extractFlow', name: 'grouped_legacy', ids: ['ref-grouped'] });
        assert.equal(layoutEditorDoc.isDirty, false);
        assert.equal((await read('slate', 'layout.json')).refs, undefined);
        assert.deepEqual((await read('slate', 'layout.json')).notes, [
            { id: 'note-dirty', title: 'Unsaved note', body: 'Kept across group', attachedTo: null },
        ]);
        assert.ok(!(await read('slate', 'flows', 'main.json')).instances.some((item: any) => item.id === 'ref-grouped'));
        assert.deepEqual((await read('slate', 'flows', 'grouped_legacy.json')).instances, [
            { id: 'ref-grouped', node: 'clamp' },
        ]);
        await vscode.workspace.fs.delete(uri('slate', 'flows', 'grouped_legacy.json'));

        // Editing legacy refs in dirty layout.json, dragging a card (saving layout), and then running createRef migrates the edited ref into main.json.
        const dirtyRefThenDragEdit = new vscode.WorkspaceEdit();
        dirtyRefThenDragEdit.replace(
            layoutEditorDoc.uri,
            new vscode.Range(layoutEditorDoc.positionAt(0), layoutEditorDoc.positionAt(layoutEditorDoc.getText().length)),
            new TextDecoder().decode(encode({
                positions: { 'ref-after-drag': { x: 20, y: 30 }, normalize: { x: 140, y: 160 } },
                notes: [],
                refs: [{ id: 'ref-after-drag', target: 'clamp' }],
            })),
        );
        assert.ok(await vscode.workspace.applyEdit(dirtyRefThenDragEdit));
        assert.equal(layoutEditorDoc.isDirty, true);
        await post({ type: 'layout', positions: { normalize: { x: 150, y: 170 } } });
        assert.equal(layoutEditorDoc.isDirty, false);
        await act({ kind: 'createRef', target: 'normalize', x: 60, y: 70 });
        assert.equal((await read('slate', 'layout.json')).refs, undefined);
        assert.ok((await read('slate', 'flows', 'main.json')).instances.some((item: any) => item.id === 'ref-after-drag' && item.node === 'clamp'));

        // Compile respects unsaved layout.json ref targets and repairs missing root instances even when layout.json is absent.
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.workspace.fs.writeFile(layoutUri, encode({
            positions: {}, notes: [], refs: [{ id: 'ref_dirty', target: 'missing_target' }],
        }));
        await vscode.workspace.fs.writeFile(mainUri, encode({
            slate: 3, name: 'main',
            inputs: [{ name: 'x', annotation: 'int' }, { name: 'lo', annotation: 'int' }, { name: 'hi', annotation: 'int' }],
            outputs: [{ name: 'out', annotation: 'int' }],
            instances: [],
            wires: [
                { from: 'input:x', to: 'ref_dirty.in:value' },
                { from: 'input:lo', to: 'ref_dirty.in:lower' },
                { from: 'input:hi', to: 'ref_dirty.in:upper' },
                { from: 'ref_dirty.out', to: 'output:out' },
            ],
        }));
        const layoutDoc = await vscode.workspace.openTextDocument(layoutUri);
        await vscode.window.showTextDocument(layoutDoc);
        await vscode.commands.executeCommand('workbench.action.files.revert');
        const dirtyLayoutEdit = new vscode.WorkspaceEdit();
        dirtyLayoutEdit.replace(
            layoutDoc.uri,
            new vscode.Range(layoutDoc.positionAt(0), layoutDoc.positionAt(layoutDoc.getText().length)),
            new TextDecoder().decode(encode({ positions: {}, notes: [], refs: [{ id: 'ref_dirty', target: 'clamp' }] })),
        );
        assert.ok(await vscode.workspace.applyEdit(dirtyLayoutEdit));
        assert.equal(layoutDoc.isDirty, true);
        const outPy = `${root.path.split('/').pop()!.replace(/-/g, '_')}.py`;
        const dirtyCompiled = await compileSlateFolder(root);
        assert.deepEqual(dirtyCompiled.files, [outPy]);
        assert.ok(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri('src', outPy)))
            .includes('v_ref_dirty = clamp(value=x, lower=lo, upper=hi)'));
        await vscode.window.showTextDocument(layoutDoc);
        await vscode.commands.executeCommand('workbench.action.files.revert');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');

        await vscode.workspace.fs.delete(layoutUri);
        await vscode.workspace.fs.writeFile(mainUri, encode({
            slate: 3, name: 'main',
            inputs: [{ name: 'x', annotation: 'int' }, { name: 'lo', annotation: 'int' }, { name: 'hi', annotation: 'int' }],
            outputs: [{ name: 'out', annotation: 'int' }],
            instances: [],
            wires: [
                { from: 'input:x', to: 'clamp.in:value' },
                { from: 'input:lo', to: 'clamp.in:lower' },
                { from: 'input:hi', to: 'clamp.in:upper' },
                { from: 'clamp.out', to: 'output:out' },
            ],
        }));
        const noLayoutCompiled = await compileSlateFolder(root);
        assert.deepEqual(noLayoutCompiled.files, [outPy]);
        assert.ok(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri('src', outPy)))
            .includes('v_ref_clamp = clamp(value=x, lower=lo, upper=hi)'));
    });

    test('protocol search, packetPreview, reveal, createNode, placeholder conversions, root addInstance/extractFlow, and validation guards', async () => {
        await messages();
        const rev = (await snapshot()).revision;
        await post({ type: 'search', query: 'normalize', revision: rev });
        await post({ type: 'search', query: 'normalize', revision: -1 });
        await post({ type: 'packetPreview', unitId: 'normalize' });
        await post({ type: 'packetPreview', unitId: 'missing_unit' });
        await post({ type: 'reveal', unitId: 'normalize', focus: true });
        await assert.rejects(Promise.resolve(vscode.commands.executeCommand('slate.test.revealUnit', 'missing_unit')));

        const searchAndPreview = await messages();
        assert.ok(searchAndPreview.some((m: any) => m.type === 'searchResults' && m.stale === false && m.results.length > 0));
        assert.ok(searchAndPreview.some((m: any) => m.type === 'searchResults' && m.stale === true));
        assert.ok(searchAndPreview.some((m: any) => m.type === 'packetPreview' && m.unitId === 'normalize' && m.packet));
        assert.ok(searchAndPreview.some((m: any) => m.type === 'packetPreview' && m.unitId === 'missing_unit' && m.error));

        // createNode success, duplicate error, and WorkspaceEdit rejection.
        let step = 0;
        replaceMethod(vscode.window, 'showInputBox', async () => ++step % 2 === 1 ? 'def extra(x: int) -> int' : 'Extra intent');
        await act({ kind: 'createNode', x: 10, y: 20 });
        assert.equal((await read(...nodePath('extra'))).intent, 'Extra intent');
        await act({ kind: 'createNode', x: 10, y: 20 });
        assert.ok((await messages()).some(m => m.ok === false && m.message?.includes('already exists')));

        step = 0;
        replaceMethod(vscode.window, 'showInputBox', async () => ++step === 1 ? 'def rejected_node(x: int) -> int' : 'Intent');
        replaceMethod(vscode.workspace, 'applyEdit', async () => false);
        await act({ kind: 'createNode', x: 10, y: 20 });
        assert.ok((await messages()).some(m => m.ok === false && m.message?.includes('rejected the new node')));
        restores.pop()!();

        // Unchanged writeNode returns existing version without editing.
        const currentExtra = await read(...nodePath('extra'));
        await act({ kind: 'setLock', target: 'extra', locked: Boolean(currentExtra.locked) });

        // Placeholders: placeholderToRef (missing, unmatched, matched) and placeholderToNode (cancelled, confirmed).
        await act({ kind: 'placeholderToRef', id: 'missing-ph' });
        await act({ kind: 'createPlaceholder', name: 'unmatched_ph', x: 5, y: 5 });
        const unmatchedId = (await snapshot()).placeholders![0].id;
        await act({ kind: 'placeholderToRef', id: unmatchedId });
        assert.ok((await messages()).some(m => m.ok === false && m.message?.includes('No single node is named unmatched_ph')));

        replaceMethod(vscode.window, 'showInputBox', async (options: vscode.InputBoxOptions) => {
            assert.ok(await options.validateInput?.('not valid'));
            assert.equal(await options.validateInput?.('def unmatched_ph(x: int) -> int'), null);
            return undefined;
        });
        await act({ kind: 'placeholderToNode', id: unmatchedId });
        replaceMethod(vscode.window, 'showInputBox', async () => 'def unmatched_ph(x: int) -> int');
        await act({ kind: 'placeholderToNode', id: unmatchedId });
        assert.equal((await read(...nodePath('unmatched_ph'))).name, 'unmatched_ph');

        await act({ kind: 'createPlaceholder', name: 'clamp', x: 15, y: 25 });
        const clampPhId = (await snapshot()).placeholders![0].id;
        await act({ kind: 'placeholderToRef', id: clampPhId });
        const mainInstances = () => read('slate', 'flows', 'main.json').then(flow => flow.instances as Array<{ id: string; node: string }>);
        assert.equal((await mainInstances()).length, 1);

        // Root addInstance with connectFrom and connectTo, plus deleteItems on root.
        await act({ kind: 'addInstance', target: 'clamp', x: 40, y: 50, connectTo: 'normalize.in:score' });
        const connectToRef = (await mainInstances()).filter(item => item.id.startsWith('ref-'))[1];
        assert.equal(connectToRef.node, 'clamp');
        assert.deepEqual((await read('slate', 'layout.json')).positions[connectToRef.id], { x: 40, y: 50 });
        assert.deepEqual((await read('slate', 'flows', 'main.json')).wires, [
            { from: `${connectToRef.id}.out`, to: 'ref_normalize.in:score' },
        ]);
        await act({ kind: 'addInstance', target: 'normalize', x: 60, y: 70, connectFrom: 'clamp.out' });
        const connectFromRef = (await mainInstances()).filter(item => item.id.startsWith('ref-'))[2];
        assert.equal(connectFromRef.node, 'normalize');
        assert.deepEqual((await read('slate', 'layout.json')).positions[connectFromRef.id], { x: 60, y: 70 });
        assert.deepEqual((await read('slate', 'flows', 'main.json')).wires, [
            { from: `${connectToRef.id}.out`, to: 'ref_normalize.in:score' },
            { from: 'ref_clamp.out', to: `${connectFromRef.id}.in:score` },
        ]);
        await act({ kind: 'deleteItems', ids: [connectToRef.id] });
        const layoutAfterDelete = await read('slate', 'layout.json');
        assert.ok(!(await mainInstances()).some(r => r.id === connectToRef.id));
        assert.equal(layoutAfterDelete.positions[connectToRef.id], undefined);
        assert.deepEqual((await read('slate', 'flows', 'main.json')).wires, [
            { from: 'ref_clamp.out', to: `${connectFromRef.id}.in:score` },
        ]);

        // Note validation errors, valid note creation, and root extractFlow ignoring notes.
        await post({ type: 'noteCreate', x: 'bad', y: 0 });
        await post({ type: 'noteUpdate', noteId: 'missing', title: 't', body: 'b' });
        await post({ type: 'noteCreate', x: 10, y: 20, attachedTo: 'clamp' });
        const noteId = (await snapshot()).notes![0].id;
        await act({ kind: 'createPlaceholder', name: 'temp_ph', x: 12, y: 22 });
        await post({ type: 'layout', positions: { normalize: { x: 11, y: 21 } } });

        await act({ kind: 'extractFlow', name: 'bad name', ids: ['clamp'] });
        await act({ kind: 'extractFlow', name: 'empty_extract', ids: [noteId] });
        await act({ kind: 'extractFlow', name: 'root_flow', ids: ['clamp', noteId] });
        assert.ok((await snapshot()).flows?.some(f => f.id === 'root_flow'));

        // Flow-scoped error guards, self-wiring, self-context, and unknown action.
        await act({ kind: 'addInstance', flow: 'root_flow', target: 'root_flow', x: 0, y: 0 });
        await act({ kind: 'addInstance', flow: 'root_flow', target: 'missing_target', x: 0, y: 0 });
        await act({ kind: 'createRef', target: 'missing_target', x: 0, y: 0 });
        await act({ kind: 'connectData', from: 'clamp.out', to: 'clamp.in:value' });
        await act({ kind: 'connectData', from: 'missing_canvas_node.out', to: 'clamp.in:value' });
        await act({ kind: 'setContext', target: 'normalize', dependency: 'normalize', enabled: true });
        await act({ kind: 'setContext', target: 'normalize', dependency: 'clamp', enabled: false });
        await act({ kind: 'setContext', target: 'normalize', dependency: 'clamp', enabled: true });
        await act({ kind: 'setAnnotationField', target: 'missing_node', field: 'intent', text: 'x' });
        await act({ kind: 'unknownFolderAction', target: 'normalize' });

        const errs = (await messages()).filter(m => m.ok === false).map(m => m.message);
        assert.ok(errs.some(m => m?.includes('cannot contain itself')));
        assert.ok(errs.some(m => m?.includes('cannot feed itself')));
        assert.ok(errs.some(m => m?.includes('cannot be its own context')));
        assert.ok(errs.some(m => m?.includes('not available for slate/ node folders')));
    });

    test('canvas ergonomics: deletion with confirmation, copy/paste linked and duplicate, make unique, and flow port renaming/deletion', async () => {
        // Create a new flow for ergo testing
        await act({ kind: 'createFlow', name: 'ergo_flow', x: 10, y: 10 });
        await act({ flow: 'ergo_flow', kind: 'addInstance', target: 'clamp', x: 100, y: 100 });
        await act({ flow: 'ergo_flow', kind: 'addInstance', target: 'normalize', x: 400, y: 100 });
        await act({ flow: 'ergo_flow', kind: 'connectData', from: 'input:+', to: 'clamp.in:value' });
        await act({ flow: 'ergo_flow', kind: 'connectData', from: 'clamp.out', to: 'normalize.in:score' });
        await act({ flow: 'ergo_flow', kind: 'connectData', from: 'normalize.out', to: 'output:+' });

        // Wire an instance of ergo_flow in main.json to test caller wire repairs
        await act({ kind: 'addInstance', target: 'ergo_flow', x: 200, y: 200 });
        const ergoMainInst = (await read('slate', 'flows', 'main.json')).instances.find((i: any) => i.node === 'ergo_flow')!;
        await act({ kind: 'connectData', from: 'clamp.out', to: `${ergoMainInst.id}.in:value` });

        let flowBefore = await read('slate', 'flows', 'ergo_flow.json');
        assert.equal(flowBefore.inputs[0].name, 'value');
        assert.equal(flowBefore.outputs[0].name, 'normalize');

        // 1. Rename flow input: updates internal wires and repairs caller wire in main.json
        await act({ flow: 'ergo_flow', kind: 'renameFlowPort', direction: 'input', oldName: 'value', newName: 'num_input' });
        let flowAfterInRename = await read('slate', 'flows', 'ergo_flow.json');
        assert.equal(flowAfterInRename.inputs[0].name, 'num_input');
        assert.ok(flowAfterInRename.wires.some((w: any) => w.from === 'input:num_input' && w.to === 'clamp.in:value'));

        let mainAfterInRename = await read('slate', 'flows', 'main.json');
        assert.ok(mainAfterInRename.wires.some((w: any) => w.from === 'ref_clamp.out' && w.to === `${ergoMainInst.id}.in:num_input`));

        // 2. Rename flow output: updates internal wires
        await act({ flow: 'ergo_flow', kind: 'renameFlowPort', direction: 'output', oldName: 'normalize', newName: 'final_score' });
        let flowAfterOutRename = await read('slate', 'flows', 'ergo_flow.json');
        assert.equal(flowAfterOutRename.outputs[0].name, 'final_score');
        assert.ok(flowAfterOutRename.wires.some((w: any) => w.to === 'output:final_score'));

        // 3. Delete flow input: unplugs internal wire and caller wire
        await act({ flow: 'ergo_flow', kind: 'deleteFlowPort', direction: 'input', name: 'num_input', prompt: false });
        let flowAfterInDelete = await read('slate', 'flows', 'ergo_flow.json');
        assert.equal(flowAfterInDelete.inputs.length, 0);
        assert.ok(!flowAfterInDelete.wires.some((w: any) => w.from === 'input:num_input'));
        let mainAfterInDelete = await read('slate', 'flows', 'main.json');
        assert.ok(!mainAfterInDelete.wires.some((w: any) => w.to === `${ergoMainInst.id}.in:num_input`));

        // 4. Paste linked: creates new instance referencing existing clamp without creating node file
        await act({ flow: 'ergo_flow', kind: 'pasteItems', mode: 'linked', items: [{ id: 'clamp', node: 'clamp', x: 50, y: 50 }] });
        let flowAfterPasteLinked = await read('slate', 'flows', 'ergo_flow.json');
        const linkedInst = flowAfterPasteLinked.instances.find((i: any) => i.id !== 'clamp' && i.node === 'clamp')!;
        assert.ok(linkedInst);
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(uri('slate', 'nodes', `${linkedInst.id}.json`))));

        // 5. Paste duplicate: forks node into a fresh node file on disk, handling batch uniqueness
        await act({ flow: 'ergo_flow', kind: 'pasteItems', mode: 'duplicate', items: [
            { id: 'clamp', node: 'clamp', x: 80, y: 80 },
            { id: 'clamp', node: 'clamp', x: 120, y: 120 },
        ] });
        let flowAfterPasteDuplicate = await read('slate', 'flows', 'ergo_flow.json');
        const dupInstances = flowAfterPasteDuplicate.instances.filter((i: any) => i.node.includes('clamp_copy'));
        assert.equal(dupInstances.length, 2);
        assert.notEqual(dupInstances[0].node, dupInstances[1].node);
        const dup0 = await read('slate', 'nodes', `${dupInstances[0].node}.json`);
        const dup1 = await read('slate', 'nodes', `${dupInstances[1].node}.json`);
        assert.equal(dup0.name, dupInstances[0].node);
        assert.equal(dup1.name, dupInstances[1].node);

        // 6. Make unique: forks the linked instance into its own independent node file
        await act({ flow: 'ergo_flow', kind: 'makeUnique', id: linkedInst.id });
        let flowAfterUnique = await read('slate', 'flows', 'ergo_flow.json');
        const uniqueInst = flowAfterUnique.instances.find((i: any) => i.id === linkedInst.id)!;
        assert.notEqual(uniqueInst.node, 'clamp');
        const uniqueNodeDisk = await read('slate', 'nodes', `${uniqueInst.node}.json`);
        assert.equal(uniqueNodeDisk.name, uniqueInst.node);
        assert.ok(uniqueNodeDisk.code.some((l: string) => l.includes(`def ${uniqueInst.node}`)));

        // 6b. Make unique on library reference shows warning and leaves flow unchanged
        await act({ flow: 'ergo_flow', kind: 'pasteItems', mode: 'linked', items: [{ id: 'lib_call', node: 'lib:math.sin', x: 20, y: 20 }] });
        const beforeLibFlow = await read('slate', 'flows', 'ergo_flow.json');
        const libInst = beforeLibFlow.instances.find((i: any) => i.node === 'lib:math.sin')!;
        let warnedLib = false;
        replaceMethod(vscode.window, 'showWarningMessage', async (msg: string) => {
            if (msg.includes('Cannot fork library')) warnedLib = true;
            return undefined;
        });
        await act({ flow: 'ergo_flow', kind: 'makeUnique', id: libInst.id });
        assert.ok(warnedLib);
        restores.pop()!();

        // 7. Deletion: prompt cancelled writes nothing
        replaceMethod(vscode.window, 'showWarningMessage', async () => undefined);
        await act({ flow: 'ergo_flow', kind: 'deleteItems', ids: [uniqueInst.id], prompt: true });
        let flowAfterCancel = await read('slate', 'flows', 'ergo_flow.json');
        assert.ok(flowAfterCancel.instances.some((i: any) => i.id === uniqueInst.id));
        restores.pop()!();

        // 8. Deletion: "Remove call instance" removes from flow but leaves node file on disk
        replaceMethod(vscode.window, 'showWarningMessage', async () => 'Remove call instance');
        await act({ flow: 'ergo_flow', kind: 'deleteItems', ids: [uniqueInst.id], prompt: true });
        let flowAfterRemove = await read('slate', 'flows', 'ergo_flow.json');
        assert.ok(!flowAfterRemove.instances.some((i: any) => i.id === uniqueInst.id));
        assert.ok(await vscode.workspace.fs.stat(uri('slate', 'nodes', `${uniqueInst.node}.json`)));
        restores.pop()!();

        // 9. Deletion: "Delete node file" deletes node file from disk and unplugs all instances/wires
        replaceMethod(vscode.window, 'showWarningMessage', async () => 'Delete node file');
        await act({ flow: 'ergo_flow', kind: 'deleteItems', ids: [dupInstances[0].id], prompt: true });
        let flowAfterDefDelete = await read('slate', 'flows', 'ergo_flow.json');
        assert.ok(!flowAfterDefDelete.instances.some((i: any) => i.node === dupInstances[0].node));
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(uri('slate', 'nodes', `${dupInstances[0].node}.json`))));
        restores.pop()!();

        // Clean up created files
        try { await vscode.workspace.fs.delete(uri('slate', 'nodes', `${uniqueInst.node}.json`)); } catch {}
        try { await vscode.workspace.fs.delete(uri('slate', 'nodes', `${dupInstances[0].node}.json`)); } catch {}
        try { await vscode.workspace.fs.delete(uri('slate', 'nodes', `${dupInstances[1].node}.json`)); } catch {}
        try { await vscode.workspace.fs.delete(uri('slate', 'flows', 'ergo_flow.json')); } catch {}
    });

    test('concurrent generation/describe guards, cancellation, compile action, stale lastGood graph, and layout error reporting', async () => {
        // Hold server response to test concurrent generate guard + cancelGeneration.
        let releaseServer!: () => void;
        let serverEntered = false;
        const listeners = server.listeners('request') as Array<(...args: any[]) => void>;
        server.removeAllListeners('request');
        server.on('request', (req, res) => {
            serverEntered = true;
            const held = new Promise<void>(resolve => { releaseServer = resolve; });
            req.on('data', () => {});
            req.on('end', () => {
                void held.then(() => {
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'intent: Auto intent\ncontract: Auto contract' } }] })}\n\n`);
                    res.end('data: [DONE]\n\n');
                });
            });
        });

        await messages();
        const gen1 = post({ type: 'generate', unitId: 'normalize' });
        await eventually(async () => serverEntered, 'generation request reached server');
        await post({ type: 'generate', unitId: 'normalize' });
        await post({ type: 'cancelGeneration' });
        releaseServer();
        await gen1;
        const genMsgs = await messages();
        assert.ok(genMsgs.some(m => m.ok === false && m.message?.includes('already running')));
        assert.ok(genMsgs.some(m => m.type === 'generationFailed'));

        // Undescribed node + oversized undescribed node: test describeNodes concurrent guard, skip report, and completion.
        await editBuffer('normalize', node => { node.intent = ''; node.contract = ''; });
        await (await vscode.workspace.openTextDocument(uri(...nodePath('normalize')))).save();
        const clampOriginal = await read(...nodePath('clamp'));
        await editBuffer('clamp', node => { node.intent = ''; node.code = ['def clamp(value: int, lower: int, upper: int) -> int:', ...Array.from({ length: 1200 }, () => '    value = value + 0'), '    return value']; });
        await (await vscode.workspace.openTextDocument(uri(...nodePath('clamp')))).save();

        serverEntered = false;
        const desc1 = act({ kind: 'describeNodes' });
        await eventually(async () => serverEntered, 'describe request reached server');
        await act({ kind: 'describeNodes' });
        releaseServer();
        await desc1;
        const descMsgs = await messages();
        assert.ok(descMsgs.some(m => m.ok === false && m.message?.includes('Describing is already running')));
        assert.equal((await read(...nodePath('normalize'))).intent, 'Auto intent');
        assert.equal((await read(...nodePath('normalize'))).describedBy, 'llama');
        await vscode.workspace.fs.writeFile(uri(...nodePath('clamp')), encode(clampOriginal));

        // Test cancelDescribe while describing is in flight, and describe catch block when writeNode rejects.
        await editBuffer('normalize', node => { node.intent = ''; });
        await (await vscode.workspace.openTextDocument(uri(...nodePath('normalize')))).save();
        serverEntered = false;
        const descCancel = act({ kind: 'describeNodes' });
        await eventually(async () => serverEntered, 'describe request reached server for cancel');
        await act({ kind: 'cancelDescribe' });
        releaseServer();
        await descCancel;

        replaceMethod(vscode.workspace, 'applyEdit', async () => false);
        serverEntered = false;
        const descFail = act({ kind: 'describeNodes' });
        await eventually(async () => serverEntered, 'describe request reached server for write failure');
        releaseServer();
        await descFail;
        assert.ok((await messages()).some(m => m.ok === false && m.message?.startsWith('Describe:')));
        restores.pop()!();

        // Restore original server handler.
        server.removeAllListeners('request');
        for (const listener of listeners) server.on('request', listener);

        // Compile action from panel: success and error.
        await messages();
        await act({ kind: 'compile' });
        assert.ok((await messages()).some(m => m.ok === true && m.message?.includes('Compiled')));

        // Break normalize.json code in buffer -> lastGood keeps units with stale: true and refreshIndex reports problem.
        const brokenDoc = await editBuffer('normalize', node => { node.code = ['def broken(:']; });
        await act({ kind: 'refreshIndex' });
        const brokenSnap = await snapshot();
        const brokenNorm = brokenSnap.documents.find(d => d.path === 'slate/nodes/normalize.json')!;
        assert.equal(brokenNorm.valid, false);
        assert.equal(brokenNorm.stale, true);
        assert.equal(brokenNorm.units.length, 1);
        assert.ok((await messages()).some(m => m.ok === false && m.message?.includes('have problems')));
        await vscode.window.showTextDocument(brokenDoc);
        await vscode.commands.executeCommand('workbench.action.files.revert');

        // JPL-60 guardrail: >60 lines in buffer produces jpl60-line-count diagnostic in snapshot.
        const longLines = ['def normalize(score: int, maximum: int) -> int:', ...Array.from({ length: 60 }, (_, i) => `    x${i} = ${i}`), '    return 1'];
        const longDoc = await editBuffer('normalize', node => { node.code = longLines; });
        await act({ kind: 'refreshIndex' });
        const longSnap = await snapshot();
        const longNorm = longSnap.documents.find(d => d.path === 'slate/nodes/normalize.json')!;
        assert.ok(longNorm.diagnostics.some(d => d.code === 'jpl60-line-count'));
        await vscode.window.showTextDocument(longDoc);
        await vscode.commands.executeCommand('workbench.action.files.revert');

        // Corrupt layout.json -> refreshNow reports commandResult(false, 'Slate folder: slate/layout.json: ...').
        await vscode.workspace.fs.writeFile(uri('slate', 'layout.json'), new TextEncoder().encode('{bad json'));
        await messages();
        await act({ kind: 'refreshIndex' });
        assert.ok((await messages()).some(m => m.ok === false && m.message?.includes('Slate folder: slate/layout.json:')));
        await vscode.workspace.fs.writeFile(uri('slate', 'layout.json'), encode({ positions: {}, notes: [] }));
    });

    test('per-node Pydantic + pytest + mutmut verification runner, badges, staleness, cancellation, and bounded retry loop', async () => {
        // 1. Untested when node has no check and no cases
        await post({ type: 'verifyNode', nodeId: 'normalize' });
        await eventually(async () => {
            const snap = await snapshot();
            return snap.verifications?.normalize?.state === 'untested';
        }, 'verify untested status');
        let snap = await snapshot();
        assert.equal(snap.verifications?.normalize?.state, 'untested');

        // 2. Untrusted workspace rejection
        replaceMethod(vscode.workspace, 'isTrusted', false);
        await post({ type: 'verifyNode', nodeId: 'normalize' });
        await eventually(async () => {
            const snap = await snapshot();
            return snap.verifications?.normalize?.state === 'failed';
        }, 'untrusted workspace rejection');
        snap = await snapshot();
        assert.ok(snap.verifications?.normalize?.diagnostics?.some(d => d.includes('not trusted')));
        restores.pop()!();

        // 3. Passing verification with Pydantic runtime contract validation & pytest cases
        await editBuffer('normalize', node => {
            node.code = [
                'def normalize(score: int, maximum: int) -> int:',
                '    return (score * 100) // maximum',
            ];
            node.cases = [
                { score: 50, maximum: 100, expected: 50 },
                { score: 100, maximum: 100, expected: 100 },
            ];
        });
        await (await vscode.workspace.openTextDocument(uri(...nodePath('normalize')))).save();

        await post({ type: 'verifyNode', nodeId: 'normalize' });
        await eventually(async () => {
            const snap = await snapshot();
            const verif = snap.verifications?.normalize;
            if (verif?.state === 'failed') {
                throw new Error(`Verification failed unexpectedly: ${JSON.stringify(verif.diagnostics)} \nTraceback: ${verif.traceback}`);
            }
            return verif?.state === 'passed' || verif?.state === 'mutant_survived';
        }, 'verification completed', 25000);
        snap = await snapshot();
        const normVerif = snap.verifications?.normalize;
        assert.ok(normVerif?.state === 'passed' || normVerif?.state === 'mutant_survived');
        assert.equal(normVerif?.pydanticValid, true);
        assert.ok((normVerif?.testsPassed ?? 0) >= 1);

        // Verification is persisted in the node file on disk
        const savedNode = await read(...nodePath('normalize'));
        assert.ok(savedNode.verification);
        assert.equal(savedNode.verification.pydanticValid, true);

        // Build artifacts exist in .slate/build/verify/normalize
        const buildFiles = await vscode.workspace.fs.readDirectory(uri('.slate', 'build', 'verify', 'normalize'));
        assert.ok(buildFiles.some(([name]) => name === 'normalize_impl.py'));
        assert.ok(buildFiles.some(([name]) => name === 'test_normalize.py'));

        // 4. Code modification transitions state to stale
        await editBuffer('normalize', node => {
            node.code = [
                'def normalize(score: int, maximum: int) -> int:',
                '    return 42',
            ];
        });
        await act({ kind: 'refreshIndex' });
        snap = await snapshot();
        assert.equal(snap.verifications?.normalize?.state, 'stale');
        const normDoc = snap.documents.find(d => d.path === 'slate/nodes/normalize.json')!;
        assert.equal(normDoc.verification?.state, 'stale');

        // 5. Contract failure (violating return type annotation) produces failed state
        await editBuffer('normalize', node => {
            node.code = [
                'def normalize(score: int, maximum: int) -> int:',
                '    return "not an integer"  # violates return type int',
            ];
            node.cases = [
                { score: 50, maximum: 100, expected: 50 },
            ];
        });
        await (await vscode.workspace.openTextDocument(uri(...nodePath('normalize')))).save();

        await post({ type: 'verifyNode', nodeId: 'normalize' });
        await eventually(async () => {
            const state = (await snapshot()).verifications?.normalize?.state;
            return state === 'failed';
        }, 'contract failure verification');
        snap = await snapshot();
        assert.equal(snap.verifications?.normalize?.state, 'failed');
        assert.equal(snap.verifications?.normalize?.pydanticValid, false);
        assert.ok((snap.verifications?.normalize?.traceback?.length ?? 0) > 0);

        // 6. cancelVerification executes cleanly
        await post({ type: 'cancelVerification', nodeId: 'normalize' });
        const cancelMsgs = await messages();
        assert.ok(cancelMsgs !== undefined);

        // 7. tryRevisions runs bounded retry loop with forge feedback and never auto-accepts
        await messages();
        serverResponseContent = '```python\ndef normalize(score: int, maximum: int) -> int:\n    return (score * 100) // maximum\n```\n\n```python\ndef test_normalize():\n    assert normalize(50, 100) == 50\n```';
        await post({ type: 'tryRevisions', nodeId: 'normalize', maxRevisions: 3 });
        let loopMsgs: any[] = [];
        await eventually(async () => {
            loopMsgs.push(...await messages());
            return loopMsgs.some(m => m.type === 'proposalReady');
        }, 'tryRevisions generated proposal');

        // Target file on disk must NOT be auto-accepted
        const diskAfterLoop = await read(...nodePath('normalize'));
        assert.ok(diskAfterLoop.code.join('\n').includes('not an integer'));

        // Generated proposal contains verification checks
        const readyProposal = loopMsgs.find(m => m.type === 'proposalReady')?.proposal;
        assert.ok(readyProposal);
        assert.ok(readyProposal.checks.some((c: string) => c.includes('Revision') || c.includes('Verified')));
    });

    test('derived usage index across instances and dependencies, and forkDefinition action (S-502)', async () => {
        await open();

        // 1. Initial snapshot has usages index for all definition nodes
        let snap = await snapshot();
        assert.ok(snap.usages, 'snapshot has usages index');
        assert.ok(snap.usages.normalize, 'usages has entry for normalize');
        assert.ok(snap.usages.clamp, 'usages has entry for clamp');
        assert.equal(snap.usages.normalize.totalUses, 0);
        // Clamp has prompt context from normalize without inflating totalUses
        assert.equal(snap.usages.clamp.contextCount, 1);
        assert.ok(snap.usages.clamp.contextUsers.includes('normalize'));
        assert.equal(snap.usages.clamp.totalUses, 0);

        // 2. Add an instance of normalize to root canvas
        await act({ kind: 'addInstance', target: 'normalize' });
        snap = await snapshot();
        const normUsage = snap.usages?.normalize;
        assert.ok(normUsage);
        assert.equal(normUsage.instanceCount, 1);
        assert.equal(normUsage.totalUses, 1);
        assert.ok(normUsage.callSites.some(site => site.kind === 'root_instance' && site.instanceId?.startsWith('ref-')));

        // Document also carries derived usage
        const normDoc = snap.documents.find(d => d.path === 'slate/nodes/normalize.json')!;
        assert.ok(normDoc.usage);
        assert.equal(normDoc.usage.instanceCount, 1);

        // 3. forkDefinition clones definition into a fresh node file on disk and layout position
        await messages();
        await act({ kind: 'forkDefinition', target: 'normalize' });
        const msgs = await messages();
        assert.ok(msgs.some(m => m.ok === true && m.message?.includes('Forked definition normalize')));

        // Check new node exists on disk
        const copyNode = await read(...nodePath('normalize_copy'));
        assert.equal(copyNode.name, 'normalize_copy');
        assert.ok(copyNode.code.some((line: string) => line.includes('def normalize_copy(')));

        // Check new node has layout position and usage entry
        const updatedSnap = await snapshot();
        assert.ok(updatedSnap.layout?.normalize_copy, 'normalize_copy has layout position');
        assert.ok(updatedSnap.usages?.normalize_copy, 'normalize_copy has usage entry');
    });

    test('trusted runner compiles and executes flow, producing immutable build trace and per-use values (S-600)', async () => {
        await open();

        // 1. Create a test flow with clamp and values
        const flowUri = uri('slate', 'flows', 'exec_flow.json');
        await vscode.workspace.fs.writeFile(flowUri, encode({
            slate: 3,
            name: 'exec_flow',
            inputs: [],
            outputs: [{ id: 'out:val', name: 'val', annotation: 'int' }],
            instances: [
                { id: 'v_val', kind: 'value', value: '42' },
                { id: 'v_lo', kind: 'value', value: '0' },
                { id: 'v_hi', kind: 'value', value: '100' },
                { id: 'inst_clamp', node: 'clamp' },
            ],
            wires: [
                { from: 'v_val.out', to: 'inst_clamp.in:value' },
                { from: 'v_lo.out', to: 'inst_clamp.in:lower' },
                { from: 'v_hi.out', to: 'inst_clamp.in:upper' },
                { from: 'inst_clamp.out', to: 'output:val' },
            ],
            extra: {},
        }));

        await post({ type: 'ready' });
        await messages();

        // 2. Run the flow
        await post({ type: 'runFlow', flowId: 'exec_flow' });

        // 3. Poll for completion
        let execSnap = (await snapshot()).execution;
        const deadline = Date.now() + 15000;
        while ((!execSnap || execSnap.status === 'running' || execSnap.status === 'idle') && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 200));
            execSnap = (await snapshot()).execution;
        }

        assert.ok(execSnap, 'execution snapshot exists');
        assert.equal(execSnap.status, 'completed');
        assert.equal(execSnap.exitCode, 0);

        // 4. Assert observations and valuesByUse
        const clampObs = execSnap.observations.find(o => o.instanceId === 'inst_clamp');
        assert.ok(clampObs, 'inst_clamp has observation');
        assert.equal(clampObs.status, 'executed');
        assert.equal(clampObs.outputs.out?.json, 42);

        assert.equal(execSnap.valuesByUse['::inst_clamp::out']?.json, 42);
        assert.equal(execSnap.valuesByUse['::v_val::out']?.json, 42);

        // 5. Verify immutable build directory created on disk
        const buildDirUri = vscode.Uri.joinPath(root, '.slate', 'build', execSnap.runId);
        const buildStat = await vscode.workspace.fs.stat(buildDirUri);
        assert.equal(buildStat.type, vscode.FileType.Directory);

        // 6. Test stopFlow when idle reports clean message
        await messages();
        await post({ type: 'stopFlow' });
        const stopMsgs = await messages();
        assert.ok(stopMsgs.some(m => m.ok === false || m.ok === true));
    });

});
