import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../extension';
import { GENERATED_HEADER } from '../../compile/python';
import type { HarnessSnapshot } from '../../harness_protocol';
import { SlateFolderHost } from '../../slate_folder_host';

suite('Slate native project commands', () => {
    let root: vscode.Uri;
    let ownsProject = false;
    let restores: Array<() => void>;
    const uri = (...parts: string[]) => vscode.Uri.joinPath(root, 'slate', ...parts);
    const read = async (...parts: string[]) => new TextDecoder().decode(await vscode.workspace.fs.readFile(uri(...parts)));
    function replace(object: object, key: string, value: unknown): void {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
        const next = descriptor.get || descriptor.set
            ? { configurable: descriptor.configurable, enumerable: descriptor.enumerable, get: () => value }
            : { ...descriptor, value };
        Object.defineProperty(object, key, next);
        restores.push(() => Object.defineProperty(object, key, descriptor));
    }
    async function indexed(name: string): Promise<void> {
        const deadline = Date.now() + 8000;
        while ((await vscode.commands.executeCommand<HarnessSnapshot>('slate.test.getSnapshot'))?.projectName !== name) {
            assert.ok(Date.now() < deadline, `Project ${name} indexed`);
            await new Promise(resolve => setTimeout(resolve, 30));
        }
    }
    setup(async () => {
        restores = [];
        ownsProject = false;
        root = vscode.workspace.workspaceFolders![0].uri;
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        // These tests own only the otherwise absent slate/ in the test fixture root.
        // Refuse to overwrite an unexpected pre-existing project.
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(uri())));
        ownsProject = true;
    });
    teardown(async () => {
        for (const restore of restores.reverse()) restore();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        if (ownsProject) {
            try { await vscode.workspace.fs.delete(uri(), { recursive: true, useTrash: false }); }
            catch (error) { if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') throw error; }
        }
    });

    test('new-project cancellation validates names and leaves the workspace unchanged', async () => {
        let prompted = false;
        replace(vscode.window, 'showInputBox', async (options: vscode.InputBoxOptions) => {
            prompted = true;
            assert.equal(options.prompt, 'Slate project name');
            for (const invalid of ['', 'two words', '../outside', 'bad/name']) assert.ok(await options.validateInput?.(invalid));
            for (const valid of ['alpha', 'demo_2', 'project-name']) assert.equal(await options.validateInput?.(valid), null);
            return undefined;
        });
        await vscode.commands.executeCommand('slate.newProject');
        assert.ok(prompted);
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(uri())));
        assert.equal(await vscode.commands.executeCommand('slate.test.getSnapshot'), undefined);
    });

    test('new project persists its empty structure, opens the canvas and reopens without overwriting', async () => {
        replace(vscode.window, 'showInputBox', async () => 'native_project');
        await vscode.commands.executeCommand('slate.newProject');
        await indexed('native_project');
        const config = await read('slate.json');
        const layout = await read('layout.json');
        assert.deepEqual(JSON.parse(config), { slate: 3, name: 'native_project', language: 'python' });
        assert.deepEqual(JSON.parse(layout).positions, {});
        assert.deepEqual(JSON.parse(layout).notes, []);
        assert.deepEqual(await vscode.workspace.fs.readDirectory(uri('nodes')), []);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        let warning = '';
        replace(vscode.window, 'showInputBox', async () => { throw new Error('Existing project must not request a replacement name'); });
        replace(vscode.window, 'showWarningMessage', async (message: string) => { warning = message; });
        await vscode.commands.executeCommand('slate.newProject');
        await indexed('native_project');
        assert.equal(warning, 'slate/slate.json already exists. Opening it.');
        assert.equal(await read('slate.json'), config);
        assert.equal(await read('layout.json'), layout);
    });

    test('compile without a project reports the error without creating files', async () => {
        let error = '';
        replace(vscode.window, 'showErrorMessage', async (message: string) => { error = message; });
        assert.equal(await vscode.commands.executeCommand('slate.compile'), undefined);
        assert.equal(error, 'No slate/slate.json found. Create or port a Slate project first.');
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(uri())));
    });

    test('port cancellation requests a single folder and writes nothing', async () => {
        let prompted = false;
        replace(vscode.window, 'showOpenDialog', async (options: vscode.OpenDialogOptions) => {
            prompted = true;
            assert.equal(options.canSelectFolders, true);
            assert.equal(options.canSelectFiles, false);
            assert.equal(options.canSelectMany, false);
            return undefined;
        });
        assert.equal(await vscode.commands.executeCommand('slate.portProject'), 0);
        assert.ok(prompted);
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(uri())));
    });

    test('port refuses sources without Python and preserves an occupied destination', async () => {
        let error = '';
        replace(vscode.window, 'showErrorMessage', async (message: string) => { error = message; });
        const source = vscode.Uri.joinPath(root, 'folder_project', 'slate', 'nodes');
        assert.equal(await vscode.commands.executeCommand('slate.portProject', source), 0);
        assert.equal(error, 'No Python files found to port.');
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(uri())));
        await vscode.workspace.fs.createDirectory(uri('nodes'));
        await vscode.workspace.fs.writeFile(uri('nodes', 'keep.json'), new TextEncoder().encode('keep this file'));
        assert.equal(await vscode.commands.executeCommand('slate.portProject', source), 0);
        assert.equal(error, 'slate/nodes is not empty. Port into a project without nodes.');
        assert.equal(await read('nodes', 'keep.json'), 'keep this file');
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(uri('slate.json'))));
    });

    test('new-project filesystem failure rejects and leaves no configuration to open', async () => {
        replace(vscode.window, 'showInputBox', async () => 'native_project');
        // Use a real filesystem obstruction: VS Code freezes workspace.fs methods.
        const obstruction = new TextEncoder().encode('Existing file must survive');
        await vscode.workspace.fs.writeFile(uri(), obstruction);
        await assert.rejects(Promise.resolve(vscode.commands.executeCommand('slate.newProject')));
        assert.deepEqual(await vscode.workspace.fs.readFile(uri()), obstruction);
        await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(uri('slate.json'))));
        assert.equal(await vscode.commands.executeCommand('slate.test.getSnapshot'), undefined);
    });

    test('newProject and portProject require an open workspace folder', async () => {
        const errors: string[] = [];
        replace(vscode.workspace, 'workspaceFolders', undefined);
        replace(vscode.window, 'showErrorMessage', async (message: string) => { errors.push(message); });
        await vscode.commands.executeCommand('slate.newProject');
        assert.equal(await vscode.commands.executeCommand('slate.portProject'), 0);
        assert.deepEqual(errors, [
            'Open a workspace folder first; Slate creates its slate/ folder there.',
            'Open a workspace folder first; Slate writes its slate/ folder there.',
        ]);
    });

    test('openHarness offers New Project or Port when no project exists and opens or reveals the panel when present', async () => {
        replace(vscode.window, 'showInformationMessage', async () => undefined);
        await vscode.commands.executeCommand('slate.openHarness');
        assert.equal(await vscode.commands.executeCommand('slate.test.getSnapshot'), undefined);

        let portPrompted = false;
        replace(vscode.window, 'showInformationMessage', async () => 'Port Python Project…');
        replace(vscode.window, 'showOpenDialog', async () => { portPrompted = true; return undefined; });
        await vscode.commands.executeCommand('slate.openHarness');
        const deadline = Date.now() + 5000;
        while (!portPrompted) {
            assert.ok(Date.now() < deadline, 'port prompt shown');
            await new Promise(resolve => setTimeout(resolve, 20));
        }

        replace(vscode.window, 'showInformationMessage', async () => 'New Project');
        replace(vscode.window, 'showInputBox', async () => 'open_harness_demo');
        await vscode.commands.executeCommand('slate.openHarness');
        await indexed('open_harness_demo');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');

        await vscode.commands.executeCommand('slate.openHarness');
        await indexed('open_harness_demo');
        // Second call while open reveals and refreshes the existing panel.
        await vscode.commands.executeCommand('slate.openHarness');
        await indexed('open_harness_demo');
    });

    test('launcher view resolves CSP HTML and routes button messages, and deactivate/activate resets adapter', async () => {
        deactivate();
        await vscode.commands.executeCommand('slate.openHarness');
        assert.equal(await vscode.commands.executeCommand('slate.test.getSnapshot'), undefined);

        let provider: vscode.WebviewViewProvider | undefined;
        const registered = new Map<string, (...args: unknown[]) => unknown>();
        replace(vscode.commands, 'registerCommand', (id: string, cb: (...args: unknown[]) => unknown) => {
            registered.set(id, cb);
            return new vscode.Disposable(() => {});
        });
        replace(vscode.window, 'registerWebviewViewProvider', (_id: string, viewProvider: vscode.WebviewViewProvider) => {
            provider = viewProvider;
            return new vscode.Disposable(() => {});
        });
        replace(vscode.window, 'registerCustomEditorProvider', () => new vscode.Disposable(() => {}));

        activate({
            extensionMode: vscode.ExtensionMode.Production,
            extensionUri: root,
            subscriptions: [],
        } as unknown as vscode.ExtensionContext);
        assert.ok(provider);

        let onMessage: ((message: unknown) => void) | undefined;
        const fakeView = {
            webview: {
                options: {},
                html: '',
                cspSource: 'vscode-webview://test',
                onDidReceiveMessage: (cb: (message: unknown) => void) => {
                    onMessage = cb;
                    return new vscode.Disposable(() => {});
                },
            },
        } as unknown as vscode.WebviewView;
        provider!.resolveWebviewView(fakeView, {} as vscode.WebviewViewResolveContext, new vscode.CancellationTokenSource().token);
        assert.ok(fakeView.webview.html.includes('Open Slate Canvas'));

        const executed: string[] = [];
        replace(vscode.commands, 'executeCommand', async (command: string) => { executed.push(command); });
        for (const type of ['open', 'new', 'port', 'compile', 'unknown']) onMessage?.({ type });
        assert.deepEqual(executed, ['slate.openHarness', 'slate.newProject', 'slate.portProject', 'slate.compile']);
    });

    test('port via dialog skips hidden/skipped/generated files, preserves existing config/layout, and reports warnings', async () => {
        const srcRoot = vscode.Uri.joinPath(root, `port-src-${Date.now()}`);
        const enc = (text: string) => new TextEncoder().encode(text);
        try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(srcRoot, 'sub'));
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(srcRoot, '.hidden'));
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(srcRoot, '__pycache__'));
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(srcRoot, 'sub', 'mod.py'), enc('def f(x: int) -> int:\n    return x\n'));
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(srcRoot, 'broken.py'), enc('def broken(:\n'));
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(srcRoot, 'gen.py'), enc(`${GENERATED_HEADER}def skip() -> None:\n    pass\n`));
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(srcRoot, 'README.md'), enc('# readme\n'));
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(srcRoot, '.hidden', 'h.py'), enc('def h() -> int:\n    return 1\n'));
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(srcRoot, '__pycache__', 'c.py'), enc('def c() -> int:\n    return 1\n'));

            await vscode.workspace.fs.createDirectory(uri());
            await vscode.workspace.fs.writeFile(uri('slate.json'), enc('{\n  "slate": 3,\n  "name": "kept_name",\n  "language": "python"\n}\n'));
            await vscode.workspace.fs.writeFile(uri('layout.json'), enc('{\n  "positions": {},\n  "notes": []\n}\n'));

            let info = '';
            replace(vscode.window, 'showOpenDialog', async () => [srcRoot]);
            replace(vscode.window, 'showInformationMessage', async (message: string) => { info = message; });
            const count = await vscode.commands.executeCommand<number>('slate.portProject');
            assert.equal(count, 1);
            assert.ok(info.includes('warning(s)'), info);
            await indexed('kept_name');
        } finally {
            await vscode.workspace.fs.delete(srcRoot, { recursive: true, useTrash: false });
        }
    });

    test('compile reports node/flow/outDir errors without writing, and removes stale nested generated files on success with warnings', async () => {
        const enc = (text: string) => new TextEncoder().encode(text);
        await vscode.workspace.fs.createDirectory(uri('nodes'));
        await vscode.workspace.fs.createDirectory(uri('flows'));
        await vscode.workspace.fs.writeFile(uri('slate.json'), enc(JSON.stringify({
            slate: 3, name: 'compile_demo', language: 'python', compile: { outDir: 'slate/bad' },
        }, null, 2) + '\n'));
        await vscode.workspace.fs.writeFile(uri('layout.json'), enc('{\n  "positions": {},\n  "notes": []\n}\n'));
        await vscode.workspace.fs.writeFile(uri('nodes', 'bad.json'), enc('{not json'));
        await vscode.workspace.fs.writeFile(uri('flows', 'bad.json'), enc('{not json'));

        let error = '';
        replace(vscode.window, 'showErrorMessage', async (message: string) => { error = message; });
        const failed = await vscode.commands.executeCommand<{ files: string[]; diagnostics: Array<{ severity: string }> }>('slate.compile');
        assert.deepEqual(failed?.files, []);
        assert.ok((failed?.diagnostics.length ?? 0) >= 3);
        assert.ok(error.includes('compile stopped'));

        const outSub = vscode.Uri.joinPath(root, 'out_compile_test', 'nested');
        try {
            await vscode.workspace.fs.delete(uri('nodes', 'bad.json'));
            await vscode.workspace.fs.delete(uri('flows', 'bad.json'));
            await vscode.workspace.fs.writeFile(uri('slate.json'), enc(JSON.stringify({
                slate: 3, name: 'compile_demo', language: 'python', compile: { outDir: 'out_compile_test' },
            }, null, 2) + '\n'));
            await vscode.workspace.fs.writeFile(uri('nodes', 'f.json'), enc(JSON.stringify({
                slate: 3, name: 'f',
                intent: 'id', contract: '', context: [], locked: false, describedBy: 'human',
                code: ['def f(x: int) -> int:', '    return x'],
            }, null, 2) + '\n'));
            await vscode.workspace.fs.writeFile(uri('flows', 'pipe.json'), enc(JSON.stringify({
                slate: 3, name: 'pipe',
                inputs: [{ name: 'x', annotation: 'int' }, { name: 'unused', annotation: 'int' }],
                outputs: [{ name: 'out', annotation: 'int' }],
                instances: [{ id: 'f', node: 'f' }],
                wires: [{ from: 'input:x', to: 'f.in:x' }, { from: 'f.out', to: 'output:out' }],
            }, null, 2) + '\n'));
            await vscode.workspace.fs.createDirectory(outSub);
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(outSub, 'stale.py'), enc(`${GENERATED_HEADER}x = 1\n`));
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(outSub, 'handwritten.py'), enc('x = 2\n'));
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(outSub, 'notes.txt'), enc('keep\n'));

            let info = '';
            replace(vscode.window, 'showInformationMessage', async (message: string) => { info = message; });
            const ok = await vscode.commands.executeCommand<{ files: string[]; diagnostics: Array<{ severity: string }> }>('slate.compile');
            assert.ok(ok && ok.files.length > 0);
            assert.ok(info.includes('warning(s)'), info);
            await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.joinPath(outSub, 'stale.py'))));
            assert.ok(await vscode.workspace.fs.stat(vscode.Uri.joinPath(outSub, 'handwritten.py')));
        } finally {
            try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, 'out_compile_test'), { recursive: true, useTrash: false }); } catch { /* ignore */ }
        }
    });

    test('SlateFolderHost handles missing config, directory libraries, invalid library files, and librarySignatures', async () => {
        const host = new SlateFolderHost(root);
        await assert.rejects(host.index(), /slate\/slate\.json is missing/);
        await assert.rejects(host.readNodes(), /slate\/slate\.json is missing/);
        await assert.rejects(host.readConfigText(), /slate\/slate\.json is missing/);

        const vendor = vscode.Uri.joinPath(root, `vendor-test-${Date.now()}`);
        const enc = (text: string) => new TextEncoder().encode(text);
        try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(vendor, 'sub'));
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(vendor, '.hidden'));
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(vendor, '__pycache__'));
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(vendor, 'sub', 'ok.py'), enc('class Helper:\n    def run(self, x: int) -> int:\n        return x\n'));
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(vendor, 'broken.py'), enc('def bad(:\n'));
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(vendor, 'README.md'), enc('hi\n'));
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(vendor, '.hidden', 'h.py'), enc('def h() -> int:\n    return 1\n'));
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(vendor, '__pycache__', 'c.py'), enc('def c() -> int:\n    return 1\n'));

            const rel = host.relative(vendor);
            const docs = await host.readLibrary({ slate: 3, name: 'lib_demo', language: 'python', library: [rel, `${rel}/missing.py`] });
            assert.equal(docs.length, 3);
            assert.ok(docs.some(doc => doc.problem === 'not found'));
            assert.ok(docs.some(doc => doc.path.endsWith('/broken.py') && doc.problem));
            const sigs = SlateFolderHost.librarySignatures(docs);
            assert.ok(sigs.has(`lib:${rel}/sub/ok.py:Helper`));

            // Also exercise readLibrary and librarySignatures through the bundled extension command.
            await vscode.workspace.fs.createDirectory(uri('nodes'));
            await vscode.workspace.fs.writeFile(uri('slate.json'), enc(JSON.stringify({
                slate: 3, name: 'lib_demo', language: 'python', library: [rel, `${rel}/missing.py`], compile: { outDir: 'slate/bad' },
            }, null, 2) + '\n'));
            replace(vscode.window, 'showErrorMessage', async () => undefined);
            await vscode.commands.executeCommand('slate.compile');
        } finally {
            await vscode.workspace.fs.delete(vendor, { recursive: true, useTrash: false });
        }
    });

});
