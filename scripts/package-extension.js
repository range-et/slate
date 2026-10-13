#!/usr/bin/env node
/**
 * Package the Slate Code VS Code extension as a VSIX.
 *
 * Flow:
 *   1. Build the harness webview -> dist/.
 *   2. Sync dist/ into vscode-extension/dist/.
 *   3. vsce package -> vscode-extension/slate-code-<ver>.vsix.
 *   4. Optionally `code --install-extension <vsix>`  (--install flag).
 *
 * Usage:
 *   npm run package-extension              # build + package
 *   npm run package-extension -- --install # also install via `code` CLI
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const extensionDir = path.join(root, 'vscode-extension');

function run(cmd, opts = {}) {
    console.log(`\n$ ${cmd}`);
    execSync(cmd, { stdio: 'inherit', cwd: opts.cwd || root });
}

const shouldInstall = process.argv.includes('--install');

run('npm run build');
run('npm run sync-dist', { cwd: extensionDir });

// Wipe any prior .vsix so the install step picks the fresh one.
for (const f of fs.readdirSync(extensionDir)) {
    if (f.endsWith('.vsix')) fs.unlinkSync(path.join(extensionDir, f));
}
run('npx --yes @vscode/vsce package --allow-missing-repository --skip-license --follow-symlinks', { cwd: extensionDir });

const vsix = fs.readdirSync(extensionDir).find(f => f.endsWith('.vsix'));
if (!vsix) throw new Error('vsce did not produce a .vsix');
const vsixPath = path.join(extensionDir, vsix);
console.log(`\n✓ packaged: ${vsixPath}`);

if (shouldInstall) {
    run(`code --install-extension "${vsixPath}"`);
    console.log('\n✓ installed. Reload VS Code (Cmd-Shift-P → Developer: Reload Window) to pick up the new build.');
} else {
    console.log('\nNext step:');
    console.log(`  code --install-extension "${vsixPath}"`);
    console.log('  (or pass --install to do it automatically)');
}
