import { parser } from '@lezer/python';
import type { SyntaxNode } from '@lezer/common';
import * as ts from 'typescript';

import { checkCppNodeCode, parseCppModule } from './cpp_adapter';
import { checkCSharpNodeCode, parseCSharpModule } from './csharp_adapter';
import type { BoardNote, CanvasRef, HarnessDocument, NodeVerificationResult, ParseModuleResult, Placeholder, Point } from './harness_protocol';
import {
    codeLines,
    codeText,
    FORMAT_VERSION,
    SlateFormatError,
    tryNormalizeLanguage,
    type Jpl60CheckResult,
} from './language_types';
import { parseModule } from './python_adapter';
import { parseProseModule } from './prose_adapter';
import { checkTsNodeCode, parseTsModule, scriptKindForPath } from './ts_adapter';

export {
    codeLines,
    codeText,
    FORMAT_VERSION,
    SlateFormatError,
    type Jpl60CheckResult,
};

// The decoupled `slate/` folder: slate.json, layout.json, and one JSON file per
// node under nodes/. See SLATE_HARNESS_PLAN.md → "Workspace format".

export const SLATE_DIR = 'slate';
export const NODES_DIR = `${SLATE_DIR}/nodes`;
export const CONFIG_PATH = `${SLATE_DIR}/slate.json`;
export const LAYOUT_PATH = `${SLATE_DIR}/layout.json`;

export type SlateLlmProvider = 'llama.cpp' | 'ollama' | 'openrouter' | 'openai-compatible';

export interface SlateLlmConfig {
    provider?: SlateLlmProvider;
    endpoint?: string;
    model?: string;
    apiKeyEnv?: string;
    concurrency?: number;
    timeoutSeconds?: number;
    outputTokens?: number;
    contextWindow?: number;
}

export interface SlateConfig {
    slate: 3;
    name: string;
    language: string;
    compile?: { outDir: string };
    /** Read-only library files (relative to the project root), callable from flows and refs. */
    library?: string[];
    /** Non-secret LLM provider/endpoint settings for local or remote OpenAI-compatible servers. */
    llm?: SlateLlmConfig;
}

export interface SlateLayout {
    positions: Record<string, Point>;
    notes: BoardNote[];
    refs: CanvasRef[];
    placeholders: Placeholder[];
    mapPositions: Record<string, Point>;
    flowPositions: Record<string, Record<string, Point>>;
}

export interface SlateNode {
    name: string;
    language?: string;
    intent: string;
    contract: string;
    context: string[];
    cases?: unknown[];
    check?: string[];
    verification?: NodeVerificationResult;
    examples: string[];
    describedBy?: 'human' | 'llama';
    locked: boolean;
    /** Module-level statements instead of one definition: `prelude` compiles before the nodes, `epilogue` after. */
    kind?: NodeKind;
    /** Compile order within the output module (importer-assigned); otherwise node id order. */
    order?: number;
    imports: string[];
    /** Node ids this node references; compile turns cross-module ones into imports. */
    uses: string[];
    code: string[];
    /** Unknown keys, preserved on write. */
    extra: Record<string, unknown>;
}

export type NodeKind = 'prelude' | 'epilogue';

const NODE_KEYS = ['slate', 'name', 'language', 'kind', 'intent', 'contract', 'context', 'cases', 'check', 'verification', 'examples', 'describedBy', 'locked', 'order', 'imports', 'uses', 'code'];
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ZERO_RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value: unknown, label: string): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
        throw new SlateFormatError(`${label} must be a list of strings`);
    }
    return value;
}

function optionalString(value: unknown, label: string): string {
    if (value === undefined) return '';
    if (typeof value !== 'string') throw new SlateFormatError(`${label} must be a string`);
    return value;
}

const LLM_PROVIDERS = new Set<SlateLlmProvider>(['llama.cpp', 'ollama', 'openrouter', 'openai-compatible']);
const SECRET_LLM_KEYS = new Set(['apikey', 'api_key', 'token', 'secret', 'authorization']);
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function boundedInteger(value: unknown, label: string, min: number, max?: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
        const range = max !== undefined ? `between ${min} and ${max}` : `>= ${min}`;
        throw new SlateFormatError(`${label} must be an integer ${range}`);
    }
    return value;
}

function parseLlmConfig(value: unknown): SlateLlmConfig {
    if (!isRecord(value)) throw new SlateFormatError('slate.json llm must be an object');
    for (const key of Object.keys(value)) {
        if (SECRET_LLM_KEYS.has(key.toLowerCase())) {
            throw new SlateFormatError('slate.json llm must not contain raw API keys; set "apiKeyEnv" to an environment variable name instead.');
        }
    }
    const llm: SlateLlmConfig = {};
    if (value.provider !== undefined) {
        if (typeof value.provider !== 'string' || !LLM_PROVIDERS.has(value.provider as SlateLlmProvider)) {
            throw new SlateFormatError('slate.json llm.provider must be one of "llama.cpp", "ollama", "openrouter", or "openai-compatible"');
        }
        llm.provider = value.provider as SlateLlmProvider;
    }
    if (value.endpoint !== undefined) {
        if (typeof value.endpoint !== 'string') throw new SlateFormatError('slate.json llm.endpoint must be a string');
        const endpoint = value.endpoint.trim();
        if (!/^https?:\/\//i.test(endpoint)) {
            throw new SlateFormatError('slate.json llm.endpoint must start with http:// or https://');
        }
        try {
            new URL(endpoint);
        } catch {
            throw new SlateFormatError('slate.json llm.endpoint must be a valid URL');
        }
        llm.endpoint = endpoint;
    }
    if (value.model !== undefined) {
        if (typeof value.model !== 'string' || !value.model.trim()) {
            throw new SlateFormatError('slate.json llm.model must be a non-empty string');
        }
        llm.model = value.model.trim();
    }
    if (value.apiKeyEnv !== undefined) {
        if (typeof value.apiKeyEnv !== 'string') {
            throw new SlateFormatError('slate.json llm.apiKeyEnv must be an environment variable name');
        }
        const envName = value.apiKeyEnv.trim();
        if (/^(?:sk-|bearer\s+)/i.test(envName) || !ENV_VAR_NAME.test(envName)) {
            throw new SlateFormatError('slate.json llm.apiKeyEnv must be an environment variable name (e.g. "OPENROUTER_API_KEY"), not a raw API key');
        }
        llm.apiKeyEnv = envName;
    }
    if (value.concurrency !== undefined) {
        llm.concurrency = boundedInteger(value.concurrency, 'slate.json llm.concurrency', 1, 16);
    }
    if (value.timeoutSeconds !== undefined) {
        llm.timeoutSeconds = boundedInteger(value.timeoutSeconds, 'slate.json llm.timeoutSeconds', 5);
    }
    if (value.outputTokens !== undefined) {
        llm.outputTokens = boundedInteger(value.outputTokens, 'slate.json llm.outputTokens', 64);
    }
    if (value.contextWindow !== undefined) {
        llm.contextWindow = boundedInteger(value.contextWindow, 'slate.json llm.contextWindow', 1024);
    }
    return llm;
}

export function parseConfig(text: string): SlateConfig {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new SlateFormatError(`slate.json is not valid JSON: ${(error as Error).message}`);
    }
    if (!isRecord(value)) throw new SlateFormatError('slate.json must be an object');
    if (value.slate !== FORMAT_VERSION) throw new SlateFormatError(`slate.json must declare "slate": ${FORMAT_VERSION}`);
    if (typeof value.name !== 'string' || !value.name.trim()) throw new SlateFormatError('slate.json needs a name');
    const language = value.language === undefined ? 'python' : value.language;
    if (typeof language !== 'string') throw new SlateFormatError('slate.json language must be a string');
    const config: SlateConfig = { slate: FORMAT_VERSION, name: value.name, language };
    if (value.compile !== undefined) {
        if (!isRecord(value.compile) || typeof value.compile.outDir !== 'string') {
            throw new SlateFormatError('slate.json compile.outDir must be a string');
        }
        config.compile = { outDir: value.compile.outDir };
    }
    if (value.library !== undefined) config.library = stringList(value.library, 'slate.json library');
    if (value.llm !== undefined) config.llm = parseLlmConfig(value.llm);
    return config;
}

export function serializeConfig(config: SlateConfig): string {
    const value: Record<string, unknown> = {
        slate: FORMAT_VERSION,
        name: config.name,
        language: config.language,
    };
    if (config.compile !== undefined) value.compile = { outDir: config.compile.outDir };
    if (config.library !== undefined) value.library = config.library;
    if (config.llm !== undefined) value.llm = parseLlmConfig(config.llm);
    return `${JSON.stringify(value, null, 2)}\n`;
}

export function emptyLayout(): SlateLayout {
    return { positions: {}, notes: [], refs: [], placeholders: [], mapPositions: {}, flowPositions: {} };
}

function points(value: unknown): Record<string, Point> {
    const result: Record<string, Point> = {};
    if (!isRecord(value)) return result;
    for (const [id, point] of Object.entries(value)) {
        if (isRecord(point) && Number.isFinite(point.x) && Number.isFinite(point.y)) result[id] = { x: point.x as number, y: point.y as number };
    }
    return result;
}

export function parseLayout(text: string | undefined): SlateLayout {
    if (text === undefined || !text.trim()) return emptyLayout();
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new SlateFormatError('layout.json must be an object');
    const positions = points(value.positions);
    const notes = Array.isArray(value.notes)
        ? value.notes.filter((note): note is BoardNote => isRecord(note)
            && typeof note.id === 'string' && typeof note.title === 'string' && typeof note.body === 'string'
            && (note.attachedTo === null || typeof note.attachedTo === 'string'))
        : [];
    const refs = Array.isArray(value.refs)
        ? value.refs.filter((ref): ref is CanvasRef => isRecord(ref) && typeof ref.id === 'string' && typeof ref.target === 'string')
            .map(ref => ({ id: ref.id, target: ref.target }))
        : [];
    const placeholders = Array.isArray(value.placeholders)
        ? value.placeholders.filter((item): item is Placeholder => isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string'
            && (item.signature === undefined || typeof item.signature === 'string'))
            .map(item => item.signature ? { id: item.id, name: item.name, signature: item.signature } : { id: item.id, name: item.name })
        : [];
    const flowPositions: SlateLayout['flowPositions'] = {};
    if (isRecord(value.flowPositions)) for (const [flow, entries] of Object.entries(value.flowPositions)) flowPositions[flow] = points(entries);
    return { positions, notes, refs, placeholders, mapPositions: points(value.mapPositions), flowPositions };
}

/** Empty sections are omitted so older layout files stay unchanged; layout keeps placement only. */
export function serializeLayout(layout: SlateLayout): string {
    const value: Record<string, unknown> = { positions: layout.positions, notes: layout.notes };
    if (layout.refs.length) value.refs = layout.refs;
    if (layout.placeholders.length) value.placeholders = layout.placeholders;
    if (Object.keys(layout.mapPositions).length) value.mapPositions = layout.mapPositions;
    if (Object.keys(layout.flowPositions).length) value.flowPositions = layout.flowPositions;
    return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseNode(text: string): SlateNode {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new SlateFormatError(`not valid JSON: ${(error as Error).message}`);
    }
    if (!isRecord(value)) throw new SlateFormatError('a node must be a JSON object');
    if (value.slate !== FORMAT_VERSION) throw new SlateFormatError(`a node must declare "slate": ${FORMAT_VERSION}`);
    if (typeof value.name !== 'string' || !NAME.test(value.name)) throw new SlateFormatError('name must be an identifier');
    if (value.language !== undefined && typeof value.language !== 'string') throw new SlateFormatError('language must be a string');
    if (value.describedBy !== undefined && value.describedBy !== 'human' && value.describedBy !== 'llama') {
        throw new SlateFormatError('describedBy must be "human" or "llama"');
    }
    if (value.locked !== undefined && typeof value.locked !== 'boolean') throw new SlateFormatError('locked must be true or false');
    if (value.kind !== undefined && value.kind !== 'prelude' && value.kind !== 'epilogue') {
        throw new SlateFormatError('kind must be "prelude" or "epilogue"');
    }
    if (value.order !== undefined && !Number.isInteger(value.order)) throw new SlateFormatError('order must be an integer');
    const extra: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (!NODE_KEYS.includes(key)) extra[key] = item;
    return {
        name: value.name,
        language: value.language as string | undefined,
        intent: optionalString(value.intent, 'intent'),
        contract: optionalString(value.contract, 'contract'),
        context: stringList(value.context, 'context'),
        cases: Array.isArray(value.cases) ? value.cases : undefined,
        check: value.check !== undefined ? stringList(value.check, 'check') : undefined,
        verification: isRecord(value.verification) ? value.verification as unknown as NodeVerificationResult : undefined,
        examples: stringList(value.examples, 'examples'),
        describedBy: value.describedBy as SlateNode['describedBy'],
        locked: value.locked === true,
        kind: value.kind as NodeKind | undefined,
        order: value.order as number | undefined,
        imports: stringList(value.imports, 'imports'),
        uses: stringList(value.uses, 'uses'),
        code: stringList(value.code, 'code'),
        extra,
    };
}

export function serializeNode(node: SlateNode): string {
    const value: Record<string, unknown> = { slate: FORMAT_VERSION, name: node.name };
    if (node.language) value.language = node.language;
    if (node.kind) value.kind = node.kind;
    if (node.intent) value.intent = node.intent;
    if (node.contract) value.contract = node.contract;
    if (node.context.length) value.context = node.context;
    if (node.cases?.length) value.cases = node.cases;
    if (node.check?.length) value.check = node.check;
    if (node.verification) value.verification = node.verification;
    if (node.examples.length) value.examples = node.examples;
    if (node.describedBy) value.describedBy = node.describedBy;
    value.locked = node.locked;
    if (node.order !== undefined) value.order = node.order;
    if (node.imports.length) value.imports = node.imports;
    if (node.uses.length) value.uses = node.uses;
    Object.assign(value, node.extra);
    value.code = node.code;
    return `${JSON.stringify(value, null, 2)}\n`;
}

/** Validate a relative node ID (`clamp`, `math/double`) and reject traversal or control chars. */
export function assertSafeNodeId(rawId: string): string {
    if (typeof rawId !== 'string' || /[\0\r\n]/.test(rawId)) {
        throw new SlateFormatError(`Path traversal rejected: "${String(rawId)}" is not a valid node ID.`);
    }
    const normalized = rawId.trim().replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || normalized.endsWith('/') || /^[A-Za-z]:/.test(normalized)) {
        throw new SlateFormatError(`Path traversal rejected: "${rawId}" is not a valid node ID.`);
    }
    const segments = normalized.split('/');
    if (segments.some(seg => !seg || seg === '.' || seg === '..')) {
        throw new SlateFormatError(`Path traversal rejected: "${rawId}" contains unsafe path segments.`);
    }
    return normalized;
}

export function nodeIdForPath(relativePath: string): string | null {
    const normalized = relativePath.replace(/\\/g, '/');
    if (!normalized.startsWith(`${NODES_DIR}/`) || !normalized.endsWith('.json')) return null;
    const candidate = normalized.slice(NODES_DIR.length + 1, -'.json'.length);
    if (candidate !== candidate.trim()) return null;
    try {
        return assertSafeNodeId(candidate);
    } catch {
        return null;
    }
}

export function pathForNodeId(nodeId: string): string {
    return `${NODES_DIR}/${assertSafeNodeId(nodeId)}.json`;
}

/** Top-level Python statements other than the definition (imports belong in `imports`). */
function extraPythonStatements(source: string): number {
    const allowed = new Set(['FunctionDefinition', 'ClassDefinition', 'DecoratedStatement', 'Comment']);
    let count = 0;
    for (let child = parser.parse(source).topNode.firstChild; child; child = child.nextSibling) {
        if (!allowed.has(child.name)) count++;
    }
    return count;
}

/**
 * Index one node file as a HarnessDocument. Unit ranges are relative to the
 * node's code text (the `code` lines joined), which is also what `sources` holds.
 */
export function indexNode(
    relativePath: string,
    text: string,
    defaultLanguage: string,
    version: number | null,
    options?: { checkJpl60?: boolean },
): { document: HarnessDocument; node: SlateNode | null; code: string } {
    const nodeId = nodeIdForPath(relativePath) ?? relativePath;
    const base = { id: `node:${nodeId}`, path: relativePath, version, stale: false };
    let node: SlateNode;
    try {
        node = parseNode(text);
    } catch (error) {
        const parsed = parseModule('', relativePath);
        return {
            document: {
                ...parsed, ...base, valid: false,
                diagnostics: [{ code: 'node-format', message: `${relativePath}: ${(error as Error).message}`, range: ZERO_RANGE }],
            },
            node: null,
            code: '',
        };
    }
    const code = codeText(node);
    const rawLanguage = node.language ?? defaultLanguage;
    const canonical = tryNormalizeLanguage(rawLanguage);
    if (!canonical) {
        const parsed = parseModule('', relativePath);
        return {
            document: {
                ...parsed, ...base, valid: false,
                diagnostics: [{ code: 'node-language', message: `No adapter for language "${rawLanguage}" yet.`, range: ZERO_RANGE }],
            },
            node,
            code,
        };
    }

    let parsed: ParseModuleResult;
    if (canonical === 'prose') {
        parsed = parseProseModule(code, relativePath, nodeId, node);
    } else if (canonical === 'typescript' || canonical === 'javascript') {
        const ext = typeof node.extra.extension === 'string'
            ? node.extra.extension
            : (canonical === 'javascript' ? '.js' : '.ts');
        const tsDocPath = typeof node.extra.modulePath === 'string' && node.extra.modulePath
            ? node.extra.modulePath
            : `${nodeId}${ext}`;
        parsed = parseTsModule(code, tsDocPath, nodeId);
    } else if (canonical === 'csharp') {
        parsed = parseCSharpModule(code, relativePath, nodeId);
    } else if (canonical === 'cpp' || canonical === 'arduino') {
        parsed = parseCppModule(code, relativePath, nodeId);
    } else {
        parsed = parseModule(code, relativePath, nodeId);
    }

    const diagnostics = [...parsed.diagnostics];
    if (node.kind) {
        // Module state: any statements; conditional definitions inside it are not separate nodes.
        return { document: { ...parsed, ...base, source: code, nodeKind: node.kind, imports: node.imports, uses: node.uses, units: [], diagnostics }, node, code };
    }
    if (parsed.valid) {
        const topLevel = parsed.units.filter(unit => unit.parentId === null);
        const definition = topLevel.find(unit => unit.id === nodeId);
        if (!definition) {
            diagnostics.push({ code: 'node-definition-missing', message: `code must define ${node.name}.`, range: ZERO_RANGE });
        } else {
            definition.annotation = {
                intent: node.intent,
                contract: node.contract,
                dependencies: node.context,
                context: node.context,
                cases: node.cases,
                imports: node.imports,
                uses: node.uses,
                examples: node.examples,
                verification: node.verification,
                locked: node.locked,
            };
        }
        if (canonical === 'python' && (topLevel.length > 1 || extraPythonStatements(code) > 0)) {
            diagnostics.push({
                code: 'node-extra-statements',
                message: 'code must contain exactly one definition; put imports in "imports" and other definitions in their own nodes.',
                range: ZERO_RANGE,
            });
        } else if (canonical !== 'python' && canonical !== 'prose' && topLevel.length > 1) {
            diagnostics.push({
                code: 'node-extra-statements',
                message: 'code must contain exactly one top-level definition; put imports/directives in "imports" and other definitions in their own nodes.',
                range: ZERO_RANGE,
            });
        }
        const leafId = nodeId.split('/').pop() ?? nodeId;
        const isOverloadId = (canonical === 'csharp' || canonical === 'cpp' || canonical === 'arduino')
            && leafId.startsWith(`${node.name}__overload_`)
            && /^\d+$/.test(leafId.slice(`${node.name}__overload_`.length));
        if (leafId !== node.name && !isOverloadId) {
            diagnostics.push({ code: 'node-name-mismatch', message: `File name must match name "${node.name}".`, range: ZERO_RANGE });
        }
        if (options?.checkJpl60 && !node.kind) {
            let jpl: Jpl60CheckResult | null = null;
            if (canonical === 'python') {
                jpl = checkJpl60(node, code);
            } else if (canonical === 'typescript' || canonical === 'javascript') {
                jpl = checkTsNodeCode(code, node.name, { contract: node.contract, language: canonical });
            } else if (canonical === 'csharp') {
                jpl = checkCSharpNodeCode(node, nodeId, code, { contract: node.contract, requireContract: true });
            } else if (canonical === 'cpp' || canonical === 'arduino') {
                jpl = checkCppNodeCode(node, nodeId, code, { contract: node.contract, requireContract: true });
            }
            if (jpl) {
                for (const diag of jpl.diagnostics) {
                    if (diag.code === 'node-definition-missing' || diag.code === 'node-extra-statements' || diag.code === 'node-name-mismatch') continue;
                    diagnostics.push({ code: diag.code, message: diag.message, range: ZERO_RANGE });
                }
            }
        }
    }
    return { document: { ...parsed, ...base, source: code, imports: node.imports, uses: node.uses, verification: node.verification, cases: (node.cases as any), diagnostics }, node, code };
}

/** Check JPL-60 rules: <=60 lines, explicit parameter & return type annotations, contract documentation. */
export function checkJpl60(node: SlateNode, code?: string): Jpl60CheckResult {
    const rawLines = code !== undefined ? codeLines(code) : node.code;
    const lines = rawLines.flatMap(line => line.split(/\r?\n/));
    const executable = lines.filter(l => l.trim().length > 0 && !l.trim().startsWith('#')).length;
    const diagnostics: Array<{ code: string; message: string }> = [];

    if (!node.kind && lines.length > 60) {
        diagnostics.push({
            code: 'jpl60-line-count',
            message: `Node "${node.name}" exceeds JPL-60 limit: ${lines.length} lines (>60). Split or refactor into stubs and a flow composition.`,
        });
    }

    if (!node.kind) {
        const source = `${lines.join('\n')}\n`;
        const parsed = parseModule(source, '<node>', node.name);
        if (parsed.valid) {
            const def = parsed.units.find(u => u.parentId === null && u.name === node.name);
            if (def && def.kind === 'function') {
                if (def.params) {
                    for (const p of def.params) {
                        if (!p.annotation || !p.annotation.trim()) {
                            diagnostics.push({
                                code: 'jpl60-param-annotation',
                                message: `Parameter "${p.name}" in "${node.name}" is missing a type annotation.`,
                            });
                        }
                    }
                }
                if (!def.returnAnnotation || !def.returnAnnotation.trim()) {
                    diagnostics.push({
                        code: 'jpl60-return-annotation',
                        message: `Function "${node.name}" is missing a return type annotation (-> ReturnType).`,
                    });
                }
            }
        }
    }

    if (!node.contract || !node.contract.trim()) {
        diagnostics.push({
            code: 'jpl60-contract-missing',
            message: `Node "${node.name}" is missing contract documentation.`,
        });
    }

    return {
        valid: diagnostics.length === 0,
        lineCount: lines.length,
        executableLines: executable,
        diagnostics,
    };
}

/** Validate replacement code for a node: one definition with the node's name (any statements for module state). */
export function checkNodeCode(
    node: SlateNode,
    nodeId: string,
    code: string,
    options?: { enforceJpl60?: boolean; language?: string },
): Jpl60CheckResult {
    const canonical = tryNormalizeLanguage(options?.language ?? node.language) ?? 'python';
    if (canonical === 'typescript' || canonical === 'javascript') {
        const result = checkTsNodeCode(code, node.name, {
            contract: options?.enforceJpl60 ? node.contract : undefined,
            enforceJpl60: false,
            language: canonical,
        });
        if (node.kind) {
            const parsed = parseTsModule(`${codeLines(code).join('\n')}\n`, `${nodeId}.ts`, nodeId);
            if (!parsed.valid) throw new SlateFormatError('code is not valid TypeScript/JavaScript');
            return { valid: true, lineCount: codeLines(code).length, executableLines: codeLines(code).length, diagnostics: [] };
        }
        const structural = result.diagnostics.find(d =>
            d.code === 'ts-syntax' || d.code === 'node-definition-missing' || d.code === 'node-extra-statements' || d.code === 'node-name-mismatch');
        if (structural) throw new SlateFormatError(structural.message);
        if (options?.enforceJpl60 && !result.valid) throw new SlateFormatError(result.diagnostics[0].message);
        return result;
    }
    if (canonical === 'csharp') {
        const result = checkCSharpNodeCode(node, nodeId, code, {
            contract: options?.enforceJpl60 ? node.contract : undefined,
            requireContract: options?.enforceJpl60 === true,
        });
        if (node.kind) return { valid: true, lineCount: codeLines(code).length, executableLines: codeLines(code).length, diagnostics: [] };
        const structural = result.diagnostics.find(d =>
            d.code === 'csharp-syntax' || d.code === 'node-definition-missing' || d.code === 'node-extra-statements' || d.code === 'node-name-mismatch');
        if (structural) throw new SlateFormatError(structural.message);
        if (options?.enforceJpl60 && !result.valid) throw new SlateFormatError(result.diagnostics[0].message);
        return result;
    }
    if (canonical === 'cpp' || canonical === 'arduino') {
        const result = checkCppNodeCode(node, nodeId, code, {
            contract: options?.enforceJpl60 ? node.contract : undefined,
            requireContract: options?.enforceJpl60 === true,
        });
        if (node.kind) return { valid: true, lineCount: codeLines(code).length, executableLines: codeLines(code).length, diagnostics: [] };
        const structural = result.diagnostics.find(d =>
            d.code === 'cpp-syntax' || d.code === 'node-definition-missing' || d.code === 'node-extra-statements' || d.code === 'node-name-mismatch');
        if (structural) throw new SlateFormatError(structural.message);
        if (options?.enforceJpl60 && !result.valid) throw new SlateFormatError(result.diagnostics[0].message);
        return result;
    }

    const source = `${codeLines(code).join('\n')}\n`;
    const parsed = parseModule(source, '<node>', nodeId);
    if (!parsed.valid) throw new SlateFormatError('code is not valid Python');
    if (node.kind) return { valid: true, lineCount: codeLines(code).length, executableLines: codeLines(code).length, diagnostics: [] };
    const topLevel = parsed.units.filter(unit => unit.parentId === null);
    if (topLevel.length !== 1 || topLevel[0].name !== node.name || extraPythonStatements(source) > 0) {
        throw new SlateFormatError(`code must contain exactly one definition named ${node.name} (put imports in "imports")`);
    }
    const result = checkJpl60(node, code);
    if (options?.enforceJpl60 && !result.valid) {
        throw new SlateFormatError(result.diagnostics[0].message);
    }
    return result;
}

/** A new node from a typed TypeScript/JavaScript signature such as `export function clamp(x: number): number`. */
export function tsNodeFromSignature(
    signature: string,
    intent: string,
    language: 'typescript' | 'javascript' = 'typescript',
    extension?: string,
): SlateNode {
    const trimmed = signature.replace(/\r\n?/g, '\n').trim().replace(/[;{]\s*$/, '').trim();
    const body = '{\n    throw new Error("Not implemented");\n}';
    const full = `${trimmed} ${body}`;
    const ext = extension ?? (language === 'javascript' ? '.js' : '.ts');
    const stubCheck = validateTsStubSource(`${full}\n`, ext, { minBodyStart: trimmed.length });
    if (!stubCheck.valid) {
        throw new SlateFormatError(stubCheck.reason ?? 'enter one TypeScript/JavaScript signature, e.g. export function clamp(value: number, lower: number, upper: number): number');
    }
    const parsed = parseTsModule(`${full}\n`, `<new>${ext}`);
    const topLevel = parsed.units.filter(u => u.parentId === null);
    const unit = parsed.valid && topLevel.length === 1 ? topLevel[0] : null;
    if (!unit || !['function', 'class'].includes(unit.kind)) {
        throw new SlateFormatError('enter one TypeScript/JavaScript signature, e.g. export function clamp(value: number, lower: number, upper: number): number');
    }
    return {
        name: unit.name,
        language,
        intent: intent.trim(),
        contract: '',
        context: [],
        examples: [],
        describedBy: 'human',
        locked: false,
        imports: [],
        uses: [],
        code: codeLines(full),
        extra: extension ? { extension } : {},
    };
}

/** A new node from a typed Python signature such as `def clamp(x: int) -> int`. */
export function nodeFromSignature(signature: string, intent: string): SlateNode {
    const header = signature.replace(/\r\n?/g, '\n').trim().replace(/:$/, '').trimEnd();
    const code = [`${header}:`, '    raise NotImplementedError'];
    const full = `${code.join('\n')}\n`;
    const parsed = parseModule(full, '<new node>');
    const unit = parsed.valid && parsed.units.length === 1 ? parsed.units[0] : null;
    const stubCheck = validateStubSource(full, { expectedHeaderLength: header.length });
    if (!unit || unit.kind !== 'function' || extraPythonStatements(full) > 0 || !stubCheck.valid) {
        throw new SlateFormatError('enter one function signature, e.g. def clamp(value: int, lower: int, upper: int) -> int');
    }
    return {
        name: unit.name, intent: intent.trim(), contract: '', context: [], examples: [],
        describedBy: 'human', locked: false, imports: [], uses: [], code, extra: {},
    };
}

export interface StubValidationResult {
    valid: boolean;
    reason?: string;
}

function directNodeChildren(node: SyntaxNode): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
    return out;
}

function hasSyntaxErrorOrForbiddenChild(node: SyntaxNode, forbiddenNames: ReadonlySet<string>): boolean {
    const cursor = node.cursor();
    const visit = (): boolean => {
        if (cursor.type.isError || forbiddenNames.has(cursor.name)) return true;
        if (cursor.firstChild()) {
            do {
                if (visit()) return true;
            } while (cursor.nextSibling());
            cursor.parent();
        }
        return false;
    };
    return visit();
}

const FORBIDDEN_PYTHON_TYPEDEF_NODES = new Set([
    'CallExpression',
    'LambdaExpression',
    'FormatString',
    'FormatReplacement',
    'ArrayComprehensionExpression',
    'SetComprehensionExpression',
    'DictionaryComprehensionExpression',
    'GeneratorExpression',
    'YieldExpression',
    'AwaitExpression',
    'NamedExpression',
]);

function isPurePythonLiteralNode(node: SyntaxNode, source: string): boolean {
    if (node.type.isError) return false;
    switch (node.name) {
        case 'Number':
        case 'Boolean':
        case 'None':
        case 'Ellipsis':
            return true;
        case 'String':
            return !hasSyntaxErrorOrForbiddenChild(node, new Set(['FormatString', 'FormatReplacement']));
        case 'UnaryExpression': {
            const kids = directNodeChildren(node).filter(c => c.name !== 'Comment');
            if (kids.length !== 2 || kids[0].name !== 'ArithOp' || kids[1].name !== 'Number') return false;
            const op = source.slice(kids[0].from, kids[0].to).trim();
            return op === '+' || op === '-';
        }
        case 'ParenthesizedExpression':
        case 'TupleExpression':
        case 'ArrayExpression':
        case 'SetExpression': {
            const skip = new Set(['(', ')', '[', ']', '{', '}', ',', 'Comment']);
            for (const child of directNodeChildren(node)) {
                if (skip.has(child.name)) continue;
                if (!isPurePythonLiteralNode(child, source)) return false;
            }
            return true;
        }
        case 'DictionaryExpression': {
            const skip = new Set(['{', '}', ',', ':', 'Comment']);
            for (const child of directNodeChildren(node)) {
                if (skip.has(child.name)) continue;
                if (!isPurePythonLiteralNode(child, source)) return false;
            }
            return true;
        }
        default:
            return false;
    }
}

function validatePythonStubSignature(funcNode: SyntaxNode, source: string): StubValidationResult | null {
    for (const child of directNodeChildren(funcNode)) {
        if (child.name === 'TypeDef') {
            if (hasSyntaxErrorOrForbiddenChild(child, FORBIDDEN_PYTHON_TYPEDEF_NODES)) {
                return {
                    valid: false,
                    reason: `Arbitrary expressions are refused in stub type annotations: "${source.slice(child.from, child.to).trim()}".`,
                };
            }
        } else if (child.name === 'ParamList') {
            const paramChildren = directNodeChildren(child).filter(c => c.name !== '(' && c.name !== ')' && c.name !== 'Comment');
            let group: SyntaxNode[] = [];
            const validateGroup = (): StubValidationResult | null => {
                for (const item of group) {
                    if (item.name === 'TypeDef' && hasSyntaxErrorOrForbiddenChild(item, FORBIDDEN_PYTHON_TYPEDEF_NODES)) {
                        return {
                            valid: false,
                            reason: `Arbitrary expressions are refused in stub parameter annotations: "${source.slice(item.from, item.to).trim()}".`,
                        };
                    }
                }
                const assignIdx = group.findIndex(item => item.name === 'AssignOp');
                if (assignIdx >= 0) {
                    const defaultExprs = group.slice(assignIdx + 1);
                    if (defaultExprs.length !== 1 || !isPurePythonLiteralNode(defaultExprs[0], source)) {
                        const snippet = defaultExprs.map(n => source.slice(n.from, n.to)).join(' ').trim();
                        return {
                            valid: false,
                            reason: `Parameter default in stub must be a pure Python literal value (refused: "${snippet}").`,
                        };
                    }
                }
                group = [];
                return null;
            };
            for (const item of paramChildren) {
                if (item.name === ',') {
                    const err = validateGroup();
                    if (err) return err;
                } else {
                    group.push(item);
                }
            }
            const tailErr = validateGroup();
            if (tailErr) return tailErr;
        }
    }
    return null;
}

function validateStubSource(fullCode: string, options?: { expectedHeaderLength?: number }): StubValidationResult {
    const tree = parser.parse(fullCode);
    if (hasSyntaxErrorOrForbiddenChild(tree.topNode, new Set())) {
        return { valid: false, reason: 'Invalid Python syntax in stub.' };
    }

    let funcNode: SyntaxNode | null = null;
    for (let cur = tree.topNode.firstChild; cur; cur = cur.nextSibling) {
        if (cur.name === 'Comment') continue;
        if (cur.name === 'FunctionDefinition') {
            if (funcNode) {
                return { valid: false, reason: 'Stub must contain exactly one function definition.' };
            }
            funcNode = cur;
            continue;
        }
        return {
            valid: false,
            reason: `Stub must contain only a single function definition (refused top-level ${cur.name}).`,
        };
    }
    if (!funcNode) {
        return { valid: false, reason: 'No valid function definition found.' };
    }

    const sigErr = validatePythonStubSignature(funcNode, fullCode);
    if (sigErr) return sigErr;

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
    if (options?.expectedHeaderLength !== undefined && bodyNode.from !== options.expectedHeaderLength) {
        return { valid: false, reason: 'Function signature contains unexpected trailing tokens or body.' };
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

            if (exprNode.name === 'CallExpression') {
                const callee = exprNode.firstChild;
                if (!callee || fullCode.slice(callee.from, callee.to).trim() !== 'NotImplementedError') {
                    return {
                        valid: false,
                        reason: `Only NotImplementedError may be raised in an atomic stub (found: "${raisedText}").`,
                    };
                }
                const argList = callee.nextSibling;
                if (argList && argList.name === 'ArgList') {
                    let argCount = 0;
                    let invalidArg = false;
                    for (let arg = argList.firstChild; arg; arg = arg.nextSibling) {
                        if (arg.name === '(' || arg.name === ')' || arg.name === ',' || arg.name === 'Comment') continue;
                        argCount++;
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

/**
 * Validates that an atomic stub contains ONLY permitted stub constructs:
 * `pass`, `...`, `raise NotImplementedError`, docstrings, comments, whitespace.
 * Strictly refuses any arbitrary implementation statements (returns, math, loops, assignments).
 */
export function validateStubBody(signature: string, bodyText: string): StubValidationResult {
    const cleanSig = signature.replace(/\r\n?/g, '\n').trim().replace(/:$/, '').trimEnd();
    const cleanLines = bodyText.replace(/\r\n?/g, '\n').split('\n');
    const indentedBody = cleanLines.map(l => l.startsWith('    ') ? l : `    ${l}`).join('\n');
    return validateStubSource(`${cleanSig}:\n${indentedBody}\n`, { expectedHeaderLength: cleanSig.length });
}

function isPureTsLiteralExpr(expr: ts.Expression): boolean {
    let cur = expr;
    while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    if (
        ts.isNumericLiteral(cur)
        || ts.isStringLiteral(cur)
        || ts.isNoSubstitutionTemplateLiteral(cur)
        || cur.kind === ts.SyntaxKind.TrueKeyword
        || cur.kind === ts.SyntaxKind.FalseKeyword
        || cur.kind === ts.SyntaxKind.NullKeyword
        || (ts.isIdentifier(cur) && cur.text === 'undefined')
    ) {
        return true;
    }
    if (
        ts.isPrefixUnaryExpression(cur)
        && (cur.operator === ts.SyntaxKind.PlusToken || cur.operator === ts.SyntaxKind.MinusToken)
        && ts.isNumericLiteral(cur.operand)
    ) {
        return true;
    }
    if (ts.isArrayLiteralExpression(cur)) {
        return cur.elements.every(el => !ts.isSpreadElement(el) && isPureTsLiteralExpr(el));
    }
    if (ts.isObjectLiteralExpression(cur)) {
        return cur.properties.every(prop =>
            ts.isPropertyAssignment(prop)
            && !ts.isComputedPropertyName(prop.name)
            && isPureTsLiteralExpr(prop.initializer));
    }
    return false;
}

function validateTsBindingName(nameNode: ts.BindingName): StubValidationResult | null {
    if (ts.isIdentifier(nameNode)) return null;
    if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
        for (const el of nameNode.elements) {
            if (ts.isOmittedExpression(el)) continue;
            if (el.propertyName && ts.isComputedPropertyName(el.propertyName)) {
                return { valid: false, reason: 'Computed property names are refused in stub parameters.' };
            }
            if (el.initializer && !isPureTsLiteralExpr(el.initializer)) {
                return { valid: false, reason: 'Parameter default values in stubs must be pure literal values.' };
            }
            const nested = validateTsBindingName(el.name);
            if (nested) return nested;
        }
        return null;
    }
    return { valid: false, reason: 'Unsupported binding pattern in stub parameter.' };
}

function validateTsStubParams(params: ts.NodeArray<ts.ParameterDeclaration>): StubValidationResult | null {
    for (const param of params) {
        const paramDecorators = ts.canHaveDecorators(param) ? ts.getDecorators(param) : undefined;
        if (paramDecorators && paramDecorators.length > 0) {
            return { valid: false, reason: 'Decorators are refused in atomic stub parameters.' };
        }
        if (param.initializer && !isPureTsLiteralExpr(param.initializer)) {
            return { valid: false, reason: 'Parameter default values in stubs must be pure literal values.' };
        }
        const bindingErr = validateTsBindingName(param.name);
        if (bindingErr) return bindingErr;
    }
    return null;
}

/** Validates that a TypeScript/JavaScript function stub body contains ONLY empty blocks or `throw new Error("...")`. */
export function validateTsStubSource(
    fullCode: string,
    extension = '.tsx',
    options?: { minBodyStart?: number },
): StubValidationResult {
    const parsed = parseTsModule(fullCode, `<stub>${extension}`);
    if (!parsed.valid) {
        return { valid: false, reason: parsed.diagnostics[0]?.message ?? 'Invalid TypeScript/JavaScript stub syntax.' };
    }
    const sf = ts.createSourceFile(`<stub>${extension}`, fullCode, ts.ScriptTarget.Latest, true, scriptKindForPath(`<stub>${extension}`, fullCode));
    if (sf.statements.length !== 1) {
        return { valid: false, reason: 'Stub must contain exactly one top-level declaration.' };
    }
    const stmt = sf.statements[0];
    const stmtDecorators = ts.canHaveDecorators(stmt) ? ts.getDecorators(stmt) : undefined;
    if (stmtDecorators && stmtDecorators.length > 0) {
        return { valid: false, reason: 'Decorators are refused in atomic stubs.' };
    }
    let bodyBlock: ts.Block | null = null;
    let params: ts.NodeArray<ts.ParameterDeclaration> | null = null;
    if (ts.isFunctionDeclaration(stmt)) {
        bodyBlock = stmt.body ?? null;
        params = stmt.parameters;
    } else if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.length === 1) {
        let init = stmt.declarationList.declarations[0].initializer;
        while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init))) {
            init = init.expression;
        }
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            if (!ts.isBlock(init.body)) {
                return {
                    valid: false,
                    reason: 'Expression-bodied arrow functions are refused in stubs; use a block stub `{ throw new Error("Not implemented"); }`.',
                };
            }
            bodyBlock = init.body;
            params = init.parameters;
        }
    }
    if (!bodyBlock || !params) {
        return { valid: false, reason: 'No function body block found in TypeScript/JavaScript stub.' };
    }
    if (options?.minBodyStart !== undefined && bodyBlock.getStart(sf) < options.minBodyStart) {
        return { valid: false, reason: 'TypeScript/JavaScript signature contains unexpected body tokens.' };
    }
    const paramErr = validateTsStubParams(params);
    if (paramErr) return paramErr;

    for (const inner of bodyBlock.statements) {
        if (ts.isEmptyStatement(inner)) continue;
        if (ts.isThrowStatement(inner)) {
            const expr = inner.expression;
            if (
                expr
                && ts.isNewExpression(expr)
                && ts.isIdentifier(expr.expression)
                && (expr.expression.text === 'Error' || expr.expression.text === 'NotImplementedError')
            ) {
                const args = expr.arguments;
                if (!args || args.length === 0) continue;
                if (args.length === 1 && (ts.isStringLiteral(args[0]) || ts.isNoSubstitutionTemplateLiteral(args[0]))) {
                    continue;
                }
                return {
                    valid: false,
                    reason: `throw new ${expr.expression.text}(...) argument must be a single literal string message; arbitrary expressions are refused in stubs.`,
                };
            }
            return {
                valid: false,
                reason: `Only throw new Error("...") or throw new NotImplementedError("...") is permitted in an atomic stub (found: "${inner.getText(sf).trim()}").`,
            };
        }
        return {
            valid: false,
            reason: `Arbitrary function body implementations are strictly refused. Frontier Architect only authors atomic stubs ({} or throw new Error("...")). Statement: "${inner.getText(sf).trim()}". Body implementations must be forged by the Tier 2 local model.`,
        };
    }

    return { valid: true };
}

/** Validates a TypeScript/JavaScript signature + stub body combination. */
export function validateTsStubBody(signature: string, bodyText: string, extension = '.tsx'): StubValidationResult {
    const cleanSig = signature.replace(/\r\n?/g, '\n').trim().replace(/[;{]\s*$/, '').trim();
    const trimmedBody = bodyText.replace(/\r\n?/g, '\n').trim();
    const block = trimmedBody.startsWith('{') && trimmedBody.endsWith('}')
        ? trimmedBody
        : `{\n${trimmedBody.split('\n').map(l => `    ${l}`).join('\n')}\n}`;
    return validateTsStubSource(`${cleanSig} ${block}\n`, extension, { minBodyStart: cleanSig.length });
}

/** Validates whether an existing node's code is an unimplemented atomic stub. */
export function validateNodeStub(node: Pick<SlateNode, 'code' | 'language'>, defaultLanguage = 'python'): StubValidationResult {
    const canonical = tryNormalizeLanguage(node.language ?? defaultLanguage) ?? 'python';
    if (canonical === 'typescript' || canonical === 'javascript') {
        return validateTsStubSource(codeText(node), canonical === 'javascript' ? '.jsx' : '.tsx');
    }
    return validateStubSource(codeText(node));
}
