import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    buildAuthHeaders,
    checkLlamaHealth,
    inferProviderFromEndpoint,
    LlamaTransportError,
    resolveLlmConfig,
    streamLlamaCompletion,
} from '../vscode-extension/src/llama_transport';
import { startFakeLlamaServer, type FakeLlamaServer } from './support/fake_llama_server';

describe('llama.cpp transport', () => {
    let server: FakeLlamaServer | undefined;
    afterEach(async () => {
        await server?.close();
        server = undefined;
    });

    it('parses chunked OpenAI-compatible SSE and reports tokens', async () => {
        server = await startFakeLlamaServer(['def target(value: int) -> int:\n', '    return value + 1\n']);
        const tokens: string[] = [];
        const result = await streamLlamaCompletion('implement it', {
            endpoint: server.url,
            model: 'tiny-local',
            outputTokens: 128,
            timeoutMs: 1000,
        }, new AbortController().signal, token => tokens.push(token));

        expect(result).toBe(tokens.join(''));
        expect(server.requests[0]).toEqual(expect.objectContaining({ model: 'tiny-local', stream: true, max_tokens: 128 }));
    });

    it('reports an unavailable server without mutating anything', async () => {
        await expect(streamLlamaCompletion('implement it', {
            endpoint: 'http://127.0.0.1:1', model: 'local', outputTokens: 64, timeoutMs: 250,
        }, new AbortController().signal, () => {})).rejects.toThrow(/Could not reach llama.cpp/);
    });

    it('honors cancellation', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(streamLlamaCompletion('implement it', {
            endpoint: 'http://127.0.0.1:8080', model: 'local', outputTokens: 64, timeoutMs: 1000,
        }, controller.signal, () => {})).rejects.toThrow('Generation cancelled');
    });

    it('rejects malformed stream payloads', async () => {
        server = await startFakeLlamaServer([], { malformed: true });
        await expect(streamLlamaCompletion('implement it', {
            endpoint: server.url, model: 'local', outputTokens: 64, timeoutMs: 1000,
        }, new AbortController().signal, () => {})).rejects.toThrow(/malformed streaming JSON/);
    });

    it('rejects a disconnect without a done event', async () => {
        server = await startFakeLlamaServer(['partial'], { omitDone: true });
        await expect(streamLlamaCompletion('implement it', {
            endpoint: server.url, model: 'local', outputTokens: 64, timeoutMs: 1000,
        }, new AbortController().signal, () => {})).rejects.toThrow(/disconnected before the stream completed/);
    });

    it('times out a stalled stream', async () => {
        server = await startFakeLlamaServer(['late'], { delayMs: 200 });
        await expect(streamLlamaCompletion('implement it', {
            endpoint: server.url, model: 'local', outputTokens: 64, timeoutMs: 20,
        }, new AbortController().signal, () => {})).rejects.toThrow(/timed out/);
    });

    it('sends Bearer authorization headers for /v1/models and /v1/chat/completions and preserves 401 errors', async () => {
        server = await startFakeLlamaServer(
            ['def target(value: int) -> int:\n', '    return value + 1\n'],
            { requiredAuth: 'Bearer fake-token-123' },
        );

        const badHealth = await checkLlamaHealth(server.url, 'qwen', 1000, { apiKey: 'wrong' });
        expect(badHealth.ok).toBe(false);
        expect(badHealth.statusText).toContain('HTTP 401');

        const okHealth = await checkLlamaHealth(server.url, 'qwen', 1000, { apiKey: 'fake-token-123' });
        expect(okHealth.ok).toBe(true);
        expect(okHealth.models).toContain('tiny-local');

        const result = await streamLlamaCompletion('implement it', {
            endpoint: server.url,
            model: 'qwen',
            outputTokens: 64,
            timeoutMs: 1000,
            apiKey: 'fake-token-123',
        }, new AbortController().signal, () => {});
        expect(result).toContain('return value + 1');
        expect(server.headers.at(-1)?.authorization).toBe('Bearer fake-token-123');
    });

    it('surfaces mid-stream SSE error payloads as LlamaTransportError', async () => {
        server = await startFakeLlamaServer([], { streamError: 'provider rate limit exceeded' });
        await expect(streamLlamaCompletion('implement it', {
            endpoint: server.url, model: 'local', outputTokens: 64, timeoutMs: 1000,
        }, new AbortController().signal, () => {})).rejects.toThrow(/provider rate limit exceeded/);
    });

    it('builds OpenRouter headers and resolves provider precedence + env secrets cleanly', () => {
        vi.stubGlobal('fetch', vi.fn());
        expect(buildAuthHeaders('https://openrouter.ai/api/v1', 'fake-key')).toEqual({
            'http-referer': 'https://github.com/range-et/slate',
            'x-title': 'Slate Component Forge',
            authorization: 'Bearer fake-key',
        });
        expect(buildAuthHeaders('http://127.0.0.1:8080', '  ')).toEqual({});
        expect(inferProviderFromEndpoint('https://openrouter.ai/api/v1')).toBe('openrouter');
        expect(inferProviderFromEndpoint('http://127.0.0.1:11434/v1')).toBe('ollama');
        expect(inferProviderFromEndpoint('http://127.0.0.1:8080')).toBe('llama.cpp');

        const fromProject = resolveLlmConfig(
            { provider: 'openrouter', model: 'qwen/qwen3-coder-30b-a3b-instruct', concurrency: 4 },
            { endpoint: 'http://127.0.0.1:8080', model: 'local' },
            { OPENROUTER_API_KEY: 'fake-or-key' },
        );
        expect(fromProject).toMatchObject({
            provider: 'openrouter',
            endpoint: 'https://openrouter.ai/api/v1',
            model: 'qwen/qwen3-coder-30b-a3b-instruct',
            apiKeyEnv: 'OPENROUTER_API_KEY',
            apiKey: 'fake-or-key',
            hasApiKey: true,
            concurrency: 4,
        });

        const overridden = resolveLlmConfig(
            { provider: 'openrouter', model: 'qwen/qwen3-coder-30b-a3b-instruct' },
            undefined,
            { OPENROUTER_API_KEY: 'fake-or-key', CUSTOM_ENV: 'custom-secret' },
            { endpoint: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'CUSTOM_ENV', model: 'qwen3:8b' },
        );
        expect(overridden).toMatchObject({
            provider: 'ollama',
            endpoint: 'http://127.0.0.1:11434/v1',
            model: 'qwen3:8b',
            apiKeyEnv: 'CUSTOM_ENV',
            apiKey: 'custom-secret',
            hasApiKey: true,
        });
        vi.unstubAllGlobals();
    });
});
