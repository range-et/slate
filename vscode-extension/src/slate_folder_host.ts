import * as path from 'path';
import * as vscode from 'vscode';

import { FLOWS_DIR, flowIdForPath, MAIN_FLOW, migrateRootOccurrences, parseFlow, pathForFlowId, serializeFlow, unitSignature, type CallableSignature } from './flow';
import type { CanvasRef, HarnessDocument, HarnessFlow, LibraryDocument, SlateFlow } from './harness_protocol';
import { parseModule } from './python_adapter';
import {
    CONFIG_PATH, emptyLayout, indexNode, LAYOUT_PATH, NODES_DIR, nodeIdForPath, parseConfig, parseLayout, parseNode, pathForNodeId,
    serializeLayout, serializeNode, SlateConfig, SlateLayout, SlateNode,
} from './slate_folder';

export interface FolderIndex {
    config: SlateConfig;
    documents: HarnessDocument[];
    flows: HarnessFlow[];
    library: LibraryDocument[];
    /** Node code text keyed by document path; unit ranges are relative to it. */
    sources: Map<string, string>;
}

/** Filesystem side of the decoupled slate/ folder. The panel owns the webview. */
export class SlateFolderHost {
    layout: SlateLayout = emptyLayout();
    private deferredRefs: CanvasRef[] = [];
    private readonly lastGood = new Map<string, { document: HarnessDocument; code: string }>();

    constructor(readonly root: vscode.Uri) {}

    static async detect(root: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, ...CONFIG_PATH.split('/')));
            return true;
        } catch {
            return false;
        }
    }

    uri(relativePath: string): vscode.Uri {
        return vscode.Uri.joinPath(this.root, ...relativePath.split('/'));
    }

    relative(uri: vscode.Uri): string {
        return path.relative(this.root.fsPath, uri.fsPath).replace(/\\/g, '/');
    }

    /** Node id for a node file URI, or null. */
    nodeId(uri: vscode.Uri): string | null {
        return nodeIdForPath(this.relative(uri));
    }

    nodePattern(): vscode.RelativePattern {
        return new vscode.RelativePattern(this.root, `${NODES_DIR}/**/*.json`);
    }

    flowPattern(): vscode.RelativePattern {
        return new vscode.RelativePattern(this.root, `${FLOWS_DIR}/**/*.json`);
    }

    /** Parsed flows by id; unreadable flow files are reported with a problem. */
    async readFlows(): Promise<HarnessFlow[]> {
        const flows: HarnessFlow[] = [];
        for (const uri of await vscode.workspace.findFiles(this.flowPattern())) {
            const id = flowIdForPath(this.relative(uri));
            const file = id ? await this.read(pathForFlowId(id)) : undefined;
            if (!id || !file) continue;
            try {
                flows.push({ id, flow: parseFlow(file.text) });
            } catch (error) {
                flows.push({ id, flow: null, problem: (error as Error).message });
            }
        }
        return flows.sort((left, right) => left.id.localeCompare(right.id));
    }

    async writeFlow(flowId: string, flow: SlateFlow): Promise<void> {
        const uri = this.uri(pathForFlowId(flowId));
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serializeFlow(flow)));
        if (flowId === MAIN_FLOW && this.deferredRefs.length > 0) {
            // main.json now holds the migrated root instances; drop the deferred legacy refs.
            this.deferredRefs = [];
            await this.writeLayout();
        }
    }

    /** Library files from slate.json `library` (files or folders of .py), with top-level ids `lib:<path>:<name>`. */
    async readLibrary(config: SlateConfig): Promise<LibraryDocument[]> {
        const documents: LibraryDocument[] = [];
        const visit = async (relativePath: string): Promise<void> => {
            const uri = this.uri(relativePath);
            let type: vscode.FileType;
            try {
                type = (await vscode.workspace.fs.stat(uri)).type;
            } catch {
                documents.push({ path: relativePath, units: [], problem: 'not found' });
                return;
            }
            if (type & vscode.FileType.Directory) {
                for (const [name, childType] of await vscode.workspace.fs.readDirectory(uri)) {
                    if (childType & vscode.FileType.Directory ? !name.startsWith('.') && name !== '__pycache__' : name.endsWith('.py')) {
                        await visit(`${relativePath.replace(/\/+$/, '')}/${name}`);
                    }
                }
                return;
            }
            const parsed = parseModule((await this.read(relativePath))?.text ?? '', relativePath);
            const ids = new Map(parsed.units.filter(unit => unit.parentId === null).map(unit => [unit.id, `lib:${relativePath}:${unit.name}`]));
            documents.push({
                path: relativePath,
                units: parsed.units.map(unit => ({ ...unit, id: ids.get(unit.id) ?? unit.id, parentId: unit.parentId && (ids.get(unit.parentId) ?? unit.parentId), annotation: null })),
                problem: parsed.valid ? undefined : parsed.diagnostics[0]?.message,
            });
        };
        for (const entry of config.library ?? []) await visit(entry.replace(/\\/g, '/'));
        return documents.sort((left, right) => left.path.localeCompare(right.path));
    }

    /** Callable signatures of library top-level units, for compile. */
    static librarySignatures(library: LibraryDocument[]): Map<string, CallableSignature> {
        const signatures = new Map<string, CallableSignature>();
        for (const document of library) {
            for (const unit of document.units.filter(item => item.parentId === null)) signatures.set(unit.id, unitSignature(unit, document.units));
        }
        return signatures;
    }

    async readLayout(): Promise<SlateLayout> {
        return parseLayout((await this.read(LAYOUT_PATH))?.text);
    }

    private isDirty(relativePath: string): boolean {
        const uri = this.uri(relativePath);
        return vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString() && document.isDirty);
    }

    private async read(relativePath: string): Promise<{ text: string; version: number | null } | undefined> {
        const uri = this.uri(relativePath);
        const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
        if (open?.isDirty) return { text: open.getText(), version: open.version };
        try {
            return { text: new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), version: open?.version ?? null };
        } catch {
            return undefined;
        }
    }

    async index(): Promise<FolderIndex> {
        const configFile = await this.read(CONFIG_PATH);
        if (!configFile) throw new Error(`${CONFIG_PATH} is missing.`);
        const config = parseConfig(configFile.text);
        const uris = await vscode.workspace.findFiles(this.nodePattern());
        const documents: HarnessDocument[] = [];
        const sources = new Map<string, string>();
        for (const uri of uris) {
            const relativePath = this.relative(uri);
            const file = await this.read(relativePath);
            if (!file) continue;
            const { document, code } = indexNode(relativePath, file.text, config.language, file.version);
            const previous = this.lastGood.get(relativePath);
            if (document.valid) this.lastGood.set(relativePath, { document, code });
            else if (previous) {
                // Keep the last good graph visible, marked stale, while the node is broken.
                document.units = previous.document.units;
                document.stale = true;
            }
            sources.set(relativePath, document.stale && previous ? previous.code : code);
            documents.push(document);
        }
        documents.sort((left, right) => left.path.localeCompare(right.path));
        const flows = await this.readFlows();
        try {
            // In place, so actions holding `layout` keep writing the live object.
            Object.assign(this.layout, await this.readLayout());
        } catch (error) {
            throw new Error(`${LAYOUT_PATH}: ${(error as Error).message}`);
        }
        const mainEntry = flows.find(item => item.id === MAIN_FLOW);
        if (!mainEntry || mainEntry.flow !== null) {
            const definitionIds = documents.flatMap(document => [
                ...(document.nodeKind ? [nodeIdForPath(document.path)!] : []),
                ...document.units.map(unit => unit.id),
            ]).filter(Boolean);
            const flowIds = flows.filter(item => item.id !== MAIN_FLOW).map(item => item.id);
            const migrated = migrateRootOccurrences(mainEntry?.flow ?? null, this.layout.refs, this.layout.positions, definitionIds, flowIds);
            this.deferredRefs = [];
            if (migrated.changed) {
                if (!this.isDirty(LAYOUT_PATH) && !this.isDirty(pathForFlowId(MAIN_FLOW))) {
                    // main.json first: legacy refs leave layout.json only once main.json holds them.
                    if (migrated.main) await this.writeFlow(MAIN_FLOW, migrated.main);
                    this.layout.positions = migrated.positions;
                    this.layout.refs = [];
                    await this.writeLayout();
                } else {
                    // Dirty buffer: migrate in memory only; layout writes keep the legacy refs
                    // until main.json is written, so they are never dropped from disk early.
                    this.deferredRefs = this.layout.refs;
                    this.layout.positions = migrated.positions;
                    this.layout.refs = [];
                }
                if (migrated.main) {
                    if (mainEntry) mainEntry.flow = migrated.main;
                    else {
                        flows.push({ id: MAIN_FLOW, flow: migrated.main });
                        flows.sort((left, right) => left.id.localeCompare(right.id));
                    }
                }
            }
        }
        return { config, documents, sources, flows, library: await this.readLibrary(config) };
    }

    /** Every node file, parsed (dirty buffers included); unreadable files are reported, not thrown. */
    async readNodes(): Promise<{ config: SlateConfig; nodes: Map<string, SlateNode>; errors: string[] }> {
        const configFile = await this.read(CONFIG_PATH);
        if (!configFile) throw new Error(`${CONFIG_PATH} is missing.`);
        const config = parseConfig(configFile.text);
        const nodes = new Map<string, SlateNode>();
        const errors: string[] = [];
        for (const uri of await vscode.workspace.findFiles(this.nodePattern())) {
            const relativePath = this.relative(uri);
            const file = await this.read(relativePath);
            try {
                if (file) nodes.set(nodeIdForPath(relativePath)!, parseNode(file.text));
            } catch (error) {
                errors.push(`${relativePath}: ${(error as Error).message}`);
            }
        }
        return { config, nodes, errors };
    }

    async readConfigText(): Promise<string> {
        const file = await this.read(CONFIG_PATH);
        if (!file) throw new Error(`${CONFIG_PATH} is missing.`);
        return file.text;
    }

    async writeLayout(): Promise<void> {
        const refs = [...this.deferredRefs, ...this.layout.refs.filter(ref => !this.deferredRefs.some(item => item.id === ref.id))];
        await vscode.workspace.fs.writeFile(this.uri(LAYOUT_PATH), new TextEncoder().encode(serializeLayout({ ...this.layout, refs })));
    }

    /** Current node from its (possibly dirty) document. */
    async readNode(nodeId: string): Promise<SlateNode> {
        const file = await this.read(pathForNodeId(nodeId));
        if (!file) throw new Error(`Node ${nodeId} does not exist.`);
        return parseNode(file.text);
    }

    /** Rewrite and save one undoable edit; return its version before Save can admit later edits. */
    async writeNode(nodeId: string, node: SlateNode): Promise<number> {
        const document = await vscode.workspace.openTextDocument(this.uri(pathForNodeId(nodeId)));
        const replacement = serializeNode(node);
        if (replacement === document.getText()) return document.version;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), replacement);
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the node edit.');
        const appliedVersion = document.version;
        if (!await document.save()) throw new Error('VS Code could not save the node. The edited buffer is still available.');
        return appliedVersion;
    }

    async createNode(node: SlateNode, position: { x: number; y: number }): Promise<string> {
        const nodeId = node.name;
        const uri = this.uri(pathForNodeId(nodeId));
        try {
            await vscode.workspace.fs.stat(uri);
            throw new Error(`Node ${nodeId} already exists.`);
        } catch (error) {
            if (error instanceof Error && error.message.startsWith('Node ')) throw error;
        }
        const edit = new vscode.WorkspaceEdit();
        edit.createFile(uri, { ignoreIfExists: false });
        edit.insert(uri, new vscode.Position(0, 0), serializeNode(node));
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the new node.');
        await (await vscode.workspace.openTextDocument(uri)).save();
        this.layout.positions[nodeId] = position;
        await this.writeLayout();
        return nodeId;
    }

    /** Line of the `"code"` key, for revealing a node file. */
    static codeLine(text: string): number {
        const index = text.split('\n').findIndex(line => line.trimStart().startsWith('"code"'));
        return Math.max(0, index);
    }
}
