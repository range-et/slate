import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Normalize mapped browser/Node source URLs into repository-relative paths. */
export function sourcePath(value, root = process.cwd()) {
    let name = value.replaceAll('\\', '/').split(/[?#]/, 1)[0];
    if (name.startsWith('file:')) name = fileURLToPath(name);
    if (name.startsWith(root.replaceAll('\\', '/') + '/')) return name.slice(root.length + 1);
    if (/^(?:https?:\/\/[^/]+\/)?harness\//.test(name)) return 'src/' + name.replace(/^https?:\/\/[^/]+\//, '');
    for (const prefix of ['vscode-extension/src/', 'src/harness/']) {
        const at = name.indexOf(prefix);
        if (at >= 0 && (at === 0 || name[at - 1] === '/')) return name.slice(at);
    }
    return name;
}

export function isActiveSource(value) {
    const name = sourcePath(value);
    return /^(src\/harness\/|vscode-extension\/src\/)/.test(name)
        && !name.startsWith('vscode-extension/src/test/')
        && /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')
        && !name.split('/').includes('..');
}

/** Include every product source, even if no runner executed it. */
export function activeSources(root = process.cwd()) {
    return ['src/harness', 'vscode-extension/src'].flatMap(directory =>
        readdirSync(path.join(root, directory), { recursive: true })
            .map(name => `${directory}/${name}`.replaceAll('\\', '/'))
            .filter(isActiveSource)).sort();
}

export function requireCompleteCoverage(coverage, expected) {
    const present = new Set(Object.keys(coverage).map(name => sourcePath(name)));
    const missing = expected.filter(name => !present.has(name));
    if (missing.length) throw new Error(`Missing product sources in coverage: ${missing.join(', ')}`);
}

/** Bind collected counts to exact source contents, not just matching AST spans. */
export function sourceFingerprint(root = process.cwd()) {
    return Object.fromEntries(activeSources(root).map(name => [name,
        createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex')]));
}
