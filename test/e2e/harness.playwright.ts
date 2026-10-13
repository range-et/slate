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

    await page.keyboard.press('Control+k');
    const palette = page.getByLabel('Command palette input');
    await expect(palette).toBeFocused();
    await palette.fill('execute(config)');
    await page.getByRole('option', { name: /Search code for “execute\(config\)”/ }).click();
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

test('command palette selects a node and runs actions scoped to it; plain keys are not hijacked', async ({ page }) => {
    await page.addInitScript(() => {
        const messages: unknown[] = [];
        Object.defineProperty(window, '__slateHostMessages', { value: messages });
        window.acquireVsCodeApi = () => ({ postMessage(message: unknown) { messages.push(message); } });
    });
    await page.goto('/harness.html?demo=folder');
    await page.locator('.react-flow__pane').click();

    await page.keyboard.press('a');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);

    await page.keyboard.press('/');
    const palette = page.getByLabel('Command palette input');
    await palette.fill('normalize');
    await palette.press('Enter');
    await expect(page.getByRole('heading', { name: 'normalize_score' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);

    await page.keyboard.press('Control+k');
    await palette.fill('remove context');
    await expect(page.getByRole('listbox', { name: 'Commands' }).getByRole('option').first()).toContainText('Remove context: clamp');
    await palette.press('Enter');
    const messages = await page.evaluate(() => (window as unknown as { __slateHostMessages: unknown[] }).__slateHostMessages);
    expect(messages).toContainEqual(expect.objectContaining({
        type: 'action',
        action: { kind: 'setContext', consumer: 'scoring/normalize_score', dependency: 'clamp', enabled: false },
    }));
});

test('inline intent edits, wires, edge menu, and the context picker all post typed context actions', async ({ page }) => {
    await page.addInitScript(() => {
        const messages: unknown[] = [];
        Object.defineProperty(window, '__slateHostMessages', { value: messages });
        window.acquireVsCodeApi = () => ({ postMessage(message: unknown) { messages.push(message); } });
    });
    await page.goto('/harness.html?demo=folder');
    const actions = async () => (await page.evaluate(() => (window as unknown as { __slateHostMessages: Array<{ type: string; action?: unknown }> }).__slateHostMessages))
        .filter(message => message.type === 'action').map(message => message.action);

    const clamp = page.locator('.react-flow__node[data-id="clamp"]');
    await clamp.getByTitle('Click to edit intent').click();
    const editor = page.getByLabel('Edit intent');
    await editor.fill('Clamp into [lower, upper]');
    await editor.press('Enter');
    expect(await actions()).toContainEqual({ kind: 'setAnnotationField', target: 'clamp', field: 'intent', text: 'Clamp into [lower, upper]' });

    const from = await page.locator('.react-flow__node[data-id="scoring/normalize_score"] .react-flow__handle.source').boundingBox();
    const to = await clamp.locator('.react-flow__handle.target').boundingBox();
    if (!from || !to) throw new Error('handles did not render');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    expect(await actions()).toContainEqual({ kind: 'setContext', consumer: 'clamp', dependency: 'scoring/normalize_score', enabled: true });

    const edge = await page.locator('.slate-edge--context .react-flow__edge-interaction').first().boundingBox();
    if (!edge) throw new Error('context edge did not render');
    await page.mouse.click(edge.x + edge.width / 2, edge.y + edge.height / 2, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove context' }).click();
    expect(await actions()).toContainEqual({ kind: 'setContext', consumer: 'scoring/normalize_score', dependency: 'clamp', enabled: false });

    await page.locator('.react-flow__node[data-id="scoring/normalize_score"]').click();
    const picker = page.getByLabel('Add context');
    await picker.fill('grad');
    await page.getByRole('listbox', { name: 'Context candidates' }).getByRole('option', { name: /Grader/ }).click();
    expect(await actions()).toContainEqual({ kind: 'setContext', consumer: 'scoring/normalize_score', dependency: 'scoring/Grader', enabled: true });
});
