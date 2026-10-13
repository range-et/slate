export interface LlamaOptions {
    endpoint: string;
    model: string;
    outputTokens: number;
    timeoutMs: number;
    /** System message; defaults to the function implementation contract. */
    system?: string;
}

export class LlamaTransportError extends Error {}

function completionUrl(endpoint: string): string {
    const clean = endpoint.replace(/\/+$/, '');
    return clean.endsWith('/v1') ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`;
}

export async function streamLlamaCompletion(
    prompt: string,
    options: LlamaOptions,
    signal: AbortSignal,
    onToken: (token: string) => void,
): Promise<string> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('llama.cpp request timed out')), options.timeoutMs);
    const combined = AbortSignal.any([signal, timeout.signal]);
    try {
        const response = await fetch(completionUrl(options.endpoint), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: options.model,
                messages: [
                    { role: 'system', content: options.system ?? 'You are a constrained Python function implementation engine. Follow the output contract exactly.' },
                    { role: 'user', content: prompt },
                ],
                stream: true,
                temperature: 0.1,
                max_tokens: options.outputTokens,
            }),
            signal: combined,
        });
        if (!response.ok) {
            const detail = (await response.text()).slice(0, 500);
            throw new LlamaTransportError(`llama.cpp returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
        }
        if (!response.body) throw new LlamaTransportError('llama.cpp returned an empty stream.');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let result = '';
        let doneEvent = false;
        while (true) {
            const read = await reader.read();
            buffer += decoder.decode(read.value, { stream: !read.done });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() ?? '';
            for (const event of events) {
                for (const line of event.split(/\r?\n/)) {
                    if (!line.startsWith('data:')) continue;
                    const data = line.slice(5).trim();
                    if (data === '[DONE]') { doneEvent = true; continue; }
                    let payload: unknown;
                    try { payload = JSON.parse(data); }
                    catch { throw new LlamaTransportError('llama.cpp sent malformed streaming JSON.'); }
                    const content = (payload as { choices?: Array<{ delta?: { content?: unknown } }> })
                        .choices?.[0]?.delta?.content;
                    if (typeof content === 'string') {
                        result += content;
                        onToken(content);
                    }
                }
            }
            if (read.done) break;
        }
        if (!doneEvent) throw new LlamaTransportError('llama.cpp disconnected before the stream completed.');
        if (!result.trim()) throw new LlamaTransportError('llama.cpp returned no implementation.');
        return result;
    } catch (error) {
        if (signal.aborted) throw new LlamaTransportError('Generation cancelled.');
        if (timeout.signal.aborted) throw new LlamaTransportError('llama.cpp request timed out.');
        if (error instanceof LlamaTransportError) throw error;
        throw new LlamaTransportError(`Could not reach llama.cpp: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        clearTimeout(timer);
    }
}
