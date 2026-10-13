#!/usr/bin/env node
// Port a Python folder into slate/ nodes and compile them back to Python.
// Usage: node scripts/port-compile.js <source-dir> <out-dir> [slate-dir]
// Requires `npm --prefix vscode-extension run compile` (uses vscode-extension/out).
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'vscode-extension', 'out');
const { portPythonProject, formatPortReport } = require(path.join(out, 'port', 'python_importer.js'));
const { compilePython } = require(path.join(out, 'compile', 'python.js'));
const { serializeNode, parseNode } = require(path.join(out, 'slate_folder.js'));

const [sourceDir, outDir, slateDir] = process.argv.slice(2);
if (!sourceDir || !outDir) {
    console.error('usage: node scripts/port-compile.js <source-dir> <out-dir> [slate-dir]');
    process.exit(2);
}

const files = new Map();
for (const name of fs.readdirSync(sourceDir, { recursive: true })) {
    const relative = String(name).replace(/\\/g, '/');
    if (relative.endsWith('.py') && !relative.split('/').some(part => part === 'tests' || part === '__pycache__')) {
        files.set(relative, fs.readFileSync(path.join(sourceDir, relative), 'utf8'));
    }
}
const { nodes, report } = portPythonProject(files);
console.log(formatPortReport(report));

// Round-trip every node through its JSON form, as the folder would.
const roundTripped = new Map([...nodes].map(([id, node]) => [id, parseNode(serializeNode(node))]));
if (slateDir) {
    for (const [id, node] of nodes) {
        const file = path.join(slateDir, 'nodes', `${id}.json`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, serializeNode(node));
    }
}
const result = compilePython(roundTripped, { slate: 3, name: path.basename(path.resolve(sourceDir)), language: 'python' });
for (const diagnostic of result.diagnostics) console.log(`${diagnostic.severity}: ${diagnostic.message}`);
if (result.diagnostics.some(diagnostic => diagnostic.severity === 'error')) process.exit(1);
for (const [relative, text] of result.files) {
    const file = path.join(outDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`compiled ${relative}`);
}
