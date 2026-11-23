import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';

export interface ElectronTestResult {
    status: 'passed' | 'failed';
    failures: number;
    error?: string;
}

export interface DestroyableStream {
    on(event: 'data', listener: (chunk: unknown) => void): unknown;
    removeListener?(event: 'data', listener: (chunk: unknown) => void): unknown;
    destroy?(): void;
}

export interface ElectronChildProcess extends EventEmitter {
    readonly pid?: number;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | string | null;
    readonly stdout: DestroyableStream | null;
    readonly stderr: DestroyableStream | null;
}

export type SpawnElectronProcess = (
    executablePath: string,
    args: readonly string[],
    options: cp.SpawnOptions,
) => ElectronChildProcess;

export type ReadElectronResultFile = (filePath: string) => ElectronTestResult | undefined;

export type TerminateElectronProcess = (child: ElectronChildProcess, force: boolean) => Promise<void> | void;

export interface BoundedElectronRunOptions {
    executablePath: string;
    args: readonly string[];
    resultFile: string;
    env?: Record<string, string | undefined>;
    graceMs?: number;
    pollIntervalMs?: number;
    overallTimeoutMs?: number;
    forceKillWaitMs?: number;
    stdout?: { write(chunk: string | Uint8Array): unknown };
    stderr?: { write(chunk: string | Uint8Array): unknown };
    warn?: (message: string) => void;
    spawnProcess?: SpawnElectronProcess;
    readResultFile?: ReadElectronResultFile;
    terminateProcess?: TerminateElectronProcess;
}

/** Validate and parse the JSON result file emitted by the Extension Host runner. */
export function parseElectronTestResult(raw: string): ElectronTestResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid Extension Host result JSON: ${message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Extension Host result payload must be a JSON object.');
    }
    const record = parsed as Record<string, unknown>;
    if (record.status !== 'passed' && record.status !== 'failed') {
        throw new Error('Extension Host result status must be "passed" or "failed".');
    }
    if (typeof record.failures !== 'number' || !Number.isInteger(record.failures) || record.failures < 0) {
        throw new Error('Extension Host result failures must be a non-negative integer.');
    }
    if (record.status === 'passed' && record.failures > 0) {
        throw new Error(`Inconsistent Extension Host result: status "passed" with ${record.failures} failure(s).`);
    }
    if (record.error !== undefined && typeof record.error !== 'string') {
        throw new Error('Extension Host result error field must be a string when present.');
    }
    return {
        status: record.status,
        failures: record.failures,
        ...(record.error !== undefined ? { error: record.error } : {}),
    };
}

function defaultReadResultFile(filePath: string): ElectronTestResult | undefined {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return parseElectronTestResult(raw);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT') return undefined;
        throw error;
    }
}

function defaultSpawnProcess(
    executablePath: string,
    args: readonly string[],
    options: cp.SpawnOptions,
): ElectronChildProcess {
    return cp.spawn(executablePath, [...args], options) as unknown as ElectronChildProcess;
}

async function defaultTerminateProcess(child: ElectronChildProcess, force: boolean): Promise<void> {
    const pid = child.pid;
    if (!pid || pid <= 0) return;

    if (process.platform === 'win32') {
        await new Promise<void>((resolve, reject) => {
            const killArgs = ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])];
            const killer = cp.spawn('taskkill', killArgs, { stdio: 'ignore' });
            killer.once('error', reject);
            killer.once('close', () => resolve());
        });
        return;
    }

    const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
    try {
        // Kill the detached process group so Electron/Xvfb helper processes cannot linger.
        process.kill(-pid, signal);
    } catch (groupError) {
        const groupCode = (groupError as NodeJS.ErrnoException | undefined)?.code;
        if (groupCode === 'ESRCH') {
            return;
        }
        try {
            process.kill(pid, signal);
        } catch (pidError) {
            const pidCode = (pidError as NodeJS.ErrnoException | undefined)?.code;
            if (pidCode !== 'ESRCH') {
                throw pidError;
            }
        }
    }
}

function normalizeChunk(chunk: unknown): string | Uint8Array {
    if (typeof chunk === 'string' || chunk instanceof Uint8Array) return chunk;
    return String(chunk);
}

/**
 * Run VS Code Extension Host tests with bounded post-result and overall shutdown.
 *
 * Linux Xvfb Electron processes can leave the main `code` process alive after the
 * Extension Host itself exits cleanly (`Extension host exited with code: 0`). Waiting on
 * an explicit atomic result file bounds that shutdown wait while remaining fail-closed
 * on missing/corrupt results, non-zero crashes, test failures, and stuck startups.
 */
export async function runBoundedElectronProcess(options: BoundedElectronRunOptions): Promise<number> {
    const {
        executablePath,
        args,
        resultFile,
        env,
        graceMs = 15_000,
        pollIntervalMs = 250,
        overallTimeoutMs = 600_000,
        forceKillWaitMs = 10_000,
        stdout = process.stdout,
        stderr = process.stderr,
        warn = console.warn,
        spawnProcess = defaultSpawnProcess,
        readResultFile = defaultReadResultFile,
        terminateProcess = defaultTerminateProcess,
    } = options;

    for (const [label, value] of [
        ['graceMs', graceMs],
        ['pollIntervalMs', pollIntervalMs],
        ['overallTimeoutMs', overallTimeoutMs],
        ['forceKillWaitMs', forceKillWaitMs],
    ] as const) {
        if (!Number.isFinite(value) || value <= 0) {
            throw new Error(`${label} must be a positive finite number`);
        }
    }

    const spawnEnv: Record<string, string | undefined> = {
        ...process.env,
        ...env,
        SLATE_TEST_RESULT_FILE: resultFile,
    };

    const child = spawnProcess(executablePath, args, {
        env: spawnEnv,
        detached: process.platform !== 'win32',
        shell: false,
    });

    const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null;

    return await new Promise<number>((resolve, reject) => {
        let settled = false;
        let observedResult: ElectronTestResult | undefined;
        let resultReadError: Error | undefined;
        let terminationError: Error | undefined;
        let forcedAfterResult = false;
        let timedOutOverall = false;
        let interruptedSignal: NodeJS.Signals | undefined;
        let terminating = false;

        let pollTimer: ReturnType<typeof setInterval> | undefined;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        let overallTimer: ReturnType<typeof setTimeout> | undefined;
        let forceTimer: ReturnType<typeof setTimeout> | undefined;

        const stopPolling = (): void => {
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = undefined;
            }
        };

        const clearOverallTimer = (): void => {
            if (overallTimer) {
                clearTimeout(overallTimer);
                overallTimer = undefined;
            }
        };

        const clearGraceTimer = (): void => {
            if (graceTimer) {
                clearTimeout(graceTimer);
                graceTimer = undefined;
            }
        };

        const clearForceTimer = (): void => {
            if (forceTimer) {
                clearTimeout(forceTimer);
                forceTimer = undefined;
            }
        };

        const onStdoutData = (chunk: unknown): void => {
            stdout.write(normalizeChunk(chunk));
        };
        const onStderrData = (chunk: unknown): void => {
            stderr.write(normalizeChunk(chunk));
        };

        const onSigint = (): void => {
            handleSignal('SIGINT');
        };
        const onSigterm = (): void => {
            handleSignal('SIGTERM');
        };

        const cleanup = (): void => {
            stopPolling();
            clearGraceTimer();
            clearOverallTimer();
            clearForceTimer();
            process.removeListener('SIGINT', onSigint);
            process.removeListener('SIGTERM', onSigterm);
            child.removeListener('exit', onProcessClosed);
            child.removeListener('close', onProcessClosed);
            child.removeListener('error', onProcessError);
            child.stdout?.removeListener?.('data', onStdoutData);
            child.stderr?.removeListener?.('data', onStderrData);
            child.stdout?.destroy?.();
            child.stderr?.destroy?.();
        };

        const failWith = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
        };

        const succeedWith = (code: number): void => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(code);
        };

        const finalizeExit = (code: number | null, signal: NodeJS.Signals | string | null): void => {
            if (settled) return;
            if (!observedResult && !resultReadError) {
                try {
                    const finalRead = readResultFile(resultFile);
                    if (finalRead) {
                        observedResult = finalRead;
                    }
                } catch (error) {
                    resultReadError = error instanceof Error ? error : new Error(String(error));
                }
            }

            if (terminationError) {
                failWith(terminationError);
                return;
            }
            if (timedOutOverall) {
                failWith(new Error(`VS Code test process timed out after ${overallTimeoutMs}ms without writing ${resultFile}`));
                return;
            }
            if (resultReadError) {
                failWith(resultReadError);
                return;
            }
            if (interruptedSignal) {
                failWith(new Error(`VS Code test run interrupted by ${interruptedSignal}`));
                return;
            }
            if (forcedAfterResult) {
                if (observedResult && observedResult.status === 'passed' && observedResult.failures === 0) {
                    succeedWith(0);
                    return;
                }
                const detail = observedResult?.error
                    ?? (observedResult ? `${observedResult.failures} Extension Host test(s) failed` : 'Extension Host tests failed');
                failWith(new Error(detail));
                return;
            }
            if (code !== 0) {
                const exitDetail = signal
                    ? `VS Code test process terminated with signal ${signal}`
                    : `VS Code test process exited with code ${String(code)}`;
                const suffix = observedResult && (observedResult.status !== 'passed' || observedResult.failures > 0)
                    ? ` (${observedResult.failures} Extension Host test(s) failed)`
                    : '';
                failWith(new Error(`${exitDetail}${suffix}`));
                return;
            }
            if (!observedResult) {
                failWith(new Error('VS Code exited with code 0 without writing an Extension Host test result'));
                return;
            }
            if (observedResult.status !== 'passed' || observedResult.failures !== 0) {
                failWith(new Error(observedResult.error ?? `${observedResult.failures} Extension Host test(s) failed`));
                return;
            }
            succeedWith(0);
        };

        const triggerForcedShutdown = async (reason: 'result' | 'timeout' | 'readError'): Promise<void> => {
            if (settled || terminating) return;
            terminating = true;
            stopPolling();
            clearOverallTimer();
            clearGraceTimer();

            if (hasExited()) {
                finalizeExit(child.exitCode, child.signalCode);
                return;
            }

            if (reason === 'timeout') {
                timedOutOverall = true;
                warn(`VS Code test process exceeded ${overallTimeoutMs}ms without reporting completion; forcing shutdown.`);
            } else if (reason === 'readError') {
                forcedAfterResult = true;
                warn('VS Code Extension Host result could not be read before shutdown timeout; forcing shutdown.');
            } else {
                forcedAfterResult = true;
                warn(`VS Code shutdown exceeded ${graceMs}ms after Extension Host finished; closing its owned test process.`);
            }

            forceTimer = setTimeout(() => {
                failWith(new Error('VS Code test process did not exit after forced shutdown'));
            }, forceKillWaitMs);

            try {
                await terminateProcess(child, true);
                if (!settled && hasExited()) {
                    finalizeExit(child.exitCode, child.signalCode);
                }
            } catch (error) {
                terminationError = error instanceof Error ? error : new Error(String(error));
                failWith(terminationError);
            }
        };

        const handleSignal = (signal: NodeJS.Signals): void => {
            if (settled) return;
            interruptedSignal = signal;
            stopPolling();
            clearGraceTimer();
            clearOverallTimer();
            void (async () => {
                try {
                    await terminateProcess(child, false);
                    if (!settled && hasExited()) {
                        finalizeExit(child.exitCode, child.signalCode);
                    }
                } catch (error) {
                    terminationError = error instanceof Error ? error : new Error(String(error));
                    failWith(terminationError);
                }
            })();
        };

        const inspectResultFile = (): void => {
            if (settled || observedResult || resultReadError) return;
            try {
                const parsed = readResultFile(resultFile);
                if (!parsed) return;
                observedResult = parsed;
                stopPolling();
                clearOverallTimer();
                if (!hasExited() && !graceTimer) {
                    graceTimer = setTimeout(() => {
                        graceTimer = undefined;
                        void triggerForcedShutdown('result');
                    }, graceMs);
                }
            } catch (error) {
                resultReadError = error instanceof Error ? error : new Error(String(error));
                stopPolling();
                clearOverallTimer();
                if (!hasExited() && !graceTimer) {
                    graceTimer = setTimeout(() => {
                        graceTimer = undefined;
                        void triggerForcedShutdown('readError');
                    }, graceMs);
                }
            }
        };

        const onProcessClosed = (code: number | null, signal: NodeJS.Signals | string | null): void => {
            finalizeExit(code, signal);
        };

        const onProcessError = (error: unknown): void => {
            failWith(error);
        };

        child.stdout?.on('data', onStdoutData);
        child.stderr?.on('data', onStderrData);
        child.on('exit', onProcessClosed);
        child.on('close', onProcessClosed);
        child.on('error', onProcessError);
        process.on('SIGINT', onSigint);
        process.on('SIGTERM', onSigterm);

        if (hasExited()) {
            finalizeExit(child.exitCode, child.signalCode);
            return;
        }

        pollTimer = setInterval(inspectResultFile, pollIntervalMs);
        overallTimer = setTimeout(() => {
            overallTimer = undefined;
            void triggerForcedShutdown('timeout');
        }, overallTimeoutMs);
    });
}
