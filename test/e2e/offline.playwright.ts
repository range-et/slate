import { expect, test } from './coverage-fixture';

test('offline demo search reports the missing host without losing the canvas', async ({ page }) => {
    await page.goto('/harness.html?demo');
    await expect(page.locator('.react-flow__node[data-id="clamp"]')).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByLabel('Command palette input').fill('unmatched-symbol');
    await page.getByRole('option').filter({ hasText: 'Search code for' }).click();
    await expect(page.getByRole('status')).toContainText('Search needs the VS Code extension.');
    await expect(page.locator('.react-flow__node[data-id="clamp"]')).toBeVisible();
});

test('empty canvas starts without a host and can open and dismiss add search', async ({ page }) => {
    await page.goto('/harness.html');
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await page.locator('.react-flow__pane').dblclick({ position: { x: 200, y: 200 } });
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
});
