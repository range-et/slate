import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import * as readline from 'readline';
import { randomUUID } from 'crypto';
import { parser as pythonParser } from '@lezer/python';
import * as ts from 'typescript';

import { batchForgeWorkspace, compactBatchForgeResult } from '../batch_forge';
import { verifyProjectCi } from '../ci_verifier';
import {
    assertSafeFlowId, connect, disconnect, emptyFlow, FLOWS_DIR, flowIdForPath, MAIN_FLOW,
    parseEndpoint, pathForFlowId, removeInstances, serializeFlow, parseFlow
} from '../flow';
import {
    assertSafeNodeId, classFrameFromHeader, codeLines, CONFIG_PATH, emptyLayout, extractClassFrameMetadata, indexNode, LAYOUT_PATH, NODES_DIR,
    nodeFromSignature, nodeIdForPath, parseConfig, parseLayout, parseNode,
    pathForNodeId, serializeConfig, serializeLayout, serializeNode,
    tsNodeFromSignature, validateNodeStub, validateStubBody, validateTsStubBody,
    type SlateConfig, type SlateLayout, type SlateLlmConfig, type SlateLlmProvider,
    type SlateNode, type StubValidationResult
} from '../slate_folder';
import type { BoardNote, FlowInstance, FlowPort, FlowWire, HarnessDocument, HarnessFlow, SlateFlow } from '../harness_protocol';
import { compileProjectForLanguage } from '../language_adapter';
import { isSlateGeneratedContent, normalizeCompileOutputPath, tryNormalizeLanguage } from '../language_types';
import { checkLlamaHealth, credentialPairingKey, DEFAULT_OPENROUTER_MODEL, evaluateProjectCredentialAccess, inferProviderFromEndpoint, resolveLlmConfig, validateLlmEndpointUrl, type LlmConfigInput } from '../llama_transport';
import { LIVE_BRIDGE_TOKEN_HEADER, readValidatedLiveBridgeRecord } from '../live_bridge';
import { assertPathInsideRealDir, assertSafeCompileOutDir, caseCollisionKey } from '../path_safety';
import { parseProseNode, proseStub } from '../prose_adapter';
import { identifierNames, isForbiddenSlateModule, parseModule, splitImport } from '../python_adapter';
import { splitTsImport, tsIdentifierNames } from '../ts_adapter';
import { buildUsageIndex } from '../usage_index';

export { validateStubBody, type StubValidationResult };

export interface SlateMcpServerOptions {
    isTrusted?: boolean;
    approvedCredentialPairings?: ReadonlySet<string> | readonly string[];
    bridgeDir?: string;
}

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
    isWorkspaceTrusted?(): boolean;
    getApprovedCredentialPairings?(): ReadonlySet<string> | readonly string[];
    getLlamaConfig?(): LlmConfigInput & { endpoint: string; model: string; timeoutSeconds?: number };
    setLlamaConfig?(config: LlmConfigInput): Promise<void>;
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
        description: 'Define typed atomic stubs (name, signature, intent, contract, cases) in slate/nodes/**/*.json for Python or TypeScript/JavaScript/Prose. Strictly refuses arbitrary body implementations and supports splitting oversized (>60-line) nodes into smaller atomic stubs.',
        inputSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Node name / identifier (e.g. "clamp" or "math/clamp").',
                },
                signature: {
                    type: 'string',
                    description: 'Typed signature (e.g. "def clamp(value: int, lower: int, upper: int) -> int" or "export function clamp(value: number, lower: number, upper: number): number").',
                },
                intent: {
                    type: 'string',
                    description: 'High-level intent describing what the atomic node must do.',
                },
                language: {
                    type: 'string',
                    enum: ['python', 'typescript', 'javascript', 'prose'],
                    description: 'Optional target language (defaults to slate.json project language).',
                },
                extension: {
                    type: 'string',
                    description: 'Optional TypeScript/JavaScript source extension (e.g. ".ts", ".tsx", ".js", ".jsx").',
                },
                modulePath: {
                    type: 'string',
                    description: 'Optional source module path hint used when compiling multi-file TypeScript/JavaScript modules.',
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
                imports: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional external import statements required by this node (e.g. ["import math"]). Internal slate.* imports are rejected.',
                },
                cases: {
                    type: 'array',
                    description: 'Optional structured test cases.',
                    items: {
                        oneOf: [
                            { type: 'string' },
                            {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    name: { type: 'string' },
                                    description: { type: 'string' },
                                    input: { type: ['object', 'array'] },
                                    inputs: { type: ['object', 'array'] },
                                    expected: {},
                                    error: { type: 'string', description: 'Expected exception class name (e.g. "ValueError").' },
                                    expectedError: { type: 'string', description: 'Alias for "error".' },
                                    approx: { type: ['boolean', 'number'], description: 'Use approximate float matching (boolean or numeric abs tolerance).' },
                                    code: { type: 'string', description: 'Explicit assertion expression/line.' },
                                },
                            },
                        ],
                    },
                },
                body: {
                    type: 'string',
                    description: 'Optional stub body (Python: "pass", "...", or "raise NotImplementedError(...)"; TS/JS: empty or "throw new Error(...)"). Non-stub implementation code is strictly rejected.',
                },
                classOwner: {
                    type: 'string',
                    description: 'Optional owning class frame node ID (from slate_define_class) when defining an owned method node.',
                },
                owner: {
                    type: 'string',
                    description: 'Alias for classOwner.',
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
                            language: { type: 'string', enum: ['python', 'typescript', 'javascript', 'prose'] },
                            extension: { type: 'string' },
                            modulePath: { type: 'string' },
                            contract: { type: 'string' },
                            context: { type: 'array', items: { type: 'string' } },
                            imports: { type: 'array', items: { type: 'string' } },
                            classOwner: { type: 'string' },
                            owner: { type: 'string' },
                            cases: {
                                type: 'array',
                                items: {
                                    oneOf: [
                                        { type: 'string' },
                                        {
                                            type: 'object',
                                            properties: {
                                                id: { type: 'string' },
                                                name: { type: 'string' },
                                                description: { type: 'string' },
                                                input: { type: ['object', 'array'] },
                                                inputs: { type: ['object', 'array'] },
                                                expected: {},
                                                error: { type: 'string' },
                                                expectedError: { type: 'string' },
                                                approx: { type: ['boolean', 'number'] },
                                                code: { type: 'string' },
                                            },
                                        },
                                    ],
                                },
                            },
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
        name: 'slate_define_class',
        description: 'Define a class frame container node (kind: "class") holding the class header, decorators, bases, and typed fields/properties in slate/nodes/**/*.json (no methods allowed inside the frame; methods live in owned method nodes via slate_define_stub with owner).',
        inputSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Class node ID (e.g. "ConvBlock" or "models/ConvBlock").',
                },
                signature: {
                    type: 'string',
                    description: 'Class header (e.g. "class ConvBlock(nn.Module)").',
                },
                intent: {
                    type: 'string',
                    description: 'High-level intent describing the class responsibility.',
                },
                contract: {
                    type: 'string',
                    description: 'Optional class invariants and behavioral contract.',
                },
                decorators: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional class decorators (e.g. ["@dataclass"]).',
                },
                fields: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional class/struct property declarations (e.g. ["dim: int", "scale: float = 1.0"]).',
                },
                imports: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional external imports needed by the class header or field annotations.',
                },
                context: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional context dependency node IDs.',
                },
                position: {
                    type: 'object',
                    properties: { x: { type: 'number' }, y: { type: 'number' } },
                    required: ['x', 'y'],
                    description: 'Canvas position for the class frame.',
                },
            },
            required: ['name', 'signature', 'intent'],
        },
    },
    {
        name: 'slate_wire_flow',
        description: 'Connect typed dataflow wires and declare flow input/output ports deterministically via flow.ts and layout.json.',
        inputSchema: {
            type: 'object',
            properties: {
                flow: {
                    type: 'string',
                    description: 'Flow ID to wire (defaults to "main").',
                },
                inputs: {
                    type: 'array',
                    description: 'Optional flow input ports (replaces existing inputs when provided; preserved when omitted).',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', description: 'Valid identifier port name.' },
                            annotation: { type: ['string', 'null'], description: 'Optional type annotation.' },
                        },
                        required: ['name'],
                        additionalProperties: false,
                    },
                },
                outputs: {
                    type: 'array',
                    description: 'Optional flow output ports (replaces existing outputs when provided; preserved when omitted).',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', description: 'Valid identifier port name.' },
                            annotation: { type: ['string', 'null'], description: 'Optional type annotation.' },
                        },
                        required: ['name'],
                        additionalProperties: false,
                    },
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
    {
        name: 'slate_llm_status',
        description: 'Inspect reachability, provider, endpoint, model, API-key presence (non-secret), and available models for the configured LLM server (llama.cpp, Ollama, OpenRouter, LM Studio, vLLM).',
        inputSchema: {
            type: 'object',
            properties: {
                endpoint: {
                    type: 'string',
                    description: 'Optional override endpoint URL to test reachability against.',
                },
                timeoutMs: {
                    type: 'number',
                    description: 'Optional timeout in milliseconds (default 3000).',
                },
            },
        },
    },
    {
        name: 'slate_configure_llm',
        description: 'Configure the LLM provider, endpoint, model, and non-secret env-var auth settings for Slate component forge (llama.cpp, Ollama, OpenRouter, or OpenAI-compatible). Never accepts raw API keys.',
        inputSchema: {
            type: 'object',
            properties: {
                provider: {
                    type: 'string',
                    enum: ['llama.cpp', 'ollama', 'openrouter', 'openai-compatible'],
                    description: 'Optional LLM provider kind.',
                },
                endpoint: {
                    type: 'string',
                    description: 'The HTTP/HTTPS URL of the OpenAI-compatible LLM server (e.g. "http://127.0.0.1:8080", "http://127.0.0.1:11434/v1", or "https://openrouter.ai/api/v1").',
                },
                model: {
                    type: 'string',
                    description: 'Optional model identifier (e.g. "qwen/qwen3-coder-next", "qwen/qwen3-coder-30b-a3b-instruct", "qwen2.5-coder:7b", or "local").',
                },
                apiKeyEnv: {
                    type: 'string',
                    description: 'Environment variable name holding the Bearer API key (e.g. "OPENROUTER_API_KEY"). Raw secrets are rejected.',
                },
                concurrency: {
                    type: 'number',
                    description: 'Optional batch forge concurrency (1-16, default 3).',
                },
                outputTokens: {
                    type: 'number',
                    description: 'Optional max completion output tokens (>= 64, default 1536).',
                },
                contextWindow: {
                    type: 'number',
                    description: 'Optional context window tokens (>= 1024, default 4096).',
                },
                timeoutSeconds: {
                    type: 'number',
                    description: 'Optional request timeout in seconds (>= 5, default 120).',
                },
                writeToProject: {
                    type: 'boolean',
                    description: 'When true, persist non-secret llm settings into slate/slate.json.',
                },
            },
        },
    },
    {
        name: 'slate_forge_batch',
        description: 'Statelessly batch-forge atomic stub nodes in topological dependency waves using bounded <=600-token micro-packets, JPL-60 validation, language-appropriate verification (Pydantic+pytest or strict tsc+node), and bounded revision retries.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional list of node IDs to forge. If omitted, forges all unlocked unimplemented atomic stubs (Python, TypeScript, JavaScript).',
                },
                allStubs: {
                    type: 'boolean',
                    description: 'When true (or when nodeIds is omitted), select all unlocked unimplemented atomic stubs (Python, TypeScript, JavaScript).',
                },
                concurrency: {
                    type: 'number',
                    description: 'Optional parallel worker count (1-16, default from config or 3).',
                },
                maxRevisions: {
                    type: 'number',
                    description: 'Optional max forge/verify attempts per node (1-5, default 3).',
                },
                verify: {
                    type: 'boolean',
                    description: 'Run verification (Pydantic+pytest for Python, strict tsc+node for TS/JS) on forged candidates before writing (default true).',
                },
                write: {
                    type: 'boolean',
                    description: 'Write verified candidates back to slate/nodes/*.json (default true).',
                },
                overwrite: {
                    type: 'boolean',
                    description: 'Allow regenerating nodes that already have non-stub implementations (default false).',
                },
                verbose: {
                    type: 'boolean',
                    description: 'Return full raw verification tracebacks and payloads instead of compact Frontier digests (default false).',
                },
                provider: {
                    type: 'string',
                    enum: ['llama.cpp', 'ollama', 'openrouter', 'openai-compatible'],
                    description: 'Optional per-batch provider override.',
                },
                endpoint: {
                    type: 'string',
                    description: 'Optional per-batch endpoint override.',
                },
                model: {
                    type: 'string',
                    description: 'Optional per-batch model override.',
                },
                apiKeyEnv: {
                    type: 'string',
                    description: 'Optional env var name override for Bearer auth (never a raw key).',
                },
            },
        },
    },
    {
        name: 'slate_references',
        description: 'Inspect deterministic AST uses, dependencies, callers, and flow call-sites across Slate nodes using indexNode and buildUsageIndex.',
        inputSchema: {
            type: 'object',
            properties: {
                nodeId: {
                    type: 'string',
                    description: 'Target node ID to inspect (e.g. "scoreMatch" or "palette/scoreMatch"). Omit for a project-wide usage summary.',
                },
            },
        },
    },
    {
        name: 'slate_compile',
        description: 'Deterministically compile slate/ nodes and flows into target source files without overwriting non-Slate user files.',
        inputSchema: {
            type: 'object',
            properties: {
                outDir: {
                    type: 'string',
                    description: 'Relative output directory inside the workspace (defaults to slate.json compile.outDir or "out").',
                },
                dryRun: {
                    type: 'boolean',
                    description: 'If true, compile in memory and return planned files and diagnostics without writing disk files.',
                },
            },
        },
    },
    {
        name: 'slate_verify_ci',
        description: 'Run Slate 4-pillar CI verification (Schema, Stub JPL-60/typing, Code parity/drift scoped to srcRoots, and Test coverage across testRoots + node.cases/node.check).',
        inputSchema: {
            type: 'object',
            properties: {
                srcRoots: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional relative source root directories to scan for code parity (defaults to slate.json ci.srcRoots or [compile.outDir ?? "src"]).',
                },
                testRoots: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional relative test root directories to scan for test coverage (defaults to slate.json ci.testRoots or ["tests", "test"]).',
                },
                requireTests: {
                    type: 'boolean',
                    description: 'Fail if any atomic function node lacks node.cases, node.check, or mapped executable test coverage (defaults to slate.json ci.requireTests or false).',
                },
            },
        },
    },
];

export class SlateMcpServer {
    private rl?: readline.Interface;
    private bridge?: SlateMcpBridge;
    private readonly options?: SlateMcpServerOptions;
    private mutationQueue: Promise<unknown> = Promise.resolve();
    private streamQueue: Promise<void> = Promise.resolve();

    constructor(
        public readonly workspaceRoot: string,
        bridge?: SlateMcpBridge,
        options?: SlateMcpServerOptions,
    ) {
        this.bridge = bridge;
        this.options = options;
    }

    private isWorkspaceTrusted(): boolean {
        if (this.bridge?.isWorkspaceTrusted) {
            return this.bridge.isWorkspaceTrusted() === true;
        }
        return this.options?.isTrusted === true;
    }

    private getApprovedCredentialPairings(): ReadonlySet<string> {
        const merged = new Set<string>();
        if (this.options?.approvedCredentialPairings) {
            for (const entry of this.options.approvedCredentialPairings) {
                merged.add(entry);
            }
        }
        const bridgePairings = this.bridge?.getApprovedCredentialPairings?.();
        if (bridgePairings) {
            for (const entry of bridgePairings) {
                merged.add(entry);
            }
        }
        return merged;
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

    /** Read a file's text; returns null only when the file is missing, throws on any other failure. */
    private async readTextIfExists(rel: string): Promise<string | null> {
        try {
            return await fs.readFile(this.absPath(rel), 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw new Error(`Cannot read "${rel}": ${(error as Error).message}`);
        }
    }

    /** Read + parse an existing node; null if missing, error (never silent overwrite) if unreadable/invalid. */
    private async readExistingNode(rel: string): Promise<SlateNode | null> {
        const raw = await this.readTextIfExists(rel);
        if (raw === null) return null;
        try {
            return parseNode(raw);
        } catch (error) {
            throw new Error(`Existing node file "${rel}" is invalid and was not modified: ${(error as Error).message}`);
        }
    }

    private async writeJsonFile(rel: string, content: string): Promise<void> {
        const full = this.absPath(rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content, 'utf8');
    }

    private async readLayout(): Promise<SlateLayout> {
        const text = await this.readTextIfExists(LAYOUT_PATH);
        if (text === null) return emptyLayout();
        try {
            return parseLayout(text);
        } catch (error) {
            throw new Error(`Existing "${LAYOUT_PATH}" is invalid and was not modified: ${(error as Error).message}`);
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
            const configText = await this.readTextIfExists(CONFIG_PATH);
            const defaultLanguage = configText ? parseConfig(configText).language : 'python';
            const files = await this.findNodeFiles();
            for (const file of files) {
                const id = nodeIdForPath(file);
                if (!id) continue;
                if (scope !== 'all' && scope !== 'nodes' && !id.startsWith(scope)) continue;
                try {
                    const text = await fs.readFile(this.absPath(file), 'utf8');
                    const indexed = indexNode(file, text, defaultLanguage, null);
                    const node = indexed.node ?? parseNode(text);
                    const code = node.code.join('\n');
                    const parsedUnit = indexed.document.units.find(u => u.id === id) ?? indexed.document.units[0];
                    const fallbackSig = node.code.find(line => {
                        const trimmed = line.trim();
                        return trimmed.length > 0 && !trimmed.startsWith('#') && !trimmed.startsWith('//');
                    }) ?? node.code[0] ?? '';
                    const sig = (parsedUnit?.signature || fallbackSig).trim().replace(/:\s*$/, '');

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
                            signature: sig,
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

        // 2. Check for live bridge file in user-private runtime directory
        try {
            const record = await readValidatedLiveBridgeRecord(this.workspaceRoot, this.options?.bridgeDir);
            if (record) {
                const posted = await new Promise<boolean>(resolve => {
                    const req = http.request({
                        hostname: '127.0.0.1',
                        port: record.port,
                        path: '/focus',
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Host: `127.0.0.1:${record.port}`,
                            [LIVE_BRIDGE_TOKEN_HEADER]: record.token,
                        },
                        timeout: 1000,
                    }, res => {
                        res.resume();
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

    private normalizeStubImports(rawImports: unknown, language: string, nodeId: string): string[] {
        if (!Array.isArray(rawImports)) {
            throw new Error(`Stub "${nodeId}" imports must be an array of strings.`);
        }
        const result: string[] = [];
        const pushUnique = (line: string) => {
            if (!result.includes(line)) result.push(line);
        };
        for (const entry of rawImports) {
            if (typeof entry !== 'string') {
                throw new Error(`Stub "${nodeId}" imports entries must be strings.`);
            }
            const trimmed = entry.trim();
            if (!trimmed) continue;
            if (language === 'prose') {
                throw new Error(`Prose stub "${nodeId}" cannot declare code imports ("${trimmed}").`);
            }
            if (language === 'python') {
                if (/[\r\n]/.test(trimmed)) {
                    throw new Error(`Invalid multi-line Python import "${trimmed}" in stub "${nodeId}".`);
                }
                const mod = parseModule(`${trimmed}\n`, '<stub-import>');
                const tree = pythonParser.parse(`${trimmed}\n`);
                const first = tree.topNode.firstChild;
                if (!mod.valid || mod.units.length > 0 || !first || first.nextSibling !== null || first.name !== 'ImportStatement') {
                    throw new Error(`Invalid Python import "${trimmed}" in stub "${nodeId}".`);
                }
                const parsed = splitImport(trimmed);
                if (parsed.length === 0) {
                    throw new Error(`Invalid Python import "${trimmed}" in stub "${nodeId}".`);
                }
                for (const item of parsed) {
                    if (isForbiddenSlateModule(item.module)) {
                        throw new Error(`Forbidden internal import "${trimmed}" in stub "${nodeId}": dependencies are imported automatically from context/uses.`);
                    }
                    pushUnique(item.line);
                }
            } else if (language === 'typescript' || language === 'javascript') {
                const parsed = splitTsImport(trimmed);
                if (parsed.length === 0) {
                    throw new Error(`Invalid ${language} import "${trimmed}" in stub "${nodeId}".`);
                }
                for (const item of parsed) {
                    const normMod = item.module.replace(/\\/g, '/').trim();
                    if (/(?:^|\/)slate\/(?:nodes|flows)(?:$|\/)/i.test(normMod) || normMod === 'slate' || normMod.startsWith('slate/')) {
                        throw new Error(`Forbidden internal import "${trimmed}" in stub "${nodeId}": dependencies are imported automatically from context/uses.`);
                    }
                    pushUnique(item.line);
                }
            } else {
                pushUnique(trimmed);
            }
        }
        return result;
    }

    private validateStubCaseCode(
        rawCode: string,
        language: string,
        nodeId: string,
        singleLineOnly: boolean,
        allowedCallables: readonly string[] = [],
    ): void {
        if (language === 'prose') {
            throw new Error(`Prose stub "${nodeId}" cannot define executable case code.`);
        }
        if (singleLineOnly && /[\r\n]/.test(rawCode)) {
            throw new Error(`Plain string case in stub "${nodeId}" must be single-line.`);
        }
        if (language === 'python') {
            const tree = pythonParser.parse(`${rawCode}\n`);
            type Node = typeof tree.topNode;
            const target = nodeId.split('/').pop()!;
            const functions = new Set([target, ...allowedCallables, 'range', 'int', 'set', 'len', 'list', 'tuple', 'sorted', 'abs']);
            const exceptions = new Set(['ValueError', 'TypeError', 'IndexError', 'KeyError', 'RuntimeError',
                'ArithmeticError', 'ZeroDivisionError', 'AssertionError', 'OverflowError']);
            const containers = new Set(['Script', 'StatementGroup', 'ExpressionStatement', 'AssertStatement',
                'WithStatement', 'Body', 'ArgList', 'UnaryExpression', 'BinaryExpression', 'ParenthesizedExpression',
                'TupleExpression', 'ArrayExpression', 'DictionaryExpression', 'SetExpression']);
            const leaves = new Set(['Number', 'String', 'Boolean', 'None', 'ArithOp', 'CompareOp', 'BitOp',
                'assert', 'with', 'is', 'in', 'and', 'or', 'not', '(', ')', '[', ']', '{', '}', ',', ':', ';', 'AssignOp']);
            const value = (n: Node) => rawCode.slice(n.from, n.to);
            const reject = (): never => { throw new Error(`Unsupported Python case form in stub "${nodeId}".`); };
            const bind = (n: Node | null, locals: Set<string>) => {
                if (!n || n.name !== 'VariableName' || !/^[A-Za-z][A-Za-z0-9_]*$|^_$/.test(value(n))
                    || functions.has(value(n)) || exceptions.has(value(n)) || value(n) === 'pytest') return reject();
                locals.add(value(n));
            };
            const visit = (n: Node, locals: Set<string>): void => {
                if (n.type.isError) reject();
                if (n.name === 'ImportStatement' && /^import[ \t]+pytest$/.test(value(n))) return;
                if (n.name === 'AssignStatement') {
                    const lhs = n.firstChild;
                    const op = lhs?.nextSibling;
                    const rhs = op?.nextSibling;
                    if (!lhs || !op || value(op) !== '=' || !rhs || rhs.nextSibling) return reject();
                    visit(rhs, locals);
                    if (lhs.name === 'VariableName') bind(lhs, locals);
                    else if (lhs.name === 'MemberExpression') visit(lhs, locals);
                    else reject();
                    return;
                }
                if (n.name === 'ArrayComprehensionExpression') {
                    const expr = n.firstChild?.nextSibling;
                    const clause = expr?.nextSibling;
                    const variable = clause?.nextSibling;
                    const iterable = variable?.nextSibling?.nextSibling;
                    if (!expr || clause?.name !== 'for' || !variable || variable.nextSibling?.name !== 'in'
                        || !iterable || iterable.nextSibling?.name !== ']') return reject();
                    visit(iterable, locals);
                    const inner = new Set(locals);
                    bind(variable, inner);
                    visit(expr, inner);
                    return;
                }
                if (n.name === 'CallExpression') {
                    const callee = n.firstChild;
                    const args = callee?.nextSibling;
                    if (!callee || args?.name !== 'ArgList' || args.nextSibling) return reject();
                    if (value(callee) === 'pytest.raises') {
                        const exception = args.firstChild?.nextSibling;
                        if (n.parent?.name !== 'WithStatement' || exception?.name !== 'VariableName'
                            || !exceptions.has(value(exception)) || exception.nextSibling?.name !== ')') reject();
                    } else {
                        if (!(callee.name === 'VariableName' && functions.has(value(callee))) && value(callee) !== 'pytest.approx') reject();
                        visit(args, locals);
                    }
                    return;
                }
                if (n.name === 'WithStatement' && value(n.firstChild?.nextSibling?.firstChild ?? n) !== 'pytest.raises') reject();
                if (n.name === 'VariableName') {
                    if (!locals.has(value(n)) && !(n.parent?.name === 'ArgList' && n.nextSibling?.name === 'AssignOp')) reject();
                    return;
                }
                if (leaves.has(n.name)) return;
                if (n.name === 'MemberExpression' ? n.firstChild?.nextSibling?.name !== '[' : !containers.has(n.name)) reject();
                for (let child = n.firstChild; child; child = child.nextSibling) visit(child, locals);
            };
            visit(tree.topNode, new Set());
            return;
        }
        if (language === 'typescript' || language === 'javascript') {
            const sf = ts.createSourceFile('<case>.tsx', rawCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
            const diags = (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
            if (diags.length > 0) {
                throw new Error(`Invalid ${language} syntax in case for stub "${nodeId}".`);
            }
            const forbiddenIds = new Set(['eval', 'Function', 'require', 'process', 'child_process', 'fs']);
            const visit = (node: ts.Node): void => {
                if (
                    ts.isFunctionDeclaration(node)
                    || ts.isClassDeclaration(node)
                    || ts.isClassExpression(node)
                    || ts.isImportDeclaration(node)
                    || ts.isImportEqualsDeclaration(node)
                ) {
                    throw new Error(`Declarations and imports are forbidden in stub "${nodeId}" case code.`);
                }
                if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                    throw new Error(`Dynamic import() is forbidden in stub "${nodeId}" case code.`);
                }
                if (ts.isIdentifier(node) && forbiddenIds.has(node.text)) {
                    throw new Error(`Forbidden identifier "${node.text}" in stub "${nodeId}" case.`);
                }
                ts.forEachChild(node, visit);
            };
            ts.forEachChild(sf, visit);
        }
    }

    private normalizeStubCases(rawCases: unknown, language: string, nodeId: string, allowedCallables: readonly string[] = []): unknown[] {
        if (!Array.isArray(rawCases)) {
            throw new Error(`Stub "${nodeId}" cases must be an array.`);
        }
        const identRe = language === 'typescript' || language === 'javascript'
            ? /^[A-Za-z_$][A-Za-z0-9_$]*$/
            : /^[A-Za-z_][A-Za-z0-9_]*$/;
        const metaKeys = new Set(['name', 'id', 'description', 'error', 'expectedError', 'expected', 'return', 'output', 'approx', 'inputs', 'input', 'args', 'params', 'init']);

        for (const entry of rawCases) {
            if (typeof entry === 'string') {
                this.validateStubCaseCode(entry, language, nodeId, true, allowedCallables);
                continue;
            }
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new Error(`Each case in stub "${nodeId}" must be a case object or assertion string.`);
            }
            const obj = entry as Record<string, unknown>;
            if (obj.code !== undefined) {
                if (typeof obj.code !== 'string') {
                    throw new Error(`Case "code" in stub "${nodeId}" must be a string.`);
                }
                this.validateStubCaseCode(obj.code, language, nodeId, false, allowedCallables);
                continue;
            }
            if (obj.approx !== undefined) {
                if (typeof obj.approx !== 'boolean' && (typeof obj.approx !== 'number' || !Number.isFinite(obj.approx) || obj.approx < 0)) {
                    throw new Error(`Case "approx" in stub "${nodeId}" must be a boolean or non-negative finite number.`);
                }
            }
            for (const errKey of ['error', 'expectedError'] as const) {
                if (obj[errKey] !== undefined) {
                    if (typeof obj[errKey] !== 'string' || /[\r\n]/.test(obj[errKey] as string)) {
                        throw new Error(`Case "${errKey}" in stub "${nodeId}" must be a single-line string.`);
                    }
                }
            }
            const inputs = obj.inputs ?? obj.input ?? obj.args ?? obj.params;
            if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
                for (const key of Object.keys(inputs as Record<string, unknown>)) {
                    if (!identRe.test(key)) {
                        throw new Error(`Invalid parameter name "${key}" in stub "${nodeId}" case inputs.`);
                    }
                }
            } else if (inputs === undefined) {
                for (const key of Object.keys(obj)) {
                    if (!metaKeys.has(key) && !identRe.test(key)) {
                        throw new Error(`Invalid parameter name "${key}" in stub "${nodeId}" case.`);
                    }
                }
            }
        }
        return rawCases;
    }

    private normalizeFlowPortsArg(rawPorts: unknown, label: 'inputs' | 'outputs'): FlowPort[] {
        if (!Array.isArray(rawPorts)) {
            throw new Error(`Flow "${label}" must be an array of { name, annotation? } objects.`);
        }
        const identRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
        const seen = new Set<string>();
        const ports: FlowPort[] = [];
        for (const entry of rawPorts) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new Error(`Each entry in flow "${label}" must be an object with a "name" identifier.`);
            }
            const rec = entry as Record<string, unknown>;
            const name = typeof rec.name === 'string' ? rec.name.trim() : '';
            if (!identRe.test(name)) {
                throw new Error(`Invalid port name "${String(rec.name ?? '')}" in flow "${label}": must match identifier pattern.`);
            }
            if (seen.has(name)) {
                throw new Error(`Duplicate port name "${name}" in flow "${label}".`);
            }
            seen.add(name);
            if (rec.annotation !== undefined && rec.annotation !== null && typeof rec.annotation !== 'string') {
                throw new Error(`Annotation for port "${name}" in flow "${label}" must be a string or null.`);
            }
            const ann = typeof rec.annotation === 'string' ? (rec.annotation.trim() || null) : null;
            ports.push({ name, annotation: ann });
        }
        return ports;
    }

    /** Tool: slate_define_stub */
    async toolDefineStub(args: {
        name?: string;
        signature?: string;
        intent?: string;
        language?: string;
        extension?: string;
        modulePath?: string;
        contract?: string;
        context?: string[];
        imports?: string[];
        cases?: unknown[];
        body?: string;
        classOwner?: string;
        owner?: string;
        position?: { x: number; y: number };
        splitFrom?: string;
        stubs?: Array<{
            name: string;
            signature: string;
            intent: string;
            language?: string;
            extension?: string;
            modulePath?: string;
            contract?: string;
            context?: string[];
            imports?: string[];
            cases?: unknown[];
            body?: string;
            classOwner?: string;
            owner?: string;
            position?: { x: number; y: number };
        }>;
    }): Promise<Record<string, unknown>> {
        const stubList = args.stubs && args.stubs.length > 0
            ? args.stubs
            : (args.name && args.signature && args.intent ? [{
                name: args.name,
                signature: args.signature,
                intent: args.intent,
                language: args.language,
                extension: args.extension,
                modulePath: args.modulePath,
                contract: args.contract,
                context: args.context,
                imports: args.imports,
                cases: args.cases,
                body: args.body,
                classOwner: args.classOwner ?? args.owner,
                position: args.position,
            }] : []);

        if (stubList.length === 0) {
            throw new Error('Must provide name, signature, and intent for the stub, or a list of stubs.');
        }

        const layout = await this.readLayout();
        const configText = await this.readTextIfExists(CONFIG_PATH);
        const rawProjectLang = configText ? parseConfig(configText).language : 'python';
        const projectLanguage = tryNormalizeLanguage(rawProjectLang) ?? 'python';
        const createdIds: string[] = [];

        for (const item of stubList) {
            const name = assertSafeNodeId(item.name);
            const nodeId = name;
            const nodeRelPath = pathForNodeId(nodeId);
            this.assertSafePath(nodeRelPath, NODES_DIR);

            // Check if node already exists before resolving language/metadata fallbacks
            const existingNode = await this.readExistingNode(nodeRelPath);
            const itemOwner = item.classOwner ?? item.owner;
            const argOwner = args.classOwner ?? args.owner;
            const rawOwner = itemOwner !== undefined ? itemOwner : (args.stubs?.length ? existingNode?.classOwner : (argOwner ?? existingNode?.classOwner));
            let ownerId: string | undefined;
            let ownerNode: SlateNode | null = null;
            if (rawOwner !== undefined) {
                ownerId = assertSafeNodeId(rawOwner);
                const ownerRelPath = pathForNodeId(ownerId);
                this.assertSafePath(ownerRelPath, NODES_DIR);
                ownerNode = await this.readExistingNode(ownerRelPath);
                if (!ownerNode || ownerNode.kind !== 'class') {
                    throw new Error(`Owner "${ownerId}" for stub "${nodeId}" does not exist or is not a class frame (define it first with slate_define_class).`);
                }
            }
            const rawItemLang = item.language ?? args.language ?? existingNode?.language;
            const itemLanguage = rawItemLang ? tryNormalizeLanguage(rawItemLang) : projectLanguage;
            if (!itemLanguage || !['python', 'typescript', 'javascript', 'prose'].includes(itemLanguage)) {
                throw new Error(`Unsupported stub language "${rawItemLang}"; expected python, typescript, javascript, or prose.`);
            }

            if (existingNode) {
                if (existingNode.locked) {
                    throw new Error(`Node "${nodeId}" is locked and cannot be modified.`);
                }
                const existingLang = tryNormalizeLanguage(existingNode.language ?? itemLanguage) ?? projectLanguage;
                const existingValidation = existingLang === 'prose'
                    ? { valid: !parseProseNode(existingNode, nodeId).bodyText, reason: 'Prose template already has a body.' }
                    : validateNodeStub(existingNode, existingLang);
                if (!existingValidation.valid) {
                    throw new Error(
                        `Node "${nodeId}" already has an active implementation and cannot be overwritten with a stub. ` +
                        `Frontier Architect only authors stubs for unimplemented nodes. Existing implementation: ${existingValidation.reason}`
                    );
                }
            }

            const signature = item.signature.trim();
            const intent = item.intent.trim();
            const contract = item.contract !== undefined ? item.contract.trim() : (existingNode?.contract ?? '');
            const context = item.context !== undefined ? item.context : (existingNode?.context ?? []);
            const rawImports = item.imports !== undefined ? item.imports : (args.stubs?.length ? undefined : args.imports);
            const imports = rawImports !== undefined
                ? this.normalizeStubImports(rawImports, itemLanguage, nodeId)
                : (existingNode?.imports ?? []);
            const allowedCaseCallables = ownerNode ? [ownerNode.name] : [];
            const cases = item.cases !== undefined
                ? this.normalizeStubCases(item.cases, itemLanguage, nodeId, allowedCaseCallables)
                : (existingNode?.cases ?? []);

            let initialNode: SlateNode;
            let code: string[];
            let extra: Record<string, unknown> = { ...(existingNode?.extra ?? {}) };

            if (itemLanguage === 'prose') {
                initialNode = proseStub(signature, name.split('/').pop()!, intent);
                if (initialNode.name !== name && name.split('/').pop() !== initialNode.name) {
                    throw new Error(`Signature function name "${initialNode.name}" does not match provided name "${name}".`);
                }
                if (item.body?.trim()) {
                    throw new Error('Architect prose stubs accept a signature without body text.');
                }
                code = initialNode.code;
            } else if (itemLanguage === 'typescript' || itemLanguage === 'javascript') {
                const modPath = (item.modulePath ?? args.modulePath)?.trim();
                const existingExt = typeof existingNode?.extra?.extension === 'string'
                    ? existingNode.extra.extension.trim()
                    : '';
                const explicitExt = (item.extension ?? args.extension)?.trim() || existingExt;
                const ext = explicitExt
                    || (modPath?.endsWith('.tsx') ? '.tsx'
                        : modPath?.endsWith('.jsx') ? '.jsx'
                        : modPath?.endsWith('.js') ? '.js'
                        : modPath?.endsWith('.ts') ? '.ts'
                        : itemLanguage === 'javascript' ? '.js'
                        : signature.includes('JSX') ? '.tsx' : '.ts');
                initialNode = tsNodeFromSignature(signature, intent, itemLanguage, ext);
                if (initialNode.name !== name && name.split('/').pop() !== initialNode.name) {
                    throw new Error(`Signature function name "${initialNode.name}" does not match provided name "${name}".`);
                }
                const rawBody = (item.body ?? '').trim();
                const stubBody = rawBody || 'throw new Error("Not implemented");';
                const validation = validateTsStubBody(signature, stubBody, ext);
                if (!validation.valid) {
                    throw new Error(validation.reason);
                }
                if (!rawBody) {
                    code = initialNode.code;
                } else {
                    const cleanSig = signature.replace(/\r\n?/g, '\n').trim().replace(/[;{]\s*$/, '').trim();
                    const normBody = stubBody.replace(/\r\n?/g, '\n');
                    const block = normBody.startsWith('{') && normBody.endsWith('}')
                        ? normBody
                        : `{\n${normBody.split('\n').map(l => `    ${l}`).join('\n')}\n}`;
                    code = codeLines(`${cleanSig} ${block}`);
                }
                extra = {
                    ...extra,
                    extension: ext,
                    ...(modPath ? { modulePath: modPath.replace(/\\/g, '/').replace(/^\.\//, '') } : {}),
                };
            } else {
                const stubBody = (item.body ?? 'raise NotImplementedError').replace(/\r\n?/g, '\n').trim();
                initialNode = nodeFromSignature(signature, intent);
                if (initialNode.name !== name && name.split('/').pop() !== initialNode.name) {
                    throw new Error(`Signature function name "${initialNode.name}" does not match provided name "${name}".`);
                }
                const validation = validateStubBody(signature, stubBody);
                if (!validation.valid) {
                    throw new Error(validation.reason);
                }
                const header = signature.replace(/\r\n?/g, '\n').trim().replace(/:$/, '').trimEnd();
                const bodyLines = stubBody.split('\n').map(l => l.startsWith('    ') ? l : `    ${l}`);
                code = [`${header}:`, ...bodyLines];
            }

            const inputsChanged = Boolean(existingNode) && (
                JSON.stringify(existingNode!.code) !== JSON.stringify(code)
                || existingNode!.contract !== contract
                || JSON.stringify(existingNode!.context) !== JSON.stringify(context)
                || JSON.stringify(existingNode!.cases ?? []) !== JSON.stringify(cases)
                || JSON.stringify(existingNode!.imports) !== JSON.stringify(imports)
            );
            const verification = existingNode?.verification
                ? (inputsChanged && existingNode.verification.state !== 'untested'
                    ? { ...existingNode.verification, state: 'stale' as const }
                    : existingNode.verification)
                : undefined;

            const node: SlateNode = {
                name: initialNode.name,
                ...(itemLanguage !== 'python' ? { language: itemLanguage } : {}),
                ...(existingNode?.kind !== undefined ? { kind: existingNode.kind } : {}),
                ...(ownerId !== undefined ? { classOwner: ownerId } : {}),
                intent,
                contract,
                context,
                cases,
                ...(existingNode?.check !== undefined ? { check: existingNode.check } : {}),
                ...(verification !== undefined ? { verification } : {}),
                examples: existingNode?.examples ?? [],
                describedBy: existingNode?.describedBy ?? 'human',
                locked: false,
                ...(existingNode?.order !== undefined ? { order: existingNode.order } : {}),
                imports,
                uses: existingNode?.uses ?? [],
                code,
                extra,
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
            const safeSplitFrom = assertSafeNodeId(args.splitFrom);
            const originalPath = pathForNodeId(safeSplitFrom);
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

    /** Tool: slate_define_class */
    async toolDefineClass(args: {
        name?: string;
        signature?: string;
        intent?: string;
        contract?: string;
        decorators?: unknown;
        fields?: unknown;
        imports?: unknown;
        context?: unknown;
        position?: { x: number; y: number };
    }): Promise<Record<string, unknown>> {
        if (!args.name || !args.signature || !args.intent) {
            throw new Error('Must provide name, signature, and intent to define a class frame.');
        }
        const nodeId = assertSafeNodeId(args.name);
        const nodeRelPath = pathForNodeId(nodeId);
        this.assertSafePath(nodeRelPath, NODES_DIR);
        const existingNode = await this.readExistingNode(nodeRelPath);
        if (existingNode?.locked) {
            throw new Error(`Node "${nodeId}" is locked and cannot be modified.`);
        }
        if (existingNode && existingNode.kind !== 'class') {
            throw new Error(`Node "${nodeId}" already exists and is not a class frame.`);
        }
        const decorators = args.decorators !== undefined
            ? (Array.isArray(args.decorators) && args.decorators.every(d => typeof d === 'string')
                ? args.decorators
                : (() => { throw new Error(`Class "${nodeId}" decorators must be an array of strings.`); })())
            : [];
        const fields = args.fields !== undefined
            ? (Array.isArray(args.fields) && args.fields.every(f => typeof f === 'string')
                ? args.fields
                : (() => { throw new Error(`Class "${nodeId}" fields must be an array of strings.`); })())
            : [];
        const frame = classFrameFromHeader(
            args.signature,
            args.intent,
            fields,
            decorators,
            args.contract ?? existingNode?.contract ?? '',
        );
        const leafName = nodeId.split('/').pop() ?? nodeId;
        if (frame.name !== leafName) {
            throw new Error(`Class signature name "${frame.name}" does not match provided node name "${nodeId}".`);
        }
        const imports = args.imports !== undefined
            ? this.normalizeStubImports(args.imports, 'python', nodeId)
            : (existingNode?.imports ?? []);
        const context = args.context !== undefined
            ? (Array.isArray(args.context) && args.context.every(c => typeof c === 'string')
                ? args.context
                : (() => { throw new Error(`Class "${nodeId}" context must be an array of node IDs.`); })())
            : (existingNode?.context ?? []);

        const node: SlateNode = {
            ...frame,
            context,
            examples: existingNode?.examples ?? [],
            describedBy: existingNode?.describedBy ?? 'human',
            locked: false,
            ...(existingNode?.order !== undefined ? { order: existingNode.order } : {}),
            imports,
            uses: existingNode?.uses ?? [],
            extra: { ...(existingNode?.extra ?? {}) },
        };

        await this.writeJsonFile(nodeRelPath, serializeNode(node));

        if (args.position && Number.isFinite(args.position.x) && Number.isFinite(args.position.y)) {
            const layout = await this.readLayout();
            layout.positions[nodeId] = { x: args.position.x, y: args.position.y };
            await this.writeLayout(layout);
        }
        if (this.bridge?.onStubDefined) await this.bridge.onStubDefined(nodeId);

        const meta = extractClassFrameMetadata(node.code);
        return {
            ok: true,
            nodeId,
            kind: 'class',
            bases: meta.bases,
            decorators: meta.decorators,
            fields: meta.fields,
        };
    }

    /** Tool: slate_wire_flow */
    async toolWireFlow(args: {
        flow?: string;
        inputs?: Array<{ name: string; annotation?: string | null }>;
        outputs?: Array<{ name: string; annotation?: string | null }>;
        instances?: Array<{ id: string; node?: string; kind?: 'value'; value?: string; position?: { x: number; y: number } }>;
        wires?: Array<{ from: string; to: string }>;
        disconnect?: Array<{ from: string; to: string }>;
        removeInstances?: string[];
    }): Promise<Record<string, unknown>> {
        const flowId = assertSafeFlowId(args.flow || MAIN_FLOW);
        const flowRelPath = pathForFlowId(flowId);
        this.assertSafePath(flowRelPath, 'slate/flows');
        let flow: SlateFlow;

        const rawFlow = await this.readTextIfExists(flowRelPath);
        if (rawFlow === null) {
            const flowName = flowId.includes('/') ? flowId.slice(flowId.lastIndexOf('/') + 1) : flowId;
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(flowName)) {
                throw new Error(`Invalid flow identifier "${flowName}" derived from flow ID "${flowId}".`);
            }
            flow = emptyFlow(flowName);
        } else {
            try {
                flow = parseFlow(rawFlow);
            } catch (error) {
                throw new Error(`Existing flow file "${flowRelPath}" is invalid and was not modified: ${(error as Error).message}`);
            }
        }

        if (args.inputs !== undefined) {
            const nextInputs = this.normalizeFlowPortsArg(args.inputs, 'inputs');
            const validInputNames = new Set(nextInputs.map(p => p.name));
            flow = {
                ...flow,
                inputs: nextInputs,
                wires: flow.wires.filter(w => {
                    const fromEp = parseEndpoint(w.from);
                    if (fromEp.instance !== null || !fromEp.port.startsWith('input:')) return true;
                    return validInputNames.has(fromEp.port.slice('input:'.length));
                }),
            };
        }
        if (args.outputs !== undefined) {
            const nextOutputs = this.normalizeFlowPortsArg(args.outputs, 'outputs');
            const validOutputNames = new Set(nextOutputs.map(p => p.name));
            flow = {
                ...flow,
                outputs: nextOutputs,
                wires: flow.wires.filter(w => {
                    const toEp = parseEndpoint(w.to);
                    if (toEp.instance !== null || !toEp.port.startsWith('output:')) return true;
                    return validOutputNames.has(toEp.port.slice('output:'.length));
                }),
            };
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
                const existing = existingIdx >= 0 ? flow.instances[existingIdx] : undefined;
                let nextInst: FlowInstance;
                if (existing) {
                    // Preserve the existing instance unless the caller explicitly changes it.
                    nextInst = { ...existing } as FlowInstance;
                    if (inst.kind === 'value') {
                        nextInst = { id: inst.id, kind: 'value', value: inst.value ?? ('value' in existing ? (existing as { value?: string }).value ?? '0' : '0') } as FlowInstance;
                    } else if (inst.node) {
                        nextInst = { id: inst.id, node: inst.node } as FlowInstance;
                    } else if ('kind' in existing && (existing as { kind?: string }).kind === 'value' && inst.value !== undefined) {
                        (nextInst as { value?: string }).value = inst.value;
                    }
                } else if (inst.kind === 'value') {
                    nextInst = { id: inst.id, kind: 'value', value: inst.value ?? '0' };
                } else {
                    nextInst = { id: inst.id, node: inst.node || inst.id };
                }

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
                if (fromEp.instance === null) {
                    if (!fromEp.port.startsWith('input:')) {
                        throw new Error(`Wire source "${from}" must originate from an instance port or "input:<port>".`);
                    }
                    const portName = fromEp.port.slice('input:'.length);
                    if (!flow.inputs.some(p => p.name === portName)) {
                        throw new Error(`Flow input port "${portName}" does not exist in flow "${flowId}". Declare it in "inputs" before wiring.`);
                    }
                } else if (!flow.instances.some(i => i.id === fromEp.instance)) {
                    throw new Error(`Instance "${fromEp.instance}" does not exist in flow "${flowId}". Define or add the instance before connecting wires.`);
                }
                if (toEp.instance === null) {
                    if (!toEp.port.startsWith('output:')) {
                        throw new Error(`Wire destination "${to}" must target an instance port or "output:<port>".`);
                    }
                    const portName = toEp.port.slice('output:'.length);
                    if (!flow.outputs.some(p => p.name === portName)) {
                        throw new Error(`Flow output port "${portName}" does not exist in flow "${flowId}". Declare it in "outputs" before wiring.`);
                    }
                } else if (!flow.instances.some(i => i.id === toEp.instance)) {
                    throw new Error(`Instance "${toEp.instance}" does not exist in flow "${flowId}". Define or add the instance before connecting wires.`);
                }
                flow = connect(flow, from, to);
            }
        }

        const serializedFlow = serializeFlow(flow);
        parseFlow(serializedFlow);
        await this.writeJsonFile(flowRelPath, serializedFlow);
        if (layoutChanged) {
            await this.writeLayout(layout);
        }

        if (this.bridge?.onFlowWired) await this.bridge.onFlowWired(flowId);

        return {
            ok: true,
            flow: flow.name,
            inputs: flow.inputs,
            outputs: flow.outputs,
            instances: flow.instances,
            wires: flow.wires,
        };
    }

    private assertNoSecretArgs(args: Record<string, unknown>, toolName: string): void {
        const forbidden = new Set(['apikey', 'api_key', 'token', 'secret', 'authorization']);
        for (const key of Object.keys(args)) {
            if (forbidden.has(key.toLowerCase())) {
                throw new Error(`Raw API keys are rejected in ${toolName}; pass "apiKeyEnv" with an environment variable name instead.`);
            }
        }
    }

    private parseEnvVarArg(raw: unknown): string | undefined {
        if (raw === undefined) return undefined;
        if (typeof raw !== 'string') {
            throw new Error('apiKeyEnv must be an environment variable name string.');
        }
        const trimmed = raw.trim();
        if (!trimmed) return undefined;
        if (/^(?:sk-|bearer\s+)/i.test(trimmed) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
            throw new Error('apiKeyEnv must be an environment variable name (e.g. "OPENROUTER_API_KEY"), not a raw API key.');
        }
        return trimmed;
    }

    private parseProviderArg(raw: unknown): SlateLlmProvider | undefined {
        if (raw === undefined) return undefined;
        const allowed = new Set<SlateLlmProvider>(['llama.cpp', 'ollama', 'openrouter', 'openai-compatible']);
        if (typeof raw !== 'string' || !allowed.has(raw as SlateLlmProvider)) {
            throw new Error('provider must be one of "llama.cpp", "ollama", "openrouter", or "openai-compatible".');
        }
        return raw as SlateLlmProvider;
    }

    private async readProjectLlm(): Promise<SlateLlmConfig | undefined> {
        const raw = await this.readTextIfExists(CONFIG_PATH);
        if (raw === null) return undefined;
        try {
            return parseConfig(raw).llm;
        } catch {
            return undefined;
        }
    }

    /** Tool: slate_llm_status */
    async toolLlmStatus(args: { endpoint?: string; timeoutMs?: number }): Promise<Record<string, unknown>> {
        const projectLlm = await this.readProjectLlm();
        const bridgeConfig = this.bridge?.getLlamaConfig ? this.bridge.getLlamaConfig() : undefined;
        const override = typeof args.endpoint === 'string' && args.endpoint.trim()
            ? { endpoint: args.endpoint.trim() }
            : undefined;
        const resolved = resolveLlmConfig(projectLlm, bridgeConfig, process.env, override);
        validateLlmEndpointUrl(resolved.endpoint);
        const access = evaluateProjectCredentialAccess({
            projectLlm,
            override,
            fallback: bridgeConfig,
            resolved,
            isTrusted: this.isWorkspaceTrusted(),
            approvedPairings: this.getApprovedCredentialPairings(),
        });
        if (!access.allowRequest) {
            throw new Error(access.reason ?? 'Workspace is not trusted; refusing request to configured LLM endpoint.');
        }
        if (access.requiresApproval && !access.allowCredential) {
            throw new Error(access.reason ?? 'Explicit approval required before sending credentials to configured LLM endpoint.');
        }
        const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 3000;
        const health = await checkLlamaHealth(
            resolved.endpoint,
            resolved.model,
            timeoutMs,
            resolved.apiKey ? { apiKey: resolved.apiKey } : undefined,
        );
        return {
            ok: health.ok,
            provider: resolved.provider,
            endpoint: resolved.endpoint,
            model: resolved.model,
            ...(resolved.apiKeyEnv ? { apiKeyEnv: resolved.apiKeyEnv } : {}),
            hasApiKey: resolved.hasApiKey,
            statusText: health.statusText,
            models: health.models ?? [],
        };
    }

    /** Tool: slate_configure_llm */
    async toolConfigureLlm(args: Record<string, unknown> & {
        provider?: string;
        endpoint?: string;
        model?: string;
        apiKeyEnv?: string;
        concurrency?: number;
        outputTokens?: number;
        contextWindow?: number;
        timeoutSeconds?: number;
        writeToProject?: boolean;
    }): Promise<Record<string, unknown>> {
        this.assertNoSecretArgs(args, 'slate_configure_llm');
        const provider = this.parseProviderArg(args.provider);
        const apiKeyEnv = this.parseEnvVarArg(args.apiKeyEnv);

        let endpoint: string;
        if (typeof args.endpoint === 'string' && args.endpoint.trim()) {
            const trimmed = args.endpoint.trim();
            validateLlmEndpointUrl(trimmed);
            endpoint = trimmed;
        } else if (provider) {
            endpoint = resolveLlmConfig({ provider }).endpoint;
            validateLlmEndpointUrl(endpoint);
        } else {
            throw new Error('A valid HTTP/HTTPS endpoint URL is required (e.g. "http://127.0.0.1:8080").');
        }

        const effectiveProvider = provider ?? inferProviderFromEndpoint(endpoint);
        const model = typeof args.model === 'string' && args.model.trim()
            ? args.model.trim()
            : (effectiveProvider === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : 'local');
        const timeoutSeconds = typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : 120;
        const concurrency = typeof args.concurrency === 'number' ? args.concurrency : undefined;
        const outputTokens = typeof args.outputTokens === 'number' ? args.outputTokens : undefined;
        const contextWindow = typeof args.contextWindow === 'number' ? args.contextWindow : undefined;

        const existingProjectLlm = await this.readProjectLlm();
        const bridgeConfig = this.bridge?.getLlamaConfig ? this.bridge.getLlamaConfig() : undefined;
        const callOverride: LlmConfigInput = {
            ...(provider ? { provider } : {}),
            endpoint,
            model,
            ...(typeof args.timeoutSeconds === 'number' ? { timeoutSeconds } : {}),
            ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
            ...(concurrency !== undefined ? { concurrency } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            ...(contextWindow !== undefined ? { contextWindow } : {}),
        };
        const candidateProjectLlm: SlateLlmConfig | undefined = args.writeToProject === true
            ? {
                ...(existingProjectLlm ?? {}),
                ...(provider ? { provider } : {}),
                endpoint,
                model,
                ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
                ...(concurrency !== undefined ? { concurrency } : {}),
                ...(outputTokens !== undefined ? { outputTokens } : {}),
                ...(contextWindow !== undefined ? { contextWindow } : {}),
                ...(typeof args.timeoutSeconds === 'number' ? { timeoutSeconds } : {}),
            }
            : existingProjectLlm;

        const precheckResolved = resolveLlmConfig(candidateProjectLlm, bridgeConfig, process.env, callOverride);
        validateLlmEndpointUrl(precheckResolved.endpoint);
        const access = evaluateProjectCredentialAccess({
            projectLlm: candidateProjectLlm,
            override: callOverride,
            fallback: bridgeConfig,
            resolved: precheckResolved,
            isTrusted: this.isWorkspaceTrusted(),
            approvedPairings: this.getApprovedCredentialPairings(),
        });
        if (!access.allowRequest) {
            throw new Error(access.reason ?? 'Workspace is not trusted; refusing request to configured LLM endpoint.');
        }
        if (access.requiresApproval && !access.allowCredential) {
            throw new Error(access.reason ?? 'Explicit approval required before sending credentials to configured LLM endpoint.');
        }

        let wroteToProject = false;
        let projectLlm = existingProjectLlm;
        if (args.writeToProject === true) {
            const rawConfig = await this.readTextIfExists(CONFIG_PATH);
            if (rawConfig === null) {
                throw new Error(`Cannot persist llm configuration: "${CONFIG_PATH}" does not exist.`);
            }
            const config = parseConfig(rawConfig);
            const nextLlm: SlateLlmConfig = {
                ...(config.llm ?? {}),
                ...(provider ? { provider } : {}),
                endpoint,
                model,
                ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
                ...(concurrency !== undefined ? { concurrency } : {}),
                ...(outputTokens !== undefined ? { outputTokens } : {}),
                ...(contextWindow !== undefined ? { contextWindow } : {}),
                ...(typeof args.timeoutSeconds === 'number' ? { timeoutSeconds } : {}),
            };
            config.llm = nextLlm;
            const serialized = serializeConfig(config);
            parseConfig(serialized);
            await this.writeJsonFile(CONFIG_PATH, serialized);
            projectLlm = nextLlm;
            wroteToProject = true;
        }

        if (this.bridge?.setLlamaConfig) {
            await this.bridge.setLlamaConfig({
                ...(provider ? { provider } : {}),
                endpoint,
                model,
                timeoutSeconds,
                ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
                ...(concurrency !== undefined ? { concurrency } : {}),
                ...(outputTokens !== undefined ? { outputTokens } : {}),
                ...(contextWindow !== undefined ? { contextWindow } : {}),
            });
        }

        const resolved = resolveLlmConfig(
            projectLlm,
            this.bridge?.getLlamaConfig ? this.bridge.getLlamaConfig() : undefined,
            process.env,
            callOverride,
        );
        const health = await checkLlamaHealth(
            resolved.endpoint,
            resolved.model,
            3000,
            resolved.apiKey ? { apiKey: resolved.apiKey } : undefined,
        );
        return {
            updated: true,
            ...(wroteToProject ? { writeToProject: true } : {}),
            provider: resolved.provider,
            endpoint: resolved.endpoint,
            model: resolved.model,
            ...(resolved.apiKeyEnv ? { apiKeyEnv: resolved.apiKeyEnv } : {}),
            hasApiKey: resolved.hasApiKey,
            reachable: health.ok,
            statusText: health.statusText,
            models: health.models ?? [],
        };
    }

    /** Tool: slate_forge_batch */
    async toolForgeBatch(args: Record<string, unknown> & {
        nodeIds?: string[];
        allStubs?: boolean;
        concurrency?: number;
        maxRevisions?: number;
        verify?: boolean;
        write?: boolean;
        overwrite?: boolean;
        provider?: string;
        endpoint?: string;
        model?: string;
        apiKeyEnv?: string;
        timeoutSeconds?: number;
        outputTokens?: number;
        verbose?: boolean;
    }): Promise<Record<string, unknown>> {
        this.assertNoSecretArgs(args, 'slate_forge_batch');
        const provider = this.parseProviderArg(args.provider);
        const apiKeyEnv = this.parseEnvVarArg(args.apiKeyEnv);

        let endpoint: string | undefined;
        if (typeof args.endpoint === 'string' && args.endpoint.trim()) {
            const trimmed = args.endpoint.trim();
            validateLlmEndpointUrl(trimmed);
            endpoint = trimmed;
        }

        const hasLlmOverride = Boolean(
            provider || endpoint || args.model || apiKeyEnv
            || typeof args.timeoutSeconds === 'number' || typeof args.outputTokens === 'number',
        );
        const llmOverride: LlmConfigInput | undefined = hasLlmOverride
            ? {
                ...(provider ? { provider } : {}),
                ...(endpoint ? { endpoint } : {}),
                ...(typeof args.model === 'string' && args.model.trim() ? { model: args.model.trim() } : {}),
                ...(apiKeyEnv ? { apiKeyEnv } : {}),
                ...(typeof args.timeoutSeconds === 'number' ? { timeoutSeconds: args.timeoutSeconds } : {}),
                ...(typeof args.outputTokens === 'number' ? { outputTokens: args.outputTokens } : {}),
            }
            : undefined;

        const result = await batchForgeWorkspace({
            workspaceRoot: this.workspaceRoot,
            nodeIds: Array.isArray(args.nodeIds) ? args.nodeIds.filter((x): x is string => typeof x === 'string') : undefined,
            allStubs: typeof args.allStubs === 'boolean' ? args.allStubs : undefined,
            concurrency: typeof args.concurrency === 'number' ? args.concurrency : undefined,
            maxRevisions: typeof args.maxRevisions === 'number' ? args.maxRevisions : undefined,
            verify: typeof args.verify === 'boolean' ? args.verify : undefined,
            write: typeof args.write === 'boolean' ? args.write : undefined,
            overwrite: typeof args.overwrite === 'boolean' ? args.overwrite : undefined,
            isTrusted: this.isWorkspaceTrusted(),
            approvedCredentialPairings: this.getApprovedCredentialPairings(),
            fallbackLlm: this.bridge?.getLlamaConfig ? this.bridge.getLlamaConfig() : undefined,
            llmOverride,
            onNodeForged: this.bridge?.onStubDefined
                ? async nodeId => { await this.bridge!.onStubDefined!(nodeId); }
                : undefined,
        });

        if (args.verbose === true) {
            return result as unknown as Record<string, unknown>;
        }
        return compactBatchForgeResult(result);
    }

    /** Tool: slate_references */
    async toolReferences(args: { nodeId?: string }): Promise<Record<string, unknown>> {
        const configText = await this.readTextIfExists(CONFIG_PATH);
        const defaultLanguage = configText ? parseConfig(configText).language : 'python';
        const layout = await this.readLayout();

        const nodeFiles = await this.findNodeFiles();
        const documents: HarnessDocument[] = [];
        const docById = new Map<string, HarnessDocument>();
        const nodesById = new Map<string, SlateNode>();

        for (const file of nodeFiles) {
            const id = nodeIdForPath(file);
            if (!id) continue;
            try {
                const text = await fs.readFile(this.absPath(file), 'utf8');
                const indexed = indexNode(file, text, defaultLanguage, null);
                documents.push(indexed.document);
                docById.set(id, indexed.document);
                if (indexed.node) {
                    nodesById.set(id, indexed.node);
                }
            } catch {
                // Skip unreadable nodes while building the reference graph
            }
        }

        const flowFiles = await this.findFlowFiles();
        const flows: HarnessFlow[] = [];
        for (const file of flowFiles) {
            const id = flowIdForPath(file);
            if (!id) continue;
            try {
                const text = await fs.readFile(this.absPath(file), 'utf8');
                flows.push({ id, flow: parseFlow(text) });
            } catch {
                // Skip unreadable flow files
            }
        }

        const shortNameToIds = new Map<string, string[]>();
        for (const [id, node] of nodesById.entries()) {
            const keys = new Set<string>([node.name, id.split('/').pop() ?? id]);
            for (const key of keys) {
                const list = shortNameToIds.get(key) ?? [];
                if (!list.includes(id)) list.push(id);
                shortNameToIds.set(key, list);
            }
        }

        const effectiveUsesById = new Map<string, string[]>();
        for (const [id, doc] of docById.entries()) {
            const node = nodesById.get(id);
            const resolvedUses = new Set<string>(doc.uses ?? node?.uses ?? []);
            const lang = tryNormalizeLanguage(node?.language ?? defaultLanguage) ?? 'python';
            if (lang === 'typescript' || lang === 'javascript' || lang === 'python') {
                const names = lang === 'python'
                    ? identifierNames(`${doc.source}\n`)
                    : tsIdentifierNames(`${doc.source}\n`);
                const contextSet = new Set<string>(node?.context ?? []);
                for (const ident of names) {
                    const candidates = shortNameToIds.get(ident);
                    if (!candidates || candidates.length === 0) continue;
                    const nonSelf = candidates.filter(c => c !== id);
                    if (nonSelf.length === 1) {
                        resolvedUses.add(nonSelf[0]);
                    } else if (nonSelf.length > 1) {
                        for (const c of nonSelf) {
                            if (contextSet.has(c)) resolvedUses.add(c);
                        }
                    }
                }
            }
            const sortedUses = Array.from(resolvedUses).sort();
            doc.uses = sortedUses;
            effectiveUsesById.set(id, sortedUses);
        }

        const usageIndex = buildUsageIndex(documents, flows, layout.refs);

        if (args.nodeId !== undefined) {
            const targetId = args.nodeId.trim();
            if (!targetId) {
                throw new Error('nodeId must be a non-empty string when provided.');
            }
            const node = nodesById.get(targetId);
            const doc = docById.get(targetId);
            const usage = usageIndex[targetId];
            if (!node && !doc && !usage) {
                throw new Error(`Node "${targetId}" was not found in "${NODES_DIR}".`);
            }
            const directUses = effectiveUsesById.get(targetId) ?? doc?.uses ?? node?.uses ?? [];
            const dependsOn = Array.from(new Set([
                ...directUses,
                ...(node?.uses ?? []),
                ...(node?.context ?? []),
            ]));
            return {
                nodeId: targetId,
                language: node?.language ?? defaultLanguage,
                uses: directUses,
                dependsOn,
                usedBy: usage?.callSites ?? [],
                contextUsers: usage?.contextUsers ?? [],
                totalUses: usage?.totalUses ?? 0,
                instanceCount: usage?.instanceCount ?? 0,
                dependencyCount: usage?.dependencyCount ?? 0,
                contextCount: usage?.contextCount ?? 0,
                usage: usage ?? null,
            };
        }

        const nodes = Object.values(usageIndex)
            .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
            .map(entry => ({
                nodeId: entry.nodeId,
                language: nodesById.get(entry.nodeId)?.language ?? defaultLanguage,
                uses: docById.get(entry.nodeId)?.uses ?? nodesById.get(entry.nodeId)?.uses ?? [],
                totalUses: entry.totalUses,
                instanceCount: entry.instanceCount,
                dependencyCount: entry.dependencyCount,
                contextCount: entry.contextCount,
            }));

        return {
            totalNodes: nodes.length,
            nodes,
        };
    }

    /** Recursively read existing files inside a directory into a map keyed by forward-slash relative path. */
    private async readExistingDirectoryFiles(dir: string): Promise<Map<string, string>> {
        const files = new Map<string, string>();
        const scan = async (current: string) => {
            let entries: string[];
            try {
                entries = await fs.readdir(current);
            } catch {
                return;
            }
            for (const entry of entries) {
                const full = path.join(current, entry);
                try {
                    const stat = await fs.lstat(full);
                    if (stat.isSymbolicLink()) continue;
                    if (stat.isDirectory()) {
                        await scan(full);
                    } else if (stat.isFile()) {
                        const rel = path.relative(dir, full).replace(/\\/g, '/');
                        files.set(rel, await fs.readFile(full, 'utf8'));
                    }
                } catch {
                    // Ignore unreadable entries
                }
            }
        };
        await scan(dir);
        return files;
    }

    /** Tool: slate_compile */
    async toolCompile(args: { outDir?: string; dryRun?: boolean }): Promise<Record<string, unknown>> {
        const configText = await this.readTextIfExists(CONFIG_PATH);
        if (!configText) {
            throw new Error(`Missing "${CONFIG_PATH}"; initialize or configure a Slate project first.`);
        }
        const config: SlateConfig = parseConfig(configText);

        const targetRelRaw = (args.outDir ?? config.compile?.outDir ?? 'out').trim() || 'out';
        const { normalizedOutDir, resolvedOut, realOut } = await assertSafeCompileOutDir(this.workspaceRoot, targetRelRaw);

        const diagnostics: Array<{ severity: 'error' | 'warning'; message: string }> = [];
        const nodes = new Map<string, SlateNode>();
        for (const file of await this.findNodeFiles()) {
            const id = nodeIdForPath(file);
            if (!id) continue;
            try {
                const text = await fs.readFile(this.absPath(file), 'utf8');
                nodes.set(id, parseNode(text));
            } catch (error) {
                diagnostics.push({
                    severity: 'error',
                    message: `Invalid node "${file}": ${error instanceof Error ? error.message : String(error)}`,
                });
            }
        }

        const flows = new Map<string, SlateFlow>();
        for (const file of await this.findFlowFiles()) {
            const id = flowIdForPath(file);
            if (!id) continue;
            try {
                const text = await fs.readFile(this.absPath(file), 'utf8');
                flows.set(id, parseFlow(text));
            } catch (error) {
                diagnostics.push({
                    severity: 'error',
                    message: `Invalid flow "${file}": ${error instanceof Error ? error.message : String(error)}`,
                });
            }
        }

        const existingFiles = await this.readExistingDirectoryFiles(resolvedOut);
        const compiled = compileProjectForLanguage(nodes, config, flows, new Map(), existingFiles);
        diagnostics.push(...compiled.diagnostics);

        const normalizedFiles = new Map<string, string>();
        const seenCaseKeys = new Map<string, string>();
        for (const [relFile, content] of compiled.files.entries()) {
            const normRel = normalizeCompileOutputPath(relFile);
            if (!normRel) {
                diagnostics.push({
                    severity: 'error',
                    message: `Refusing unsafe output path "${relFile}" outside "${normalizedOutDir}".`,
                });
                continue;
            }
            if (normalizedFiles.has(normRel)) {
                diagnostics.push({
                    severity: 'error',
                    message: `Refusing duplicate output destination "${normRel}" from "${relFile}".`,
                });
                continue;
            }
            const caseKey = caseCollisionKey(normRel);
            const priorCase = seenCaseKeys.get(caseKey);
            if (priorCase) {
                diagnostics.push({
                    severity: 'error',
                    message: `Refusing case-colliding output destination "${normRel}" (conflicts with "${priorCase}").`,
                });
                continue;
            }
            seenCaseKeys.set(caseKey, normRel);
            const absOut = path.resolve(resolvedOut, normRel);
            const relCheck = path.relative(resolvedOut, absOut);
            if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
                diagnostics.push({
                    severity: 'error',
                    message: `Refusing to write output path "${relFile}" outside "${normalizedOutDir}".`,
                });
                continue;
            }
            try {
                await assertPathInsideRealDir(realOut, absOut, false);
            } catch {
                diagnostics.push({
                    severity: 'error',
                    message: `Refusing output path "${relFile}" escaping "${normalizedOutDir}" via symlink.`,
                });
                continue;
            }
            let existingContent = existingFiles.get(normRel);
            if (existingContent === undefined) {
                try {
                    existingContent = await fs.readFile(absOut, 'utf8');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                        diagnostics.push({
                            severity: 'error',
                            message: `Cannot inspect existing destination "${normRel}": ${(error as Error).message}`,
                        });
                        continue;
                    }
                }
            }
            if (existingContent !== undefined && !isSlateGeneratedContent(existingContent)) {
                const alreadyFlagged = diagnostics.some(d => d.severity === 'error' && (d.message.includes(normRel) || d.message.includes(relFile)));
                if (!alreadyFlagged) {
                    diagnostics.push({
                        severity: 'error',
                        message: `Refusing to overwrite existing non-generated file "${normRel}" (missing Slate generated header).`,
                    });
                }
            }
            normalizedFiles.set(normRel, content);
        }

        const dryRun = args.dryRun === true;
        const hasErrors = diagnostics.some(d => d.severity === 'error');
        const generatedPaths = Array.from(normalizedFiles.keys()).sort();
        const writtenFiles: string[] = [];
        const removedFiles: string[] = [];

        if (!dryRun && !hasErrors) {
            await fs.mkdir(resolvedOut, { recursive: true });
            const resolvedRealOut = await fs.realpath(resolvedOut);
            for (const [prevRel, prevContent] of existingFiles.entries()) {
                if (!seenCaseKeys.has(caseCollisionKey(prevRel)) && isSlateGeneratedContent(prevContent)) {
                    const prevAbs = path.resolve(resolvedOut, prevRel);
                    const prevRelCheck = path.relative(resolvedOut, prevAbs);
                    if (prevRelCheck && !prevRelCheck.startsWith('..') && !path.isAbsolute(prevRelCheck)) {
                        await assertPathInsideRealDir(resolvedRealOut, prevAbs, false);
                        await fs.unlink(prevAbs);
                        removedFiles.push(prevRel);
                    }
                }
            }
            for (const relFile of generatedPaths) {
                const absOut = path.resolve(resolvedOut, relFile);
                await assertPathInsideRealDir(resolvedRealOut, absOut, false);
                await fs.mkdir(path.dirname(absOut), { recursive: true });
                await fs.writeFile(absOut, normalizedFiles.get(relFile)!, 'utf8');
                writtenFiles.push(relFile);
            }
        }

        return {
            ok: !hasErrors,
            language: config.language,
            outDir: normalizedOutDir,
            dryRun,
            fileCount: normalizedFiles.size,
            files: generatedPaths,
            writtenFiles,
            removedFiles: removedFiles.sort(),
            diagnostics,
        };
    }

    /** Tool: slate_verify_ci */
    async toolVerifyCi(args: Record<string, unknown> & {
        srcRoots?: unknown;
        testRoots?: unknown;
        requireTests?: unknown;
    }): Promise<Record<string, unknown>> {
        const parseRootsArg = (raw: unknown, label: string): string[] | undefined => {
            if (raw === undefined) return undefined;
            if (!Array.isArray(raw) || !raw.every((item): item is string => typeof item === 'string')) {
                throw new Error(`${label} must be an array of relative path strings.`);
            }
            return raw;
        };
        const srcRoots = parseRootsArg(args.srcRoots, 'srcRoots');
        const testRoots = parseRootsArg(args.testRoots, 'testRoots');
        let requireTests: boolean | undefined;
        if (args.requireTests !== undefined) {
            if (typeof args.requireTests !== 'boolean') {
                throw new Error('requireTests must be a boolean.');
            }
            requireTests = args.requireTests;
        }
        const report = verifyProjectCi(this.workspaceRoot, {
            ...(srcRoots ? { srcRoots } : {}),
            ...(testRoots ? { testRoots } : {}),
            ...(requireTests !== undefined ? { requireTests } : {}),
        });
        return report as unknown as Record<string, unknown>;
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
                case 'slate_define_class':
                    result = await this.runSerialized(() => this.toolDefineClass(args as any));
                    break;
                case 'slate_wire_flow':
                    result = await this.runSerialized(() => this.toolWireFlow(args));
                    break;
                case 'slate_llm_status':
                    result = await this.toolLlmStatus(args);
                    break;
                case 'slate_configure_llm':
                    result = await this.runSerialized(() => this.toolConfigureLlm(args as any));
                    break;
                case 'slate_forge_batch':
                    result = await this.runSerialized(() => this.toolForgeBatch(args as any));
                    break;
                case 'slate_references':
                    result = await this.toolReferences(args as any);
                    break;
                case 'slate_compile':
                    result = await this.runSerialized(() => this.toolCompile(args as any));
                    break;
                case 'slate_verify_ci':
                    result = await this.toolVerifyCi(args);
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

export interface SlateMcpCliIo {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    cwd?: string;
}

const SLATE_MCP_CLI_HELP = [
    'Usage: slate_mcp_server [--workspace <dir>] [--trust-workspace] [--approve-llm-pairing <endpoint|env:VAR>] [--list-tools | --call <tool> [--args <json> | --args-file <path>]]',
    '',
    'Options:',
    '  --workspace <dir>                   Workspace root directory (defaults to current working directory)',
    '  --trust-workspace                   Mark the target workspace trusted for executing forged checks and configured endpoints (or set SLATE_TRUST_WORKSPACE=1)',
    '  --approve-llm-pairing <pairing>     Approve a specific <normalized-endpoint>|<env:VAR|secret-storage> pairing (repeatable)',
    '  --list-tools                        Print available MCP tools as JSON and exit',
    '  --call <tool>                       Invoke a single MCP tool one-shot and print JSON result',
    '  --args <json>                       Inline JSON object of arguments for --call',
    '  --args-file <path>                  Path to JSON file containing arguments for --call',
    '  -h, --help                          Show this help message and exit',
    '',
    'With no action flag, starts the stdio JSON-RPC 2.0 MCP server.',
].join('\n');

/** Executes the standalone CLI or stdio MCP server entrypoint and returns a process exit code. */
export async function runSlateMcpCli(
    argv: readonly string[],
    io: SlateMcpCliIo = {
        stdout: text => { process.stdout.write(text); },
        stderr: text => { process.stderr.write(text); },
        cwd: process.cwd(),
    },
): Promise<number> {
    const baseCwd = io.cwd ?? process.cwd();
    let workspaceDir = path.resolve(baseCwd);
    let showHelp = false;
    let listTools = false;
    let trustWorkspace = process.env.SLATE_TRUST_WORKSPACE === '1';
    const approvedPairings: string[] = [];
    let callToolName: string | undefined;
    let inlineArgsJson: string | undefined;
    let argsFilePath: string | undefined;

    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--help' || flag === '-h') {
            showHelp = true;
        } else if (flag === '--list-tools') {
            listTools = true;
        } else if (flag === '--trust-workspace') {
            trustWorkspace = true;
        } else if (flag === '--approve-llm-pairing') {
            if (!argv[i + 1]) {
                io.stderr('Error: --approve-llm-pairing requires an endpoint|credential pairing value.\n');
                return 1;
            }
            const rawPairing = argv[++i];
            const sepIdx = rawPairing.lastIndexOf('|');
            if (sepIdx <= 0) {
                io.stderr('Error: --approve-llm-pairing must be formatted as <endpoint>|<env:VAR|secret-storage>.\n');
                return 1;
            }
            const ep = rawPairing.slice(0, sepIdx);
            const cred = rawPairing.slice(sepIdx + 1);
            const envName = cred.startsWith('env:') ? cred.slice(4) : undefined;
            approvedPairings.push(credentialPairingKey(ep, envName));
        } else if (flag === '--workspace') {
            if (!argv[i + 1]) {
                io.stderr('Error: --workspace requires a directory path.\n');
                return 1;
            }
            workspaceDir = path.resolve(baseCwd, argv[++i]);
        } else if (flag === '--call') {
            if (!argv[i + 1]) {
                io.stderr('Error: --call requires a tool name.\n');
                return 1;
            }
            callToolName = argv[++i];
        } else if (flag === '--args') {
            if (argv[i + 1] === undefined) {
                io.stderr('Error: --args requires a JSON string.\n');
                return 1;
            }
            inlineArgsJson = argv[++i];
        } else if (flag === '--args-file') {
            if (!argv[i + 1]) {
                io.stderr('Error: --args-file requires a file path.\n');
                return 1;
            }
            argsFilePath = argv[++i];
        } else {
            io.stderr(`Unknown argument: "${flag}". Run with --help for usage.\n`);
            return 1;
        }
    }

    if (showHelp) {
        io.stdout(`${SLATE_MCP_CLI_HELP}\n`);
        return 0;
    }

    if (listTools) {
        io.stdout(`${JSON.stringify(MCP_TOOLS.map(t => ({ name: t.name, description: t.description })), null, 2)}\n`);
        return 0;
    }

    if (callToolName !== undefined) {
        if (inlineArgsJson !== undefined && argsFilePath !== undefined) {
            io.stderr('Error: pass either --args or --args-file, not both.\n');
            return 1;
        }
        let rawJson: string | undefined = inlineArgsJson;
        if (argsFilePath) {
            try {
                rawJson = await fs.readFile(path.resolve(baseCwd, argsFilePath), 'utf8');
            } catch (err) {
                io.stderr(`Error reading --args-file "${argsFilePath}": ${(err as Error).message}\n`);
                return 1;
            }
        }
        let parsedArgs: Record<string, unknown> = {};
        if (rawJson !== undefined) {
            try {
                const candidate = JSON.parse(rawJson);
                if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
                    io.stderr('Error: tool arguments JSON must be an object.\n');
                    return 1;
                }
                parsedArgs = candidate as Record<string, unknown>;
            } catch (err) {
                io.stderr(`Error parsing tool arguments JSON: ${(err as Error).message}\n`);
                return 1;
            }
        }

        const server = new SlateMcpServer(workspaceDir, undefined, {
            isTrusted: trustWorkspace,
            approvedCredentialPairings: approvedPairings,
        });
        try {
            const response = await server.handleRequest({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: callToolName, arguments: parsedArgs },
            });
            if (!response) {
                io.stderr('Error: empty response from MCP server.\n');
                return 1;
            }
            if ('error' in response) {
                io.stderr(`${JSON.stringify(response.error, null, 2)}\n`);
                return 1;
            }
            const toolResult = response.result as McpToolCallResult;
            const text = toolResult?.content?.[0]?.text ?? JSON.stringify(toolResult);
            if (toolResult?.isError) {
                io.stderr(`${text}\n`);
                return 1;
            }
            io.stdout(`${text}\n`);
            return 0;
        } finally {
            server.close();
        }
    }

    const server = new SlateMcpServer(workspaceDir, undefined, {
        isTrusted: trustWorkspace,
        approvedCredentialPairings: approvedPairings,
    });
    server.startStdio();
    return 0;
}

// Standalone CLI execution
if (require.main === module) {
    runSlateMcpCli(process.argv.slice(2)).then(code => {
        if (code !== 0) process.exitCode = code;
    }).catch(err => {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
    });
}
