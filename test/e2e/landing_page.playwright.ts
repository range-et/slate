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

    for (const theme of ['dark', 'light'] as const) {
        const expectedBg = theme === 'light' ? 'rgb(242, 244, 247)' : 'rgb(15, 17, 19)';

        test(`captures screenshots and verifies layout without overflow (${theme} theme)`, async ({ page }) => {
            await page.addInitScript(t => window.localStorage.setItem('mn-strata', t), theme);
            await page.setViewportSize({ width: 1280, height: 800 });
            await page.goto('/index.html');
            await page.evaluate(() => document.fonts?.ready);

            await expect(page.locator('html')).toHaveAttribute('data-strata', theme);
            await expect(page.locator('body')).toHaveCSS('background-color', expectedBg);

            const desktopMetrics = await page.evaluate(() => {
                const selectors = ['.monad-header', '.hero-title', '#thinking', '#structure', '#two-tier', '#languages', '#install', '.atomos-table', 'footer'];
                const boxes = selectors.map(sel => {
                    const el = document.querySelector(sel);
                    const rect = el ? el.getBoundingClientRect() : null;
                    return { sel, exists: Boolean(el), width: rect?.width ?? 0, height: rect?.height ?? 0 };
                });
                return {
                    scrollWidth: document.documentElement.scrollWidth,
                    innerWidth: window.innerWidth,
                    boxes,
                };
            });

            expect(desktopMetrics.scrollWidth).toBeLessThanOrEqual(desktopMetrics.innerWidth);
            for (const box of desktopMetrics.boxes) {
                expect(box.exists, `${box.sel} exists`).toBe(true);
                expect(box.width, `${box.sel} width`).toBeGreaterThan(0);
                expect(box.height, `${box.sel} height`).toBeGreaterThan(0);
            }

            const desktopShot = await page.screenshot({
                path: `test-results/landing-${theme}-desktop.png`,
                fullPage: true,
            });
            expect(desktopShot.byteLength).toBeGreaterThan(1000);

            await page.setViewportSize({ width: 800, height: 900 });
            const toggle = page.locator('[data-mn-threshold-toggle]');
            const nav = page.locator('[data-mn-threshold-nav]');
            await toggle.click();
            await expect(nav).toHaveClass(/is-open/);

            const mobileMetrics = await page.evaluate(() => {
                const navEl = document.querySelector('[data-mn-threshold-nav]');
                const rect = navEl ? navEl.getBoundingClientRect() : null;
                return {
                    scrollWidth: document.documentElement.scrollWidth,
                    innerWidth: window.innerWidth,
                    navWidth: rect?.width ?? 0,
                    navHeight: rect?.height ?? 0,
                };
            });
            expect(mobileMetrics.scrollWidth).toBeLessThanOrEqual(mobileMetrics.innerWidth);
            expect(mobileMetrics.navWidth).toBeGreaterThan(0);
            expect(mobileMetrics.navHeight).toBeGreaterThan(0);

            const mobileShot = await page.screenshot({
                path: `test-results/landing-${theme}-mobile-drawer.png`,
            });
            expect(mobileShot.byteLength).toBeGreaterThan(1000);
        });

        test(`supports keyboard-only navigation and visible focus (${theme} theme)`, async ({ page }) => {
            await page.addInitScript(t => window.localStorage.setItem('mn-strata', t), theme);
            await page.setViewportSize({ width: 1280, height: 800 });
            await page.goto('/index.html');

            let focusedThemeToggle = false;
            for (let i = 0; i < 15; i += 1) {
                await page.keyboard.press('Tab');
                focusedThemeToggle = await page.evaluate(() =>
                    Boolean(document.activeElement?.matches('[data-mn-theme-toggle]')),
                );
                if (focusedThemeToggle) break;
            }
            expect(focusedThemeToggle).toBe(true);

            const focusStyle = await page.evaluate(() => {
                const el = document.activeElement;
                if (!el) return null;
                const cs = getComputedStyle(el);
                return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth };
            });
            expect(focusStyle).not.toBeNull();
            expect(focusStyle?.outlineStyle).not.toBe('none');
            expect(focusStyle?.outlineWidth).not.toBe('0px');

            const oppositeTheme = theme === 'dark' ? 'light' : 'dark';
            await page.keyboard.press('Enter');
            await expect(page.locator('html')).toHaveAttribute('data-strata', oppositeTheme);
            await expect(page.locator('[data-mn-theme-toggle]')).toHaveAttribute(
                'aria-pressed',
                String(oppositeTheme === 'light'),
            );

            await page.setViewportSize({ width: 800, height: 900 });
            await page.addInitScript(t => window.localStorage.setItem('mn-strata', t), theme);
            await page.goto('/index.html');

            let focusedMenuToggle = false;
            for (let i = 0; i < 10; i += 1) {
                await page.keyboard.press('Tab');
                focusedMenuToggle = await page.evaluate(() =>
                    Boolean(document.activeElement?.matches('[data-mn-threshold-toggle]')),
                );
                if (focusedMenuToggle) break;
            }
            expect(focusedMenuToggle).toBe(true);

            await page.keyboard.press('Enter');
            const toggle = page.locator('[data-mn-threshold-toggle]');
            const nav = page.locator('[data-mn-threshold-nav]');
            await expect(nav).toHaveClass(/is-open/);
            await expect(toggle).toHaveAttribute('aria-expanded', 'true');
            await expect(nav).toHaveAttribute('aria-hidden', 'false');

            let reachedNavLink = false;
            for (let i = 0; i < 10; i += 1) {
                await page.keyboard.press('Tab');
                reachedNavLink = await page.evaluate(() => {
                    const active = document.activeElement;
                    if (!active || active.tagName !== 'A') return false;
                    if (!active.closest('[data-mn-threshold-nav]')) return false;
                    const rect = active.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                });
                if (reachedNavLink) break;
            }
            expect(reachedNavLink).toBe(true);

            await page.keyboard.press('Escape');
            await expect(nav).not.toHaveClass(/is-open/);
            await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            await expect(nav).toHaveAttribute('aria-hidden', 'true');
        });

        test(`honors prefers-reduced-motion: reduce (${theme} theme)`, async ({ page }) => {
            await page.addInitScript(t => window.localStorage.setItem('mn-strata', t), theme);
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.goto('/index.html');

            const motion = await page.evaluate(() => {
                const rootStyles = getComputedStyle(document.documentElement);
                const parseDurationSeconds = (raw: string): number[] =>
                    raw.split(',').map(part => {
                        const trimmed = part.trim();
                        if (trimmed.endsWith('ms')) return Number.parseFloat(trimmed) / 1000;
                        return Number.parseFloat(trimmed);
                    });

                const targets = ['body', '.threshold-nav a', '.atomos-btn', '.strata-toggle'].map(sel => {
                    const el = document.querySelector(sel);
                    const raw = el ? getComputedStyle(el).transitionDuration : '';
                    return { sel, exists: Boolean(el), durations: raw ? parseDurationSeconds(raw) : [] };
                });

                return {
                    fast: rootStyles.getPropertyValue('--threshold-duration-fast').trim(),
                    base: rootStyles.getPropertyValue('--threshold-duration-base').trim(),
                    targets,
                };
            });

            expect(motion.fast).toBe('0.01ms');
            expect(motion.base).toBe('0.01ms');
            for (const target of motion.targets) {
                expect(target.exists, `${target.sel} exists`).toBe(true);
                for (const d of target.durations) {
                    expect(d, `${target.sel} transitionDuration`).toBeLessThanOrEqual(0.001);
                }
            }

            const oppositeTheme = theme === 'dark' ? 'light' : 'dark';
            await page.locator('[data-mn-theme-toggle]').click();
            await expect(page.locator('html')).toHaveAttribute('data-strata', oppositeTheme);

            await page.setViewportSize({ width: 800, height: 900 });
            const toggle = page.locator('[data-mn-threshold-toggle]');
            const nav = page.locator('[data-mn-threshold-nav]');
            await toggle.click();
            await expect(nav).toHaveClass(/is-open/);
            await toggle.click();
            await expect(nav).not.toHaveClass(/is-open/);
        });

        test(`passes DOM accessibility and semantics checks (${theme} theme)`, async ({ page }) => {
            await page.addInitScript(t => window.localStorage.setItem('mn-strata', t), theme);
            await page.goto('/index.html');

            const a11y = await page.evaluate(() => {
                const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map(el =>
                    Number.parseInt(el.tagName.slice(1), 10),
                );
                let skippedHeading = false;
                for (let i = 1; i < headings.length; i += 1) {
                    if (headings[i] > headings[i - 1] + 1) skippedHeading = true;
                }

                const buttonsWithoutType = [...document.querySelectorAll('button')]
                    .filter(b => b.getAttribute('type') !== 'button').length;
                const buttonsWithoutName = [...document.querySelectorAll('button')]
                    .filter(b => !(b.getAttribute('aria-label')?.trim() || b.textContent?.trim())).length;
                const linksWithoutName = [...document.querySelectorAll('a')]
                    .filter(a => !(a.getAttribute('aria-label')?.trim() || a.textContent?.trim())).length;
                const headersWithoutScope = [...document.querySelectorAll('th')]
                    .filter(th => th.getAttribute('scope') !== 'col').length;

                const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
                const duplicateIds = ids.length - new Set(ids).size;
                const positiveTabindex = [...document.querySelectorAll('[tabindex]')]
                    .filter(el => Number.parseInt(el.getAttribute('tabindex') ?? '0', 10) > 0).length;

                return {
                    lang: document.documentElement.lang,
                    title: document.title.trim(),
                    h1Count: document.querySelectorAll('h1').length,
                    skippedHeading,
                    hasHeader: Boolean(document.querySelector('header')),
                    hasNav: Boolean(document.querySelector('nav[aria-label]')),
                    hasMain: Boolean(document.querySelector('main')),
                    hasFooter: Boolean(document.querySelector('footer')),
                    buttonsWithoutType,
                    buttonsWithoutName,
                    linksWithoutName,
                    headersWithoutScope,
                    duplicateIds,
                    positiveTabindex,
                };
            });

            expect(a11y.lang).toBe('en');
            expect(a11y.title.length).toBeGreaterThan(0);
            expect(a11y.h1Count).toBe(1);
            expect(a11y.skippedHeading).toBe(false);
            expect(a11y.hasHeader).toBe(true);
            expect(a11y.hasNav).toBe(true);
            expect(a11y.hasMain).toBe(true);
            expect(a11y.hasFooter).toBe(true);
            expect(a11y.buttonsWithoutType).toBe(0);
            expect(a11y.buttonsWithoutName).toBe(0);
            expect(a11y.linksWithoutName).toBe(0);
            expect(a11y.headersWithoutScope).toBe(0);
            expect(a11y.duplicateIds).toBe(0);
            expect(a11y.positiveTabindex).toBe(0);
        });
    }
});
