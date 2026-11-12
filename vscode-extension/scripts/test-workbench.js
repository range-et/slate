const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { closeTestApplication } = require('./close-test-application.cjs');

const { _electron: electron } = require('playwright');
const { expect } = require('@playwright/test');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

async function main() {
    const extensionRoot = path.resolve(__dirname, '..');
    const fixture = path.join(extensionRoot, 'test-fixtures', 'electron');
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-workbench-'));
    // Native prompt QA writes real files; never mutate the checked-in fixture.
    const workspace = path.join(userData, 'workspace');
    fs.cpSync(fixture, workspace, { recursive: true });
    const executablePath = await downloadAndUnzipVSCode('1.139.0');
    const candidate = 'def normalize(score: int, maximum: int) -> int:\n    return score * 100 // maximum';
    const requests = [];
    const server = http.createServer((request, response) => {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            requests.push(JSON.parse(body));
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: candidate } }] })}\n\n`);
            response.end('data: [DONE]\n\n');
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let app;
    let page;
    try {
        app = await electron.launch({
            executablePath,
            env: { ...process.env, SLATE_QA_LLAMA_ENDPOINT: `http://127.0.0.1:${server.address().port}` },
            args: [
                workspace,
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
        page = await app.firstWindow();
        page.setDefaultTimeout(10_000);
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
        await harnessFrame.locator('.react-flow__node').first().waitFor();
        for (const notificationClose of await page.getByRole('button', { name: /(?:clear|close) notification/i }).all()) {
            await notificationClose.click();
        }
        const command = async label => {
            console.log(`Workbench QA: ${label}`);
            await harnessFrame.getByRole('button', { name: 'Compose', exact: true }).click();
            await page.keyboard.press('Control+k');
            await harnessFrame.getByLabel('Command palette input').fill(label);
            await harnessFrame.getByRole('option').filter({ has: harnessFrame.getByText(label, { exact: true }) }).click();
        };
        const prompt = page.locator('.quick-input-widget:visible input');
        const promptMessage = page.locator('.quick-input-message');
        const enterSignature = async () => {
            // Observe a complete validation cycle before accepting the prompt.
            // Visibility alone does not prove that the native prompt has
            // processed the current value. Keep error-to-valid checks explicit.
            await expect(promptMessage).toContainText('Typed function signature');
            await prompt.fill('not a function');
            await expect(promptMessage).toContainText('enter one function signature');
            await prompt.fill('def qa_native(value: int) -> int');
            await expect(promptMessage).toContainText('Typed function signature');
            await expect(prompt).toHaveValue('def qa_native(value: int) -> int');
            await prompt.press('Enter');
            await expect(promptMessage).toContainText('Intent (what it should do)');
        };
        const readJson = file => {
            try {
                return JSON.parse(fs.readFileSync(file, 'utf8'));
            } catch {
                return null;
            }
        };
        const project = path.join(workspace, 'folder_project');
        const nodeFile = path.join(project, 'slate', 'nodes', 'qa_native.json');
        const beforeNodes = fs.readdirSync(path.dirname(nodeFile)).sort();

        // End-to-end: real webview buttons -> Extension Host -> fake HTTP model ->
        // WorkspaceEdit/save -> native Undo -> Save. No injected host messages.
        const normalizeFile = path.join(project, 'slate', 'nodes', 'normalize.json');
        const normalizeBefore = JSON.parse(fs.readFileSync(normalizeFile, 'utf8'));
        await command('normalize');
        const generate = harnessFrame.getByRole('button', { name: 'Generate with llama.cpp', exact: true });
        await expect(generate).toBeEnabled();
        await generate.click();
        await expect(harnessFrame.getByRole('button', { name: 'Accept WorkspaceEdit', exact: true })).toBeEnabled();
        expect(JSON.parse(fs.readFileSync(normalizeFile, 'utf8'))).toEqual(normalizeBefore);
        await harnessFrame.getByRole('button', { name: 'Accept WorkspaceEdit', exact: true }).click();
        await expect.poll(() => readJson(normalizeFile)?.code).toEqual(candidate.split('\n'));
        expect(requests).toHaveLength(1);
        expect(requests[0].messages[1].content).toContain('def clamp(');
        await harnessFrame.getByRole('button', { name: 'Undo accepted edit', exact: true }).click();
        await expect(harnessFrame.getByRole('status')).toContainText('UNDO: reverted');
        await command('Save all files');
        await expect.poll(() => readJson(normalizeFile)).toEqual(normalizeBefore);

        // Exercise VS Code's actual validation UI and Escape, not a mocked input box.
        await command('New node file…');
        await expect(prompt).toBeVisible();
        await prompt.fill('this is not a function');
        await expect(page.locator('.quick-input-message')).toContainText('enter one function signature');
        await prompt.press('Enter');
        await expect(prompt).toBeVisible();
        await prompt.press('Escape');
        await expect(prompt).toHaveCount(0);
        expect(fs.readdirSync(path.dirname(nodeFile)).sort()).toEqual(beforeNodes);

        // Cancelling the intent prompt must also leave the project unchanged.
        await command('New node file…');
        await enterSignature();
        await prompt.press('Escape');
        await expect(prompt).toHaveCount(0);
        expect(fs.existsSync(nodeFile)).toBe(false);

        // Confirm both prompts, then assert the visible node and saved source file.
        await command('New node file…');
        await enterSignature();
        await prompt.fill('Return the supplied value');
        await prompt.press('Enter');
        await expect(harnessFrame.locator('.react-flow__node[data-id="qa_native"]')).toBeVisible();
        expect(JSON.parse(fs.readFileSync(nodeFile, 'utf8'))).toMatchObject({
            name: 'qa_native', intent: 'Return the supplied value',
            code: ['def qa_native(value: int) -> int:', '    raise NotImplementedError'],
        });

        // The real flow-name prompt prevents invalid names and respects cancellation.
        await command('New flow…');
        await prompt.fill('not-a-name');
        await expect(page.locator('.quick-input-message')).toContainText('Use a Python identifier');
        await prompt.press('Escape');
        await expect(prompt).toHaveCount(0);
        expect(fs.existsSync(path.join(project, 'slate', 'flows', 'not-a-name.json'))).toBe(false);
        await command('New flow…');
        await prompt.fill('qa_flow');
        await prompt.press('Enter');
        await expect(harnessFrame.locator('.react-flow__node[data-id="flow:qa_flow"]')).toBeVisible();
        expect(JSON.parse(fs.readFileSync(path.join(project, 'slate', 'flows', 'qa_flow.json'), 'utf8')).name).toBe('qa_flow');
        console.log('Workbench QA passed: real Generate/Accept/Undo/Save, native validation/cancel, node/flow creation and persisted files.');
        fs.mkdirSync(path.resolve(extensionRoot, '..', 'test-results'), { recursive: true });
        await page.screenshot({ path: path.resolve(extensionRoot, '..', 'test-results', 'vscode-workbench.png') });
    } catch (error) {
        if (page && !page.isClosed()) {
            fs.mkdirSync(path.resolve(extensionRoot, '..', 'test-results'), { recursive: true });
            await page.screenshot({ path: path.resolve(extensionRoot, '..', 'test-results', 'vscode-workbench-failure.png') }).catch(() => {});
        }
        throw error;
    } finally {
        if (app) await closeTestApplication(app);
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(userData, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
