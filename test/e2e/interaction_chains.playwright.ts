import { expect, test, type Page, type Locator } from './coverage-fixture';
import { demoSnapshot } from '../../src/harness/demo';

async function send(page: Page, message: unknown) {
    await page.evaluate(message => window.postMessage(message, '*'), message);
}
async function messages(page: Page) {
    return page.evaluate(() => (window as unknown as { qa: Array<Record<string, any>> }).qa);
}
async function clear(page: Page) { await page.evaluate(() => { (window as unknown as { qa: unknown[] }).qa.length = 0; }); }
async function command(page: Page, label: string) {
    await page.keyboard.press('Control+k');
    await page.getByLabel('Command palette input').fill(label);
    await page.getByRole('option').filter({ has: page.getByText(label, { exact: true }) }).click();
}
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
async function settle(locator: Locator) {
    let last = '';
    await expect.poll(async () => {
        const box = await locator.boundingBox();
        const current = JSON.stringify(box);
        const same = Boolean(box) && current === last;
        last = current;
        return same;
    }).toBe(true);
    return (await locator.boundingBox())!;
}
async function wire(page: Page, from: Locator, to: Locator) {
    const a = await settle(from), b = await settle(to);
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    await page.mouse.up();
}
async function blank(page: Page, button: 'left' | 'right' = 'left', double = false) {
    const pane = page.locator('.react-flow__pane');
    if (double) await pane.dblclick({ position: { x: 15, y: 15 } });
    else await pane.click({ position: { x: 15, y: 15 }, button });
}
async function snapshot(page: Page, change: (value: typeof demoSnapshot) => void) {
    const value = structuredClone(demoSnapshot);
    value.revision = 2;
    change(value);
    await send(page, { type: 'snapshot', snapshot: value });
    return value;
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        const qa: unknown[] = [];
        Object.defineProperty(window, 'qa', { value: qa });
        window.acquireVsCodeApi = () => ({ postMessage(message: unknown) { qa.push(message); } });
    });
    await page.goto('/harness.html?demo');
    await expect(node(page, 'clamp')).toBeVisible();
});

for (const entry of ['double-click', 'Enter', 'context menu', 'palette']) {
    test(`chain source reveal via ${entry}`, async ({ page }) => {
        await node(page, 'clamp').locator('strong').first().click();
        if (entry === 'double-click') await node(page, 'clamp').getByText('clamp', { exact: true }).dblclick();
        if (entry === 'Enter') await page.keyboard.press('Enter');
        if (entry === 'context menu') {
            await node(page, 'clamp').click({ button: 'right' });
            await page.getByRole('menuitem', { name: 'Open node file', exact: true }).click();
        }
        if (entry === 'palette') await command(page, 'Open clamp in editor');
        expect(await messages(page)).toContainEqual({ type: 'reveal', unitId: 'clamp', focus: true });
        if (entry === 'double-click') {
            await node(page, 'clamp').locator('strong').first().click();
            await expect(page.getByRole('complementary', { name: 'Selected node details' }).getByRole('heading', { name: 'clamp', exact: true })).toBeVisible();
        }
    });
}
for (const entry of ['inspector', 'context menu', 'double-click', 'Tab']) {
    test(`chain flow navigation via ${entry}`, async ({ page }) => {
        if (entry === 'inspector' || entry === 'Tab') await node(page, 'flow:report').locator('strong').first().click();
        if (entry === 'inspector') await page.getByRole('button', { name: 'Open flow', exact: true }).click();
        if (entry === 'context menu') {
            await node(page, 'flow:report').click({ button: 'right' });
            await page.getByRole('menuitem', { name: 'Open flow', exact: true }).click();
        }
        if (entry === 'double-click') await node(page, 'flow:report').locator('strong').first().dblclick();
        if (entry === 'Tab') await page.keyboard.press('Tab');
        await expect(node(page, 'hundred')).toBeVisible();
        if (entry === 'double-click') await page.screenshot({ path: 'test-results/qa-direct-doubleclick-flow.png' });
        await command(page, 'Back to parent canvas');
        await expect(node(page, 'flow:report')).toBeVisible();
    });
}
test('chain nested flow breadcrumbs and deletion return to surviving parent', async ({ page }) => {
    const value = await snapshot(page, value => {
        value.flows!.push({ id: 'child', flow: { name: 'child', inputs: [], outputs: [], instances: [], wires: [], extra: {} } });
        value.flows!.find(f => f.id === 'report')!.flow!.instances.push({ id: 'nested', node: 'child' });
    });
    await command(page, 'Flow: report');
    await settle(node(page, 'nested'));
    await node(page, 'nested').locator('strong').first().dblclick();
    const crumbs = page.getByRole('navigation', { name: 'Canvas path' });
    await expect(crumbs.getByRole('button', { name: 'child', exact: true })).toBeVisible();
    await crumbs.getByRole('button', { name: 'report', exact: true }).click();
    await expect(node(page, 'nested')).toBeVisible();
    await settle(node(page, 'nested'));
    await node(page, 'nested').locator('strong').first().dblclick();
    value.flows = value.flows!.filter(f => f.id !== 'child');
    await send(page, { type: 'snapshot', snapshot: { ...value, revision: 3 } });
    await expect(crumbs.getByRole('button', { name: 'child', exact: true })).toHaveCount(0);
    await expect(crumbs.getByRole('button', { name: 'report', exact: true })).toBeVisible();
});
for (const entry of ['Shift+A', 'double-click', 'context menu']) {
    test(`chain add dialog via ${entry}`, async ({ page }) => {
        await blank(page);
        if (entry === 'Shift+A') await page.keyboard.press('Shift+A');
        if (entry === 'double-click') await blank(page, 'left', true);
        if (entry === 'context menu') {
            await blank(page, 'right');
            await page.getByRole('menuitem', { name: 'Add node…', exact: true }).click();
        }
        await expect(page.getByRole('dialog', { name: 'Add node' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
    });
}

test('chain add literal and named placeholder; flow cannot add itself', async ({ page }) => {
    await command(page, 'Add node…');
    await page.getByLabel('Add node input').fill('Value');
    await page.getByRole('option').filter({ has: page.getByText('Value', { exact: true }) }).click();
    expect(await messages(page)).toContainEqual(expect.objectContaining({ action: expect.objectContaining({ kind: 'addInstance', value: '0' }) }));
    await command(page, 'Add node…');
    await page.getByLabel('Add node input').fill('future_name');
    await page.getByRole('option', { name: /New placeholder “future_name”/ }).click();
    expect(await messages(page)).toContainEqual(expect.objectContaining({ action: expect.objectContaining({ kind: 'createPlaceholder', name: 'future_name' }) }));
    await command(page, 'Flow: report');
    await command(page, 'Add node…');
    await page.getByLabel('Add node input').fill('report');
    await expect(page.getByRole('option').filter({ has: page.getByText('report', { exact: true }) })).toHaveCount(0);
    await page.getByLabel('Add node input').fill('not_a_target');
    await expect(page.getByText('Nothing matches.', { exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: /New placeholder/ })).toHaveCount(0);
});

test('chain palette hover and backdrop dismissal; library find and missing match', async ({ page }) => {
    const library = page.getByRole('complementary', { name: 'Library' });
    await library.getByText('clamp', { exact: true }).click();
    await expect(node(page, 'clamp')).toHaveClass(/selected/);
    await library.getByText('shout', { exact: true }).click();
    await expect(page.getByRole('status')).toContainText('is not on this canvas');
    await page.getByLabel('Filter library').fill('zzzz-no-match');
    await expect(library).toContainText('Nothing matches.');
    await page.keyboard.press('Control+k');
    const option = page.getByRole('listbox', { name: 'Commands' }).getByRole('option').nth(2);
    await option.hover();
    await expect(option).toHaveAttribute('aria-selected', 'true');
    await page.locator('.palette-backdrop').click({ position: { x: 10, y: 10 } });
    await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('chain inline intent unchanged, Shift+Enter, blur and unlock', async ({ page }) => {
    const target = node(page, 'clamp');
    await target.getByTitle('Click to edit intent').click();
    await page.getByLabel('Edit intent').blur();
    expect((await messages(page)).filter(v => v.action?.kind === 'setAnnotationField')).toEqual([]);
    await target.getByTitle('Click to edit intent').click();
    const editor = page.getByLabel('Edit intent');
    await editor.fill('First');
    await editor.press('End');
    await editor.press('Shift+Enter');
    await editor.pressSequentially('Second');
    await expect(editor).toHaveValue('First\nSecond');
    expect((await messages(page)).filter(v => v.action?.kind === 'setAnnotationField')).toEqual([]);
    await editor.blur();
    expect(await messages(page)).toContainEqual({ type: 'action', action: { kind: 'setAnnotationField', target: 'clamp', field: 'intent', text: 'First\nSecond' } });
    await target.locator('strong').first().click();
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    expect(await messages(page)).toContainEqual(expect.objectContaining({ action: { kind: 'setLock', target: 'clamp', locked: false } }));
});

test('chain module-state editor saves source hash and arbitrary statements', async ({ page }) => {
    await node(page, 'scoring/_prelude').click();
    await expect(page.getByRole('button', { name: 'Save code' })).toBeDisabled();
    await page.locator('.node-code-editor .cm-content').fill('LIMIT = 20\nTABLE = {}');
    await page.getByRole('button', { name: 'Save code' }).click();
    expect(await messages(page)).toContainEqual(expect.objectContaining({ action: { kind: 'setNodeCode', target: 'scoring/_prelude', code: 'LIMIT = 20\nTABLE = {}', baseHash: 'sha256:scoring/_prelude' } }));
});

test('chain context picker excludes self, existing context and methods; keyboard adds and chip removes', async ({ page }) => {
    await node(page, 'scoring/normalize_score').click();
    await page.getByLabel('Add context').click();
    const candidates = page.getByRole('listbox', { name: 'Context candidates' });
    await expect(candidates.getByRole('option')).toHaveCount(1);
    await expect(candidates).toContainText('Grader');
    await page.getByLabel('Add context').press('ArrowDown');
    await page.getByLabel('Add context').press('ArrowUp');
    await page.getByLabel('Add context').press('Enter');
    expect(await messages(page)).toContainEqual(expect.objectContaining({ action: { kind: 'setContext', consumer: 'scoring/normalize_score', dependency: 'scoring/Grader', enabled: true } }));
    await page.getByTitle('Remove clamp', { exact: true }).click();
    expect(await messages(page)).toContainEqual(expect.objectContaining({ action: { kind: 'setContext', consumer: 'scoring/normalize_score', dependency: 'clamp', enabled: false } }));
    await page.getByLabel('Add context').click();
    await page.getByLabel('Add context').press('Escape');
    await expect(candidates).toHaveCount(0);
});

for (const mode of ['resolved', 'ambiguous', 'broken'] as const) {
    test(`chain ${mode} references and placeholders`, async ({ page }) => {
        await snapshot(page, value => {
            if (mode === 'broken') {
                const main = value.flows!.find(flow => flow.id === 'main')!.flow!;
                main.instances.find(instance => instance.id === 'ref-clamp')!.node = 'gone';
            } else {
                value.placeholders![0].name = 'clamp';
                if (mode === 'ambiguous') {
                    const doc = structuredClone(value.documents[0]);
                    doc.id = 'node:other/clamp'; doc.path = 'slate/nodes/other/clamp.json'; doc.units[0].id = 'other/clamp';
                    value.documents.push(doc);
                }
            }
        });
        await node(page, mode === 'broken' ? 'ref-clamp' : 'placeholder-letter').click({ button: 'right' });
        if (mode === 'broken') {
            await expect(node(page, 'ref-clamp')).toContainText('BROKEN');
            await expect(page.getByRole('menuitem', { name: 'Go to definition' })).toHaveCount(0);
            await expect(page.getByRole('menuitem', { name: 'Generate body' })).toHaveCount(0);
        } else if (mode === 'ambiguous') {
            await expect(page.getByRole('menuitem', { name: 'Convert to reference' })).toHaveCount(0);
        } else {
            await page.getByRole('menuitem', { name: 'Convert to reference' }).click();
            expect(await messages(page)).toContainEqual(expect.objectContaining({ action: { kind: 'placeholderToRef', id: 'placeholder-letter' } }));
        }
    });
}

test('chain root call instances in main.json render, wire, and count references without double-counting legacy refs', async ({ page }) => {
    await snapshot(page, value => {
        const main = value.flows!.find(flow => flow.id === 'main')!.flow!;
        main.instances.push({ id: 'ref-norm', node: 'scoring/normalize_score' });
        value.refs = [{ id: 'ref-clamp', target: 'clamp' }];
        value.layout!['ref-norm'] = { x: 760, y: 500 };
    });
    await expect(node(page, 'ref-norm')).toBeVisible();
    await node(page, 'ref-norm').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Find references' }).click();
    await expect(page.getByRole('status')).toContainText('scoring/normalize_score: 1 reference on the canvas; used in flows report.');
    await node(page, 'ref-clamp').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Find references' }).click();
    await expect(page.getByRole('status')).toContainText('clamp: 1 reference on the canvas.');
});

test('chain flow value Enter saves once; instance deletion and empty grouping are scoped', async ({ page }) => {
    await command(page, 'Flow: report');
    const editor = page.getByLabel('Value of hundred');
    await editor.fill('200');
    await editor.press('Enter');
    expect((await messages(page)).filter(v => v.action?.kind === 'setValue')).toEqual([
        { type: 'action', action: { kind: 'setValue', flow: 'report', id: 'hundred', value: '200' } },
    ]);
    await node(page, 'normalize_score').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove from flow', exact: true }).click();
    expect(await messages(page)).toContainEqual(expect.objectContaining({ action: { flow: 'report', kind: 'deleteItems', ids: ['normalize_score'] } }));
    await command(page, 'Clear selection');
    await blank(page);
    await page.keyboard.press('Control+g');
    await expect(page.getByRole('status')).toContainText('Select nodes, references, flows, or values to group.');
    expect((await messages(page)).filter(v => v.action?.kind === 'extractFlow')).toEqual([]);
});

test('chain note context deletion and attached-note palette entry', async ({ page }) => {
    await node(page, 'clamp').locator('strong').first().click();
    await command(page, 'Add note attached to clamp');
    expect(await messages(page)).toContainEqual(expect.objectContaining({ type: 'noteCreate', attachedTo: 'clamp' }));
    await node(page, 'clamp').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add note attached here' }).click();
    expect((await messages(page)).filter(v => v.type === 'noteCreate' && v.attachedTo === 'clamp')).toHaveLength(2);
    await command(page, 'Clear selection');
    await node(page, 'board-note-port').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete board note' }).click();
    expect(await messages(page)).toContainEqual({ type: 'noteDelete', revision: 1, noteId: 'board-note-port' });
});

for (const id of ['board-note-port', 'placeholder-letter']) {
    test(`chain non-groupable selection ${id} never dispatches extraction`, async ({ page }) => {
        await node(page, id).locator('strong').first().click();
        await page.keyboard.press('Control+g');
        await expect(page.getByRole('status')).toContainText('Select nodes, references, flows, or values to group.');
        expect((await messages(page)).filter(message => message.action?.kind === 'extractFlow')).toEqual([]);
    });
}

for (const scope of ['root', 'map', 'report']) {
    test(`chain drag persists ${scope} layout scope`, async ({ page }) => {
        if (scope === 'map') await page.getByRole('button', { name: 'Map', exact: true }).click();
        if (scope === 'report') await command(page, 'Flow: report');
        const target = node(page, scope === 'report' ? 'hundred' : 'clamp').locator('strong').first();
        const box = await settle(target);
        await clear(page);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 12 });
        await page.mouse.up();
        const updates = (await messages(page)).filter(v => v.type === 'layout');
        expect(updates).toHaveLength(1);
        expect(updates[0].scope).toBe(scope === 'root' ? undefined : scope);
        expect(updates[0].revision).toBe(1);
        expect(updates[0].positions[scope === 'report' ? 'hundred' : 'clamp']).toEqual({ x: expect.any(Number), y: expect.any(Number) });
    });
}

test('chain zoom controls, drag pan, fit menu and fit command change viewport', async ({ page }) => {
    const viewport = page.locator('.react-flow__viewport');
    await settle(node(page, 'clamp'));
    const start = await viewport.getAttribute('style');
    await page.getByRole('button', { name: /zoom in/i }).click();
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(start);
    const zoomed = await viewport.getAttribute('style');
    await page.getByRole('button', { name: /zoom out/i }).click();
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(zoomed);
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    const beforePan = await viewport.getAttribute('style');
    await page.mouse.move(pane.x + 15, pane.y + 15);
    await page.mouse.down();
    await page.mouse.move(pane.x + 65, pane.y + 55, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(beforePan);
    await blank(page, 'right');
    await page.getByRole('menuitem', { name: 'Fit to view' }).click();
    await settle(node(page, 'clamp'));
    await page.getByRole('button', { name: /zoom in/i }).click();
    const beforeFit = await viewport.getAttribute('style');
    await command(page, 'Fit view');
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(beforeFit);
    await page.getByRole('button', { name: /fit view/i }).click();
    await expect(node(page, 'board-note-port')).toBeVisible();
});

for (const invalid of ['self', 'mixed', 'reverse', 'empty group ports']) {
    test(`chain rejects ${invalid} wire`, async ({ page }) => {
        let from: Locator, to: Locator;
        if (invalid === 'empty group ports') {
            await command(page, 'Flow: report');
            from = node(page, '__input').locator('[data-handleid="input:+"]');
            to = node(page, '__output').locator('[data-handleid="output:+"]');
        } else {
            from = node(page, 'clamp').locator(`[data-handleid="${invalid === 'mixed' ? 'ctx-out' : invalid === 'reverse' ? 'in:value' : 'out'}"]`);
            to = node(page, invalid === 'self' ? 'clamp' : 'scoring/normalize_score').locator(`[data-handleid="${invalid === 'reverse' ? 'in:score' : invalid === 'self' ? 'in:value' : 'in:score'}"]`);
        }
        await clear(page);
        await wire(page, from, to);
        expect((await messages(page)).filter(v => ['connectData', 'setContext'].includes(v.action?.kind))).toEqual([]);
    });
}

test('chain group port plus dispatch and data-wire removal preserve endpoint syntax', async ({ page }) => {
    await command(page, 'Flow: report');
    await wire(page, node(page, '__input').locator('[data-handleid="input:+"]'), node(page, 'normalize_score').locator('[data-handleid="in:score"]'));
    expect(await messages(page)).toContainEqual(expect.objectContaining({ action: { flow: 'report', kind: 'connectData', from: 'input:+', to: 'normalize_score.in:score' } }));
    await wire(page, node(page, 'normalize_score').locator('[data-handleid="out"]'), node(page, '__output').locator('[data-handleid="output:+"]'));
    expect(await messages(page)).toContainEqual(expect.objectContaining({ action: { flow: 'report', kind: 'connectData', from: 'normalize_score.out', to: 'output:+' } }));
    const edge = page.locator('.react-flow__edge-interaction').first();
    await edge.click({ button: 'right', force: true });
    await page.getByRole('menuitem', { name: 'Remove wire' }).click();
    expect(await messages(page)).toContainEqual(expect.objectContaining({ action: { flow: 'report', kind: 'disconnectData', from: 'input:score', to: 'normalize_score.in:score' } }));
});

async function search(page: Page, query: string) {
    await page.keyboard.press('Control+k');
    await page.getByLabel('Command palette input').fill(query);
    await page.getByRole('option').filter({ has: page.getByText(`Search code for “${query}”`, { exact: true }) }).click();
}
test('chain latest search wins and dismissed search stays dismissed', async ({ page }) => {
    await search(page, 'first');
    await search(page, 'second');
    await send(page, { type: 'searchResults', query: 'second', results: [], stale: false });
    await expect(page.getByRole('region', { name: 'Search results for second' })).toBeVisible();
    await send(page, { type: 'searchResults', query: 'first', results: [], stale: false });
    await expect(page.getByRole('region', { name: 'Search results for second' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Search results for first' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Close search results' }).click();
    await send(page, { type: 'searchResults', query: 'second', results: [], stale: false });
    await expect(page.getByRole('region', { name: 'Search results for second' })).toHaveCount(0);
});

test('chain generation stays scoped across selection and ignores unrelated progress/stale/failure', async ({ page }) => {
    await node(page, 'scoring/normalize_score').locator('strong').first().click();
    await send(page, { type: 'generationStarted', unitId: 'scoring/normalize_score', message: 'Working on normalize' });
    await send(page, { type: 'generationProgress', unitId: 'clamp', receivedCharacters: 999 });
    await expect(page.locator('.generation-activity')).toContainText('Working on normalize');
    await node(page, 'clamp').locator('strong').first().click();
    await expect(page.locator('.generation-activity')).toHaveCount(0);
    await node(page, 'scoring/normalize_score').locator('strong').first().click();
    await send(page, { type: 'proposalReady', proposal: { id: 'unrelated', unitId: 'clamp', path: 'slate/nodes/clamp.json', candidate: 'wrong candidate', checks: [] } });
    await expect(page.locator('.generation-activity')).toContainText('Working on normalize');
    await send(page, { type: 'generationFailed', unitId: 'clamp', message: 'Unrelated failure' });
    await expect(page.locator('.generation-activity')).toContainText('Working on normalize');
    await send(page, { type: 'proposalReady', proposal: { id: 'current', unitId: 'scoring/normalize_score', path: 'slate/nodes/scoring/normalize_score.json', candidate: 'candidate', checks: [] } });
    await send(page, { type: 'proposalStale', proposalId: 'old', message: 'Unrelated stale' });
    await expect(page.getByRole('button', { name: 'Accept WorkspaceEdit' })).toBeEnabled();
    await expect(page.locator('.proposal-review')).not.toContainText('Unrelated stale');
});

test('chain multi-drag emits positions for all selected nodes', async ({ page }) => {
    await node(page, 'clamp').locator('strong').first().click();
    await node(page, 'scoring/normalize_score').locator('strong').first().click({ modifiers: ['Shift'] });
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
    const box = await settle(node(page, 'clamp').locator('strong').first());
    await clear(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 + 30, { steps: 10 });
    await page.mouse.up();
    const updates = (await messages(page)).filter(v => v.type === 'layout');
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0].positions).sort()).toEqual(['clamp', 'scoring/normalize_score']);
});

test('chain trackpad pinch wheel gesture zooms canvas', async ({ page }) => {
    const viewport = page.locator('.react-flow__viewport');
    await settle(node(page, 'clamp'));
    const initial = await viewport.getAttribute('style');
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    // Chromium exposes trackpad pinch to web content as Ctrl+wheel.
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(initial);
});

test('chain deleted search target cannot create phantom selection', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await search(page, 'clamp');
    await snapshot(page, value => { value.documents = value.documents.filter(d => d.units[0]?.id !== 'clamp'); });
    await send(page, { type: 'searchResults', query: 'clamp', stale: true, results: [{ unitId: 'clamp', path: 'slate/nodes/clamp.json',
        qualifiedName: 'clamp', signature: 'def clamp()', snippet: 'old source', reason: 'exact name', score: 100 }] });
    await page.getByRole('region', { name: 'Search results for clamp' }).getByRole('button', { name: /clamp.*exact name/ }).click();
    await expect(node(page, 'clamp')).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('graph changed; search again');
    expect(errors).toEqual([]);
});

test('chain single selection opens inspector and quick reselection cancels the old inspector', async ({ page }) => {
    await node(page, 'clamp').locator('strong').first().click();
    await node(page, 'scoring/normalize_score').locator('strong').first().click();
    const inspector = page.getByRole('complementary', { name: 'Selected node details' });
    await expect(inspector.getByRole('heading', { name: 'normalize_score', exact: true })).toBeVisible();
    await expect(inspector.getByRole('heading', { name: 'clamp', exact: true })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/qa-selected-inspector.png' });
    await command(page, 'Clear selection');
    await expect(inspector).toHaveCount(0);
});

for (const [id, label, expected] of [
    ['clamp', 'Generate implementation', { type: 'generate', unitId: 'clamp' }],
    ['ref-clamp', 'Generate body', { type: 'generate', unitId: 'clamp' }],
] as const) {
    test(`chain ${label} from ${id} context menu`, async ({ page }) => {
        await node(page, id).click({ button: 'right' });
        await clear(page);
        await page.getByRole('menuitem', { name: label, exact: true }).click();
        await expect(page.getByRole('menu')).toHaveCount(0);
        await expect.poll(() => messages(page)).toContainEqual(expected);
    });
}

for (const [label, kind] of [
    ['New node file…', 'createNode'], ['New placeholder…', 'createPlaceholder'],
    ['New flow…', 'createFlow'], ['Refresh source index', 'refreshIndex'],
] as const) {
    test(`chain board menu ${label}`, async ({ page }) => {
        await blank(page, 'right');
        await clear(page);
        await page.getByRole('menuitem', { name: label, exact: true }).click();
        await expect(page.getByRole('menu')).toHaveCount(0);
        await expect.poll(() => messages(page)).toContainEqual(expect.objectContaining({
            type: 'action', action: expect.objectContaining({ kind }),
        }));
    });
}

test('chain double-click editing controls stays local and value Escape cancels', async ({ page }) => {
    const intent = node(page, 'clamp').locator('.slate-node__intent');
    await intent.dblclick();
    await expect(page.getByLabel('Edit intent')).toBeVisible();
    await clear(page);
    await page.getByLabel('Edit intent').dblclick();
    await page.getByLabel('Edit intent').press('Escape');
    expect((await messages(page)).some(message => message.type === 'reveal')).toBe(false);
    const value = page.getByLabel('Value of value');
    const original = await value.inputValue();
    await value.dblclick();
    await value.fill('999');
    await value.press('Escape');
    await expect(value).toHaveValue(original);
    await value.press('Tab');
    expect((await messages(page)).some(message => message.action?.kind === 'setValue')).toBe(false);
});

for (const [label, kind] of [
    ['New node file…', 'createNode'], ['New placeholder…', 'createPlaceholder'],
    ['New flow…', 'createFlow'], ['Add library file…', 'addLibrary'],
    ['Compile project', 'compile'], ['Save all files', 'saveWorkspace'],
]) {
    test(`palette dispatches ${label} once and closes`, async ({ page }) => {
        await clear(page);
        await command(page, label);
        await expect(page.getByLabel('Command palette input')).toHaveCount(0);
        const actions = (await messages(page)).filter(message => message.type === 'action');
        expect(actions).toHaveLength(1);
        expect(actions[0].action).toMatchObject({ kind });
        if (kind.startsWith('create')) {
            expect(Number.isFinite(actions[0].action.x)).toBe(true);
            expect(Number.isFinite(actions[0].action.y)).toBe(true);
        }
    });
}

test('palette switches canvas views and returns from a flow while preserving navigation controls', async ({ page }) => {
    await command(page, 'Switch to Map');
    await expect(page.getByRole('button', { name: 'Map', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(node(page, 'ref-clamp')).toHaveCount(0);
    await command(page, 'Switch to Compose');
    await expect(node(page, 'ref-clamp')).toBeVisible();
    await command(page, 'Flow: report');
    await expect(node(page, '__input')).toBeVisible();
    await command(page, 'Back to parent canvas');
    await expect(node(page, 'clamp')).toBeVisible();
    await expect(node(page, '__input')).toHaveCount(0);
});

test('source double-click preserves unsaved inspector code and metadata drafts', async ({ page }) => {
    const target = node(page, 'clamp').locator('strong').first();
    await target.click();
    await page.getByLabel('Function intent').fill('Unsaved intent');
    await page.getByLabel('Function contract').fill('Unsaved contract');
    const code = 'def clamp(value: int, lower: int, upper: int) -> int:\n    return 123';
    await page.locator('.node-code-editor .cm-content').fill(code);
    await clear(page);
    await target.dblclick();
    await expect(page.getByRole('complementary', { name: 'Selected node details' })).toHaveCount(0);
    expect(await messages(page)).toContainEqual({ type: 'reveal', unitId: 'clamp', focus: true });
    await target.click();
    await expect(page.getByLabel('Function intent')).toHaveValue('Unsaved intent');
    await expect(page.getByLabel('Function contract')).toHaveValue('Unsaved contract');
    await expect(page.locator('.node-code-editor .cm-content')).toHaveText(code);
    await expect(page.getByRole('button', { name: 'Save code', exact: true })).toBeEnabled();
    expect((await messages(page)).filter(message => message.type === 'action')).toEqual([]);
    await page.getByRole('button', { name: 'Save code', exact: true }).click();
    expect(await messages(page)).toContainEqual(expect.objectContaining({ type: 'action', action: expect.objectContaining({ kind: 'setNodeCode', code }) }));
    await page.screenshot({ path: 'test-results/qa-preserved-drafts.png' });
});

test('double-click preserves unsaved note fields and attachment until explicit Save', async ({ page }) => {
    await snapshot(page, value => { value.layout!['board-note-port'] = { x: 100, y: 650 }; });
    const target = node(page, 'board-note-port').locator('strong').first();
    await target.click();
    await page.getByLabel('Note title').fill('Unsaved title');
    await page.getByLabel('Note body').fill('Unsaved body');
    await page.getByLabel('Attach note to function').selectOption('clamp');
    await clear(page);
    await target.dblclick();
    await expect(page.getByRole('complementary', { name: 'Selected node details' })).toHaveCount(0);
    await target.click();
    await expect(page.getByLabel('Note title')).toHaveValue('Unsaved title');
    await expect(page.getByLabel('Note body')).toHaveValue('Unsaved body');
    await expect(page.getByLabel('Attach note to function')).toHaveValue('clamp');
    expect((await messages(page)).filter(message => message.type === 'noteUpdate')).toEqual([]);
    await page.getByRole('button', { name: 'Save board note', exact: true }).click();
    expect(await messages(page)).toContainEqual(expect.objectContaining({ type: 'noteUpdate', title: 'Unsaved title', body: 'Unsaved body', attachedTo: 'clamp' }));
});

for (const width of [320, 480]) {
    test(`narrow ${width}px pane keeps view controls clear of status text`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        const path = page.getByRole('navigation', { name: 'Canvas path' });
        const bounds = await path.boundingBox();
        const status = await page.locator('.harness-status').boundingBox();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(status!.x);
        await page.getByRole('button', { name: 'Map', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Map', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await page.getByRole('button', { name: 'Compose', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Compose', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await page.getByRole('button', { name: 'Library', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Library', exact: true })).toHaveAttribute('aria-pressed', 'false');
        await page.screenshot({ path: `test-results/qa-narrow-${width}.png` });
    });
}

test('palette shortcuts stop propagation in capture phase before host bubble listeners see them', async ({ page }) => {
    await page.addInitScript(() => {
        const forwarded: string[] = [];
        Object.defineProperty(window, 'forwardedKeys', { value: forwarded });
        window.addEventListener('keydown', event => {
            if (event.key === 'Control' || event.key === 'Meta') return;
            forwarded.push(`${event.ctrlKey ? 'Ctrl+' : ''}${event.metaKey ? 'Meta+' : ''}${event.key}`);
        });
    });
    await page.goto('/harness.html?demo');
    await expect(node(page, 'clamp')).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.getByLabel('Command palette input')).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.getByLabel('Command palette input')).toHaveCount(0);
    await page.keyboard.press('/');
    await expect(page.getByLabel('Command palette input')).toBeVisible();
    await page.getByLabel('Command palette input').press('/');
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Command palette input')).toHaveCount(0);
    const forwarded = await page.evaluate(() => (window as unknown as { forwardedKeys: string[] }).forwardedKeys);
    expect(forwarded).not.toContain('Ctrl+k');
    expect(forwarded).not.toContain('Ctrl+K');
    expect(forwarded).toEqual(['/', 'Escape']);
});

test('chain canvas ergonomics: Delete/Backspace prompt, copy/paste linked/duplicate, make unique, and port context menu', async ({ page }) => {
    // 1. Delete and Backspace trigger deleteItems with prompt: true
    await node(page, 'ref-clamp').click();
    await page.keyboard.press('Delete');
    expect(await messages(page)).toContainEqual(expect.objectContaining({
        type: 'action',
        action: expect.objectContaining({ kind: 'deleteItems', ids: ['ref-clamp'], prompt: true }),
    }));

    await clear(page);
    await node(page, 'ref-clamp').click();
    await page.keyboard.press('Backspace');
    expect(await messages(page)).toContainEqual(expect.objectContaining({
        type: 'action',
        action: expect.objectContaining({ kind: 'deleteItems', ids: ['ref-clamp'], prompt: true }),
    }));

    // 2. Copy and Paste linked (Control+c, Control+v)
    await clear(page);
    await node(page, 'ref-clamp').click();
    await page.keyboard.press('Control+c');
    await expect(page.getByRole('status')).toContainText('Copied 1 item(s)');

    await page.keyboard.press('Control+v');
    expect(await messages(page)).toContainEqual(expect.objectContaining({
        type: 'action',
        action: expect.objectContaining({
            kind: 'pasteItems',
            mode: 'linked',
            items: expect.arrayContaining([expect.objectContaining({ id: 'ref-clamp', node: 'clamp' })]),
        }),
    }));

    // 3. Paste duplicate (Control+Shift+v)
    await clear(page);
    await page.keyboard.press('Control+Shift+V');
    expect(await messages(page)).toContainEqual(expect.objectContaining({
        type: 'action',
        action: expect.objectContaining({
            kind: 'pasteItems',
            mode: 'duplicate',
            items: expect.arrayContaining([expect.objectContaining({ id: 'ref-clamp', node: 'clamp' })]),
        }),
    }));

    // 4. "Make unique" button in Inspector
    await clear(page);
    await node(page, 'ref-clamp').click();
    const makeUniqueBtn = page.getByRole('button', { name: 'Make unique', exact: true });
    await expect(makeUniqueBtn).toBeVisible();
    await makeUniqueBtn.click();
    expect(await messages(page)).toContainEqual(expect.objectContaining({
        type: 'action',
        action: expect.objectContaining({ kind: 'makeUnique', id: 'ref-clamp' }),
    }));

    // 5. Flow port rename and delete in flow group context menu
    await command(page, 'Flow: report');
    await expect(node(page, '__output')).toBeVisible();
    await node(page, '__output').click({ button: 'right' });
    const renameItem = page.getByRole('menuitem', { name: /Rename output/ });
    await expect(renameItem.first()).toBeVisible();
    await renameItem.first().click();
    expect(await messages(page)).toContainEqual(expect.objectContaining({
        type: 'action',
        action: expect.objectContaining({ flow: 'report', kind: 'renameFlowPort', direction: 'output' }),
    }));
});
