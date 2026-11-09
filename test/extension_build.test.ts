import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { instrumentSource } from '../scripts/source-instrumentation.cjs';

const script = readFileSync('vscode-extension/scripts/build-extension.js', 'utf8');
function loader(coverage = true) {
    let options: any;
    let load: ((args: { path: string }) => any) | undefined;
    const read = vi.fn(() => 'export const value: number = 1;');
    runInNewContext(script, {
        process: { env: coverage ? { SLATE_SOURCE_COVERAGE: '1' } : {} }, console,
        require(name: string) {
            if (name === 'esbuild') return { build(value: unknown) { options = value; return Promise.resolve(); } };
            if (name === 'node:fs') return { readFileSync: read };
            if (name === '../../scripts/source-instrumentation.cjs') return { instrumentSource };
            throw new Error(`Unexpected module: ${name}`);
        },
    });
    for (const plugin of options.plugins) plugin.setup({ onLoad(_filter: unknown, callback: typeof load) { load = callback; } });
    return { load, read };
}
it.each(['/repo/vscode-extension/src/extension.ts', 'C:\\repo\\vscode-extension\\src\\extension.ts'])('instruments native source paths: %s', path => {
    const { load, read } = loader();
    expect(load!({ path })).toEqual({ contents: expect.stringContaining('__coverage__'), loader: 'ts' });
    expect(read).toHaveBeenCalledWith(path, 'utf8');
});
it.each([
    '/repo/vscode-extension/src/test/suite/index.ts', 'C:\\repo\\vscode-extension\\src\\test\\suite\\index.ts',
    '/repo/node_modules/dependency.ts', 'C:\\repo\\node_modules\\dependency.ts',
])('excludes tests and dependencies: %s', path => {
    const { load, read } = loader();
    expect(load!({ path })).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
});
it('does not instrument normal extension builds', () => {
    const { load, read } = loader(false);
    expect(load).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
});
it('propagates source read errors instead of silently omitting coverage', () => {
    const { load, read } = loader();
    read.mockImplementation(() => { throw new Error('read failed'); });
    expect(() => load!({ path: '/repo/vscode-extension/src/extension.ts' })).toThrow('read failed');
});
