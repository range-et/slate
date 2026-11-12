import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { NodeVerificationResult, VerificationState } from './harness_protocol';
import type { SlateNode } from './slate_folder';
import { codeText } from './slate_folder';
import { sourceHash } from './python_adapter';

export interface GeneratedVerification {
    moduleContent: string;
    testContent: string;
    hasChecks: boolean;
}

/** Resolves the Python binary to use, checking explicit config, environment variables, and platform paths. */
export function resolvePythonPath(configuredPath?: string): string {
    if (configuredPath && configuredPath.trim().length > 0) {
        return configuredPath.trim();
    }
    if (process.env.PYTHON_BIN && process.env.PYTHON_BIN.trim().length > 0) {
        return process.env.PYTHON_BIN.trim();
    }
    if (process.env.PYTHON && process.env.PYTHON.trim().length > 0) {
        return process.env.PYTHON.trim();
    }
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || '';
        const standardBase = path.join(localAppData, 'Programs', 'Python');
        if (fs.existsSync(standardBase)) {
            try {
                const entries = fs.readdirSync(standardBase);
                for (const entry of entries) {
                    const candidate = path.join(standardBase, entry, 'python.exe');
                    if (fs.existsSync(candidate)) {
                        return candidate;
                    }
                }
            } catch {
                // Ignore readdir error
            }
        }
        for (const fixed of ['C:\\Python312\\python.exe', 'C:\\Python311\\python.exe', 'C:\\Python310\\python.exe']) {
            if (fs.existsSync(fixed)) {
                return fixed;
            }
        }
    }
    return 'python3';
}

/** Formats structured cases into executable pytest test assertions. */
export function formatCasesAsPython(nodeName: string, cases: unknown[]): string[] {
    const lines: string[] = [];
    lines.push(`def test_structured_cases_${nodeName}():`);
    if (cases.length === 0) {
        lines.push('    pass');
        return lines;
    }

    cases.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
            const str = String(item).trim();
            if (str.startsWith('assert ')) {
                lines.push(`    # Case ${index + 1}`);
                lines.push(`    ${str}`);
            } else if (str.length > 0) {
                lines.push(`    # Case ${index + 1}`);
                lines.push(`    assert ${str}`);
            }
            return;
        }

        const obj = item as Record<string, unknown>;
        lines.push(`    # Case ${index + 1}`);
        if (typeof obj.code === 'string') {
            lines.push(`    ${obj.code.trim()}`);
            return;
        }

        const expected = obj.expected ?? obj.return ?? obj.output;
        const inputs = obj.inputs ?? obj.args ?? obj.params;

        if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
            const kwargs = Object.entries(inputs)
                .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                .join(', ');
            if (expected !== undefined) {
                lines.push(`    assert ${nodeName}(${kwargs}) == ${JSON.stringify(expected)}`);
            } else {
                lines.push(`    ${nodeName}(${kwargs})`);
            }
        } else if (Array.isArray(inputs)) {
            const args = inputs.map(v => JSON.stringify(v)).join(', ');
            if (expected !== undefined) {
                lines.push(`    assert ${nodeName}(${args}) == ${JSON.stringify(expected)}`);
            } else {
                lines.push(`    ${nodeName}(${args})`);
            }
        } else {
            // Check if object keys themselves are parameter names
            const keys = Object.keys(obj).filter(k => k !== 'expected' && k !== 'return' && k !== 'output');
            if (keys.length > 0) {
                const kwargs = keys.map(k => `${k}=${JSON.stringify(obj[k])}`).join(', ');
                if (expected !== undefined) {
                    lines.push(`    assert ${nodeName}(${kwargs}) == ${JSON.stringify(expected)}`);
                } else {
                    lines.push(`    ${nodeName}(${kwargs})`);
                }
            } else {
                lines.push(`    # Untyped case: ${JSON.stringify(obj)}`);
            }
        }
    });

    return lines;
}

/** Generates python module and pytest test code for scoped per-node verification. */
export function generateVerificationFiles(
    node: SlateNode,
    dependencies?: Map<string, SlateNode>,
): GeneratedVerification {
    const hasCases = Array.isArray(node.cases) && node.cases.length > 0;
    const hasCheck = Array.isArray(node.check) && node.check.length > 0;
    const hasChecks = hasCases || hasCheck;

    if (!hasChecks) {
        return { moduleContent: '', testContent: '', hasChecks: false };
    }

    const moduleParts: string[] = [
        '# Auto-generated verification module for Slate atomic node',
        'from __future__ import annotations',
        'import sys',
        'import typing',
    ];

    if (node.imports.length > 0) {
        moduleParts.push(...node.imports);
    }

    // Include dependency node code so target can reference helpers
    if (dependencies && dependencies.size > 0) {
        moduleParts.push('# Dependent context nodes');
        for (const [depId, depNode] of dependencies.entries()) {
            if (depId !== node.name && depNode.code.length > 0) {
                moduleParts.push(`\n# Context: ${depNode.name}`);
                moduleParts.push(...depNode.code);
            }
        }
    }

    moduleParts.push(`\n# Target implementation: ${node.name}`);
    moduleParts.push(...node.code);

    // Pydantic parameter & return contract validation wrapper
    moduleParts.push(`
# Pydantic contract validation (S-513)
try:
    from pydantic import validate_call
    ${node.name} = validate_call(validate_return=True)(${node.name})
except Exception:
    pass
`);

    const testParts: string[] = [
        '# Auto-generated pytest check file for Slate atomic node',
        'import pytest',
        `from ${node.name}_impl import ${node.name}`,
    ];

    if (hasCheck && node.check) {
        testParts.push('\n# Target unit check');
        testParts.push(...node.check);
    }

    if (hasCases && node.cases) {
        testParts.push('\n# Structured cases');
        testParts.push(...formatCasesAsPython(node.name, node.cases));
    }

    return {
        moduleContent: moduleParts.join('\n') + '\n',
        testContent: testParts.join('\n') + '\n',
        hasChecks: true,
    };
}

export interface VerificationOptions {
    workspaceRoot: string;
    node: SlateNode;
    nodeId: string;
    dependencies?: Map<string, SlateNode>;
    isTrusted: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    pythonPath?: string;
    executeCommand?: (cmd: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>;
}

function defaultExecute(
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }> {
    return new Promise(resolve => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;

        if (signal?.aborted) {
            resolve({ code: -1, stdout: '', stderr: 'Verification cancelled', timedOut: false });
            return;
        }

        const proc = child_process.spawn(cmd, args, { cwd, shell: process.platform === 'win32' });

        const timer = setTimeout(() => {
            timedOut = true;
            try {
                proc.kill();
            } catch {}
        }, timeoutMs);

        const onAbort = () => {
            try {
                proc.kill();
            } catch {}
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        proc.stdout?.on('data', d => { stdout += d.toString(); });
        proc.stderr?.on('data', d => { stderr += d.toString(); });

        proc.on('close', code => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve({ code: code ?? (timedOut ? -1 : 0), stdout, stderr, timedOut });
        });

        proc.on('error', err => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
        });
    });
}

function parsePytestSummary(output: string): { passed: number; total: number; failed: number } {
    const passedMatch = output.match(/(\d+)\s+passed/);
    const failedMatch = output.match(/(\d+)\s+failed/);
    const errorMatch = output.match(/(\d+)\s+error/);

    const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
    const failed = (failedMatch ? parseInt(failedMatch[1], 10) : 0) + (errorMatch ? parseInt(errorMatch[1], 10) : 0);
    const total = passed + failed;

    return { passed, total: total || (passed > 0 ? passed : 0), failed };
}

function extractTraceback(stdout: string, stderr: string): string {
    const text = `${stdout}\n${stderr}`;
    const failureSection = text.indexOf('FAILURES');
    if (failureSection !== -1) {
        return text.slice(failureSection).trim();
    }
    const errorSection = text.indexOf('ERRORS');
    if (errorSection !== -1) {
        return text.slice(errorSection).trim();
    }
    const tbIndex = text.indexOf('Traceback (most recent call last):');
    if (tbIndex !== -1) {
        return text.slice(tbIndex).trim();
    }
    return text.trim();
}

/** Runs scoped verification (Pydantic contract + pytest + mutmut) for an atomic node in .slate/build/. */
export async function runNodeVerification(options: VerificationOptions): Promise<NodeVerificationResult> {
    const {
        workspaceRoot,
        node,
        nodeId,
        dependencies,
        isTrusted,
        timeoutMs = 15000,
        pythonPath: rawPythonPath,
        executeCommand = defaultExecute,
        signal,
    } = options;

    const currentHash = sourceHash(codeText(node));

    if (signal?.aborted) {
        return {
            nodeId,
            state: 'failed',
            timestamp: Date.now(),
            sourceHash: currentHash,
            diagnostics: ['Verification was cancelled.'],
        };
    }

    if (!isTrusted) {
        return {
            nodeId,
            state: 'failed',
            timestamp: Date.now(),
            sourceHash: currentHash,
            diagnostics: ['Workspace is not trusted. Cannot execute verification.'],
        };
    }

    const { moduleContent, testContent, hasChecks } = generateVerificationFiles(node, dependencies);

    if (!hasChecks) {
        return {
            nodeId,
            state: 'untested',
            timestamp: Date.now(),
            sourceHash: currentHash,
            diagnostics: ['Node has no check or cases; status is untested.'],
        };
    }

    const pythonPath = resolvePythonPath(rawPythonPath);
    const buildDir = path.join(workspaceRoot, '.slate', 'build', 'verify', nodeId);
    await fs.promises.mkdir(buildDir, { recursive: true });

    const moduleFile = path.join(buildDir, `${node.name}_impl.py`);
    const testFile = path.join(buildDir, `test_${node.name}.py`);

    await fs.promises.writeFile(moduleFile, moduleContent, 'utf8');
    await fs.promises.writeFile(testFile, testContent, 'utf8');

    // 1. Run pytest
    const pytestRes = await executeCommand(pythonPath, ['-m', 'pytest', `test_${node.name}.py`, '-v'], buildDir, timeoutMs, signal);

    if (signal?.aborted) {
        return {
            nodeId,
            state: 'failed',
            timestamp: Date.now(),
            sourceHash: currentHash,
            diagnostics: ['Verification was cancelled.'],
        };
    }

    if (pytestRes.timedOut) {
        return {
            nodeId,
            state: 'failed',
            timestamp: Date.now(),
            sourceHash: currentHash,
            diagnostics: [`Verification timed out after ${timeoutMs}ms`],
        };
    }

    const combinedOutput = `${pytestRes.stdout}\n${pytestRes.stderr}`;
    const { passed, total, failed } = parsePytestSummary(combinedOutput);
    const pydanticValid = !combinedOutput.includes('ValidationError') && !combinedOutput.includes('pydantic_core._pydantic_core.ValidationError');

    if (pytestRes.code !== 0 || failed > 0 || !pydanticValid) {
        return {
            nodeId,
            state: 'failed',
            timestamp: Date.now(),
            sourceHash: currentHash,
            pydanticValid,
            testsPassed: passed,
            testsTotal: total,
            traceback: extractTraceback(pytestRes.stdout, pytestRes.stderr),
            diagnostics: [
                !pydanticValid ? 'Pydantic contract/type validation failed' : 'Pytest check failed',
            ],
        };
    }

    // 2. Pytest passed -> run scoped mutmut mutation testing if available
    const mutmutCheck = await executeCommand(pythonPath, ['-m', 'mutmut', '--version'], buildDir, 5000, signal);
    const mutmutOutCheck = `${mutmutCheck.stdout} ${mutmutCheck.stderr}`;
    const mutmutAvailable = mutmutCheck.code === 0 && !mutmutOutCheck.includes('WSL');

    if (!mutmutAvailable) {
        const reason = mutmutOutCheck.includes('WSL')
            ? 'mutmut requires Linux/WSL environment'
            : 'mutmut not found in environment';
        return {
            nodeId,
            state: 'passed',
            timestamp: Date.now(),
            sourceHash: currentHash,
            pydanticValid: true,
            testsPassed: passed,
            testsTotal: total,
            diagnostics: [`Pytest passed; mutmut mutation testing skipped (${reason}).`],
        };
    }

    // Run mutmut against target module
    const mutmutRun = await executeCommand(
        pythonPath,
        ['-m', 'mutmut', 'run', '--paths-to-mutate', `${node.name}_impl.py`, '--tests-dir', '.'],
        buildDir,
        timeoutMs,
        signal,
    );

    if (signal?.aborted) {
        return {
            nodeId,
            state: 'failed',
            timestamp: Date.now(),
            sourceHash: currentHash,
            diagnostics: ['Verification was cancelled.'],
        };
    }

    const mutmutOut = `${mutmutRun.stdout}\n${mutmutRun.stderr}`;
    const survivingMatch = mutmutOut.match(/(\d+)\s+survived/i) || mutmutOut.match(/survived\s*:\s*(\d+)/i);
    const killedMatch = mutmutOut.match(/(\d+)\s+killed/i) || mutmutOut.match(/killed\s*:\s*(\d+)/i);

    const surviving = survivingMatch ? parseInt(survivingMatch[1], 10) : 0;
    const killed = killedMatch ? parseInt(killedMatch[1], 10) : 0;
    const totalMutants = surviving + killed;

    if (surviving > 0) {
        // Retrieve mutant diff
        const showRes = await executeCommand(pythonPath, ['-m', 'mutmut', 'show', '1'], buildDir, 5000);
        return {
            nodeId,
            state: 'mutant_survived',
            timestamp: Date.now(),
            sourceHash: currentHash,
            pydanticValid: true,
            testsPassed: passed,
            testsTotal: total,
            survivingMutants: surviving,
            totalMutants,
            mutantDiff: showRes.stdout.trim() || 'Mutant survived test suite without triggering failure.',
            diagnostics: [`${surviving} surviving mutant(s) detected by mutmut; test suite lacks mutant detection power.`],
        };
    }

    return {
        nodeId,
        state: 'passed',
        timestamp: Date.now(),
        sourceHash: currentHash,
        pydanticValid: true,
        testsPassed: passed,
        testsTotal: total,
        survivingMutants: 0,
        totalMutants: totalMutants > 0 ? totalMutants : undefined,
    };
}

/** Determines if an existing verification result is stale against current node contents. */
export function isVerificationStale(
    verification: NodeVerificationResult | undefined,
    node: SlateNode,
): boolean {
    if (!verification) return false;
    const currentHash = sourceHash(codeText(node));
    return verification.sourceHash !== currentHash;
}

export interface RevisionAttempt {
    attempt: number;
    candidateCode?: string;
    candidateCheck?: string;
    result: NodeVerificationResult;
    feedback?: string;
}

export interface RevisionLoopResult {
    nodeId: string;
    success: boolean;
    attempts: RevisionAttempt[];
    finalResult: NodeVerificationResult;
    lastCandidate?: { implementation: string; check?: string };
}

export interface RevisionLoopOptions {
    nodeId: string;
    node: SlateNode;
    maxRevisions?: number;
    forgeCandidate: (feedback: string) => Promise<{ implementation: string; check?: string } | null>;
    verifyCandidate: (candidateNode: SlateNode) => Promise<NodeVerificationResult>;
}

/** Executes bounded local retry loop (up to 3 revisions) feeding failure feedback to llama.cpp forge. */
export async function runRevisionLoop(options: RevisionLoopOptions): Promise<RevisionLoopResult> {
    const { nodeId, node, maxRevisions = 3, forgeCandidate, verifyCandidate } = options;
    const attempts: RevisionAttempt[] = [];

    // Attempt 0: verify current node
    let currentResult = await verifyCandidate(node);
    attempts.push({
        attempt: 0,
        result: currentResult,
    });

    if (currentResult.state === 'passed') {
        return {
            nodeId,
            success: true,
            attempts,
            finalResult: currentResult,
        };
    }

    let lastCandidate: { implementation: string; check?: string } | undefined;

    for (let revision = 1; revision <= maxRevisions; revision++) {
        let feedbackDetail = currentResult.state === 'mutant_survived' && currentResult.mutantDiff
            ? currentResult.mutantDiff
            : currentResult.traceback || currentResult.diagnostics?.join('\n') || 'Verification failed.';

        // Bounded retry feedback: truncate to fit comfortably within the 600-token micro-packet budget
        if (feedbackDetail.length > 300) {
            feedbackDetail = feedbackDetail.slice(-300);
        }

        const feedback = currentResult.state === 'mutant_survived'
            ? `Mutmut detected surviving mutant:\n${feedbackDetail}`
            : `Validation failed:\n${feedbackDetail}`;

        const forged = await forgeCandidate(feedback);
        if (!forged) break;

        lastCandidate = forged;
        const candidateNode: SlateNode = {
            ...node,
            code: forged.implementation.replace(/\r\n?/g, '\n').split('\n'),
            check: forged.check ? forged.check.replace(/\r\n?/g, '\n').split('\n') : node.check,
        };

        currentResult = await verifyCandidate(candidateNode);
        currentResult.retryCount = revision;

        attempts.push({
            attempt: revision,
            candidateCode: forged.implementation,
            candidateCheck: forged.check,
            result: currentResult,
            feedback,
        });

        if (currentResult.state === 'passed') {
            return {
                nodeId,
                success: true,
                attempts,
                finalResult: currentResult,
                lastCandidate,
            };
        }
    }

    return {
        nodeId,
        success: false,
        attempts,
        finalResult: currentResult,
        lastCandidate,
    };
}
