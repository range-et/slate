import { expect, test } from '@playwright/test';

test.describe('Landing Page E2E', () => {
    test('renders landing page with Monad theme toggle and demo navigation', async ({ page }) => {
        await page.goto('/index.html');

        // Verify Hero Title
        const heroTitle = page.locator('.hero-title');
        await expect(heroTitle).toBeVisible();
        await expect(heroTitle).toContainText('Forge atomic components');
        await expect(heroTitle).toContainText('Compose verified software');

        // Verify Monad Theme Toggle
        const html = page.locator('html');
        const initialTheme = await html.getAttribute('data-strata') ?? 'dark';
        const nextTheme = initialTheme === 'dark' ? 'light' : 'dark';

        const themeBtn = page.locator('[data-mn-theme-toggle]');
        await expect(themeBtn).toBeVisible();
        await themeBtn.click();
        await expect(html).toHaveAttribute('data-strata', nextTheme);

        await themeBtn.click();
        await expect(html).toHaveAttribute('data-strata', initialTheme);

        // Verify Hero Stats Strip
        const stats = page.locator('.atomos-stat');
        await expect(stats).toHaveCount(4);
        await expect(stats.nth(0)).toContainText('≤ 60 Lines');
        await expect(stats.nth(1)).toContainText('≤ 600 Tokens');
        await expect(stats.nth(2)).toContainText('0 Guesswork');
        await expect(stats.nth(3)).toContainText('100% Unbundled');

        // Verify Navigation Link to Demo Harness
        const demoLink = page.getByRole('link', { name: 'Launch Demo' }).first();
        await expect(demoLink).toBeVisible();
        await expect(demoLink).toHaveAttribute('href', './harness.html?demo');
    });
});
