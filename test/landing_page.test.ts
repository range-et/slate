import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { computePipeline, EXPLAINER_NODES, generateCompiledPython } from '../src/explainer';

describe('Product landing page (src/index.html)', () => {
    const htmlPath = path.resolve(__dirname, '../src/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    it('exists and includes valid HTML5 doctype and Monad system links', () => {
        expect(html).toContain('<!doctype html>');
        expect(html).toContain('data-strata="dark"');
        expect(html).toContain('rel="stylesheet" href="./monad.css"');
        expect(html).toContain('<script src="./monad.js"></script>');
        expect(html).toContain('<script type="module" src="./explainer.ts"></script>');
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

    it('embeds the interactive micro-studio explainer elements', () => {
        expect(html).toContain('id="micro-studio"');
        expect(html).toContain('id="explainer-slider"');
        expect(html).toContain('data-walkthrough-step="1"');
        expect(html).toContain('data-walkthrough-step="2"');
        expect(html).toContain('data-walkthrough-step="3"');
        expect(html).toContain('data-walkthrough-step="4"');
        expect(html).toContain('data-inspector-tab="code"');
        expect(html).toContain('data-inspector-tab="packet"');
        expect(html).toContain('data-inspector-tab="compiled"');
        expect(html).toContain('id="sim-forge-btn"');
    });
});

describe('Explainer Engine (src/explainer.ts)', () => {
    it('defines valid JPL-60 nodes with tokens strictly <= 600', () => {
        for (const [id, node] of Object.entries(EXPLAINER_NODES)) {
            expect(node.id).toBe(id);
            expect(node.lines).toBeLessThanOrEqual(60);
            expect(node.jpl60).toBe(true);
            expect(node.signature).toMatch(/^def \w+\(.*\)\s*->\s*\w+/);
            expect(node.packet.tokens).toBeLessThanOrEqual(600);
            expect(node.packet.budgetLimit).toBe(600);
            expect(node.code).toContain('validate_call');
        }
    });

    it('computes pipeline clamping and tier classification accurately', () => {
        // High score clamped to 10.0 -> ratio 1.0 -> Tier A
        const high = computePipeline(14.5);
        expect(high.rawScore).toBe(14.5);
        expect(high.clampedScore).toBe(10.0);
        expect(high.normalizedRatio).toBe(1.0);
        expect(high.tier).toContain('TIER_A');

        // Mid score -> ratio 0.7 -> Tier B
        const mid = computePipeline(7.0);
        expect(mid.clampedScore).toBe(7.0);
        expect(mid.normalizedRatio).toBe(0.7);
        expect(mid.tier).toContain('TIER_B');

        // Low score clamped to 0.0 -> ratio 0.0 -> Tier C
        const low = computePipeline(-3.2);
        expect(low.clampedScore).toBe(0.0);
        expect(low.normalizedRatio).toBe(0.0);
        expect(low.tier).toContain('TIER_C');
    });

    it('generates deterministic compiled Python without LLM glue code', () => {
        const py = generateCompiledPython(12.5);
        expect(py).toContain('def score_pipeline(raw_score: float) -> str:');
        expect(py).toContain('val_clamped = clamp(val=raw_score, low=0.0, high=10.0)');
        expect(py).toContain('ratio = normalize(score=val_clamped, max_score=10.0)');
        expect(py).toContain('tier = evaluate_tier(ratio=ratio)');
        expect(py).toContain('score_pipeline(12.5) -> "TIER_A (Excellent)"');
    });
});
