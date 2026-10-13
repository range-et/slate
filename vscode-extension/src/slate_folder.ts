import { parser } from '@lezer/python';

import type { BoardNote, HarnessDocument } from './harness_protocol';
import { parseModule } from './python_adapter';

// The decoupled `slate/` folder: slate.json, layout.json, and one JSON file per
// node under nodes/. See SLATE_HARNESS_PLAN.md → "Workspace format".

export const SLATE_DIR = 'slate';
export const NODES_DIR = `${SLATE_DIR}/nodes`;
export const CONFIG_PATH = `${SLATE_DIR}/slate.json`;
export const LAYOUT_PATH = `${SLATE_DIR}/layout.json`;
export const FORMAT_VERSION = 3;

export class SlateFormatError extends Error {}

export interface SlateConfig {
    slate: 3;
    name: string;
    language: string;
    compile?: { outDir: string };
}

export interface SlateLayout {
    positions: Record<string, { x: number; y: number }>;
    notes: BoardNote[];
}

export interface SlateNode {
    name: string;
    language?: string;
    intent: string;
    contract: string;
    context: string[];
    examples: string[];
    describedBy?: 'human' | 'llama';
    locked: boolean;
    imports: string[];
    code: string[];
    /** Unknown keys, preserved on write. */
    extra: Record<string, unknown>;
}

const NODE_KEYS = ['slate', 'name', 'language', 'intent', 'contract', 'context', 'examples', 'describedBy', 'locked', 'imports', 'code'];
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
    return config;
}

export function parseLayout(text: string | undefined): SlateLayout {
    if (text === undefined || !text.trim()) return { positions: {}, notes: [] };
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new SlateFormatError('layout.json must be an object');
    const positions: SlateLayout['positions'] = {};
    if (isRecord(value.positions)) {
        for (const [id, point] of Object.entries(value.positions)) {
            if (isRecord(point) && Number.isFinite(point.x) && Number.isFinite(point.y)) {
                positions[id] = { x: point.x as number, y: point.y as number };
            }
        }
    }
    const notes = Array.isArray(value.notes)
        ? value.notes.filter((note): note is BoardNote => isRecord(note)
            && typeof note.id === 'string' && typeof note.title === 'string' && typeof note.body === 'string'
            && (note.attachedTo === null || typeof note.attachedTo === 'string'))
        : [];
    return { positions, notes };
}

export function serializeLayout(layout: SlateLayout): string {
    return `${JSON.stringify({ positions: layout.positions, notes: layout.notes }, null, 2)}\n`;
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
    const extra: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (!NODE_KEYS.includes(key)) extra[key] = item;
    return {
        name: value.name,
        language: value.language as string | undefined,
        intent: optionalString(value.intent, 'intent'),
        contract: optionalString(value.contract, 'contract'),
        context: stringList(value.context, 'context'),
        examples: stringList(value.examples, 'examples'),
        describedBy: value.describedBy as SlateNode['describedBy'],
        locked: value.locked === true,
        imports: stringList(value.imports, 'imports'),
        code: stringList(value.code, 'code'),
        extra,
    };
}

export function serializeNode(node: SlateNode): string {
    const value: Record<string, unknown> = { slate: FORMAT_VERSION, name: node.name };
    if (node.language) value.language = node.language;
    if (node.intent) value.intent = node.intent;
    if (node.contract) value.contract = node.contract;
    if (node.context.length) value.context = node.context;
    if (node.examples.length) value.examples = node.examples;
    if (node.describedBy) value.describedBy = node.describedBy;
    value.locked = node.locked;
    if (node.imports.length) value.imports = node.imports;
    Object.assign(value, node.extra);
    value.code = node.code;
    return `${JSON.stringify(value, null, 2)}\n`;
}

export function codeText(node: Pick<SlateNode, 'code'>): string {
    return `${node.code.join('\n')}\n`;
}

export function codeLines(text: string): string[] {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    return lines;
}

export function nodeIdForPath(relativePath: string): string | null {
    const normalized = relativePath.replace(/\\/g, '/');
    if (!normalized.startsWith(`${NODES_DIR}/`) || !normalized.endsWith('.json')) return null;
    return normalized.slice(NODES_DIR.length + 1, -'.json'.length);
}

export function pathForNodeId(nodeId: string): string {
    return `${NODES_DIR}/${nodeId}.json`;
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
    const language = node.language ?? defaultLanguage;
    if (language !== 'python') {
        const parsed = parseModule('', relativePath);
        return {
            document: {
                ...parsed, ...base, valid: false,
                diagnostics: [{ code: 'node-language', message: `No adapter for language "${language}" yet.`, range: ZERO_RANGE }],
            },
            node,
            code,
        };
    }
    const parsed = parseModule(code, relativePath, nodeId);
    const diagnostics = [...parsed.diagnostics];
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
                examples: node.examples,
                locked: node.locked,
            };
        }
        if (topLevel.length > 1 || extraPythonStatements(code) > 0) {
            diagnostics.push({
                code: 'node-extra-statements',
                message: 'code must contain exactly one definition; put imports in "imports" and other definitions in their own nodes.',
                range: ZERO_RANGE,
            });
        }
        if (nodeId.split('/').pop() !== node.name) {
            diagnostics.push({ code: 'node-name-mismatch', message: `File name must match name "${node.name}".`, range: ZERO_RANGE });
        }
    }
    return { document: { ...parsed, ...base, diagnostics }, node, code };
}

/** Validate replacement code for a node: one definition with the node's name. */
export function checkNodeCode(node: SlateNode, nodeId: string, code: string): void {
    const source = `${codeLines(code).join('\n')}\n`;
    const parsed = parseModule(source, '<node>', nodeId);
    if (!parsed.valid) throw new SlateFormatError('code is not valid Python');
    const topLevel = parsed.units.filter(unit => unit.parentId === null);
    if (topLevel.length !== 1 || topLevel[0].name !== node.name || extraPythonStatements(source) > 0) {
        throw new SlateFormatError(`code must contain exactly one definition named ${node.name} (put imports in "imports")`);
    }
}

/** A new node from a typed Python signature such as `def clamp(x: int) -> int`. */
export function nodeFromSignature(signature: string, intent: string): SlateNode {
    const header = signature.trim().replace(/:$/, '');
    const code = [`${header}:`, '    raise NotImplementedError'];
    const parsed = parseModule(`${code.join('\n')}\n`, '<new node>');
    const unit = parsed.valid && parsed.units.length === 1 ? parsed.units[0] : null;
    if (!unit || unit.kind !== 'function' || extraPythonStatements(`${code.join('\n')}\n`) > 0) {
        throw new SlateFormatError('enter one function signature, e.g. def clamp(value: int, lower: int, upper: int) -> int');
    }
    return {
        name: unit.name, intent: intent.trim(), contract: '', context: [], examples: [],
        describedBy: 'human', locked: false, imports: [], code, extra: {},
    };
}
