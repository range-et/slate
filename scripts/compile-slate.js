#!/usr/bin/env node
// Compile a project's slate/ folder (nodes, flows, library) into <out-dir>.
// Usage: node scripts/compile-slate.js <project-root> <out-dir>
// Requires `npm --prefix vscode-extension run compile` (uses vscode-extension/out).
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'vscode-extension', 'out');
const { compilePython } = require(path.join(out, 'compile', 'python.js'));
const { parseConfig, parseNode } = require(path.join(out, 'slate_folder.js'));
const { parseFlow, unitSignature } = require(path.join(out, 'flow.js'));
const { parseModule } = require(path.join(out, 'python_adapter.js'));

const [root, outDir] = process.argv.slice(2);
if (!root || !outDir) {
    console.error('usage: node scripts/compile-slate.js <project-root> <out-dir>');
    process.exit(2);
}
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const walk = dir => fs.existsSync(path.join(root, dir))
    ? fs.readdirSync(path.join(root, dir), { recursive: true }).map(String).filter(name => name.endsWith('.json')).map(name => name.replace(/\\/g, '/'))
    : [];

const config = parseConfig(read('slate/slate.json'));
const nodes = new Map(walk('slate/nodes').map(name => [name.slice(0, -5), parseNode(read(`slate/nodes/${name}`))]));
const flows = new Map(walk('slate/flows').map(name => [name.slice(0, -5), parseFlow(read(`slate/flows/${name}`))]));
const library = new Map();
for (const file of config.library ?? []) {
    const units = parseModule(read(file), file).units;
    for (const unit of units.filter(item => item.parentId === null)) library.set(`lib:${file}:${unit.name}`, unitSignature(unit, units));
}
const result = compilePython(nodes, config, flows, library);
for (const diagnostic of result.diagnostics) console.log(`${diagnostic.severity}: ${diagnostic.message}`);
if (result.diagnostics.some(diagnostic => diagnostic.severity === 'error')) process.exit(1);
for (const [relative, text] of result.files) {
    const file = path.join(outDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`compiled ${relative}`);
}
