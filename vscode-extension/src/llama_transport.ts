export interface LlamaOptions {
    endpoint: string;
    model: string;
    outputTokens: number;
    timeoutMs: number;
    /** System message; defaults to the function implementation contract. */
    system?: string;
}

export interface LlamaHealthResult {
    ok: boolean;
    endpoint: string;
    model?: string;
    statusText: string;
    models?: string[];
}

export class LlamaTransportError extends Error {}

function completionUrl(endpoint: string): string {
    const clean = endpoint.replace(/\/+$/, '');
    return clean.endsWith('/v1') ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`;
}

function modelsUrl(endpoint: string): string {
    const clean = endpoint.replace(/\/+$/, '');
    return clean.endsWith('/v1') ? `${clean}/models` : `${clean}/v1/models`;
}

export async function checkLlamaHealth(
    endpoint: string,
    model?: string,
    timeoutMs = 3000,
): Promise<LlamaHealthResult> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('Connection timed out')), timeoutMs);
    try {
        const clean = endpoint.replace(/\/+$/, '');
        let response: Response | null = null;
        let lastError: unknown = null;

        // Try standard OpenAI /v1/models endpoint first
        try {
            response = await fetch(modelsUrl(endpoint), {
                method: 'GET',
                headers: { accept: 'application/json' },
                signal: timeout.signal,
            });
        } catch (error) {
            lastError = error;
            response = null;
        }

        if (timeout.signal.aborted) {
            return {
                ok: false,
                endpoint,
                model,
                statusText: 'Connection timed out',
            };
        }

        // Fall back to /health endpoint (native to llama.cpp server and ollama)
        if (!response || !response.ok) {
            try {
                response = await fetch(`${clean}/health`, {
                    method: 'GET',
                    signal: timeout.signal,
                });
            } catch (error) {
                lastError = error;
            }
        }

        if (timeout.signal.aborted) {
            return {
                ok: false,
                endpoint,
                model,
                statusText: 'Connection timed out',
            };
        }

        if (response && response.ok) {
            let availableModels: string[] = [];
            try {
                const body = (await response.json()) as { data?: Array<{ id?: string }> };
                if (Array.isArray(body?.data)) {
                    availableModels = body.data
                        .map(m => m?.id)
                        .filter((id): id is string => typeof id === 'string' && id.length > 0);
                }
            } catch {
                // Plaintext health response or non-JSON
            }
            const countStr = availableModels.length > 0 ? ` (${availableModels.length} model(s) available)` : '';
            return {
                ok: true,
                endpoint,
                model,
                statusText: `Connected${countStr}`,
                models: availableModels,
            };
        }

        const errorDetail = lastError instanceof Error ? lastError.message : String(lastError ?? 'Endpoint unreachable');
        return {
            ok: false,
            endpoint,
            model,
            statusText: response ? `HTTP ${response.status} ${response.statusText || 'Error'}` : errorDetail,
        };
    } catch (error) {
        return {
            ok: false,
            endpoint,
            model,
            statusText: error instanceof Error ? error.message : String(error),
        };
    } finally {
        clearTimeout(timer);
    }
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
