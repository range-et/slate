import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './test/e2e',
    testMatch: '**/*.playwright.ts',
    timeout: 30_000,
    use: {
        baseURL: 'http://127.0.0.1:4178',
        viewport: { width: 1280, height: 800 },
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'npm run start -- --host 127.0.0.1 --port 4178',
        url: 'http://127.0.0.1:4178/harness.html?demo',
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
    },
});
