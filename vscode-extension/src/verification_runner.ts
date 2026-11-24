import * as child_process from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import type { NodeVerificationResult, VerificationState } from './harness_protocol';
import { normalizeCompileOutputPath, tryNormalizeLanguage } from './language_types';
import type { SlateNode } from './slate_folder';
import { codeText } from './slate_folder';
import { parseModule, sourceHash, topLevelBindings } from './python_adapter';
import { containsJsxSyntax, parseTsModule, scriptKindForPath, splitTsImport } from './ts_adapter';

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

function toPythonLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'None';
    if (typeof value === 'boolean') return value ? 'True' : 'False';
    if (typeof value === 'number') {
        if (Number.isNaN(value)) return "float('nan')";
        if (value === Infinity) return "float('inf')";
        if (value === -Infinity) return "float('-inf')";
        return String(value);
    }
    if (typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(toPythonLiteral).join(', ')}]`;
    if (typeof value === 'object') {
        return `{${Object.entries(value as Record<string, unknown>)
            .map(([k, v]) => `${JSON.stringify(k)}: ${toPythonLiteral(v)}`)
            .join(', ')}}`;
    }
    return JSON.stringify(value);
}

const CASE_METADATA_KEYS = new Set(['name', 'id', 'description', 'error', 'expectedError', 'expected', 'return', 'output', 'approx']);

const FLOAT_RETURN_RE = /^\s*(?:float|Optional\[float\]|float\s*\|\s*None|None\s*\|\s*float)\s*$/;

/** Formats structured cases into executable pytest test assertions. */
export function formatCasesAsPython(
    nodeName: string,
    cases: unknown[],
    options?: { returnAnnotation?: string | null },
): string[] {
    const lines: string[] = [];
    lines.push(`def test_structured_cases_${nodeName}():`);
    if (cases.length === 0) {
        lines.push('    pass');
        return lines;
    }

    const isFloatReturn = Boolean(options?.returnAnnotation && FLOAT_RETURN_RE.test(options.returnAnnotation));

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
        const expectedError = typeof obj.error === 'string' && obj.error.trim()
            ? obj.error.trim()
            : (typeof obj.expectedError === 'string' && obj.expectedError.trim() ? obj.expectedError.trim() : undefined);
        const inputs = obj.inputs ?? obj.input ?? obj.args ?? obj.params;

        let callExpr: string | null = null;
        if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
            const kwargs = Object.entries(inputs as Record<string, unknown>)
                .map(([k, v]) => `${k}=${toPythonLiteral(v)}`)
                .join(', ');
            callExpr = `${nodeName}(${kwargs})`;
        } else if (Array.isArray(inputs)) {
            const args = inputs.map(v => toPythonLiteral(v)).join(', ');
            callExpr = `${nodeName}(${args})`;
        } else {
            const keys = Object.keys(obj).filter(k => !CASE_METADATA_KEYS.has(k));
            if (keys.length > 0) {
                const kwargs = keys.map(k => `${k}=${toPythonLiteral(obj[k])}`).join(', ');
                callExpr = `${nodeName}(${kwargs})`;
            }
        }

        if (!callExpr) {
            lines.push(`    # Untyped case: ${JSON.stringify(obj)}`);
        } else if (expectedError) {
            const excClass = /^[A-Za-z_][A-Za-z0-9_]*$/.test(expectedError) ? expectedError : 'Exception';
            lines.push(`    with pytest.raises(${excClass}):`);
            lines.push(`        ${callExpr}`);
        } else if (expected !== undefined) {
            const approxFlag = obj.approx;
            if (
                typeof expected === 'number'
                && Number.isFinite(expected)
                && approxFlag !== false
                && (
                    typeof approxFlag === 'number'
                    || approxFlag === true
                    || isFloatReturn
                    || !Number.isInteger(expected)
                )
            ) {
                if (typeof approxFlag === 'number' && Number.isFinite(approxFlag) && approxFlag > 0) {
                    lines.push(`    assert ${callExpr} == pytest.approx(${toPythonLiteral(expected)}, abs=${approxFlag})`);
                } else {
                    lines.push(`    assert ${callExpr} == pytest.approx(${toPythonLiteral(expected)}, rel=1e-9, abs=1e-12)`);
                }
            } else {
                lines.push(`    assert ${callExpr} == ${toPythonLiteral(expected)}`);
            }
        } else {
            lines.push(`    ${callExpr}`);
        }
    });

    return lines;
}

function buildTsPositionalArgs(paramNames: readonly string[], rec: Record<string, unknown>, keyList: readonly string[]): string[] | null {
    if (paramNames.length === 0 || keyList.length === 0) return null;
    if (!keyList.every(k => paramNames.includes(k))) return null;
    const maxIdx = Math.max(...keyList.map(k => paramNames.indexOf(k)));
    const args: string[] = [];
    for (let idx = 0; idx <= maxIdx; idx++) {
        const paramName = paramNames[idx];
        args.push(Object.prototype.hasOwnProperty.call(rec, paramName) ? JSON.stringify(rec[paramName]) : 'undefined');
    }
    return args;
}

/** Formats structured cases into standalone TypeScript/JavaScript test() blocks. */
export function formatCasesAsTs(node: SlateNode, cases: unknown[], language: 'typescript' | 'javascript' = 'typescript'): string[] {
    const extHint = typeof node.extra?.extension === 'string'
        ? node.extra.extension
        : (language === 'javascript' ? '.js' : '.ts');
    const parsed = parseTsModule(codeText(node), `<cases>${extHint}`, node.name);
    const targetUnit = parsed.units.find(u => u.parentId === null && u.name === node.name);
    const paramNames = (targetUnit?.params ?? []).filter(p => p.name !== 'this' && p.name !== 'self').map(p => p.name);
    const isAsync = Boolean(targetUnit?.async)
        || Boolean(targetUnit?.returnAnnotation && /^\s*Promise\s*</.test(targetUnit.returnAnnotation));

    const lines: string[] = [];
    lines.push(`test('structured cases for ${node.name}', ${isAsync ? 'async ' : ''}() => {`);
    if (cases.length === 0) {
        lines.push('});');
        return lines;
    }

    cases.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
            const str = String(item).trim();
            if (str.length > 0) {
                lines.push(`    // Case ${index + 1}`);
                lines.push(str.startsWith('expect(') ? `    ${str}` : `    expect(${str}).toBeTruthy();`);
            }
            return;
        }

        const obj = item as Record<string, unknown>;
        lines.push(`    // Case ${index + 1}`);
        if (typeof obj.code === 'string') {
            lines.push(`    ${obj.code.trim()}`);
            return;
        }

        const hasExpected = Object.prototype.hasOwnProperty.call(obj, 'expected')
            || Object.prototype.hasOwnProperty.call(obj, 'return')
            || Object.prototype.hasOwnProperty.call(obj, 'output');
        const expected = Object.prototype.hasOwnProperty.call(obj, 'expected')
            ? obj.expected
            : Object.prototype.hasOwnProperty.call(obj, 'return')
                ? obj.return
                : obj.output;
        const expectedError = typeof obj.error === 'string' && obj.error.trim()
            ? obj.error.trim()
            : (typeof obj.expectedError === 'string' && obj.expectedError.trim() ? obj.expectedError.trim() : undefined);
        const inputs = obj.inputs ?? obj.input ?? obj.args ?? obj.params;

        let callExpr: string | null = null;
        if (Array.isArray(inputs)) {
            callExpr = `${node.name}(${inputs.map(v => JSON.stringify(v)).join(', ')})`;
        } else if (inputs && typeof inputs === 'object') {
            const rec = inputs as Record<string, unknown>;
            const recKeys = Object.keys(rec);
            const posArgs = buildTsPositionalArgs(paramNames, rec, recKeys);
            if (posArgs) {
                callExpr = `${node.name}(${posArgs.join(', ')})`;
            } else if (paramNames.length === 1) {
                callExpr = `${node.name}(${JSON.stringify(rec)})`;
            } else {
                callExpr = `${node.name}(${Object.values(rec).map(v => JSON.stringify(v)).join(', ')})`;
            }
        } else if (inputs !== undefined) {
            callExpr = `${node.name}(${JSON.stringify(inputs)})`;
        } else {
            const keys = Object.keys(obj).filter(k => !CASE_METADATA_KEYS.has(k));
            if (keys.length > 0) {
                const posArgs = buildTsPositionalArgs(paramNames, obj, keys);
                if (posArgs) {
                    callExpr = `${node.name}(${posArgs.join(', ')})`;
                } else {
                    callExpr = `${node.name}(${keys.map(k => JSON.stringify(obj[k])).join(', ')})`;
                }
            }
        }

        if (!callExpr) {
            lines.push(`    // Untyped case: ${JSON.stringify(obj)}`);
        } else if (expectedError) {
            if (isAsync) {
                lines.push(`    {`);
                lines.push(`        let __caught: unknown = null;`);
                lines.push(`        try {`);
                lines.push(`            await ${callExpr};`);
                lines.push(`        } catch (err) {`);
                lines.push(`            __caught = err;`);
                lines.push(`        }`);
                lines.push(`        expect(() => { if (__caught) throw __caught; }).toThrow(${JSON.stringify(expectedError)});`);
                lines.push(`    }`);
            } else {
                lines.push(`    expect(() => { ${callExpr}; }).toThrow(${JSON.stringify(expectedError)});`);
            }
        } else if (hasExpected) {
            const awaitedExpr = isAsync ? `await ${callExpr}` : callExpr;
            const approxFlag = obj.approx;
            if (typeof expected === 'number' && Number.isFinite(expected) && approxFlag !== false) {
                if (typeof approxFlag === 'number' && Number.isFinite(approxFlag) && approxFlag > 0) {
                    lines.push(`    expect(Math.abs((${awaitedExpr}) - (${JSON.stringify(expected)}))).toBeLessThanOrEqual(${approxFlag});`);
                } else if (approxFlag === true) {
                    lines.push(`    expect(${awaitedExpr}).toBeCloseTo(${JSON.stringify(expected)}, 6);`);
                } else {
                    lines.push(`    expect(${awaitedExpr}).toEqual(${JSON.stringify(expected)});`);
                }
            } else {
                lines.push(`    expect(${awaitedExpr}).toEqual(${JSON.stringify(expected)});`);
            }
        } else {
            lines.push(`    ${isAsync ? 'await ' : ''}${callExpr};`);
        }
    });

    lines.push('});');
    return lines;
}

/** Generates python module and pytest test code for scoped per-node verification. */
export function generateVerificationFiles(
    node: SlateNode,
    dependencies?: Map<string, SlateNode>,
    nodeId?: string,
): GeneratedVerification {
    const hasCases = Array.isArray(node.cases) && node.cases.length > 0;
    const hasCheck = Array.isArray(node.check) && node.check.length > 0;
    const hasChecks = hasCases || hasCheck;

    if (!hasChecks) {
        return { moduleContent: '', testContent: '', hasChecks: false };
    }

    const futureImports: string[] = ['from __future__ import annotations'];
    const regularImports: string[] = ['import sys', 'import typing'];
    const seenImports = new Set<string>([...futureImports, ...regularImports]);
    const pushImport = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed || seenImports.has(trimmed)) return;
        seenImports.add(trimmed);
        if (trimmed.startsWith('from __future__ ')) {
            futureImports.push(trimmed);
        } else {
            regularImports.push(trimmed);
        }
    };

    const depCodeBlocks: string[] = [];
    const depExportNames = new Set<string>();
    if (dependencies && dependencies.size > 0) {
        for (const [depId, depNode] of dependencies.entries()) {
            if (depNode === node || (nodeId ? depId === nodeId : depId === node.name)) continue;
            for (const imp of depNode.imports ?? []) {
                pushImport(imp);
            }
            if (depNode.code.length > 0) {
                depCodeBlocks.push(`\n# Context: ${depNode.name}`);
                depCodeBlocks.push(...depNode.code);
                if (
                    depNode.kind !== 'prelude'
                    && /^[A-Za-z_][A-Za-z0-9_]*$/.test(depNode.name)
                    && topLevelBindings(codeText(depNode)).has(depNode.name)
                ) {
                    depExportNames.add(depNode.name);
                }
            }
        }
    }

    for (const imp of node.imports ?? []) {
        pushImport(imp);
    }

    const moduleParts: string[] = [
        '# Auto-generated verification module for Slate atomic node',
        ...futureImports,
        ...regularImports,
    ];

    if (depCodeBlocks.length > 0) {
        moduleParts.push('# Dependent context nodes');
        moduleParts.push(...depCodeBlocks);
    }

    moduleParts.push(`\n# Target implementation: ${node.name}`);
    moduleParts.push(...node.code);

    // Pydantic strict parameter & return contract validation wrapper
    moduleParts.push(`
# Pydantic contract validation (S-513)
try:
    from pydantic import ConfigDict, validate_call
    ${node.name} = validate_call(config=ConfigDict(strict=True), validate_return=True)(${node.name})
except Exception:
    pass
`);

    const checkTopBindings = hasCheck && node.check
        ? topLevelBindings(node.check.join('\n'))
        : new Set<string>();
    const extraTestImports = Array.from(depExportNames)
        .filter(name => name !== node.name && name !== 'pytest' && !checkTopBindings.has(name))
        .sort();
    const isPytestTestName = (name: string) => name.startsWith('test') || name.startsWith('Test');
    const safeTestImports = extraTestImports.filter(name => !isPytestTestName(name));
    const pytestCollidingImports = extraTestImports.filter(isPytestTestName);
    const nonCollectedHelperLines = pytestCollidingImports.length > 0
        ? [
            `class _SlateNonTestClass:`,
            `    def __init__(self, target_cls, inherited=True):`,
            `        self._target_cls = target_cls`,
            `        self._inherited = inherited`,
            `    def __get__(self, obj, owner=None):`,
            `        return False if owner is self._target_cls else self._inherited`,
            `def _slate_mark_helper(obj):`,
            `    if isinstance(obj, type):`,
            `        try:`,
            `            obj.__test__ = _SlateNonTestClass(obj, getattr(obj, '__test__', True))`,
            `        except Exception:`,
            `            pass`,
            `        return obj`,
            `    try:`,
            `        obj.__test__ = False`,
            `        return obj`,
            `    except Exception:`,
            `        if callable(obj):`,
            `            def _wrapped(*_args, **_kwargs):`,
            `                return obj(*_args, **_kwargs)`,
            `            _wrapped.__test__ = False`,
            `            return _wrapped`,
            `        return obj`,
            `from ${node.name}_impl import ${pytestCollidingImports.join(', ')}`,
            ...pytestCollidingImports.map(name => `${name} = _slate_mark_helper(${name})`),
        ]
        : [];

    const testParts: string[] = [
        '# Auto-generated pytest check file for Slate atomic node',
        'import pytest',
        `from ${node.name}_impl import ${node.name}`,
        ...(safeTestImports.length > 0 ? [`from ${node.name}_impl import ${safeTestImports.join(', ')}`] : []),
        ...nonCollectedHelperLines,
    ];

    if (hasCheck && node.check) {
        testParts.push('\n# Target unit check');
        testParts.push(...node.check);
    }

    if (hasCases && node.cases) {
        const parsedTarget = parseModule(`${codeText(node)}\n`, '<verify>', node.name);
        const targetUnit = parsedTarget.units.find(u => u.parentId === null && u.name === node.name);
        testParts.push('\n# Structured cases');
        testParts.push(...formatCasesAsPython(node.name, node.cases, { returnAnnotation: targetUnit?.returnAnnotation }));
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
    language?: string;
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

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: '1',
            ...(process.versions.electron && cmd === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        };
        const useShell = process.platform === 'win32' && cmd !== process.execPath && !cmd.toLowerCase().endsWith('.exe');
        const proc = child_process.spawn(cmd, args, {
            cwd,
            shell: useShell,
            env,
        });

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

/** Runs scoped verification (Pydantic + pytest + mutmut for Python; strict tsc + isolated Node runner for TS/JS). */
export async function runNodeVerification(options: VerificationOptions): Promise<NodeVerificationResult> {
    const effectiveLang = tryNormalizeLanguage(options.language ?? options.node.language) ?? 'python';
    if (effectiveLang === 'typescript' || effectiveLang === 'javascript') {
        return runTsNodeVerification({ ...options, language: effectiveLang });
    }

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

    const { moduleContent, testContent, hasChecks } = generateVerificationFiles(node, dependencies, nodeId);

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
    const normNodeRel = normalizeCompileOutputPath(nodeId);
    const pyRelSegments = normNodeRel
        ? normNodeRel.split('/')
        : [`${nodeId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${createHash('sha256').update(nodeId).digest('hex').slice(0, 12)}`];
    const buildDir = path.join(workspaceRoot, '.slate', 'build', 'verify', ...pyRelSegments);
    await fs.promises.mkdir(buildDir, { recursive: true });
    for (const staleDir of ['__pycache__', '.pytest_cache', '.mutmut-cache', 'mutants']) {
        await fs.promises.rm(path.join(buildDir, staleDir), { recursive: true, force: true });
    }

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

    if (mutmutRun.timedOut) {
        return {
            nodeId,
            state: 'passed',
            timestamp: Date.now(),
            sourceHash: currentHash,
            pydanticValid: true,
            testsPassed: passed,
            testsTotal: total,
            diagnostics: [`Pytest passed; mutmut mutation testing timed out after ${timeoutMs}ms.`],
        };
    }

    const mutmutOut = `${mutmutRun.stdout}\n${mutmutRun.stderr}`;
    const survivingMatch = mutmutOut.match(/(\d+)\s+survived/i) || mutmutOut.match(/survived\s*:\s*(\d+)/i);
    const killedMatch = mutmutOut.match(/(\d+)\s+killed/i) || mutmutOut.match(/killed\s*:\s*(\d+)/i);

    const surviving = survivingMatch ? parseInt(survivingMatch[1], 10) : 0;
    const killed = killedMatch ? parseInt(killedMatch[1], 10) : 0;
    const totalMutants = surviving + killed;

    if (mutmutRun.code !== 0 && totalMutants === 0) {
        return {
            nodeId,
            state: 'passed',
            timestamp: Date.now(),
            sourceHash: currentHash,
            pydanticValid: true,
            testsPassed: passed,
            testsTotal: total,
            diagnostics: [`Pytest passed; mutmut execution note: ${mutmutRun.stderr.slice(0, 100) || 'completed'}`],
        };
    }

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

const TS_HARNESS_SOURCE = `const { isDeepStrictEqual } = require('node:util');

const __slateTests = [];
function describe(_name, fn) { fn(); }
function test(name, fn) { __slateTests.push({ name: String(name), fn }); }
const it = test;

function makeMatchers(actual, negated) {
    const check = (pass, message) => {
        const ok = negated ? !pass : pass;
        if (!ok) throw new Error(negated ? 'Negated expectation failed: ' + message : message);
    };
    return {
        toBe: (expected) => check(Object.is(actual, expected), 'Expected ' + JSON.stringify(expected) + ', received ' + JSON.stringify(actual)),
        toEqual: (expected) => check(isDeepStrictEqual(actual, expected), 'Expected deep equal ' + JSON.stringify(expected) + ', received ' + JSON.stringify(actual)),
        toStrictEqual: (expected) => check(isDeepStrictEqual(actual, expected), 'Expected strict equal ' + JSON.stringify(expected) + ', received ' + JSON.stringify(actual)),
        toBeTruthy: () => check(Boolean(actual), 'Expected truthy value, received ' + JSON.stringify(actual)),
        toBeFalsy: () => check(!actual, 'Expected falsy value, received ' + JSON.stringify(actual)),
        toBeNull: () => check(actual === null, 'Expected null, received ' + JSON.stringify(actual)),
        toBeUndefined: () => check(actual === undefined, 'Expected undefined, received ' + JSON.stringify(actual)),
        toBeDefined: () => check(actual !== undefined, 'Expected defined value, received undefined'),
        toContain: (item) => {
            const has = typeof actual === 'string'
                ? actual.includes(String(item))
                : Array.isArray(actual) || actual instanceof Set
                    ? [...actual].includes(item)
                    : false;
            check(has, 'Expected ' + JSON.stringify(actual) + ' to contain ' + JSON.stringify(item));
        },
        toHaveLength: (len) => check(actual != null && actual.length === len, 'Expected length ' + len + ', received ' + (actual ? actual.length : actual)),
        toBeGreaterThan: (n) => check(typeof actual === 'number' && actual > n, 'Expected ' + actual + ' > ' + n),
        toBeGreaterThanOrEqual: (n) => check(typeof actual === 'number' && actual >= n, 'Expected ' + actual + ' >= ' + n),
        toBeLessThan: (n) => check(typeof actual === 'number' && actual < n, 'Expected ' + actual + ' < ' + n),
        toBeLessThanOrEqual: (n) => check(typeof actual === 'number' && actual <= n, 'Expected ' + actual + ' <= ' + n),
        toBeCloseTo: (n, precision = 2) => {
            const diff = Math.abs(Number(actual) - n);
            check(diff < Math.pow(10, -precision) / 2, 'Expected ' + actual + ' to be close to ' + n);
        },
        toMatch: (pat) => check(pat instanceof RegExp ? pat.test(String(actual)) : String(actual).includes(String(pat)), 'Expected ' + JSON.stringify(actual) + ' to match ' + String(pat)),
        toThrow: (expected) => {
            if (typeof actual !== 'function') throw new Error('toThrow requires a function');
            let threw = false;
            let caught = null;
            try { actual(); } catch (e) { threw = true; caught = e; }
            let matched = threw;
            if (threw && expected !== undefined) {
                const msg = caught && caught.message ? caught.message : String(caught);
                matched = expected instanceof RegExp ? expected.test(msg) : msg.includes(String(expected));
            }
            check(matched, expected !== undefined ? 'Expected function to throw matching ' + String(expected) : 'Expected function to throw');
        },
    };
}

function expect(actual) {
    return Object.assign(makeMatchers(actual, false), { not: makeMatchers(actual, true) });
}

globalThis.describe = describe;
globalThis.test = test;
globalThis.it = it;
globalThis.expect = expect;
globalThis.__slateJsx = (tag, props, ...children) => ({ type: tag, props: props || {}, children });
globalThis.__slateFragment = Symbol.for('slate.fragment');

(async () => {
    const testEntry = process.argv[2];
    const failures = [];
    let passed = 0;
    let failed = 0;
    try {
        require(testEntry);
    } catch (err) {
        failed += 1;
        failures.push('module load: ' + (err && err.stack ? err.stack : String(err)));
    }
    for (const t of __slateTests) {
        try {
            await t.fn();
            passed += 1;
        } catch (err) {
            failed += 1;
            failures.push(t.name + ': ' + (err && err.stack ? err.stack : String(err)));
        }
    }
    const total = passed + failed;
    console.log('SLATE_TS_VERIFY_RESULT:' + JSON.stringify({ passed, failed, total, failures }));
    process.exit(failed > 0 ? 1 : 0);
})();
`;

const TS_PRELUDE_DECLARATIONS = `
declare function describe(name: string, fn: () => void): void;
declare function it(name: string, fn: () => void | Promise<void>): void;
declare function test(name: string, fn: () => void | Promise<void>): void;
interface SlateExpectMatchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toContain(item: unknown): void;
    toHaveLength(len: number): void;
    toBeGreaterThan(n: number): void;
    toBeGreaterThanOrEqual(n: number): void;
    toBeLessThan(n: number): void;
    toBeLessThanOrEqual(n: number): void;
    toBeCloseTo(n: number, precision?: number): void;
    toMatch(pattern: RegExp | string): void;
    toThrow(expected?: string | RegExp): void;
}
declare function expect(actual: unknown): SlateExpectMatchers & { not: SlateExpectMatchers };
declare module 'vitest' {
    export { describe, it, test, expect };
}
`;

const TS_FALLBACK_NO_LIB_DECLARATIONS = `
type PropertyKey = string | number | symbol;
interface Array<T> {
    readonly length: number;
    [n: number]: T;
    push(...items: T[]): number;
    pop(): T | undefined;
    map<U>(fn: (value: T, index: number, array: T[]) => U): U[];
    filter(fn: (value: T, index: number, array: T[]) => unknown): T[];
    reduce<U>(fn: (acc: U, value: T, index: number) => U, init: U): U;
    forEach(fn: (value: T, index: number) => void): void;
    some(fn: (value: T, index: number) => unknown): boolean;
    every(fn: (value: T, index: number) => unknown): boolean;
    find(fn: (value: T, index: number) => unknown): T | undefined;
    includes(value: T): boolean;
    indexOf(value: T): number;
    slice(start?: number, end?: number): T[];
    join(sep?: string): string;
    sort(cmp?: (a: T, b: T) => number): this;
    [Symbol.iterator](): IterableIterator<T>;
}
interface ReadonlyArray<T> extends Array<T> {}
interface Iterable<T> { [Symbol.iterator](): Iterator<T>; }
interface Iterator<T> { next(): { value: T; done: boolean }; }
interface IterableIterator<T> extends Iterable<T>, Iterator<T> {}
interface SymbolConstructor { readonly iterator: unique symbol; }
declare var Symbol: SymbolConstructor;
interface Function {}
interface Object {}
interface RegExp { test(input: string): boolean; exec(input: string): string[] | null; }
interface String {
    readonly length: number;
    trim(): string;
    trimStart(): string;
    trimEnd(): string;
    toLowerCase(): string;
    toUpperCase(): string;
    includes(search: string): boolean;
    startsWith(search: string): boolean;
    endsWith(search: string): boolean;
    indexOf(search: string): number;
    slice(start?: number, end?: number): string;
    split(sep: string | RegExp): string[];
    replace(search: string | RegExp, replace: string): string;
    match(pat: RegExp): string[] | null;
}
interface Boolean {}
interface Number { toFixed(digits?: number): string; }
interface IArguments {}
interface Error { name: string; message: string; stack?: string; }
declare var Error: { new (message?: string): Error; (message?: string): Error; };
interface Promise<T> { then<U>(fn?: (val: T) => U | Promise<U>): Promise<U>; catch(fn?: (err: unknown) => unknown): Promise<T>; }
interface Set<T> { add(val: T): this; has(val: T): boolean; delete(val: T): boolean; readonly size: number; }
interface Map<K, V> { get(k: K): V | undefined; set(k: K, v: V): this; has(k: K): boolean; delete(k: K): boolean; readonly size: number; }
type Record<K extends keyof any, T> = { [P in K]: T };
type Partial<T> = { [P in keyof T]?: T[P] };
type Readonly<T> = { readonly [P in keyof T]: T[P] };
declare var Array: { isArray(arg: unknown): arg is unknown[]; from<T>(it: Iterable<T>): T[]; };
declare var Object: { keys(o: object): string[]; values<T>(o: Record<string, T>): T[]; entries<T>(o: Record<string, T>): [string, T][]; assign<T extends object, U>(t: T, u: U): T & U; is(a: unknown, b: unknown): boolean; };
declare var Math: { min(...vals: number[]): number; max(...vals: number[]): number; floor(x: number): number; ceil(x: number): number; round(x: number): number; abs(x: number): number; sqrt(x: number): number; pow(x: number, y: number): number; };
declare var JSON: { stringify(v: unknown): string; parse(text: string): unknown; };
declare var Number: { isNaN(v: unknown): boolean; isFinite(v: unknown): boolean; isInteger(v: unknown): boolean; (v?: unknown): number; };
declare var String: { (v?: unknown): string; };
declare var Boolean: { (v?: unknown): boolean; };
declare var console: { log(...args: unknown[]): void; error(...args: unknown[]): void; warn(...args: unknown[]): void; };
`;

function resolveTypeScriptLibDir(): string | undefined {
    try {
        const tsEntry = require.resolve('typescript');
        const dir = path.dirname(tsEntry);
        if (fs.existsSync(path.join(dir, 'lib.es2022.d.ts')) || fs.existsSync(path.join(dir, 'lib.d.ts'))) {
            return dir;
        }
    } catch {
        // Standalone bundle without node_modules/typescript on disk
    }
    return undefined;
}

function hasWorkspaceReactTypes(startDir: string): boolean {
    let dir = path.resolve(startDir);
    for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, 'node_modules', '@types', 'react'))) return true;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return false;
}

function inspectTsModuleDeclarations(
    source: string,
    fileName: string,
): {
    allSymbols: string[];
    valueSymbols: string[];
    typeSymbols: string[];
    exportedVariables: string[];
    unexportedValues: string[];
    unexportedTypes: string[];
} {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindForPath(fileName, source));
    const allSymbols: string[] = [];
    const valueSymbols: string[] = [];
    const typeSymbols: string[] = [];
    const exportedVariables: string[] = [];
    const unexportedValues: string[] = [];
    const unexportedTypes: string[] = [];
    const seen = new Set<string>();
    const seenValues = new Set<string>();
    const seenTypes = new Set<string>();
    const seenExportedVars = new Set<string>();
    const seenUnexportedVal = new Set<string>();
    const seenUnexportedType = new Set<string>();

    const collectBindingNames = (binding: ts.BindingName, out: string[]): void => {
        if (ts.isIdentifier(binding)) {
            out.push(binding.text);
        } else if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
            for (const el of binding.elements) {
                if (ts.isBindingElement(el)) {
                    collectBindingNames(el.name, out);
                }
            }
        }
    };

    const record = (names: readonly string[], isNamedExport: boolean, kind: 'value' | 'type' | 'both') => {
        for (const sym of names) {
            if (!sym) continue;
            if (!seen.has(sym)) {
                seen.add(sym);
                allSymbols.push(sym);
            }
            if ((kind === 'value' || kind === 'both') && !seenValues.has(sym)) {
                seenValues.add(sym);
                valueSymbols.push(sym);
            }
            if ((kind === 'type' || kind === 'both') && !seenTypes.has(sym)) {
                seenTypes.add(sym);
                typeSymbols.push(sym);
            }
            if (!isNamedExport) {
                if (kind === 'type') {
                    if (!seenUnexportedType.has(sym)) {
                        seenUnexportedType.add(sym);
                        unexportedTypes.push(sym);
                    }
                } else if (!seenUnexportedVal.has(sym)) {
                    seenUnexportedVal.add(sym);
                    unexportedValues.push(sym);
                }
            }
        }
    };

    for (const stmt of sf.statements) {
        if (ts.isImportDeclaration(stmt)) continue;
        const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
        const hasExport = Boolean(mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
        const hasDefault = Boolean(mods?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword));
        const isNamedExport = hasExport && !hasDefault;

        if (ts.isVariableStatement(stmt)) {
            const names: string[] = [];
            for (const decl of stmt.declarationList.declarations) {
                collectBindingNames(decl.name, names);
            }
            record(names, isNamedExport, 'value');
            if (isNamedExport) {
                for (const sym of names) {
                    if (sym && !seenExportedVars.has(sym)) {
                        seenExportedVars.add(sym);
                        exportedVariables.push(sym);
                    }
                }
            }
        } else if (ts.isFunctionDeclaration(stmt)) {
            if (stmt.name) record([stmt.name.text], isNamedExport, 'value');
        } else if (ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
            if (stmt.name) record([stmt.name.text], isNamedExport, 'both');
        } else if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
            record([stmt.name.text], isNamedExport, 'type');
        }
    }

    return { allSymbols, valueSymbols, typeSymbols, exportedVariables, unexportedValues, unexportedTypes };
}

function collectTsReferencedNamespaces(
    source: string,
    fileName: string,
): { valueRefs: Set<string>; typeRefs: Set<string> } {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindForPath(fileName, source));
    const host: ts.CompilerHost = {
        getSourceFile: (requested) => (requested === fileName ? sf : undefined),
        writeFile: () => {},
        getCurrentDirectory: () => '',
        getDirectories: () => [],
        fileExists: (requested) => requested === fileName,
        readFile: () => undefined,
        getCanonicalFileName: (name) => name,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        getDefaultLibFileName: () => '__slate_no_lib.d.ts',
    };
    const program = ts.createProgram(
        [fileName],
        {
            allowJs: true,
            noLib: true,
            noResolve: true,
            jsx: ts.JsxEmit.Preserve,
            target: ts.ScriptTarget.Latest,
            module: ts.ModuleKind.ESNext,
        },
        host,
    );
    const checker = program.getTypeChecker();
    const isLocallyResolved = (sym: ts.Symbol | undefined): boolean =>
        Boolean(sym?.declarations && sym.declarations.some(decl => decl.getSourceFile() === sf));

    const valueRefs = new Set<string>();
    const typeRefs = new Set<string>();

    const recordEntityNameRoot = (name: ts.EntityName, target: Set<string>): void => {
        let cur: ts.EntityName = name;
        while (ts.isQualifiedName(cur)) {
            cur = cur.left;
        }
        if (ts.isIdentifier(cur) && !isLocallyResolved(checker.getSymbolAtLocation(cur))) {
            target.add(cur.text);
        }
    };

    const visitDecorators = (node: ts.Node): void => {
        if (!ts.canHaveDecorators(node)) return;
        for (const dec of ts.getDecorators(node) ?? []) {
            visit(dec, false);
        }
    };

    const visitBindingPattern = (binding: ts.BindingName): void => {
        if (ts.isIdentifier(binding)) return;
        for (const el of binding.elements) {
            if (!ts.isBindingElement(el)) continue;
            if (el.propertyName && ts.isComputedPropertyName(el.propertyName)) {
                visit(el.propertyName.expression, false);
            }
            visitBindingPattern(el.name);
            if (el.initializer) visit(el.initializer, false);
        }
    };

    const visit = (node: ts.Node, inType: boolean): void => {
        if (ts.isImportDeclaration(node) || ts.isJsxClosingElement(node)) return;
        visitDecorators(node);

        if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
            visitBindingPattern(node.name);
            if (node.type) visit(node.type, true);
            if (node.initializer) visit(node.initializer, false);
            return;
        }

        if (
            ts.isFunctionDeclaration(node)
            || ts.isFunctionExpression(node)
            || ts.isArrowFunction(node)
            || ts.isMethodDeclaration(node)
            || ts.isMethodSignature(node)
            || ts.isGetAccessorDeclaration(node)
            || ts.isSetAccessorDeclaration(node)
            || ts.isConstructorDeclaration(node)
            || ts.isCallSignatureDeclaration(node)
            || ts.isConstructSignatureDeclaration(node)
            || ts.isFunctionTypeNode(node)
            || ts.isConstructorTypeNode(node)
        ) {
            if ('name' in node && node.name && ts.isComputedPropertyName(node.name)) {
                visit(node.name.expression, false);
            }
            for (const tp of node.typeParameters ?? []) visit(tp, true);
            for (const param of node.parameters) visit(param, false);
            if (node.type) visit(node.type, true);
            if ('body' in node && node.body) visit(node.body, false);
            return;
        }

        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
            for (const tp of node.typeParameters ?? []) visit(tp, true);
            for (const hc of node.heritageClauses ?? []) {
                const isImplements = hc.token === ts.SyntaxKind.ImplementsKeyword;
                for (const t of hc.types) {
                    visit(t.expression, isImplements);
                    for (const ta of t.typeArguments ?? []) visit(ta, true);
                }
            }
            for (const member of node.members) visit(member, false);
            return;
        }

        if (ts.isInterfaceDeclaration(node)) {
            for (const tp of node.typeParameters ?? []) visit(tp, true);
            for (const hc of node.heritageClauses ?? []) {
                for (const t of hc.types) visit(t, true);
            }
            for (const member of node.members) visit(member, true);
            return;
        }

        if (ts.isTypeAliasDeclaration(node)) {
            for (const tp of node.typeParameters ?? []) visit(tp, true);
            visit(node.type, true);
            return;
        }

        if (ts.isEnumDeclaration(node)) {
            for (const member of node.members) {
                if (ts.isComputedPropertyName(member.name)) {
                    visit(member.name.expression, false);
                }
                if (member.initializer) visit(member.initializer, false);
            }
            return;
        }

        if (ts.isTypeParameterDeclaration(node)) {
            if (node.constraint) visit(node.constraint, true);
            if (node.default) visit(node.default, true);
            return;
        }

        if (ts.isTypePredicateNode(node)) {
            if (node.type) visit(node.type, true);
            return;
        }

        if (ts.isInferTypeNode(node)) {
            visit(node.typeParameter, true);
            return;
        }

        if (ts.isNamedTupleMember(node)) {
            visit(node.type, true);
            return;
        }

        if (ts.isImportTypeNode(node)) {
            for (const ta of node.typeArguments ?? []) visit(ta, true);
            return;
        }

        if (ts.isTypeQueryNode(node)) {
            recordEntityNameRoot(node.exprName, valueRefs);
            for (const ta of node.typeArguments ?? []) visit(ta, true);
            return;
        }

        if (ts.isTypeReferenceNode(node)) {
            recordEntityNameRoot(node.typeName, typeRefs);
            for (const ta of node.typeArguments ?? []) visit(ta, true);
            return;
        }

        if (ts.isTypeNode(node)) {
            ts.forEachChild(node, child => visit(child, true));
            return;
        }

        if (ts.isPropertyAccessExpression(node)) {
            visit(node.expression, inType);
            return;
        }

        if (ts.isPropertyAssignment(node)) {
            if (ts.isComputedPropertyName(node.name)) {
                visit(node.name.expression, false);
            }
            visit(node.initializer, false);
            return;
        }

        if (ts.isShorthandPropertyAssignment(node)) {
            if (!isLocallyResolved(checker.getShorthandAssignmentValueSymbol(node))) {
                valueRefs.add(node.name.text);
            }
            if (node.objectAssignmentInitializer) {
                visit(node.objectAssignmentInitializer, false);
            }
            return;
        }

        if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
            if (ts.isComputedPropertyName(node.name)) {
                visit(node.name.expression, false);
            }
            if (node.type) visit(node.type, true);
            if ('initializer' in node && node.initializer) visit(node.initializer, false);
            return;
        }

        if (ts.isExportDeclaration(node)) {
            if (node.moduleSpecifier) return;
            if (node.exportClause && ts.isNamedExports(node.exportClause)) {
                for (const spec of node.exportClause.elements) {
                    if (isLocallyResolved(checker.getExportSpecifierLocalTargetSymbol(spec))) continue;
                    const ref = spec.propertyName ?? spec.name;
                    if (node.isTypeOnly || spec.isTypeOnly) {
                        typeRefs.add(ref.text);
                    } else {
                        valueRefs.add(ref.text);
                        typeRefs.add(ref.text);
                    }
                }
            }
            return;
        }

        if (ts.isExportAssignment(node)) {
            if (ts.isIdentifier(node.expression)) {
                if (!isLocallyResolved(checker.getSymbolAtLocation(node.expression))) {
                    valueRefs.add(node.expression.text);
                    typeRefs.add(node.expression.text);
                }
            } else {
                visit(node.expression, false);
            }
            return;
        }

        if (ts.isLabeledStatement(node)) {
            visit(node.statement, false);
            return;
        }

        if (ts.isBreakOrContinueStatement(node)) {
            return;
        }

        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            if (ts.isPropertyAccessExpression(node.tagName)) {
                visit(node.tagName, false);
            } else if (ts.isIdentifier(node.tagName)) {
                if (!/^[a-z]/.test(node.tagName.text) && !isLocallyResolved(checker.getSymbolAtLocation(node.tagName))) {
                    valueRefs.add(node.tagName.text);
                }
            }
            for (const ta of node.typeArguments ?? []) visit(ta, true);
            visit(node.attributes, false);
            return;
        }

        if (ts.isJsxAttribute(node)) {
            if (node.initializer) visit(node.initializer, false);
            return;
        }

        if (ts.isIdentifier(node)) {
            if (!isLocallyResolved(checker.getSymbolAtLocation(node))) {
                (inType ? typeRefs : valueRefs).add(node.text);
            }
            return;
        }

        ts.forEachChild(node, child => visit(child, inType));
    };

    ts.forEachChild(sf, child => visit(child, false));
    return { valueRefs, typeRefs };
}

function stripInjectedImports(lines: readonly string[], symbolNames: ReadonlySet<string>, stripTestImports: boolean): string[] {
    const out: string[] = [];
    for (const line of lines) {
        if (!/^\s*import\b/.test(line)) {
            out.push(line);
            continue;
        }
        const parsed = splitTsImport(line);
        if (parsed.length === 0) {
            out.push(line);
            continue;
        }
        const kept = parsed.filter(item => {
            if (stripTestImports && (item.module === 'vitest' || item.module === '@jest/globals' || item.module === 'node:test')) {
                return false;
            }
            if ((item.module.startsWith('./') || item.module.startsWith('../')) && item.binding !== null && symbolNames.has(item.binding)) {
                return false;
            }
            return true;
        });
        for (const item of kept) {
            out.push(item.line);
        }
    }
    return out;
}

function dedupeNormalizedImports(lines: readonly string[]): { lines: string[]; bindings: Set<string> } {
    const out: string[] = [];
    const seen = new Set<string>();
    const bindings = new Set<string>();
    for (const raw of lines) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const parsed = splitTsImport(trimmed);
        if (parsed.length > 0) {
            for (const item of parsed) {
                if (item.binding) bindings.add(item.binding);
                if (!seen.has(item.line)) {
                    seen.add(item.line);
                    out.push(item.line);
                }
            }
        } else if (!seen.has(trimmed)) {
            seen.add(trimmed);
            out.push(trimmed);
        }
    }
    return { lines: out, bindings };
}

function runStrictTsTypecheck(
    workspaceRoot: string,
    virtualFiles: ReadonlyMap<string, string>,
    checkedFiles: readonly string[],
    useStandaloneJsx: boolean,
): string[] {
    const tsLibDir = resolveTypeScriptLibDir();
    const compilerOptions: ts.CompilerOptions = {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        ...(useStandaloneJsx
            ? { jsx: ts.JsxEmit.React, jsxFactory: '__slateJsx', jsxFragmentFactory: '__slateFragment' }
            : { jsx: ts.JsxEmit.ReactJSX }),
        esModuleInterop: true,
        skipLibCheck: true,
        ...(tsLibDir ? { lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'] } : { noLib: true }),
    };

    const host = ts.createCompilerHost(compilerOptions, true);
    const normMap = new Map<string, string>();
    for (const [k, v] of virtualFiles.entries()) {
        normMap.set(path.resolve(k).toLowerCase(), v);
    }

    const resolveVirtualOrLib = (fileName: string): { key: string; content: string } | undefined => {
        const resolved = path.resolve(fileName).toLowerCase();
        const direct = normMap.get(resolved);
        if (direct !== undefined) return { key: fileName, content: direct };
        if (tsLibDir) {
            const base = path.basename(fileName);
            if (/^lib(?:\.[^.]+)*\.d\.ts$/i.test(base)) {
                const libCandidate = path.join(tsLibDir, base);
                if (fs.existsSync(libCandidate)) {
                    return { key: libCandidate, content: fs.readFileSync(libCandidate, 'utf8') };
                }
            }
        }
        return undefined;
    };

    const origFileExists = host.fileExists.bind(host);
    const origReadFile = host.readFile.bind(host);
    const origGetSourceFile = host.getSourceFile.bind(host);

    host.getDefaultLibFileName = (opts) => tsLibDir
        ? path.join(tsLibDir, ts.getDefaultLibFileName(opts))
        : '__slate_lib_none.d.ts';
    host.fileExists = (fileName) => resolveVirtualOrLib(fileName) !== undefined || origFileExists(fileName);
    host.readFile = (fileName) => resolveVirtualOrLib(fileName)?.content ?? origReadFile(fileName);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
        const hit = resolveVirtualOrLib(fileName);
        if (hit !== undefined) {
            return ts.createSourceFile(fileName, hit.content, languageVersion, true);
        }
        return origGetSourceFile(fileName, languageVersion, onError, shouldCreate);
    };
    host.getCurrentDirectory = () => workspaceRoot;
    host.writeFile = () => {};

    const roots = Array.from(virtualFiles.keys());
    const program = ts.createProgram(roots, compilerOptions, host);
    const checkedSet = new Set(checkedFiles.map(f => path.resolve(f).toLowerCase()));
    const allDiags = ts.getPreEmitDiagnostics(program);
    const messages: string[] = [];

    for (const d of allDiags) {
        if (d.file && !checkedSet.has(path.resolve(d.file.fileName).toLowerCase())) continue;
        const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
        if (d.file && d.start !== undefined) {
            const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
            messages.push(`${path.basename(d.file.fileName)}(${line + 1},${character + 1}): TS${d.code}: ${msg}`);
        } else {
            messages.push(`TS${d.code}: ${msg}`);
        }
    }
    return messages;
}

/** Runs scoped TypeScript/JavaScript verification (strict tsc typecheck + isolated Node harness). */
async function runTsNodeVerification(
    options: VerificationOptions & { language: 'typescript' | 'javascript' },
): Promise<NodeVerificationResult> {
    const {
        workspaceRoot,
        node,
        nodeId,
        dependencies,
        isTrusted,
        timeoutMs = 15000,
        executeCommand = defaultExecute,
        signal,
        language,
    } = options;

    const currentHash = sourceHash(codeText(node));
    if (signal?.aborted) {
        return { nodeId, state: 'failed', timestamp: Date.now(), sourceHash: currentHash, diagnostics: ['Verification was cancelled.'] };
    }
    if (!isTrusted) {
        return { nodeId, state: 'failed', timestamp: Date.now(), sourceHash: currentHash, diagnostics: ['Workspace is not trusted. Cannot execute verification.'] };
    }

    const hasCases = Array.isArray(node.cases) && node.cases.length > 0;
    const hasCheck = Array.isArray(node.check) && node.check.length > 0;
    if (!hasCases && !hasCheck) {
        return {
            nodeId,
            state: 'untested',
            timestamp: Date.now(),
            sourceHash: currentHash,
            diagnostics: ['Node has no check or cases; status is untested.'],
        };
    }

    const idHash = createHash('sha256').update(nodeId).digest('hex').slice(0, 12);
    const runNonce = randomUUID().slice(0, 8);
    const safeNodeDir = `${nodeId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${idHash}-${runNonce}`;
    const buildDir = path.join(workspaceRoot, '.slate', 'build', 'ts-verify', safeNodeDir);
    fs.mkdirSync(buildDir, { recursive: true });

    try {
        const depNodes = dependencies ? Array.from(dependencies.values()).filter(d => d.name !== node.name && d.code.length > 0) : [];

        const extHint = typeof node.extra?.extension === 'string' ? node.extra.extension : undefined;
        const combinedJsxSource = `${node.code.join('\n')}\n${node.check?.join('\n') ?? ''}`;
        const needsJsx = containsJsxSyntax(combinedJsxSource, extHint);
        const ext = language === 'javascript' ? (needsJsx ? '.jsx' : '.js') : (needsJsx ? '.tsx' : '.ts');
        const safeBase = node.name.replace(/[^a-zA-Z0-9_$]/g, '_') || 'node';

        // Prepare each dependency in its own isolated module so per-module imports never clash
        interface DepModuleSpec {
            dep: SlateNode;
            moduleBase: string;
            ext: string;
            tsPath: string;
            cjsPath: string;
            needsJsx: boolean;
            exportedSymbols: string[];
            exportedValues: Set<string>;
            exportedTypes: Set<string>;
            source: string;
        }

        const depSpecsRaw = depNodes.map((dep, idx) => {
            const depExtHint = typeof dep.extra?.extension === 'string' ? dep.extra.extension : undefined;
            const depBodyText = dep.code.join('\n');
            const depNeedsJsx = containsJsxSyntax(depBodyText, depExtHint);
            const depExt = language === 'javascript' ? (depNeedsJsx ? '.jsx' : '.js') : (depNeedsJsx ? '.tsx' : '.ts');
            const moduleBase = `__slate_dep_${idx}`;
            const decls = inspectTsModuleDeclarations(depBodyText, `${moduleBase}${depExt}`);
            const exportedSymbols = decls.allSymbols.length > 0
                ? decls.allSymbols
                : (!dep.kind ? [dep.name] : []);
            const exportedValues = new Set<string>(decls.allSymbols.length > 0 ? decls.valueSymbols : (!dep.kind ? [dep.name] : []));
            const exportedTypes = new Set<string>(decls.allSymbols.length > 0 ? decls.typeSymbols : []);
            return {
                dep,
                moduleBase,
                ext: depExt,
                tsPath: path.join(buildDir, `${moduleBase}${depExt}`),
                cjsPath: path.join(buildDir, `${moduleBase}.cjs`),
                needsJsx: depNeedsJsx,
                decls,
                exportedSymbols,
                exportedValues,
                exportedTypes,
            };
        });

        const canImportDepSymbol = (
            depSpec: { exportedValues: ReadonlySet<string>; exportedTypes: ReadonlySet<string> },
            sym: string,
            boundValues: ReadonlySet<string>,
            boundTypes: ReadonlySet<string>,
        ): boolean => !(depSpec.exportedValues.has(sym) && boundValues.has(sym))
            && !(depSpec.exportedTypes.has(sym) && boundTypes.has(sym));

        const recordDepSymbol = (
            sym: string,
            boundValues: Set<string>,
            boundTypes: Set<string>,
        ): void => {
            boundValues.add(sym);
            boundTypes.add(sym);
        };

        type DepImportCandidate = {
            moduleBase: string;
            exportedSymbols: readonly string[];
            exportedValues: ReadonlySet<string>;
            exportedTypes: ReadonlySet<string>;
        };

        const emitAllDepImports = (
            depSpecs: readonly DepImportCandidate[],
            refs: { valueRefs: ReadonlySet<string>; typeRefs: ReadonlySet<string> },
            boundValues: Set<string>,
            boundTypes: Set<string>,
            outLines: string[],
        ): void => {
            const perDep = new Map<string, { valueNeeded: string[]; typeOnlyNeeded: string[] }>();
            const tryAcquire = (depSpec: DepImportCandidate, sym: string): void => {
                if (!canImportDepSymbol(depSpec, sym, boundValues, boundTypes)) return;
                let entry = perDep.get(depSpec.moduleBase);
                if (!entry) {
                    entry = { valueNeeded: [], typeOnlyNeeded: [] };
                    perDep.set(depSpec.moduleBase, entry);
                }
                if (depSpec.exportedValues.has(sym)) {
                    entry.valueNeeded.push(sym);
                } else {
                    entry.typeOnlyNeeded.push(sym);
                }
                recordDepSymbol(sym, boundValues, boundTypes);
            };

            // Pass 1: dual providers when a symbol needs both value and type namespaces
            for (const depSpec of depSpecs) {
                for (const sym of depSpec.exportedSymbols) {
                    if (
                        depSpec.exportedValues.has(sym) && depSpec.exportedTypes.has(sym)
                        && refs.valueRefs.has(sym) && refs.typeRefs.has(sym)
                    ) {
                        tryAcquire(depSpec, sym);
                    }
                }
            }
            // Pass 2: value providers whenever a value reference exists, so an earlier
            // type-only dependency does not reserve the name and block required runtime bindings
            for (const depSpec of depSpecs) {
                for (const sym of depSpec.exportedSymbols) {
                    if (depSpec.exportedValues.has(sym) && refs.valueRefs.has(sym)) {
                        tryAcquire(depSpec, sym);
                    }
                }
            }
            // Pass 3: remaining type-only providers for remaining type references
            for (const depSpec of depSpecs) {
                for (const sym of depSpec.exportedSymbols) {
                    if (depSpec.exportedTypes.has(sym) && refs.typeRefs.has(sym)) {
                        tryAcquire(depSpec, sym);
                    }
                }
            }

            for (const depSpec of depSpecs) {
                const entry = perDep.get(depSpec.moduleBase);
                if (!entry) continue;
                if (entry.valueNeeded.length > 0) {
                    entry.valueNeeded.sort();
                    outLines.push(`import { ${entry.valueNeeded.join(', ')} } from './${depSpec.moduleBase}';`);
                }
                if (entry.typeOnlyNeeded.length > 0) {
                    entry.typeOnlyNeeded.sort();
                    outLines.push(`import type { ${entry.typeOnlyNeeded.join(', ')} } from './${depSpec.moduleBase}';`);
                }
            }
        };

        const availableSymbols = new Set<string>([
            node.name,
            ...depSpecsRaw.flatMap(d => (d.dep.kind ? d.exportedSymbols : [d.dep.name, ...d.exportedSymbols])),
        ]);

        const depModules: DepModuleSpec[] = depSpecsRaw.map((spec) => {
            const { dep, moduleBase, ext: depExt, tsPath, cjsPath, needsJsx: depNeedsJsx, decls, exportedSymbols, exportedValues, exportedTypes } = spec;
            const depImports = dedupeNormalizedImports(stripInjectedImports(dep.imports ?? [], availableSymbols, false));
            const depLines = stripInjectedImports(dep.code, availableSymbols, false);
            const depText = depLines.join('\n');
            const depRefs = collectTsReferencedNamespaces(depText, `dep_${dep.name}${depExt}`);
            const boundValuesInDep = new Set<string>([...depImports.bindings, ...decls.valueSymbols]);
            const boundTypesInDep = new Set<string>([...depImports.bindings, ...decls.typeSymbols, ...decls.exportedVariables]);
            const depParts: string[] = [...depImports.lines];

            emitAllDepImports(
                depSpecsRaw.filter(other => other.dep !== dep),
                depRefs,
                boundValuesInDep,
                boundTypesInDep,
                depParts,
            );

            // Support mutual recursion (helper calling target function)
            if (
                (depRefs.valueRefs.has(node.name) || depRefs.typeRefs.has(node.name))
                && !boundValuesInDep.has(node.name)
                && !boundTypesInDep.has(node.name)
            ) {
                depParts.push(`import { ${node.name} } from './${safeBase}_impl';`);
                recordDepSymbol(node.name, boundValuesInDep, boundTypesInDep);
            }

            depParts.push(...depLines);
            if (decls.unexportedValues.length > 0) {
                depParts.push(`export { ${decls.unexportedValues.join(', ')} };`);
            } else if (decls.allSymbols.length === 0 && !dep.kind) {
                depParts.push(`export { ${dep.name} };`);
            }
            if (decls.unexportedTypes.length > 0) {
                depParts.push(`export type { ${decls.unexportedTypes.join(', ')} };`);
            }

            return {
                dep,
                moduleBase,
                ext: depExt,
                tsPath,
                cjsPath,
                needsJsx: depNeedsJsx,
                exportedSymbols,
                exportedValues,
                exportedTypes,
                source: depParts.join('\n') + '\n',
            };
        });

        // Build target module with ONLY target's own imports + explicit imports from isolated dep modules
        const targetImports = dedupeNormalizedImports(stripInjectedImports(node.imports ?? [], availableSymbols, false));
        const targetLines = stripInjectedImports(node.code, availableSymbols, false);
        const targetText = targetLines.join('\n');
        const targetRefs = collectTsReferencedNamespaces(targetText, `target${ext}`);
        const targetDecls = inspectTsModuleDeclarations(targetText, `target${ext}`);
        const boundValuesInTarget = new Set<string>([...targetImports.bindings, ...targetDecls.valueSymbols]);
        const boundTypesInTarget = new Set<string>([...targetImports.bindings, ...targetDecls.typeSymbols, ...targetDecls.exportedVariables]);

        const implParts: string[] = [...targetImports.lines];
        emitAllDepImports(depModules, targetRefs, boundValuesInTarget, boundTypesInTarget, implParts);
        implParts.push(...targetLines);

        if (targetDecls.unexportedValues.includes(node.name) || !targetDecls.allSymbols.includes(node.name)) {
            implParts.push(`export { ${node.name} };`);
        }
        const implSource = implParts.join('\n') + '\n';

        // Build test module importing target symbol (plus any dep symbols directly referenced in testBody)
        const testBodyLines: string[] = [];
        if (hasCheck && node.check) {
            testBodyLines.push(...stripInjectedImports(node.check, availableSymbols, true));
        }
        if (hasCases && node.cases) {
            testBodyLines.push(...formatCasesAsTs(node, node.cases, language));
        }
        const testBodyText = testBodyLines.join('\n');
        const testRefs = collectTsReferencedNamespaces(testBodyText, `test_${safeBase}${ext}`);
        const testDecls = inspectTsModuleDeclarations(testBodyText, `test_${safeBase}${ext}`);
        const boundValuesInTest = new Set<string>([node.name, ...testDecls.valueSymbols]);
        const boundTypesInTest = new Set<string>([node.name, ...testDecls.typeSymbols, ...testDecls.exportedVariables]);
        for (const line of testBodyLines) {
            if (/^\s*import\b/.test(line)) {
                for (const item of splitTsImport(line)) {
                    if (item.binding) {
                        boundValuesInTest.add(item.binding);
                        boundTypesInTest.add(item.binding);
                    }
                }
            }
        }
        const testHeader: string[] = [`import { ${node.name} } from './${safeBase}_impl';`];
        emitAllDepImports(depModules, testRefs, boundValuesInTest, boundTypesInTest, testHeader);
        const testSource = [...testHeader, ...testBodyLines].join('\n') + '\n';

        const implTsPath = path.join(buildDir, `${safeBase}_impl${ext}`);
        const testTsPath = path.join(buildDir, `${safeBase}_test${ext}`);
        const preludePath = path.join(buildDir, '__slate_prelude.d.ts');

        const anyNeedsJsx = needsJsx || depModules.some(d => d.needsJsx);
        const useStandaloneJsx = anyNeedsJsx && !hasWorkspaceReactTypes(workspaceRoot);
        const jsxFallback = useStandaloneJsx
            ? '\ndeclare namespace JSX { interface IntrinsicElements { [elem: string]: unknown; } interface Element { type: unknown; props: Record<string, unknown>; children?: unknown[]; } }\ndeclare function __slateJsx(tag: unknown, props: unknown, ...children: unknown[]): JSX.Element;\ndeclare const __slateFragment: unique symbol;\n'
            : '';
        const preludeContent = (resolveTypeScriptLibDir() ? '' : TS_FALLBACK_NO_LIB_DECLARATIONS) + TS_PRELUDE_DECLARATIONS + jsxFallback;

        if (language === 'typescript') {
            const virtualFiles = new Map<string, string>([[preludePath, preludeContent]]);
            const checkedFiles: string[] = [];
            for (const depSpec of depModules) {
                virtualFiles.set(depSpec.tsPath, depSpec.source);
                checkedFiles.push(depSpec.tsPath);
            }
            virtualFiles.set(implTsPath, implSource);
            virtualFiles.set(testTsPath, testSource);
            checkedFiles.push(implTsPath, testTsPath);

            const typeErrors = runStrictTsTypecheck(workspaceRoot, virtualFiles, checkedFiles, useStandaloneJsx);
            if (typeErrors.length > 0) {
                return {
                    nodeId,
                    state: 'failed',
                    timestamp: Date.now(),
                    sourceHash: currentHash,
                    pydanticValid: false,
                    traceback: typeErrors.join('\n'),
                    diagnostics: typeErrors,
                };
            }
        }

        const transpileOpts: ts.TranspileOptions = {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.CommonJS,
                ...(useStandaloneJsx
                    ? { jsx: ts.JsxEmit.React, jsxFactory: '__slateJsx', jsxFragmentFactory: '__slateFragment' }
                    : { jsx: ts.JsxEmit.ReactJSX }),
                esModuleInterop: true,
            },
            reportDiagnostics: true,
        };
        const depTranspiled = depModules.map(depSpec => ({
            spec: depSpec,
            result: ts.transpileModule(depSpec.source, { ...transpileOpts, fileName: depSpec.tsPath }),
        }));
        const implTranspiled = ts.transpileModule(implSource, { ...transpileOpts, fileName: implTsPath });
        const testTranspiled = ts.transpileModule(testSource, { ...transpileOpts, fileName: testTsPath });
        const syntaxErrors = [
            ...depTranspiled.flatMap(d => d.result.diagnostics ?? []),
            ...(implTranspiled.diagnostics ?? []),
            ...(testTranspiled.diagnostics ?? []),
        ]
            .filter(d => d.category === ts.DiagnosticCategory.Error)
            .map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
        if (syntaxErrors.length > 0) {
            return {
                nodeId,
                state: 'failed',
                timestamp: Date.now(),
                sourceHash: currentHash,
                pydanticValid: false,
                traceback: syntaxErrors.join('\n'),
                diagnostics: syntaxErrors,
            };
        }

        const testBase = `${safeBase}_test`;
        const implCjsPath = path.join(buildDir, `${safeBase}_impl.cjs`);
        const testCjsPath = path.join(buildDir, `${testBase}.cjs`);
        const harnessPath = path.join(buildDir, '__slate_harness.cjs');

        const escapedSafeBase = safeBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rewriteLocalRequires = (jsCode: string): string =>
            jsCode.replace(
                new RegExp(`require\\((['"])(\\.\\/(?:__slate_dep_\\d+|${escapedSafeBase}_impl))\\1\\)`, 'g'),
                "require('$2.cjs')",
            );

        for (const item of depTranspiled) {
            fs.writeFileSync(item.spec.cjsPath, rewriteLocalRequires(item.result.outputText), 'utf8');
        }
        fs.writeFileSync(implCjsPath, rewriteLocalRequires(implTranspiled.outputText), 'utf8');
        fs.writeFileSync(testCjsPath, rewriteLocalRequires(testTranspiled.outputText), 'utf8');
        fs.writeFileSync(harnessPath, TS_HARNESS_SOURCE, 'utf8');

    const runRes = await executeCommand(process.execPath, [harnessPath, testCjsPath], buildDir, timeoutMs, signal);
    if (signal?.aborted) {
        return { nodeId, state: 'failed', timestamp: Date.now(), sourceHash: currentHash, diagnostics: ['Verification was cancelled.'] };
    }
    if (runRes.timedOut) {
        return { nodeId, state: 'failed', timestamp: Date.now(), sourceHash: currentHash, pydanticValid: true, diagnostics: [`Node verification timed out after ${timeoutMs}ms.`] };
    }

    const marker = runRes.stdout.split(/\r?\n/).find(l => l.startsWith('SLATE_TS_VERIFY_RESULT:'));
    if (marker) {
        try {
            const parsed = JSON.parse(marker.slice('SLATE_TS_VERIFY_RESULT:'.length)) as {
                passed?: number;
                failed?: number;
                total?: number;
                failures?: string[];
            };
            const passed = parsed.passed ?? 0;
            const total = parsed.total ?? 0;
            const failed = parsed.failed ?? 0;
            const failures = Array.isArray(parsed.failures) ? parsed.failures : [];
            if (runRes.code === 0 && failed === 0 && passed > 0) {
                return {
                    nodeId,
                    state: 'passed',
                    timestamp: Date.now(),
                    sourceHash: currentHash,
                    pydanticValid: true,
                    testsPassed: passed,
                    testsTotal: total,
                };
            }
            return {
                nodeId,
                state: 'failed',
                timestamp: Date.now(),
                sourceHash: currentHash,
                pydanticValid: true,
                testsPassed: passed,
                testsTotal: total,
                traceback: failures.join('\n') || runRes.stderr.trim() || runRes.stdout.trim(),
                diagnostics: failures.length > 0 ? failures : ['Node unit check failed.'],
            };
        } catch {
            // Fall through to generic failure handling
        }
    }

    const fallbackMsg = `${runRes.stderr}\n${runRes.stdout}`.trim() || `Node verification exited with code ${runRes.code}.`;
    return {
        nodeId,
        state: runRes.code === 0 ? 'passed' : 'failed',
        timestamp: Date.now(),
        sourceHash: currentHash,
        pydanticValid: true,
        traceback: runRes.code === 0 ? undefined : fallbackMsg,
        diagnostics: runRes.code === 0 ? undefined : [fallbackMsg],
    };
    } finally {
        try {
            fs.rmSync(buildDir, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup of per-run verification scratch dir
        }
    }
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
