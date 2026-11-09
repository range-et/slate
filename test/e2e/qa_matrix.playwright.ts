import { expect, test, type Page } from './coverage-fixture';

// Browser contract tests: a recording host makes assertions deterministic. Host
// persistence and native Undo are exercised by the Extension Host gate.
async function messages(page: Page) {
    return page.evaluate(() => (window as unknown as { __qaMessages: Array<Record<string, any>> }).__qaMessages);
}
async function host(page: Page, message: unknown) {
    await page.evaluate(message => window.postMessage(message, '*'), message);
}
async function command(page: Page, label: string) {
    await page.keyboard.press('Control+k');
    await page.getByLabel('Command palette input').fill(label);
    await page.getByRole('option').filter({ has: page.getByText(label, { exact: true }) }).click();
}
async function select(page: Page, id = 'scoring/normalize_score') {
    await page.locator(`.react-flow__node[data-id="${id}"]`).click();
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        const messages: unknown[] = [];
        Object.defineProperty(window, '__qaMessages', { value: messages });
        window.acquireVsCodeApi = () => ({ postMessage(message: unknown) { messages.push(message); } });
    });
    await page.goto('/harness.html?demo');
    await expect(page.locator('.react-flow__node[data-id="clamp"]')).toBeVisible();
});

for (const [label, kind] of [
    ['New node file…', 'createNode'], ['New placeholder…', 'createPlaceholder'],
    ['New flow…', 'createFlow'], ['Add library file…', 'addLibrary'],
    ['Describe nodes with llama.cpp', 'describeNodes'], ['Compile project', 'compile'],
    ['Refresh index', 'refreshIndex'], ['Save all files', 'saveWorkspace'],
]) {
    test(`QA command dispatch: ${label}`, async ({ page }) => {
        await command(page, label);
        expect(await messages(page)).toContainEqual(expect.objectContaining({ type: 'action', revision: 1,
            action: expect.objectContaining({ kind }) }));
        await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
        await host(page, { type: 'commandResult', message: `${label} completed` });
        await expect(page.getByRole('status')).toContainText(`${label} completed`);
    });
}

test('QA describe start, progress, stop, and retry controls follow host state', async ({ page }) => {
    await command(page, 'Describe nodes with llama.cpp');
    await host(page, { type: 'describeState', running: true });
    await host(page, { type: 'commandResult', message: 'Describing 1/3: clamp…' });
    await expect(page.getByRole('status')).toContainText('Describing 1/3');
    await command(page, 'Stop describing');
    expect(await messages(page)).toContainEqual(expect.objectContaining({ action: { kind: 'cancelDescribe' } }));
    await host(page, { type: 'describeState', running: false });
    await command(page, 'Describe nodes with llama.cpp');
    expect((await messages(page)).filter(value => value.action?.kind === 'describeNodes')).toHaveLength(2);
});

test('QA inspector edits intent, contract, code and lock with source identity', async ({ page }) => {
    await select(page);
    await page.getByLabel('Function intent').fill('Return a percentage');
    await page.getByRole('button', { name: 'Save intent', exact: true }).click();
    await page.getByLabel('Function contract').fill('Reject zero maximum');
    await page.getByRole('button', { name: 'Save contract', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save code', exact: true })).toBeDisabled();
    const editor = page.locator('.node-code-editor .cm-content');
    await editor.fill('def normalize_score(score: int, maximum: int) -> int:\n    return 100');
    await page.getByRole('button', { name: 'Save code', exact: true }).click();
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    const actions = (await messages(page)).filter(value => value.type === 'action').map(value => value.action);
    expect(actions).toEqual(expect.arrayContaining([
        { kind: 'setAnnotationField', target: 'scoring/normalize_score', field: 'intent', text: 'Return a percentage' },
        { kind: 'setAnnotationField', target: 'scoring/normalize_score', field: 'contract', text: 'Reject zero maximum' },
        { kind: 'setNodeCode', target: 'scoring/normalize_score', code: 'def normalize_score(score: int, maximum: int) -> int:\n    return 100', baseHash: 'sha256:scoring/normalize_score' },
        { kind: 'setLock', target: 'scoring/normalize_score', locked: true },
    ]));
    await page.getByRole('button', { name: 'Open node file', exact: true }).click();
    expect(await messages(page)).toContainEqual({ type: 'reveal', unitId: 'scoring/normalize_score', focus: true });
});

test('QA inline intent Escape cancels; typing shortcuts in fields stays local', async ({ page }) => {
    await page.locator('.react-flow__node[data-id="clamp"]').getByTitle('Click to edit intent').click();
    const editor = page.getByLabel('Edit intent');
    await editor.fill('Do not persist');
    await editor.press('Escape');
    expect((await messages(page)).filter(value => value.action?.kind === 'setAnnotationField')).toEqual([]);
    await select(page);
    await page.getByLabel('Function intent').fill('/');
    await page.getByLabel('Function intent').press('/');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByLabel('Function intent').press('Enter');
    expect((await messages(page)).filter(value => value.type === 'reveal')).toEqual([]);
});

test('QA board note edit, attach, save and delete preserve note identity', async ({ page }) => {
    await select(page, 'board-note-port');
    await page.getByLabel('Note title').fill('QA note');
    await page.getByLabel('Note body').fill('Check the boundary');
    await page.getByLabel('Attach note to function').selectOption('clamp');
    await page.getByRole('button', { name: 'Save board note', exact: true }).click();
    expect(await messages(page)).toContainEqual({ type: 'noteUpdate', revision: 1, noteId: 'board-note-port',
        title: 'QA note', body: 'Check the boundary', attachedTo: 'clamp' });
    await page.getByLabel('Attach note to function').selectOption('');
    await page.getByRole('button', { name: 'Save board note', exact: true }).click();
    expect(await messages(page)).toContainEqual(expect.objectContaining({ type: 'noteUpdate', attachedTo: null }));
    await page.getByRole('button', { name: 'Delete board note', exact: true }).click();
    expect(await messages(page)).toContainEqual({ type: 'noteDelete', revision: 1, noteId: 'board-note-port' });
    expect((await messages(page)).filter(value => value.action?.kind === 'setNodeCode')).toEqual([]);
});

test('QA generation disabled/error, progress, cancel, retry, accept and undo chain', async ({ page }) => {
    await select(page);
    const generate = page.getByRole('button', { name: 'Generate with llama.cpp', exact: true });
    await expect(generate).toBeDisabled();
    await host(page, { type: 'packetPreview', unitId: 'scoring/normalize_score', error: 'Required context unavailable' });
    await expect(page.locator('.packet-preview')).toContainText('Required context unavailable');
    await expect(generate).toBeDisabled();
    await host(page, { type: 'packetPreview', unitId: 'scoring/normalize_score', packet: {
        items: [], estimatedInputTokens: 100, inputBudgetTokens: 1000, outputBudgetTokens: 200,
    } });
    await generate.click();
    expect(await messages(page)).toContainEqual({ type: 'generate', unitId: 'scoring/normalize_score' });
    await host(page, { type: 'generationStarted', unitId: 'scoring/normalize_score', message: 'Starting generation' });
    await host(page, { type: 'generationProgress', unitId: 'scoring/normalize_score', receivedCharacters: 123 });
    await expect(page.locator('.generation-activity')).toContainText('123 characters');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await messages(page)).toContainEqual({ type: 'cancelGeneration' });
    await host(page, { type: 'generationFailed', message: 'Generation cancelled.' });
    await expect(page.getByRole('status')).toContainText('Generation cancelled.');
    await generate.click();
    await host(page, { type: 'proposalReady', proposal: { id: 'qa-proposal', unitId: 'scoring/normalize_score',
        path: 'slate/nodes/scoring/normalize_score.json', candidate: 'def normalize_score(score: int, maximum: int) -> int:\n    return 100', checks: ['Valid Python'] } });
    await page.getByRole('button', { name: 'Accept WorkspaceEdit' }).click();
    expect(await messages(page)).toContainEqual({ type: 'acceptProposal', proposalId: 'qa-proposal' });
    await host(page, { type: 'proposalAccepted', unitId: 'scoring/normalize_score' });
    await expect(page.getByRole('heading', { name: 'Confined proposal' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo accepted edit' }).click();
    expect(await messages(page)).toContainEqual({ type: 'undoAccepted' });
});

test('QA stale proposals cannot be accepted', async ({ page }) => {
    await select(page);
    await host(page, { type: 'proposalReady', proposal: { id: 'stale', unitId: 'scoring/normalize_score',
        path: 'slate/nodes/scoring/normalize_score.json', candidate: 'candidate', checks: [] } });
    await host(page, { type: 'proposalStale', proposalId: 'stale', message: 'Source changed; regenerate.' });
    await expect(page.getByRole('button', { name: 'Accept WorkspaceEdit' })).toBeDisabled();
    await expect(page.locator('.proposal-review')).toContainText('Source changed; regenerate.');
    expect((await messages(page)).filter(value => value.type === 'acceptProposal')).toEqual([]);
});

test('QA search empty/stale results can be dismissed and searched again', async ({ page }) => {
    await host(page, { type: 'searchResults', query: 'missing', results: [], stale: true });
    await expect(page.getByRole('status')).toContainText('graph changed; search again');
    const region = page.getByRole('region', { name: 'Search results for missing' });
    await expect(region).toContainText('No indexed code matched.');
    await page.getByRole('button', { name: 'Close search results' }).click();
    await expect(region).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await page.getByLabel('Command palette input').fill('again');
    await page.getByRole('option', { name: /Search code for “again”/ }).click();
    expect(await messages(page)).toContainEqual({ type: 'search', query: 'again', revision: 1 });
});

test('QA library filtering, visibility, Map restriction, and return to Compose', async ({ page }) => {
    const library = page.getByRole('complementary', { name: 'Library' });
    await page.getByLabel('Filter library').fill('shout');
    await expect(library.getByText('shout', { exact: true })).toBeVisible();
    await expect(library.getByText('clamp', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await expect(library).toHaveCount(0);
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await expect(library).toBeVisible();
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Map', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await command(page, 'Add node…');
    await expect(page.getByRole('dialog', { name: 'Add node' })).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('Switch to Compose');
    await page.getByRole('button', { name: 'Compose', exact: true }).click();
    await command(page, 'Add node…');
    await expect(page.getByRole('dialog', { name: 'Add node' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
});

for (const [id, label, action] of [
    ['ref-clamp', 'Delete reference', { kind: 'deleteItems', ids: ['ref-clamp'] }],
    ['placeholder-letter', 'Delete placeholder', { kind: 'deleteItems', ids: ['placeholder-letter'] }],
    ['placeholder-letter', 'Create node…', { kind: 'placeholderToNode', id: 'placeholder-letter' }],
    ['flow:report', 'Delete flow…', { kind: 'deleteFlow', id: 'report' }],
    ['value', 'Delete value', { kind: 'deleteItems', ids: ['value'] }],
] as const) {
    test(`QA context menu: ${label}`, async ({ page }) => {
        await page.locator(`.react-flow__node[data-id="${id}"]`).click({ button: 'right' });
        await page.getByRole('menuitem', { name: label, exact: true }).click();
        expect(await messages(page)).toContainEqual({ type: 'action', revision: 1, action });
        await expect(page.getByRole('menu')).toHaveCount(0);
    });
}

test('QA literal Escape restores original and blur saves changed value', async ({ page }) => {
    const editor = page.getByLabel('Value of value', { exact: true });
    await editor.fill('99');
    await editor.press('Escape');
    await expect(editor).toHaveValue('42');
    await editor.blur();
    expect((await messages(page)).filter(value => value.action?.kind === 'setValue')).toEqual([]);
    await editor.fill('123');
    await editor.blur();
    expect((await messages(page)).filter(value => value.action?.kind === 'setValue')).toEqual([
        { type: 'action', action: { kind: 'setValue', flow: null, id: 'value', value: '123' } },
    ]);
});

test('QA palette keyboard navigation, Escape, clear selection and reference navigation', async ({ page }) => {
    await select(page, 'ref-clamp');
    await page.getByRole('button', { name: 'Go to definition', exact: true }).click();
    await expect(page.locator('.react-flow__node[data-id="clamp"]')).toHaveClass(/selected/);
    await command(page, 'Clear selection');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
    await page.mouse.move(0, 0);
    await page.keyboard.press('Control+k');
    const input = page.getByLabel('Command palette input');
    const options = page.getByRole('listbox', { name: 'Commands' }).getByRole('option');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await input.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await input.press('ArrowUp');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await input.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
});
