import { afterEach, describe, expect, it, vi } from 'vitest';
import { sourceCoveragePlugin } from '../scripts/coverage-vite-plugin.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourcePath, isActiveSource, activeSources, sourceFingerprint, requireCompleteCoverage } from '../scripts/coverage-scope.mjs';

const nativeRepoRoot = join(tmpdir(), 'slate-repo');

describe('coverage source inventory', () => {
    it.each([
        ['/repo/src/harness/main.tsx', '/repo', 'src/harness/main.tsx'],
        ['file:///repo/vscode-extension/src/flow.ts', '/repo', 'vscode-extension/src/flow.ts'],
        ['file:///repo/scripts/coverage%20scope.mjs', '/repo/', 'scripts/coverage scope.mjs'],
        [pathToFileURL(join(nativeRepoRoot, 'scripts', 'coverage scope.mjs')).href, `${nativeRepoRoot}\\`, 'scripts/coverage scope.mjs'],
        ['file:///repo/scripts%2Fcoverage-scope.mjs', '/repo/', 'scripts/coverage-scope.mjs'],
        ['http://localhost:4178/harness/main.tsx', '/repo', 'src/harness/main.tsx'],
        ['/repo/src/harness/palette.ts?x=1', '/repo', 'src/harness/palette.ts'],
        ['/repo/scripts/coverage-scope.mjs', '/repo///', 'scripts/coverage-scope.mjs'],
        ['C:\\repo\\scripts\\coverage-scope.mjs', 'C:\\repo\\', 'scripts/coverage-scope.mjs'],
        ['C:\\repo\\src\\harness\\palette.ts', '/repo', 'src/harness/palette.ts'],
    ])('normalizes %s against %s', (value, root, expected) => expect(sourcePath(value, root)).toBe(expected));
    it.each([
        ['src/harness/main.tsx', true], ['vscode-extension/src/extension.ts', true],
        ['vscode-extension/src/test/runTest.ts', false], ['src/harness/types.d.ts', false],
        ['legacy/src/app.js', false], ['src/harness/styles.css', false],
        ['src/harness/../outside.ts', false], ['vendor/not-src/harness/fake.ts', false],
        ['node_modules/dependency.ts', false],
    ])('scopes %s', (value, expected) => expect(isActiveSource(value)).toBe(expected));
    it('includes unexecuted host and UI sources and rejects omitted files', () => {
        const root = mkdtempSync(join(tmpdir(), 'slate-coverage-test-'));
        try {
            for (const name of ['src/harness/main.tsx', 'src/harness/nested/helper.ts',
                'vscode-extension/src/extension.ts', 'vscode-extension/src/test/fixture.ts', 'src/harness/style.css']) {
                const full = join(root, name);
                mkdirSync(join(full, '..'), { recursive: true });
                writeFileSync(full, '');
            }
            const expected = activeSources(root);
            expect(expected).toEqual(['src/harness/main.tsx', 'src/harness/nested/helper.ts', 'vscode-extension/src/extension.ts']);
            expect(() => requireCompleteCoverage({}, expected)).toThrow('Missing product sources');
            expect(() => requireCompleteCoverage(Object.fromEntries(expected.map(name => [name, {}])), expected)).not.toThrow();
            expect(() => requireCompleteCoverage({ 'src/harness/main.tsx': {} }, expected)).toThrow('vscode-extension/src/extension.ts');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('fails when source roots are missing instead of claiming an empty scope', () => {
        expect(() => activeSources('/nonexistent/slate-coverage-test')).toThrow();
    });
});

import vm from 'node:vm';
import { instrumentSource } from '../scripts/source-instrumentation.cjs';
import { mergeRunnerCoverage, generateCoverage } from '../scripts/coverage-report.mjs';

describe('shared instrumentation and aggregation', () => {
    it('instruments TypeScript and JSX with stable source counters', () => {
        const source = 'export function label(value: string) { return <span>{value}</span>; }';
        const first = instrumentSource(source, '/repo/src/harness/main.tsx');
        const second = instrumentSource(source, '/repo/src/harness/main.tsx');
        expect(first.coverage).toEqual(second.coverage);
        expect(first.code).toContain('__coverage__');
        expect(Object.keys(first.coverage.fnMap)).toHaveLength(1);
        expect(first.map.sources).toContain('main.tsx');
        expect(() => instrumentSource('function {', '/repo/src/harness/bad.ts')).toThrow();
    });
    it('merges complementary execution without dropping unexecuted source and fails closed on missing or stale data', () => {
        const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const root = mkdtempSync(join(tmpdir(), 'slate-coverage-test-'));
        try {
            mkdirSync(join(root, 'src/harness'), { recursive: true });
            mkdirSync(join(root, 'vscode-extension/src'), { recursive: true });
            const filename = join(root, 'src/harness/palette.ts');
            const source = 'function choose(value) { if (value) return 1; return 2; }';
            writeFileSync(filename, source);
            mkdirSync(join(root, 'coverage'), { recursive: true });
            const manifest = () => writeFileSync(join(root, 'coverage/source-manifest.json'), JSON.stringify(sourceFingerprint(root)));
            manifest();
            const writeRun = (runner: string, call: string) => {
                const context = vm.createContext({});
                vm.runInContext(instrumentSource(source, filename).code + call, context);
                mkdirSync(join(root, 'coverage', runner), { recursive: true });
                writeFileSync(join(root, 'coverage', runner, 'run.json'), JSON.stringify(context.__coverage__));
                writeFileSync(join(root, 'coverage', runner, '.passed'), '');
            };
            expect(() => mergeRunnerCoverage(root)).toThrow('Missing runner coverage');
            writeRun('unit', '; choose(true);');
            writeRun('browser', '; choose(false);');
            writeRun('native', '; choose(true);');
            rmSync(join(root, 'coverage', 'native', '.passed'));
            expect(() => mergeRunnerCoverage(root)).toThrow('successful completion marker');
            writeFileSync(join(root, 'coverage', 'native', '.passed'), '');
            const result = generateCoverage(root, true);
            for (const metric of ['lines', 'functions', 'statements', 'branches']) expect(result[metric].pct).toBe(100);
            writeFileSync(join(root, 'vscode-extension/src/untested.ts'), 'export function untouched() { return 3; }');
            manifest();
            expect(mergeRunnerCoverage(root).files()).toContain(join(root, 'vscode-extension/src/untested.ts'));
            expect(() => generateCoverage(root, true)).toThrow('100% coverage target not reached');
            writeFileSync(filename, source.replace('return 1', 'return 9'));
            expect(() => mergeRunnerCoverage(root)).toThrow('Stale or incompatible coverage');
            writeFileSync(filename, source);
            writeFileSync(join(root, 'coverage/unit/run.json'), '{bad');
            expect(() => mergeRunnerCoverage(root)).toThrow();
        } finally {
            output.mockRestore();
            rmSync(root, { recursive: true, force: true });
        }
    });
});


describe('coverage Vite integration', () => {
    afterEach(() => vi.unstubAllEnvs());
    it('leaves normal builds and non-product files untouched', () => {
        const plugin = sourceCoveragePlugin();
        vi.stubEnv('SLATE_SOURCE_COVERAGE', '');
        expect(plugin.transform('const value = 1;', '/repo/src/harness/probe.ts')).toBeUndefined();
        vi.stubEnv('SLATE_SOURCE_COVERAGE', '1');
        expect(plugin.transform('body {}', '/repo/src/harness/styles.css')).toBeUndefined();
        expect(plugin.transform('const value = 1;', '/repo/vscode-extension/src/test/probe.ts')).toBeUndefined();
    });
    it('instruments source requests consistently and preserves runtime results', () => {
        vi.stubEnv('SLATE_SOURCE_COVERAGE', '1');
        const source = 'globalThis.result = 4 + 5;';
        const plugin = sourceCoveragePlugin();
        const result = plugin.transform(source, '/repo/src/harness/probe.ts?cache=1');
        expect(result.map.sources).toContain('probe.ts');
        const context = vm.createContext({});
        vm.runInContext(result.code, context);
        expect(context.result).toBe(9);
        expect(Object.values(context.__coverage__['/repo/src/harness/probe.ts'].s)).toEqual([1]);
        expect(() => plugin.transform('export {', '/repo/src/harness/probe.ts')).toThrow();
    });
});
