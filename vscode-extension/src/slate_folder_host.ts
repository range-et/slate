import * as path from 'path';
import * as vscode from 'vscode';

import type { HarnessDocument } from './harness_protocol';
import {
    CONFIG_PATH, indexNode, LAYOUT_PATH, NODES_DIR, nodeIdForPath, parseConfig, parseLayout, parseNode, pathForNodeId,
    serializeLayout, serializeNode, SlateConfig, SlateLayout, SlateNode,
} from './slate_folder';

export interface FolderIndex {
    config: SlateConfig;
    documents: HarnessDocument[];
    /** Node code text keyed by document path; unit ranges are relative to it. */
    sources: Map<string, string>;
}

/** Filesystem side of the decoupled slate/ folder. The panel owns the webview. */
export class SlateFolderHost {
    layout: SlateLayout = { positions: {}, notes: [] };
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

    private async read(relativePath: string): Promise<{ text: string; version: number | null } | undefined> {
        const uri = this.uri(relativePath);
        const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
        if (open) return { text: open.getText(), version: open.version };
        try {
            return { text: new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), version: null };
        } catch {
            return undefined;
        }
    }

    async index(): Promise<FolderIndex> {
        const configFile = await this.read(CONFIG_PATH);
        if (!configFile) throw new Error(`${CONFIG_PATH} is missing.`);
        const config = parseConfig(configFile.text);
        try {
            this.layout = parseLayout((await this.read(LAYOUT_PATH))?.text);
        } catch (error) {
            throw new Error(`${LAYOUT_PATH}: ${(error as Error).message}`);
        }
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
        return { config, documents, sources };
    }

    async writeLayout(): Promise<void> {
        await vscode.workspace.fs.writeFile(this.uri(LAYOUT_PATH), new TextEncoder().encode(serializeLayout(this.layout)));
    }

    /** Current node from its (possibly dirty) document. */
    async readNode(nodeId: string): Promise<SlateNode> {
        const file = await this.read(pathForNodeId(nodeId));
        if (!file) throw new Error(`Node ${nodeId} does not exist.`);
        return parseNode(file.text);
    }

    /** Rewrite one node file as a single undoable WorkspaceEdit, then save it. */
    async writeNode(nodeId: string, node: SlateNode): Promise<void> {
        const document = await vscode.workspace.openTextDocument(this.uri(pathForNodeId(nodeId)));
        const replacement = serializeNode(node);
        if (replacement === document.getText()) return;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), replacement);
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the node edit.');
        await document.save();
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
