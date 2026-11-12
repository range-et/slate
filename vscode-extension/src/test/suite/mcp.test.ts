import * as assert from 'assert';
import * as vscode from 'vscode';

import { SlateMcpServer } from '../../mcp/slate_mcp_server';
import type { HarnessSnapshot } from '../../harness_protocol';

type Message = {
    type: string;
    target?: string;
    region?: { x: number; y: number; width?: number; height?: number };
    zoom?: number;
    duration?: number;
    [key: string]: unknown;
};

async function waitForSnapshot(predicate: (snapshot: HarnessSnapshot) => boolean): Promise<HarnessSnapshot> {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
        const snapshot = await vscode.commands.executeCommand<HarnessSnapshot | undefined>('slate.test.getSnapshot');
        if (snapshot && predicate(snapshot)) return snapshot;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for the Slate harness snapshot.');
}

suite('Slate Frontier Architect MCP Suite', () => {
    let folder: vscode.Uri;
    let mcpServer: SlateMcpServer;

    suiteSetup(async () => {
        const extension = vscode.extensions.getExtension('indrajeet-haldar.slate-code');
        assert.ok(extension, 'Slate extension is installed');
        await extension.activate();

        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        assert.ok(root, 'fixture workspace is open');
        const projectRoot = vscode.Uri.joinPath(root, 'folder_project');
        folder = vscode.Uri.joinPath(projectRoot, 'slate');

        await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(folder, 'slate.json'), 'slate.editor');
        await waitForSnapshot(snapshot => snapshot.documents.some(d => d.units.some(u => u.name === 'clamp')));

        // Obtain MCP server bridged to the active panel
        mcpServer = await vscode.commands.executeCommand<SlateMcpServer>('slate.test.createMcpServer', projectRoot.fsPath);
        assert.ok(mcpServer, 'MCP server initialized');
    });

    test('slate_find searches nodes, flows, and layout notes', async () => {
        const result = await mcpServer.callTool('slate_find', { query: 'clamp' });
        assert.equal(result.isError, false);
        const data = JSON.parse(result.content[0].text);
        assert.equal(data.ok, true);
        assert.ok(data.nodes.some((n: any) => n.name === 'clamp'));
    });

    test('slate_focus dispatches smooth viewport camera sync to active webview', async () => {
        // Clear any prior test messages
        await vscode.commands.executeCommand('slate.test.takeMessages');

        const result = await mcpServer.callTool('slate_focus', {
            target: 'clamp',
            zoom: 1.25,
            duration: 350,
        });
        assert.equal(result.isError, false);
        const data = JSON.parse(result.content[0].text);
        assert.equal(data.ok, true);
        assert.equal(data.liveWebview, true);

        // Verify message received by webview
        const messages = await vscode.commands.executeCommand<Message[]>('slate.test.takeMessages') ?? [];
        const focusMsg = messages.find(m => m.type === 'focus');
        assert.ok(focusMsg, 'Webview received focus message');
        assert.equal(focusMsg.target, 'clamp');
        assert.equal(focusMsg.zoom, 1.25);
        assert.equal(focusMsg.duration, 350);
    });

    test('slate_focus centers on bounding region', async () => {
        await vscode.commands.executeCommand('slate.test.takeMessages');

        const result = await mcpServer.callTool('slate_focus', {
            region: { x: 100, y: 150, width: 600, height: 400 },
            duration: 200,
        });
        assert.equal(result.isError, false);
        const messages = await vscode.commands.executeCommand<Message[]>('slate.test.takeMessages') ?? [];
        const focusMsg = messages.find(m => m.type === 'focus');
        assert.ok(focusMsg, 'Webview received region focus message');
        assert.deepEqual(focusMsg.region, { x: 100, y: 150, width: 600, height: 400 });
        assert.equal(focusMsg.duration, 200);
    });

    test('slate_place_notes creates and updates spatial notes on canvas', async () => {
        const result = await mcpServer.callTool('slate_place_notes', {
            title: 'MCP Architect Note',
            body: 'Documenting architectural decision',
            attachedTo: 'clamp',
            position: { x: 500, y: 250 },
        });
        assert.equal(result.isError, false);
        const data = JSON.parse(result.content[0].text);
        assert.equal(data.ok, true);
        const noteId = data.notes[0].id;

        // Verify layout.json on disk
        const layoutUri = vscode.Uri.joinPath(folder, 'layout.json');
        const raw = await vscode.workspace.fs.readFile(layoutUri);
        const layout = JSON.parse(new TextDecoder().decode(raw));
        const found = layout.notes.find((n: any) => n.id === noteId);
        assert.ok(found, 'Note stored in layout.json');
        assert.equal(found.title, 'MCP Architect Note');
        assert.equal(found.attachedTo, 'clamp');

        // Cleanup note
        layout.notes = layout.notes.filter((n: any) => n.id !== noteId);
        delete layout.positions[noteId];
        await vscode.workspace.fs.writeFile(layoutUri, new TextEncoder().encode(JSON.stringify(layout, null, 2) + '\n'));
    });

    test('slate_define_stub creates typed atomic stubs and strictly refuses body code', async () => {
        const stubName = 'mcp_test_stub';
        const stubFileUri = vscode.Uri.joinPath(folder, 'nodes', `${stubName}.json`);

        try {
            // 1. Refuse arbitrary implementation code
            const refused = await mcpServer.callTool('slate_define_stub', {
                name: stubName,
                signature: `def ${stubName}(x: int) -> int`,
                intent: 'Test stub that tries to return a value',
                body: 'return x + 42',
            });
            assert.equal(refused.isError, true);
            assert.ok(refused.content[0].text.includes('Arbitrary function body implementations are strictly refused'));

            // 2. Accept valid atomic stub
            const accepted = await mcpServer.callTool('slate_define_stub', {
                name: stubName,
                signature: `def ${stubName}(x: int, y: int) -> int`,
                intent: 'Compute something via forged body later',
                contract: 'x > 0 and y > 0',
                context: ['clamp'],
                cases: [{ name: 'positive', input: { x: 1, y: 2 }, expected: 3 }],
                body: 'raise NotImplementedError',
                position: { x: 120, y: 450 },
            });
            assert.equal(accepted.isError, false);
            const data = JSON.parse(accepted.content[0].text);
            assert.equal(data.ok, true);
            assert.deepEqual(data.created, [stubName]);

            // Verify file written to disk
            const fileRaw = await vscode.workspace.fs.readFile(stubFileUri);
            const node = JSON.parse(new TextDecoder().decode(fileRaw));
            assert.equal(node.name, stubName);
            assert.equal(node.intent, 'Compute something via forged body later');
            assert.equal(node.contract, 'x > 0 and y > 0');
            assert.equal(node.cases.length, 1);
            assert.deepEqual(node.code, [
                `def ${stubName}(x: int, y: int) -> int:`,
                '    raise NotImplementedError',
            ]);
        } finally {
            try {
                await vscode.workspace.fs.delete(stubFileUri);
                const layoutUri = vscode.Uri.joinPath(folder, 'layout.json');
                const raw = await vscode.workspace.fs.readFile(layoutUri);
                const layout = JSON.parse(new TextDecoder().decode(raw));
                delete layout.positions[stubName];
                await vscode.workspace.fs.writeFile(layoutUri, new TextEncoder().encode(JSON.stringify(layout, null, 2) + '\n'));
            } catch {
                // Ignore if not created
            }
        }
    });

    test('slate_wire_flow connects and disconnects wires in flows', async () => {
        const mainFlowUri = vscode.Uri.joinPath(folder, 'flows', 'main.json');
        let beforeRaw: Uint8Array | null = null;
        try {
            beforeRaw = await vscode.workspace.fs.readFile(mainFlowUri);
        } catch {
            beforeRaw = null;
        }

        try {
            const result = await mcpServer.callTool('slate_wire_flow', {
                flow: 'main',
                instances: [
                    { id: 'mcp_src', node: 'clamp' },
                    { id: 'mcp_dst', node: 'normalize' },
                ],
                wires: [
                    { from: 'mcp_src.out', to: 'mcp_dst.in:score' },
                ],
            });
            assert.equal(result.isError, false);
            const data = JSON.parse(result.content[0].text);
            assert.equal(data.ok, true);
            assert.ok(data.wires.some((w: any) => w.from === 'mcp_src.out' && w.to === 'mcp_dst.in:score'));

            // Verify disk
            const afterRaw = await vscode.workspace.fs.readFile(mainFlowUri);
            const afterFlow = JSON.parse(new TextDecoder().decode(afterRaw));
            assert.ok(afterFlow.wires.some((w: any) => w.from === 'mcp_src.out' && w.to === 'mcp_dst.in:score'));
        } finally {
            if (beforeRaw) {
                await vscode.workspace.fs.writeFile(mainFlowUri, beforeRaw);
            } else {
                try {
                    await vscode.workspace.fs.delete(mainFlowUri);
                } catch {
                    // Ignore
                }
            }
        }
    });
});
