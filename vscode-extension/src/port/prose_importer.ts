import {
    parseCitationNode,
    PROSE_GENERATED_MD_HEADER,
    PROSE_GENERATED_TEX_HEADER,
    proseDocumentSlug,
    type ProseCitationEntry,
} from '../compile/prose';
import { emptyFlow, MAIN_FLOW, uniqueName } from '../flow';
import type { FlowInstance, FlowPort, FlowWire, SlateFlow } from '../harness_protocol';
import {
    countProseWords,
    extractCitations,
    normalizeCitationKey,
    parseProseContract,
    type ProseContractSpec,
} from '../prose_adapter';
import { codeLines, FORMAT_VERSION } from '../language_types';
import type { SlateConfig, SlateNode } from '../slate_folder';
import type { PortReport } from './python_importer';

// Phase 8.5 (S-850): Markdown & LaTeX Prose Importer (`language: "prose"`).
// Mechanically decomposes existing `.md` (Markdown) and `.tex` (LaTeX) documents
// (plus optional `.bib` BibTeX or `.json` citation maps) into a Slate Prose project:
// - `config`: `SlateConfig` with `language: "prose"`
// - `nodes`: atomic `SlateNode` definitions under `nodes/` for each heading section/passage
//   and each extracted citation node (`citation <name>() -> citation:`)
// - `flows`: a wired `flows/main.json` connecting citation nodes into section/passage nodes
//   and wiring sections in document order so `compileProse` round-trips back to `.md` and `.tex`.

export interface PortProseOptions {
    /** Explicit project/document name override. Inferred from frontmatter/title/filename when omitted. */
    projectName?: string;
    /** Compile output directory for `config.compile.outDir` (defaults to `"build/prose"`). */
    outDir?: string;
    /** Additional citation entries to merge with any `.bib`, `.json`, or inline bibliography entries. */
    citations?: ReadonlyMap<string, ProseCitationEntry> | ProseCitationEntry[];
}

export interface PortProseResult {
    config: SlateConfig;
    nodes: Map<string, SlateNode>;
    flows: Map<string, SlateFlow>;
    mainFlow: SlateFlow;
    citations: Map<string, ProseCitationEntry>;
    report: PortReport;
}

interface ParsedSectionChunk {
    heading: string | null;
    level: number;
    bodyLines: string[];
    sectionContract: ProseContractSpec;
}

interface ParsedDocument {
    path: string;
    title: string | null;
    docContract: ProseContractSpec;
    sections: ParsedSectionChunk[];
    extractedCitations: Map<string, ProseCitationEntry>;
}

function normalizeFilesInput(
    files: Record<string, string> | ReadonlyMap<string, string>,
): Array<[string, string]> {
    if (files instanceof Map) {
        return [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
    }
    const entries = Object.entries(files as Record<string, string>);
    return entries.sort(([a], [b]) => a.localeCompare(b));
}

function safeIdentifier(raw: string, fallback: string): string {
    const cleaned = raw
        .trim()
        .toLowerCase()
        .replace(/^[0-9.\-\s]+/, '')
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!cleaned) return fallback;
    return /^[a-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

function safeCitationNodeName(key: string): string {
    const clean = normalizeCitationKey(key)
        .replace(/[^A-Za-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return `cite_${clean || 'ref'}`;
}

function mergeContracts(base: ProseContractSpec, override: ProseContractSpec): ProseContractSpec {
    const merged: ProseContractSpec = { ...base };
    if (override.minWords !== undefined) merged.minWords = override.minWords;
    if (override.maxWords !== undefined) merged.maxWords = override.maxWords;
    if (override.minChars !== undefined) merged.minChars = override.minChars;
    if (override.maxChars !== undefined) merged.maxChars = override.maxChars;

    if (override.requiredCitations && override.requiredCitations.length > 0) {
        const set = new Set([...(merged.requiredCitations ?? []), ...override.requiredCitations]);
        merged.requiredCitations = [...set];
    }
    if (override.forbiddenTerms && override.forbiddenTerms.length > 0) {
        const set = new Set([...(merged.forbiddenTerms ?? []), ...override.forbiddenTerms]);
        merged.forbiddenTerms = [...set];
    }
    if (override.requiredSections && override.requiredSections.length > 0) {
        const set = new Set([...(merged.requiredSections ?? []), ...override.requiredSections]);
        merged.requiredSections = [...set];
    }
    if (override.rubricCriteria && override.rubricCriteria.length > 0) {
        const set = new Set([...(merged.rubricCriteria ?? []), ...override.rubricCriteria]);
        merged.rubricCriteria = [...set];
    }
    return merged;
}

export function formatProseContract(spec: ProseContractSpec): string {
    const parts: string[] = [];
    if (spec.minWords !== undefined) parts.push(`minWords: ${spec.minWords}`);
    if (spec.maxWords !== undefined) parts.push(`maxWords: ${spec.maxWords}`);
    if (spec.minChars !== undefined) parts.push(`minChars: ${spec.minChars}`);
    if (spec.maxChars !== undefined) parts.push(`maxChars: ${spec.maxChars}`);
    if (spec.requiredCitations && spec.requiredCitations.length > 0) {
        const formatted = spec.requiredCitations.map(k => `@${normalizeCitationKey(k)}`).join(', ');
        parts.push(`requiredCitations: [${formatted}]`);
    }
    if (spec.forbiddenTerms && spec.forbiddenTerms.length > 0) {
        parts.push(`forbiddenTerms: [${spec.forbiddenTerms.join(', ')}]`);
    }
    if (spec.requiredSections && spec.requiredSections.length > 0) {
        parts.push(`requiredSections: [${spec.requiredSections.join(', ')}]`);
    }
    if (spec.rubricCriteria && spec.rubricCriteria.length > 0) {
        parts.push(`rubric: [${spec.rubricCriteria.join(', ')}]`);
    }
    return parts.join(', ');
}

function hasAnyContractField(spec: ProseContractSpec): boolean {
    return (
        spec.minWords !== undefined ||
        spec.maxWords !== undefined ||
        spec.minChars !== undefined ||
        spec.maxChars !== undefined ||
        (spec.requiredCitations !== undefined && spec.requiredCitations.length > 0) ||
        (spec.forbiddenTerms !== undefined && spec.forbiddenTerms.length > 0) ||
        (spec.requiredSections !== undefined && spec.requiredSections.length > 0) ||
        (spec.rubricCriteria !== undefined && spec.rubricCriteria.length > 0)
    );
}

/**
 * Parse BibTeX `.bib` content into `ProseCitationEntry` records.
 */
export function parseBibtexEntries(bibSource: string): Map<string, ProseCitationEntry> {
    const entries = new Map<string, ProseCitationEntry>();
    const entryRegex = /@([A-Za-z]+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n\s*@[A-Za-z]+\s*\{|$)/g;

    for (const match of bibSource.matchAll(entryRegex)) {
        const rawKey = match[2].trim();
        const body = match[3];
        const key = normalizeCitationKey(rawKey);
        if (!key) continue;

        const fields = new Map<string, string>();
        const fieldRegex = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)"|([^\s,}]+))/g;
        for (const fm of body.matchAll(fieldRegex)) {
            const fieldName = fm[1].toLowerCase();
            const rawVal = (fm[2] ?? fm[3] ?? fm[4] ?? '').trim();
            const cleanedVal = rawVal.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
            if (cleanedVal) {
                fields.set(fieldName, cleanedVal);
            }
        }

        const author = fields.get('author') ?? 'Unknown Author';
        const year = fields.get('year') ?? 'n.d.';
        const title = fields.get('title') ?? key;
        const venue = fields.get('journal') ?? fields.get('booktitle') ?? fields.get('venue') ?? fields.get('publisher');
        const doi = fields.get('doi');
        const url = fields.get('url');

        entries.set(key, {
            key,
            author,
            year,
            title,
            ...(venue ? { venue } : {}),
            ...(doi ? { doi } : {}),
            ...(url ? { url } : {}),
        });
    }

    return entries;
}

/**
 * Parse JSON citation map or array into `ProseCitationEntry` records.
 */
function parseJsonCitations(jsonSource: string): Map<string, ProseCitationEntry> {
    const entries = new Map<string, ProseCitationEntry>();
    try {
        const parsed = JSON.parse(jsonSource) as unknown;
        if (Array.isArray(parsed)) {
            for (const item of parsed) {
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    const rec = item as Record<string, unknown>;
                    if (typeof rec.key === 'string' && rec.key.trim()) {
                        const key = normalizeCitationKey(rec.key);
                        entries.set(key, {
                            key,
                            author: typeof rec.author === 'string' ? rec.author : 'Unknown Author',
                            year: typeof rec.year === 'string' || typeof rec.year === 'number' ? String(rec.year) : 'n.d.',
                            title: typeof rec.title === 'string' ? rec.title : key,
                            ...(typeof rec.venue === 'string' ? { venue: rec.venue } : {}),
                            ...(typeof rec.doi === 'string' ? { doi: rec.doi } : {}),
                            ...(typeof rec.url === 'string' ? { url: rec.url } : {}),
                        });
                    }
                }
            }
        } else if (parsed && typeof parsed === 'object') {
            const obj = parsed as Record<string, unknown>;
            // Skip Slate config/flow/node JSON files
            if ('slate' in obj) return entries;
            for (const [rawKey, val] of Object.entries(obj)) {
                if (val && typeof val === 'object' && !Array.isArray(val)) {
                    const rec = val as Record<string, unknown>;
                    const key = normalizeCitationKey(typeof rec.key === 'string' ? rec.key : rawKey);
                    if (!key) continue;
                    entries.set(key, {
                        key,
                        author: typeof rec.author === 'string' ? rec.author : 'Unknown Author',
                        year: typeof rec.year === 'string' || typeof rec.year === 'number' ? String(rec.year) : 'n.d.',
                        title: typeof rec.title === 'string' ? rec.title : key,
                        ...(typeof rec.venue === 'string' ? { venue: rec.venue } : {}),
                        ...(typeof rec.doi === 'string' ? { doi: rec.doi } : {}),
                        ...(typeof rec.url === 'string' ? { url: rec.url } : {}),
                    });
                }
            }
        }
    } catch {
        // Ignore non-citation or invalid JSON files
    }
    return entries;
}

/**
 * Parse YAML frontmatter block (`--- ... ---`) at the start of a Markdown document.
 */
function parseYamlFrontmatter(source: string): {
    title: string | null;
    contract: ProseContractSpec;
    citations: Map<string, ProseCitationEntry>;
    remainingContent: string;
} {
    const citations = new Map<string, ProseCitationEntry>();
    const normalized = source.replace(/\r\n?/g, '\n');

    // Strip optional generated header before frontmatter
    let working = normalized;
    if (working.startsWith(`${PROSE_GENERATED_MD_HEADER}\n`)) {
        working = working.slice(`${PROSE_GENERATED_MD_HEADER}\n`.length).replace(/^\n+/, '');
    }

    const fmMatch = working.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!fmMatch) {
        return {
            title: null,
            contract: {},
            citations,
            remainingContent: working,
        };
    }

    const fmText = fmMatch[1];
    const remainingContent = fmMatch[2];
    let title: string | null = null;
    const rawRecord: Record<string, unknown> = {};

    const lines = fmText.split('\n');
    let currentListKey: string | null = null;
    let currentListItems: string[] = [];

    const flushList = () => {
        if (currentListKey) {
            rawRecord[currentListKey] = [...currentListItems];
            currentListKey = null;
            currentListItems = [];
        }
    };

    for (const line of lines) {
        const listItemMatch = line.match(/^\s*-\s+(.+?)\s*$/);
        if (listItemMatch && currentListKey) {
            currentListItems.push(listItemMatch[1].replace(/^["']|["']$/g, '').trim());
            continue;
        }
        flushList();

        const kvMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/);
        if (!kvMatch) continue;
        const rawKey = kvMatch[1];
        const rawVal = kvMatch[2];

        const camelKey = rawKey.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        if ((camelKey === 'title' || camelKey === 'name') && rawVal) {
            title = rawVal.replace(/^["']|["']$/g, '').trim();
            continue;
        }

        if (!rawVal) {
            currentListKey = camelKey === 'rubric' ? 'rubricCriteria' : camelKey;
            currentListItems = [];
            continue;
        }

        if (/^\d+$/.test(rawVal)) {
            rawRecord[camelKey] = Number.parseInt(rawVal, 10);
            continue;
        }

        if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
            const items = rawVal
                .slice(1, -1)
                .split(/[,;]/)
                .map(s => s.trim().replace(/^["']|["']$/g, ''))
                .filter(Boolean);
            const normKey =
                camelKey === 'rubric'
                    ? 'rubricCriteria'
                    : camelKey === 'citations' || camelKey === 'cite'
                        ? 'requiredCitations'
                        : camelKey === 'forbid' || camelKey === 'forbidden'
                            ? 'forbiddenTerms'
                            : camelKey === 'sections'
                                ? 'requiredSections'
                                : camelKey;
            rawRecord[normKey] = items;
            continue;
        }

        rawRecord[camelKey] = rawVal.replace(/^["']|["']$/g, '');
    }
    flushList();

    const contract = parseProseContract(fmText, rawRecord);
    return {
        title,
        contract,
        citations,
        remainingContent,
    };
}

/**
 * Parse a Markdown `## References` or `## Bibliography` section body into `ProseCitationEntry` records.
 */
function parseMarkdownBibliographyLines(lines: string[]): Map<string, ProseCitationEntry> {
    const entries = new Map<string, ProseCitationEntry>();
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Pattern 1: `- **[key]** Author (Year). "Title." *Venue*. DOI: 10.1234. https://...`
        const boldKeyMatch = trimmed.match(
            /^(?:[-*]\s+)?\*\*\[([A-Za-z0-9_:-]+)\]\*\*\s+(.+?)\s*\(([^)]+)\)\.\s*(?:"([^"]+)"|([^.*]+?\.)?)\s*(.*)$/,
        );
        if (boldKeyMatch) {
            const key = normalizeCitationKey(boldKeyMatch[1]);
            const author = boldKeyMatch[2].trim();
            const year = boldKeyMatch[3].trim();
            const rawTitle = (boldKeyMatch[4] ?? boldKeyMatch[5] ?? key).replace(/\.$/, '').trim();
            const rest = boldKeyMatch[6] ?? '';
            if (author === 'Unresolved citation key') continue;

            const venueMatch = rest.match(/\*([^*]+)\*/);
            const doiMatch = rest.match(/DOI:\s*([^\s.]+(?:\.[^\s.]+)*?)(?:\.\s|\.$|$)/i);
            const urlMatch = rest.match(/(https?:\/\/\S+)/i);

            entries.set(key, {
                key,
                author,
                year,
                title: rawTitle,
                ...(venueMatch ? { venue: venueMatch[1].trim() } : {}),
                ...(doiMatch ? { doi: doiMatch[1].replace(/\.$/, '').trim() } : {}),
                ...(urlMatch ? { url: urlMatch[1].trim() } : {}),
            });
            continue;
        }

        // Pattern 2: `- [@key] Author (Year). "Title." *Venue*.` or `[key]: Author (Year). Title.`
        const bracketMatch = trimmed.match(
            /^(?:[-*]\s+)?\[@?([A-Za-z0-9_:-]+)\]:?\s+(.+?)\s*\(([^)]+)\)\.\s*(?:"([^"]+)"|([^.]+))\.(.*)$/,
        );
        if (bracketMatch) {
            const key = normalizeCitationKey(bracketMatch[1]);
            const author = bracketMatch[2].trim();
            const year = bracketMatch[3].trim();
            const title = (bracketMatch[4] ?? bracketMatch[5] ?? key).replace(/\.$/, '').trim();
            const rest = bracketMatch[6] ?? '';
            const venueMatch = rest.match(/\*([^*]+)\*/);
            const doiMatch = rest.match(/DOI:\s*([^\s.]+(?:\.[^\s.]+)*?)(?:\.\s|\.$|$)/i);
            const urlMatch = rest.match(/(https?:\/\/\S+)/i);

            entries.set(key, {
                key,
                author,
                year,
                title,
                ...(venueMatch ? { venue: venueMatch[1].trim() } : {}),
                ...(doiMatch ? { doi: doiMatch[1].replace(/\.$/, '').trim() } : {}),
                ...(urlMatch ? { url: urlMatch[1].trim() } : {}),
            });
        }
    }
    return entries;
}

/**
 * Parse LaTeX `\begin{thebibliography} ... \end{thebibliography}` items into `ProseCitationEntry` records.
 */
function parseLatexBibliography(texSource: string): Map<string, ProseCitationEntry> {
    const entries = new Map<string, ProseCitationEntry>();
    const bibBlockMatch = texSource.match(/\\begin\{thebibliography\}\{[^}]*\}([\s\S]*?)\\end\{thebibliography\}/);
    if (!bibBlockMatch) return entries;

    const block = bibBlockMatch[1];
    const itemRegex = /\\bibitem\{([^}]+)\}\s*([^\n]+)/g;
    for (const match of block.matchAll(itemRegex)) {
        const key = normalizeCitationKey(match[1]);
        const rest = match[2].trim();
        if (rest.startsWith('Unresolved citation')) continue;

        const m = rest.match(/^(.+?)\s*\(([^)]+)\)\.\s*(.+?)\.(?:\s*\\textit\{([^}]+)\}\.)?(?:\s*DOI:\s*([^\s]+?)\.?)?\s*$/);
        if (m) {
            entries.set(key, {
                key,
                author: m[1].trim(),
                year: m[2].trim(),
                title: m[3].trim(),
                ...(m[4] ? { venue: m[4].trim() } : {}),
                ...(m[5] ? { doi: m[5].replace(/\.$/, '').trim() } : {}),
            });
        } else {
            entries.set(key, {
                key,
                author: 'Unknown Author',
                year: 'n.d.',
                title: rest.replace(/\.$/, '').trim() || key,
            });
        }
    }
    return entries;
}

/**
 * Extract HTML comment directives (`<!-- maxWords: 250 -->`) from lines, returning the
 * merged `ProseContractSpec` and the cleaned lines with directive comments removed.
 */
function extractCommentDirectives(lines: string[]): {
    contract: ProseContractSpec;
    cleanedLines: string[];
} {
    let contract: ProseContractSpec = {};
    const cleanedLines: string[] = [];

    for (const line of lines) {
        const commentMatches = [...line.matchAll(/<!--([\s\S]*?)-->/g)];
        if (commentMatches.length === 0) {
            cleanedLines.push(line);
            continue;
        }

        let lineRemaining = line;
        for (const cm of commentMatches) {
            const inner = cm[1].trim();
            if (inner === 'Generated by Slate Prose Mode') {
                lineRemaining = lineRemaining.replace(cm[0], '');
                continue;
            }
            const strippedPrefix = inner.replace(/^contract\s*:\s*/i, '');
            const parsed = parseProseContract(strippedPrefix);
            if (hasAnyContractField(parsed)) {
                contract = mergeContracts(contract, parsed);
                lineRemaining = lineRemaining.replace(cm[0], '');
            }
        }

        if (lineRemaining.trim().length > 0 || line.trim().length === 0) {
            if (lineRemaining.trim().length > 0) {
                cleanedLines.push(lineRemaining.trimEnd());
            }
        }
    }

    // Trim leading and trailing blank lines
    while (cleanedLines.length > 0 && cleanedLines[0].trim() === '') cleanedLines.shift();
    while (cleanedLines.length > 0 && cleanedLines[cleanedLines.length - 1].trim() === '') cleanedLines.pop();

    return { contract, cleanedLines };
}

/**
 * Restore rendered Markdown inline citations `(Author, Year)` or `(Author1, Year1; Author2, Year2)`
 * back to `[@key]` when they match known bibliography entries (enabling full `.md` round-trip).
 */
function restoreRenderedInlineCitations(
    text: string,
    knownCitations: ReadonlyMap<string, ProseCitationEntry>,
): string {
    if (knownCitations.size === 0) return text;
    const byAuthorYear = new Map<string, string>();
    for (const [key, entry] of knownCitations.entries()) {
        const sig = `${entry.author.trim().toLowerCase()}, ${entry.year.trim().toLowerCase()}`;
        byAuthorYear.set(sig, key);
    }

    return text.replace(/\(([^()]+)\)/g, (full, inner: string) => {
        const parts = inner.split(';').map(p => p.trim()).filter(Boolean);
        if (parts.length === 0) return full;
        const matchedKeys: string[] = [];
        for (const part of parts) {
            const key = byAuthorYear.get(part.toLowerCase());
            if (!key) return full;
            matchedKeys.push(key);
        }
        return matchedKeys.map(k => `[@${k}]`).join(' ');
    });
}

function updateFenceState(
    line: string,
    activeFence: { char: '`' | '~'; len: number } | null,
): { nextFence: { char: '`' | '~'; len: number } | null; insideFence: boolean } {
    const trimmed = line.trim();
    if (!activeFence) {
        const openMatch = trimmed.match(/^(`{3,}|~{3,})/);
        if (openMatch) {
            const ch = openMatch[1][0] as '`' | '~';
            // Note: CommonMark info strings on backtick fences cannot contain backticks
            const rest = trimmed.slice(openMatch[1].length);
            if (!(ch === '`' && rest.includes('`'))) {
                return { nextFence: { char: ch, len: openMatch[1].length }, insideFence: true };
            }
        }
        return { nextFence: null, insideFence: false };
    }
    const closeMatch = trimmed.match(/^(`{3,}|~{3,})\s*$/);
    if (closeMatch && closeMatch[1][0] === activeFence.char && closeMatch[1].length >= activeFence.len) {
        return { nextFence: null, insideFence: true };
    }
    return { nextFence: activeFence, insideFence: true };
}

function parseMarkdownDocument(path: string, source: string): ParsedDocument {
    const { title: fmTitle, contract: fmContract, remainingContent } = parseYamlFrontmatter(source);
    const rawLines = remainingContent.split(/\r?\n/);

    let inferredTitle: string | null = fmTitle;
    let docDirectiveContract: ProseContractSpec = { ...fmContract };

    // First pass: check if there is a top-level `# Title` and `## Section` headings (ignoring fenced code blocks)
    const headingLines: Array<{ idx: number; level: number; text: string }> = [];
    let scanFence: { char: '`' | '~'; len: number } | null = null;
    for (let idx = 0; idx < rawLines.length; idx++) {
        const line = rawLines[idx];
        const fenceUpdate = updateFenceState(line, scanFence);
        scanFence = fenceUpdate.nextFence;
        if (fenceUpdate.insideFence) continue;
        const m = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
        if (m) {
            headingLines.push({ idx, level: m[1].length, text: m[2].trim() });
        }
    }

    const h1Count = headingLines.filter(h => h.level === 1).length;
    const h2PlusCount = headingLines.filter(h => h.level >= 2).length;

    let startLineIdx = 0;
    const preHeadingLines: string[] = [];

    if (headingLines.length > 0 && headingLines[0].level === 1 && (h1Count === 1 && h2PlusCount > 0)) {
        // Single H1 followed by H2+ sections: treat H1 as document title
        const firstH1 = headingLines[0];
        if (!inferredTitle) {
            inferredTitle = firstH1.text;
        }
        const beforeH1 = rawLines.slice(0, firstH1.idx);
        const { contract: preH1Contract } = extractCommentDirectives(beforeH1);
        docDirectiveContract = mergeContracts(docDirectiveContract, preH1Contract);
        startLineIdx = firstH1.idx + 1;
    }

    // Collect chunks separated by section headings (`##` when H1 is title, or `#`/`##` otherwise)
    const splitOnLevel = (h1Count === 1 && h2PlusCount > 0) ? 2 : 1;
    interface RawChunk {
        heading: string | null;
        level: number;
        lines: string[];
    }
    const rawChunks: RawChunk[] = [];
    let currentChunk: RawChunk | null = null;
    let chunkFence: { char: '`' | '~'; len: number } | null = null;

    for (let i = startLineIdx; i < rawLines.length; i++) {
        const line = rawLines[i];
        const fenceUpdate = updateFenceState(line, chunkFence);
        chunkFence = fenceUpdate.nextFence;
        const hm = !fenceUpdate.insideFence ? line.match(/^\s*(#{1,6})\s+(.+?)\s*$/) : null;
        if (hm) {
            const level = hm[1].length;
            const headingText = hm[2].trim();
            if (level <= splitOnLevel || (splitOnLevel === 2 && level === 2) || (currentChunk === null)) {
                if (currentChunk) {
                    rawChunks.push(currentChunk);
                } else if (preHeadingLines.length > 0) {
                    rawChunks.push({ heading: null, level: 0, lines: [...preHeadingLines] });
                    preHeadingLines.length = 0;
                }
                currentChunk = { heading: headingText, level, lines: [] };
                continue;
            }
        }
        if (currentChunk) {
            currentChunk.lines.push(line);
        } else {
            preHeadingLines.push(line);
        }
    }
    if (currentChunk) {
        rawChunks.push(currentChunk);
    } else if (preHeadingLines.length > 0) {
        rawChunks.push({ heading: null, level: 0, lines: [...preHeadingLines] });
        preHeadingLines.length = 0;
    }

    const extractedCitations = new Map<string, ProseCitationEntry>();
    const sections: ParsedSectionChunk[] = [];

    for (const chunk of rawChunks) {
        const isBibHeading =
            chunk.heading !== null &&
            /^(?:references|bibliography|works\s+cited)$/i.test(chunk.heading.trim());

        if (isBibHeading) {
            const bibEntries = parseMarkdownBibliographyLines(chunk.lines);
            for (const [k, v] of bibEntries) {
                extractedCitations.set(k, v);
            }
            // Skip emitting a separate section node for the References block since `compileProse` generates `## References`
            continue;
        }

        const { contract: secContract, cleanedLines } = extractCommentDirectives(chunk.lines);
        if (chunk.heading === null && cleanedLines.length === 0) {
            docDirectiveContract = mergeContracts(docDirectiveContract, secContract);
            continue;
        }

        sections.push({
            heading: chunk.heading,
            level: chunk.level || 2,
            bodyLines: cleanedLines,
            sectionContract: secContract,
        });
    }

    return {
        path,
        title: inferredTitle,
        docContract: docDirectiveContract,
        sections,
        extractedCitations,
    };
}

function parseLatexDocument(path: string, source: string): ParsedDocument {
    const normalized = source.replace(/\r\n?/g, '\n');
    const extractedCitations = parseLatexBibliography(normalized);

    let title: string | null = null;
    const titleMatch = normalized.match(/\\title\{([^}]+)\}/);
    if (titleMatch) {
        title = titleMatch[1].trim();
    }

    let docContract: ProseContractSpec = {};
    for (const line of normalized.split('\n')) {
        const commentMatch = line.match(/^\s*%\s*(.+)$/);
        if (commentMatch) {
            const commentText = commentMatch[1].trim();
            if (commentText === 'Generated by Slate Prose Mode') continue;
            const parsed = parseProseContract(commentText.replace(/^contract\s*:\s*/i, ''));
            if (hasAnyContractField(parsed)) {
                docContract = mergeContracts(docContract, parsed);
            }
        }
    }

    // Extract inner document body if \begin{document} ... \end{document} is present
    let body = normalized;
    const docMatch = normalized.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/);
    if (docMatch) {
        body = docMatch[1];
    }

    // Strip \maketitle and \begin{thebibliography}...\end{thebibliography}
    body = body
        .replace(/\\maketitle\b/g, '')
        .replace(/\\begin\{thebibliography\}\{[^}]*\}[\s\S]*?\\end\{thebibliography\}/g, '')
        .trim();

    const convertLatexLineToProse = (line: string): string => {
        return line
            .replace(/\\textbf\{([^}]+)\}/g, '**$1**')
            .replace(/\\textit\{([^}]+)\}/g, '*$1*')
            .replace(/\\emph\{([^}]+)\}/g, '*$1*');
    };

    const rawLines = body.split('\n');
    const sections: ParsedSectionChunk[] = [];
    let currentHeading: string | null = null;
    let currentLevel = 2;
    let currentLines: string[] = [];
    let currentContract: ProseContractSpec = {};

    const flushSection = () => {
        while (currentLines.length > 0 && currentLines[0].trim() === '') currentLines.shift();
        while (currentLines.length > 0 && currentLines[currentLines.length - 1].trim() === '') currentLines.pop();
        if (currentHeading !== null || currentLines.length > 0) {
            sections.push({
                heading: currentHeading,
                level: currentLevel,
                bodyLines: currentLines,
                sectionContract: currentContract,
            });
        }
        currentHeading = null;
        currentLevel = 2;
        currentLines = [];
        currentContract = {};
    };

    for (const rawLine of rawLines) {
        const commentMatch = rawLine.match(/^\s*%\s*(.+)$/);
        if (commentMatch) {
            const parsed = parseProseContract(commentMatch[1].trim().replace(/^contract\s*:\s*/i, ''));
            if (hasAnyContractField(parsed)) {
                currentContract = mergeContracts(currentContract, parsed);
            }
            continue;
        }

        const secMatch = rawLine.match(/^\s*\\(sub)*section\*?\{([^}]+)\}\s*$/);
        if (secMatch) {
            flushSection();
            const subPrefix = secMatch[1] ?? '';
            currentLevel = subPrefix === '' ? 2 : 3;
            currentHeading = secMatch[2].trim();
            continue;
        }

        currentLines.push(convertLatexLineToProse(rawLine));
    }
    flushSection();

    return {
        path,
        title,
        docContract,
        sections,
        extractedCitations,
    };
}

/**
 * Replace inline citations (`[@key]` and `\cite{key}`) with `{cite_<safeKey>}` placeholders
 * and return the ordered list of referenced citation keys.
 */
function collectSectionCitationKeys(text: string): string[] {
    const orderedKeys: string[] = [];
    const seen = new Set<string>();
    const recordKey = (rawKey: string) => {
        const norm = normalizeCitationKey(rawKey);
        if (!seen.has(norm)) {
            seen.add(norm);
            orderedKeys.push(norm);
        }
    };
    for (const match of text.matchAll(/\[([^\[\]]*@[A-Za-z0-9_:-]+[^\[\]]*)\]/g)) {
        for (const m of match[1].matchAll(/@([A-Za-z0-9_:-]+)/g)) {
            recordKey(m[1]);
        }
    }
    for (const match of text.matchAll(/\\cite[a-zA-Z]*\{([^}]+)\}/g)) {
        for (const k of match[1].split(',').map(s => s.trim()).filter(Boolean)) {
            recordKey(k);
        }
    }
    return orderedKeys;
}

function parameterizeSectionCitations(
    text: string,
    resolveParamName: (normKey: string) => string = safeCitationNodeName,
): {
    templateText: string;
    citationKeys: string[];
} {
    const orderedKeys: string[] = [];
    const seen = new Set<string>();
    const recordKey = (rawKey: string): string => {
        const norm = normalizeCitationKey(rawKey);
        if (!seen.has(norm)) {
            seen.add(norm);
            orderedKeys.push(norm);
        }
        return norm;
    };

    // Replace Pandoc/Markdown bracket citations `[@key1; @key2]` or `[@key]`
    let templateText = text.replace(/\[([^\[\]]*@[A-Za-z0-9_:-]+[^\[\]]*)\]/g, (full, inner: string) => {
        const matches = [...inner.matchAll(/@([A-Za-z0-9_:-]+)/g)];
        if (matches.length === 0) return full;
        const placeholders = matches.map(m => {
            const norm = recordKey(m[1]);
            return `{${resolveParamName(norm)}}`;
        });
        return placeholders.join(' ');
    });

    // Replace LaTeX `\cite{key1, key2}` citations
    templateText = templateText.replace(/\\cite[a-zA-Z]*\{([^}]+)\}/g, (full, inner: string) => {
        const keys = inner.split(',').map(k => k.trim()).filter(Boolean);
        if (keys.length === 0) return full;
        const placeholders = keys.map(k => {
            const norm = recordKey(k);
            return `{${resolveParamName(norm)}}`;
        });
        return placeholders.join(' ');
    });

    return { templateText, citationKeys: orderedKeys };
}

function inferFallbackCitationEntry(key: string): ProseCitationEntry {
    const norm = normalizeCitationKey(key);
    const m = norm.match(/^([A-Za-z]+)[_:-]?(\d{4}[a-z]?)$/);
    if (m) {
        const rawAuthor = m[1];
        const author = rawAuthor.charAt(0).toUpperCase() + rawAuthor.slice(1);
        const year = m[2];
        return {
            key: norm,
            author,
            year,
            title: `Reference ${norm}`,
        };
    }
    return {
        key: norm,
        author: 'Unknown Author',
        year: '2024',
        title: `Reference ${norm}`,
    };
}

function buildCitationSlateNode(nodeName: string, entry: ProseCitationEntry, order: number): SlateNode {
    const lines: string[] = [
        `citation ${nodeName}() -> citation:`,
        `    key: ${entry.key}`,
        `    author: ${entry.author}`,
        `    year: ${entry.year}`,
        `    title: ${entry.title}`,
    ];
    if (entry.venue) lines.push(`    venue: ${entry.venue}`);
    if (entry.doi) lines.push(`    doi: ${entry.doi}`);
    if (entry.url) lines.push(`    url: ${entry.url}`);

    const node: SlateNode = {
        name: nodeName,
        language: 'prose',
        intent: `${entry.author} (${entry.year}): ${entry.title}`,
        contract: '',
        context: [],
        examples: [],
        locked: false,
        order,
        imports: [],
        uses: [],
        code: lines,
        extra: {
            proseKind: 'citation',
            citation: { ...entry },
        },
    };
    // Ensure parseCitationNode round-trips cleanly
    parseCitationNode(node, entry.key);
    return node;
}

/**
 * Mechanically port existing `.md` (Markdown) or `.tex` (LaTeX) documents
 * (plus optional `.bib` or `.json` citation maps) into a Slate Prose project
 * (`config` with `language: "prose"`, atomic `SlateNode` definitions for each
 * section/passage and citation, and a wired `flows/main.json`).
 */
export function portProseProject(
    files: Record<string, string> | ReadonlyMap<string, string>,
    options?: PortProseOptions,
): PortProseResult {
    const entries = normalizeFilesInput(files);
    const warnings: string[] = [];
    const citations = new Map<string, ProseCitationEntry>();

    if (options?.citations) {
        if (Array.isArray(options.citations)) {
            for (const c of options.citations) {
                const norm = normalizeCitationKey(c.key);
                citations.set(norm, { ...c, key: norm });
            }
        } else {
            for (const [k, c] of options.citations.entries()) {
                const norm = normalizeCitationKey(k);
                citations.set(norm, { ...c, key: norm });
            }
        }
    }

    // 1. First pass: collect bibliography entries from `.bib` and `.json` files
    const docEntries: Array<[string, string]> = [];
    for (const [rawPath, content] of entries) {
        const path = rawPath.replace(/\\/g, '/');
        if (path.endsWith('.bib')) {
            for (const [k, v] of parseBibtexEntries(content)) {
                citations.set(k, v);
            }
        } else if (path.endsWith('.json')) {
            for (const [k, v] of parseJsonCitations(content)) {
                citations.set(k, v);
            }
        } else if (path.endsWith('.md') || path.endsWith('.markdown') || path.endsWith('.tex')) {
            docEntries.push([path, content]);
        }
    }

    // 2. Parse `.md` and `.tex` documents
    const parsedDocs: ParsedDocument[] = [];
    for (const [path, content] of docEntries) {
        if (!content.trim()) {
            warnings.push(`${path}: document is empty; not ported.`);
            continue;
        }
        const parsed = path.endsWith('.tex')
            ? parseLatexDocument(path, content)
            : parseMarkdownDocument(path, content);

        for (const [k, v] of parsed.extractedCitations) {
            if (!citations.has(k)) {
                citations.set(k, v);
            }
        }

        if (parsed.sections.length === 0) {
            warnings.push(`${path}: no prose sections or passages found.`);
            continue;
        }
        parsedDocs.push(parsed);
    }

    const firstDoc = parsedDocs[0];
    const inferredProjectName =
        options?.projectName ??
        firstDoc?.title ??
        (firstDoc
            ? firstDoc.path
                .split('/')
                .pop()!
                .replace(/\.(?:md|markdown|tex)$/i, '')
            : 'prose_project');

    const config: SlateConfig = {
        slate: FORMAT_VERSION,
        name: inferredProjectName,
        language: 'prose',
        compile: { outDir: options?.outDir ?? 'build/prose' },
    };

    const nodes = new Map<string, SlateNode>();
    const usedNodeNames = new Set<string>();
    const citationNodeNameByKey = new Map<string, string>();
    const orderedSectionNodeNames: Array<{ name: string; returnType: 'section' | 'passage' }> = [];
    const sectionCitationWiring: Array<{ sectionNodeName: string; citationKeys: string[] }> = [];

    let combinedDocContract: ProseContractSpec = {};
    const allDiscoveredSections: string[] = [];
    const allDiscoveredCitations = new Set<string>();
    let totalDocumentWords = 0;
    let nodeOrder = 0;

    // 3. Build section / passage nodes and discover all referenced citations
    for (const doc of parsedDocs) {
        combinedDocContract = mergeContracts(combinedDocContract, doc.docContract);
        const docStem = safeIdentifier(
            doc.path.split('/').pop()!.replace(/\.(?:md|markdown|tex)$/i, ''),
            'document',
        );

        for (let sIdx = 0; sIdx < doc.sections.length; sIdx++) {
            const sec = doc.sections[sIdx];
            const isSection = sec.heading !== null;
            const returnType: 'section' | 'passage' = isSection ? 'section' : 'passage';

            const baseName = isSection
                ? safeIdentifier(sec.heading!, `section_${sIdx + 1}`)
                : safeIdentifier(`${docStem}_passage_${sIdx + 1}`, `passage_${sIdx + 1}`);
            const nodeName = uniqueName(baseName, usedNodeNames);
            usedNodeNames.add(nodeName);

            const rawBodyText = sec.bodyLines.join('\n').trim();
            const restoredBodyText = restoreRenderedInlineCitations(rawBodyText, citations);
            const fullSectionRaw = isSection
                ? `${'#'.repeat(Math.max(2, sec.level))} ${sec.heading}\n${restoredBodyText}`.trim()
                : restoredBodyText;

            const sectionWordCount = countProseWords(fullSectionRaw);
            totalDocumentWords += sectionWordCount;

            const directCitations = extractCitations(fullSectionRaw).map(normalizeCitationKey);
            const preCollectedCites = collectSectionCitationKeys(fullSectionRaw);
            const allSectionCites = [...new Set([...directCitations, ...preCollectedCites])];

            for (const cKey of allSectionCites) {
                allDiscoveredCitations.add(cKey);
                if (!citations.has(cKey)) {
                    citations.set(cKey, inferFallbackCitationEntry(cKey));
                }
                if (!citationNodeNameByKey.has(cKey)) {
                    const cNodeName = uniqueName(safeCitationNodeName(cKey), usedNodeNames);
                    usedNodeNames.add(cNodeName);
                    citationNodeNameByKey.set(cKey, cNodeName);
                }
            }

            const { templateText } = parameterizeSectionCitations(
                fullSectionRaw,
                normKey => citationNodeNameByKey.get(normKey) ?? safeCitationNodeName(normKey),
            );

            if (isSection && sec.heading) {
                allDiscoveredSections.push(sec.heading);
            }

            // Build section-level contract: merge explicit section directives, extracted citations, and frontmatter maxWords budget
            let nodeContractSpec: ProseContractSpec = { ...sec.sectionContract };
            if ( nodeContractSpec.maxWords === undefined && doc.docContract.maxWords !== undefined && sectionWordCount <= doc.docContract.maxWords) {
                nodeContractSpec.maxWords = doc.docContract.maxWords;
            }
            if (nodeContractSpec.forbiddenTerms === undefined && doc.docContract.forbiddenTerms) {
                nodeContractSpec.forbiddenTerms = [...doc.docContract.forbiddenTerms];
            }
            if (allSectionCites.length > 0) {
                nodeContractSpec = mergeContracts(nodeContractSpec, {
                    requiredCitations: allSectionCites,
                });
            }
            if (isSection && sec.heading) {
                nodeContractSpec = mergeContracts(nodeContractSpec, {
                    requiredSections: [sec.heading],
                });
            }

            const paramDecls = allSectionCites.map(cKey => {
                const cNodeName = citationNodeNameByKey.get(cKey)!;
                return `${cNodeName}: citation = "[@${cKey}]"`;
            });
            const signatureLine = `${returnType} ${nodeName}(${paramDecls.join(', ')}) -> ${returnType}:`;
            const indentedBody = templateText
                .split('\n')
                .map(line => (line.length > 0 ? `    ${line}` : ''));

            const citationNodeUses = allSectionCites.map(cKey => citationNodeNameByKey.get(cKey)!);
            const contractStr = formatProseContract(nodeContractSpec);

            const sectionNode: SlateNode = {
                name: nodeName,
                language: 'prose',
                intent: isSection ? `Section: ${sec.heading}` : `Passage in ${doc.path}`,
                contract: contractStr,
                context: [],
                examples: [],
                locked: false,
                order: nodeOrder++,
                imports: [],
                uses: [...citationNodeUses],
                code: codeLines([signatureLine, ...indentedBody].join('\n')),
                extra: {
                    proseKind: returnType,
                    returnType,
                    ...(isSection && sec.heading ? { heading: sec.heading, headingLevel: sec.level } : {}),
                    ...(hasAnyContractField(nodeContractSpec) ? { proseContract: nodeContractSpec } : {}),
                },
            };

            nodes.set(nodeName, sectionNode);
            orderedSectionNodeNames.push({ name: nodeName, returnType });
            sectionCitationWiring.push({ sectionNodeName: nodeName, citationKeys: allSectionCites });
        }
    }

    // 4. Create atomic citation `SlateNode`s for all referenced or declared citations
    const citationKeysToEmit = new Set<string>([
        ...allDiscoveredCitations,
        ...citations.keys(),
    ]);
    for (const cKey of citationKeysToEmit) {
        const entry = citations.get(cKey) ?? inferFallbackCitationEntry(cKey);
        citations.set(cKey, entry);
        let cNodeName = citationNodeNameByKey.get(cKey);
        if (!cNodeName) {
            cNodeName = uniqueName(safeCitationNodeName(cKey), usedNodeNames);
            usedNodeNames.add(cNodeName);
            citationNodeNameByKey.set(cKey, cNodeName);
        }
        const citeNode = buildCitationSlateNode(cNodeName, entry, nodeOrder++);
        nodes.set(cNodeName, citeNode);
    }

    // 5. Wire `flows/main.json` connecting citations -> sections and sections -> outputs in document order
    const instances: FlowInstance[] = [];
    const wires: FlowWire[] = [];
    const outputs: FlowPort[] = [];

    for (const cKey of citationKeysToEmit) {
        const cNodeName = citationNodeNameByKey.get(cKey)!;
        instances.push({ id: cNodeName, node: cNodeName });
    }

    for (const secInfo of orderedSectionNodeNames) {
        instances.push({ id: secInfo.name, node: secInfo.name });
        outputs.push({ name: secInfo.name, annotation: secInfo.returnType });
    }

    for (const wiring of sectionCitationWiring) {
        for (const cKey of wiring.citationKeys) {
            const cNodeName = citationNodeNameByKey.get(cKey)!;
            wires.push({
                from: `${cNodeName}.out`,
                to: `${wiring.sectionNodeName}.in:${cNodeName}`,
            });
        }
        wires.push({
            from: `${wiring.sectionNodeName}.out`,
            to: `output:${wiring.sectionNodeName}`,
        });
    }

    const flowContractSpec: ProseContractSpec = { ...combinedDocContract };
    if (flowContractSpec.maxWords !== undefined && flowContractSpec.maxWords < totalDocumentWords) {
        // Frontmatter `maxWords` was a per-section budget rather than a whole-document budget
        delete flowContractSpec.maxWords;
    }
    if (allDiscoveredCitations.size > 0) {
        flowContractSpec.requiredCitations = [
            ...new Set([...(flowContractSpec.requiredCitations ?? []), ...allDiscoveredCitations]),
        ];
    }
    if (allDiscoveredSections.length > 0) {
        flowContractSpec.requiredSections = [
            ...new Set([...(flowContractSpec.requiredSections ?? []), ...allDiscoveredSections]),
        ];
    }

    const mainFlowContractStr = formatProseContract(flowContractSpec);
    const mainFlow: SlateFlow = {
        ...emptyFlow(MAIN_FLOW),
        outputs,
        instances,
        wires,
        extra: {
            title: config.name,
            ...(mainFlowContractStr ? { contract: mainFlowContractStr, proseContract: flowContractSpec } : {}),
            ...(flowContractSpec.maxWords !== undefined
                ? { maxWords: flowContractSpec.maxWords }
                : combinedDocContract.maxWords !== undefined
                    ? { sectionMaxWords: combinedDocContract.maxWords }
                    : {}),
        },
    };

    const flows = new Map<string, SlateFlow>([[MAIN_FLOW, mainFlow]]);
    const report: PortReport = {
        modules: parsedDocs.map(d => d.path),
        nodes: nodes.size,
        preludes: 0,
        epilogues: 0,
        warnings,
    };

    return {
        config,
        nodes,
        flows,
        mainFlow,
        citations,
        report,
    };
}

export const portMarkdownProject = portProseProject;
