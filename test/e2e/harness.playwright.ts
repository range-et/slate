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
                        unitId: 'clamp',
                        path: 'slate/nodes/clamp.json',
                        qualifiedName: 'clamp',
                        signature: 'def clamp(value: int, lower: int, upper: int) -> int',
                        snippet: 'return max(lower, min(value, upper))',
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
    await palette.fill('min(value');
    await page.getByRole('option', { name: /Search code for “min\(value”/ }).click();
    await expect(page.getByRole('region', { name: 'Search results for min(value' })).toBeVisible();
    await expect(page.getByRole('button', { name: /clamp.*source/i })).toContainText('slate/nodes/clamp.json');

    await page.getByRole('button', { name: /clamp.*source/i }).click();
    const messages = await page.evaluate(() => (window as unknown as { __slateHostMessages: unknown[] }).__slateHostMessages);
    expect(messages).toContainEqual({ type: 'reveal', unitId: 'clamp', focus: false });
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
                                { id: value.unitId, path: 'slate/nodes/scoring/normalize_score.json', qualifiedName: 'normalize_score', role: 'target', sourceHash: 'sha256:demo', characters: 86 },
                                { id: 'clamp', path: 'slate/nodes/clamp.json', qualifiedName: 'clamp', role: 'required-context', sourceHash: 'sha256:demo', characters: 74 },
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
                            id: 'proposal-1', unitId: value.unitId, path: 'slate/nodes/scoring/normalize_score.json',
                            candidate: 'def normalize_score(score: int, maximum: int) -> int:\n    return clamp(score * 100 // maximum, 0, 100)',
                            checks: ['Valid Python', 'Exactly one function', 'Name and signature preserved', 'Edit confined to owned function'],
                        },
                    }, '*'), 10);
                }
            },
        });
    });
    await page.goto('/harness.html?demo');
    await page.locator('.react-flow').getByText('normalize_score', { exact: true }).click();
    const packet = page.locator('.packet-preview');
    await expect(packet.getByRole('heading', { name: 'Exact packet' })).toBeVisible();
    await expect(packet.getByText('slate/nodes/clamp.json · 74 chars')).toBeVisible();
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

    await page.locator('.react-flow').getByText('normalize_score', { exact: true }).click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'function actions' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Add note attached here' })).toBeVisible();
    await page.keyboard.press('Escape');

    const note = page.locator('.slate-node--note');
    await note.click({ button: 'right' });
    expect(pageErrors).toEqual([]);
    await page.getByRole('menuitem', { name: 'Edit board note' }).click();
    await expect(page.getByLabel('Note body')).toHaveValue('Split grade.py into nodes, then describe each one with llama.');
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
    await page.goto('/harness.html?demo');
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
    await page.goto('/harness.html?demo');
    const actions = async () => (await page.evaluate(() => (window as unknown as { __slateHostMessages: Array<{ type: string; action?: unknown }> }).__slateHostMessages))
        .filter(message => message.type === 'action').map(message => message.action);

    const clamp = page.locator('.react-flow__node[data-id="clamp"]');
    await clamp.getByTitle('Click to edit intent').click();
    const editor = page.getByLabel('Edit intent');
    await editor.fill('Clamp into [lower, upper]');
    await editor.press('Enter');
    expect(await actions()).toContainEqual({ kind: 'setAnnotationField', target: 'clamp', field: 'intent', text: 'Clamp into [lower, upper]' });

    const from = await page.locator('.react-flow__node[data-id="scoring/normalize_score"] [data-handleid="ctx-out"]').boundingBox();
    const to = await clamp.locator('[data-handleid="ctx-in"]').boundingBox();
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

test('refs, placeholders, data wires, flows, add-node search, and grouping post typed actions', async ({ page }) => {
    await page.addInitScript(() => {
        const messages: unknown[] = [];
        Object.defineProperty(window, '__slateHostMessages', { value: messages });
        window.acquireVsCodeApi = () => ({ postMessage(message: unknown) { messages.push(message); } });
    });
    await page.goto('/harness.html?demo');
    const actions = async () => (await page.evaluate(() => (window as unknown as { __slateHostMessages: Array<{ type: string; action?: unknown }> }).__slateHostMessages))
        .filter(message => message.type === 'action').map(message => message.action);
    const drag = async (from: { x: number; y: number; width: number; height: number } | null, to: { x: number; y: number }) => {
        if (!from) throw new Error('handle did not render');
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 12 });
        await page.mouse.up();
    };

    // A reference offers navigation and deletion; Find references highlights the target and its refs.
    await page.locator('.react-flow__node[data-id="ref-clamp"]').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'ref actions' });
    await expect(menu.getByRole('menuitem', { name: 'Go to definition' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Find references' }).click();
    await expect(page.locator('.slate-node.is-highlighted')).toHaveCount(2);
    await expect(page.getByRole('status')).toContainText('clamp: 1 reference on the canvas');
    await page.locator('.react-flow__node[data-id="ref-clamp"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete reference' }).click();
    expect(await actions()).toContainEqual({ kind: 'deleteItems', ids: ['ref-clamp'] });

    await page.locator('.react-flow__node[data-id="placeholder-letter"]').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Convert to reference' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Create node…' }).click();
    expect(await actions()).toContainEqual({ kind: 'placeholderToNode', id: 'placeholder-letter' });

    // Port-to-port data wire on the root canvas.
    const valueOut = await page.locator('.react-flow__node[data-id="value"] [data-handleid="out"]').boundingBox();
    const clampIn = await page.locator('.react-flow__node[data-id="clamp"] [data-handleid="in:value"]').boundingBox();
    await drag(valueOut, { x: clampIn!.x + clampIn!.width / 2, y: clampIn!.y + clampIn!.height / 2 });
    expect(await actions()).toContainEqual({ kind: 'connectData', from: 'value.out', to: 'clamp.in:value' });

    // Enter a flow; dropping a wire on empty canvas opens add-node search filtered by type and auto-wires.
    await page.keyboard.press('Control+k');
    await page.getByLabel('Command palette input').fill('Flow: report');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('navigation', { name: 'Canvas path' }).getByRole('button', { name: 'report' })).toBeVisible();
    const out = await page.locator('.react-flow__node[data-id="normalize_score"] [data-handleid="out"]').boundingBox();
    await drag(out, { x: out!.x + 240, y: out!.y + 220 });
    const add = page.getByRole('dialog', { name: 'Add node' });
    await expect(add.getByRole('option').filter({ hasText: 'shout' })).toHaveCount(0);
    await page.getByLabel('Add node input').fill('clamp');
    await page.keyboard.press('Enter');
    expect(await actions()).toContainEqual(expect.objectContaining({
        flow: 'report', kind: 'addInstance', target: 'clamp', connectFrom: 'normalize_score.out', connectPort: 'in:value',
    }));

    // Tab on empty selection opens add mode; Ctrl+G groups the selection into a flow.
    await page.locator('.react-flow__pane').click({ position: { x: 40, y: 40 } });
    await page.keyboard.press('Tab');
    await expect(page.getByRole('dialog', { name: 'Add node' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('.react-flow__node[data-id="hundred"] strong').click();
    await page.locator('.react-flow__node[data-id="normalize_score"]').click({ modifiers: ['Shift'] });
    await page.keyboard.press('Control+g');
    expect(await actions()).toContainEqual({ flow: 'report', kind: 'extractFlow', ids: expect.arrayContaining(['hundred', 'normalize_score']) });

    // Library drag places an instance where it is dropped.
    await page.getByRole('complementary', { name: 'Library' }).getByText('shout', { exact: true }).dragTo(page.locator('.react-flow__pane'), { targetPosition: { x: 200, y: 500 } });
    expect(await actions()).toContainEqual(expect.objectContaining({ flow: 'report', kind: 'addInstance', target: 'lib:vendor/textutil.py:shout' }));

    await page.getByRole('navigation', { name: 'Canvas path' }).getByRole('button', { name: 'llama-demo' }).click();
    await expect(page.locator('.react-flow__node[data-id="flow:report"]')).toBeVisible();
    await page.getByRole('button', { name: 'Map' }).click();
    await expect(page.locator('.slate-node--folder')).toHaveCount(2);
    await expect(page.locator('.react-flow__node[data-id="ref-clamp"]')).toHaveCount(0);
});
