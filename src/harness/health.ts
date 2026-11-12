import type { SyntaxNode } from '@lezer/common';
import { parser } from '@lezer/python';

import { unitSignature } from '../../vscode-extension/src/flow';
import { nodeIdOf } from './graph';
import type { HarnessDocument, HarnessSnapshot, HarnessUnit } from './types';

export interface UnreferencedCandidate {
    nodeId: string;
    name: string;
    signature: string | null;
    intent: string;
    /** Prompt-only context consumers (`context` in node JSON, not runtime calls). */
    contextOnlyBy: string[];
}

export interface DuplicateGroup {
    normalizedCode: string;
    nodeIds: string[];
}

export interface NearDuplicatePair {
    leftId: string;
    rightId: string;
    similarity: number;
}

export interface DiffLine {
    kind: 'same' | 'remove' | 'add';
    leftLine: number | null;
    rightLine: number | null;
    text: string;
}

export interface NodeHealthReport {
    unreferenced: UnreferencedCandidate[];
    exactDuplicates: DuplicateGroup[];
    nearDuplicates: NearDuplicatePair[];
    /** Explicit coverage gaps that static inspection cannot resolve. */
    caveats: string[];
}

const PYTHON_KEYWORDS = new Set([
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
    'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
    'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

function folderOf(nodeId: string): string {
    return nodeId.includes('/') ? nodeId.slice(0, nodeId.lastIndexOf('/')) : '';
}

function stripLineComment(line: string): string {
    let quote: string | null = null;
    let escaped = false;
    for (let index = 0; index < line.length; index++) {
        const ch = line[index];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (quote) {
            if (line.startsWith(quote, index)) {
                index += quote.length - 1;
                quote = null;
            }
            continue;
        }
        if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
            quote = line.slice(index, index + 3);
            index += 2;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '#') return line.slice(0, index);
    }
    return line;
}

function stripLeadingDocstring(lines: string[]): string[] {
    const result: string[] = [];
    let bodyStarted = false;
    let skippingDocstring: string | null = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (skippingDocstring) {
            if (trimmed.includes(skippingDocstring)) skippingDocstring = null;
            continue;
        }
        if (!bodyStarted) {
            if (trimmed.startsWith('def ') || trimmed.startsWith('async def ') || trimmed.startsWith('class ') || trimmed.startsWith('@')) {
                result.push(line);
                if (trimmed.endsWith(':')) bodyStarted = true;
                continue;
            }
            if (trimmed.endsWith(':')) bodyStarted = true;
            result.push(line);
            continue;
        }
        if (result.length > 0 && !result.some((prev, idx) => idx > 0 && !prev.trim().startsWith('@') && !prev.trim().startsWith('def ') && !prev.trim().startsWith('async def ') && !prev.trim().startsWith('class '))) {
            if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
                const delim = trimmed.slice(0, 3);
                const rest = trimmed.slice(3);
                if (!rest.includes(delim)) skippingDocstring = delim;
                continue;
            }
        }
        result.push(line);
    }
    return result;
}

function directChildren(node: SyntaxNode): SyntaxNode[] {
    const children: SyntaxNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) children.push(child);
    return children;
}

function isKeywordArgLabel(parent: SyntaxNode, child: SyntaxNode): boolean {
    if (parent.name !== 'ArgList') return false;
    const siblings = directChildren(parent);
    const idx = siblings.findIndex(sib => sib.from === child.from && sib.to === child.to);
    return idx >= 0 && siblings[idx + 1]?.name === 'AssignOp';
}

function formatLiteralNode(node: SyntaxNode, text: string, renameMap: ReadonlyMap<string, string>): string {
    if (node.name === 'String') return text.slice(node.from, node.to);
    if (node.name !== 'FormatString') return text.slice(node.from, node.to);
    const replacements: Array<{ from: number; to: number; value: string }> = [];
    const visitFormat = (current: SyntaxNode) => {
        for (const child of directChildren(current)) {
            if (child.name === 'FormatReplacement') {
                const innerEdits: Array<{ from: number; to: number; value: string }> = [];
                const visitInner = (expr: SyntaxNode, parent: SyntaxNode) => {
                    if (expr.name === 'String' || expr.name === 'FormatString') {
                        innerEdits.push({ from: expr.from, to: expr.to, value: formatLiteralNode(expr, text, renameMap) });
                        return;
                    }
                    if (expr.name === 'VariableName' && !isKeywordArgLabel(parent, expr)) {
                        const raw = text.slice(expr.from, expr.to);
                        const renamed = renameMap.get(raw);
                        if (renamed) innerEdits.push({ from: expr.from, to: expr.to, value: renamed });
                        return;
                    }
                    for (const sub of directChildren(expr)) visitInner(sub, expr);
                };
                for (const sub of directChildren(child)) visitInner(sub, child);
                innerEdits.sort((a, b) => b.from - a.from);
                let replaced = text.slice(child.from, child.to);
                for (const edit of innerEdits) {
                    replaced = replaced.slice(0, edit.from - child.from) + edit.value + replaced.slice(edit.to - child.from);
                }
                replacements.push({ from: child.from, to: child.to, value: replaced });
            } else {
                visitFormat(child);
            }
        }
    };
    visitFormat(node);
    replacements.sort((a, b) => b.from - a.from);
    let result = text.slice(node.from, node.to);
    for (const rep of replacements) {
        result = result.slice(0, rep.from - node.from) + rep.value + result.slice(rep.to - node.from);
    }
    return result;
}

/**
 * Normalize a node's Python code for structural comparison:
 * - Strip comments and blank lines
 * - Strip leading module/function docstring
 * - Replace the top-level definition name with `_fn`
 * - Alpha-rename parameter names to `_p0`, `_p1`, ... across the definition (excluding strings, attribute accesses, and keyword-argument labels)
 * - Normalize internal whitespace outside string literals while preserving exact string contents
 */
export function normalizeNodeCode(source: string, definitionName?: string, paramNames: string[] = []): string {
    const rawLines = source.replace(/\r\n?/g, '\n').split('\n')
        .map(stripLineComment)
        .map(line => line.trimEnd())
        .filter(line => line.trim().length > 0);
    const lines = stripLeadingDocstring(rawLines);
    const renameMap = new Map<string, string>();
    if (definitionName) renameMap.set(definitionName, '_fn');
    paramNames.forEach((param, index) => {
        if (param && param !== 'self' && param !== 'cls') renameMap.set(param, `_p${index}`);
    });
    const joined = lines.join('\n');
    const literals: string[] = [];
    const edits: Array<{ from: number; to: number; replacement: string }> = [];
    const collectEdits = (node: SyntaxNode, parent: SyntaxNode | null) => {
        if (node.name === 'String' || node.name === 'FormatString') {
            const index = literals.length;
            literals.push(formatLiteralNode(node, joined, renameMap));
            edits.push({ from: node.from, to: node.to, replacement: `__SLATE_STR_${index}__` });
            return;
        }
        if (node.name === 'VariableName' && (!parent || !isKeywordArgLabel(parent, node))) {
            const raw = joined.slice(node.from, node.to);
            const renamed = renameMap.get(raw);
            if (renamed) edits.push({ from: node.from, to: node.to, replacement: renamed });
            return;
        }
        for (const child of directChildren(node)) collectEdits(child, node);
    };
    collectEdits(parser.parse(joined).topNode, null);
    edits.sort((a, b) => b.from - a.from);
    let masked = joined;
    for (const edit of edits) {
        masked = masked.slice(0, edit.from) + edit.replacement + masked.slice(edit.to);
    }
    return masked.split('\n').map(line => {
        const indent = line.match(/^[ \t]*/)?.[0].replace(/\t/g, '    ') ?? '';
        const body = line.trim()
            .replace(/\s+/g, ' ')
            .replace(/\s*(->|[(),:[\]])\s*/g, '$1')
            .replace(/__SLATE_STR_(\d+)__/g, (_, idx) => literals[Number(idx)] ?? '');
        return `${indent}${body}`;
    }).join('\n');
}

function tokenizeNormalized(normalized: string): string[] {
    return (normalized.match(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|==|!=|<=|>=|->|\/\/|\*\*|[+\-*/%<>()[\]{}.,:=]/g) ?? [])
        .filter(token => !PYTHON_KEYWORDS.has(token) || ['return', 'if', 'else', 'elif', 'for', 'while', 'raise', 'try', 'except', 'with', 'yield'].includes(token));
}

function tokenSimilarity(leftTokens: string[], rightTokens: string[]): number {
    if (leftTokens.length === 0 && rightTokens.length === 0) return 1;
    if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
    const trigrams = (tokens: string[]): Map<string, number> => {
        const counts = new Map<string, number>();
        const list = tokens.length < 3 ? [tokens.join(' ')] : tokens.slice(0, -2).map((_, idx) => `${tokens[idx]} ${tokens[idx + 1]} ${tokens[idx + 2]}`);
        for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1);
        return counts;
    };
    const leftMap = trigrams(leftTokens);
    const rightMap = trigrams(rightTokens);
    let intersection = 0;
    let total = 0;
    for (const [key, count] of leftMap) {
        total += count;
        intersection += Math.min(count, rightMap.get(key) ?? 0);
    }
    for (const count of rightMap.values()) total += count;
    return total === 0 ? 0 : (2 * intersection) / total;
}

function importBoundNames(statement: string): Set<string> {
    const names = new Set<string>();
    const visit = (node: SyntaxNode) => {
        if (node.name === 'ImportStatement') {
            const tokens = directChildren(node)
                .filter(child => !['(', ')'].includes(child.name))
                .map(child => ({ name: child.name, text: statement.slice(child.from, child.to) }));
            if (tokens[0]?.name === 'from') {
                const importAt = tokens.findIndex(token => token.name === 'import');
                const rest = importAt >= 0 ? tokens.slice(importAt + 1) : [];
                for (let index = 0; index < rest.length; index++) {
                    const token = rest[index];
                    if (token.name !== 'VariableName') continue;
                    const alias = rest[index + 1]?.name === 'as' ? rest[index + 2]?.text : undefined;
                    names.add(alias ?? token.text);
                    if (alias) index += 2;
                }
            } else {
                let dotted: string[] = [];
                const flush = (alias?: string) => {
                    if (!dotted.length) return;
                    names.add(alias ?? dotted[0]);
                    dotted = [];
                };
                for (let index = 1; index < tokens.length; index++) {
                    const token = tokens[index];
                    if (token.name === 'VariableName') dotted.push(token.text);
                    else if (token.name === 'as') { flush(tokens[index + 1]?.text); index++; }
                    else if (token.name === ',') flush();
                }
                flush();
            }
            return;
        }
        for (const child of directChildren(node)) visit(child);
    };
    visit(parser.parse(statement).topNode);
    return names;
}

interface Scope {
    bound: Set<string>;
    parent: Scope | null;
}

function isBoundInScope(scope: Scope | null, name: string): boolean {
    let cursor = scope;
    while (cursor) {
        if (cursor.bound.has(name)) return true;
        cursor = cursor.parent;
    }
    return false;
}

/**
 * Collect free variable references from Python syntax, excluding:
 * - String literals and comments
 * - Property accesses (`obj.attr`) and keyword-argument labels (`fn(kw=1)`)
 * - The node's own definition/nested definitions, parameters, local assignments, loop/comprehension/with/except bindings, and imported names (tracked per lexical Python scope)
 */
function freeCodeReferences(source: string, imports: string[] = []): Set<string> {
    const rootScope: Scope = { bound: new Set<string>(), parent: null };
    for (const line of imports) {
        for (const bound of importBoundNames(line)) rootScope.bound.add(bound);
    }
    const nonRefRanges = new Set<string>();
    const refScopes = new Map<string, Scope>();
    const tree = parser.parse(source);

    const markAllVariablesNonRef = (node: SyntaxNode) => {
        if (node.name === 'VariableName') nonRefRanges.add(`${node.from}:${node.to}`);
        for (const child of directChildren(node)) markAllVariablesNonRef(child);
    };

    const collectTargetVariables = (node: SyntaxNode, scope: Scope) => {
        if (node.name === 'VariableName') {
            scope.bound.add(source.slice(node.from, node.to));
            nonRefRanges.add(`${node.from}:${node.to}`);
            return;
        }
        if (['TupleExpression', 'ArrayExpression', 'ParenthesizedExpression'].includes(node.name)) {
            for (const child of directChildren(node)) collectTargetVariables(child, scope);
        }
    };

    const collectParamList = (paramListNode: SyntaxNode, paramScope: Scope, defaultScope: Scope) => {
        const children = directChildren(paramListNode);
        let group: SyntaxNode[] = [];
        const flush = () => {
            if (group.length === 0) return;
            const assignAt = group.findIndex(child => child.name === 'AssignOp');
            const head = assignAt >= 0 ? group.slice(0, assignAt) : group;
            const tail = assignAt >= 0 ? group.slice(assignAt + 1) : [];
            const paramName = head.find(child => child.name === 'VariableName');
            if (paramName) collectTargetVariables(paramName, paramScope);
            for (const child of head) {
                if (child !== paramName) visit(child, defaultScope);
            }
            for (const child of tail) visit(child, defaultScope);
            group = [];
        };
        for (const child of children) {
            if (child.name === '(' || child.name === ')') continue;
            if (child.name === ',') flush();
            else group.push(child);
        }
        flush();
    };

    const visit = (node: SyntaxNode, scope: Scope) => {
        if (node.name === 'VariableName') {
            refScopes.set(`${node.from}:${node.to}`, scope);
        }
        const children = directChildren(node);
        if (node.name === 'FunctionDefinition' || node.name === 'ClassDefinition') {
            const nameNode = children.find(child => child.name === 'VariableName');
            if (nameNode) collectTargetVariables(nameNode, scope);
            const innerScope: Scope = { bound: new Set<string>(), parent: scope };
            for (const child of children) {
                if (child === nameNode) continue;
                if (child.name === 'ParamList') {
                    collectParamList(child, innerScope, scope);
                } else if (child.name === 'Body') {
                    visit(child, innerScope);
                } else {
                    visit(child, scope);
                }
            }
            return;
        }
        if (node.name === 'LambdaExpression') {
            const innerScope: Scope = { bound: new Set<string>(), parent: scope };
            for (const child of children) {
                if (child.name === 'ParamList') {
                    collectParamList(child, innerScope, scope);
                } else {
                    visit(child, innerScope);
                }
            }
            return;
        }
        if (['ArrayComprehensionExpression', 'SetComprehensionExpression', 'DictionaryComprehensionExpression', 'GeneratorExpression', 'ComprehensionExpression'].includes(node.name)) {
            const innerScope: Scope = { bound: new Set<string>(), parent: scope };
            for (let idx = 0; idx < children.length; idx++) {
                if (children[idx].name === 'for') {
                    for (let cursor = idx + 1; cursor < children.length && children[cursor].name !== 'in'; cursor++) {
                        collectTargetVariables(children[cursor], innerScope);
                    }
                }
            }
            for (const child of children) visit(child, innerScope);
            return;
        }
        if (node.name === 'AssignStatement') {
            let lastAssign = -1;
            for (let idx = 0; idx < children.length; idx++) {
                if (children[idx].name === 'AssignOp') lastAssign = idx;
            }
            if (lastAssign >= 0) {
                for (const child of children.slice(0, lastAssign)) {
                    if (child.name !== 'TypeDef' && child.name !== 'AssignOp') collectTargetVariables(child, scope);
                }
            } else {
                const typeDefAt = children.findIndex(child => child.name === 'TypeDef');
                if (typeDefAt > 0) {
                    for (const child of children.slice(0, typeDefAt)) collectTargetVariables(child, scope);
                }
            }
        } else if (node.name === 'UpdateStatement') {
            const updateAt = children.findIndex(child => child.name === 'UpdateOp');
            if (updateAt > 0) {
                for (const child of children.slice(0, updateAt)) collectTargetVariables(child, scope);
            }
        } else if (node.name === 'NamedExpression') {
            const assignAt = children.findIndex(child => child.name === 'AssignOp');
            if (assignAt > 0) {
                for (const child of children.slice(0, assignAt)) collectTargetVariables(child, scope);
            }
        } else if (node.name === 'ForStatement') {
            for (let idx = 0; idx < children.length; idx++) {
                if (children[idx].name === 'for') {
                    for (let cursor = idx + 1; cursor < children.length && children[cursor].name !== 'in'; cursor++) {
                        collectTargetVariables(children[cursor], scope);
                    }
                }
            }
        } else if (node.name === 'WithStatement' || node.name === 'TryStatement') {
            for (let idx = 0; idx < children.length; idx++) {
                if (children[idx].name === 'as' && children[idx + 1]) {
                    collectTargetVariables(children[idx + 1], scope);
                }
            }
        } else if (node.name === 'ImportStatement') {
            for (const bound of importBoundNames(source.slice(node.from, node.to))) scope.bound.add(bound);
            markAllVariablesNonRef(node);
            return;
        } else if (node.name === 'GlobalStatement' || node.name === 'NonlocalStatement') {
            markAllVariablesNonRef(node);
            return;
        } else if (node.name === 'ArgList') {
            for (let idx = 0; idx < children.length; idx++) {
                if (children[idx].name === 'VariableName' && children[idx + 1]?.name === 'AssignOp') {
                    nonRefRanges.add(`${children[idx].from}:${children[idx].to}`);
                }
            }
        }
        for (const child of children) visit(child, scope);
    };
    visit(tree.topNode, rootScope);

    const references = new Set<string>();
    const collectRefs = (node: SyntaxNode) => {
        if (node.name === 'VariableName') {
            const key = `${node.from}:${node.to}`;
            if (!nonRefRanges.has(key)) {
                const name = source.slice(node.from, node.to);
                const scope = refScopes.get(key) ?? rootScope;
                if (!isBoundInScope(scope, name) && !PYTHON_KEYWORDS.has(name)) references.add(name);
            }
            return;
        }
        for (const child of directChildren(node)) collectRefs(child);
    };
    collectRefs(tree.topNode);
    return references;
}

/**
 * Line-by-line LCS diff between two node code strings for side-by-side / unified review.
 */
export function diffNodeCode(leftSource: string, rightSource: string): DiffLine[] {
    const left = leftSource.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    const right = rightSource.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    const n = left.length;
    const m = right.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = left[i] === right[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const result: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (left[i] === right[j]) {
            result.push({ kind: 'same', leftLine: i + 1, rightLine: j + 1, text: left[i] });
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            result.push({ kind: 'remove', leftLine: i + 1, rightLine: null, text: left[i] });
            i++;
        } else {
            result.push({ kind: 'add', leftLine: null, rightLine: j + 1, text: right[j] });
            j++;
        }
    }
    while (i < n) {
        result.push({ kind: 'remove', leftLine: i + 1, rightLine: null, text: left[i] });
        i++;
    }
    while (j < m) {
        result.push({ kind: 'add', leftLine: null, rightLine: j + 1, text: right[j] });
        j++;
    }
    return result;
}

/**
 * Build a read-only Node Health Report from the current snapshot:
 * - Unreferenced definition candidates (no flow instances, no canvas refs, no resolved code `uses` or bare-name references)
 * - Exact duplicates (identical normalized code)
 * - Near duplicates (heuristic token-trigram similarity >= 0.65 on non-trivial bodies)
 * - Explicit coverage caveats (dynamic imports, `import pkg` module-qualified calls, external entrypoints)
 */
export function buildNodeHealthReport(snapshot: HarnessSnapshot): NodeHealthReport {
    const definitions: Array<{
        nodeId: string;
        document: HarnessDocument;
        unit: HarnessUnit;
        source: string;
        normalized: string;
        tokens: string[];
    }> = [];
    const byName = new Map<string, string[]>();
    for (const document of snapshot.documents) {
        if (document.nodeKind || !document.valid) continue;
        const top = document.units.find(unit => unit.parentId === null);
        if (!top) continue;
        const nodeId = nodeIdOf(document.path);
        const source = document.source ?? '';
        const paramNames = (top.params ?? unitSignature(top, document.units)?.params ?? []).map(param => param.name);
        const normalized = normalizeNodeCode(source, top.name, paramNames);
        const tokens = tokenizeNormalized(normalized);
        definitions.push({ nodeId, document, unit: top, source, normalized, tokens });
        byName.set(top.name, [...(byName.get(top.name) ?? []), nodeId]);
    }
    definitions.sort((a, b) => a.nodeId.localeCompare(b.nodeId));

    // Track runtime/code references vs prompt-only context links.
    const referenced = new Set<string>();
    const contextConsumers = new Map<string, string[]>();

    for (const ref of snapshot.refs ?? []) referenced.add(ref.target);
    for (const item of snapshot.flows ?? []) {
        for (const instance of item.flow?.instances ?? []) {
            if (instance.node) referenced.add(instance.node);
        }
    }
    for (const placeholder of snapshot.placeholders ?? []) {
        const matches = definitions.filter(def => def.nodeId === placeholder.name || def.unit.name === placeholder.name);
        if (matches.length === 1) referenced.add(matches[0].nodeId);
    }

    const caveats = new Set<string>([
        'No known references does not mean safe to delete: external callers, CLI/test entrypoints, reflection, and dynamic dispatch are outside static graph indexing.',
    ]);

    for (const document of snapshot.documents) {
        const callerId = nodeIdOf(document.path);
        const callerFolder = folderOf(callerId);
        for (const used of document.uses ?? []) {
            if (used !== callerId) referenced.add(used);
        }
        const top = document.units.find(unit => unit.parentId === null);
        const deps = Array.isArray(top?.annotation?.dependencies)
            ? top.annotation.dependencies.filter((d): d is string => typeof d === 'string')
            : [];
        for (const dep of deps) {
            if (dep !== callerId) {
                contextConsumers.set(dep, [...(contextConsumers.get(dep) ?? []), callerId].sort());
            }
        }
        const source = document.source ?? '';
        const combinedText = `${(document.imports ?? []).join('\n')}\n${source}`;
        if (/\b(?:importlib|__import__|getattr|globals|eval|exec)\b/.test(combinedText)) {
            caveats.add(`Dynamic import or reflection in ${callerId} (importlib / __import__ / getattr / eval) is not resolved statically.`);
        }
        for (const line of document.imports ?? []) {
            if (/^import\s+\S+/.test(line.trim())) {
                caveats.add(`Module-style import "${line.trim()}" in ${callerId}: attribute calls (module.fn) are not tracked as node uses.`);
            }
        }
        const identifiers = freeCodeReferences(source, document.imports ?? []);
        for (const name of identifiers) {
            if (top && name === top.name) continue;
            // Same-folder node with this name, or unique node across the project.
            const candidates = byName.get(name) ?? [];
            const sameFolder = candidates.find(id => folderOf(id) === callerFolder && id !== callerId);
            if (sameFolder) referenced.add(sameFolder);
            else if (candidates.length === 1 && candidates[0] !== callerId) referenced.add(candidates[0]);
        }
    }

    const unreferenced: UnreferencedCandidate[] = definitions
        .filter(def => !referenced.has(def.nodeId))
        .map(def => ({
            nodeId: def.nodeId,
            name: def.unit.name,
            signature: def.unit.signature ?? null,
            intent: typeof def.unit.annotation?.intent === 'string' ? def.unit.annotation.intent : '',
            contextOnlyBy: contextConsumers.get(def.nodeId) ?? [],
        }));

    // Exact duplicates: group definitions with identical non-empty normalized code
    const byNormalized = new Map<string, string[]>();
    for (const def of definitions) {
        if (!def.normalized.trim()) continue;
        byNormalized.set(def.normalized, [...(byNormalized.get(def.normalized) ?? []), def.nodeId]);
    }
    const exactDuplicates: DuplicateGroup[] = [...byNormalized.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([normalizedCode, nodeIds]) => ({ normalizedCode, nodeIds: nodeIds.sort() }))
        .sort((a, b) => a.nodeIds[0].localeCompare(b.nodeIds[0]));

    const exactPairs = new Set<string>();
    for (const group of exactDuplicates) {
        for (let i = 0; i < group.nodeIds.length; i++) {
            for (let j = i + 1; j < group.nodeIds.length; j++) {
                exactPairs.add(`${group.nodeIds[i]}::${group.nodeIds[j]}`);
            }
        }
    }

    // Near duplicates: heuristic token-trigram similarity on non-stub definitions
    const nearDuplicates: NearDuplicatePair[] = [];
    const isStub = (normalized: string) => /\braise NotImplementedError\b/.test(normalized) || normalized.split('\n').length < 2;
    for (let i = 0; i < definitions.length; i++) {
        const left = definitions[i];
        if (isStub(left.normalized) || left.tokens.length < 5) continue;
        for (let j = i + 1; j < definitions.length; j++) {
            const right = definitions[j];
            if (isStub(right.normalized) || right.tokens.length < 5) continue;
            if (exactPairs.has(`${left.nodeId}::${right.nodeId}`)) continue;
            const similarity = tokenSimilarity(left.tokens, right.tokens);
            if (similarity >= 0.65) {
                nearDuplicates.push({
                    leftId: left.nodeId,
                    rightId: right.nodeId,
                    similarity: Math.round(similarity * 100) / 100,
                });
            }
        }
    }
    nearDuplicates.sort((a, b) => b.similarity - a.similarity || a.leftId.localeCompare(b.leftId) || a.rightId.localeCompare(b.rightId));

    return {
        unreferenced,
        exactDuplicates,
        nearDuplicates,
        caveats: [...caveats],
    };
}
