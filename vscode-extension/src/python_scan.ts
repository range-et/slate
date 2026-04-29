/**
 * Lightweight Python → slate-project scanner.
 * Walks a directory for *.py files, extracts top-level def/class blocks via
 * regex (no AST — robust enough for slate's modeling, since cards are units of
 * authorship not units of compilation). Each .py file becomes a Doc; each
 * top-level symbol becomes a code Card.
 *
 * Cross-file references: when card body text contains a bare reference to
 * another card's title, it gets added to card.links so the network viz draws
 * the edge and compile emits an `import`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

function uuid(): string {
    return crypto.randomUUID();
}

export interface ScannedCard {
    id: string;
    title: string;
    content: string;
    prompt: string;
    images: any[];
    links: string[];
    cardType: 'code';
}

export interface ScannedDoc {
    id: string;
    title: string;
    summary: string | null;
    destination: string;
    cards: ScannedCard[];
    createdAt: string;
    updatedAt: string;
    cardCount: number;
}

export interface ScannedProject {
    id: string;
    name: string;
    docs: ScannedDoc[];
    createdAt: string;
    updatedAt: string;
    docCount: number;
    totalCards: number;
}

const SKIP_DIR = new Set([
    'node_modules', '__pycache__', '.git', '.venv', 'venv', 'env',
    '.tox', '.pytest_cache', 'dist', 'build', '.mypy_cache', '.ruff_cache',
    'site-packages'
]);

function listPyFiles(root: string): string[] {
    const out: string[] = [];
    function walk(dir: string) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIR.has(entry.name) || entry.name.startsWith('.')) continue;
                walk(full);
            } else if (entry.isFile() && entry.name.endsWith('.py')) {
                out.push(full);
            }
        }
    }
    walk(root);
    return out.sort();
}

function sanitizeSegment(seg: string): string {
    return seg
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
}

/**
 * Split a relative .py path into (destination, docTitle). e.g.
 *   `source/apps/main.py` -> { destination: 'source/apps', title: 'main' }
 *   `main.py`             -> { destination: '',            title: 'main' }
 * Each path segment is independently snake_cased so slate's title sanitizer
 * accepts the result without further mangling.
 */
function splitRelPath(rel: string): { destination: string; title: string } {
    const noExt = rel.replace(/\.py$/, '');
    const segs = noExt.split(path.sep).filter(Boolean);
    if (segs.length === 0) return { destination: '', title: 'untitled' };
    const titleSeg = sanitizeSegment(segs[segs.length - 1]) || 'untitled';
    const destSegs = segs.slice(0, -1).map(sanitizeSegment).filter(Boolean);
    return { destination: destSegs.join('/'), title: titleSeg };
}

/**
 * Split a Python file's text into top-level symbol blocks: each yielded entry
 * has the symbol name and its full source (including any decorators above the
 * `def`/`class` line, until the next top-level def/class/end-of-file).
 */
interface Block { name: string; source: string }

function extractBlocks(source: string): Block[] {
    const lines = source.split(/\r?\n/);
    const blocks: Block[] = [];
    const headerRe = /^(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z_0-9]*)/;

    let i = 0;
    while (i < lines.length) {
        let decoratorStart = -1;

        // Collect any leading decorators and advance i to the next def/class line.
        if (/^@\w/.test(lines[i])) {
            decoratorStart = i;
            let j = i + 1;
            while (j < lines.length && (/^\s*$/.test(lines[j]) || /^@\w/.test(lines[j]))) j++;
            if (j < lines.length && headerRe.test(lines[j])) {
                i = j;
            } else {
                // Decorator without a following def/class — skip past it.
                i = Math.max(j, i + 1);
                continue;
            }
        }

        const headerMatch = lines[i].match(headerRe);
        if (headerMatch) {
            const name = headerMatch[2];
            const startLine = decoratorStart >= 0 ? decoratorStart : i;
            let end = i + 1;
            while (end < lines.length) {
                const next = lines[end];
                // Body extends through indented lines and blank lines. Anything
                // at column 0 (def, class, decorator, import, assignment, comment,
                // `if __name__ == '__main__':`, etc.) ends the block.
                if (next.length > 0 && !/^\s/.test(next)) break;
                end++;
            }
            const sourceText = lines.slice(startLine, end).join('\n').replace(/\s+$/, '') + '\n';
            blocks.push({ name, source: sourceText });
            i = end;
            continue;
        }

        i++;
    }
    return blocks;
}

/**
 * Parse `from X import a, b` and `import X.Y` lines so we know which symbols
 * are referenced from elsewhere (used to seed card.links).
 */
function extractImports(source: string): { module: string; names: string[] }[] {
    const out: { module: string; names: string[] }[] = [];
    const lines = source.split(/\r?\n/);
    for (const line of lines) {
        const fromMatch = line.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)$/);
        if (fromMatch) {
            const module = fromMatch[1];
            const names = fromMatch[2]
                .replace(/\s*#.*$/, '')           // drop trailing comments
                .replace(/[()]/g, '')             // strip parens for multi-line imports
                .split(',')
                .map(s => s.trim().split(/\s+as\s+/)[0])
                .filter(Boolean);
            out.push({ module, names });
            continue;
        }
        const importMatch = line.match(/^\s*import\s+([\w.]+)/);
        if (importMatch) {
            out.push({ module: importMatch[1], names: [] });
        }
    }
    return out;
}

export function scanWorkspace(root: string, projectName: string): ScannedProject {
    const now = new Date().toISOString();
    const project: ScannedProject = {
        id: uuid(),
        name: projectName,
        docs: [],
        createdAt: now,
        updatedAt: now,
        docCount: 0,
        totalCards: 0
    };

    const files = listPyFiles(root);
    if (files.length === 0) return project;

    // Track every symbol name we've seen, to resolve import references later.
    const symbolToDoc = new Map<string, string>(); // symbolName → unique docTitle
    const usedTitles = new Set<string>();
    const fileBlocks: { rel: string; docTitle: string; destination: string; blocks: Block[]; imports: ReturnType<typeof extractImports> }[] = [];

    for (const file of files) {
        const rel = path.relative(root, file);
        const { destination, title } = splitRelPath(rel);
        let text: string;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        const blocks = extractBlocks(text);
        const imports = extractImports(text);

        // Skip files with no top-level symbols (empty __init__.py, scripts with only main blocks, etc.)
        if (blocks.length === 0) continue;

        // Disambiguate when two paths produce the same filename — slate Doc
        // titles are project-unique. Suffix with a destination-derived hash.
        let docTitle = title;
        if (usedTitles.has(docTitle)) {
            const destHint = destination.replace(/[\/\\]+/g, '_') || 'root';
            docTitle = `${title}__${destHint}`;
            let n = 1;
            while (usedTitles.has(docTitle)) {
                docTitle = `${title}__${destHint}_${n++}`;
            }
        }
        usedTitles.add(docTitle);

        for (const blk of blocks) symbolToDoc.set(blk.name, docTitle);
        fileBlocks.push({ rel, docTitle, destination, blocks, imports });
    }

    // Build docs + cards now that we have the global symbol table.
    for (const entry of fileBlocks) {
        // Per-file: which symbols imported here came from another scanned file?
        const linkedSymbols = new Set<string>();
        for (const imp of entry.imports) {
            for (const name of imp.names) {
                if (symbolToDoc.has(name) && symbolToDoc.get(name) !== entry.docTitle) {
                    linkedSymbols.add(name);
                }
            }
        }

        const doc: ScannedDoc = {
            id: uuid(),
            title: entry.docTitle,
            summary: null,
            destination: entry.destination,
            cards: [],
            createdAt: now,
            updatedAt: now,
            cardCount: 0
        };

        for (const blk of entry.blocks) {
            // For each card, only attach links the card actually references in its body.
            const mentioned = [...linkedSymbols].filter(sym => {
                const re = new RegExp(`\\b${sym}\\b`);
                return re.test(blk.source);
            });
            doc.cards.push({
                id: uuid(),
                title: blk.name,
                content: blk.source,
                prompt: `imported from ${entry.rel}`,
                images: [],
                links: mentioned,
                cardType: 'code'
            });
        }
        doc.cardCount = doc.cards.length;
        project.docs.push(doc);
    }

    project.docCount = project.docs.length;
    project.totalCards = project.docs.reduce((sum, d) => sum + d.cards.length, 0);
    return project;
}
