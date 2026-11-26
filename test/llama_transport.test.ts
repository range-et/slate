import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    buildAuthHeaders,
    checkLlamaHealth,
    credentialPairingKey,
    DEFAULT_OUTPUT_TOKENS,
    evaluateProjectCredentialAccess,
    inferProviderFromEndpoint,
    isLoopbackHost,
    LlamaTransportError,
    resolveLlmConfig,
    streamLlamaCompletion,
    stripDisallowedCredential,
    validateLlmEndpointUrl,
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

    it('guards project-directed credentials against silent disclosure without workspace trust and explicit approval (#1)', () => {
        const key1 = credentialPairingKey('HTTPS://Example.COM/v1/', 'MY_SECRET');
        const key2 = credentialPairingKey('https://example.com/v1', 'MY_SECRET');
        expect(key1).toBe(key2);
        expect(credentialPairingKey('https://example.com/v1/')).toBe('https://example.com/v1|secret-storage');

        const projectLlm = {
            provider: 'openai-compatible' as const,
            endpoint: 'https://evil.example/v1',
            model: 'qwen',
            apiKeyEnv: 'MY_SECRET',
        };
        const resolved = resolveLlmConfig(projectLlm, undefined, { MY_SECRET: 'super-secret-value' });
        expect(resolved.hasApiKey).toBe(true);

        // Untrusted workspace always refuses credential transmission even if previously approved
        const untrusted = evaluateProjectCredentialAccess({
            projectLlm,
            resolved,
            isTrusted: false,
            approvedPairings: new Set([key1]),
        });
        expect(untrusted.allowCredential).toBe(false);
        expect(untrusted.requiresApproval).toBe(true);
        expect(untrusted.reason).toContain('not trusted');

        // Trusted workspace without explicit pairing approval requires approval
        const unapproved = evaluateProjectCredentialAccess({
            projectLlm,
            resolved,
            isTrusted: true,
            approvedPairings: [],
        });
        expect(unapproved.allowCredential).toBe(false);
        expect(unapproved.requiresApproval).toBe(true);
        expect(unapproved.pairingKey).toBe(credentialPairingKey('https://evil.example/v1', 'MY_SECRET'));
        expect(unapproved.reason).toContain('Explicit user approval required');

        // Trusted workspace with matching approved pairing allows credential
        const approved = evaluateProjectCredentialAccess({
            projectLlm,
            resolved,
            isTrusted: true,
            approvedPairings: new Set([unapproved.pairingKey!]),
        });
        expect(approved.allowCredential).toBe(true);
        expect(approved.requiresApproval).toBe(false);

        // User-configured settings with no project-directed endpoint/provider/apiKeyEnv do not prompt
        const userOnly = evaluateProjectCredentialAccess({
            projectLlm: { model: 'qwen' },
            resolved,
            isTrusted: true,
        });
        expect(userOnly.allowCredential).toBe(true);
        expect(userOnly.requiresApproval).toBe(false);

        for (const fallback of [resolved, stripDisallowedCredential(resolved)]) {
            expect(evaluateProjectCredentialAccess({ resolved: fallback, isTrusted: false })).toMatchObject({
                allowRequest: false, allowCredential: false, requiresApproval: false, pairingKey: null,
            });
        }

        // Requests with no resolved API key need no credential approval
        const noCred = evaluateProjectCredentialAccess({
            projectLlm,
            resolved: stripDisallowedCredential(resolved),
            isTrusted: false,
        });
        expect(noCred.allowCredential).toBe(false);
        expect(noCred.requiresApproval).toBe(false);

        const stripped = stripDisallowedCredential(resolved);
        expect(stripped.apiKey).toBeUndefined();
        expect(stripped.hasApiKey).toBe(false);
        expect(stripped.endpoint).toBe('https://evil.example/v1');
    });

    it('defaults outputTokens to DEFAULT_OUTPUT_TOKENS (1536) and surfaces non-empty SSE finish_reason (#55)', async () => {
        const defaults = resolveLlmConfig(undefined, undefined, {});
        expect(DEFAULT_OUTPUT_TOKENS).toBe(1536);
        expect(defaults.outputTokens).toBe(1536);

        server = await startFakeLlamaServer(
            ['def add(a: int, b: int) -> int:\n', '    return a + b\n'],
            { finishReason: 'length' },
        );
        const reasons: string[] = [];
        await streamLlamaCompletion('implement add', {
            endpoint: server.url,
            model: 'tiny-local',
            outputTokens: DEFAULT_OUTPUT_TOKENS,
            timeoutMs: 1000,
            onFinishReason: reason => reasons.push(reason),
        }, new AbortController().signal, () => {});
        expect(reasons).toEqual(['length']);

        await server.close();
        server = await startFakeLlamaServer(['def add(a: int, b: int) -> int:\n    return a + b\n']);
        const omittedReasons: string[] = [];
        await streamLlamaCompletion('implement add', {
            endpoint: server.url,
            model: 'tiny-local',
            outputTokens: DEFAULT_OUTPUT_TOKENS,
            timeoutMs: 1000,
            onFinishReason: reason => omittedReasons.push(reason),
        }, new AbortController().signal, () => {});
        expect(omittedReasons).toEqual([]);
    });

    it('bounds default outputTokens by small contextWindow sizes while preserving explicit overrides (#55 PR #56)', () => {
        expect(resolveLlmConfig({ contextWindow: 1024 }, undefined, {})).toMatchObject({
            contextWindowTokens: 1024,
            outputTokens: 512,
        });
        expect(resolveLlmConfig({ contextWindow: 2048 }, undefined, {})).toMatchObject({
            contextWindowTokens: 2048,
            outputTokens: 1024,
        });
        expect(resolveLlmConfig({ contextWindow: 4096 }, undefined, {})).toMatchObject({
            contextWindowTokens: 4096,
            outputTokens: 1536,
        });
        expect(resolveLlmConfig({ contextWindow: 1024, outputTokens: 700 }, undefined, {})).toMatchObject({
            contextWindowTokens: 1024,
            outputTokens: 700,
        });
    });

    it('blocks unsafe SSRF endpoints, HTTP redirects, untrusted requests, and ambient key leaks (P0-1)', async () => {
        expect(isLoopbackHost('localhost')).toBe(true);
        expect(isLoopbackHost('sub.localhost')).toBe(true);
        expect(isLoopbackHost('127.0.0.1')).toBe(true);
        expect(isLoopbackHost('[::1]')).toBe(true);
        expect(isLoopbackHost('api.openrouter.ai')).toBe(false);

        expect(validateLlmEndpointUrl('http://127.0.0.1:8080/v1').hostname).toBe('127.0.0.1');
        expect(validateLlmEndpointUrl('https://openrouter.ai/api/v1').protocol).toBe('https:');

        expect(() => validateLlmEndpointUrl('http://api.example.com/v1')).toThrow(/must use https:\/\//i);
        expect(() => validateLlmEndpointUrl('https://user:pass@api.example.com/v1')).toThrow(/embedded credentials/i);
        expect(() => validateLlmEndpointUrl('http://169.254.169.254/latest/meta-data')).toThrow(/restricted metadata/i);
        expect(() => validateLlmEndpointUrl('https://169.254.169.254/v1')).toThrow(/restricted metadata/i);
        expect(() => validateLlmEndpointUrl('https://[::ffff:169.254.169.254]/v1')).toThrow(/restricted metadata/i);
        expect(() => validateLlmEndpointUrl('https://[::ffff:a9fe:a9fe]/v1')).toThrow(/restricted metadata/i);
        expect(() => validateLlmEndpointUrl('http://[fe80::1]/v1')).toThrow(/restricted metadata/i);
        expect(() => validateLlmEndpointUrl('https://metadata.google.internal/v1')).toThrow(/restricted metadata/i);

        // Untrusted workspaces refuse even unauthenticated requests to project or override endpoints
        const noKeyResolved = resolveLlmConfig(
            { provider: 'openai-compatible', endpoint: 'https://proj.example/v1' },
            undefined,
            {},
        );
        const untrustedNoKey = evaluateProjectCredentialAccess({
            projectLlm: { provider: 'openai-compatible', endpoint: 'https://proj.example/v1' },
            resolved: noKeyResolved,
            isTrusted: false,
        });
        expect(untrustedNoKey.allowRequest).toBe(false);
        expect(untrustedNoKey.allowCredential).toBe(false);
        expect(untrustedNoKey.reason).toContain('Workspace is not trusted');

        // Ambient SLATE_LLM_API_KEY applies to loopback fallback, not foreign non-loopback project endpoints
        const foreignAmbient = resolveLlmConfig(
            { provider: 'openai-compatible', endpoint: 'https://foreign.example/v1', model: 'qwen' },
            { endpoint: 'http://127.0.0.1:8080' },
            { SLATE_LLM_API_KEY: 'ambient-secret' },
        );
        expect(foreignAmbient.apiKey).toBeUndefined();
        expect(foreignAmbient.hasApiKey).toBe(false);

        const localAmbient = resolveLlmConfig(
            undefined,
            { endpoint: 'http://127.0.0.1:8080' },
            { SLATE_LLM_API_KEY: 'ambient-secret' },
        );
        expect(localAmbient.apiKey).toBe('ambient-secret');
        expect(localAmbient.credentialSource).toBe('env:SLATE_LLM_API_KEY');

        // Redirects (302) must fail closed rather than following Location targets
        const redirectServer = createServer((_req, res) => {
            res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
            res.end();
        });
        await new Promise<void>(resolve => redirectServer.listen(0, '127.0.0.1', () => resolve()));
        const addr = redirectServer.address() as { port: number };
        const redirectUrl = `http://127.0.0.1:${addr.port}`;
        try {
            const health = await checkLlamaHealth(redirectUrl, 'local', 1000);
            expect(health.ok).toBe(false);
            await expect(streamLlamaCompletion('implement it', {
                endpoint: redirectUrl,
                model: 'local',
                outputTokens: 32,
                timeoutMs: 1000,
            }, new AbortController().signal, () => {})).rejects.toThrow(LlamaTransportError);
        } finally {
            await new Promise<void>(resolve => redirectServer.close(() => resolve()));
        }
    });

    it('defaults OpenRouter model to qwen/qwen3-coder-next and supports concurrency 1..16', () => {
        const openrouterDefault = resolveLlmConfig(
            { provider: 'openrouter' },
            { endpoint: 'http://127.0.0.1:8080', model: 'local', concurrency: 6 },
            { OPENROUTER_API_KEY: 'or-key' },
        );
        expect(openrouterDefault).toMatchObject({
            provider: 'openrouter',
            endpoint: 'https://openrouter.ai/api/v1',
            model: 'qwen/qwen3-coder-next',
            apiKeyEnv: 'OPENROUTER_API_KEY',
            hasApiKey: true,
            concurrency: 6,
        });

        const capped = resolveLlmConfig(
            { provider: 'openrouter', concurrency: 24 },
            undefined,
            {},
        );
        expect(capped.model).toBe('qwen/qwen3-coder-next');
        expect(capped.concurrency).toBe(16);
    });

    it('retries HTTP 429 rate limits with backoff/Retry-After, surfaces exhaustion, and honors abort', async () => {
        let attempts = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            attempts += 1;
            if (attempts === 1) {
                return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
            }
            if (attempts === 2) {
                return new Response('still rate limited', { status: 429 });
            }
            return new Response(
                'data: {"choices":[{"delta":{"content":"def f() -> int:\\n    return 1"}}]}\n\ndata: [DONE]\n\n',
                { status: 200, headers: { 'content-type': 'text/event-stream' } },
            );
        }));

        const ok = await streamLlamaCompletion('implement f', {
            endpoint: 'http://127.0.0.1:8080',
            model: 'local',
            outputTokens: 64,
            timeoutMs: 2000,
            maxRateLimitRetries: 3,
            rateLimitBaseDelayMs: 5,
        }, new AbortController().signal, () => {});
        expect(ok).toContain('return 1');
        expect(attempts).toBe(3);

        // Exhausting 429 retries throws HTTP 429 error
        vi.stubGlobal('fetch', vi.fn(async () => new Response('too many requests', { status: 429 })));
        await expect(streamLlamaCompletion('implement f', {
            endpoint: 'http://127.0.0.1:8080',
            model: 'local',
            outputTokens: 64,
            timeoutMs: 2000,
            maxRateLimitRetries: 1,
            rateLimitBaseDelayMs: 2,
        }, new AbortController().signal, () => {})).rejects.toThrow(/HTTP 429/);

        // Aborting during backoff cancels cleanly
        const controller = new AbortController();
        vi.stubGlobal('fetch', vi.fn(async () => {
            setTimeout(() => controller.abort(), 10);
            return new Response('rate limited', { status: 429 });
        }));
        await expect(streamLlamaCompletion('implement f', {
            endpoint: 'http://127.0.0.1:8080',
            model: 'local',
            outputTokens: 64,
            timeoutMs: 5000,
            maxRateLimitRetries: 2,
            rateLimitBaseDelayMs: 200,
        }, controller.signal, () => {})).rejects.toThrow(/Generation cancelled/);

        vi.unstubAllGlobals();
    });
});
