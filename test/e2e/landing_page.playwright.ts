import { expect, test } from '@playwright/test';

test.describe('Landing Page & Explainer Micro-Studio E2E', () => {
    test('renders landing page with Monad theme toggle, stats, and demo navigation', async ({ page }) => {
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

    test('interactively propagates live dataflow through micro-canvas wires', async ({ page }) => {
        await page.goto('/index.html');

        const studio = page.locator('#micro-studio');
        await expect(studio).toBeVisible();

        // Check initial state (score = 12.5 -> clamped 10.0 -> ratio 1.00 -> TIER_A)
        const valInput = page.locator('#port-val-input');
        const valClamped = page.locator('#port-val-clamped');
        const valNorm = page.locator('#port-val-norm');
        const valTier = page.locator('#port-val-tier');

        await expect(valInput).toHaveText('12.5');
        await expect(valClamped).toHaveText('10.0');
        await expect(valNorm).toHaveText('1.00');
        await expect(valTier).toHaveText('TIER_A (Excellent)');

        // Change slider to 7.0 via number input
        const numInput = page.locator('#explainer-num');
        await numInput.fill('7.0');
        await numInput.dispatchEvent('input');

        await expect(valInput).toHaveText('7.0');
        await expect(valClamped).toHaveText('7.0');
        await expect(valNorm).toHaveText('0.70');
        await expect(valTier).toHaveText('TIER_B (Proficient)');

        // Change to negative value -3.0
        await numInput.fill('-3.0');
        await numInput.dispatchEvent('input');

        await expect(valInput).toHaveText('-3.0');
        await expect(valClamped).toHaveText('0.0');
        await expect(valNorm).toHaveText('0.00');
        await expect(valTier).toHaveText('TIER_C (Needs Review)');
    });

    test('interacts with node inspection, forge simulation, and walkthrough stepper', async ({ page }) => {
        await page.goto('/index.html');

        // Click normalize node
        const normalizeCard = page.locator('[data-node-id="normalize"]');
        await normalizeCard.click();

        const inspectorTitle = page.locator('#inspector-title');
        await expect(inspectorTitle).toHaveText('fn normalize');

        // Switch to Forge Packet tab
        const packetTab = page.locator('[data-inspector-tab="packet"]');
        await packetTab.click();

        const tokenCount = page.locator('#inspector-tokens');
        await expect(tokenCount).toContainText('/ 600 tokens');

        // Simulate local forge
        const forgeBtn = page.locator('#sim-forge-btn');
        await expect(forgeBtn).toBeVisible();
        await forgeBtn.click();

        const forgeStatus = page.locator('#forge-sim-status');
        await expect(forgeStatus).toBeVisible();
        await expect(forgeStatus).toContainText('Dispatching micro-packet');
        await expect(forgeStatus).toContainText('mutmut: 0 survivors');

        const acceptBtn = page.locator('#sim-accept-btn');
        await expect(acceptBtn).toBeVisible();
        await acceptBtn.click();
        await expect(forgeStatus).toContainText('Candidate accepted into slate/nodes/normalize.json');

        // Click walkthrough step 4: Python Output
        const step4Btn = page.locator('[data-walkthrough-step="4"]');
        await step4Btn.click();

        const callout = page.locator('#walkthrough-callout');
        await expect(callout).toContainText('Step 4: Deterministic Compilation');

        const compiledCode = page.locator('#inspector-compiled');
        await expect(compiledCode).toContainText('from nodes.clamp import clamp');
        await expect(compiledCode).toContainText('def score_pipeline(raw_score: float) -> str:');
    });
});
