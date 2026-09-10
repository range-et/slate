import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
    ParseModuleResult,
    SourceProposal,
    WORKER_PROTOCOL_VERSION,
    WorkerMethod,
    WorkerRequest,
    parseWorkerResponse,
} from './harness_protocol';

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timeout: NodeJS.Timeout;
}

function venvPython(venv: string): string {
    return process.platform === 'win32'
        ? path.join(venv, 'Scripts', 'python.exe')
        : path.join(venv, 'bin', 'python');
}

function run(command: string, args: string[], output: vscode.OutputChannel): Promise<void> {
    return new Promise((resolve, reject) => {
        output.appendLine(`> ${command} ${args.join(' ')}`);
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', chunk => output.append(chunk.toString()));
        child.stderr.on('data', chunk => output.append(chunk.toString()));
        child.once('error', reject);
        child.once('exit', code => {
            if (code === 0) resolve();
            else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
        });
    });
}

export class PythonWorker implements vscode.Disposable {
    private child: ChildProcessWithoutNullStreams | undefined;
    private pending = new Map<string | number, PendingRequest>();
    private nextId = 1;
    private stdoutBuffer = '';
    private disposed = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
    ) {}

    async setup(): Promise<void> {
        const engineRoot = this.engineRoot();
        if (!engineRoot) {
            throw new Error('Bundled Slate Python engine was not found. Rebuild the extension.');
        }
        await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
        const venv = path.join(this.context.globalStorageUri.fsPath, 'python-engine-venv');
        const configured = vscode.workspace.getConfiguration('slate.pythonEngine');
        const bootstrapPython = configured.get<string>('bootstrapPython', 'python3');
        if (!fs.existsSync(venvPython(venv))) {
            await run(bootstrapPython, ['-m', 'venv', venv], this.output);
        }
        await run(
            venvPython(venv),
            ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', engineRoot],
            this.output,
        );
        await configured.update(
            'pythonPath',
            venvPython(venv),
            vscode.ConfigurationTarget.Global,
        );
        await this.stop();
        await this.health();
    }

    async health(): Promise<{ status: string; protocolVersion: number }> {
        return this.request('health', {});
    }

    async parseModule(source: string, documentPath: string): Promise<ParseModuleResult> {
        return this.request('parseModule', { source, path: documentPath }, 30_000);
    }

    async adoptUnit(params: Record<string, unknown>): Promise<SourceProposal> {
        return this.request('adoptUnit', params, 30_000);
    }

    async updateAnnotation(params: Record<string, unknown>): Promise<SourceProposal> {
        return this.request('updateAnnotation', params, 30_000);
    }

    async insertStub(params: Record<string, unknown>): Promise<SourceProposal> {
        return this.request('insertStub', params, 30_000);
    }

    async moveUnit(params: Record<string, unknown>): Promise<{
        unitId: string;
        source: SourceProposal;
        target: SourceProposal;
    }> {
        return this.request('moveUnit', params, 30_000);
    }

    private engineRoot(): string | undefined {
        const candidates = [
            path.join(this.context.extensionPath, 'python-engine'),
            path.resolve(this.context.extensionPath, '..', 'python-engine'),
        ];
        return candidates.find(candidate => fs.existsSync(path.join(candidate, 'pyproject.toml')));
    }

    private engineSource(): string {
        const root = this.engineRoot();
        if (!root) throw new Error('Slate Python engine source is missing.');
        return path.join(root, 'src');
    }

    private pythonPath(): string {
        const configured = vscode.workspace
            .getConfiguration('slate.pythonEngine')
            .get<string>('pythonPath', '')
            .trim();
        if (configured) return configured;

        const candidates = [
            venvPython(path.join(this.context.globalStorageUri.fsPath, 'python-engine-venv')),
            ...((vscode.workspace.workspaceFolders ?? []).map(folder =>
                venvPython(path.join(folder.uri.fsPath, '.venv'))
            )),
            venvPython(path.resolve(this.context.extensionPath, '..', '.venv')),
        ];
        return candidates.find(fs.existsSync) ?? 'python3';
    }

    private start(): void {
        if (this.disposed) throw new Error('Slate Python worker is disposed.');
        if (this.child) return;

        const python = this.pythonPath();
        const engineSource = this.engineSource();
        const separator = process.platform === 'win32' ? ';' : ':';
        const pythonPath = [engineSource, process.env.PYTHONPATH].filter(Boolean).join(separator);
        this.output.appendLine(`Starting Slate Python worker with ${python}`);
        const child = spawn(python, ['-m', 'slate_engine.worker'], {
            env: { ...process.env, PYTHONPATH: pythonPath },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child = child;
        this.stdoutBuffer = '';
        child.stdout.on('data', chunk => this.handleStdout(chunk.toString()));
        child.stderr.on('data', chunk => this.output.append(chunk.toString()));
        child.once('error', error => this.handleExit(error));
        child.once('exit', (code, signal) => {
            this.handleExit(new Error(`Slate Python worker exited (${code ?? signal ?? 'unknown'}).`));
        });
    }

    private handleStdout(chunk: string): void {
        this.stdoutBuffer += chunk;
        let newline = this.stdoutBuffer.indexOf('\n');
        while (newline >= 0) {
            const line = this.stdoutBuffer.slice(0, newline).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            if (line) this.handleResponseLine(line);
            newline = this.stdoutBuffer.indexOf('\n');
        }
    }

    private handleResponseLine(line: string): void {
        try {
            const response = parseWorkerResponse(JSON.parse(line));
            if (response.id === null) {
                this.output.appendLine(`Worker returned an uncorrelated response: ${line}`);
                return;
            }
            const pending = this.pending.get(response.id);
            if (!pending) {
                this.output.appendLine(`Worker returned unknown request id ${response.id}.`);
                return;
            }
            clearTimeout(pending.timeout);
            this.pending.delete(response.id);
            if (response.ok) pending.resolve(response.result);
            else pending.reject(new Error(`${response.error.code}: ${response.error.message}`));
        } catch (error) {
            this.output.appendLine(`Invalid worker response: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private handleExit(error: Error): void {
        if (!this.child) return;
        this.child = undefined;
        this.stdoutBuffer = '';
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
        if (!this.disposed) this.output.appendLine(error.message);
    }

    private request<T>(method: WorkerMethod, params: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
        this.start();
        const child = this.child;
        if (!child) return Promise.reject(new Error('Slate Python worker failed to start.'));
        const id = this.nextId++;
        const request: WorkerRequest = {
            id,
            protocolVersion: WORKER_PROTOCOL_VERSION,
            method,
            params,
        };
        return new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Slate Python worker timed out handling ${method}.`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: value => resolve(value as T),
                reject,
                timeout,
            });
            child.stdin.write(`${JSON.stringify(request)}\n`, error => {
                if (!error) return;
                clearTimeout(timeout);
                this.pending.delete(id);
                reject(error);
            });
        });
    }

    private async stop(): Promise<void> {
        const child = this.child;
        if (!child) return;
        try {
            await this.request('shutdown', {}, 2_000);
            // The response is flushed immediately before the worker exits.
            // Clear our handle now so a follow-up health request starts a new
            // process instead of writing to the shutting-down stdin.
            this.child = undefined;
        } catch {
            child.kill();
        }
    }

    dispose(): void {
        this.disposed = true;
        const child = this.child;
        this.child = undefined;
        if (child) child.kill();
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Slate Python worker disposed.'));
        }
        this.pending.clear();
    }
}
