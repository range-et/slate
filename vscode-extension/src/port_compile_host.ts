import * as vscode from 'vscode';

import { compilePython, GENERATED_HEADER, type CompileDiagnostic } from './compile/python';
import { formatPortReport, portPythonProject } from './port/python_importer';
import { CONFIG_PATH, LAYOUT_PATH, NODES_DIR, pathForNodeId, serializeLayout, serializeNode } from './slate_folder';
import { SlateFolderHost } from './slate_folder_host';

// VS Code side of Port Python Project… and Compile. Both write with plain fs
// writes; porting never touches the source folder.

const SKIPPED_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'env', 'dist', 'build', 'slate', 'tests', 'test']);

let channel: vscode.OutputChannel | undefined;
export function slateOutput(): vscode.OutputChannel {
    channel ??= vscode.window.createOutputChannel('Slate');
    return channel;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function exists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function writeText(uri: vscode.Uri, text: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, encoder.encode(text));
}

/** `.py` files under a folder, skipping hidden folders, virtualenvs, tests, build output, and Slate-generated files. */
async function readPythonTree(root: vscode.Uri, prefix = '', files = new Map<string, string>()): Promise<Map<string, string>> {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, ...prefix.split('/').filter(Boolean)))) {
        const relative = prefix ? `${prefix}/${name}` : name;
        if (type === vscode.FileType.Directory) {
            if (!name.startsWith('.') && !SKIPPED_DIRS.has(name)) await readPythonTree(root, relative, files);
        } else if (name.endsWith('.py')) {
            const text = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ...relative.split('/'))));
            if (!text.startsWith(GENERATED_HEADER)) files.set(relative, text);
        }
    }
    return files;
}

/** Slate: Port Python Project… — split a Python folder into `<root>/slate/nodes`. Returns the number of nodes written. */
export async function portPythonFolder(root: vscode.Uri, source?: vscode.Uri): Promise<number> {
    const nodesDir = vscode.Uri.joinPath(root, ...NODES_DIR.split('/'));
    if (await exists(nodesDir) && (await vscode.workspace.fs.readDirectory(nodesDir)).length > 0) {
        vscode.window.showErrorMessage(`${NODES_DIR} is not empty. Port into a project without nodes.`);
        return 0;
    }
    if (!source) {
        const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: root,
            openLabel: 'Port this folder', title: 'Port a Python project into slate/ (the folder is not modified)',
        });
        source = picked?.[0];
        if (!source) return 0;
    }
    const files = await readPythonTree(source);
    if (files.size === 0) {
        vscode.window.showErrorMessage('No Python files found to port.');
        return 0;
    }
    const { nodes, report } = portPythonProject(files);
    const config = vscode.Uri.joinPath(root, ...CONFIG_PATH.split('/'));
    if (!await exists(config)) {
        const name = source.path.split('/').filter(Boolean).pop()?.replace(/[^A-Za-z0-9_-]/g, '_') || 'project';
        await writeText(config, `${JSON.stringify({ slate: 3, name, language: 'python', compile: { outDir: 'src' } }, null, 2)}\n`);
    }
    const layout = vscode.Uri.joinPath(root, ...LAYOUT_PATH.split('/'));
    if (!await exists(layout)) await writeText(layout, serializeLayout({ positions: {}, notes: [] }));
    for (const [nodeId, node] of nodes) {
        await writeText(vscode.Uri.joinPath(root, ...pathForNodeId(nodeId).split('/')), serializeNode(node));
    }
    const output = slateOutput();
    output.clear();
    output.appendLine(`Port of ${source.fsPath}`);
    output.appendLine(formatPortReport(report));
    output.show(true);
    vscode.window.showInformationMessage(
        `Slate: ported ${report.modules.length} module(s) into ${nodes.size} node file(s)${report.warnings.length ? `, ${report.warnings.length} warning(s) (see Output → Slate)` : ''}.`,
    );
    return nodes.size;
}

/** Slate: Compile — write `<outDir>/**.py` from the nodes, removing stale generated files. */
export async function compileSlateFolder(root: vscode.Uri): Promise<{ files: string[]; diagnostics: CompileDiagnostic[] }> {
    const { config, nodes, errors } = await new SlateFolderHost(root).readNodes();
    const result = compilePython(nodes, config);
    const diagnostics: CompileDiagnostic[] = [...errors.map(message => ({ severity: 'error' as const, message })), ...result.diagnostics];
    const outDir = (config.compile?.outDir ?? 'src').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!outDir || outDir.startsWith('/') || outDir.split('/').includes('..') || outDir.split('/')[0] === 'slate') {
        diagnostics.push({ severity: 'error', message: `compile.outDir "${outDir}" must be a relative folder outside slate/.` });
    }
    const output = slateOutput();
    output.clear();
    for (const diagnostic of diagnostics) output.appendLine(`${diagnostic.severity}: ${diagnostic.message}`);
    const failed = diagnostics.filter(diagnostic => diagnostic.severity === 'error').length;
    if (failed > 0) {
        output.show(true);
        vscode.window.showErrorMessage(`Slate: compile stopped with ${failed} error(s); nothing was written (see Output → Slate).`);
        return { files: [], diagnostics };
    }
    const outRoot = vscode.Uri.joinPath(root, ...outDir.split('/'));
    if (await exists(outRoot)) {
        for (const stale of (await readGenerated(outRoot)).filter(path => !result.files.has(path))) {
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(outRoot, ...stale.split('/')));
        }
    }
    for (const [relative, text] of result.files) await writeText(vscode.Uri.joinPath(outRoot, ...relative.split('/')), text);
    output.appendLine(`Compiled ${result.files.size} file(s) into ${outDir}/.`);
    vscode.window.showInformationMessage(`Slate: compiled ${result.files.size} file(s) into ${outDir}/${diagnostics.length ? ` with ${diagnostics.length} warning(s)` : ''}.`);
    return { files: [...result.files.keys()], diagnostics };
}

async function readGenerated(root: vscode.Uri, prefix = ''): Promise<string[]> {
    const found: string[] = [];
    for (const [name, type] of await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, ...prefix.split('/').filter(Boolean)))) {
        const relative = prefix ? `${prefix}/${name}` : name;
        if (type === vscode.FileType.Directory) found.push(...await readGenerated(root, relative));
        else if (name.endsWith('.py')) {
            const text = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ...relative.split('/'))));
            if (text.startsWith(GENERATED_HEADER)) found.push(relative);
        }
    }
    return found;
}
