import { afterEach, describe, expect, it } from 'vitest';

import { startFakeLlamaServer, type FakeLlamaServer } from './support/fake_llama_server';

describe('fake llama.cpp test server', () => {
    let server: FakeLlamaServer | undefined;
    afterEach(async () => server?.close());

    it('records OpenAI-compatible requests and streams deterministic SSE chunks', async () => {
        server = await startFakeLlamaServer(['one', ' two']);
        const response = await fetch(`${server.url}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'tiny-local', messages: [{ role: 'user', content: 'fill one function' }], stream: true }),
        });

        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain('"content":"one"');
        expect(body).toContain('"content":" two"');
        expect(body).toContain('data: [DONE]');
        expect(server.requests).toEqual([expect.objectContaining({ model: 'tiny-local', stream: true })]);
    });
});
