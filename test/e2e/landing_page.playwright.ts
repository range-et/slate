import { expect, test } from '@playwright/test';

test.describe('Landing Page (src/index.html) Monad & STE E2E', () => {
    test('renders core STE sections, dark/light Monad strata theme toggle, and zero demo links', async ({ page }) => {
        await page.goto('/index.html');

        await expect(page.locator('.hero-title')).toHaveText('Small verified functions. Deterministic graphs.');

        const stats = page.locator('.atomos-stat');
        await expect(stats).toHaveCount(4);
        await expect(stats.nth(0)).toContainText('<= 60 lines');
        await expect(stats.nth(1)).toContainText('<= 600 tokens');
        await expect(stats.nth(2)).toContainText('Deterministic');
        await expect(stats.nth(3)).toContainText('Unbundled');

        for (const id of ['thinking', 'structure', 'two-tier', 'languages', 'install']) {
            await expect(page.locator(`#${id}`)).toBeVisible();
        }
        await expect(page.locator('.atomos-table')).toContainText('slate_mcp_server.js');
        await expect(page.locator('#install')).toContainText('npm run package-extension -- --install');

        // Confirm no demo embeds or harness?demo links exist on the product page
        await expect(page.locator('#micro-studio')).toHaveCount(0);
        await expect(page.locator('a[href*="harness.html?demo"]')).toHaveCount(0);

        // Verify dark (#0F1113 -> rgb(15, 17, 19)) and light (#F2F4F7 -> rgb(242, 244, 247)) Monad strata toggle
        const html = page.locator('html');
        const body = page.locator('body');
        const bgFor = (theme: string) => (theme === 'light' ? 'rgb(242, 244, 247)' : 'rgb(15, 17, 19)');
        const initialTheme = (await html.getAttribute('data-strata')) ?? 'dark';
        const nextTheme = initialTheme === 'dark' ? 'light' : 'dark';

        await expect(body).toHaveCSS('background-color', bgFor(initialTheme));

        await page.locator('[data-mn-theme-toggle]').click();
        await expect(html).toHaveAttribute('data-strata', nextTheme);
        await expect(body).toHaveCSS('background-color', bgFor(nextTheme));

        await page.locator('[data-mn-theme-toggle]').click();
        await expect(html).toHaveAttribute('data-strata', initialTheme);
        await expect(body).toHaveCSS('background-color', bgFor(initialTheme));
    });

    test('enforces orthogonal flat Monad geometry and responsive threshold navigation', async ({ page }) => {
        await page.goto('/index.html');

        const geometry = await page.evaluate(() => {
            const selectors = ['.monad-header', '.atomos-stat', '.atomos-card', '.atomos-btn', '.atomos-table'];
            return selectors.map(sel => {
                const el = document.querySelector(sel);
                if (!el) return { sel, missing: true };
                const cs = getComputedStyle(el);
                return {
                    sel,
                    missing: false,
                    borderRadius: cs.borderRadius,
                    boxShadow: cs.boxShadow,
                    backgroundImage: cs.backgroundImage,
                };
            });
        });

        for (const item of geometry) {
            expect(item.missing, `${item.sel} should exist`).toBe(false);
            expect(item.borderRadius, `${item.sel} borderRadius`).toBe('0px');
            expect(item.boxShadow, `${item.sel} boxShadow`).toBe('none');
            expect(item.backgroundImage, `${item.sel} backgroundImage`).toBe('none');
        }

        // Responsive threshold hamburger drawer at <= 1056px
        await page.setViewportSize({ width: 800, height: 900 });
        const toggle = page.locator('[data-mn-threshold-toggle]');
        const nav = page.locator('[data-mn-threshold-nav]');
        await expect(toggle).toBeVisible();
        await expect(nav).toHaveAttribute('aria-hidden', 'true');

        await toggle.click();
        await expect(nav).toHaveClass(/is-open/);
        await expect(nav).toHaveAttribute('aria-hidden', 'false');

        await page.keyboard.press('Escape');
        await expect(nav).not.toHaveClass(/is-open/);
        await expect(nav).toHaveAttribute('aria-hidden', 'true');
    });
});
