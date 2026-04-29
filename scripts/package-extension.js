#!/usr/bin/env node
/**
 * Package the Slate Code VS Code extension as a VSIX, with the build
 * neutralized so a developer's local API keys (src/config.js) never get
 * embedded into dist/ and shipped.
 *
 * Flow:
 *   1. Move src/config.js out of the way (if it exists).
 *   2. Write a null-keyed stub in its place.
 *   3. Build slate -> dist/.
 *   4. Sync dist/ into vscode-extension/dist/.
 *   5. vsce package -> vscode-extension/slate-code-<ver>.vsix.
 *   6. Optionally `code --install-extension <vsix>`  (--install flag).
 *   7. ALWAYS restore the real config.js, even on crash (finally + signal handlers).
 *
 * Usage:
 *   npm run package-extension              # build + package
 *   npm run package-extension -- --install # also install via `code` CLI
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'src', 'config.js');
const backupPath = path.join(root, '.config.js.backup');
const extensionDir = path.join(root, 'vscode-extension');

const STUB = `// Auto-generated stub for extension packaging. Real keys live in localStorage.
const OPENAI_API_KEY = null;
const GEMINI_API_KEY = null;
export { OPENAI_API_KEY, GEMINI_API_KEY };
`;

let configWasBackedUp = false;

function backupConfig() {
    if (fs.existsSync(configPath)) {
        fs.copyFileSync(configPath, backupPath);
        configWasBackedUp = true;
        console.log('✓ backed up src/config.js -> .config.js.backup');
    }
    fs.writeFileSync(configPath, STUB);
    console.log('✓ wrote null-keyed stub to src/config.js');
}

function restoreConfig() {
    if (!configWasBackedUp) return;
    try {
        fs.copyFileSync(backupPath, configPath);
        fs.unlinkSync(backupPath);
        configWasBackedUp = false;
        console.log('✓ restored src/config.js');
    } catch (err) {
        console.error('!! FAILED to restore src/config.js — backup is at', backupPath);
        console.error('!! Run: cp .config.js.backup src/config.js && rm .config.js.backup');
        throw err;
    }
}

// Restore on Ctrl-C / kill, not just clean exit.
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => {
    process.on(sig, () => { restoreConfig(); process.exit(1); });
});

function run(cmd, opts = {}) {
    console.log(`\n$ ${cmd}`);
    execSync(cmd, { stdio: 'inherit', cwd: opts.cwd || root });
}

const shouldInstall = process.argv.includes('--install');

try {
    backupConfig();
    run('npm run build');
    run('npm run sync-dist', { cwd: extensionDir });

    // Wipe any prior .vsix so the install step picks the fresh one.
    for (const f of fs.readdirSync(extensionDir)) {
        if (f.endsWith('.vsix')) fs.unlinkSync(path.join(extensionDir, f));
    }
    run('npx --yes @vscode/vsce package --allow-missing-repository --skip-license', { cwd: extensionDir });

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
} finally {
    restoreConfig();
}
