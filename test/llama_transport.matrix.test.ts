import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlamaTransportError, streamLlamaCompletion } from '../vscode-extension/src/llama_transport';

const options = { endpoint: 'http://localhost:8080', model: 'local', outputTokens: 64, timeoutMs: 1000, system: 'Custom contract' };
const token = 'data: {"choices":[{"delta":{"content":"😀 result"}}]}\n\n';
const done = 'data: [DONE]\n\n';
function stream(text: string, chunkSize = 1024) {
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream({ start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
        controller.close();
    } }));
}
afterEach(() => vi.unstubAllGlobals());

describe('llama request and stream matrix', () => {
    it.each(['', '/', '/v1', '/v1/'])('normalizes endpoint suffix %j and sends the contract', async suffix => {
        const fetchMock = vi.fn(async () => stream(token + done));
        vi.stubGlobal('fetch', fetchMock);
        const result = await streamLlamaCompletion('Implement', { ...options, endpoint: options.endpoint + suffix }, new AbortController().signal, () => {});
        expect(result).toBe('😀 result');
        const [url, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://localhost:8080/v1/chat/completions');
        expect(request.method).toBe('POST');
        expect(JSON.parse(request.body as string)).toEqual({ model: 'local', stream: true, temperature: 0.1, max_tokens: 64,
            messages: [{ role: 'system', content: 'Custom contract' }, { role: 'user', content: 'Implement' }] });
    });
    it.each([1, 2, 7, 1024])('decodes UTF-8 and SSE across %i-byte chunks', async size => {
        vi.stubGlobal('fetch', vi.fn(async () => stream(': heartbeat\r\n\r\n' + (token + done).replace(/\n/g, '\r\n'), size)));
        const onToken = vi.fn();
        expect(await streamLlamaCompletion('Implement', options, new AbortController().signal, onToken)).toBe('😀 result');
        expect(onToken).toHaveBeenCalledExactlyOnceWith('😀 result');
    });
    it.each([
        ['empty body', () => new Response(null), /empty stream/],
        ['HTTP failure', () => new Response('unavailable', { status: 503 }), /HTTP 503: unavailable/],
        ['malformed JSON', () => stream('data: nope\n\n'), /malformed streaming JSON/],
        ['missing done', () => stream(token), /disconnected/],
        ['no implementation', () => stream(done), /no implementation/],
        ['metadata only', () => stream('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' + done), /no implementation/],
        ['nonstring content', () => stream('data: {"choices":[{"delta":{"content":42}}]}\n\n' + done), /no implementation/],
    ] as const)('rejects %s', async (_label, response, error) => {
        vi.stubGlobal('fetch', vi.fn(async () => response()));
        const request = streamLlamaCompletion('Implement', options, new AbortController().signal, () => {});
        await expect(request).rejects.toThrow(LlamaTransportError);
        await expect(request).rejects.toThrow(error);
    });
});
