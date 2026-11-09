import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Reuse installed tools/cache, while source, fixtures and outputs stay sandboxed. */
export function prepareSystemSandbox(root, sandbox = process.cwd()) {
    if (!root) throw new Error('SLATE_MUTATION_ROOT must identify the original repository');
    const repository = fs.realpathSync(root);
    const working = fs.realpathSync(sandbox);
    const relative = path.relative(path.join(repository, '.stryker-tmp'), working);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('System mutation tests must run inside a Stryker sandbox');
    }
    for (const directory of ['node_modules', 'vscode-extension/node_modules', 'vscode-extension/.vscode-test']) {
        const source = path.join(repository, directory);
        const destination = path.join(working, directory);
        if (!fs.statSync(source).isDirectory()) throw new Error(`Required tool directory is missing: ${source}`);
        if (fs.existsSync(destination)) {
            if (fs.realpathSync(destination) !== fs.realpathSync(source)) throw new Error(`Refusing to replace ${destination}`);
        } else {
            fs.symlinkSync(source, destination, 'dir');
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    prepareSystemSandbox(process.env.SLATE_MUTATION_ROOT);
}
