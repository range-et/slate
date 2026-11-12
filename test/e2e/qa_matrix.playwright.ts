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
    await input.press('ArrowUp');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await input.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('QA statusbar palette button, selection palette commands, context menu refs, library flow pick, search dblclick, and inspector diagnostics', async ({ page }) => {
    await host(page, null);
    await host(page, { type: 'selectUnit', unitId: 'clamp' });
    await expect(page.locator('.react-flow__node[data-id="clamp"]')).toHaveClass(/selected/);

    // Double-click on inline intent paragraph stops propagation without revealing source.
    await page.locator('.react-flow__node[data-id="clamp"] .slate-node__intent').dispatchEvent('dblclick');

    // Empty ContextPicker Enter is a safe no-op.
    await select(page, 'clamp');
    const contextInput = page.getByLabel('Add context');
    await contextInput.fill('zzzz_no_match');
    await contextInput.press('Enter');

    // Statusbar button opens the command palette; run Add context from it.
    await page.getByRole('button', { name: '⌘K Commands' }).click();
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.getByLabel('Command palette input').fill('Add context: Grader');
    await page.getByRole('option').filter({ has: page.getByText('Add context: Grader', { exact: true }) }).click();

    // Palette commands for selected unit: Generate, Lock, Find references.
    await page.locator('.react-flow__node[data-id="scoring/normalize_score"] strong').click();
    await expect(page.locator('.react-flow__node[data-id="scoring/normalize_score"]')).toHaveClass(/selected/);
    await command(page, 'Generate normalize_score with llama.cpp');
    await command(page, 'Lock normalize_score');
    await command(page, 'Find references of scoring/normalize_score');
    await expect(page.getByRole('status')).toContainText('0 references on the canvas; used in flows report');

    // Palette commands for library toggle, new note, note navigation, flow enter, and delete selected.
    await command(page, 'Hide library');
    await expect(page.getByRole('complementary', { name: 'Library' })).toHaveCount(0);
    await command(page, 'New board note');
    await command(page, 'Note: Port the grading script next');
    await expect(page.locator('.react-flow__node[data-id="board-note-port"]')).toHaveClass(/selected/);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Fit View' }).click();

    await select(page, 'ref-clamp');
    await command(page, 'Delete selected (1)');
    await command(page, 'Clear selection');

    // Context menu: Find references on unit and flow, Go to definition on ref.
    await page.locator('.react-flow__node[data-id="clamp"] strong').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Find references', exact: true }).click();
    await command(page, 'Clear selection');
    await page.locator('.react-flow__node[data-id="flow:report"] strong').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Find references', exact: true }).click();
    await command(page, 'Clear selection');
    await page.locator('.react-flow__node[data-id="ref-clamp"] strong').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Go to definition', exact: true }).click();

    // Clear selection so the inspector does not cover flow:report on the right edge, then select and open via Command Palette.
    await command(page, 'Clear selection');
    await select(page, 'flow:report');
    await command(page, 'Open flow report');
    await expect(page.locator('.react-flow__node[data-id="shout"]')).toBeVisible();

    // Library sidebar inside a flow: Show library via palette, Add library file button, and picking an instance inside the flow.
    await command(page, 'Show library');
    const library = page.getByRole('complementary', { name: 'Library' });
    await expect(library).toBeVisible();
    await library.getByRole('button', { name: 'Add library file…' }).click();
    await library.getByText('shout', { exact: true }).click();
    await expect(page.locator('.react-flow__node[data-id="shout"]')).toHaveClass(/selected/);

    // Go to definition on a read-only library instance shows status message.
    await page.locator('.react-flow__node[data-id="shout"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Go to definition', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('is read-only library code.');

    // Empty Add-node palette Enter is a safe no-op.
    await command(page, 'Add node…');
    const addInput = page.getByLabel('Add node input');
    await addInput.fill('123_no_match');
    await addInput.press('Enter');
    await addInput.press('Escape');

    // Return to root canvas and double-click a search result.
    await command(page, 'Hide library');
    await page.getByRole('navigation', { name: 'Canvas path' }).getByRole('button', { name: 'llama-demo' }).click();
    await host(page, {
        type: 'searchResults',
        query: 'clamp',
        stale: false,
        results: [{ unitId: 'clamp', path: 'slate/nodes/clamp.json', qualifiedName: 'clamp', signature: null, snippet: 'def clamp', reason: 'exact name', score: 100 }],
    });
    await page.locator('.harness-search-result').dblclick();

    // Snapshot with diagnostics on both a unit node and a module node, plus a ref to a flow.
    await page.evaluate(() => {
        window.postMessage({
            type: 'snapshot',
            snapshot: {
                revision: 2,
                projectName: 'diag-demo',
                refs: [{ id: 'ref-flow', target: 'report' }],
                flows: [{ id: 'report', flow: { name: 'report', inputs: [], outputs: [], instances: [], wires: [], extra: {} } }],
                documents: [
                    {
                        id: 'node:clamp',
                        path: 'slate/nodes/clamp.json',
                        valid: true,
                        stale: false,
                        sourceHash: 'sha256:clamp',
                        version: null,
                        diagnostics: [{ code: 'node-name-mismatch', message: 'File name mismatch', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
                        source: 'def clamp(x: int) -> int:\n    return x\n',
                        units: [{
                            id: 'clamp', identity: 'durable', kind: 'function', name: 'clamp', qualifiedName: 'clamp', parentId: null,
                            ranges: { name: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } }, declaration: { start: { line: 0, character: 0 }, end: { line: 1, character: 12 } } },
                            annotation: { intent: '', contract: '', dependencies: [], examples: [], locked: false }, decorators: [],
                            signature: 'def clamp(x: int) -> int', parameters: 'x: int', returnAnnotation: 'int',
                            params: [{ name: 'x', annotation: 'int', default: null, kind: 'keyword' }],
                        }],
                    },
                    {
                        id: 'node:broken',
                        path: 'slate/nodes/broken.json',
                        nodeKind: 'prelude',
                        nodeTitle: 'broken',
                        valid: false,
                        stale: false,
                        sourceHash: 'sha256:broken',
                        version: null,
                        diagnostics: [{ code: 'node-format', message: 'Broken node JSON', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
                        units: [],
                    },
                ],
            },
        }, '*');
    });
    await select(page, 'clamp');
    await expect(page.locator('.harness-inspector__diagnostic')).toContainText('File name mismatch');
    await select(page, 'broken');
    await expect(page.locator('.harness-inspector__diagnostic')).toContainText('Broken node JSON');
    await page.locator('.react-flow__node[data-id="ref-flow"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open flow', exact: true }).click();
});
