import { afterEach, describe, expect, it } from 'vitest';

import { streamLlamaCompletion } from '../vscode-extension/src/llama_transport';
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
});
