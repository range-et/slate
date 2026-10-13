/**
 * Pure-JS scanner for a single Python source string.
 *
 * Splits a file into top-level def/class blocks (each becomes one slate code
 * card) and pulls out every column-zero `import` / `from x import y` line
 * separately. Mirrors `vscode-extension/src/python_scan.ts` so slate can
 * rehydrate from a file that the host already read off disk.
 *
 * Robust enough for slate's modeling — units of authorship, not units of
 * compilation. Decorators above a def/class are kept with the block; bare
 * top-level statements outside any def/class are dropped (they would belong in
 * a "module body" card type that slate doesn't have today).
 */

const HEADER_RE = /^(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z_0-9]*)/;

function isImportLine(line) {
    return /^import\s+\S/.test(line) || /^from\s+[\w.]+\s+import\s+/.test(line);
}

function collectMultilineImport(lines, start) {
    const first = lines[start];
    // Parenthesized multi-line: collect until the closing paren.
    if (/\(\s*$/.test(first) && !first.includes(')')) {
        const buf = [first];
        let i = start + 1;
        while (i < lines.length && !buf[buf.length - 1].includes(')')) {
            buf.push(lines[i]);
            i++;
        }
        return { text: buf.join('\n'), nextIndex: i };
    }
    // Backslash-continued.
    if (first.endsWith('\\')) {
        const buf = [first];
        let i = start + 1;
        while (i < lines.length && buf[buf.length - 1].endsWith('\\')) {
            buf.push(lines[i]);
            i++;
        }
        return { text: buf.join('\n'), nextIndex: i };
    }
    return { text: first, nextIndex: start + 1 };
}

/**
 * Walk a source string and return:
 *   imports: Array<string>  — full text of each top-level import statement
 *   blocks:  Array<{ name, source }>  — def/class with leading decorators
 */
export function scanPythonSource(source) {
    const lines = String(source || '').split(/\r?\n/);
    const imports = [];
    const blocks = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        // Top-level imports — collect and skip.
        if (isImportLine(line)) {
            const { text, nextIndex } = collectMultilineImport(lines, i);
            imports.push(text);
            i = nextIndex;
            continue;
        }

        // Decorators directly above a def/class.
        let decoratorStart = -1;
        if (/^@\w/.test(line)) {
            decoratorStart = i;
            let j = i + 1;
            while (j < lines.length && (/^\s*$/.test(lines[j]) || /^@\w/.test(lines[j]))) j++;
            if (j < lines.length && HEADER_RE.test(lines[j])) {
                i = j;
            } else {
                i = Math.max(j, i + 1);
                continue;
            }
        }

        const headerMatch = lines[i].match(HEADER_RE);
        if (headerMatch) {
            const name = headerMatch[2];
            const startLine = decoratorStart >= 0 ? decoratorStart : i;
            let end = i + 1;
            while (end < lines.length) {
                const next = lines[end];
                // Body extends through indented + blank lines. Anything at
                // column 0 (def, class, decorator, import, assignment, etc.)
                // ends the block.
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

    return { imports, blocks };
}
