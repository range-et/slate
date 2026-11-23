import type { SlateLlmConfig, SlateLlmProvider } from './slate_folder';

export const DEFAULT_OUTPUT_TOKENS = 1536;

export interface LlamaOptions {
    endpoint: string;
    model: string;
    outputTokens: number;
    timeoutMs: number;
    /** System message; defaults to the function implementation contract. */
    system?: string;
    /** Optional runtime Bearer API key (never persisted to disk or settings). */
    apiKey?: string;
    /** Optional additional HTTP headers. */
    headers?: Record<string, string>;
    /** Optional callback notified when SSE emits a non-empty finish_reason. */
    onFinishReason?: (finishReason: string) => void;
}

export interface LlamaHealthOptions {
    apiKey?: string;
    headers?: Record<string, string>;
}

export interface LlmConfigInput extends SlateLlmConfig {
    /** Alias for contextWindow used by panel settings. */
    contextWindowTokens?: number;
    /** Runtime-only API key (never persisted). */
    apiKey?: string;
}

export interface ResolvedLlmConfig {
    provider: SlateLlmProvider;
    endpoint: string;
    model: string;
    apiKeyEnv?: string;
    apiKey?: string;
    hasApiKey: boolean;
    concurrency: number;
    timeoutSeconds: number;
    timeoutMs: number;
    outputTokens: number;
    contextWindowTokens: number;
}

export interface ProjectCredentialAccessInput {
    projectLlm?: SlateLlmConfig;
    resolved: ResolvedLlmConfig;
    isTrusted: boolean;
    approvedPairings?: ReadonlySet<string> | readonly string[];
}

export interface ProjectCredentialAccessDecision {
    allowCredential: boolean;
    requiresApproval: boolean;
    pairingKey: string | null;
    credentialSource?: string;
    reason?: string;
}

export function credentialPairingKey(endpoint: string, apiKeyEnv?: string): string {
    const raw = endpoint.trim();
    let normalizedEndpoint = raw.replace(/\/+$/, '').toLowerCase();
    try {
        const parsed = new URL(raw);
        const pathPart = parsed.pathname.replace(/\/+$/, '');
        normalizedEndpoint = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathPart}`;
    } catch {
        // Keep trimmed lowercase fallback for unparseable URLs
    }
    const credKey = cleanString(apiKeyEnv) ? `env:${cleanString(apiKeyEnv)}` : 'secret-storage';
    return `${normalizedEndpoint}|${credKey}`;
}

export function evaluateProjectCredentialAccess(
    input: ProjectCredentialAccessInput,
): ProjectCredentialAccessDecision {
    const { projectLlm, resolved, isTrusted, approvedPairings } = input;
    if (!resolved.hasApiKey || !resolved.apiKey) {
        return { allowCredential: false, requiresApproval: false, pairingKey: null };
    }
    const projectDirectsLlm = Boolean(
        cleanString(projectLlm?.endpoint)
        || cleanString(projectLlm?.apiKeyEnv)
        || projectLlm?.provider,
    );
    if (!projectDirectsLlm) {
        return { allowCredential: true, requiresApproval: false, pairingKey: null };
    }

    const source = cleanString(resolved.apiKeyEnv) ? `environment variable "${resolved.apiKeyEnv}"` : 'stored API key';
    const pairingKey = credentialPairingKey(resolved.endpoint, resolved.apiKeyEnv);
    if (!isTrusted) {
        return {
            allowCredential: false,
            requiresApproval: true,
            pairingKey,
            credentialSource: source,
            reason: `Workspace is not trusted; refusing to send ${source} to project-configured LLM endpoint "${resolved.endpoint}".`,
        };
    }

    const approvedSet = approvedPairings instanceof Set
        ? approvedPairings
        : new Set(approvedPairings ?? []);
    if (approvedSet.has(pairingKey)) {
        return {
            allowCredential: true,
            requiresApproval: false,
            pairingKey,
            credentialSource: source,
        };
    }

    return {
        allowCredential: false,
        requiresApproval: true,
        pairingKey,
        credentialSource: source,
        reason: `Explicit user approval required before sending ${source} to project-configured LLM endpoint "${resolved.endpoint}".`,
    };
}

export function stripDisallowedCredential(resolved: ResolvedLlmConfig): ResolvedLlmConfig {
    return {
        ...resolved,
        apiKey: undefined,
        hasApiKey: false,
    };
}

export interface LlamaHealthResult {
    ok: boolean;
    endpoint: string;
    model?: string;
    statusText: string;
    models?: string[];
}

export class LlamaTransportError extends Error {}

const PROVIDER_DEFAULTS: Record<SlateLlmProvider, { endpoint: string; apiKeyEnv?: string }> = {
    'llama.cpp': { endpoint: 'http://127.0.0.1:8080' },
    ollama: { endpoint: 'http://127.0.0.1:11434/v1' },
    openrouter: { endpoint: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
    'openai-compatible': { endpoint: 'http://127.0.0.1:8080/v1', apiKeyEnv: 'SLATE_LLM_API_KEY' },
};

function isOpenRouterEndpoint(endpoint: string): boolean {
    if (typeof endpoint !== 'string') return false;
    try {
        const host = new URL(endpoint.trim()).hostname.toLowerCase();
        return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
    } catch {
        return false;
    }
}

export function inferProviderFromEndpoint(endpoint: string): SlateLlmProvider {
    if (typeof endpoint !== 'string') return 'llama.cpp';
    try {
        const parsed = new URL(endpoint.trim());
        const host = parsed.hostname.toLowerCase();
        if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'openrouter';
        if (parsed.port === '11434') return 'ollama';
    } catch {
        // Ignore unparseable endpoints; default to llama.cpp.
    }
    return 'llama.cpp';
}

function cleanString(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve effective LLM settings and runtime API key from project config, fallback settings,
 * environment variables, and optional per-call overrides. Never mutates or writes secrets.
 */
export function resolveLlmConfig(
    projectLlm?: SlateLlmConfig,
    fallback?: LlmConfigInput,
    env: Readonly<Record<string, string | undefined>> = process.env,
    override?: LlmConfigInput,
): ResolvedLlmConfig {
    const overrideEndpoint = cleanString(override?.endpoint);
    const projectEndpoint = cleanString(projectLlm?.endpoint);
    const fallbackEndpoint = cleanString(fallback?.endpoint);

    let endpoint: string;
    if (overrideEndpoint) endpoint = overrideEndpoint;
    else if (override?.provider) endpoint = PROVIDER_DEFAULTS[override.provider].endpoint;
    else if (projectEndpoint) endpoint = projectEndpoint;
    else if (projectLlm?.provider) endpoint = PROVIDER_DEFAULTS[projectLlm.provider].endpoint;
    else if (fallbackEndpoint) endpoint = fallbackEndpoint;
    else if (fallback?.provider) endpoint = PROVIDER_DEFAULTS[fallback.provider].endpoint;
    else endpoint = PROVIDER_DEFAULTS['llama.cpp'].endpoint;

    let provider: SlateLlmProvider;
    if (override?.provider) provider = override.provider;
    else if (overrideEndpoint) provider = inferProviderFromEndpoint(overrideEndpoint);
    else if (projectLlm?.provider) provider = projectLlm.provider;
    else if (projectEndpoint) provider = inferProviderFromEndpoint(projectEndpoint);
    else if (fallback?.provider) provider = fallback.provider;
    else provider = inferProviderFromEndpoint(endpoint);

    const model = cleanString(override?.model)
        ?? cleanString(projectLlm?.model)
        ?? cleanString(fallback?.model)
        ?? 'local';

    const apiKeyEnv = cleanString(override?.apiKeyEnv)
        ?? cleanString(projectLlm?.apiKeyEnv)
        ?? cleanString(fallback?.apiKeyEnv)
        ?? PROVIDER_DEFAULTS[provider].apiKeyEnv;

    const rawConcurrency = override?.concurrency ?? projectLlm?.concurrency ?? fallback?.concurrency ?? 3;
    const concurrency = Math.max(1, Math.min(16, Math.trunc(Number.isFinite(rawConcurrency) ? rawConcurrency : 3)));

    const rawTimeout = override?.timeoutSeconds ?? projectLlm?.timeoutSeconds ?? fallback?.timeoutSeconds ?? 120;
    const timeoutSeconds = Math.max(5, Math.trunc(Number.isFinite(rawTimeout) ? rawTimeout : 120));

    const rawOutputTokens = override?.outputTokens ?? projectLlm?.outputTokens ?? fallback?.outputTokens ?? DEFAULT_OUTPUT_TOKENS;
    const outputTokens = Math.max(64, Math.trunc(Number.isFinite(rawOutputTokens) ? rawOutputTokens : DEFAULT_OUTPUT_TOKENS));

    const rawContextWindow = override?.contextWindow
        ?? override?.contextWindowTokens
        ?? projectLlm?.contextWindow
        ?? fallback?.contextWindow
        ?? fallback?.contextWindowTokens
        ?? 4096;
    const contextWindowTokens = Math.max(1024, Math.trunc(Number.isFinite(rawContextWindow) ? rawContextWindow : 4096));

    const apiKey = cleanString(override?.apiKey)
        ?? cleanString(fallback?.apiKey)
        ?? (apiKeyEnv ? cleanString(env[apiKeyEnv]) : undefined)
        ?? cleanString(env.SLATE_LLM_API_KEY)
        ?? ((provider === 'openrouter' || isOpenRouterEndpoint(endpoint)) ? cleanString(env.OPENROUTER_API_KEY) : undefined);

    return {
        provider,
        endpoint,
        model,
        ...(apiKeyEnv ? { apiKeyEnv } : {}),
        ...(apiKey ? { apiKey } : {}),
        hasApiKey: Boolean(apiKey),
        concurrency,
        timeoutSeconds,
        timeoutMs: timeoutSeconds * 1000,
        outputTokens,
        contextWindowTokens,
    };
}

export function buildAuthHeaders(
    endpoint: string,
    apiKey?: string,
    extra?: Record<string, string>,
): Record<string, string> {
    const headers: Record<string, string> = {};
    if (isOpenRouterEndpoint(endpoint)) {
        headers['http-referer'] = 'https://github.com/range-et/slate';
        headers['x-title'] = 'Slate Component Forge';
    }
    const cleanKey = cleanString(apiKey);
    if (cleanKey) {
        headers.authorization = `Bearer ${cleanKey}`;
    }
    if (extra) {
        for (const [key, val] of Object.entries(extra)) {
            if (typeof val === 'string') headers[key.toLowerCase()] = val;
        }
    }
    return headers;
}

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
    options?: LlamaHealthOptions,
): Promise<LlamaHealthResult> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('Connection timed out')), timeoutMs);
    try {
        const clean = endpoint.replace(/\/+$/, '');
        const authHeaders = buildAuthHeaders(endpoint, options?.apiKey, options?.headers);
        let response: Response | null = null;
        let lastError: unknown = null;

        // Try standard OpenAI /v1/models endpoint first
        try {
            response = await fetch(modelsUrl(endpoint), {
                method: 'GET',
                headers: { accept: 'application/json', ...authHeaders },
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

        if (response && (response.status === 401 || response.status === 403)) {
            const fallbackText = response.status === 401 ? 'Unauthorized' : 'Forbidden';
            return {
                ok: false,
                endpoint,
                model,
                statusText: `HTTP ${response.status} ${response.statusText || fallbackText}`,
            };
        }

        // Fall back to /health endpoint (native to llama.cpp server and ollama)
        if (!response || !response.ok) {
            try {
                response = await fetch(`${clean}/health`, {
                    method: 'GET',
                    ...(Object.keys(authHeaders).length > 0 ? { headers: authHeaders } : {}),
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
        const authHeaders = buildAuthHeaders(options.endpoint, options.apiKey, options.headers);
        const response = await fetch(completionUrl(options.endpoint), {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeaders },
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
                    const streamError = (payload as { error?: { message?: unknown } | string }).error;
                    if (streamError) {
                        const message = typeof streamError === 'string'
                            ? streamError
                            : typeof streamError.message === 'string'
                                ? streamError.message
                                : JSON.stringify(streamError);
                        throw new LlamaTransportError(`llama.cpp stream error: ${message}`);
                    }
                    const choice = (payload as { choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }> })
                        .choices?.[0];
                    const content = choice?.delta?.content;
                    if (typeof content === 'string') {
                        result += content;
                        onToken(content);
                    }
                    if (typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0) {
                        options.onFinishReason?.(choice.finish_reason);
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
