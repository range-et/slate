import { createServer, type Server } from 'node:http';

export type FakeLlamaRequest = Record<string, unknown>;

export type FakeLlamaServer = {
    url: string;
    requests: FakeLlamaRequest[];
    close(): Promise<void>;
};

export type FakeLlamaBehavior = {
    malformed?: boolean;
    omitDone?: boolean;
    delayMs?: number;
};

/** Fixed chunks for every request, or chunks computed per request (0-based index). */
export type FakeLlamaReply = string[] | ((request: FakeLlamaRequest, index: number) => string[]);

export async function startFakeLlamaServer(
    reply: FakeLlamaReply = ['def generated() -> int:\n', '    return 42\n'],
    behavior: FakeLlamaBehavior = {},
): Promise<FakeLlamaServer> {
    const requests: FakeLlamaRequest[] = [];
    const server: Server = createServer((request, response) => {
        if (request.method === 'GET' && request.url === '/health') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ status: 'ok' }));
            return;
        }
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
            response.writeHead(404).end();
            return;
        }
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            let parsed: FakeLlamaRequest;
            try {
                parsed = JSON.parse(body) as FakeLlamaRequest;
            } catch {
                response.writeHead(400, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: { message: 'invalid JSON' } }));
                return;
            }
            requests.push(parsed);
            const chunks = typeof reply === 'function' ? reply(parsed, requests.length - 1) : reply;
            if (parsed.stream === true) {
                response.writeHead(200, {
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-cache',
                    connection: 'keep-alive',
                });
                setTimeout(() => {
                    if (behavior.malformed) response.write('data: {not-json}\n\n');
                    else for (const content of chunks) {
                        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
                    }
                    response.end(behavior.omitDone ? '' : 'data: [DONE]\n\n');
                }, behavior.delayMs ?? 0);
                return;
            }
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ choices: [{ message: { content: chunks.join('') } }] }));
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fake llama.cpp server did not bind a TCP port.');
    return {
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeAllConnections();
        }),
    };
}
