import { ESLint } from 'eslint';
import { expect, it } from 'vitest';

const lint = new ESLint();
it.each([
    ['async executor', 'new Promise(async resolve => { resolve(1); });', 'no-async-promise-executor'],
    ['NaN equality', 'export const invalid = value => value === NaN;', 'use-isnan'],
    ['invalid typeof', 'export const invalid = value => typeof value === "strnig";', 'valid-typeof'],
    ['sparse array', 'export const values = [1,,3];', 'no-sparse-arrays'],
    ['unsafe finally', 'export function f() { try { throw Error(); } finally { return 1; } }', 'no-unsafe-finally'],
])('rejects %s in active TypeScript', async (_name, source, rule) => {
    const [result] = await lint.lintText(source, { filePath: 'src/harness/lint-probe.ts' });
    expect(result.messages.map(message => message.ruleId)).toContain(rule);
    expect(result.errorCount).toBeGreaterThan(0);
});
it('accepts typed async code with error propagation and cleanup', async () => {
    const [result] = await lint.lintText(`export async function load(read: () => Promise<number>, clean: () => void): Promise<number> {
        try { return await read(); } finally { clean(); }
    }`, { filePath: 'src/harness/lint-probe.ts' });
    expect(result.messages).toEqual([]);
});
