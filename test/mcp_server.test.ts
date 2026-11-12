import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    SlateMcpServer, validateStubBody, MCP_TOOLS
} from '../vscode-extension/src/mcp/slate_mcp_server';

describe('Frontier Architect MCP Server (S-510)', () => {
    let tmpDir: string;
    let server: SlateMcpServer;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-mcp-test-'));
        // Setup a minimal slate workspace structure
        await fs.mkdir(path.join(tmpDir, 'slate', 'nodes'), { recursive: true });
        await fs.mkdir(path.join(tmpDir, 'slate', 'flows'), { recursive: true });
        await fs.writeFile(
            path.join(tmpDir, 'slate', 'slate.json'),
            JSON.stringify({ slate: 3, name: 'test_project', language: 'python' }, null, 2),
            'utf8',
        );
        await fs.writeFile(
            path.join(tmpDir, 'slate', 'layout.json'),
            JSON.stringify({
                positions: { 'calc': { x: 100, y: 150 } },
                notes: [
                    { id: 'note-1', title: 'Architecture note', body: 'Design considerations', attachedTo: 'calc' },
                ],
                refs: [],
                placeholders: [],
            }, null, 2),
            'utf8',
        );
        // Create an existing sample node
        await fs.writeFile(
            path.join(tmpDir, 'slate', 'nodes', 'calc.json'),
            JSON.stringify({
                slate: 3,
                name: 'calc',
                intent: 'Perform calculations',
                contract: 'value >= 0',
                context: [],
                describedBy: 'human',
                locked: false,
                imports: [],
                uses: [],
                code: [
                    'def calc(value: int) -> int:',
                    '    return value * 2',
                ],
            }, null, 2),
            'utf8',
        );

        server = new SlateMcpServer(tmpDir);
    });

    afterEach(async () => {
        server.close();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    describe('MCP JSON-RPC Protocol', () => {
        it('handles initialize handshake with protocolVersion 2024-11-05 and tools capability', async () => {
            const resp = await server.handleRequest({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'test-client', version: '1.0' },
                },
            });
            expect(resp).toMatchObject({
                jsonrpc: '2.0',
                id: 1,
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'slate-frontier-architect', version: '0.1.0' },
                },
            });
        });

        it('returns null for initialized notification and empty object for ping', async () => {
            const notifResp = await server.handleRequest({
                jsonrpc: '2.0',
                method: 'notifications/initialized',
            });
            expect(notifResp).toBeNull();

            const pingResp = await server.handleRequest({
                jsonrpc: '2.0',
                id: 2,
                method: 'ping',
            });
            expect(pingResp).toMatchObject({
                jsonrpc: '2.0',
                id: 2,
                result: {},
            });
        });

        it('tools/list enumerates all 5 required frontier architect tools', async () => {
            const resp = await server.handleRequest({
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/list',
            });
            expect(resp).not.toBeNull();
            const tools = (resp as any).result.tools;
            expect(tools).toHaveLength(5);
            const toolNames = tools.map((t: any) => t.name);
            expect(toolNames).toEqual([
                'slate_find',
                'slate_focus',
                'slate_place_notes',
                'slate_define_stub',
                'slate_wire_flow',
            ]);
            for (const tool of tools) {
                expect(tool.description).toBeTruthy();
                expect(tool.inputSchema.type).toBe('object');
            }
        });

        it('reports -32601 on unknown methods and -32700 on malformed json', async () => {
            const unknownResp = await server.handleRequest({
                jsonrpc: '2.0',
                id: 99,
                method: 'nonexistent_method',
            });
            expect(unknownResp).toMatchObject({
                jsonrpc: '2.0',
                id: 99,
                error: { code: -32601 },
            });

            const parseResp = await server.handleMessage('this is not json');
            expect(parseResp).toContain('-32700');
        });
    });

    describe('Strict Stub Body Validation (zero function bodies)', () => {
        it('permits valid stubs: pass, ..., raise NotImplementedError, and docstrings', () => {
            expect(validateStubBody('def foo(x: int) -> int', 'pass').valid).toBe(true);
            expect(validateStubBody('def foo(x: int) -> int', '...').valid).toBe(true);
            expect(validateStubBody('def foo(x: int) -> int', 'raise NotImplementedError').valid).toBe(true);
            expect(validateStubBody('def foo(x: int) -> int', 'raise NotImplementedError("TODO: implement foo")').valid).toBe(true);
            expect(validateStubBody('def foo(x: int) -> int', '"""Calculate foo."""\npass').valid).toBe(true);
            expect(validateStubBody('def foo(x: int) -> int', '# A helpful comment\nraise NotImplementedError').valid).toBe(true);
        });

        it('strictly refuses arbitrary implementation code (returns, assignments, loops, calls)', () => {
            const returnCheck = validateStubBody('def foo(x: int) -> int', 'return x + 1');
            expect(returnCheck.valid).toBe(false);
            expect(returnCheck.reason).toContain('Arbitrary function body implementations are strictly refused');

            const assignCheck = validateStubBody('def foo(x: int) -> int', 'x = 10\npass');
            expect(assignCheck.valid).toBe(false);
            expect(assignCheck.reason).toContain('Arbitrary function body implementations are strictly refused');

            const loopCheck = validateStubBody('def foo(x: int) -> int', 'for i in range(10): pass');
            expect(loopCheck.valid).toBe(false);
            expect(loopCheck.reason).toContain('Arbitrary function body implementations are strictly refused');

            const raiseOtherCheck = validateStubBody('def foo(x: int) -> int', 'raise ValueError("bad")');
            expect(raiseOtherCheck.valid).toBe(false);
            expect(raiseOtherCheck.reason).toContain('Only NotImplementedError may be raised');

            const callCheck = validateStubBody('def foo(x: int) -> int', 'print("hello")\nraise NotImplementedError');
            expect(callCheck.valid).toBe(false);
            expect(callCheck.reason).toContain('Arbitrary expression in function body is refused');
        });
    });

    describe('Tool: slate_find', () => {
        it('finds existing nodes by name and code query', async () => {
            const res = await server.callTool('slate_find', { query: 'calc' });
            expect(res.isError).toBe(false);
            const parsed = JSON.parse(res.content[0].text);
            expect(parsed.ok).toBe(true);
            expect(parsed.nodes).toHaveLength(1);
            expect(parsed.nodes[0].name).toBe('calc');
            expect(parsed.notes).toHaveLength(1);
            expect(parsed.notes[0].title).toBe('Architecture note');
        });

        it('filters by scope and signature', async () => {
            const nodeOnly = await server.callTool('slate_find', { scope: 'nodes' });
            const nodeParsed = JSON.parse(nodeOnly.content[0].text);
            expect(nodeParsed.nodes.length).toBeGreaterThan(0);
            expect(nodeParsed.notes).toHaveLength(0);

            const notesOnly = await server.callTool('slate_find', { scope: 'notes' });
            const notesParsed = JSON.parse(notesOnly.content[0].text);
            expect(notesParsed.notes.length).toBeGreaterThan(0);
            expect(notesParsed.nodes).toHaveLength(0);

            const sigMatch = await server.callTool('slate_find', { signature: 'int' });
            const sigParsed = JSON.parse(sigMatch.content[0].text);
            expect(sigParsed.nodes.some((n: any) => n.name === 'calc')).toBe(true);

            const noMatch = await server.callTool('slate_find', { signature: 'float' });
            const noParsed = JSON.parse(noMatch.content[0].text);
            expect(noParsed.nodes).toHaveLength(0);
        });
    });

    describe('Tool: slate_focus', () => {
        it('dispatches to in-process bridge when available', async () => {
            const focusSpy = vi.fn().mockResolvedValue(true);
            server.setBridge({ focusCamera: focusSpy });

            const res = await server.callTool('slate_focus', {
                target: 'calc',
                zoom: 1.2,
                duration: 250,
            });
            expect(res.isError).toBe(false);
            const parsed = JSON.parse(res.content[0].text);
            expect(parsed.ok).toBe(true);
            expect(parsed.focused).toBe('calc');
            expect(parsed.liveWebview).toBe(true);
            expect(focusSpy).toHaveBeenCalledWith({
                target: 'calc',
                region: undefined,
                zoom: 1.2,
                duration: 250,
            });
        });

        it('records focus intent cleanly in headless mode when no live webview is connected', async () => {
            server.setBridge(undefined);
            const res = await server.callTool('slate_focus', {
                region: { x: 100, y: 200, width: 400, height: 300 },
            });
            expect(res.isError).toBe(false);
            const parsed = JSON.parse(res.content[0].text);
            expect(parsed.ok).toBe(true);
            expect(parsed.focused).toBe('region');
            expect(parsed.liveWebview).toBe(false);
        });
    });

    describe('Tool: slate_place_notes', () => {
        it('creates a new note with position and attachedTo in layout.json', async () => {
            const res = await server.callTool('slate_place_notes', {
                title: 'Data pipeline design',
                body: 'Ingestion -> Validation -> Aggregation',
                attachedTo: 'calc',
                position: { x: 300, y: 400 },
            });
            expect(res.isError).toBe(false);
            const parsed = JSON.parse(res.content[0].text);
            expect(parsed.ok).toBe(true);
            expect(parsed.notes).toHaveLength(1);
            expect(parsed.notes[0].title).toBe('Data pipeline design');

            // Verify written layout.json
            const raw = await fs.readFile(path.join(tmpDir, 'slate', 'layout.json'), 'utf8');
            const layout = JSON.parse(raw);
            const found = layout.notes.find((n: any) => n.title === 'Data pipeline design');
            expect(found).toBeDefined();
            expect(found.attachedTo).toBe('calc');
            expect(layout.positions[found.id]).toEqual({ x: 300, y: 400 });
        });

        it('updates an existing note and supports batch notes', async () => {
            const res = await server.callTool('slate_place_notes', {
                id: 'note-1',
                title: 'Updated note title',
                body: 'Updated body text',
                position: { x: 120, y: 160 },
            });
            expect(res.isError).toBe(false);

            const raw = await fs.readFile(path.join(tmpDir, 'slate', 'layout.json'), 'utf8');
            const layout = JSON.parse(raw);
            const updated = layout.notes.find((n: any) => n.id === 'note-1');
            expect(updated.title).toBe('Updated note title');
            expect(layout.positions['note-1']).toEqual({ x: 120, y: 160 });
        });
    });

    describe('Tool: slate_define_stub', () => {
        it('creates a typed atomic stub with intent, contract, cases and default stub body', async () => {
            const res = await server.callTool('slate_define_stub', {
                name: 'clamp',
                signature: 'def clamp(value: int, lower: int, upper: int) -> int',
                intent: 'Clamp value to range [lower, upper]',
                contract: 'lower <= upper',
                context: ['calc'],
                cases: [
                    { name: 'in_range', input: { value: 5, lower: 0, upper: 10 }, expected: 5 },
                    { name: 'below_lower', input: { value: -5, lower: 0, upper: 10 }, expected: 0 },
                ],
                position: { x: 250, y: 100 },
            });
            expect(res.isError).toBe(false);
            const parsed = JSON.parse(res.content[0].text);
            expect(parsed.ok).toBe(true);
            expect(parsed.created).toEqual(['clamp']);

            // Verify file written to slate/nodes/clamp.json
            const nodeRaw = await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'clamp.json'), 'utf8');
            const node = JSON.parse(nodeRaw);
            expect(node.name).toBe('clamp');
            expect(node.intent).toBe('Clamp value to range [lower, upper]');
            expect(node.contract).toBe('lower <= upper');
            expect(node.cases).toHaveLength(2);
            expect(node.code).toEqual([
                'def clamp(value: int, lower: int, upper: int) -> int:',
                '    raise NotImplementedError',
            ]);

            // Verify position in layout.json
            const layoutRaw = await fs.readFile(path.join(tmpDir, 'slate', 'layout.json'), 'utf8');
            const layout = JSON.parse(layoutRaw);
            expect(layout.positions['clamp']).toEqual({ x: 250, y: 100 });
        });

        it('strictly refuses arbitrary function body implementation in slate_define_stub', async () => {
            const res = await server.callTool('slate_define_stub', {
                name: 'clamp_bad',
                signature: 'def clamp_bad(value: int, lower: int, upper: int) -> int',
                intent: 'Clamp value to range',
                body: 'return max(lower, min(value, upper))', // Disallowed arbitrary implementation
            });
            expect(res.isError).toBe(true);
            expect(res.content[0].text).toContain('Arbitrary function body implementations are strictly refused');

            // Verify file was NOT created
            await expect(fs.stat(path.join(tmpDir, 'slate', 'nodes', 'clamp_bad.json'))).rejects.toThrow();
        });

        it('supports splitting an oversized node into smaller atomic stubs (S-510 splitFrom)', async () => {
            const res = await server.callTool('slate_define_stub', {
                splitFrom: 'calc',
                stubs: [
                    {
                        name: 'calc_step_a',
                        signature: 'def calc_step_a(x: int) -> int',
                        intent: 'First phase of calculation',
                        body: 'pass',
                        position: { x: 100, y: 300 },
                    },
                    {
                        name: 'calc_step_b',
                        signature: 'def calc_step_b(y: int) -> int',
                        intent: 'Second phase of calculation',
                        body: 'raise NotImplementedError',
                        position: { x: 300, y: 300 },
                    },
                ],
            });
            expect(res.isError).toBe(false);
            const parsed = JSON.parse(res.content[0].text);
            expect(parsed.ok).toBe(true);
            expect(parsed.created).toEqual(['calc_step_a', 'calc_step_b']);
            expect(parsed.splitFrom).toBe('calc');

            // Verify both stub files were created
            const aRaw = await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'calc_step_a.json'), 'utf8');
            const bRaw = await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'calc_step_b.json'), 'utf8');
            expect(JSON.parse(aRaw).name).toBe('calc_step_a');
            expect(JSON.parse(bRaw).name).toBe('calc_step_b');

            // Verify parent node updated with context dependencies
            const parentRaw = await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'calc.json'), 'utf8');
            const parent = JSON.parse(parentRaw);
            expect(parent.context).toContain('calc_step_a');
            expect(parent.context).toContain('calc_step_b');
        });
    });

    describe('Tool: slate_wire_flow', () => {
        it('connects typed instances deterministically and writes to slate/flows/main.json', async () => {
            const res = await server.callTool('slate_wire_flow', {
                flow: 'main',
                instances: [
                    { id: 'inst1', node: 'calc', position: { x: 50, y: 50 } },
                    { id: 'inst2', node: 'clamp', position: { x: 300, y: 50 } },
                ],
                wires: [
                    { from: 'inst1.out', to: 'inst2.in:value' },
                ],
            });
            expect(res.isError).toBe(false);
            const parsed = JSON.parse(res.content[0].text);
            expect(parsed.ok).toBe(true);
            expect(parsed.instances).toHaveLength(2);
            expect(parsed.wires).toEqual([{ from: 'inst1.out', to: 'inst2.in:value' }]);

            // Verify file written to slate/flows/main.json
            const raw = await fs.readFile(path.join(tmpDir, 'slate', 'flows', 'main.json'), 'utf8');
            const flow = JSON.parse(raw);
            expect(flow.wires).toEqual([{ from: 'inst1.out', to: 'inst2.in:value' }]);
        });

        it('refuses self-loops on the same instance', async () => {
            const res = await server.callTool('slate_wire_flow', {
                flow: 'main',
                instances: [
                    { id: 'loop_inst', node: 'calc' },
                ],
                wires: [
                    { from: 'loop_inst.out', to: 'loop_inst.in:value' },
                ],
            });
            expect(res.isError).toBe(true);
            expect(res.content[0].text).toContain('Self-loop rejected');
        });

        it('supports removing instances and disconnecting wires', async () => {
            // First add wire
            await server.callTool('slate_wire_flow', {
                flow: 'custom_flow',
                instances: [
                    { id: 'node_a', node: 'calc' },
                    { id: 'node_b', node: 'calc' },
                ],
                wires: [
                    { from: 'node_a.out', to: 'node_b.in:value' },
                ],
            });

            // Disconnect wire
            const disRes = await server.callTool('slate_wire_flow', {
                flow: 'custom_flow',
                disconnect: [{ from: 'node_a.out', to: 'node_b.in:value' }],
            });
            const disParsed = JSON.parse(disRes.content[0].text);
            expect(disParsed.wires).toHaveLength(0);

            // Remove instance
            const remRes = await server.callTool('slate_wire_flow', {
                flow: 'custom_flow',
                removeInstances: ['node_b'],
            });
            const remParsed = JSON.parse(remRes.content[0].text);
            expect(remParsed.instances).toHaveLength(1);
            expect(remParsed.instances[0].id).toBe('node_a');
        });
    });

    describe('Stdio Stream Transport', () => {
        it('exchanges messages over readable/writable streams', async () => {
            const input = new PassThrough();
            const output = new PassThrough();
            server.connectStreams(input, output);

            const received: string[] = [];
            output.on('data', chunk => {
                received.push(chunk.toString());
            });

            const req = JSON.stringify({
                jsonrpc: '2.0',
                id: 10,
                method: 'tools/call',
                params: {
                    name: 'slate_find',
                    arguments: { query: 'calc' },
                },
            });
            input.write(`${req}\n`);

            // Wait for response
            const deadline = Date.now() + 3000;
            while (received.length === 0 && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            expect(received.length).toBeGreaterThan(0);
            const parsed = JSON.parse(received[0]);
            expect(parsed.id).toBe(10);
            expect(parsed.result.isError).toBe(false);
            const content = JSON.parse(parsed.result.content[0].text);
            expect(content.nodes[0].name).toBe('calc');
        });
    });
});
