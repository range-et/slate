import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    parseElectronTestResult,
    runBoundedElectronProcess,
    type ElectronChildProcess,
    type ElectronTestResult,
} from '../vscode-extension/src/test/electron_runner';

function createChildFixture(): {
    child: ElectronChildProcess & {
        exitCode: number | null;
        signalCode: string | null;
        emitExit: (code?: number | null, signal?: string | null) => void;
    };
    stdoutChunks: string[];
    stderrChunks: string[];
} {
    const emitter = new EventEmitter();
    const stdoutEmitter = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const stderrEmitter = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const child = Object.assign(emitter, {
        pid: 4242,
        exitCode: null as number | null,
        signalCode: null as string | null,
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        emitExit(code: number | null = 0, signal: string | null = null) {
            child.exitCode = code;
            child.signalCode = signal;
            child.emit('exit', code, signal);
        },
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    return { child, stdoutChunks, stderrChunks };
}

function makeFakeOutputs(stdoutChunks: string[], stderrChunks: string[]) {
    return {
        stdout: { write: (chunk: string | Uint8Array) => stdoutChunks.push(String(chunk)) },
        stderr: { write: (chunk: string | Uint8Array) => stderrChunks.push(String(chunk)) },
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('parseElectronTestResult', () => {
    it('accepts valid passed and failed payloads and preserves error details', () => {
        expect(parseElectronTestResult('{"status":"passed","failures":0}')).toEqual({
            status: 'passed',
            failures: 0,
        });
        expect(parseElectronTestResult('{"status":"failed","failures":2,"error":"boom"}')).toEqual({
            status: 'failed',
            failures: 2,
            error: 'boom',
        });
    });

    it('rejects malformed JSON, wrong shapes, invalid counts, and inconsistent pass/failure state', () => {
        expect(() => parseElectronTestResult('{not json')).toThrow('Invalid Extension Host result JSON');
        expect(() => parseElectronTestResult('[]')).toThrow('must be a JSON object');
        expect(() => parseElectronTestResult('{"status":"unknown","failures":0}')).toThrow('status must be "passed" or "failed"');
        expect(() => parseElectronTestResult('{"status":"passed","failures":-1}')).toThrow('non-negative integer');
        expect(() => parseElectronTestResult('{"status":"passed","failures":1.5}')).toThrow('non-negative integer');
        expect(() => parseElectronTestResult('{"status":"passed","failures":1}')).toThrow('Inconsistent Extension Host result');
        expect(() => parseElectronTestResult('{"status":"failed","failures":1,"error":123}')).toThrow('error field must be a string');
    });
});

describe('runBoundedElectronProcess', () => {
    it('resolves cleanly without forced termination when the child writes a passed result and exits normally', async () => {
        vi.useFakeTimers();
        const { child, stdoutChunks, stderrChunks } = createChildFixture();
        const outputs = makeFakeOutputs(stdoutChunks, stderrChunks);
        const terminateProcess = vi.fn();
        let currentResult: ElectronTestResult | undefined;

        const initialSigintCount = process.listenerCount('SIGINT');
        const initialSigtermCount = process.listenerCount('SIGTERM');

        const pending = runBoundedElectronProcess({
            executablePath: 'code',
            args: ['--test'],
            resultFile: '/tmp/result.json',
            graceMs: 100,
            pollIntervalMs: 25,
            overallTimeoutMs: 1000,
            forceKillWaitMs: 50,
            ...outputs,
            spawnProcess: () => child,
            readResultFile: () => currentResult,
            terminateProcess,
        });

        child.stdout?.emit('data', '71 passing\n');
        child.stderr?.emit('data', 'diag\n');
        // Fast exit before the first poll tick still reads the result file.
        currentResult = { status: 'passed', failures: 0 };
        child.emitExit(0, null);

        await expect(pending).resolves.toBe(0);
        expect(terminateProcess).not.toHaveBeenCalled();
        expect(stdoutChunks.join('')).toContain('71 passing');
        expect(stderrChunks.join('')).toContain('diag');
        expect(vi.getTimerCount()).toBe(0);
        expect(process.listenerCount('SIGINT')).toBe(initialSigintCount);
        expect(process.listenerCount('SIGTERM')).toBe(initialSigtermCount);
    });

    it('preserves normal non-zero failure exits without forced termination', async () => {
        vi.useFakeTimers();
        const { child, stdoutChunks, stderrChunks } = createChildFixture();
        const terminateProcess = vi.fn();
        const currentResult: ElectronTestResult = { status: 'failed', failures: 2 };

        const pending = runBoundedElectronProcess({
            executablePath: 'code',
            args: [],
            resultFile: '/tmp/result.json',
            ...makeFakeOutputs(stdoutChunks, stderrChunks),
            spawnProcess: () => child,
            readResultFile: () => currentResult,
            terminateProcess,
        });

        child.emitExit(1, null);
        await expect(pending).rejects.toThrow('exited with code 1 (2 Extension Host test(s) failed)');
        expect(terminateProcess).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('terminates a hung VS Code process after graceMs when passed result was written and resolves 0', async () => {
        vi.useFakeTimers();
        const { child, stdoutChunks, stderrChunks } = createChildFixture();
        const warn = vi.fn();
        const terminateProcess = vi.fn(() => {
            child.signalCode = 'SIGKILL';
            child.emit('exit', null, 'SIGKILL');
        });
        let currentResult: ElectronTestResult | undefined;

        const initialSigintCount = process.listenerCount('SIGINT');
        const pending = runBoundedElectronProcess({
            executablePath: 'code',
            args: [],
            resultFile: '/tmp/result.json',
            graceMs: 100,
            pollIntervalMs: 20,
            overallTimeoutMs: 1000,
            forceKillWaitMs: 50,
            warn,
            ...makeFakeOutputs(stdoutChunks, stderrChunks),
            spawnProcess: () => child,
            readResultFile: () => currentResult,
            terminateProcess,
        });

        currentResult = { status: 'passed', failures: 0 };
        await vi.advanceTimersByTimeAsync(20);
        expect(terminateProcess).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(99);
        expect(terminateProcess).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toBe(0);
        expect(terminateProcess).toHaveBeenCalledExactlyOnceWith(child, true);
        expect(warn).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        expect(process.listenerCount('SIGINT')).toBe(initialSigintCount);
    });

    it('still fails when a hung VS Code process is terminated after writing a failed result', async () => {
        vi.useFakeTimers();
        const { child, stdoutChunks, stderrChunks } = createChildFixture();
        const terminateProcess = vi.fn(() => {
            child.signalCode = 'SIGKILL';
            child.emit('exit', null, 'SIGKILL');
        });

        const pending = runBoundedElectronProcess({
            executablePath: 'code',
            args: [],
            resultFile: '/tmp/result.json',
            graceMs: 50,
            pollIntervalMs: 10,
            overallTimeoutMs: 1000,
            forceKillWaitMs: 50,
            warn: vi.fn(),
            ...makeFakeOutputs(stdoutChunks, stderrChunks),
            spawnProcess: () => child,
            readResultFile: () => ({ status: 'failed', failures: 3 }),
            terminateProcess,
        });

        const expectation = expect(pending).rejects.toThrow('3 Extension Host test(s) failed');
        await vi.advanceTimersByTimeAsync(60);
        await expectation;
        expect(terminateProcess).toHaveBeenCalledExactlyOnceWith(child, true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('kills a hung child on overallTimeoutMs when no result file is ever written', async () => {
        vi.useFakeTimers();
        const { child, stdoutChunks, stderrChunks } = createChildFixture();
        const warn = vi.fn();
        const terminateProcess = vi.fn(() => {
            child.exitCode = 137;
            child.emit('exit', 137, null);
        });

        const pending = runBoundedElectronProcess({
            executablePath: 'code',
            args: [],
            resultFile: '/tmp/missing.json',
            graceMs: 50,
            pollIntervalMs: 25,
            overallTimeoutMs: 200,
            forceKillWaitMs: 50,
            warn,
            ...makeFakeOutputs(stdoutChunks, stderrChunks),
            spawnProcess: () => child,
            readResultFile: () => undefined,
            terminateProcess,
        });

        const expectation = expect(pending).rejects.toThrow('timed out after 200ms');
        await vi.advanceTimersByTimeAsync(200);
        await expectation;
        expect(terminateProcess).toHaveBeenCalledExactlyOnceWith(child, true);
        expect(warn).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('fails closed when VS Code exits with code 0 without writing any result file', async () => {
        vi.useFakeTimers();
        const { child, stdoutChunks, stderrChunks } = createChildFixture();

        const pending = runBoundedElectronProcess({
            executablePath: 'code',
            args: [],
            resultFile: '/tmp/missing.json',
            ...makeFakeOutputs(stdoutChunks, stderrChunks),
            spawnProcess: () => child,
            readResultFile: () => undefined,
            terminateProcess: vi.fn(),
        });

        child.emitExit(0, null);
        await expect(pending).rejects.toThrow('without writing an Extension Host test result');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('never masks a crash exit even after a passed result was written before forced shutdown', async () => {
        vi.useFakeTimers();
        const { child, stdoutChunks, stderrChunks } = createChildFixture();
        const terminateProcess = vi.fn();

        const pending = runBoundedElectronProcess({
            executablePath: 'code',
            args: [],
            resultFile: '/tmp/result.json',
            graceMs: 100,
            pollIntervalMs: 10,
            overallTimeoutMs: 1000,
            ...makeFakeOutputs(stdoutChunks, stderrChunks),
            spawnProcess: () => child,
            readResultFile: () => ({ status: 'passed', failures: 0 }),
            terminateProcess,
        });

        await vi.advanceTimersByTimeAsync(10);
        child.emitExit(null, 'SIGSEGV');
        await expect(pending).rejects.toThrow('terminated with signal SIGSEGV');
        expect(terminateProcess).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('propagates result-file read/parse errors and terminates stuck processes instead of hanging', async () => {
        vi.useFakeTimers();
        const { child, stdoutChunks, stderrChunks } = createChildFixture();
        const terminateProcess = vi.fn(() => {
            child.signalCode = 'SIGKILL';
            child.emit('exit', null, 'SIGKILL');
        });
        const parseError = new Error('Invalid Extension Host result JSON');

        const pending = runBoundedElectronProcess({
            executablePath: 'code',
            args: [],
            resultFile: '/tmp/corrupt.json',
            graceMs: 40,
            pollIntervalMs: 10,
            overallTimeoutMs: 1000,
            warn: vi.fn(),
            ...makeFakeOutputs(stdoutChunks, stderrChunks),
            spawnProcess: () => child,
            readResultFile: () => { throw parseError; },
            terminateProcess,
        });

        const expectation = expect(pending).rejects.toThrow('Invalid Extension Host result JSON');
        await vi.advanceTimersByTimeAsync(50);
        await expectation;
        expect(terminateProcess).toHaveBeenCalledExactlyOnceWith(child, true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects if forced termination fails or if the process refuses to exit after forced shutdown', async () => {
        vi.useFakeTimers();
        const { child: stubbornChild, stdoutChunks: s1, stderrChunks: e1 } = createChildFixture();
        const pendingTimeout = runBoundedElectronProcess({
            executablePath: 'code',
            args: [],
            resultFile: '/tmp/result.json',
            graceMs: 30,
            pollIntervalMs: 10,
            overallTimeoutMs: 500,
            forceKillWaitMs: 25,
            warn: vi.fn(),
            ...makeFakeOutputs(s1, e1),
            spawnProcess: () => stubbornChild,
            readResultFile: () => ({ status: 'passed', failures: 0 }),
            terminateProcess: vi.fn(),
        });
        const stubbornAssert = expect(pendingTimeout).rejects.toThrow('did not exit after forced shutdown');
        await vi.advanceTimersByTimeAsync(70);
        await stubbornAssert;
        expect(vi.getTimerCount()).toBe(0);

        const { child: errChild, stdoutChunks: s2, stderrChunks: e2 } = createChildFixture();
        const killFailure = new Error('EPERM kill failed');
        const pendingErr = runBoundedElectronProcess({
            executablePath: 'code',
            args: [],
            resultFile: '/tmp/result.json',
            graceMs: 30,
            pollIntervalMs: 10,
            overallTimeoutMs: 500,
            forceKillWaitMs: 25,
            warn: vi.fn(),
            ...makeFakeOutputs(s2, e2),
            spawnProcess: () => errChild,
            readResultFile: () => ({ status: 'passed', failures: 0 }),
            terminateProcess: vi.fn(() => Promise.reject(killFailure)),
        });
        const errAssert = expect(pendingErr).rejects.toBe(killFailure);
        await vi.advanceTimersByTimeAsync(45);
        await errAssert;
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        ['graceMs', 0],
        ['pollIntervalMs', -5],
        ['overallTimeoutMs', Number.NaN],
        ['forceKillWaitMs', Number.POSITIVE_INFINITY],
    ])('rejects invalid %s bound (%s) before spawning', async (field, badValue) => {
        const spawnProcess = vi.fn();
        await expect(runBoundedElectronProcess({
            executablePath: 'code',
            args: [],
            resultFile: '/tmp/result.json',
            [field]: badValue,
            spawnProcess,
        })).rejects.toThrow(`${field} must be a positive finite number`);
        expect(spawnProcess).not.toHaveBeenCalled();
    });

    it('stops gracefully on first SIGINT when the child honors termination', async () => {
        vi.useFakeTimers();
        const { child, stdoutChunks, stderrChunks } = createChildFixture();
        const signals = new EventEmitter();
        const terminateProcess = vi.fn(() => {
            child.emitExit(null, 'SIGINT');
        });

        const pending = runBoundedElectronProcess({
            executablePath: 'code',
            args: [],
            resultFile: '/tmp/result.json',
            graceMs: 100,
            pollIntervalMs: 25,
            overallTimeoutMs: 1000,
            forceKillWaitMs: 50,
            signalSource: signals,
            ...makeFakeOutputs(stdoutChunks, stderrChunks),
            spawnProcess: () => child,
            readResultFile: () => undefined,
            terminateProcess,
        });

        signals.emit('SIGINT');
        await expect(pending).rejects.toThrow('VS Code test run interrupted by SIGINT');
        expect(terminateProcess).toHaveBeenCalledExactlyOnceWith(child, false);
        expect(vi.getTimerCount()).toBe(0);
        expect(signals.listenerCount('SIGINT')).toBe(0);
        expect(signals.listenerCount('SIGTERM')).toBe(0);
    });

    it('escalates SIGTERM to forced termination after graceMs if the child ignores graceful shutdown', async () => {
        vi.useFakeTimers();
        const { child, stdoutChunks, stderrChunks } = createChildFixture();
        const signals = new EventEmitter();
        const warn = vi.fn();
        const terminateProcess = vi.fn((_c: ElectronChildProcess, force: boolean) => {
            if (force) {
                child.emitExit(null, 'SIGKILL');
            }
        });

        const pending = runBoundedElectronProcess({
            executablePath: 'code',
            args: [],
            resultFile: '/tmp/result.json',
            graceMs: 80,
            pollIntervalMs: 20,
            overallTimeoutMs: 1000,
            forceKillWaitMs: 50,
            warn,
            signalSource: signals,
            ...makeFakeOutputs(stdoutChunks, stderrChunks),
            spawnProcess: () => child,
            readResultFile: () => undefined,
            terminateProcess,
        });

        signals.emit('SIGTERM');
        await vi.advanceTimersByTimeAsync(79);
        expect(terminateProcess).toHaveBeenCalledExactlyOnceWith(child, false);

        const expectation = expect(pending).rejects.toThrow('VS Code test run interrupted by SIGTERM');
        await vi.advanceTimersByTimeAsync(1);
        await expectation;
        expect(terminateProcess).toHaveBeenCalledTimes(2);
        expect(terminateProcess).toHaveBeenNthCalledWith(1, child, false);
        expect(terminateProcess).toHaveBeenNthCalledWith(2, child, true);
        expect(warn).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        expect(signals.listenerCount('SIGINT')).toBe(0);
        expect(signals.listenerCount('SIGTERM')).toBe(0);
    });

    it('immediately escalates repeated SIGINT before graceMs expires', async () => {
        vi.useFakeTimers();
        const { child, stdoutChunks, stderrChunks } = createChildFixture();
        const signals = new EventEmitter();
        const warn = vi.fn();
        const terminateProcess = vi.fn((_c: ElectronChildProcess, force: boolean) => {
            if (force) {
                child.emitExit(null, 'SIGKILL');
            }
        });

        const pending = runBoundedElectronProcess({
            executablePath: 'code',
            args: [],
            resultFile: '/tmp/result.json',
            graceMs: 500,
            pollIntervalMs: 50,
            overallTimeoutMs: 5000,
            forceKillWaitMs: 50,
            warn,
            signalSource: signals,
            ...makeFakeOutputs(stdoutChunks, stderrChunks),
            spawnProcess: () => child,
            readResultFile: () => undefined,
            terminateProcess,
        });

        signals.emit('SIGINT');
        signals.emit('SIGINT');
        await expect(pending).rejects.toThrow('VS Code test run interrupted by SIGINT');
        expect(terminateProcess).toHaveBeenCalledTimes(2);
        expect(terminateProcess).toHaveBeenNthCalledWith(1, child, false);
        expect(terminateProcess).toHaveBeenNthCalledWith(2, child, true);
        expect(warn).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        expect(signals.listenerCount('SIGINT')).toBe(0);
        expect(signals.listenerCount('SIGTERM')).toBe(0);
    });

    it('rejects if child ignores both graceful and forced termination after interrupt', async () => {
        vi.useFakeTimers();
        const { child, stdoutChunks, stderrChunks } = createChildFixture();
        const signals = new EventEmitter();
        const terminateProcess = vi.fn();

        const pending = runBoundedElectronProcess({
            executablePath: 'code',
            args: [],
            resultFile: '/tmp/result.json',
            graceMs: 40,
            pollIntervalMs: 10,
            overallTimeoutMs: 1000,
            forceKillWaitMs: 30,
            warn: vi.fn(),
            signalSource: signals,
            ...makeFakeOutputs(stdoutChunks, stderrChunks),
            spawnProcess: () => child,
            readResultFile: () => undefined,
            terminateProcess,
        });

        signals.emit('SIGINT');
        const expectation = expect(pending).rejects.toThrow('did not exit after forced shutdown');
        await vi.advanceTimersByTimeAsync(75);
        await expectation;
        expect(terminateProcess).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
        expect(signals.listenerCount('SIGINT')).toBe(0);
        expect(signals.listenerCount('SIGTERM')).toBe(0);
    });
});
