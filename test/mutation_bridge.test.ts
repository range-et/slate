import { afterEach, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { mutationBridgePlugin } from '../scripts/mutation-vite-plugin.mjs';

const bridge = () => mutationBridgePlugin().transformIndexHtml.handler();
afterEach(() => vi.unstubAllEnvs());

it('adds no mutation code to ordinary pages or Stryker dry runs', () => {
    vi.stubEnv('__STRYKER_ACTIVE_MUTANT__', undefined);
    expect(bridge()).toEqual([]);
});

it.each(['', '-1', '3.5', '</script><script>alert(1)</script>', 'undefined'])('rejects invalid mutation ID %s', value => {
    vi.stubEnv('__STRYKER_ACTIVE_MUTANT__', value);
    expect(bridge).toThrow('Invalid Stryker active mutant ID');
});

it('activates real Stryker instrumentation without Node globals and preserves the existing namespace', async () => {
    const noop = () => {};
    const disabled = () => false;
    const instrumenter = new Instrumenter({
        trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
        isTraceEnabled: disabled, isDebugEnabled: disabled, isInfoEnabled: disabled,
        isWarnEnabled: disabled, isErrorEnabled: disabled, isFatalEnabled: disabled,
    });
    const result = await instrumenter.instrument([
        { name: '/probe.js', content: 'globalThis.result = 4 + 5;', mutate: true },
    ], { plugins: null, excludedMutations: [], ignorers: [] });
    const mutant = result.mutants.find(item => item.mutatorName === 'ArithmeticOperator')!;
    expect(mutant).toBeDefined();
    const baseline = vm.createContext({});
    vm.runInContext(result.files[0].content, baseline);
    expect(baseline.result).toBe(9);
    vi.stubEnv('__STRYKER_ACTIVE_MUTANT__', mutant.id);
    const [script] = bridge();
    expect(script).toMatchObject({ tag: 'script', injectTo: 'head-prepend' });
    const browser = vm.createContext({ __stryker__: { preserved: true } });
    vm.runInContext(script.children, browser);
    vm.runInContext(result.files[0].content, browser);
    expect(browser.result).toBe(-1);
    expect(browser.__stryker__.preserved).toBe(true);
    expect(browser.__stryker__.activeMutant).toBe(mutant.id);
});

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepareSystemSandbox } from '../scripts/prepare-system-mutation.mjs';

it('shares only installed tools and the editor cache, refusing the original repository or conflicting directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-system-mutation-'));
    try {
        const sandbox = path.join(root, '.stryker-tmp/system/sandbox');
        fs.mkdirSync(path.join(sandbox, 'vscode-extension'), { recursive: true });
        fs.mkdirSync(path.join(root, 'node_modules'));
        for (const dir of ['node_modules', '.vscode-test']) fs.mkdirSync(path.join(root, 'vscode-extension', dir), { recursive: true });
        expect(() => prepareSystemSandbox(undefined, sandbox)).toThrow('SLATE_MUTATION_ROOT');
        expect(() => prepareSystemSandbox(root, root)).toThrow('Stryker sandbox');
        fs.mkdirSync(path.join(root, 'outside'));
        expect(() => prepareSystemSandbox(root, path.join(root, 'outside'))).toThrow('Stryker sandbox');
        prepareSystemSandbox(root, sandbox);
        prepareSystemSandbox(root, sandbox);
        expect(fs.realpathSync(path.join(sandbox, 'node_modules'))).toBe(fs.realpathSync(path.join(root, 'node_modules')));
        for (const dir of ['node_modules', '.vscode-test']) {
            expect(fs.realpathSync(path.join(sandbox, 'vscode-extension', dir))).toBe(fs.realpathSync(path.join(root, 'vscode-extension', dir)));
        }
        const modules = path.join(sandbox, 'vscode-extension/node_modules');
        fs.unlinkSync(modules);
        fs.mkdirSync(modules);
        fs.writeFileSync(path.join(modules, 'keep'), 'keep');
        expect(() => prepareSystemSandbox(root, sandbox)).toThrow('Refusing to replace');
        expect(fs.readFileSync(path.join(modules, 'keep'), 'utf8')).toBe('keep');
        fs.rmSync(modules, { recursive: true });
        fs.rmSync(path.join(root, 'vscode-extension/node_modules'), { recursive: true });
        expect(() => prepareSystemSandbox(root, sandbox)).toThrow();
        fs.writeFileSync(path.join(root, 'vscode-extension/node_modules'), 'not a directory');
        expect(() => prepareSystemSandbox(root, sandbox)).toThrow('Required tool directory is missing');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
