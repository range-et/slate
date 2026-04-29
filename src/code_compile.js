import { CARD_TYPE_CODE } from './cards.js';

const PY_KEYWORDS = new Set([
    'False','None','True','and','as','assert','async','await','break','class','continue',
    'def','del','elif','else','except','finally','for','from','global','if','import','in',
    'is','lambda','nonlocal','not','or','pass','raise','return','try','while','with','yield'
]);

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidPythonIdentifier(name) {
    if (!name || !IDENT_RE.test(name)) return false;
    if (PY_KEYWORDS.has(name)) return false;
    return true;
}

export function sanitizeDocFilename(title) {
    // Doc titles are already snake_case via sanitizeTitle. Re-validate and fall back.
    const trimmed = String(title || '').trim();
    if (isValidPythonIdentifier(trimmed)) return trimmed;
    const cleaned = trimmed.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    if (cleaned && /^[a-z_]/.test(cleaned)) return cleaned;
    return `doc_${cleaned || 'untitled'}`;
}

/**
 * Convert a doc destination ("lib/util" or "src\\api") into a Python dotted
 * module prefix ("lib.util"). Empty / missing destination → empty string.
 */
export function destinationToModulePrefix(destination) {
    if (!destination) return '';
    const parts = String(destination)
        .split(/[\/\\]+/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(seg => sanitizeDocFilename(seg));
    return parts.join('.');
}

function fullModuleName(doc) {
    const base = sanitizeDocFilename(doc.title);
    const prefix = destinationToModulePrefix(doc.destination);
    return prefix ? `${prefix}.${base}` : base;
}

/**
 * Pull import / from-import statements out of a card's source so they can be
 * hoisted to the top of the compiled file. Operates on column-zero lines only;
 * indented imports inside functions stay put on purpose. Multi-line parenthesized
 * `from x import (a, b)` blocks are collected as one unit.
 *
 * Returns { imports: string[], cleaned: string } — `imports` is the list of
 * raw import statements (one per logical line), `cleaned` is the source with
 * those lines removed. Trailing/leading blank-only runs are collapsed.
 */
export function extractInlineImports(source) {
    if (!source) return { imports: [], cleaned: '' };
    const lines = String(source).split(/\r?\n/);
    const imports = [];
    const kept = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        // Top-level import / from-import. Allow leading blank-line gap, but the
        // statement itself must start at column zero.
        const isImport = /^import\s+\S/.test(line);
        const isFrom = /^from\s+[\w.]+\s+import\s+/.test(line);

        if (!isImport && !isFrom) {
            kept.push(line);
            i++;
            continue;
        }

        // Multi-line parenthesized from-import: collect until we hit the closing paren.
        if (isFrom && /\(\s*$/.test(line) && !line.includes(')')) {
            const buf = [line];
            i++;
            while (i < lines.length && !buf[buf.length - 1].includes(')')) {
                buf.push(lines[i]);
                i++;
            }
            imports.push(buf.join('\n'));
            continue;
        }

        // Backslash-continued import: rare but cheap to handle.
        if (line.endsWith('\\')) {
            const buf = [line];
            i++;
            while (i < lines.length && buf[buf.length - 1].endsWith('\\')) {
                buf.push(lines[i]);
                i++;
            }
            imports.push(buf.join('\n'));
            continue;
        }

        imports.push(line);
        i++;
    }

    // Collapse runs of leading/trailing blank lines that the strip created.
    let start = 0;
    while (start < kept.length && kept[start].trim() === '') start++;
    let end = kept.length;
    while (end > start && kept[end - 1].trim() === '') end--;
    const cleaned = kept.slice(start, end).join('\n');

    return { imports, cleaned };
}

/**
 * Walk a card's prompt for @references and resolve them to (doc, card) tuples
 * limited to other code cards in the project.
 */
function collectCrossDocImports(card, doc, project) {
    const refs = card.links || [];
    const out = []; // [{ targetDoc, cardTitle }]
    if (!project || !refs.length) return out;
    const allDocs = project.getAllDocs ? project.getAllDocs() : [];

    refs.forEach(refTitle => {
        for (const otherDoc of allDocs) {
            if (otherDoc === doc) continue;
            const found = otherDoc.getAllCards().find(c => c.title === refTitle && c.cardType === CARD_TYPE_CODE);
            if (found) {
                out.push({ targetDoc: otherDoc, cardTitle: found.title });
                break;
            }
        }
    });
    return out;
}

/**
 * Compile a doc's code cards into a single Python file.
 * Returns { filename, source, destination, warnings } or throws on hard errors.
 */
export function compileDocToPython(doc, project) {
    if (!doc) throw new Error('No document to compile.');
    const codeCards = doc.getAllCards().filter(c => c.cardType === CARD_TYPE_CODE);
    if (codeCards.length === 0) {
        throw new Error(`Document "${doc.title}" has no code cards to compile.`);
    }

    const warnings = [];
    const docName = sanitizeDocFilename(doc.title);
    const filename = `${docName}.py`;
    const destination = doc.destination || '';

    // Cross-doc @reference imports, deduplicated by (module, name).
    const importMap = new Map(); // key: `${module}|${name}` → { module, name }
    const nameCounts = new Map();
    codeCards.forEach(card => {
        if (!isValidPythonIdentifier(card.title)) {
            warnings.push(`Card title "${card.title}" is not a valid Python identifier; renaming required before compile.`);
        }
        const refs = collectCrossDocImports(card, doc, project);
        refs.forEach(({ targetDoc, cardTitle }) => {
            const refModule = fullModuleName(targetDoc);
            const key = `${refModule}|${cardTitle}`;
            if (!importMap.has(key)) {
                importMap.set(key, { module: refModule, name: cardTitle });
                nameCounts.set(cardTitle, (nameCounts.get(cardTitle) || 0) + 1);
            }
        });
    });

    if (warnings.some(w => w.includes('not a valid Python identifier'))) {
        // Hard fail: invalid identifiers would produce broken Python.
        throw new Error(warnings.join('\n'));
    }

    // Resolve aliases: only namespace when two imports share a name (collision).
    const refImports = new Map();
    for (const [key, entry] of importMap.entries()) {
        const collides = (nameCounts.get(entry.name) || 0) > 1;
        const tail = entry.module.split('.').pop() || entry.module;
        const alias = collides ? `${entry.name}_${tail}` : entry.name;
        refImports.set(key, { ...entry, alias });
    }

    // Per-card pass: hoist inline imports, collect cleaned bodies.
    const inlineImports = new Set(); // dedupe by exact normalized text
    const inlineImportOrder = [];    // preserve first-seen ordering
    const cleanedBodies = [];
    codeCards.forEach(card => {
        const rawSource = (typeof card.getPythonSource === 'function')
            ? (card.getPythonSource() || '')
            : (card.content || '');
        const { imports, cleaned } = extractInlineImports(rawSource);
        for (const imp of imports) {
            const norm = imp.replace(/\s+/g, ' ').trim();
            if (!inlineImports.has(norm)) {
                inlineImports.add(norm);
                inlineImportOrder.push(imp);
            }
        }
        cleanedBodies.push(cleaned);
    });

    // Build the file.
    const lines = [];
    lines.push(`# Compiled from slate doc: ${doc.title}`);
    lines.push(`# Generated by slate-code; do not edit by hand.`);
    lines.push('');

    // 1) Inline (stdlib + third-party) imports the AI wrote into card bodies.
    if (inlineImportOrder.length > 0) {
        for (const imp of inlineImportOrder) lines.push(imp);
        lines.push('');
    }

    // 2) Cross-doc @reference imports — local to this slate project.
    if (refImports.size > 0) {
        for (const { module, name, alias } of refImports.values()) {
            if (alias === name) {
                lines.push(`from ${module} import ${name}`);
            } else {
                lines.push(`from ${module} import ${name} as ${alias}`);
            }
        }
        lines.push('');
    }

    // 3) Card bodies, separated by a blank line.
    cleanedBodies.forEach((body, idx) => {
        if (idx > 0) lines.push('');  // blank line between symbols (one extra → two blank lines total)
        if (body.length > 0) lines.push(body);
    });

    let source = lines.join('\n');
    if (!source.endsWith('\n')) source += '\n';

    return { filename, source, destination, warnings };
}
