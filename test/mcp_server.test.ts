import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    SlateMcpServer, validateStubBody, MCP_TOOLS, runSlateMcpCli
} from '../vscode-extension/src/mcp/slate_mcp_server';
import { credentialPairingKey } from '../vscode-extension/src/llama_transport';
import { startFakeLlamaServer } from './support/fake_llama_server';

describe('Frontier Architect MCP Server (S-510)', () => {
    let tmpDir: string;
    let server: SlateMcpServer;
    let approvedPairings: Set<string>;

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

        approvedPairings = new Set<string>();
        server = new SlateMcpServer(tmpDir, undefined, {
            isTrusted: true,
            approvedCredentialPairings: approvedPairings,
        });
    });

    afterEach(async () => {
        server.close();
        await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

        it('tools/list enumerates all 10 required frontier architect tools', async () => {
            const resp = await server.handleRequest({
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/list',
            });
            expect(resp).not.toBeNull();
            const tools = (resp as any).result.tools;
            expect(tools).toHaveLength(10);
            const toolNames = tools.map((t: any) => t.name);
            expect(toolNames).toEqual([
                'slate_find',
                'slate_focus',
                'slate_place_notes',
                'slate_define_stub',
                'slate_wire_flow',
                'slate_llm_status',
                'slate_configure_llm',
                'slate_forge_batch',
                'slate_references',
                'slate_compile',
            ]);
            for (const tool of tools) {
                expect(tool.description).toBeTruthy();
                expect(tool.inputSchema.type).toBe('object');
            }
        });

        it('refuses malformed or non-object payloads with -32600 error without throwing', async () => {
            const nullResp = await server.handleMessage('null');
            expect(nullResp).toContain('-32600');
            const numResp = await server.handleMessage('42');
            expect(numResp).toContain('-32600');
            const arrResp = await server.handleMessage('[1, 2, 3]');
            expect(arrResp).toContain('-32600');
            const badObjResp = await server.handleMessage('{"foo": "bar"}');
            expect(badObjResp).toContain('-32600');
        });
    });

    describe('Strict Stub Body Validation (zero function bodies)', () => {
        it('permits valid stubs: pass, ..., raise NotImplementedError, and docstrings', () => {
            expect(validateStubBody('def foo(x: int) -> int', 'pass').valid).toBe(true);
            expect(validateStubBody('def foo(x: int) -> int', '...').valid).toBe(true);
            expect(validateStubBody('def foo(x: int) -> int', 'raise NotImplementedError').valid).toBe(true);
            expect(validateStubBody('def foo(x: int) -> int', 'raise NotImplementedError()').valid).toBe(true);
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

            // Arbitrary expressions inside raise NotImplementedError(...) are strictly refused
            const callInsideRaise = validateStubBody('def foo(x: int) -> int', 'raise NotImplementedError(os.system("ls"))');
            expect(callInsideRaise.valid).toBe(false);
            expect(callInsideRaise.reason).toContain('NotImplementedError argument must be an optional literal string message');

            const multiArgRaise = validateStubBody('def foo(x: int) -> int', 'raise NotImplementedError("a", "b")');
            expect(multiArgRaise.valid).toBe(false);
            expect(multiArgRaise.reason).toContain('NotImplementedError argument must be an optional literal string message');

            const fStringRaise = validateStubBody('def foo(x: int) -> int', 'raise NotImplementedError(f"bad {x}")');
            expect(fStringRaise.valid).toBe(false);
            expect(fStringRaise.reason).toContain('NotImplementedError argument must be an optional literal string message');
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

        it('discovers nested flow files recursively under slate/flows/**/*', async () => {
            await fs.mkdir(path.join(tmpDir, 'slate', 'flows', 'sub'), { recursive: true });
            await fs.writeFile(
                path.join(tmpDir, 'slate', 'flows', 'sub', 'nested.json'),
                JSON.stringify({ slate: 3, name: 'nested', instances: [], wires: [], inputs: [], outputs: [] }),
                'utf8'
            );
            const res = await server.callTool('slate_find', { scope: 'flows' });
            const parsed = JSON.parse(res.content[0].text);
            expect(parsed.flows.some((f: any) => f.path.includes('nested'))).toBe(true);
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

        it('rejects path traversal attempting to escape slate/nodes', async () => {
            const res = await server.callTool('slate_define_stub', {
                name: '../../escaped_node',
                signature: 'def escaped_node() -> None',
                intent: 'Attempt escape',
            });
            expect(res.isError).toBe(true);
            expect(res.content[0].text).toContain('Path traversal rejected');
        });

        it('refuses to overwrite an active node implementation with a stub', async () => {
            // calc already exists in tmpDir with real implementation (return value * 2)
            const res = await server.callTool('slate_define_stub', {
                name: 'calc',
                signature: 'def calc(value: int) -> int',
                intent: 'Erase real implementation',
                body: 'pass',
            });
            expect(res.isError).toBe(true);
            expect(res.content[0].text).toContain('already has an active implementation');

            // Verify original implementation is intact
            const raw = await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'calc.json'), 'utf8');
            expect(raw).toContain('return value * 2');
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

        it('rejects path traversal attempting to escape slate/flows', async () => {
            const res = await server.callTool('slate_wire_flow', {
                flow: '../../escaped_flow',
                instances: [{ id: 'n1', node: 'calc' }],
            });
            expect(res.isError).toBe(true);
            expect(res.content[0].text).toContain('Path traversal rejected');
        });

        it('refuses wiring when endpoint instances do not exist in the flow', async () => {
            const res = await server.callTool('slate_wire_flow', {
                flow: 'main',
                instances: [{ id: 'inst1', node: 'calc' }],
                wires: [{ from: 'inst1.out', to: 'nonexistent_instance.in' }],
            });
            expect(res.isError).toBe(true);
            expect(res.content[0].text).toContain('does not exist in flow');
        });

        it('declares flow inputs/outputs, preserves existing ports, validates boundary ports, and compiles end-to-end', async () => {
            await server.callTool('slate_define_stub', {
                name: 'scientific/double',
                signature: 'def double(x: float) -> float',
                intent: 'Double input x',
                imports: ['import math'],
                cases: [{ name: 'c1', input: { x: 2 }, expected: 4 }],
            });
            const nodePath = path.join(tmpDir, 'slate', 'nodes', 'scientific', 'double.json');
            const nodeJson = JSON.parse(await fs.readFile(nodePath, 'utf8'));
            expect(nodeJson.imports).toEqual(['import math']);
            nodeJson.code = ['def double(x: float) -> float:', '    return float(x * 2.0)'];
            await fs.writeFile(nodePath, JSON.stringify(nodeJson, null, 2), 'utf8');

            const wireRes = await server.callTool('slate_wire_flow', {
                flow: 'sci_calc/twice',
                inputs: [{ name: 'val', annotation: 'float' }],
                outputs: [{ name: 'result', annotation: 'float' }],
                instances: [{ id: 'd1', node: 'scientific/double' }],
                wires: [
                    { from: 'input:val', to: 'd1.in:x' },
                    { from: 'd1.out', to: 'output:result' },
                ],
            });
            expect(wireRes.isError).toBe(false);
            const wired = JSON.parse(wireRes.content[0].text);
            expect(wired.flow).toBe('twice');
            expect(wired.inputs).toEqual([{ name: 'val', annotation: 'float' }]);
            expect(wired.outputs).toEqual([{ name: 'result', annotation: 'float' }]);

            // Omitting inputs/outputs preserves existing declared ports
            const updatePos = await server.callTool('slate_wire_flow', {
                flow: 'sci_calc/twice',
                instances: [{ id: 'd1', position: { x: 100, y: 200 } }],
            });
            expect(updatePos.isError).toBe(false);
            const preserved = JSON.parse(updatePos.content[0].text);
            expect(preserved.inputs).toEqual([{ name: 'val', annotation: 'float' }]);

            // Rejects undeclared boundary ports and duplicate port names
            const missingIn = await server.callTool('slate_wire_flow', {
                flow: 'sci_calc/twice',
                wires: [{ from: 'input:missing_port', to: 'd1.in:x' }],
            });
            expect(missingIn.isError).toBe(true);
            expect(missingIn.content[0].text).toContain('missing_port');

            const dupPort = await server.callTool('slate_wire_flow', {
                flow: 'bad_ports',
                inputs: [{ name: 'x' }, { name: 'x' }],
            });
            expect(dupPort.isError).toBe(true);
            expect(dupPort.content[0].text).toContain('Duplicate port name');

            // End-to-end compile succeeds without manual flow editing
            const compileRes = await server.callTool('slate_compile', { outDir: 'compiled_out' });
            expect(compileRes.isError).toBe(false);
            const compileParsed = JSON.parse(compileRes.content[0].text);
            expect(compileParsed.ok).toBe(true);
            expect(compileParsed.diagnostics).toEqual([]);
            const compiledFlowPy = await fs.readFile(path.join(tmpDir, 'compiled_out', 'sci_calc.py'), 'utf8');
            expect(compiledFlowPy).toContain('def twice(val: float) -> float:');

            // Updating inputs/outputs removes wires attached to deleted boundary ports without breaking compile
            await server.callTool('slate_wire_flow', {
                flow: 'sci_calc/twice',
                inputs: [
                    { name: 'val', annotation: 'float' },
                    { name: 'extra_in', annotation: 'float' },
                ],
                outputs: [
                    { name: 'result', annotation: 'float' },
                    { name: 'extra_out', annotation: 'float' },
                ],
                wires: [
                    { from: 'd1.out', to: 'output:extra_out' },
                ],
            });
            const pruneExtras = await server.callTool('slate_wire_flow', {
                flow: 'sci_calc/twice',
                inputs: [{ name: 'val', annotation: 'float' }],
                outputs: [{ name: 'result', annotation: 'float' }],
            });
            expect(pruneExtras.isError).toBe(false);
            const prunedExtrasData = JSON.parse(pruneExtras.content[0].text);
            expect(prunedExtrasData.wires).toEqual([
                { from: 'input:val', to: 'd1.in:x' },
                { from: 'd1.out', to: 'output:result' },
            ]);
            const postExtraCompile = await server.callTool('slate_compile', { outDir: 'compiled_out' });
            expect(JSON.parse(postExtraCompile.content[0].text)).toMatchObject({ ok: true, diagnostics: [] });

            // Clearing all inputs/outputs also removes remaining boundary wires
            const clearAll = await server.callTool('slate_wire_flow', {
                flow: 'sci_calc/twice',
                inputs: [],
                outputs: [],
                removeInstances: ['d1'],
            });
            expect(clearAll.isError).toBe(false);
            const clearedData = JSON.parse(clearAll.content[0].text);
            expect(clearedData.inputs).toEqual([]);
            expect(clearedData.outputs).toEqual([]);
            expect(clearedData.wires).toEqual([]);

            const postPruneCompile = await server.callTool('slate_compile', { outDir: 'compiled_out' });
            expect(postPruneCompile.isError).toBe(false);
            const postPruneParsed = JSON.parse(postPruneCompile.content[0].text);
            expect(postPruneParsed.ok).toBe(true);
            expect(postPruneParsed.diagnostics).toEqual([]);
        });
    });

    describe('MCP Tool Improvements (Issue #53)', () => {
        it('slate_define_stub validates imports and rejects forbidden slate.* imports', async () => {
            const badSyntax = await server.callTool('slate_define_stub', {
                name: 'bad_imp',
                signature: 'def bad_imp() -> int',
                intent: 'bad',
                imports: ['not an import'],
            });
            expect(badSyntax.isError).toBe(true);
            expect(badSyntax.content[0].text).toContain('Invalid Python import');

            const badSlate = await server.callTool('slate_define_stub', {
                name: 'slate_imp',
                signature: 'def slate_imp() -> int',
                intent: 'bad',
                imports: ['from slate.nodes.calc import calc'],
            });
            expect(badSlate.isError).toBe(true);
            expect(badSlate.content[0].text).toContain('Forbidden internal import');
        });

        it('slate_find extracts parsed signatures instead of raw leading comments', async () => {
            await fs.writeFile(
                path.join(tmpDir, 'slate', 'nodes', 'commented.json'),
                JSON.stringify({
                    slate: 3,
                    name: 'commented',
                    intent: 'Has leading comment',
                    contract: 'Returns int',
                    code: ['# SECTION HEADER', 'def commented(x: int) -> int:', '    return x + 1'],
                }, null, 2),
                'utf8',
            );
            const findRes = await server.callTool('slate_find', { query: 'commented', scope: 'nodes' });
            expect(findRes.isError).toBe(false);
            const data = JSON.parse(findRes.content[0].text);
            const hit = data.nodes.find((n: any) => n.id === 'commented');
            expect(hit.signature).toBe('def commented(x: int) -> int');
        });

        it('slate_forge_batch returns compact failure digests by default and full details with verbose:true', async () => {
            await server.callTool('slate_define_stub', {
                name: 'fail_stub',
                signature: 'def fail_stub(x: int) -> int',
                intent: 'Return x + 1',
                contract: 'Returns x + 1',
                cases: [{ name: 'c1', input: { x: 1 }, expected: 2 }],
            });
            const fakeServer = await startFakeLlamaServer(() => [
                '### Implementation\n```python\ndef fail_stub(x: int) -> int:\n    return x + 999\n```',
            ]);
            try {
                const compactRes = await server.callTool('slate_forge_batch', {
                    nodeIds: ['fail_stub'],
                    maxRevisions: 1,
                    endpoint: fakeServer.url,
                    model: 'fake',
                });
                expect(compactRes.isError).toBe(false);
                const compactJson = JSON.parse(compactRes.content[0].text);
                expect(compactJson.results[0].verification.traceback).toBeUndefined();
                expect(compactJson.results[0].reason.length).toBeLessThanOrEqual(360);

                const verboseRes = await server.callTool('slate_forge_batch', {
                    nodeIds: ['fail_stub'],
                    maxRevisions: 1,
                    verbose: true,
                    endpoint: fakeServer.url,
                    model: 'fake',
                });
                const verboseJson = JSON.parse(verboseRes.content[0].text);
                expect(verboseJson.results[0].verification.traceback).toBeTruthy();
            } finally {
                await fakeServer.close();
            }
        }, 20_000);

        it('runSlateMcpCli handles --help, --list-tools, --call with --args and --args-file, and errors cleanly', async () => {
            const runCli = async (argv: string[]) => {
                let stdout = '';
                let stderr = '';
                const code = await runSlateMcpCli(argv, {
                    stdout: s => { stdout += s; },
                    stderr: s => { stderr += s; },
                    cwd: tmpDir,
                });
                return { code, stdout, stderr };
            };

            const help = await runCli(['--help']);
            expect(help.code).toBe(0);
            expect(help.stdout).toContain('--list-tools');

            const list = await runCli(['--list-tools']);
            expect(list.code).toBe(0);
            expect(JSON.parse(list.stdout).some((t: any) => t.name === 'slate_wire_flow')).toBe(true);

            const callInline = await runCli(['--workspace', tmpDir, '--call', 'slate_find', '--args', '{"query":"calc"}']);
            expect(callInline.code).toBe(0);
            expect(JSON.parse(callInline.stdout).nodes.some((n: any) => n.id === 'calc')).toBe(true);

            const argsPath = path.join(tmpDir, 'find_args.json');
            await fs.writeFile(argsPath, JSON.stringify({ scope: 'nodes' }), 'utf8');
            const callFile = await runCli(['--workspace', tmpDir, '--call', 'slate_find', '--args-file', argsPath]);
            expect(callFile.code).toBe(0);
            expect(JSON.parse(callFile.stdout).nodes.length).toBeGreaterThanOrEqual(1);

            const badFlag = await runCli(['--unknown-flag']);
            expect(badFlag.code).toBe(1);
            expect(badFlag.stderr).toContain('Unknown argument');

            const badTool = await runCli(['--workspace', tmpDir, '--call', 'nonexistent_tool']);
            expect(badTool.code).toBe(1);
            expect(badTool.stderr).toContain('Unknown tool');

            const bothArgs = await runCli(['--call', 'slate_find', '--args', '{}', '--args-file', argsPath]);
            expect(bothArgs.code).toBe(1);
            expect(bothArgs.stderr).toContain('not both');
        });
    });

    describe('Existing file safety (no silent erasure)', () => {
        it('rejects print(...) smuggled inside NotImplementedError(...)', () => {
            const res = validateStubBody('def foo() -> None', "raise NotImplementedError(print('implemented'))");
            expect(res.valid).toBe(false);
        });

        it('slate_place_notes refuses to overwrite a malformed layout.json', async () => {
            const layoutPath = path.join(tmpDir, 'slate', 'layout.json');
            await fs.writeFile(layoutPath, '{ not valid json', 'utf8');
            const res = await server.callTool('slate_place_notes', { title: 'New', body: 'x' });
            expect(res.isError).toBe(true);
            expect(res.content[0].text).toContain('invalid and was not modified');
            expect(await fs.readFile(layoutPath, 'utf8')).toBe('{ not valid json');
        });

        it('slate_place_notes creates a layout only when layout.json is missing', async () => {
            await fs.rm(path.join(tmpDir, 'slate', 'layout.json'));
            const res = await server.callTool('slate_place_notes', { title: 'Fresh', body: 'x' });
            expect(res.isError).toBe(false);
            const layout = JSON.parse(await fs.readFile(path.join(tmpDir, 'slate', 'layout.json'), 'utf8'));
            expect(layout.notes.some((n: any) => n.title === 'Fresh')).toBe(true);
        });

        it('slate_wire_flow refuses to overwrite a malformed flow file', async () => {
            const flowPath = path.join(tmpDir, 'slate', 'flows', 'main.json');
            await fs.writeFile(flowPath, '{ broken', 'utf8');
            const res = await server.callTool('slate_wire_flow', { instances: [{ id: 'a', node: 'calc' }] });
            expect(res.isError).toBe(true);
            expect(res.content[0].text).toContain('invalid and was not modified');
            expect(await fs.readFile(flowPath, 'utf8')).toBe('{ broken');
        });

        it('slate_define_stub refuses to overwrite a malformed node file', async () => {
            const nodePath = path.join(tmpDir, 'slate', 'nodes', 'broken.json');
            await fs.writeFile(nodePath, '{ nope', 'utf8');
            const res = await server.callTool('slate_define_stub', {
                name: 'broken', signature: 'def broken() -> None', intent: 'x',
            });
            expect(res.isError).toBe(true);
            expect(res.content[0].text).toContain('invalid and was not modified');
            expect(await fs.readFile(nodePath, 'utf8')).toBe('{ nope');
        });

        it('slate_wire_flow position-only update preserves the instance node and value', async () => {
            await server.callTool('slate_wire_flow', {
                instances: [{ id: 'step', node: 'calc' }, { id: 'const', kind: 'value', value: '7' }],
            });
            const res = await server.callTool('slate_wire_flow', {
                instances: [
                    { id: 'step', position: { x: 10, y: 20 } },
                    { id: 'const', position: { x: 30, y: 40 } },
                ],
            });
            expect(res.isError).toBe(false);
            const flow = JSON.parse(await fs.readFile(path.join(tmpDir, 'slate', 'flows', 'main.json'), 'utf8'));
            const step = flow.instances.find((i: any) => (typeof i === 'string' ? i : i.id) === 'step');
            const konst = flow.instances.find((i: any) => (typeof i === 'string' ? false : i.id === 'const'));
            expect(step).toMatchObject({ id: 'step', node: 'calc' });
            expect(konst).toMatchObject({ id: 'const', kind: 'value', value: '7' });
            const layout = JSON.parse(await fs.readFile(path.join(tmpDir, 'slate', 'layout.json'), 'utf8'));
            expect(layout.positions.step).toEqual({ x: 10, y: 20 });
        });

        it('slate_wire_flow can still retarget an instance when node is given explicitly', async () => {
            await server.callTool('slate_wire_flow', { instances: [{ id: 'step', node: 'calc' }] });
            await server.callTool('slate_wire_flow', { instances: [{ id: 'step', node: 'other' }] });
            const flow = JSON.parse(await fs.readFile(path.join(tmpDir, 'slate', 'flows', 'main.json'), 'utf8'));
            expect(flow.instances.find((i: any) => i.id === 'step')).toMatchObject({ node: 'other' });
        });
    });

    describe('Parallel edits mutation serialization', () => {
        it('serializes concurrent file-changing operations without losing updates', async () => {
            const promises = [
                server.callTool('slate_define_stub', {
                    name: 'concurrent_a',
                    signature: 'def concurrent_a() -> None',
                    intent: 'First concurrent stub',
                }),
                server.callTool('slate_define_stub', {
                    name: 'concurrent_b',
                    signature: 'def concurrent_b() -> None',
                    intent: 'Second concurrent stub',
                }),
                server.callTool('slate_place_notes', {
                    title: 'Concurrent note',
                    body: 'Note body',
                    position: { x: 50, y: 50 },
                }),
            ];
            const results = await Promise.all(promises);
            for (const r of results) {
                expect(r.isError).toBe(false);
            }

            // Verify both stub files exist
            await expect(fs.stat(path.join(tmpDir, 'slate', 'nodes', 'concurrent_a.json'))).resolves.toBeDefined();
            await expect(fs.stat(path.join(tmpDir, 'slate', 'nodes', 'concurrent_b.json'))).resolves.toBeDefined();

            // Verify layout has both positions and the note
            const layoutRaw = await fs.readFile(path.join(tmpDir, 'slate', 'layout.json'), 'utf8');
            const layout = JSON.parse(layoutRaw);
            expect(layout.notes.some((n: any) => n.title === 'Concurrent note')).toBe(true);
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

        it('slate_llm_status reports reachability against a local server and offline when unreachable', async () => {
            const unreachableResult = await server.callTool('slate_llm_status', { endpoint: 'http://127.0.0.1:1', timeoutMs: 200 });
            expect(unreachableResult.isError).toBe(false);
            const unreachableParsed = JSON.parse(unreachableResult.content[0].text);
            expect(unreachableParsed.ok).toBe(false);

            const fakeServer = await startFakeLlamaServer();
            try {
                const healthyResult = await server.callTool('slate_llm_status', { endpoint: fakeServer.url });
                expect(healthyResult.isError).toBe(false);
                const healthyParsed = JSON.parse(healthyResult.content[0].text);
                expect(healthyParsed.ok).toBe(true);
                expect(healthyParsed.models).toContain('tiny-local');
            } finally {
                await fakeServer.close();
            }
        });

        it('slate_configure_llm updates settings through bridge and validates URL format', async () => {
            let configured: any = null;
            server.setBridge({
                setLlamaConfig: async cfg => { configured = cfg; },
                getLlamaConfig: () => configured ?? { endpoint: 'http://127.0.0.1:8080', model: 'local' },
                isWorkspaceTrusted: () => true,
            });

            const invalidResult = await server.callTool('slate_configure_llm', { endpoint: 'invalid-url' });
            expect(invalidResult.isError).toBe(true);
            expect(invalidResult.content[0].text).toContain('valid HTTP/HTTPS');

            const fakeServer = await startFakeLlamaServer();
            try {
                const validResult = await server.callTool('slate_configure_llm', {
                    endpoint: fakeServer.url,
                    model: 'qwen2.5-coder',
                    timeoutSeconds: 60,
                });
                expect(validResult.isError).toBe(false);
                const parsed = JSON.parse(validResult.content[0].text);
                expect(parsed.updated).toBe(true);
                expect(parsed.reachable).toBe(true);
                expect(configured).toEqual({
                    endpoint: fakeServer.url,
                    model: 'qwen2.5-coder',
                    timeoutSeconds: 60,
                });
            } finally {
                await fakeServer.close();
            }
        });

        it('slate_configure_llm persists non-secret llm config to slate.json and rejects raw secrets', async () => {
            const rejectKey = await server.callTool('slate_configure_llm', {
                endpoint: 'https://openrouter.ai/api/v1',
                apiKey: 'sk-fake-secret',
            });
            expect(rejectKey.isError).toBe(true);
            expect(rejectKey.content[0].text).toContain('Raw API keys are rejected');

            const rejectSkEnv = await server.callTool('slate_configure_llm', {
                endpoint: 'https://openrouter.ai/api/v1',
                apiKeyEnv: 'sk-fake-secret',
            });
            expect(rejectSkEnv.isError).toBe(true);
            expect(rejectSkEnv.content[0].text).toContain('not a raw API key');

            const fakeServer = await startFakeLlamaServer(undefined, { requiredAuth: 'Bearer fake-mcp-auth' });
            approvedPairings.add(credentialPairingKey(fakeServer.url, 'SLATE_MCP_TEST_KEY'));
            const prevEnv = process.env.SLATE_MCP_TEST_KEY;
            process.env.SLATE_MCP_TEST_KEY = 'fake-mcp-auth';
            try {
                const writeRes = await server.callTool('slate_configure_llm', {
                    provider: 'openai-compatible',
                    endpoint: fakeServer.url,
                    model: 'qwen/qwen3-coder-30b-a3b-instruct',
                    apiKeyEnv: 'SLATE_MCP_TEST_KEY',
                    concurrency: 3,
                    writeToProject: true,
                });
                expect(writeRes.isError).toBe(false);
                const parsed = JSON.parse(writeRes.content[0].text);
                expect(parsed).toMatchObject({
                    updated: true,
                    writeToProject: true,
                    provider: 'openai-compatible',
                    model: 'qwen/qwen3-coder-30b-a3b-instruct',
                    apiKeyEnv: 'SLATE_MCP_TEST_KEY',
                    hasApiKey: true,
                    reachable: true,
                });

                const diskConfig = JSON.parse(await fs.readFile(path.join(tmpDir, 'slate', 'slate.json'), 'utf8'));
                expect(diskConfig.llm).toEqual({
                    provider: 'openai-compatible',
                    endpoint: fakeServer.url,
                    model: 'qwen/qwen3-coder-30b-a3b-instruct',
                    apiKeyEnv: 'SLATE_MCP_TEST_KEY',
                    concurrency: 3,
                });

                const statusRes = await server.callTool('slate_llm_status', {});
                expect(statusRes.isError).toBe(false);
                const statusParsed = JSON.parse(statusRes.content[0].text);
                expect(statusParsed).toMatchObject({
                    ok: true,
                    provider: 'openai-compatible',
                    model: 'qwen/qwen3-coder-30b-a3b-instruct',
                    hasApiKey: true,
                });
            } finally {
                if (prevEnv === undefined) delete process.env.SLATE_MCP_TEST_KEY;
                else process.env.SLATE_MCP_TEST_KEY = prevEnv;
                await fakeServer.close();
            }
        });

        it('slate_forge_batch statelessly forges stubs over MCP and notifies canvas bridge', async () => {
            const notified: string[] = [];
            server.setBridge({
                onStubDefined: async id => { notified.push(id); },
                isWorkspaceTrusted: () => true,
                getApprovedCredentialPairings: () => approvedPairings,
            });

            const stubRes = await server.callTool('slate_define_stub', {
                stubs: [
                    {
                        name: 'inc',
                        signature: 'def inc(x: int) -> int',
                        intent: 'Increment integer by one',
                        contract: 'Returns x + 1',
                        cases: [{ name: 'c1', input: { x: 4 }, expected: 5 }],
                    },
                    {
                        name: 'dec',
                        signature: 'def dec(x: int) -> int',
                        intent: 'Decrement integer by one',
                        contract: 'Returns x - 1',
                        cases: [{ name: 'c1', input: { x: 4 }, expected: 3 }],
                    },
                ],
            });
            expect(stubRes.isError).toBe(false);
            notified.length = 0;

            const fakeServer = await startFakeLlamaServer(req => {
                const prompt = String((req as any).messages?.[1]?.content ?? '');
                if (prompt.includes('def inc(')) {
                    return ['### Implementation\n```python\ndef inc(x: int) -> int:\n    return x + 1\n```\n\n### Unit Check\n```python\ndef test_inc():\n    assert inc(4) == 5\n```'];
                }
                return ['### Implementation\n```python\ndef dec(x: int) -> int:\n    return x - 1\n```\n\n### Unit Check\n```python\ndef test_dec():\n    assert dec(4) == 3\n```'];
            }, { requiredAuth: 'Bearer fake-batch-mcp' });
            approvedPairings.add(credentialPairingKey(fakeServer.url, 'SLATE_MCP_BATCH_KEY'));

            const prevEnv = process.env.SLATE_MCP_BATCH_KEY;
            process.env.SLATE_MCP_BATCH_KEY = 'fake-batch-mcp';
            try {
                const secretReject = await server.callTool('slate_forge_batch', { apiKey: 'sk-nope' });
                expect(secretReject.isError).toBe(true);
                expect(secretReject.content[0].text).toContain('Raw API keys are rejected');

                const traversalReject = await server.callTool('slate_forge_batch', { nodeIds: ['../../evil'] });
                expect(traversalReject.isError).toBe(true);
                expect(traversalReject.content[0].text).toContain('Path traversal rejected');

                const batchRes = await server.callTool('slate_forge_batch', {
                    allStubs: true,
                    concurrency: 2,
                    endpoint: fakeServer.url,
                    model: 'qwen/qwen3-coder-30b-a3b-instruct',
                    apiKeyEnv: 'SLATE_MCP_BATCH_KEY',
                });
                expect(batchRes.isError).toBe(false);
                const parsed = JSON.parse(batchRes.content[0].text);
                expect(parsed).toMatchObject({
                    ok: true,
                    forgedCount: 2,
                    failedCount: 0,
                    hasApiKey: true,
                });
                expect(notified.sort()).toEqual(['dec', 'inc']);

                const incNode = JSON.parse(await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'inc.json'), 'utf8'));
                expect(incNode.code).toEqual(['def inc(x: int) -> int:', '    return x + 1']);
                expect(incNode.verification.state).toBe('passed');
            } finally {
                if (prevEnv === undefined) delete process.env.SLATE_MCP_BATCH_KEY;
                else process.env.SLATE_MCP_BATCH_KEY = prevEnv;
                await fakeServer.close();
            }
        }, 20_000);
    });

    describe('TypeScript stubs, AST references, and safe multi-language compile', () => {
        it('slate_define_stub creates TS stubs, rejects arbitrary TS bodies, and refuses overwriting implemented TS nodes', async () => {
            await fs.writeFile(
                path.join(tmpDir, 'slate', 'slate.json'),
                JSON.stringify({ slate: 3, name: 'ts_app', language: 'typescript' }, null, 2),
                'utf8',
            );

            const bodyReject = await server.callTool('slate_define_stub', {
                name: 'scaleScore',
                signature: 'export function scaleScore(v: number): number',
                intent: 'Multiply by 2',
                body: 'return v * 2;',
            });
            expect(bodyReject.isError).toBe(true);
            expect(bodyReject.content[0].text).toMatch(/stub|throw/i);

            const okStub = await server.callTool('slate_define_stub', {
                name: 'scaleScore',
                signature: 'export function scaleScore(v: number): number',
                intent: 'Multiply by 2',
                modulePath: 'src/math/scale.ts',
                extension: '.ts',
                cases: [{ name: 'c1', input: { v: 3 }, expected: 6 }],
            });
            expect(okStub.isError).toBe(false);
            const nodeRaw = await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'scaleScore.json'), 'utf8');
            const nodeDisk = JSON.parse(nodeRaw);
            expect(nodeDisk.language).toBe('typescript');
            expect(nodeDisk.modulePath).toBe('src/math/scale.ts');
            expect(nodeDisk.extension).toBe('.ts');

            // Simulate forged implementation on disk, then ensure slate_define_stub refuses overwrite
            nodeDisk.code = ['export function scaleScore(v: number): number {', '    return v * 2;', '}'];
            await fs.writeFile(path.join(tmpDir, 'slate', 'nodes', 'scaleScore.json'), JSON.stringify(nodeDisk, null, 2), 'utf8');

            const overwriteReject = await server.callTool('slate_define_stub', {
                name: 'scaleScore',
                signature: 'export function scaleScore(v: number): number',
                intent: 'Overwrite check',
            });
            expect(overwriteReject.isError).toBe(true);
            expect(overwriteReject.content[0].text).toContain('already has an active implementation');
        });

        it('slate_references reports uses, dependencies, and flow/caller references accurately', async () => {
            await fs.writeFile(
                path.join(tmpDir, 'slate', 'slate.json'),
                JSON.stringify({ slate: 3, name: 'ts_refs', language: 'typescript' }, null, 2),
                'utf8',
            );
            await fs.writeFile(
                path.join(tmpDir, 'slate', 'nodes', 'leaf.json'),
                JSON.stringify({
                    slate: 3,
                    name: 'leaf',
                    language: 'typescript',
                    intent: 'Leaf helper',
                    code: ['export function leaf(x: number): number {', '    return x + 1;', '}'],
                }, null, 2),
                'utf8',
            );
            await fs.writeFile(
                path.join(tmpDir, 'slate', 'nodes', 'caller.json'),
                JSON.stringify({
                    slate: 3,
                    name: 'caller',
                    language: 'typescript',
                    intent: 'Calls leaf',
                    context: ['leaf'],
                    code: ['export function caller(x: number): number {', '    return leaf(x) * 2;', '}'],
                }, null, 2),
                'utf8',
            );

            const leafRefs = await server.callTool('slate_references', { nodeId: 'leaf' });
            expect(leafRefs.isError).toBe(false);
            const leafParsed = JSON.parse(leafRefs.content[0].text);
            expect(leafParsed.nodeId).toBe('leaf');
            expect(leafParsed.dependencyCount).toBeGreaterThanOrEqual(1);
            expect(leafParsed.usedBy.some((s: any) => s.nodeId === 'caller')).toBe(true);
            expect(leafParsed.contextUsers).toContain('caller');

            const callerRefs = await server.callTool('slate_references', { nodeId: 'caller' });
            expect(callerRefs.isError).toBe(false);
            const callerParsed = JSON.parse(callerRefs.content[0].text);
            expect(callerParsed.uses).toContain('leaf');
            expect(callerParsed.dependsOn).toContain('leaf');

            const summary = await server.callTool('slate_references', {});
            expect(summary.isError).toBe(false);
            const summaryParsed = JSON.parse(summary.content[0].text);
            expect(summaryParsed.totalNodes).toBeGreaterThanOrEqual(2);
        });

        it('slate_compile compiles safely, prunes stale generated files, and refuses overwriting hand-written files or escaping workspace', async () => {
            await fs.rm(path.join(tmpDir, 'slate', 'nodes', 'calc.json'), { force: true });
            await fs.writeFile(
                path.join(tmpDir, 'slate', 'slate.json'),
                JSON.stringify({ slate: 3, name: 'compile_demo', language: 'typescript', compile: { outDir: 'built-ts' } }, null, 2),
                'utf8',
            );
            await fs.writeFile(
                path.join(tmpDir, 'slate', 'nodes', 'greet.json'),
                JSON.stringify({
                    slate: 3,
                    name: 'greet',
                    language: 'typescript',
                    intent: 'Greet user',
                    contract: 'Returns greeting for non-empty name',
                    modulePath: 'greet.ts',
                    extension: '.ts',
                    code: ['export function greet(name: string): string {', '    return `Hi ${name}`;', '}'],
                }, null, 2),
                'utf8',
            );

            // Unsafe outDir rejections
            const escapeRes = await server.callTool('slate_compile', { outDir: '../outside' });
            expect(escapeRes.isError).toBe(true);
            const slateDirRes = await server.callTool('slate_compile', { outDir: 'slate/nodes' });
            expect(slateDirRes.isError).toBe(true);

            // Dry run does not write files
            const dry = await server.callTool('slate_compile', { dryRun: true });
            expect(dry.isError).toBe(false);
            const dryParsed = JSON.parse(dry.content[0].text);
            expect(dryParsed.ok).toBe(true);
            expect(dryParsed.dryRun).toBe(true);
            expect(dryParsed.writtenFiles).toEqual([]);
            expect(dryParsed.files).toContain('greet.ts');

            // Seed a stale Slate-generated file to test pruning
            await fs.mkdir(path.join(tmpDir, 'built-ts'), { recursive: true });
            await fs.writeFile(
                path.join(tmpDir, 'built-ts', 'obsolete.ts'),
                '// Generated by Slate — do not edit by hand.\nexport const old = 1;\n',
                'utf8',
            );

            const compiled = await server.callTool('slate_compile', {});
            expect(compiled.isError).toBe(false);
            const compiledParsed = JSON.parse(compiled.content[0].text);
            expect(compiledParsed.ok).toBe(true);
            expect(compiledParsed.writtenFiles).toContain('greet.ts');
            expect(compiledParsed.removedFiles).toContain('obsolete.ts');

            const emitted = await fs.readFile(path.join(tmpDir, 'built-ts', 'greet.ts'), 'utf8');
            expect(emitted).toContain('// Generated by Slate');
            expect(emitted).toContain('export function greet(name: string): string');

            // Create a non-generated user file colliding with output path and confirm refusal
            await fs.writeFile(path.join(tmpDir, 'built-ts', 'greet.ts'), '// Hand-written file\nexport const lock = true;\n', 'utf8');
            const collision = await server.callTool('slate_compile', {});
            expect(collision.isError).toBe(false);
            const collisionParsed = JSON.parse(collision.content[0].text);
            expect(collisionParsed.ok).toBe(false);
            expect(collisionParsed.diagnostics.some((d: any) => d.message.includes('Refusing to overwrite'))).toBe(true);
            const preserved = await fs.readFile(path.join(tmpDir, 'built-ts', 'greet.ts'), 'utf8');
            expect(preserved).toContain('// Hand-written file');

            // Regression (#2): dot-segment modulePath `sub/../victim.ts` must NOT bypass existing-file overwrite check,
            // and parent traversal `../../victim.ts` must NOT write outside outDir.
            await fs.writeFile(path.join(tmpDir, 'built-ts', 'victim.ts'), '// Hand-written victim\nexport const keep = 1;\n', 'utf8');
            await fs.rm(path.join(tmpDir, 'slate', 'nodes', 'greet.json'), { force: true });
            await fs.writeFile(
                path.join(tmpDir, 'slate', 'nodes', 'dotdot_inside.json'),
                JSON.stringify({
                    slate: 3,
                    name: 'dotdot_inside',
                    language: 'typescript',
                    intent: 'Attempt raw-key bypass via sub/../victim.ts',
                    contract: '',
                    modulePath: 'sub/../victim.ts',
                    extension: '.ts',
                    code: ['export function dotdot_inside(): number {', '    return 1;', '}'],
                }, null, 2),
                'utf8',
            );
            const rawKeyBypass = await server.callTool('slate_compile', {});
            expect(rawKeyBypass.isError).toBe(false);
            const rawBypassParsed = JSON.parse(rawKeyBypass.content[0].text);
            expect(rawBypassParsed.ok).toBe(false);
            expect(rawBypassParsed.diagnostics.some((d: any) => d.message.includes('Refusing to overwrite'))).toBe(true);
            expect(await fs.readFile(path.join(tmpDir, 'built-ts', 'victim.ts'), 'utf8')).toContain('// Hand-written victim');

            await fs.rm(path.join(tmpDir, 'slate', 'nodes', 'dotdot_inside.json'), { force: true });
            await fs.writeFile(
                path.join(tmpDir, 'slate', 'nodes', 'escape_outside.json'),
                JSON.stringify({
                    slate: 3,
                    name: 'escape_outside',
                    language: 'typescript',
                    intent: 'Attempt escape via ../../outside.ts',
                    contract: '',
                    modulePath: '../../outside.ts',
                    extension: '.ts',
                    code: ['export function escape_outside(): number {', '    return 1;', '}'],
                }, null, 2),
                'utf8',
            );
            const escapeAttempt = await server.callTool('slate_compile', {});
            expect(escapeAttempt.isError).toBe(false);
            const escapeParsed = JSON.parse(escapeAttempt.content[0].text);
            expect(escapeParsed.ok).toBe(false);
            expect(escapeParsed.diagnostics.some((d: any) => /unsafe/i.test(String(d.message)))).toBe(true);
            await expect(fs.stat(path.join(tmpDir, 'outside.ts'))).rejects.toThrow();
        });
    });

    describe('MCP security hardening and stub updates (P0-5, P0-6, P0-8, P0-9)', () => {
        it('fails closed when SlateMcpServer workspace trust is omitted (P0-5)', async () => {
            const untrustedServer = new SlateMcpServer(tmpDir);
            try {
                for (const [tool, args] of [
                    ['slate_llm_status', { endpoint: 'https://api.example/v1' }],
                    ['slate_forge_batch', { allStubs: true }],
                    ['slate_configure_llm', { endpoint: 'https://api.example/v1' }],
                ] as const) {
                    const res = await untrustedServer.callTool(tool, args as Record<string, unknown>);
                    expect(res.isError, tool).toBe(true);
                    expect(res.content[0].text, tool).toContain('Workspace is not trusted');
                }
            } finally {
                untrustedServer.close();
            }
        });

        it('rejects smuggled TS/Prose imports and executable cases while preserving valid pytest.raises cases (P0-6)', async () => {
            // Forbidden TS internal import
            const tsInternal = await server.callTool('slate_define_stub', {
                name: 'ts_bad_imp',
                language: 'typescript',
                signature: 'export function ts_bad_imp(x: number): number',
                intent: 'bad',
                imports: ["import { calc } from 'slate/nodes/calc';"],
            });
            expect(tsInternal.isError).toBe(true);
            expect(tsInternal.content[0].text).toContain('Forbidden internal import');

            // Prose imports forbidden
            const proseImp = await server.callTool('slate_define_stub', {
                name: 'prose_bad_imp',
                language: 'prose',
                signature: 'def prose_bad_imp(topic: section) -> passage',
                intent: 'bad prose',
                imports: ['import math'],
            });
            expect(proseImp.isError).toBe(true);
            expect(proseImp.content[0].text).toContain('cannot declare code imports');

            // Python case smuggling: def / non-pytest import / eval
            for (const badCase of [
                { code: 'def evil():\n    pass' },
                { code: 'import os\nassert calc(1) == 2' },
                { code: 'assert eval("1 + 1") == 2' },
                '1 == 1\nimport os',
            ]) {
                const res = await server.callTool('slate_define_stub', {
                    name: 'py_bad_case',
                    signature: 'def py_bad_case(x: int) -> int',
                    intent: 'bad case',
                    cases: [badCase],
                });
                expect(res.isError).toBe(true);
            }

            // Valid sudoku-style import pytest + with pytest.raises(...) must still pass
            const validPytest = await server.callTool('slate_define_stub', {
                name: 'py_good_case',
                signature: 'def py_good_case(x: int) -> int',
                intent: 'valid pytest case',
                cases: [
                    { code: 'import pytest\nwith pytest.raises(ValueError):\n    py_good_case(-1)' },
                ],
            });
            expect(validPytest.isError).toBe(false);

            // TS case smuggling: eval / require / function
            for (const badTsCase of [
                { code: 'eval("1 + 1");' },
                { code: 'const fsMod = require("fs");' },
                { code: 'function evil() { return 1; }' },
            ]) {
                const res = await server.callTool('slate_define_stub', {
                    name: 'ts_bad_case',
                    language: 'typescript',
                    signature: 'export function ts_bad_case(x: number): number',
                    intent: 'bad ts case',
                    cases: [badTsCase],
                });
                expect(res.isError).toBe(true);
            }
        });

        it('rejects case-insensitive reserved outDirs, symlinked outDir escapes, and case collisions on compile (P0-8)', async () => {
            for (const reserved of ['SLATE', 'SlAtE/nodes', '.GIT', '.VSCODE/out']) {
                const res = await server.callTool('slate_compile', { outDir: reserved });
                expect(res.isError, reserved).toBe(true);
                expect(res.content[0].text, reserved).toMatch(/Unsafe compile output directory/i);
            }

            // Symlinked outDir escaping workspace must fail closed when symlink creation is permitted
            const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-symlink-outside-'));
            const linkPath = path.join(tmpDir, 'sym_out');
            let createdSymlink = false;
            try {
                await fs.symlink(outsideDir, linkPath, 'dir');
                createdSymlink = true;
            } catch {
                // Windows without Developer Mode / admin privileges cannot create symlinks; skip safely.
            }
            try {
                if (createdSymlink) {
                    const symRes = await server.callTool('slate_compile', { outDir: 'sym_out' });
                    expect(symRes.isError).toBe(true);
                    expect(symRes.content[0].text).toMatch(/Path traversal rejected|Unsafe compile/i);
                }
            } finally {
                await fs.rm(outsideDir, { recursive: true, force: true });
            }

            if (process.platform === 'win32' || process.platform === 'darwin') {
                await fs.rm(path.join(tmpDir, 'slate', 'nodes', 'calc.json'), { force: true });
                await fs.writeFile(
                    path.join(tmpDir, 'slate', 'slate.json'),
                    JSON.stringify({ slate: 3, name: 'case_col', language: 'typescript', compile: { outDir: 'built-case' } }, null, 2),
                    'utf8',
                );
                await fs.writeFile(
                    path.join(tmpDir, 'slate', 'nodes', 'upper.json'),
                    JSON.stringify({
                        slate: 3, name: 'upper', language: 'typescript', intent: 'upper',
                        modulePath: 'Dup.ts', extension: '.ts', code: ['export function upper(): number { return 1; }'],
                    }, null, 2),
                    'utf8',
                );
                await fs.writeFile(
                    path.join(tmpDir, 'slate', 'nodes', 'lower.json'),
                    JSON.stringify({
                        slate: 3, name: 'lower', language: 'typescript', intent: 'lower',
                        modulePath: 'dup.ts', extension: '.ts', code: ['export function lower(): number { return 2; }'],
                    }, null, 2),
                    'utf8',
                );
                const colRes = await server.callTool('slate_compile', {});
                expect(colRes.isError).toBe(false);
                const colParsed = JSON.parse(colRes.content[0].text);
                expect(colParsed.ok).toBe(false);
                expect(colParsed.diagnostics.some((d: { message: string }) => d.message.includes('Refusing case-colliding output destination'))).toBe(true);
            }
        });

        it('preserves omitted metadata fields and marks verification stale on existing stub updates (P0-9)', async () => {
            await fs.writeFile(
                path.join(tmpDir, 'slate', 'nodes', 'existing_stub.json'),
                JSON.stringify({
                    slate: 3,
                    name: 'existing_stub',
                    language: 'typescript',
                    intent: 'Original intent',
                    contract: 'Original contract',
                    context: ['calc'],
                    cases: [{ id: 'c1', inputs: { x: 2 }, expected: 4 }],
                    check: ["test('ok', () => { expect(existing_stub(2)).toBe(4); });"],
                    examples: ['existing_stub(2) -> 4'],
                    describedBy: 'llama',
                    order: 7,
                    imports: ['import type { Foo } from "./foo"'],
                    uses: ['calc'],
                    locked: false,
                    extension: '.tsx',
                    verification: {
                        nodeId: 'existing_stub',
                        state: 'passed',
                        timestamp: 12345,
                        sourceHash: 'abc',
                    },
                    code: [
                        'export function existing_stub(x: number): number {',
                        '    throw new Error("Not implemented");',
                        '}',
                    ],
                }, null, 2),
                'utf8',
            );

            // Update ONLY intent + signature parameter name (omit language, contract, context, cases, imports, extension)
            const upd = await server.callTool('slate_define_stub', {
                name: 'existing_stub',
                signature: 'export function existing_stub(value: number): number',
                intent: 'Updated intent',
            });
            expect(upd.isError).toBe(false);

            const after = JSON.parse(await fs.readFile(path.join(tmpDir, 'slate', 'nodes', 'existing_stub.json'), 'utf8'));
            expect(after.language).toBe('typescript');
            expect(after.contract).toBe('Original contract');
            expect(after.context).toEqual(['calc']);
            expect(after.cases).toEqual([{ id: 'c1', inputs: { x: 2 }, expected: 4 }]);
            expect(after.imports).toEqual(['import type { Foo } from "./foo"']);
            expect(after.extension).toBe('.tsx');
            expect(after.order).toBe(7);
            expect(after.check).toEqual(["test('ok', () => { expect(existing_stub(2)).toBe(4); });"]);
            expect(after.examples).toEqual(['existing_stub(2) -> 4']);
            expect(after.uses).toEqual(['calc']);
            expect(after.describedBy).toBe('llama');
            expect(after.verification.state).toBe('stale');
        });
    });
});
