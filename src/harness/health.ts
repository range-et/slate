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

/**
 * Normalize a node's Python code for structural comparison:
 * - Strip comments and blank lines
 * - Strip leading module/function docstring
 * - Replace the top-level definition name with `_fn`
 * - Alpha-rename parameter names to `_p0`, `_p1`, ... across the definition
 * - Normalize internal whitespace outside string literals
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
    return lines.map(line => {
        const indent = line.match(/^[ \t]*/)?.[0].replace(/\t/g, '    ') ?? '';
        const body = line.trim()
            .replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, token => renameMap.get(token) ?? token)
            .replace(/\s+/g, ' ')
            .replace(/\s*(->|[(),:[\]])\s*/g, '$1');
        return `${indent}${body}`;
    }).join('\n');
}

function tokenizeNormalized(normalized: string): string[] {
    return (normalized.match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|==|!=|<=|>=|->|\/\/|\*\*|[+\-*/%<>()[\]{}.,:=]/g) ?? [])
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

function codeIdentities(source: string): Set<string> {
    const cleaned = source.replace(/\r\n?/g, '\n').split('\n').map(stripLineComment).join('\n');
    return new Set(cleaned.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []);
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
        const identifiers = codeIdentities(source);
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
