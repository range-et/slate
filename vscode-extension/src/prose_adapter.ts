import { createHash } from 'crypto';

import { inputPorts, outputPorts, parseEndpoint, type CallableSignature, type Port } from './flow';
import type { ParseModuleResult, ParsedUnit, SlateFlow, SourceRange, UnitParam } from './harness_protocol';
import type { SlateNode } from './slate_folder';

// Phase 8.5 (S-850): Prose / Grant & Research Mode ("ComfyUI for text", `language: "prose"`).
// Supports structured Prose port/wire types (`passage`, `citation`, `section`, `rubric`),
// prose operator signature parsing (`operator <name>(...) -> ...` or `def <name>(...) -> ...`),
// and deterministic per-node & per-flow prose contract verification (word/char budgets,
// required citations, forbidden terms, and rubric/section completeness).

export type ProsePortType = 'passage' | 'citation' | 'section' | 'rubric';

export const PROSE_PORT_TYPES: readonly ProsePortType[] = ['passage', 'citation', 'section', 'rubric'];

const PROSE_PORT_SET = new Set<string>(PROSE_PORT_TYPES);

export interface ProseContractSpec {
    minWords?: number;
    maxWords?: number;
    minChars?: number;
    maxChars?: number;
    requiredCitations?: string[];
    forbiddenTerms?: string[];
    requiredSections?: string[];
    rubricCriteria?: string[];
}

export interface ProseDiagnostic {
    code:
        | 'prose-syntax'
        | 'prose-port-type'
        | 'prose-word-budget'
        | 'prose-char-budget'
        | 'prose-missing-citation'
        | 'prose-forbidden-term'
        | 'prose-missing-section'
        | 'prose-rubric-incomplete'
        | 'prose-wire-error'
        | 'prose-flow-cycle';
    severity: 'error' | 'warning';
    message: string;
    nodeId?: string;
    flowId?: string;
}

export interface ProseVerificationResult {
    valid: boolean;
    wordCount: number;
    charCount: number;
    citationsFound: string[];
    sectionsFound: string[];
    diagnostics: ProseDiagnostic[];
    contract: ProseContractSpec;
}

export interface ParsedProseNode {
    name: string;
    kind: 'operator' | 'passage' | 'citation' | 'section' | 'rubric';
    signature: CallableSignature;
    inputs: Port[];
    outputs: Port[];
    bodyText: string;
    templateLines: string[];
    contractSpec: ProseContractSpec;
    diagnostics: ProseDiagnostic[];
}

const ZERO_RANGE: SourceRange = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
};

function hashProseSource(source: string): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(source, 'utf8').digest('hex')}`;
}

export function isProsePortType(value: string | null | undefined): value is ProsePortType {
    if (!value) return false;
    const normalized = normalizeProseAnnotation(value);
    return PROSE_PORT_SET.has(normalized);
}

export function normalizeProseAnnotation(annotation: string | null | undefined): string {
    if (!annotation) return 'passage';
    const trimmed = annotation.trim();
    const lower = trimmed.toLowerCase();
    if (PROSE_PORT_SET.has(lower)) return lower;
    if (lower === 'str' || lower === 'string' || lower === 'text') return 'passage';
    const listMatch = lower.match(/^(?:list|sequence)\[\s*([a-z_]+)\s*\]$/);
    if (listMatch && PROSE_PORT_SET.has(listMatch[1])) return listMatch[1];
    return trimmed;
}

/** Split parameter list at top-level commas, respecting brackets and quotes. */
function splitTopLevelParams(rawParams: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depth = 0;
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < rawParams.length; i++) {
        const ch = rawParams[i];
        if (quote) {
            current += ch;
            if (ch === quote && rawParams[i - 1] !== '\\') quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
            current += ch;
            continue;
        }
        if (ch === ')' || ch === ']' || ch === '}') {
            depth = Math.max(0, depth - 1);
            current += ch;
            continue;
        }
        if (ch === ',' && depth === 0) {
            if (current.trim()) parts.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function parseParamEntry(entry: string): { param: UnitParam; rawAnnotation: string | null } | null {
    const trimmed = entry.trim();
    if (!trimmed || trimmed === '/') return null;

    let defaultVal: string | null = null;
    let leftSide = trimmed;
    const eqIndex = findTopLevelChar(trimmed, '=');
    if (eqIndex >= 0) {
        leftSide = trimmed.slice(0, eqIndex).trim();
        defaultVal = trimmed.slice(eqIndex + 1).trim();
    }

    let kind: UnitParam['kind'] = 'keyword';
    if (leftSide.startsWith('**')) {
        kind = 'kwvar';
        leftSide = leftSide.slice(2).trim();
    } else if (leftSide.startsWith('*')) {
        kind = 'var';
        leftSide = leftSide.slice(1).trim();
    }

    const colonIndex = findTopLevelChar(leftSide, ':');
    let name = leftSide;
    let rawAnnotation: string | null = null;
    if (colonIndex >= 0) {
        name = leftSide.slice(0, colonIndex).trim();
        rawAnnotation = leftSide.slice(colonIndex + 1).trim() || null;
    }

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
    const normalizedAnn = rawAnnotation ? normalizeProseAnnotation(rawAnnotation) : 'passage';
    return {
        param: {
            name,
            annotation: normalizedAnn,
            default: defaultVal,
            kind,
        },
        rawAnnotation,
    };
}

function findTopLevelChar(text: string, target: string): number {
    let depth = 0;
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote && text[i - 1] !== '\\') quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
        else if (ch === target && depth === 0) return i;
    }
    return -1;
}

/**
 * Parse a prose operator/function header line such as:
 * - `operator synthesize(claim: passage, ref: citation) -> section:`
 * - `def tighten_abstract(draft: passage, rubric: rubric) -> passage:`
 * - `passage intro() -> passage:`
 */
export function parseProseSignatureLine(
    line: string,
    fallbackName = 'prose_node',
): {
    matched: boolean;
    kind: ParsedProseNode['kind'];
    name: string;
    params: UnitParam[];
    returns: string;
    rawReturn: string | null;
    rawParamAnnotations: Array<{ name: string; raw: string | null }>;
} {
    const trimmed = line.trim().replace(/:$/, '').trim();
    const headerRegex = /^(operator|def|passage|citation|section|rubric)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*(?:->\s*(.+))?$/;
    const match = trimmed.match(headerRegex);
    if (!match) {
        return {
            matched: false,
            kind: 'passage',
            name: fallbackName,
            params: [],
            returns: 'passage',
            rawReturn: null,
            rawParamAnnotations: [],
        };
    }

    const keyword = match[1];
    const name = match[2];
    const rawParams = match[3] ?? '';
    const rawReturn = match[4]?.trim() ?? null;

    const kind: ParsedProseNode['kind'] =
        keyword === 'def' || keyword === 'operator'
            ? 'operator'
            : (keyword as ParsedProseNode['kind']);

    const entries = splitTopLevelParams(rawParams);
    const params: UnitParam[] = [];
    const rawParamAnnotations: Array<{ name: string; raw: string | null }> = [];
    for (const entry of entries) {
        const parsed = parseParamEntry(entry);
        if (parsed) {
            params.push(parsed.param);
            rawParamAnnotations.push({ name: parsed.param.name, raw: parsed.rawAnnotation });
        }
    }

    const defaultReturn = kind === 'operator' ? 'passage' : kind;
    const returns = rawReturn ? normalizeProseAnnotation(rawReturn) : defaultReturn;

    return {
        matched: true,
        kind,
        name,
        params,
        returns,
        rawReturn,
        rawParamAnnotations,
    };
}

/**
 * Parse structured prose contract rules from `node.contract` text and/or `node.extra.proseContract` / `node.extra`.
 * Supports human-readable directives in `contract`:
 * - `maxWords: 250`, `max_words = 250`, `<= 250 words`, `word budget: 100..250`
 * - `minWords: 50`, `min_words = 50`, `>= 50 words`
 * - `maxChars: 1500`, `minChars: 100`, `<= 1500 chars`
 * - `requiredCitations: [@smith2024, @doe2023]` or `cite: smith2024, doe2023`
 * - `forbiddenTerms: [synergy, paradigm]` or `forbid: synergy, revolutionary`
 * - `requiredSections: [Specific Aims, Significance, Innovation]`
 * - `rubric: [Significance, Innovation, Approach]`
 */
export function parseProseContract(contractText: string, extra?: Record<string, unknown>): ProseContractSpec {
    const spec: ProseContractSpec = {};

    const applyRecord = (rec: Record<string, unknown>) => {
        if (typeof rec.minWords === 'number' && Number.isFinite(rec.minWords)) spec.minWords = rec.minWords;
        if (typeof rec.maxWords === 'number' && Number.isFinite(rec.maxWords)) spec.maxWords = rec.maxWords;
        if (typeof rec.minChars === 'number' && Number.isFinite(rec.minChars)) spec.minChars = rec.minChars;
        if (typeof rec.maxChars === 'number' && Number.isFinite(rec.maxChars)) spec.maxChars = rec.maxChars;
        if (Array.isArray(rec.requiredCitations)) {
            spec.requiredCitations = rec.requiredCitations
                .filter((x): x is string => typeof x === 'string')
                .map(normalizeCitationKey)
                .filter(Boolean);
        }
        if (Array.isArray(rec.forbiddenTerms)) {
            spec.forbiddenTerms = rec.forbiddenTerms
                .filter((x): x is string => typeof x === 'string')
                .map(s => s.trim())
                .filter(Boolean);
        }
        if (Array.isArray(rec.requiredSections)) {
            spec.requiredSections = rec.requiredSections
                .filter((x): x is string => typeof x === 'string')
                .map(s => s.trim())
                .filter(Boolean);
        }
        if (Array.isArray(rec.rubricCriteria)) {
            spec.rubricCriteria = rec.rubricCriteria
                .filter((x): x is string => typeof x === 'string')
                .map(s => s.trim())
                .filter(Boolean);
        }
    };

    if (extra) {
        applyRecord(extra);
        if (extra.proseContract && typeof extra.proseContract === 'object' && !Array.isArray(extra.proseContract)) {
            applyRecord(extra.proseContract as Record<string, unknown>);
        }
        if (extra.rubric && typeof extra.rubric === 'object' && !Array.isArray(extra.rubric)) {
            applyRecord(extra.rubric as Record<string, unknown>);
        }
    }

    const trimmed = (contractText ?? '').trim();
    if (!trimmed) return spec;

    // If contractText is valid JSON object, parse fields directly as well.
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                applyRecord(parsed as Record<string, unknown>);
                return spec;
            }
        } catch {
            // Fall through to text directive parsing.
        }
    }

    const maxWordsMatch =
        trimmed.match(/\b(?:maxWords|max_words|max\s+words)\s*[:=]\s*(\d+)/i) ??
        trimmed.match(/(?:<=|≤|at\s+most|under|max)\s*(\d+)\s*words\b/i);
    if (maxWordsMatch && spec.maxWords === undefined) {
        spec.maxWords = Number.parseInt(maxWordsMatch[1], 10);
    }

    const minWordsMatch =
        trimmed.match(/\b(?:minWords|min_words|min\s+words)\s*[:=]\s*(\d+)/i) ??
        trimmed.match(/(?:>=|≥|at\s+least|min)\s*(\d+)\s*words\b/i);
    if (minWordsMatch && spec.minWords === undefined) {
        spec.minWords = Number.parseInt(minWordsMatch[1], 10);
    }

    const wordRangeMatch = trimmed.match(/\b(\d+)\s*(?:\.\.|-|to)\s*(\d+)\s*words\b/i);
    if (wordRangeMatch) {
        if (spec.minWords === undefined) spec.minWords = Number.parseInt(wordRangeMatch[1], 10);
        if (spec.maxWords === undefined) spec.maxWords = Number.parseInt(wordRangeMatch[2], 10);
    }

    const maxCharsMatch =
        trimmed.match(/\b(?:maxChars|max_chars|max\s+chars|max\s+characters)\s*[:=]\s*(\d+)/i) ??
        trimmed.match(/(?:<=|≤|at\s+most|under|max)\s*(\d+)\s*(?:chars|characters)\b/i);
    if (maxCharsMatch && spec.maxChars === undefined) {
        spec.maxChars = Number.parseInt(maxCharsMatch[1], 10);
    }

    const minCharsMatch =
        trimmed.match(/\b(?:minChars|min_chars|min\s+chars|min\s+characters)\s*[:=]\s*(\d+)/i) ??
        trimmed.match(/(?:>=|≥|at\s+least|min)\s*(\d+)\s*(?:chars|characters)\b/i);
    if (minCharsMatch && spec.minChars === undefined) {
        spec.minChars = Number.parseInt(minCharsMatch[1], 10);
    }

    const parseListDirective = (pattern: RegExp): string[] | undefined => {
        const match = trimmed.match(pattern);
        if (!match) return undefined;
        const raw = match[1].trim().replace(/^\[/, '').replace(/\][,;\s]*$/, '');
        return raw
            .split(/[,;]/)
            .map(item => item.trim().replace(/^\[|\]$/g, '').replace(/^["']|["']$/g, ''))
            .filter(Boolean);
    };

    const citeList = parseListDirective(/\b(?:requiredCitations|required_citations|citations|cite)\s*[:=]\s*([^\n]+?)(?=\s+\b(?:minWords|maxWords|minChars|maxChars|forbiddenTerms|forbid|requiredSections|sections|rubricCriteria|rubric)\s*[:=]|$)/i);
    if (citeList && !spec.requiredCitations) {
        spec.requiredCitations = citeList.map(normalizeCitationKey).filter(Boolean);
    }

    const forbidList = parseListDirective(/\b(?:forbiddenTerms|forbidden_terms|forbidden|forbid)\s*[:=]\s*([^\n]+?)(?=\s+\b(?:minWords|maxWords|minChars|maxChars|requiredCitations|citations|cite|requiredSections|sections|rubricCriteria|rubric)\s*[:=]|$)/i);
    if (forbidList && !spec.forbiddenTerms) {
        spec.forbiddenTerms = forbidList;
    }

    const sectionList = parseListDirective(/\b(?:requiredSections|required_sections|sections)\s*[:=]\s*([^\n]+?)(?=\s+\b(?:minWords|maxWords|minChars|maxChars|requiredCitations|citations|cite|forbiddenTerms|forbid|rubricCriteria|rubric)\s*[:=]|$)/i);
    if (sectionList && !spec.requiredSections) {
        spec.requiredSections = sectionList;
    }

    const rubricList = parseListDirective(/\b(?:rubricCriteria|rubric_criteria|rubric)\s*[:=]\s*([^\n]+?)(?=\s+\b(?:minWords|maxWords|minChars|maxChars|requiredCitations|citations|cite|forbiddenTerms|forbid|requiredSections|sections)\s*[:=]|$)/i);
    if (rubricList && !spec.rubricCriteria) {
        spec.rubricCriteria = rubricList;
    }

    return spec;
}

export function normalizeCitationKey(raw: string): string {
    const trimmed = raw.trim();
    const pandocMatch = trimmed.match(/^\[?@([A-Za-z0-9_:-]+)\]?$/);
    if (pandocMatch) return pandocMatch[1];
    const latexMatch = trimmed.match(/^\\cite\{([A-Za-z0-9_:-]+)\}$/);
    if (latexMatch) return latexMatch[1];
    return trimmed.replace(/^@/, '');
}

/** Extract all citation keys referenced in prose text via `[@key]`, `@key` in brackets, or `\cite{key1,key2}`. */
export function extractCitations(text: string): string[] {
    const found = new Set<string>();
    // Match [@key] or [@key1; @key2] or [@key1, @key2]
    const bracketRegex = /\[([^\[\]]*@[A-Za-z0-9_:-]+[^\[\]]*)\]/g;
    for (const match of text.matchAll(bracketRegex)) {
        const inner = match[1];
        const keyMatches = inner.matchAll(/@([A-Za-z0-9_:-]+)/g);
        for (const km of keyMatches) {
            found.add(km[1]);
        }
    }
    // Match \cite{key1, key2} or \citet{...} or \citep{...}
    const latexRegex = /\\cite[a-zA-Z]*\{([^}]+)\}/g;
    for (const match of text.matchAll(latexRegex)) {
        const keys = match[1].split(',').map(k => k.trim()).filter(Boolean);
        for (const k of keys) {
            found.add(k);
        }
    }
    return [...found];
}

/** Count words in prose text deterministically (stripping markdown/latex formatting markers only if standalone). */
export function countProseWords(text: string): number {
    const cleaned = text
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .trim();
    if (!cleaned) return 0;
    const tokens = cleaned
        .split(/\s+/)
        .map(tok => tok.replace(/^[^A-Za-z0-9@\\]+|[^A-Za-z0-9}]+$/g, ''))
        .filter(tok => tok.length > 0);
    return tokens.length;
}

/** Extract section headings from Markdown (`# Heading`) or LaTeX (`\section{Heading}`) or `## Heading`. */
export function extractSections(text: string): string[] {
    const sections: string[] = [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        const mdMatch = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
        if (mdMatch) {
            sections.push(mdMatch[1].trim());
            continue;
        }
        const latexMatches = line.matchAll(/\\(?:sub)*section\*?\{([^}]+)\}/g);
        for (const lm of latexMatches) {
            sections.push(lm[1].trim());
        }
    }
    return sections;
}

function unindentLines(lines: string[]): string[] {
    const nonEmpty = lines.filter(l => l.trim().length > 0);
    if (nonEmpty.length === 0) return [];
    const minIndent = Math.min(
        ...nonEmpty.map(l => l.match(/^[ \t]*/)?.[0].length ?? 0),
    );
    return lines.map(l => l.slice(minIndent));
}

function stripReturnOrTripleQuotes(bodyText: string): string {
    const trimmed = bodyText.trim();
    if (!trimmed) return '';
    if (trimmed === 'pass' || trimmed === '...' || /^raise\s+NotImplementedError/.test(trimmed)) {
        return '';
    }
    let expr = trimmed;
    if (expr.startsWith('return ')) {
        expr = expr.slice('return '.length).trim();
    }
    if ((expr.startsWith('f"""') || expr.startsWith('"""')) && expr.endsWith('"""')) {
        const prefixLen = expr.startsWith('f"""') ? 4 : 3;
        return expr.slice(prefixLen, -3).trim();
    }
    if ((expr.startsWith("f'''") || expr.startsWith("'''")) && expr.endsWith("'''")) {
        const prefixLen = expr.startsWith("f'''") ? 4 : 3;
        return expr.slice(prefixLen, -3).trim();
    }
    if ((expr.startsWith('f"') || expr.startsWith('"')) && expr.endsWith('"') && !expr.slice(2, -1).includes('"')) {
        const prefixLen = expr.startsWith('f"') ? 2 : 1;
        return expr.slice(prefixLen, -1);
    }
    if ((expr.startsWith("f'") || expr.startsWith("'")) && expr.endsWith("'") && !expr.slice(2, -1).includes("'")) {
        const prefixLen = expr.startsWith("f'") ? 2 : 1;
        return expr.slice(prefixLen, -1);
    }
    return trimmed;
}

/**
 * Parse a `SlateNode` in prose mode (`language: "prose"`), extracting its
 * prose signature, typed ports (`passage`, `citation`, `section`, `rubric`),
 * template/body text, and contract specification.
 */
export function parseProseNode(node: SlateNode, nodeId = node.name): ParsedProseNode {
    const diagnostics: ProseDiagnostic[] = [];
    const rawLines = node.code ?? [];
    const firstNonEmptyIdx = rawLines.findIndex(l => l.trim().length > 0 && !l.trim().startsWith('#'));

    let kind: ParsedProseNode['kind'] = 'operator';
    let signature: CallableSignature;
    let templateLines: string[];

    const parsedSig = parseProseSignatureLine(rawLines[firstNonEmptyIdx] ?? '', node.name);
    if (parsedSig.matched) {
        kind = parsedSig.kind;
        if (parsedSig.name !== node.name) {
            diagnostics.push({
                code: 'prose-syntax',
                severity: 'error',
                message: `Prose node "${nodeId}" declares signature name "${parsedSig.name}" which does not match node name "${node.name}".`,
                nodeId,
            });
        }
        for (const p of parsedSig.rawParamAnnotations) {
            if (p.raw !== null && !isProsePortType(p.raw) && !['str', 'string', 'text'].includes(p.raw.toLowerCase())) {
                diagnostics.push({
                    code: 'prose-port-type',
                    severity: 'warning',
                    message: `Parameter "${p.name}" on prose node "${node.name}" uses non-standard prose port type "${p.raw}" (expected passage, citation, section, or rubric).`,
                    nodeId,
                });
            }
        }
        if (
            parsedSig.rawReturn !== null &&
            !isProsePortType(parsedSig.rawReturn) &&
            !['str', 'string', 'text'].includes(parsedSig.rawReturn.toLowerCase())
        ) {
            diagnostics.push({
                code: 'prose-port-type',
                severity: 'warning',
                message: `Return type on prose node "${node.name}" uses non-standard prose port type "${parsedSig.rawReturn}" (expected passage, citation, section, or rubric).`,
                nodeId,
            });
        }
        signature = {
            name: parsedSig.name,
            params: parsedSig.params,
            returns: parsedSig.returns,
        };
        const rest = unindentLines(rawLines.slice(firstNonEmptyIdx + 1));
        const stripped = stripReturnOrTripleQuotes(rest.join('\n'));
        templateLines = stripped ? stripped.split(/\r?\n/) : [];
    } else {
        // Plain passage/text node without explicit operator header: infer `{param}` placeholders as `passage` inputs
        kind = (typeof node.extra?.proseKind === 'string' && isProsePortType(node.extra.proseKind))
            ? node.extra.proseKind
            : 'passage';
        const fullText = rawLines.join('\n');
        const placeholderMatches = [...fullText.matchAll(/\{\{?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}?\}/g)];
        const seenParams = new Set<string>();
        const params: UnitParam[] = [];
        for (const m of placeholderMatches) {
            const pName = m[1];
            if (!seenParams.has(pName)) {
                seenParams.add(pName);
                params.push({
                    name: pName,
                    annotation: 'passage',
                    default: null,
                    kind: 'keyword',
                });
            }
        }
        const returnType = (typeof node.extra?.returnType === 'string' && isProsePortType(node.extra.returnType))
            ? node.extra.returnType
            : kind;
        signature = {
            name: node.name,
            params,
            returns: returnType,
        };
        templateLines = [...rawLines];
    }

    const contractSpec = parseProseContract(node.contract, node.extra);
    const bodyText = templateLines.join('\n').trim();

    return {
        name: node.name,
        kind,
        signature,
        inputs: inputPorts(signature),
        outputs: outputPorts(signature),
        bodyText,
        templateLines,
        contractSpec,
        diagnostics,
    };
}

export function proseStub(signature: string, expectedName: string, intent: string): SlateNode {
    const header = signature.trim();
    const parsed = parseProseSignatureLine(header, expectedName);
    if (!parsed.matched || parsed.name !== expectedName || /[\r\n]/.test(header)) {
        throw new Error('Use one prose operator signature with the requested name.');
    }
    return {
        name: expectedName, language: 'prose', intent, contract: '', context: [],
        examples: [], locked: false, imports: [], uses: [],
        code: [header.endsWith(':') ? header : header + ':'], extra: {},
    };
}

/**
 * Parse a prose source module into a `ParseModuleResult` compatible with `HarnessDocument` and `slate_folder.ts`.
 */
export function parseProseModule(source: string, documentPath = '<prose>', nodeId?: string, node?: SlateNode): ParseModuleResult {
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const fallbackName = nodeId ? (nodeId.split('/').pop() ?? nodeId) : 'prose_node';
    const firstNonEmptyIdx = lines.findIndex(l => l.trim().length > 0 && !l.trim().startsWith('#'));
    const headerLine = firstNonEmptyIdx >= 0 ? lines[firstNonEmptyIdx] : '';
    const parsedSig = parseProseSignatureLine(headerLine, fallbackName);

    const endLine = Math.max(0, lines.length - 1);
    const endChar = lines[endLine]?.length ?? 0;
    const declarationRange: SourceRange = {
        start: { line: 0, character: 0 },
        end: { line: endLine, character: endChar },
    };

    const parsedNode = node ? parseProseNode(node, nodeId ?? node.name) : undefined;
    const name = parsedNode?.signature.name ?? (parsedSig.matched ? parsedSig.name : fallbackName);
    const params = parsedNode?.signature.params ?? (parsedSig.matched ? parsedSig.params : []);
    const returnAnnotation = parsedNode?.signature.returns ?? (parsedSig.matched ? parsedSig.returns : 'passage');
    const paramStr = params.map(p => `${p.name}: ${p.annotation ?? 'passage'}`).join(', ');

    const unit: ParsedUnit = {
        id: nodeId ?? name,
        identity: 'durable',
        kind: 'function',
        name,
        qualifiedName: name,
        parentId: null,
        ranges: {
            name: ZERO_RANGE,
            declaration: declarationRange,
        },
        annotation: null,
        decorators: [],
        parameters: paramStr,
        params,
        returnAnnotation,
        signature: `operator ${name}(${paramStr}) -> ${returnAnnotation}`,
    };

    return {
        path: documentPath,
        sourceHash: hashProseSource(source),
        valid: !parsedNode?.diagnostics.some(item => item.severity === 'error'),
        units: [unit],
        diagnostics: parsedNode?.diagnostics.map(item => ({ code: item.code, message: item.message, range: ZERO_RANGE })) ?? [],
    };
}

/**
 * Verify a prose text passage or compiled document against a `ProseContractSpec`.
 */
export function verifyProseText(
    text: string,
    contract: ProseContractSpec,
    context?: { nodeId?: string; flowId?: string },
): ProseVerificationResult {
    const diagnostics: ProseDiagnostic[] = [];
    const wordCount = countProseWords(text);
    const charCount = text.length;
    const citationsFound = extractCitations(text);
    const sectionsFound = extractSections(text);
    const label = context?.nodeId
        ? `Node "${context.nodeId}"`
        : context?.flowId
            ? `Flow "${context.flowId}"`
            : 'Prose text';

    if (contract.minWords !== undefined && wordCount < contract.minWords) {
        diagnostics.push({
            code: 'prose-word-budget',
            severity: 'error',
            message: `${label} is under minimum word budget: ${wordCount} words (minWords: ${contract.minWords}).`,
            nodeId: context?.nodeId,
            flowId: context?.flowId,
        });
    }

    if (contract.maxWords !== undefined && wordCount > contract.maxWords) {
        diagnostics.push({
            code: 'prose-word-budget',
            severity: 'error',
            message: `${label} exceeds maximum word budget: ${wordCount} words (maxWords: ${contract.maxWords}).`,
            nodeId: context?.nodeId,
            flowId: context?.flowId,
        });
    }

    if (contract.minChars !== undefined && charCount < contract.minChars) {
        diagnostics.push({
            code: 'prose-char-budget',
            severity: 'error',
            message: `${label} is under minimum character budget: ${charCount} chars (minChars: ${contract.minChars}).`,
            nodeId: context?.nodeId,
            flowId: context?.flowId,
        });
    }

    if (contract.maxChars !== undefined && charCount > contract.maxChars) {
        diagnostics.push({
            code: 'prose-char-budget',
            severity: 'error',
            message: `${label} exceeds maximum character budget: ${charCount} chars (maxChars: ${contract.maxChars}).`,
            nodeId: context?.nodeId,
            flowId: context?.flowId,
        });
    }

    if (contract.requiredCitations && contract.requiredCitations.length > 0) {
        const citationSet = new Set(citationsFound.map(c => c.toLowerCase()));
        for (const req of contract.requiredCitations) {
            const normReq = normalizeCitationKey(req);
            if (!citationSet.has(normReq.toLowerCase())) {
                diagnostics.push({
                    code: 'prose-missing-citation',
                    severity: 'error',
                    message: `${label} is missing required citation "[@${normReq}]" (or "\\cite{${normReq}}").`,
                    nodeId: context?.nodeId,
                    flowId: context?.flowId,
                });
            }
        }
    }

    if (contract.forbiddenTerms && contract.forbiddenTerms.length > 0) {
        const lowerText = text.toLowerCase();
        for (const term of contract.forbiddenTerms) {
            const cleanTerm = term.trim();
            if (!cleanTerm) continue;
            if (lowerText.includes(cleanTerm.toLowerCase())) {
                diagnostics.push({
                    code: 'prose-forbidden-term',
                    severity: 'error',
                    message: `${label} contains forbidden term or claim "${cleanTerm}".`,
                    nodeId: context?.nodeId,
                    flowId: context?.flowId,
                });
            }
        }
    }

    if (contract.requiredSections && contract.requiredSections.length > 0) {
        const lowerSections = sectionsFound.map(s => s.toLowerCase());
        const lowerText = text.toLowerCase();
        for (const reqSection of contract.requiredSections) {
            const target = reqSection.trim().toLowerCase();
            if (!target) continue;
            const hasHeading = lowerSections.some(s => s === target || s.includes(target));
            const hasBoldOrInlineHeader = lowerText.includes(`# ${target}`) || lowerText.includes(`**${target}**`);
            if (!hasHeading && !hasBoldOrInlineHeader) {
                diagnostics.push({
                    code: 'prose-missing-section',
                    severity: 'error',
                    message: `${label} is missing required section "${reqSection}".`,
                    nodeId: context?.nodeId,
                    flowId: context?.flowId,
                });
            }
        }
    }

    if (contract.rubricCriteria && contract.rubricCriteria.length > 0) {
        const lowerSections = sectionsFound.map(s => s.toLowerCase());
        const lowerText = text.toLowerCase();
        for (const criterion of contract.rubricCriteria) {
            const target = criterion.trim().toLowerCase();
            if (!target) continue;
            const addressedInSection = lowerSections.some(s => s.includes(target));
            const addressedInBody = lowerText.includes(target);
            if (!addressedInSection && !addressedInBody) {
                diagnostics.push({
                    code: 'prose-rubric-incomplete',
                    severity: 'error',
                    message: `${label} does not satisfy grant/research rubric criterion "${criterion}".`,
                    nodeId: context?.nodeId,
                    flowId: context?.flowId,
                });
            }
        }
    }

    return {
        valid: diagnostics.every(d => d.severity !== 'error'),
        wordCount,
        charCount,
        citationsFound,
        sectionsFound,
        diagnostics,
        contract,
    };
}

/**
 * Deterministically verify a single `SlateNode` in prose mode (`language: "prose"`).
 * Evaluates the node's body text (or `candidateText` if provided) against its parsed contract.
 */
export function verifyProseNode(
    node: SlateNode,
    options?: { nodeId?: string; candidateText?: string; contractOverride?: Partial<ProseContractSpec> },
): ProseVerificationResult {
    const nodeId = options?.nodeId ?? node.name;
    const parsed = parseProseNode(node, nodeId);
    const mergedContract: ProseContractSpec = {
        ...parsed.contractSpec,
        ...(options?.contractOverride ?? {}),
    };
    const textToVerify = options?.candidateText !== undefined ? options.candidateText : parsed.bodyText;
    const result = verifyProseText(textToVerify, mergedContract, { nodeId });
    const allDiagnostics = [...parsed.diagnostics, ...result.diagnostics];
    return {
        ...result,
        valid: allDiagnostics.every(d => d.severity !== 'error'),
        diagnostics: allDiagnostics,
    };
}

/**
 * Verify a prose `SlateFlow` and its assembled text (or constituent nodes) against flow-level and node-level contracts.
 */
export function verifyProseFlow(
    flow: SlateFlow,
    nodes: ReadonlyMap<string, SlateNode>,
    options?: {
        flowId?: string;
        assembledText?: string;
        contractOverride?: Partial<ProseContractSpec>;
        verifyConstituentNodes?: boolean;
    },
): ProseVerificationResult {
    const flowId = options?.flowId ?? flow.name;
    const flowContract = parseProseContract(
        typeof flow.extra?.contract === 'string' ? flow.extra.contract : '',
        flow.extra,
    );
    const mergedContract: ProseContractSpec = {
        ...flowContract,
        ...(options?.contractOverride ?? {}),
    };

    const diagnostics: ProseDiagnostic[] = [];

    // Validate wires and instances in the flow
    const instanceIds = new Set(flow.instances.map(i => i.id));
    for (const region of flow.regions ?? []) {
        instanceIds.add(region.id);
    }

    for (const inst of flow.instances) {
        if (inst.kind === 'value' || inst.kind === 'viewer') continue;
        if (inst.node && !nodes.has(inst.node)) {
            diagnostics.push({
                code: 'prose-wire-error',
                severity: 'error',
                message: `Flow "${flowId}" instance "${inst.id}" references unknown prose node "${inst.node}".`,
                flowId,
                nodeId: inst.node,
            });
        }
    }

    for (const wire of flow.wires) {
        const from = parseEndpoint(wire.from);
        const to = parseEndpoint(wire.to);
        if (from.instance !== null && !instanceIds.has(from.instance)) {
            diagnostics.push({
                code: 'prose-wire-error',
                severity: 'error',
                message: `Flow "${flowId}" wire "${wire.from} -> ${wire.to}" references unknown source instance "${from.instance}".`,
                flowId,
            });
        }
        if (to.instance !== null && !instanceIds.has(to.instance)) {
            diagnostics.push({
                code: 'prose-wire-error',
                severity: 'error',
                message: `Flow "${flowId}" wire "${wire.from} -> ${wire.to}" references unknown target instance "${to.instance}".`,
                flowId,
            });
        }
    }

    if (options?.verifyConstituentNodes) {
        for (const inst of flow.instances) {
            if (!inst.node) continue;
            const node = nodes.get(inst.node);
            if (!node) continue;
            const parsedNode = parseProseNode(node, inst.node);
            // Only verify constituent leaf nodes that don't have unresolved template placeholders,
            // or always include their syntax/port diagnostics.
            diagnostics.push(...parsedNode.diagnostics);
            const hasUnresolvedPlaceholders = /\{\{?\s*[A-Za-z_][A-Za-z0-9_]*\s*\}?\}/.test(parsedNode.bodyText);
            if (!hasUnresolvedPlaceholders && parsedNode.bodyText.length > 0) {
                const nodeRes = verifyProseNode(node, { nodeId: inst.node });
                diagnostics.push(...nodeRes.diagnostics);
            }
        }
    }

    const textToVerify = options?.assembledText ?? '';
    const textResult = verifyProseText(textToVerify, mergedContract, { flowId });
    const combinedDiagnostics = [...diagnostics, ...textResult.diagnostics];

    return {
        ...textResult,
        valid: combinedDiagnostics.every(d => d.severity !== 'error'),
        diagnostics: combinedDiagnostics,
    };
}
