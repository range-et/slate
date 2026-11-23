import * as vscode from 'vscode';

import { PROSE_GENERATED_MD_HEADER, PROSE_GENERATED_TEX_HEADER } from './compile/prose';
import { GENERATED_HEADER, type CompileDiagnostic } from './compile/python';
import { MAIN_FLOW, migrateRootOccurrences, pathForFlowId, serializeFlow } from './flow';
import {
    compileProjectForLanguage,
    inferLanguageFromPath,
    isSlateGeneratedContent,
    portProjectForLanguage,
    tryNormalizeLanguage,
} from './language_adapter';
import { formatPortReport } from './port/python_importer';
import { CONFIG_PATH, emptyLayout, LAYOUT_PATH, NODES_DIR, pathForNodeId, serializeLayout, serializeNode } from './slate_folder';
import { SlateFolderHost } from './slate_folder_host';

// VS Code side of Port Project… and Compile. Both write with plain fs
// writes; porting never touches the source folder.

const SKIPPED_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'env', 'dist', 'build', 'slate', 'tests', 'test', 'bin', 'obj']);

const SUPPORTED_SOURCE_EXTENSIONS = [
    '.py',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.cs',
    '.cpp',
    '.cc',
    '.cxx',
    '.c',
    '.h',
    '.hpp',
    '.hh',
    '.hxx',
    '.ino',
    '.pde',
    '.md',
    '.markdown',
    '.tex',
    '.bib',
] as const;

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

function isSupportedSourceFile(name: string, languageFilter?: string): boolean {
    const lower = name.toLowerCase();
    if (lower.endsWith('.d.ts')) return false;
    const normFilter = tryNormalizeLanguage(languageFilter);
    if (normFilter === 'python') return lower.endsWith('.py');
    if (normFilter === 'typescript' || normFilter === 'javascript') {
        return lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.js') || lower.endsWith('.jsx');
    }
    if (normFilter === 'csharp') return lower.endsWith('.cs');
    if (normFilter === 'cpp' || normFilter === 'arduino') {
        return ['.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.hh', '.hxx', '.ino', '.pde'].some(ext => lower.endsWith(ext));
    }
    if (normFilter === 'prose') {
        return ['.md', '.markdown', '.tex', '.bib'].some(ext => lower.endsWith(ext));
    }
    return SUPPORTED_SOURCE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/** Source files under a folder, skipping hidden folders, virtualenvs, tests, build output, and Slate-generated files. */
async function readSourceTree(
    root: vscode.Uri,
    languageFilter?: string,
    prefix = '',
    files = new Map<string, string>(),
): Promise<Map<string, string>> {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, ...prefix.split('/').filter(Boolean)))) {
        const relative = prefix ? `${prefix}/${name}` : name;
        if (type === vscode.FileType.Directory) {
            if (!name.startsWith('.') && !SKIPPED_DIRS.has(name)) await readSourceTree(root, languageFilter, relative, files);
        } else if (isSupportedSourceFile(name, languageFilter)) {
            const text = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ...relative.split('/'))));
            if (!text.startsWith(GENERATED_HEADER) && !isSlateGeneratedContent(text)) {
                files.set(relative, text);
            }
        }
    }
    return files;
}

/**
 * Slate: Port Project… — split a Python, TypeScript/JavaScript, C#, C++/Arduino, or Markdown/Prose folder
 * into `<root>/slate/nodes` (and `<root>/slate/flows` when applicable). Returns the number of nodes written.
 */
export async function portProjectFolder(
    root: vscode.Uri,
    source?: vscode.Uri,
    language?: string,
): Promise<number> {
    const nodesDir = vscode.Uri.joinPath(root, ...NODES_DIR.split('/'));
    if (await exists(nodesDir) && (await vscode.workspace.fs.readDirectory(nodesDir)).length > 0) {
        vscode.window.showErrorMessage(`${NODES_DIR} is not empty. Port into a project without nodes.`);
        return 0;
    }
    if (!source) {
        const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: root,
            openLabel: 'Port this folder', title: 'Port a project into slate/ (the folder is not modified)',
        });
        source = picked?.[0];
        if (!source) return 0;
    }
    const files = await readSourceTree(source, language);
    if (files.size === 0) {
        const label = language === 'python' ? 'Python' : 'source';
        vscode.window.showErrorMessage(`No ${label} files found to port.`);
        return 0;
    }
    const ported = portProjectForLanguage(files, language);
    const { nodes, report } = ported;
    const config = vscode.Uri.joinPath(root, ...CONFIG_PATH.split('/'));
    if (!await exists(config)) {
        const name = ported.config?.name || source.path.split('/').filter(Boolean).pop()?.replace(/[^A-Za-z0-9_-]/g, '_') || 'project';
        const outDir = ported.config?.compile?.outDir ?? (ported.language === 'prose' ? 'build/prose' : 'src');
        await writeText(
            config,
            `${JSON.stringify({ slate: 3, name, language: ported.language, compile: { outDir } }, null, 2)}\n`,
        );
    }
    const layout = vscode.Uri.joinPath(root, ...LAYOUT_PATH.split('/'));
    if (!await exists(layout)) await writeText(layout, serializeLayout(emptyLayout()));
    for (const [nodeId, node] of nodes) {
        await writeText(vscode.Uri.joinPath(root, ...pathForNodeId(nodeId).split('/')), serializeNode(node));
    }
    if (ported.flows) {
        for (const [flowId, flow] of ported.flows) {
            await writeText(vscode.Uri.joinPath(root, ...pathForFlowId(flowId).split('/')), serializeFlow(flow));
        }
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

/** Slate: Port Python Project… — backwards-compatible wrapper around `portProjectFolder`. */
export async function portPythonFolder(root: vscode.Uri, source?: vscode.Uri): Promise<number> {
    return portProjectFolder(root, source, 'python');
}

/** Slate: Compile — write `<outDir>/**` from the nodes across all supported languages, removing stale generated files. */
export async function compileSlateFolder(root: vscode.Uri): Promise<{ files: string[]; diagnostics: CompileDiagnostic[] }> {
    const host = new SlateFolderHost(root);
    const { config, nodes, errors } = await host.readNodes();
    const flowFiles = await host.readFlows();
    const flows = new Map(flowFiles.filter(item => item.flow).map(item => [item.id, item.flow!]));
    let layout = emptyLayout();
    try {
        layout = await host.readLayout();
    } catch { /* layout errors are surfaced when opening the folder */ }
    const migrated = migrateRootOccurrences(
        flows.get(MAIN_FLOW) ?? null,
        layout.refs,
        layout.positions,
        nodes.keys(),
        [...flows.keys()].filter(id => id !== MAIN_FLOW),
    );
    if (migrated.main) flows.set(MAIN_FLOW, migrated.main);
    const outDir = (config.compile?.outDir ?? 'src').replace(/\\/g, '/').replace(/\/+$/, '');
    const outRoot = vscode.Uri.joinPath(root, ...outDir.split('/'));
    const existingFiles = await exists(outRoot) ? await readExistingOutFiles(outRoot) : undefined;
    const library = tryNormalizeLanguage(config.language) === 'prose'
        ? new Map()
        : SlateFolderHost.librarySignatures(await host.readLibrary(config));
    const result = compileProjectForLanguage(nodes, config, flows, library, existingFiles);
    const diagnostics: CompileDiagnostic[] = [
        ...errors.map(message => ({ severity: 'error' as const, message })),
        ...flowFiles.filter(item => item.problem).map(item => ({ severity: 'error' as const, message: `flows/${item.id}: ${item.problem}` })),
        ...result.diagnostics,
    ];
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

async function readExistingOutFiles(root: vscode.Uri, prefix = '', files = new Map<string, string>()): Promise<Map<string, string>> {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, ...prefix.split('/').filter(Boolean)))) {
        const relative = prefix ? `${prefix}/${name}` : name;
        if (type === vscode.FileType.Directory) {
            await readExistingOutFiles(root, relative, files);
        } else if (inferLanguageFromPath(name) !== null) {
            const text = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ...relative.split('/'))));
            files.set(relative, text);
        }
    }
    return files;
}

async function readGenerated(root: vscode.Uri, prefix = ''): Promise<string[]> {
    const found: string[] = [];
    for (const [name, type] of await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, ...prefix.split('/').filter(Boolean)))) {
        const relative = prefix ? `${prefix}/${name}` : name;
        if (type === vscode.FileType.Directory) found.push(...await readGenerated(root, relative));
        else if (inferLanguageFromPath(name) !== null) {
            const text = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, ...relative.split('/'))));
            if (
                text.startsWith(GENERATED_HEADER) ||
                text.startsWith(PROSE_GENERATED_MD_HEADER) ||
                text.startsWith(PROSE_GENERATED_TEX_HEADER) ||
                isSlateGeneratedContent(text)
            ) {
                found.push(relative);
            }
        }
    }
    return found;
}

