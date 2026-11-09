import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { closeTestApplication } from '../vscode-extension/scripts/close-test-application.cjs';

function fixture(close = () => Promise.resolve()) {
    const child = Object.assign(new EventEmitter(), {
        exitCode: null as number | null, signalCode: null as string | null,
        kill: vi.fn(function () { child.signalCode = 'SIGKILL'; child.emit('exit'); return true; }),
    });
    return { child, app: { process: () => child, close: vi.fn(close) } };
}
afterEach(() => vi.useRealTimers());

it('keeps normal shutdown and already-exited applications free of forced termination', async () => {
    const { child, app } = fixture();
    await closeTestApplication(app, 10);
    expect(app.close).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    child.exitCode = 0;
    await closeTestApplication(app, 10);
    expect(app.close).toHaveBeenCalledOnce();
});
it('bounds a stuck shutdown, kills only the owned child and removes its listener', async () => {
    vi.useFakeTimers();
    const { child, app } = fixture(() => new Promise(() => {}));
    const warn = vi.fn();
    const pending = closeTestApplication(app, 50, warn);
    await vi.advanceTimersByTimeAsync(49);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(warn).toHaveBeenCalledOnce();
    expect(child.listenerCount('exit')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});
it('preserves close failures rather than reporting them as successful cleanup', async () => {
    vi.useFakeTimers();
    const failure = new Error('Close failed');
    const { child, app } = fixture(() => Promise.reject(failure));
    await expect(closeTestApplication(app, 50)).rejects.toBe(failure);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
});
it('reports failure to terminate instead of pretending that the process exited', async () => {
    vi.useFakeTimers();
    const { child, app } = fixture(() => new Promise(() => {}));
    child.kill.mockReturnValue(false);
    const assertion = expect(closeTestApplication(app, 50, vi.fn())).rejects.toThrow('did not exit after forced shutdown');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(child.listenerCount('exit')).toBe(0);
});
it.each([0, -1, Infinity, NaN])('rejects invalid shutdown grace %s', async grace => {
    const { app } = fixture();
    await expect(closeTestApplication(app, grace)).rejects.toThrow('Shutdown grace must be positive');
    expect(app.close).not.toHaveBeenCalled();
});

it('does not kill a process that exits while graceful close is pending', async () => {
    vi.useFakeTimers();
    const { child, app } = fixture(() => new Promise(() => {}));
    const pending = closeTestApplication(app, 50);
    child.exitCode = 0;
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    expect(child.kill).not.toHaveBeenCalled();
});
it.each(['throw', 'event'])('propagates termination errors delivered by %s', async mode => {
    vi.useFakeTimers();
    const { child, app } = fixture(() => new Promise(() => {}));
    const failure = new Error('Termination refused');
    child.kill.mockImplementation(() => {
        if (mode === 'throw') throw failure;
        child.emit('error', failure);
        return false;
    });
    const assertion = expect(closeTestApplication(app, 50, vi.fn())).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});
