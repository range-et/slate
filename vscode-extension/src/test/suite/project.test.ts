import * as assert from 'assert';
import * as vscode from 'vscode';
import type { HarnessSnapshot } from '../../harness_protocol';

suite('Slate native project commands', () => {
    let root: vscode.Uri;
    let ownsProject = false;
    let restores: Array<() => void>;
    const uri = (...parts: string[]) => vscode.Uri.joinPath(root, 'slate', ...parts);
    const read = async (...parts: string[]) => new TextDecoder().decode(await vscode.workspace.fs.readFile(uri(...parts)));
    function replace(object: object, key: string, value: unknown): void {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
        Object.defineProperty(object, key, { ...descriptor, value });
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

});
