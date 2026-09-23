const fs = require('fs');
const os = require('os');
const path = require('path');

const { _electron: electron } = require('playwright');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

async function main() {
    const extensionRoot = path.resolve(__dirname, '..');
    const fixture = path.join(extensionRoot, 'test-fixtures', 'electron');
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-workbench-'));
    const executablePath = await downloadAndUnzipVSCode('1.139.0');
    let app;
    try {
        app = await electron.launch({
            executablePath,
            args: [
                fixture,
                `--extensionDevelopmentPath=${extensionRoot}`,
                `--extensionTestsPath=${path.join(extensionRoot, 'out', 'test', 'workbench', 'index.js')}`,
                `--user-data-dir=${path.join(userData, 'user')}`,
                `--extensions-dir=${path.join(userData, 'extensions')}`,
                '--disable-workspace-trust',
                '--disable-updates',
                '--no-sandbox',
                '--disable-gpu-sandbox',
                '--skip-welcome',
                '--skip-release-notes',
            ],
        });
        const page = await app.firstWindow();
        await page.locator('.monaco-workbench').waitFor({ timeout: 20_000 });

        const deadline = Date.now() + 20_000;
        let harnessFrame;
        while (Date.now() < deadline) {
            for (const frame of page.frames()) {
                if (await frame.locator('.harness-shell').count()) {
                    harnessFrame = frame;
                    break;
                }
            }
            if (harnessFrame) break;
            await page.waitForTimeout(200);
        }
        if (!harnessFrame || !await harnessFrame.locator('.harness-shell').count()) {
            fs.mkdirSync(path.resolve(extensionRoot, '..', 'test-results'), { recursive: true });
            await page.screenshot({ path: path.resolve(extensionRoot, '..', 'test-results', 'vscode-workbench-failure.png') });
            console.error('Available workbench frames:', page.frames().map(frame => frame.url()));
            throw new Error('Slate Harness webview did not render in the VS Code workbench.');
        }
        await harnessFrame.getByLabel('Slate action').waitFor();
        for (const notificationClose of await page.getByRole('button', { name: /(?:clear|close) notification/i }).all()) {
            await notificationClose.click();
        }
        fs.mkdirSync(path.resolve(extensionRoot, '..', 'test-results'), { recursive: true });
        await page.screenshot({ path: path.resolve(extensionRoot, '..', 'test-results', 'vscode-workbench.png') });
    } finally {
        if (app) await app.close();
        fs.rmSync(userData, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
