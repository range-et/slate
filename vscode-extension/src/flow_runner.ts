import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { MAIN_FLOW, type CallableSignature } from './flow';
import type { SlateConfig, SlateNode } from './slate_folder';
import type { FlowExecutionSnapshot, InstanceRunObservation, ObservedValue, RunStatus, SlateFlow } from './harness_protocol';
import { compilePython, flowTarget } from './compile/python';
import { SLATE_RUN_PY } from './compile/slate_trace';
import { resolvePythonPath } from './verification_runner';

export interface FlowRunRequest {
    workspaceRoot: string;
    flowId: string;
    documents: Map<string, SlateNode>;
    flows: Map<string, SlateFlow>;
    config: SlateConfig;
    library?: Map<string, CallableSignature>;
    pythonPath?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    inputs?: Record<string, unknown>;
    isTrusted?: boolean;
    signal?: AbortSignal;
}

export function makeValueKey(invocationPath: string[], instanceId: string, portId: string): string {
    return `${invocationPath.join('/')}::${instanceId}::${portId}`;
}

export function parseValueKey(key: string): { invocationPath: string[]; instanceId: string; portId: string } {
    const parts = key.split('::');
    return {
        invocationPath: parts[0] ? parts[0].split('/') : [],
        instanceId: parts[1] || '',
        portId: parts[2] || '',
    };
}

export async function killProcessTree(pid: number): Promise<void> {
    if (process.platform === 'win32') {
        try {
            await new Promise<void>((resolve) => {
                const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
                killer.on('close', () => resolve());
                killer.on('error', () => resolve());
            });
        } catch {
            // Ignore kill errors
        }
    } else {
        try {
            process.kill(-pid, 'SIGKILL');
        } catch {
            try {
                process.kill(pid, 'SIGKILL');
            } catch {
                // Ignore kill errors
            }
        }
    }
}

interface RawTraceEvent {
    kind: 'input' | 'output' | 'error' | 'flow_output' | 'completed' | 'flow_error';
    path?: string[];
    instance?: string;
    port?: string;
    val?: ObservedValue;
    error?: string;
    time?: number;
}

export function parseTraceLog(
    traceContent: string,
    targetFlow: SlateFlow | undefined,
): { observations: InstanceRunObservation[]; valuesByUse: Record<string, ObservedValue>; runError?: string } {
    const lines = traceContent.split('\n').filter(line => line.trim().length > 0);
    const obsMap = new Map<string, InstanceRunObservation>();
    const valuesByUse: Record<string, ObservedValue> = {};
    let runError: string | undefined;

    const getOrCreateObs = (pathList: string[], instanceId: string): InstanceRunObservation => {
        const key = `${pathList.join('/')}::${instanceId}`;
        let obs = obsMap.get(key);
        if (!obs) {
            obs = {
                path: [...pathList],
                instanceId,
                status: 'not_executed',
                inputs: {},
                outputs: {},
            };
            obsMap.set(key, obs);
        }
        return obs;
    };

    for (const line of lines) {
        try {
            const event = JSON.parse(line) as RawTraceEvent;
            const eventPath = event.path ?? [];
            if (event.kind === 'input' && event.instance && event.port && event.val) {
                const obs = getOrCreateObs(eventPath, event.instance);
                obs.inputs[event.port] = event.val;
                valuesByUse[makeValueKey(eventPath, event.instance, event.port)] = event.val;
            } else if (event.kind === 'output' && event.instance && event.port && event.val) {
                const obs = getOrCreateObs(eventPath, event.instance);
                obs.outputs[event.port] = event.val;
                obs.status = 'executed';
                valuesByUse[makeValueKey(eventPath, event.instance, event.port)] = event.val;
            } else if (event.kind === 'error' && event.instance) {
                const obs = getOrCreateObs(eventPath, event.instance);
                obs.status = 'failed';
                obs.error = event.error;
            } else if (event.kind === 'flow_error') {
                runError = event.error;
            }
        } catch {
            // Ignore malformed trace line
        }
    }

    // Ensure all instances of the target flow are represented; if not observed, mark not_executed
    if (targetFlow) {
        for (const instance of targetFlow.instances) {
            const rootKey = `::${instance.id}`;
            if (!obsMap.has(rootKey)) {
                obsMap.set(rootKey, {
                    path: [],
                    instanceId: instance.id,
                    status: 'not_executed',
                    inputs: {},
                    outputs: {},
                });
            }
        }
    }

    return {
        observations: Array.from(obsMap.values()),
        valuesByUse,
        runError,
    };
}

export async function runFlow(request: FlowRunRequest): Promise<FlowExecutionSnapshot> {
    const startTime = Date.now();
    const flowId = request.flowId;

    if (request.isTrusted === false) {
        return {
            runId: '',
            flowId,
            status: 'failed',
            durationMs: 0,
            exitCode: null,
            error: 'Workspace is not trusted; code execution is disabled in untrusted workspaces.',
            observations: [],
            valuesByUse: {},
        };
    }

    const targetFlow = flowId === MAIN_FLOW || flowId === 'main'
        ? request.flows.get(MAIN_FLOW) || request.flows.get('main')
        : request.flows.get(flowId) || request.flows.get(flowId.startsWith('flows/') ? flowId.slice('flows/'.length) : flowId);

    if (!targetFlow) {
        return {
            runId: '',
            flowId,
            status: 'failed',
            durationMs: 0,
            exitCode: null,
            error: `Flow "${flowId}" not found in project.`,
            observations: [],
            valuesByUse: {},
        };
    }

    if (targetFlow.instances.length === 0) {
        return {
            runId: '',
            flowId,
            status: 'completed',
            durationMs: 0,
            exitCode: 0,
            stdout: '',
            stderr: '',
            observations: [],
            valuesByUse: {},
        };
    }

    // 1. Compile graph with trace mode enabled
    const compileRes = compilePython(request.documents, request.config, request.flows, request.library ?? new Map(), { trace: true });
    const compileErrors = compileRes.diagnostics.filter(d => d.severity === 'error');
    if (compileErrors.length > 0) {
        return {
            runId: '',
            flowId,
            status: 'failed',
            durationMs: Date.now() - startTime,
            exitCode: null,
            error: `Refusing execution: graph has compile errors:\n${compileErrors.map(e => e.message).join('\n')}`,
            observations: [],
            valuesByUse: {},
        };
    }

    // 2. Prepare immutable build directory under .slate/build/<runId>/
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const buildDir = path.join(request.workspaceRoot, '.slate', 'build', runId);
    try {
        fs.mkdirSync(buildDir, { recursive: true });
    } catch (err) {
        return {
            runId,
            flowId,
            status: 'failed',
            durationMs: Date.now() - startTime,
            exitCode: null,
            error: `Failed to create build directory: ${err instanceof Error ? err.message : String(err)}`,
            observations: [],
            valuesByUse: {},
        };
    }

    // Write compiled Python files
    for (const [relPath, content] of compileRes.files) {
        const fullPath = path.join(buildDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf-8');
    }

    // Write _slate_run.py entrypoint
    fs.writeFileSync(path.join(buildDir, '_slate_run.py'), SLATE_RUN_PY, 'utf-8');

    // Write inputs file if provided
    let inputsFilePath: string | undefined;
    if (request.inputs && Object.keys(request.inputs).length > 0) {
        inputsFilePath = path.join(buildDir, '_slate_inputs.json');
        fs.writeFileSync(inputsFilePath, JSON.stringify(request.inputs), 'utf-8');
    }

    const traceFilePath = path.join(buildDir, 'trace.jsonl');
    const target = flowTarget(flowId, request.config.name);
    const pythonBin = resolvePythonPath(request.pythonPath);
    const timeoutMs = request.timeoutMs ?? 15000;
    const maxOutputBytes = request.maxOutputBytes ?? 1024 * 1024;

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        SLATE_TARGET_MODULE: target.module,
        SLATE_TARGET_FUNCTION: target.functionName,
        SLATE_TRACE_FILE: traceFilePath,
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1',
    };
    if (inputsFilePath) {
        env.SLATE_INPUTS_FILE = inputsFilePath;
    }

    let child: ChildProcess | undefined;
    let timedOut = false;
    let stopped = false;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const runPromise = new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        try {
            child = spawn(pythonBin, ['_slate_run.py'], {
                cwd: buildDir,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (err) {
            return reject(err);
        }

        let stdoutBuf = '';
        let stderrBuf = '';

        child.stdout?.on('data', (chunk: Buffer) => {
            if (stdoutBuf.length < maxOutputBytes) {
                stdoutBuf += chunk.toString('utf-8');
                if (stdoutBuf.length >= maxOutputBytes) {
                    stdoutBuf += '\n[Output truncated at limit]';
                }
            }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
            if (stderrBuf.length < maxOutputBytes) {
                stderrBuf += chunk.toString('utf-8');
                if (stderrBuf.length >= maxOutputBytes) {
                    stderrBuf += '\n[Output truncated at limit]';
                }
            }
        });

        child.on('error', (err) => {
            reject(err);
        });

        child.on('close', (code) => {
            resolve({ exitCode: code, stdout: stdoutBuf, stderr: stderrBuf });
        });

        if (timeoutMs > 0) {
            timeoutTimer = setTimeout(() => {
                timedOut = true;
                if (child && child.pid) {
                    void killProcessTree(child.pid);
                }
            }, timeoutMs);
        }

        if (request.signal) {
            if (request.signal.aborted) {
                stopped = true;
                if (child && child.pid) {
                    void killProcessTree(child.pid);
                }
            } else {
                request.signal.addEventListener('abort', () => {
                    stopped = true;
                    if (child && child.pid) {
                        void killProcessTree(child.pid);
                    }
                }, { once: true });
            }
        }
    });

    try {
        const { exitCode, stdout, stderr } = await runPromise;
        if (timeoutTimer) clearTimeout(timeoutTimer);

        let traceContent = '';
        if (fs.existsSync(traceFilePath)) {
            traceContent = fs.readFileSync(traceFilePath, 'utf-8');
        }

        const { observations, valuesByUse, runError } = parseTraceLog(traceContent, targetFlow);
        const durationMs = Date.now() - startTime;

        let status: RunStatus = 'completed';
        let errorMsg: string | undefined;

        if (stopped) {
            status = 'stopped';
            errorMsg = 'Execution was stopped.';
        } else if (timedOut) {
            status = 'timeout';
            errorMsg = `Execution timed out after ${timeoutMs}ms.`;
        } else if (exitCode !== 0 || runError) {
            status = 'failed';
            errorMsg = runError || (stderr.trim().length > 0 ? stderr.trim() : `Process exited with code ${exitCode}.`);
        }

        return {
            runId,
            flowId,
            status,
            durationMs,
            exitCode,
            stdout,
            stderr,
            error: errorMsg,
            observations,
            valuesByUse,
        };
    } catch (err) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const durationMs = Date.now() - startTime;
        return {
            runId,
            flowId,
            status: 'failed',
            durationMs,
            exitCode: null,
            error: `Failed to execute flow: ${err instanceof Error ? err.message : String(err)}`,
            observations: [],
            valuesByUse: {},
        };
    }
}
