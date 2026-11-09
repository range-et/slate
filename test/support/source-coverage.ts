import { afterAll, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

afterAll(() => {
    const coverage = (globalThis as typeof globalThis & { __coverage__?: unknown }).__coverage__;
    if (!coverage) return;
    const directory = resolve('coverage/unit');
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, `${basename(expect.getState().testPath!)}.json`), JSON.stringify(coverage));
});
