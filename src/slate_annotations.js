/**
 * slate_annotations.js — single source of truth for the structured
 * comment block Slate writes above each compiled card section.
 *
 * Format (one card section):
 *
 *     ## @slate id=<uuid> kind=<header|body|class> title=<name> doc=<docName>
 *     ## prompt: <first prompt line>
 *     ## prompt: <second prompt line>
 *     <body source — Python>
 *
 * Why double-hash (`##`):
 *   - Stays out of the way of #50's `# @slate:header-additions`
 *     single-hash tag, which is a totally separate concern.
 *   - Python lints + most editors render double-hash as a comment
 *     normally; nothing special required to be valid Python.
 *   - Easy to grammar-highlight in the VS Code extension (#56).
 *
 * Round-trip guarantees (issue #53):
 *   - emitAnnotation(card, doc) → string ALWAYS produces a block
 *     parseAnnotations() can read back into the same field values.
 *   - parseAnnotations(source) returns sections in source order; cards
 *     without an annotation block (e.g. legacy compiled files) are
 *     reported as `{ id: null, ... }` so the caller can fall back to
 *     title matching for backward compat.
 *   - Comment lines, prompt lines, and body lines all round-trip
 *     verbatim modulo the `## prompt: ` prefix on prompt lines.
 *
 * Pure / synchronous / no DOM. Testable headless.
 */

export const ANNOTATION_TAG = '## @slate';
export const ANNOTATION_PROMPT_PREFIX = '## prompt: ';

/**
 * Build the annotation block (tag + optional prompt lines) for one card.
 * Returns a string with NO trailing newline so the caller controls
 * spacing between sections. Header / body / class kinds are handled
 * the same way — only the `kind=` value differs.
 *
 * @param {object} card — needs id, title, kind, prompt
 * @param {object} doc  — needs title (used as `doc=` for cross-doc refs)
 */
export function emitAnnotation(card, doc) {
    if (!card) return '';
    const id = card.id || '';
    const kind = card.kind || 'body';
    const title = card.title || '';
    const docName = (doc && doc.title) || '';
    const tag = `${ANNOTATION_TAG} id=${id} kind=${kind} title=${title} doc=${docName}`;
    const promptLines = (card.prompt || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => `${ANNOTATION_PROMPT_PREFIX}${line}`);
    if (promptLines.length === 1 && promptLines[0] === ANNOTATION_PROMPT_PREFIX) {
        // No prompt → omit the prompt block entirely.
        return tag;
    }
    return [tag, ...promptLines].join('\n');
}

/**
 * Parse annotation blocks out of a compiled Python source. Returns
 * sections in source order:
 *
 *   [{
 *     id, kind, title, doc,   // from the `## @slate ...` tag
 *     prompt,                 // joined `## prompt:` lines (no prefix)
 *     body,                   // raw text between this annotation and
 *                             // the next annotation (or EOF), trimmed
 *     startLine, endLine,     // 0-indexed inclusive range in `source`
 *   }, ...]
 *
 * Lines BEFORE the first annotation are returned as a leading
 * `prelude` section with `id: null, kind: 'prelude'` — that's where
 * the compiler writes the file header comment + hoisted imports +
 * cross-doc imports. Callers usually keep the prelude verbatim.
 *
 * Files with no annotations at all → returns `[]` with `prelude` only,
 * so the legacy code path (existing `extractBlocks` in card_ctl) can
 * still kick in.
 *
 * Robust to trailing whitespace, CRLF line endings, and missing
 * fields (`title=` empty etc.). Unknown extra `key=value` pairs in the
 * tag are tolerated and ignored — forward-compat with future fields.
 */
export function parseAnnotations(source) {
    const text = (source == null ? '' : String(source)).replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const sections = [];
    let prelude = null;
    let current = null;

    const flush = () => {
        if (current) {
            current.endLine = current._lastLine;
            current.body = trimSurroundingBlankLines(current._bodyLines.join('\n'));
            delete current._bodyLines;
            delete current._promptLines;
            delete current._lastLine;
            sections.push(current);
            current = null;
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith(ANNOTATION_TAG)) {
            // Close out the prior section / prelude.
            if (current) flush();
            else if (prelude !== null) {
                prelude.endLine = i - 1;
                prelude.body = trimSurroundingBlankLines(prelude._bodyLines.join('\n'));
                delete prelude._bodyLines;
                sections.unshift(prelude);
                prelude = null;
            }
            const tag = parseTagLine(line);
            current = {
                ...tag,
                prompt: '',
                body: '',
                startLine: i,
                endLine: i,
                _bodyLines: [],
                _promptLines: [],
                _lastLine: i,
            };
            continue;
        }
        if (current && line.startsWith(ANNOTATION_PROMPT_PREFIX)) {
            current._promptLines.push(line.slice(ANNOTATION_PROMPT_PREFIX.length));
            current.prompt = current._promptLines.join('\n');
            current._lastLine = i;
            continue;
        }
        if (current) {
            current._bodyLines.push(line);
            current._lastLine = i;
        } else {
            // Pre-first-annotation: bucket into the prelude.
            if (!prelude) prelude = { id: null, kind: 'prelude', title: '', doc: '', prompt: '', body: '', startLine: 0, endLine: i, _bodyLines: [] };
            prelude._bodyLines.push(line);
            prelude.endLine = i;
        }
    }

    if (current) flush();
    if (prelude) {
        prelude.body = trimSurroundingBlankLines(prelude._bodyLines.join('\n'));
        delete prelude._bodyLines;
        // Drop empty preludes so callers can detect "no content at all"
        // as `parseAnnotations(src).length === 0`. A prelude with real
        // content (file header comment, hoisted imports) is still kept.
        if (prelude.body.length > 0) sections.unshift(prelude);
    }

    return sections;
}

/** Pull `key=value` pairs off the tag line into a simple object. */
function parseTagLine(line) {
    const rest = line.slice(ANNOTATION_TAG.length).trim();
    const tag = { id: '', kind: '', title: '', doc: '' };
    // Tokenize on whitespace; each token is either `key=value` or an
    // ignored extra. Values can't contain spaces in this format —
    // titles are sanitized to identifiers anyway.
    for (const tok of rest.split(/\s+/)) {
        if (!tok) continue;
        const eq = tok.indexOf('=');
        if (eq <= 0) continue;
        const key = tok.slice(0, eq);
        const val = tok.slice(eq + 1);
        if (key in tag) tag[key] = val;
    }
    return tag;
}

function trimSurroundingBlankLines(s) {
    const lines = s.split('\n');
    let start = 0;
    while (start < lines.length && lines[start].trim() === '') start++;
    let end = lines.length;
    while (end > start && lines[end - 1].trim() === '') end--;
    return lines.slice(start, end).join('\n');
}
