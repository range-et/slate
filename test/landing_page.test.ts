import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Product landing page (src/index.html)', () => {
    const htmlPath = path.resolve(__dirname, '../src/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    it('uses HTML5 doctype and loads only Monad runtime assets', () => {
        expect(html).toContain('<!doctype html>');
        expect(html).toContain('data-strata="dark"');
        expect(html).toContain('rel="stylesheet" href="./monad.css"');
        expect(html).toContain('<script src="./monad.js"></script>');
        expect(html).not.toContain('explainer.ts');
    });

    it('contains no embedded demo or interactive simulator controls', () => {
        expect(html).not.toContain('harness.html?demo');
        expect(html).not.toContain('id="micro-studio"');
        expect(html).not.toContain('id="sim-forge-btn"');
        expect(html).not.toContain('id="explainer-slider"');
    });

    it('strictly follows the Monad System CSS and token rules', () => {
        const styleBlockMatch = html.match(/<style>([\s\S]*?)<\/style>/i);
        expect(styleBlockMatch).not.toBeNull();
        const styleCss = styleBlockMatch?.[1] ?? '';
        const inlineStyles = [...html.matchAll(/\sstyle="([^"]*)"/gi)].map(m => m[1]).join('\n');
        const authoredCss = `${styleCss}\n${inlineStyles}`;

        expect(authoredCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(authoredCss).not.toMatch(/\brgba?\s*\(/i);
        expect(authoredCss).not.toMatch(/border-radius\s*:/i);
        expect(authoredCss).not.toMatch(/box-shadow\s*:/i);
        expect(authoredCss).not.toMatch(/gradient\s*\(/i);
        expect(authoredCss).not.toMatch(/backdrop-filter\s*:/i);
        expect(authoredCss).not.toMatch(/translateY/i);
        expect(html).toContain('class="monad-header"');
        expect(html).toContain('class="monad-grid');
        expect(html).toContain('class="atomos-table atomos-table--zebra"');
        expect(html).toContain('data-mn-theme-toggle');
        expect(html).toContain('data-mn-threshold-toggle');
        expect(html).toContain('data-mn-threshold-nav');
    });

    it('presents Slate thinking, structure, Two-Tier AI, and agent install instructions in matter-of-fact STE', () => {
        expect(html).toContain('Small verified functions. Deterministic graphs.');
        expect(html).toContain('Language models do not have memory');
        expect(html).toContain('id="thinking"');
        expect(html).toContain('id="structure"');
        expect(html).toContain('id="two-tier"');
        expect(html).toContain('id="languages"');
        expect(html).toContain('id="install"');
        expect(html).toContain('JPL-60');
        expect(html).toContain('&lt;= 60 lines');
        expect(html).toContain('&lt;= 600 tokens');
        expect(html).toContain('Model Context Protocol');
        expect(html).toContain('slate_mcp_server.js');
        expect(html).toContain('llama.cpp');
        expect(html).toContain('Ollama');
        expect(html).toContain('OpenRouter');
        expect(html).toContain('npm run package-extension -- --install');
        expect(html).toContain('https://github.com/range-et/slate');
        expect(html).toContain('docs/motivation.md');
        expect(html).toContain('README.md');
        expect(html).not.toMatch(/flips this paradigm|sprawling|bloated|unleash|supercharge|blacksmiths|0 Guesswork|Ready in Seconds|Engineered for Verifiability/i);
    });
});
