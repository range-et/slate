import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import * as readline from 'readline';
import { randomUUID } from 'crypto';
import { parser } from '@lezer/python';
import type { SyntaxNode } from '@lezer/common';

import {
    connect, disconnect, emptyFlow, flowIdForPath, MAIN_FLOW,
    parseEndpoint, pathForFlowId, removeInstances, serializeFlow, parseFlow
} from '../flow';
import {
    codeLines, CONFIG_PATH, emptyLayout, LAYOUT_PATH, NODES_DIR,
    nodeFromSignature, nodeIdForPath, parseLayout, parseNode,
    pathForNodeId, serializeLayout, serializeNode,
    type SlateLayout, type SlateNode
} from '../slate_folder';
import type { BoardNote, FlowInstance, FlowWire, SlateFlow } from '../harness_protocol';

export interface SlateMcpBridge {
    focusCamera?(options: {
        target?: string;
        region?: { x: number; y: number; width?: number; height?: number };
        zoom?: number;
        duration?: number;
    }): Promise<boolean>;
    onStubDefined?(nodeId: string): Promise<void>;
    onFlowWired?(flowId: string): Promise<void>;
    onNotesPlaced?(): Promise<void>;
}

export interface StubValidationResult {
    valid: boolean;
    reason?: string;
}

/**
 * Validates that an atomic stub contains ONLY permitted stub constructs:
 * `pass`, `...`, `raise NotImplementedError`, docstrings, comments, whitespace.
 * Strictly refuses any arbitrary implementation statements (returns, math, loops, assignments).
 */
export function validateStubBody(signature: string, bodyText: string): StubValidationResult {
    const cleanSig = signature.trim().replace(/:$/, '');
    const cleanLines = bodyText.replace(/\r\n/g, '\n').split('\n');
    const indentedBody = cleanLines.map(l => l.startsWith('    ') ? l : `    ${l}`).join('\n');
    const fullCode = `${cleanSig}:\n${indentedBody}\n`;

    const tree = parser.parse(fullCode);

    let funcNode: SyntaxNode | null = null;
    for (let cur = tree.topNode.firstChild; cur; cur = cur.nextSibling) {
        if (cur.name === 'FunctionDefinition') {
            funcNode = cur;
            break;
        }
    }
    if (!funcNode) {
        return { valid: false, reason: 'No valid function definition found.' };
    }

    let bodyNode: SyntaxNode | null = null;
    for (let cur = funcNode.firstChild; cur; cur = cur.nextSibling) {
        if (cur.name === 'Body') {
            bodyNode = cur;
            break;
        }
    }
    if (!bodyNode) {
        return { valid: false, reason: 'No function body found.' };
    }

    let hasStubStatement = false;
    for (let stmt = bodyNode.firstChild; stmt; stmt = stmt.nextSibling) {
        if (stmt.name === ':' || stmt.name === 'Comment') continue;
        if (stmt.name === 'PassStatement') {
            hasStubStatement = true;
            continue;
        }
        if (stmt.name === 'ExpressionStatement') {
            const inner = stmt.firstChild;
            if (inner && inner.name === 'String') {
                // Docstring allowed
                continue;
            }
            if (inner && inner.name === 'Ellipsis') {
                hasStubStatement = true;
                continue;
            }
            return {
                valid: false,
                reason: `Arbitrary expression in function body is refused: "${fullCode.slice(stmt.from, stmt.to).trim()}". Only stubs (pass, ..., raise NotImplementedError) are permitted.`,
            };
        }
        if (stmt.name === 'RaiseStatement') {
            const raisedText = fullCode.slice(stmt.from, stmt.to).trim();
            let exprNode: SyntaxNode | null = null;
            for (let c = stmt.firstChild; c; c = c.nextSibling) {
                if (c.name === 'raise' || c.name === 'Comment') continue;
                exprNode = c;
                break;
            }
            if (!exprNode) {
                return {
                    valid: false,
                    reason: 'Bare "raise" statement without exception is not a valid stub.',
                };
            }

            // Case 1: raise NotImplementedError
            if (exprNode.name === 'VariableName') {
                const nameText = fullCode.slice(exprNode.from, exprNode.to).trim();
                if (nameText === 'NotImplementedError') {
                    hasStubStatement = true;
                    continue;
                }
                return {
                    valid: false,
                    reason: `Only NotImplementedError may be raised in an atomic stub (found: "${nameText}").`,
                };
            }

            // Case 2: raise NotImplementedError(...)
            if (exprNode.name === 'CallExpression') {
                const callee = exprNode.firstChild;
                if (!callee || fullCode.slice(callee.from, callee.to).trim() !== 'NotImplementedError') {
                    return {
                        valid: false,
                        reason: `Only NotImplementedError may be raised in an atomic stub (found: "${raisedText}").`,
                    };
                }
                // Check arguments inside ArgList
                const argList = callee.nextSibling;
                if (argList && argList.name === 'ArgList') {
                    let argCount = 0;
                    let invalidArg = false;
                    for (let arg = argList.firstChild; arg; arg = arg.nextSibling) {
                        if (arg.name === '(' || arg.name === ')' || arg.name === ',' || arg.name === 'Comment') continue;
                        argCount++;
                        // Argument MUST be an optional literal String only!
                        if (arg.name !== 'String') {
                            invalidArg = true;
                            break;
                        }
                    }
                    if (invalidArg || argCount > 1) {
                        return {
                            valid: false,
                            reason: `NotImplementedError argument must be an optional literal string message; arbitrary expressions or calls are refused in stubs (found: "${raisedText}").`,
                        };
                    }
                }
                hasStubStatement = true;
                continue;
            }

            return {
                valid: false,
                reason: `Only NotImplementedError (or NotImplementedError("message")) may be raised in an atomic stub (found: "${raisedText}").`,
            };
        }
        return {
            valid: false,
            reason: `Arbitrary function body implementations are strictly refused. Frontier Architect only authors atomic stubs (pass, ..., or raise NotImplementedError). Statement: ${stmt.name} ("${fullCode.slice(stmt.from, stmt.to).trim()}"). Body implementations must be forged by the Tier 2 local model.`,
        };
    }

    if (!hasStubStatement) {
        return {
            valid: false,
            reason: 'Function body must contain an atomic stub statement (pass, ..., or raise NotImplementedError).',
        };
    }

    return { valid: true };
}

export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: number | string | null;
    method: string;
    params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
    jsonrpc: '2.0';
    id: number | string | null;
    result: unknown;
}

export interface JsonRpcErrorResponse {
    jsonrpc: '2.0';
    id: number | string | null;
    error: {
        code: number;
        message: string;
        data?: unknown;
    };
}

export interface McpToolCallResult {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}

export const MCP_TOOLS = [
    {
        name: 'slate_find',
        description: 'Search nodes, flows, and spatial notes by query, signature, or folder scope in the active Slate project.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search query to match against node names, signatures, intents, contracts, notes, and flow instances.',
                },
                scope: {
                    type: 'string',
                    description: 'Optional filter: "all" (default), "nodes", "flows", "notes", or a folder path prefix.',
                },
                signature: {
                    type: 'string',
                    description: 'Optional filter matching parameter or return type annotations.',
                },
            },
        },
    },
    {
        name: 'slate_focus',
        description: 'Pan and zoom the live Slate XYFlow canvas camera to center on a target node, note, flow, or bounding region in real time.',
        inputSchema: {
            type: 'object',
            properties: {
                target: {
                    type: 'string',
                    description: 'ID or name of the target node, note, or flow instance to focus on.',
                },
                region: {
                    type: 'object',
                    description: 'Optional bounding box region to center: { x, y, width, height } or center point { x, y }.',
                    properties: {
                        x: { type: 'number' },
                        y: { type: 'number' },
                        width: { type: 'number' },
                        height: { type: 'number' },
                    },
                    required: ['x', 'y'],
                },
                zoom: {
                    type: 'number',
                    description: 'Target zoom level (e.g. 1.0 or 1.2).',
                },
                duration: {
                    type: 'number',
                    description: 'Smooth transition animation duration in milliseconds (default 300).',
                },
            },
        },
    },
    {
        name: 'slate_place_notes',
        description: 'Create or update spatial design notes on the Slate canvas (saved to layout.json).',
        inputSchema: {
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                    description: 'Optional note ID. If provided and note exists, updates it; otherwise creates a new note.',
                },
                title: {
                    type: 'string',
                    description: 'Note title.',
                },
                body: {
                    type: 'string',
                    description: 'Note markdown or text body.',
                },
                attachedTo: {
                    type: 'string',
                    description: 'Optional node or unit ID to attach this note to.',
                },
                position: {
                    type: 'object',
                    properties: {
                        x: { type: 'number' },
                        y: { type: 'number' },
                    },
                    required: ['x', 'y'],
                    description: 'Canvas position for the note.',
                },
                notes: {
                    type: 'array',
                    description: 'Batch of notes to create/update.',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            title: { type: 'string' },
                            body: { type: 'string' },
                            attachedTo: { type: 'string' },
                            position: {
                                type: 'object',
                                properties: { x: { type: 'number' }, y: { type: 'number' } },
                                required: ['x', 'y'],
                            },
                        },
                        required: ['title', 'body'],
                    },
                },
            },
        },
    },
    {
        name: 'slate_define_stub',
        description: 'Define typed atomic stubs (name, signature, intent, contract, cases) in slate/nodes/**/*.json. Strictly refuses arbitrary body implementations (only pass, ..., or raise NotImplementedError stubs permitted) and supports splitting oversized (>60-line) nodes into smaller atomic stubs.',
        inputSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Node name / identifier (e.g. "clamp" or "math/clamp").',
                },
                signature: {
                    type: 'string',
                    description: 'Typed Python function signature (e.g. "def clamp(value: int, lower: int, upper: int) -> int").',
                },
                intent: {
                    type: 'string',
                    description: 'High-level intent describing what the atomic node must do.',
                },
                contract: {
                    type: 'string',
                    description: 'Optional contract (preconditions, postconditions, invariants).',
                },
                context: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional list of node dependency IDs.',
                },
                cases: {
                    type: 'array',
                    description: 'Optional structured test cases.',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            input: { type: 'object' },
                            expected: {},
                        },
                        required: ['name', 'input'],
                    },
                },
                body: {
                    type: 'string',
                    description: 'Optional stub body (MUST only be "pass", "...", or "raise NotImplementedError(...)"). Non-stub implementation code is strictly rejected.',
                },
                position: {
                    type: 'object',
                    properties: { x: { type: 'number' }, y: { type: 'number' } },
                    required: ['x', 'y'],
                    description: 'Canvas position.',
                },
                splitFrom: {
                    type: 'string',
                    description: 'Optional ID of an existing node being split/decomposed into this stub.',
                },
                stubs: {
                    type: 'array',
                    description: 'Batch of stubs when decomposing an oversized node into multiple smaller stubs.',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            signature: { type: 'string' },
                            intent: { type: 'string' },
                            contract: { type: 'string' },
                            context: { type: 'array', items: { type: 'string' } },
                            cases: { type: 'array' },
                            body: { type: 'string' },
                            position: {
                                type: 'object',
                                properties: { x: { type: 'number' }, y: { type: 'number' } },
                            },
                        },
                        required: ['name', 'signature', 'intent'],
                    },
                },
            },
        },
    },
    {
        name: 'slate_wire_flow',
        description: 'Connect typed dataflow wires deterministically via flow.ts and layout.json.',
        inputSchema: {
            type: 'object',
            properties: {
                flow: {
                    type: 'string',
                    description: 'Flow ID to wire (defaults to "main").',
                },
                instances: {
                    type: 'array',
                    description: 'Optional instances to add/ensure in the flow.',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            node: { type: 'string' },
                            kind: { type: 'string', enum: ['value'] },
                            value: { type: 'string' },
                            position: {
                                type: 'object',
                                properties: { x: { type: 'number' }, y: { type: 'number' } },
                            },
                        },
                        required: ['id'],
                    },
                },
                wires: {
                    type: 'array',
                    description: 'Wires to add to the flow.',
                    items: {
                        type: 'object',
                        properties: {
                            from: { type: 'string' },
                            to: { type: 'string' },
                        },
                        required: ['from', 'to'],
                    },
                },
                disconnect: {
                    type: 'array',
                    description: 'Wires to disconnect.',
                    items: {
                        type: 'object',
                        properties: {
                            from: { type: 'string' },
                            to: { type: 'string' },
                        },
                        required: ['from', 'to'],
                    },
                },
                removeInstances: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Instance IDs to remove from the flow.',
                },
            },
        },
    },
];

export class SlateMcpServer {
    private rl?: readline.Interface;
    private bridge?: SlateMcpBridge;
    private mutationQueue: Promise<unknown> = Promise.resolve();
    private streamQueue: Promise<void> = Promise.resolve();

    constructor(
        public readonly workspaceRoot: string,
        bridge?: SlateMcpBridge
    ) {
        this.bridge = bridge;
    }

    private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.mutationQueue.then(operation, operation);
        this.mutationQueue = next.then(() => {}, () => {});
        return next;
    }

    setBridge(bridge: SlateMcpBridge | undefined): void {
        this.bridge = bridge;
    }

    private absPath(rel: string): string {
        const resolved = path.resolve(this.workspaceRoot, rel);
        const relFromRoot = path.relative(this.workspaceRoot, resolved);
        if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) {
            throw new Error(`Path traversal rejected: "${rel}" escapes workspace root.`);
        }
        return resolved;
    }

    private assertSafePath(targetRelOrAbs: string, allowedParentDir: string): string {
        const resolvedAllowed = path.resolve(this.workspaceRoot, allowedParentDir);
        const resolved = path.resolve(this.workspaceRoot, targetRelOrAbs);
        const rel = path.relative(resolvedAllowed, resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`Path traversal rejected: "${targetRelOrAbs}" escapes allowed directory "${allowedParentDir}".`);
        }
        return resolved;
    }

    private async readJsonFile<T>(rel: string): Promise<T | null> {
        try {
            const raw = await fs.readFile(this.absPath(rel), 'utf8');
            return JSON.parse(raw) as T;
        } catch {
            return null;
        }
    }

    private async writeJsonFile(rel: string, content: string): Promise<void> {
        const full = this.absPath(rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content, 'utf8');
    }

    private async readLayout(): Promise<SlateLayout> {
        try {
            const text = await fs.readFile(this.absPath(LAYOUT_PATH), 'utf8');
            return parseLayout(text);
        } catch {
            return emptyLayout();
        }
    }

    private async writeLayout(layout: SlateLayout): Promise<void> {
        await this.writeJsonFile(LAYOUT_PATH, serializeLayout(layout));
    }

    /** Find all node files under slate/nodes/ recursively */
    private async findNodeFiles(): Promise<string[]> {
        const nodesDir = this.absPath(NODES_DIR);
        const results: string[] = [];
        const scan = async (dir: string) => {
            let entries: string[];
            try {
                entries = await fs.readdir(dir);
            } catch {
                return;
            }
            for (const entry of entries) {
                const full = path.join(dir, entry);
                try {
                    const stat = await fs.stat(full);
                    if (stat.isDirectory()) {
                        await scan(full);
                    } else if (stat.isFile() && entry.endsWith('.json')) {
                        const rel = path.relative(this.workspaceRoot, full).replace(/\\/g, '/');
                        results.push(rel);
                    }
                } catch {
                    // Ignore stat errors
                }
            }
        };
        await scan(nodesDir);
        return results.sort();
    }

    /** Find all flow files under slate/flows/ recursively */
    private async findFlowFiles(): Promise<string[]> {
        const flowsDir = this.absPath('slate/flows');
        const results: string[] = [];
        const scan = async (dir: string) => {
            let entries: string[];
            try {
                entries = await fs.readdir(dir);
            } catch {
                return;
            }
            for (const entry of entries) {
                const full = path.join(dir, entry);
                try {
                    const stat = await fs.stat(full);
                    if (stat.isDirectory()) {
                        await scan(full);
                    } else if (stat.isFile() && entry.endsWith('.json')) {
                        const rel = path.relative(this.workspaceRoot, full).replace(/\\/g, '/');
                        results.push(rel);
                    }
                } catch {
                    // Ignore stat errors
                }
            }
        };
        await scan(flowsDir);
        return results.sort();
    }

    /** Tool: slate_find */
    async toolFind(args: { query?: string; scope?: string; signature?: string }): Promise<Record<string, unknown>> {
        const q = (args.query ?? '').toLowerCase().trim();
        const scope = (args.scope ?? 'all').toLowerCase().trim();
        const sigFilter = (args.signature ?? '').toLowerCase().trim();

        const matchNodes = scope === 'all' || scope === 'nodes' || (!['flows', 'notes'].includes(scope) && scope.length > 0);
        const matchFlows = scope === 'all' || scope === 'flows';
        const matchNotes = scope === 'all' || scope === 'notes';

        const nodes: Array<Record<string, unknown>> = [];
        if (matchNodes) {
            const files = await this.findNodeFiles();
            for (const file of files) {
                const id = nodeIdForPath(file);
                if (!id) continue;
                if (scope !== 'all' && scope !== 'nodes' && !id.startsWith(scope)) continue;
                try {
                    const text = await fs.readFile(this.absPath(file), 'utf8');
                    const node = parseNode(text);
                    const code = node.code.join('\n');
                    const sig = node.code[0] ?? '';

                    let matched = !q;
                    if (q) {
                        matched = id.toLowerCase().includes(q)
                            || node.name.toLowerCase().includes(q)
                            || node.intent.toLowerCase().includes(q)
                            || node.contract.toLowerCase().includes(q)
                            || code.toLowerCase().includes(q)
                            || (node.uses ?? []).some(u => u.toLowerCase().includes(q))
                            || (node.imports ?? []).some(i => i.toLowerCase().includes(q));
                    }
                    if (matched && sigFilter) {
                        matched = sig.toLowerCase().includes(sigFilter);
                    }
                    if (matched) {
                        nodes.push({
                            id,
                            name: node.name,
                            path: file,
                            signature: sig.replace(/:$/, ''),
                            intent: node.intent,
                            contract: node.contract,
                            locked: node.locked,
                        });
                    }
                } catch {
                    // skip unreadable
                }
            }
        }

        const flows: Array<Record<string, unknown>> = [];
        if (matchFlows) {
            const flowFiles = await this.findFlowFiles();
            for (const file of flowFiles) {
                const id = flowIdForPath(file);
                if (!id) continue;
                try {
                    const text = await fs.readFile(this.absPath(file), 'utf8');
                    const flow = parseFlow(text);
                    let matched = !q;
                    if (q) {
                        matched = id.toLowerCase().includes(q)
                            || flow.name.toLowerCase().includes(q)
                            || flow.instances.some(inst => inst.id.toLowerCase().includes(q) || (inst.node && inst.node.toLowerCase().includes(q)))
                            || flow.wires.some(w => w.from.toLowerCase().includes(q) || w.to.toLowerCase().includes(q));
                    }
                    if (matched) {
                        flows.push({
                            id,
                            name: flow.name,
                            path: file,
                            inputs: flow.inputs.map(i => i.name),
                            outputs: flow.outputs.map(o => o.name),
                            instanceCount: flow.instances.length,
                            wireCount: flow.wires.length,
                        });
                    }
                } catch {
                    // skip unreadable
                }
            }
        }

        const notes: Array<Record<string, unknown>> = [];
        if (matchNotes) {
            const layout = await this.readLayout();
            for (const note of layout.notes) {
                let matched = !q;
                if (q) {
                    matched = note.id.toLowerCase().includes(q)
                        || note.title.toLowerCase().includes(q)
                        || note.body.toLowerCase().includes(q)
                        || (Boolean(note.attachedTo) && note.attachedTo!.toLowerCase().includes(q));
                }
                if (matched) {
                    notes.push({
                        id: note.id,
                        title: note.title,
                        body: note.body,
                        attachedTo: note.attachedTo,
                        position: layout.positions[note.id] ?? null,
                    });
                }
            }
        }

        return {
            ok: true,
            nodes,
            flows,
            notes,
        };
    }

    /** Tool: slate_focus */
    async toolFocus(args: {
        target?: string;
        region?: { x: number; y: number; width?: number; height?: number };
        zoom?: number;
        duration?: number;
    }): Promise<Record<string, unknown>> {
        const { target, region, zoom, duration } = args;

        // 1. Direct in-process bridge
        if (this.bridge?.focusCamera) {
            const sent = await this.bridge.focusCamera({ target, region, zoom, duration });
            return {
                ok: true,
                focused: target ?? (region ? 'region' : 'canvas'),
                liveWebview: sent,
            };
        }

        // 2. Check for live bridge file written by active HarnessPanel
        const bridgeFile = this.absPath('.slate/live_bridge.json');
        try {
            const data = JSON.parse(await fs.readFile(bridgeFile, 'utf8')) as { port: number };
            if (data?.port) {
                const posted = await new Promise<boolean>(resolve => {
                    const req = http.request({
                        hostname: '127.0.0.1',
                        port: data.port,
                        path: '/focus',
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 1000,
                    }, res => {
                        resolve(res.statusCode === 200);
                    });
                    req.on('error', () => resolve(false));
                    req.on('timeout', () => { req.destroy(); resolve(false); });
                    req.write(JSON.stringify({ target, region, zoom, duration }));
                    req.end();
                });
                if (posted) {
                    return {
                        ok: true,
                        focused: target ?? (region ? 'region' : 'canvas'),
                        liveWebview: true,
                    };
                }
            }
        } catch {
            // Live bridge not active
        }

        // 3. Headless fallback
        return {
            ok: true,
            focused: target ?? (region ? 'region' : 'canvas'),
            liveWebview: false,
            message: 'Camera focus intent recorded (headless mode; no live webview connected).',
        };
    }

    /** Tool: slate_place_notes */
    async toolPlaceNotes(args: {
        id?: string;
        title?: string;
        body?: string;
        attachedTo?: string | null;
        position?: { x: number; y: number };
        notes?: Array<{
            id?: string;
            title: string;
            body: string;
            attachedTo?: string | null;
            position?: { x: number; y: number };
        }>;
    }): Promise<Record<string, unknown>> {
        const layout = await this.readLayout();
        const incoming = args.notes && args.notes.length > 0
            ? args.notes
            : (args.title ? [{
                id: args.id,
                title: args.title,
                body: args.body ?? '',
                attachedTo: args.attachedTo ?? null,
                position: args.position,
            }] : []);

        if (incoming.length === 0) {
            throw new Error('Must provide at least one note with title and body.');
        }

        const updatedNotes: BoardNote[] = [];
        for (const item of incoming) {
            const title = (item.title ?? '').trim();
            if (!title) throw new Error('Note title cannot be empty.');
            const noteBody = item.body ?? '';
            const attachedTo = item.attachedTo ?? null;

            let existingIndex = item.id ? layout.notes.findIndex(n => n.id === item.id) : -1;
            let noteId = item.id;
            if (existingIndex >= 0 && noteId) {
                layout.notes[existingIndex] = { id: noteId, title, body: noteBody, attachedTo };
                updatedNotes.push(layout.notes[existingIndex]);
            } else {
                noteId = noteId || `note-${randomUUID().slice(0, 8)}`;
                const newNote: BoardNote = { id: noteId, title, body: noteBody, attachedTo };
                layout.notes.push(newNote);
                updatedNotes.push(newNote);
            }

            if (item.position && Number.isFinite(item.position.x) && Number.isFinite(item.position.y)) {
                layout.positions[noteId] = { x: item.position.x, y: item.position.y };
            }
        }

        await this.writeLayout(layout);
        if (this.bridge?.onNotesPlaced) await this.bridge.onNotesPlaced();

        return {
            ok: true,
            notes: updatedNotes,
        };
    }

    /** Tool: slate_define_stub */
    async toolDefineStub(args: {
        name?: string;
        signature?: string;
        intent?: string;
        contract?: string;
        context?: string[];
        cases?: Array<{ name: string; input: Record<string, unknown>; expected?: unknown }>;
        body?: string;
        position?: { x: number; y: number };
        splitFrom?: string;
        stubs?: Array<{
            name: string;
            signature: string;
            intent: string;
            contract?: string;
            context?: string[];
            cases?: Array<{ name: string; input: Record<string, unknown>; expected?: unknown }>;
            body?: string;
            position?: { x: number; y: number };
        }>;
    }): Promise<Record<string, unknown>> {
        const stubList = args.stubs && args.stubs.length > 0
            ? args.stubs
            : (args.name && args.signature && args.intent ? [{
                name: args.name,
                signature: args.signature,
                intent: args.intent,
                contract: args.contract,
                context: args.context,
                cases: args.cases,
                body: args.body,
                position: args.position,
            }] : []);

        if (stubList.length === 0) {
            throw new Error('Must provide name, signature, and intent for the stub, or a list of stubs.');
        }

        const layout = await this.readLayout();
        const createdIds: string[] = [];

        for (const item of stubList) {
            const name = item.name.trim();
            if (!name) throw new Error('Stub "name" is required.');
            const nodeId = name;
            const nodeRelPath = pathForNodeId(nodeId);
            this.assertSafePath(nodeRelPath, NODES_DIR);

            // Check if node already exists
            const existingNode = await this.readJsonFile<SlateNode>(nodeRelPath);
            if (existingNode) {
                if (existingNode.locked) {
                    throw new Error(`Node "${nodeId}" is locked and cannot be modified.`);
                }
                const existingBody = existingNode.code.slice(1).join('\n');
                const existingSig = existingNode.code[0] ?? '';
                const existingValidation = validateStubBody(existingSig, existingBody);
                if (!existingValidation.valid) {
                    throw new Error(
                        `Node "${nodeId}" already has an active implementation and cannot be overwritten with a stub. ` +
                        `Frontier Architect only authors stubs for unimplemented nodes. Existing implementation: ${existingValidation.reason}`
                    );
                }
            }

            const signature = item.signature.trim();
            const intent = item.intent.trim();
            const contract = (item.contract ?? '').trim();
            const context = item.context ?? [];
            const cases = item.cases ?? [];
            const stubBody = (item.body ?? 'raise NotImplementedError').trim();

            // Validate that the signature creates a valid node header
            const initialNode = nodeFromSignature(signature, intent);
            if (initialNode.name !== name && name.split('/').pop() !== initialNode.name) {
                throw new Error(`Signature function name "${initialNode.name}" does not match provided name "${name}".`);
            }

            // Strictly validate that body is an allowed stub (zero arbitrary function bodies allowed)
            const validation = validateStubBody(signature, stubBody);
            if (!validation.valid) {
                throw new Error(validation.reason);
            }

            // Build node code
            const header = signature.replace(/:$/, '');
            const bodyLines = stubBody.split('\n').map(l => l.startsWith('    ') ? l : `    ${l}`);
            const code = [`${header}:`, ...bodyLines];

            const node: SlateNode = {
                name: initialNode.name,
                intent,
                contract,
                context,
                cases,
                examples: existingNode?.examples ?? [],
                describedBy: existingNode?.describedBy ?? 'human',
                locked: false,
                imports: existingNode?.imports ?? [],
                uses: existingNode?.uses ?? [],
                code,
                extra: existingNode?.extra ?? {},
            };

            await this.writeJsonFile(nodeRelPath, serializeNode(node));

            if (item.position && Number.isFinite(item.position.x) && Number.isFinite(item.position.y)) {
                layout.positions[nodeId] = { x: item.position.x, y: item.position.y };
            }

            createdIds.push(nodeId);
            if (this.bridge?.onStubDefined) await this.bridge.onStubDefined(nodeId);
        }

        // If this was a split operation, update the original node's context or note if it exists
        if (args.splitFrom) {
            const originalPath = pathForNodeId(args.splitFrom);
            this.assertSafePath(originalPath, NODES_DIR);
            try {
                const origText = await fs.readFile(this.absPath(originalPath), 'utf8');
                const origNode = parseNode(origText);
                origNode.context = [...new Set([...origNode.context, ...createdIds])];
                await this.writeJsonFile(originalPath, serializeNode(origNode));
            } catch {
                // Ignore if original file not found
            }
        }

        await this.writeLayout(layout);

        return {
            ok: true,
            created: createdIds,
            splitFrom: args.splitFrom ?? null,
        };
    }

    /** Tool: slate_wire_flow */
    async toolWireFlow(args: {
        flow?: string;
        instances?: Array<{ id: string; node?: string; kind?: 'value'; value?: string; position?: { x: number; y: number } }>;
        wires?: Array<{ from: string; to: string }>;
        disconnect?: Array<{ from: string; to: string }>;
        removeInstances?: string[];
    }): Promise<Record<string, unknown>> {
        const flowId = args.flow || MAIN_FLOW;
        const flowRelPath = pathForFlowId(flowId);
        this.assertSafePath(flowRelPath, 'slate/flows');
        let flow: SlateFlow;

        try {
            const raw = await fs.readFile(this.absPath(flowRelPath), 'utf8');
            flow = parseFlow(raw);
        } catch {
            flow = emptyFlow(flowId);
        }

        const layout = await this.readLayout();
        let layoutChanged = false;

        // 1. Remove instances if requested
        if (args.removeInstances && args.removeInstances.length > 0) {
            flow = removeInstances(flow, args.removeInstances);
            for (const id of args.removeInstances) {
                if (flowId === MAIN_FLOW) delete layout.positions[id];
                else if (layout.flowPositions[flowId]) delete layout.flowPositions[flowId][id];
            }
            layoutChanged = true;
        }

        // 2. Add or update instances
        if (args.instances && args.instances.length > 0) {
            for (const inst of args.instances) {
                const existingIdx = flow.instances.findIndex((i: FlowInstance) => i.id === inst.id);
                const nextInst: FlowInstance = inst.kind === 'value'
                    ? { id: inst.id, kind: 'value', value: inst.value ?? '0' }
                    : { id: inst.id, node: inst.node || inst.id };

                if (existingIdx >= 0) {
                    flow.instances[existingIdx] = nextInst;
                } else {
                    flow.instances.push(nextInst);
                }

                if (inst.position && Number.isFinite(inst.position.x) && Number.isFinite(inst.position.y)) {
                    if (flowId === MAIN_FLOW) {
                        layout.positions[inst.id] = { x: inst.position.x, y: inst.position.y };
                    } else {
                        (layout.flowPositions[flowId] ??= {})[inst.id] = { x: inst.position.x, y: inst.position.y };
                    }
                    layoutChanged = true;
                }
            }
        }

        // 3. Disconnect wires
        if (args.disconnect && args.disconnect.length > 0) {
            for (const w of args.disconnect) {
                flow = disconnect(flow, w.from, w.to);
            }
        }

        // 4. Connect wires
        if (args.wires && args.wires.length > 0) {
            for (const wire of args.wires) {
                const { from, to } = wire;
                if (!from || !to) throw new Error('Wire must specify both "from" and "to" endpoints.');
                const fromEp = parseEndpoint(from);
                const toEp = parseEndpoint(to);
                if (fromEp.instance !== null && fromEp.instance === toEp.instance) {
                    throw new Error(`Self-loop rejected: node instance "${fromEp.instance}" cannot wire into itself.`);
                }
                if (fromEp.instance !== null && !flow.instances.some(i => i.id === fromEp.instance)) {
                    throw new Error(`Instance "${fromEp.instance}" does not exist in flow "${flowId}". Define or add the instance before connecting wires.`);
                }
                if (toEp.instance !== null && !flow.instances.some(i => i.id === toEp.instance)) {
                    throw new Error(`Instance "${toEp.instance}" does not exist in flow "${flowId}". Define or add the instance before connecting wires.`);
                }
                flow = connect(flow, from, to);
            }
        }

        await this.writeJsonFile(flowRelPath, serializeFlow(flow));
        if (layoutChanged) {
            await this.writeLayout(layout);
        }

        if (this.bridge?.onFlowWired) await this.bridge.onFlowWired(flowId);

        return {
            ok: true,
            flow: flow.name,
            instances: flow.instances,
            wires: flow.wires,
        };
    }

    /** Call a tool directly by name and arguments */
    async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
        try {
            let result: Record<string, unknown>;
            switch (name) {
                case 'slate_find':
                    result = await this.toolFind(args);
                    break;
                case 'slate_focus':
                    result = await this.toolFocus(args);
                    break;
                case 'slate_place_notes':
                    result = await this.runSerialized(() => this.toolPlaceNotes(args));
                    break;
                case 'slate_define_stub':
                    result = await this.runSerialized(() => this.toolDefineStub(args));
                    break;
                case 'slate_wire_flow':
                    result = await this.runSerialized(() => this.toolWireFlow(args));
                    break;
                default:
                    return {
                        content: [{ type: 'text', text: `Unknown tool: "${name}"` }],
                        isError: true,
                    };
            }
            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                isError: false,
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
                isError: true,
            };
        }
    }

    /** Handle a JSON-RPC request object */
    async handleRequest(request: JsonRpcRequest): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse | null> {
        if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
            return {
                jsonrpc: '2.0',
                id: (request && (typeof request.id === 'string' || typeof request.id === 'number')) ? request.id : null,
                error: {
                    code: -32600,
                    message: 'Invalid Request: missing or invalid "jsonrpc" or "method" field.',
                },
            };
        }

        const id = request.id !== undefined ? request.id : null;

        if (request.method === 'initialize') {
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                        tools: {},
                    },
                    serverInfo: {
                        name: 'slate-frontier-architect',
                        version: '0.1.0',
                    },
                },
            };
        }

        if (request.method === 'notifications/initialized') {
            return null; // Notifications have no response
        }

        if (request.method === 'ping') {
            return {
                jsonrpc: '2.0',
                id,
                result: {},
            };
        }

        if (request.method === 'tools/list') {
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    tools: MCP_TOOLS,
                },
            };
        }

        if (request.method === 'tools/call') {
            const params = request.params ?? {};
            const toolName = String(params.name ?? '');
            const toolArgs = (params.arguments && typeof params.arguments === 'object'
                ? params.arguments
                : {}) as Record<string, unknown>;

            const toolResult = await this.callTool(toolName, toolArgs);
            return {
                jsonrpc: '2.0',
                id,
                result: toolResult,
            };
        }

        // Method not found
        return {
            jsonrpc: '2.0',
            id,
            error: {
                code: -32601,
                message: `Method not found: "${request.method}"`,
            },
        };
    }

    /** Handle raw incoming line of JSON */
    async handleMessage(line: string): Promise<string | null> {
        const trimmed = line.trim();
        if (!trimmed) return null;

        let request: JsonRpcRequest;
        try {
            request = JSON.parse(trimmed) as JsonRpcRequest;
        } catch (error) {
            const errResp: JsonRpcErrorResponse = {
                jsonrpc: '2.0',
                id: null,
                error: {
                    code: -32700,
                    message: `Parse error: ${(error as Error).message}`,
                },
            };
            return JSON.stringify(errResp);
        }

        if (!request || typeof request !== 'object' || Array.isArray(request)) {
            const errResp: JsonRpcErrorResponse = {
                jsonrpc: '2.0',
                id: null,
                error: {
                    code: -32600,
                    message: 'Invalid Request: payload must be a non-null JSON-RPC object.',
                },
            };
            return JSON.stringify(errResp);
        }

        const response = await this.handleRequest(request);
        return response ? JSON.stringify(response) : null;
    }

    /** Attach stdio or readable/writable streams to this MCP server */
    connectStreams(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): void {
        const rl = readline.createInterface({ input, terminal: false });
        this.rl = rl;
        rl.on('line', line => {
            this.streamQueue = this.streamQueue.then(async () => {
                const reply = await this.handleMessage(line);
                if (reply) {
                    output.write(`${reply}\n`);
                }
            }).catch(() => {});
        });
    }

    /** Start server on process.stdin / process.stdout */
    startStdio(): void {
        this.connectStreams(process.stdin, process.stdout);
    }

    close(): void {
        this.rl?.close();
        this.rl = undefined;
    }
}

// Standalone CLI execution
if (require.main === module) {
    let workspaceDir = process.cwd();
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--workspace' && args[i + 1]) {
            workspaceDir = path.resolve(args[i + 1]);
            i++;
        }
    }
    const server = new SlateMcpServer(workspaceDir);
    server.startStdio();
}
