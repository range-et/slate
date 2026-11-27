import { describe, expect, it } from 'vitest';

import {
    buildOpenRouterConfig,
    checkGenerationSlot,
    clampForgeConcurrency,
    DEFAULT_OPENROUTER_MODEL,
    formatConcurrencyBadge,
    MAX_FORGE_CONCURRENCY,
    summarizeBatchForge,
} from '../vscode-extension/src/forge_concurrency';

describe('forge_concurrency (forged via Slate Two-Tier Qwen3-Coder-Next)', () => {
    it('exports expected OpenRouter default model and concurrency ceiling', () => {
        expect(DEFAULT_OPENROUTER_MODEL).toBe('qwen/qwen3-coder-next');
        expect(MAX_FORGE_CONCURRENCY).toBe(16);
    });

    it('clamps concurrency values between 1 and 16 with fallback support', () => {
        expect(clampForgeConcurrency(undefined)).toBe(3);
        expect(clampForgeConcurrency(undefined, undefined)).toBe(3);
        expect(clampForgeConcurrency(Number.NaN, 5)).toBe(5);
        expect(clampForgeConcurrency(Number.POSITIVE_INFINITY, 99)).toBe(16);
        expect(clampForgeConcurrency(0, 4)).toBe(1);
        expect(clampForgeConcurrency(-5, 4)).toBe(1);
        expect(clampForgeConcurrency(1)).toBe(1);
        expect(clampForgeConcurrency(16)).toBe(16);
        expect(clampForgeConcurrency(17, 3)).toBe(16);
        expect(clampForgeConcurrency(6.9, 3)).toBe(6);
        expect(clampForgeConcurrency(undefined, 0)).toBe(1);
        expect(clampForgeConcurrency(undefined, 8.7)).toBe(8);
    });

    it('checks generation slot availability for duplicates and max concurrency', () => {
        expect(checkGenerationSlot([], 'alpha', 3)).toBeNull();
        expect(checkGenerationSlot(['alpha'], 'beta', 3)).toBeNull();
        expect(checkGenerationSlot(['alpha', 'beta'], 'alpha', 4)).toBe(
            'Generation for "alpha" is already running.',
        );
        expect(checkGenerationSlot(['alpha', 'beta'], 'gamma', 2)).toBe(
            'Maximum concurrent LLM generations (2) already running.',
        );
        expect(checkGenerationSlot(['a'], 'b', 0)).toBe(
            'Maximum concurrent LLM generations (1) already running.',
        );
    });

    it('builds OpenRouter config defaulting to qwen/qwen3-coder-next', () => {
        expect(buildOpenRouterConfig()).toEqual({
            provider: 'openrouter',
            endpoint: 'https://openrouter.ai/api/v1',
            model: 'qwen/qwen3-coder-next',
            apiKeyEnv: 'OPENROUTER_API_KEY',
            concurrency: 4,
        });
        expect(buildOpenRouterConfig('   ', 8)).toEqual({
            provider: 'openrouter',
            endpoint: 'https://openrouter.ai/api/v1',
            model: 'qwen/qwen3-coder-next',
            apiKeyEnv: 'OPENROUTER_API_KEY',
            concurrency: 8,
        });
        expect(buildOpenRouterConfig(' qwen/custom ', 99)).toEqual({
            provider: 'openrouter',
            endpoint: 'https://openrouter.ai/api/v1',
            model: 'qwen/custom',
            apiKeyEnv: 'OPENROUTER_API_KEY',
            concurrency: 16,
        });
        expect(buildOpenRouterConfig('qwen/qwen3-coder-next', 0).concurrency).toBe(1);
    });

    it('formats batch forge summaries and active concurrency badges', () => {
        expect(summarizeBatchForge(0, 0, 0, 0, 3)).toBe('Batch forge: no eligible stubs to forge.');
        expect(summarizeBatchForge(4, 0, 0, 4, 4)).toBe('Batch forge: 4/4 forged (concurrency 4).');
        expect(summarizeBatchForge(3, 1, 0, 4, 4)).toBe('Batch forge: 3/4 forged, 1 failed (concurrency 4).');
        expect(summarizeBatchForge(3, 1, 2, 6, 4)).toBe('Batch forge: 3/6 forged, 1 failed, 2 skipped (concurrency 4).');

        expect(formatConcurrencyBadge(0, 4)).toBe('');
        expect(formatConcurrencyBadge(-2, 4)).toBe('');
        expect(formatConcurrencyBadge(2, 4)).toBe('2/4 forging');
        expect(formatConcurrencyBadge(1, 99)).toBe('1/16 forging');
    });
});
