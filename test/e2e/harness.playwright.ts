import { expect, test } from '@playwright/test';

test('guided search returns provenance and reveals by durable unit id', async ({ page }) => {
    await page.addInitScript(() => {
        const messages: unknown[] = [];
        Object.defineProperty(window, '__slateHostMessages', { value: messages });
        window.acquireVsCodeApi = () => ({
            postMessage(message: unknown) {
                messages.push(message);
                const value = message as { type?: string; query?: string };
                if (value.type !== 'search') return;
                window.setTimeout(() => window.postMessage({
                    type: 'searchResults',
                    query: value.query,
                    stale: false,
                    results: [{
                        unitId: 'durable-run',
                        path: 'calculator.py',
                        qualifiedName: 'run',
                        signature: 'def run(value: int) -> int',
                        snippet: 'return execute(config)',
                        reason: 'source',
                        score: 52,
                    }],
                }, '*'), 0);
            },
        });
    });
    await page.goto('/harness.html?demo');

    const action = page.getByLabel('Slate action');
    await action.fill('/search');
    await action.press('Enter');
    await expect(page.getByLabel('Search indexed code')).toBeFocused();
    await expect(page.getByText('SEARCH: what should Slate find?')).toBeVisible();

    const search = page.getByLabel('Search indexed code');
    await search.fill('execute(config)');
    await search.press('Enter');
    await expect(page.getByRole('region', { name: 'Search results for execute(config)' })).toBeVisible();
    await expect(page.getByRole('button', { name: /run.*source/i })).toContainText('calculator.py');

    await page.getByRole('button', { name: /run.*source/i }).click();
    const messages = await page.evaluate(() => (window as unknown as { __slateHostMessages: unknown[] }).__slateHostMessages);
    expect(messages).toContainEqual({ type: 'reveal', unitId: 'durable-run', focus: false });
});

test('context packet and confined llama.cpp proposal stay in one workbench', async ({ page }) => {
    await page.addInitScript(() => {
        window.acquireVsCodeApi = () => ({
            postMessage(message: unknown) {
                const value = message as { type?: string; unitId?: string };
                if (value.type === 'packetPreview' && value.unitId) {
                    window.setTimeout(() => window.postMessage({
                        type: 'packetPreview', unitId: value.unitId,
                        packet: {
                            items: [
                                { id: value.unitId, path: 'calculator.py', qualifiedName: 'run', role: 'target', sourceHash: 'sha256:demo', characters: 86 },
                                { id: 'durable-add', path: 'operations.py', qualifiedName: 'Operations.add', role: 'required-context', sourceHash: 'sha256:demo', characters: 74 },
                            ],
                            estimatedInputTokens: 312, inputBudgetTokens: 3328, outputBudgetTokens: 768,
                        },
                    }, '*'), 0);
                }
                if (value.type === 'generate' && value.unitId) {
                    window.postMessage({ type: 'generationStarted', unitId: value.unitId, message: 'Sent 2 exact source units to http://127.0.0.1:8080.' }, '*');
                    window.setTimeout(() => window.postMessage({
                        type: 'proposalReady',
                        proposal: {
                            id: 'proposal-1', unitId: value.unitId, path: 'calculator.py',
                            candidate: 'def run(value: int) -> int:\n    return value + 1',
                            checks: ['Valid Python', 'Exactly one function', 'Name and signature preserved', 'Edit confined to owned function'],
                        },
                    }, '*'), 10);
                }
            },
        });
    });
    await page.goto('/harness.html?demo');
    await page.getByText('run', { exact: true }).click();
    const packet = page.locator('.packet-preview');
    await expect(packet.getByRole('heading', { name: 'Exact packet' })).toBeVisible();
    await expect(packet.getByText('Operations.add')).toBeVisible();
    await page.getByRole('button', { name: 'Generate with llama.cpp' }).click();
    await expect(page.getByRole('heading', { name: 'Confined proposal' })).toBeVisible();
    await expect(page.getByText('Edit confined to owned function')).toBeVisible();
    await page.locator('.proposal-review').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/context-workbench.png' });
});

test('board context menus, board-only notes, and trackpad-style panning work', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
    await page.addInitScript(() => {
        const messages: unknown[] = [];
        Object.defineProperty(window, '__slateHostMessages', { value: messages });
        window.acquireVsCodeApi = () => ({ postMessage(message: unknown) { messages.push(message); } });
    });
    await page.goto('/harness.html?demo');

    await page.getByText('run', { exact: true }).click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'function actions' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Add note attached here' })).toBeVisible();
    await page.keyboard.press('Escape');

    const note = page.locator('.slate-node--note');
    await note.click({ button: 'right' });
    expect(pageErrors).toEqual([]);
    await page.getByRole('menuitem', { name: 'Edit board note' }).click();
    await expect(page.getByLabel('Note body')).toHaveValue('Should run clamp values before calling Operations.add?');
    await expect(page.getByText('never modify Python source')).toBeVisible();

    const pane = page.locator('.react-flow__pane');
    const box = await pane.boundingBox();
    if (!box) throw new Error('Graph pane did not render.');
    await page.mouse.click(box.x + 20, box.y + 20, { button: 'right' });
    await expect(page.getByRole('menu', { name: 'Board actions' })).toBeVisible();
    await page.screenshot({ path: 'test-results/board-notes-context-menu.png' });
    await page.getByRole('menuitem', { name: 'New board note' }).click();
    const messages = await page.evaluate(() => (window as unknown as { __slateHostMessages: unknown[] }).__slateHostMessages);
    expect(messages).toContainEqual(expect.objectContaining({ type: 'noteCreate', attachedTo: null, revision: 1 }));

    const viewport = page.locator('.react-flow__viewport');
    const before = await viewport.getAttribute('style');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(90, 70);
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(before);
});
