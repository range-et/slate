import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Product landing page (src/index.html)', () => {
    const htmlPath = path.resolve(__dirname, '../src/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    it('exists and includes valid HTML5 doctype and Monad system links', () => {
        expect(html).toContain('<!doctype html>');
        expect(html).toContain('data-strata="dark"');
        expect(html).toContain('rel="stylesheet" href="./monad.css"');
        expect(html).toContain('<script src="./monad.js"></script>');
    });

    it('highlights the Grasshopper mental model and JPL-60 constraints', () => {
        expect(html).toMatch(/Grasshopper for Software/i);
        expect(html).toMatch(/Forge atomic components/i);
        expect(html).toMatch(/Compose verified software/i);
        expect(html).toMatch(/JPL-60 RULE/i);
        expect(html).toMatch(/≤ 60 Lines/i);
        expect(html).toMatch(/≤ 600 Tokens/i);
    });

    it('articulates the Two-Tier AI division of labor', () => {
        expect(html).toContain('Frontier Architect');
        expect(html).toContain('Local Component Forge');
        expect(html).toContain('llama.cpp');
        expect(html).toContain('Model Context Protocol');
    });

    it('emphasizes unbundled local LLM architecture', () => {
        expect(html).toMatch(/Unbundled Local LLM Architecture/i);
        expect(html).toContain('llama-server');
        expect(html).toContain('Ollama');
        expect(html).toContain('LM Studio');
    });

    it('provides navigation links to demo and documentation', () => {
        expect(html).toContain('./harness.html?demo');
        expect(html).toContain('https://github.com/range-et/slate');
        expect(html).toContain('docs/motivation.md');
        expect(html).toContain('data-mn-theme-toggle');
    });
});
