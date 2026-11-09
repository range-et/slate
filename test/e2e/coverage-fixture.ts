import { test as base } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export { expect, type Page, type Locator } from '@playwright/test';
export const test = base.extend<{ sourceCoverage: void }>({
    sourceCoverage: [async ({ page }, use, testInfo) => {
        if (!process.env.SLATE_SOURCE_COVERAGE) return use();
        try {
            await use();
        } finally {
            const data = await page.evaluate(() => (window as unknown as { __coverage__?: unknown }).__coverage__);
            if (!data) throw new Error('Browser source instrumentation is missing');
            const directory = 'coverage/browser';
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, `${testInfo.testId}-${testInfo.retry}.json`), JSON.stringify(data));
        }
    }, { auto: true }],
});
