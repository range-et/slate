import {
    clampForgeConcurrency,
    DEFAULT_OPENROUTER_MODEL,
    MAX_FORGE_CONCURRENCY,
} from './forge_concurrency';
import type { SlateLlmConfig, SlateLlmProvider } from './slate_folder';

export { DEFAULT_OPENROUTER_MODEL, MAX_FORGE_CONCURRENCY };

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
    /** Maximum automatic retries on HTTP 429 rate limits (default 3, clamped 0..5). */
    maxRateLimitRetries?: number;
    /** Base exponential backoff delay in ms for HTTP 429 retries (default 1200, clamped 0..15000). */
    rateLimitBaseDelayMs?: number;
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

export type LlmCredentialSource = 'override' | 'secret-storage' | `env:${string}`;

export interface ResolvedLlmConfig {
    provider: SlateLlmProvider;
    endpoint: string;
    model: string;
    apiKeyEnv?: string;
    apiKey?: string;
    hasApiKey: boolean;
    credentialSource?: LlmCredentialSource;
    concurrency: number;
    timeoutSeconds: number;
    timeoutMs: number;
    outputTokens: number;
    contextWindowTokens: number;
}

export interface ProjectCredentialAccessInput {
    projectLlm?: SlateLlmConfig;
    override?: LlmConfigInput;
    fallback?: LlmConfigInput;
    resolved: ResolvedLlmConfig;
    isTrusted: boolean;
    approvedPairings?: ReadonlySet<string> | readonly string[];
}

export interface ProjectCredentialAccessDecision {
    allowRequest: boolean;
    allowCredential: boolean;
    requiresApproval: boolean;
    pairingKey: string | null;
    credentialSource?: string;
    reason?: string;
}

function normalizeEndpointForComparison(endpoint?: string): string {
    const raw = cleanString(endpoint);
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        const pathPart = parsed.pathname.replace(/\/+$/, '');
        return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathPart}`;
    } catch {
        return raw.replace(/\/+$/, '').toLowerCase();
    }
}

export function credentialPairingKey(endpoint: string, apiKeyEnv?: string): string {
    const raw = endpoint.trim();
    const normalizedEndpoint = normalizeEndpointForComparison(raw) || raw.replace(/\/+$/, '').toLowerCase();
    const credKey = cleanString(apiKeyEnv) ? `env:${cleanString(apiKeyEnv)}` : 'secret-storage';
    return `${normalizedEndpoint}|${credKey}`;
}

function expandIpv6Hextets(host: string): string[] | null {
    if (!host.includes(':') || host.includes('%')) return null;
    let work = host.toLowerCase();
    const lastColon = work.lastIndexOf(':');
    const tail = lastColon >= 0 ? work.slice(lastColon + 1) : '';
    if (tail.includes('.')) {
        const ipv4 = parseDottedIpv4(tail);
        if (!ipv4) return null;
        const hi = ((ipv4[0] << 8) | ipv4[1]).toString(16);
        const lo = ((ipv4[2] << 8) | ipv4[3]).toString(16);
        work = `${work.slice(0, lastColon)}:${hi}:${lo}`;
    }
    const parts = work.split('::');
    if (parts.length > 2) return null;
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
    if (parts.length === 1 && left.length !== 8) return null;
    const missing = 8 - (left.length + right.length);
    if (parts.length === 2 && missing < 0) return null;
    const full = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
    if (full.length !== 8) return null;
    const out: string[] = [];
    for (const seg of full) {
        if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
        out.push(seg.padStart(4, '0'));
    }
    return out;
}

function parseDottedIpv4(host: string): [number, number, number, number] | null {
    const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) return null;
    const nums = match.slice(1).map(n => Number.parseInt(n, 10));
    if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return [nums[0], nums[1], nums[2], nums[3]];
}

function extractIpv4FromHost(host: string): [number, number, number, number] | null {
    const direct = parseDottedIpv4(host);
    if (direct) return direct;
    const hextets = expandIpv6Hextets(host);
    if (!hextets) return null;
    if (
        hextets[0] === '0000'
        && hextets[1] === '0000'
        && hextets[2] === '0000'
        && hextets[3] === '0000'
        && hextets[4] === '0000'
        && hextets[5] === 'ffff'
    ) {
        const hi = Number.parseInt(hextets[6], 16);
        const lo = Number.parseInt(hextets[7], 16);
        return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
    }
    return null;
}

function isBlockedMetadataOrLinkLocalHost(normalizedHost: string): boolean {
    if (
        normalizedHost === 'metadata'
        || normalizedHost === 'metadata.google.internal'
        || normalizedHost.endsWith('.metadata.google.internal')
        || normalizedHost === 'metadata.goog'
        || normalizedHost === 'instance-data'
        || normalizedHost === 'metadata.azure.internal'
    ) {
        return true;
    }

    const ipv4 = extractIpv4FromHost(normalizedHost);
    if (ipv4) {
        const [a, b, c, d] = ipv4;
        if (a === 169 && b === 254) return true;
        if (a === 0) return true;
        if (a === 100 && b === 100 && c === 100 && d === 200) return true;
    }

    const hextets = expandIpv6Hextets(normalizedHost);
    if (hextets) {
        if (hextets.every(h => h === '0000')) return true;
        const firstHextet = Number.parseInt(hextets[0], 16);
        if ((firstHextet & 0xffc0) === 0xfe80) return true;
        if (
            hextets[0] === 'fd00'
            && hextets[1] === '0ec2'
            && hextets[2] === '0000'
            && hextets[3] === '0000'
            && hextets[4] === '0000'
            && hextets[5] === '0000'
            && hextets[6] === '0000'
            && hextets[7] === '0254'
        ) {
            return true;
        }
    }

    return false;
}

export function isLoopbackHost(hostname: string): boolean {
    const normalizedHost = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (!normalizedHost) return false;
    if (normalizedHost === 'localhost' || normalizedHost.endsWith('.localhost')) {
        return true;
    }
    const ipv4 = extractIpv4FromHost(normalizedHost);
    if (ipv4 && ipv4[0] === 127) {
        return true;
    }
    const hextets = expandIpv6Hextets(normalizedHost);
    if (
        hextets
        && hextets[0] === '0000'
        && hextets[1] === '0000'
        && hextets[2] === '0000'
        && hextets[3] === '0000'
        && hextets[4] === '0000'
        && hextets[5] === '0000'
        && hextets[6] === '0000'
        && hextets[7] === '0001'
    ) {
        return true;
    }
    return false;
}

export function validateLlmEndpointUrl(endpoint: string): URL {
    if (typeof endpoint !== 'string' || !endpoint.trim()) {
        throw new LlamaTransportError('A valid HTTP/HTTPS endpoint URL is required (e.g. "http://127.0.0.1:8080").');
    }
    let parsed: URL;
    try {
        parsed = new URL(endpoint.trim());
    } catch {
        throw new LlamaTransportError(`A valid HTTP/HTTPS endpoint URL is required (received "${endpoint}").`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new LlamaTransportError(`A valid HTTP/HTTPS endpoint URL is required (unsupported protocol "${parsed.protocol}").`);
    }
    if (parsed.username || parsed.password) {
        throw new LlamaTransportError('LLM endpoint URLs must not contain embedded credentials.');
    }
    const normalizedHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (!normalizedHost) {
        throw new LlamaTransportError(`Invalid LLM endpoint hostname in "${endpoint}".`);
    }
    if (isBlockedMetadataOrLinkLocalHost(normalizedHost)) {
        throw new LlamaTransportError(`Refusing restricted metadata or link-local LLM endpoint "${endpoint}".`);
    }
    if (!isLoopbackHost(normalizedHost) && parsed.protocol !== 'https:') {
        throw new LlamaTransportError(`Non-loopback LLM endpoint "${endpoint}" must use https://.`);
    }
    return parsed;
}

export function evaluateProjectCredentialAccess(
    input: ProjectCredentialAccessInput,
): ProjectCredentialAccessDecision {
    const { projectLlm, override, fallback, resolved, isTrusted, approvedPairings } = input;
    const projectDirectsLlm = Boolean(
        cleanString(projectLlm?.endpoint)
        || cleanString(projectLlm?.apiKeyEnv)
        || projectLlm?.provider,
    );

    const baseNorm = normalizeEndpointForComparison(fallback?.endpoint ?? PROVIDER_DEFAULTS['llama.cpp'].endpoint);
    const overrideEndpoint = cleanString(override?.endpoint);
    const overrideProviderEndpoint = override?.provider ? PROVIDER_DEFAULTS[override.provider].endpoint : undefined;
    const overrideChangesEndpoint = Boolean(
        (overrideEndpoint && normalizeEndpointForComparison(overrideEndpoint) !== baseNorm)
        || (overrideProviderEndpoint && normalizeEndpointForComparison(overrideProviderEndpoint) !== baseNorm),
    );
    const overrideEnv = cleanString(override?.apiKeyEnv);
    const fallbackEnv = cleanString(fallback?.apiKeyEnv);
    const overrideChangesCred = Boolean(overrideEnv && overrideEnv !== fallbackEnv);
    const overrideDirectsLlm = overrideChangesEndpoint || overrideChangesCred;
    const directedByProjectOrOverride = projectDirectsLlm || overrideDirectsLlm;

    const effectiveCredEnv = resolved.credentialSource?.startsWith('env:')
        ? resolved.credentialSource.slice(4)
        : (resolved.credentialSource === 'secret-storage' || resolved.credentialSource === 'override')
            ? undefined
            : cleanString(resolved.apiKeyEnv);

    const hasCredential = Boolean(resolved.hasApiKey && resolved.apiKey);
    const source = effectiveCredEnv
        ? `environment variable "${effectiveCredEnv}"`
        : resolved.credentialSource === 'override'
            ? 'explicit override API key'
            : 'stored API key';
    const pairingKey = hasCredential ? credentialPairingKey(resolved.endpoint, effectiveCredEnv) : null;

    if (isTrusted !== true) {
        return {
            allowRequest: false,
            allowCredential: false,
            requiresApproval: directedByProjectOrOverride && hasCredential,
            pairingKey: directedByProjectOrOverride ? pairingKey : null,
            ...(hasCredential ? { credentialSource: source } : {}),
            reason: hasCredential
                ? `Workspace is not trusted; refusing to send ${source} to configured LLM endpoint "${resolved.endpoint}".`
                : `Workspace is not trusted; refusing request to configured LLM endpoint "${resolved.endpoint}".`,
        };
    }

    if (!directedByProjectOrOverride) {
        return {
            allowRequest: true,
            allowCredential: Boolean(resolved.hasApiKey && resolved.apiKey),
            requiresApproval: false,
            pairingKey: null,
        };
    }

    if (!hasCredential) {
        return {
            allowRequest: true,
            allowCredential: false,
            requiresApproval: false,
            pairingKey: null,
        };
    }

    const approvedSet = approvedPairings instanceof Set
        ? approvedPairings
        : new Set(approvedPairings ?? []);
    if (pairingKey && approvedSet.has(pairingKey)) {
        return {
            allowRequest: true,
            allowCredential: true,
            requiresApproval: false,
            pairingKey,
            credentialSource: source,
        };
    }

    return {
        allowRequest: true,
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

const PROVIDER_DEFAULTS: Record<SlateLlmProvider, { endpoint: string; apiKeyEnv?: string; model?: string }> = {
    'llama.cpp': { endpoint: 'http://127.0.0.1:8080' },
    ollama: { endpoint: 'http://127.0.0.1:11434/v1' },
    openrouter: {
        endpoint: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        model: DEFAULT_OPENROUTER_MODEL,
    },
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

    const fallbackModel = cleanString(fallback?.model);
    const defaultModel = PROVIDER_DEFAULTS[provider].model;
    const model = cleanString(override?.model)
        ?? cleanString(projectLlm?.model)
        ?? (defaultModel
            ? (fallbackModel && fallbackModel !== 'local' ? fallbackModel : defaultModel)
            : fallbackModel)
        ?? 'local';

    const explicitApiKeyEnv = cleanString(override?.apiKeyEnv)
        ?? cleanString(projectLlm?.apiKeyEnv)
        ?? cleanString(fallback?.apiKeyEnv);
    const apiKeyEnv = explicitApiKeyEnv
        ?? PROVIDER_DEFAULTS[provider].apiKeyEnv;

    const fallbackConcurrency = clampForgeConcurrency(fallback?.concurrency, 3);
    const projectConcurrency = clampForgeConcurrency(projectLlm?.concurrency, fallbackConcurrency);
    const concurrency = clampForgeConcurrency(override?.concurrency, projectConcurrency);

    const rawTimeout = override?.timeoutSeconds ?? projectLlm?.timeoutSeconds ?? fallback?.timeoutSeconds ?? 120;
    const timeoutSeconds = Math.max(5, Math.trunc(Number.isFinite(rawTimeout) ? rawTimeout : 120));

    const rawContextWindow = override?.contextWindow
        ?? override?.contextWindowTokens
        ?? projectLlm?.contextWindow
        ?? fallback?.contextWindow
        ?? fallback?.contextWindowTokens
        ?? 4096;
    const contextWindowTokens = Math.max(1024, Math.trunc(Number.isFinite(rawContextWindow) ? rawContextWindow : 4096));

    const defaultOutputTokens = Math.max(64, Math.min(DEFAULT_OUTPUT_TOKENS, Math.floor(contextWindowTokens / 2)));
    const rawOutputTokens = override?.outputTokens ?? projectLlm?.outputTokens ?? fallback?.outputTokens ?? defaultOutputTokens;
    const outputTokens = Math.max(64, Math.trunc(Number.isFinite(rawOutputTokens) ? rawOutputTokens : defaultOutputTokens));

    const overrideKey = cleanString(override?.apiKey);
    const fallbackKey = cleanString(fallback?.apiKey);
    const baseFallbackEndpoint = normalizeEndpointForComparison(fallbackEndpoint ?? PROVIDER_DEFAULTS['llama.cpp'].endpoint);
    const resolvedNormEndpoint = normalizeEndpointForComparison(endpoint);
    let resolvedHost = '';
    try {
        resolvedHost = new URL(endpoint.trim()).hostname;
    } catch {
        // Ignore unparseable endpoints here; transport checks will reject before network calls.
    }
    const endpointDirectedExternally = Boolean(
        (overrideEndpoint || override?.provider || projectEndpoint || projectLlm?.provider)
        && resolvedNormEndpoint !== baseFallbackEndpoint
        && !isLoopbackHost(resolvedHost),
    );
    const allowImplicitSlateKey = !endpointDirectedExternally || Boolean(explicitApiKeyEnv);
    const explicitEnvKey = apiKeyEnv && (apiKeyEnv !== 'SLATE_LLM_API_KEY' || allowImplicitSlateKey)
        ? cleanString(env[apiKeyEnv])
        : undefined;
    const ambientSlateKey = !endpointDirectedExternally ? cleanString(env.SLATE_LLM_API_KEY) : undefined;
    const openRouterKey = (provider === 'openrouter' || isOpenRouterEndpoint(endpoint))
        ? cleanString(env.OPENROUTER_API_KEY)
        : undefined;

    let apiKey: string | undefined;
    let credentialSource: LlmCredentialSource | undefined;
    if (overrideKey) {
        apiKey = overrideKey;
        credentialSource = 'override';
    } else if (fallbackKey) {
        apiKey = fallbackKey;
        credentialSource = 'secret-storage';
    } else if (explicitEnvKey && apiKeyEnv) {
        apiKey = explicitEnvKey;
        credentialSource = `env:${apiKeyEnv}`;
    } else if (ambientSlateKey) {
        apiKey = ambientSlateKey;
        credentialSource = 'env:SLATE_LLM_API_KEY';
    } else if (openRouterKey) {
        apiKey = openRouterKey;
        credentialSource = 'env:OPENROUTER_API_KEY';
    }

    return {
        provider,
        endpoint,
        model,
        ...(apiKeyEnv ? { apiKeyEnv } : {}),
        ...(apiKey ? { apiKey } : {}),
        hasApiKey: Boolean(apiKey),
        ...(credentialSource ? { credentialSource } : {}),
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
        validateLlmEndpointUrl(clean);
        const authHeaders = buildAuthHeaders(endpoint, options?.apiKey, options?.headers);
        let response: Response | null = null;
        let lastError: unknown = null;

        // Try standard OpenAI /v1/models endpoint first
        try {
            response = await fetch(modelsUrl(endpoint), {
                method: 'GET',
                headers: { accept: 'application/json', ...authHeaders },
                redirect: 'error',
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
                    redirect: 'error',
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

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    }
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function computeRateLimitDelayMs(retryAfterHeader: string | null, attempt: number, baseDelayMs: number): number {
    if (retryAfterHeader) {
        const trimmed = retryAfterHeader.trim();
        const seconds = Number(trimmed);
        if (trimmed && Number.isFinite(seconds) && seconds >= 0) {
            return Math.min(Math.ceil(seconds * 1000), 15000);
        }
    }
    const exp = Math.min(baseDelayMs * (2 ** attempt), 8000);
    const jitter = baseDelayMs > 0 ? Math.floor(Math.random() * Math.min(250, baseDelayMs)) : 0;
    return exp + jitter;
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
    const maxRetries = typeof options.maxRateLimitRetries === 'number' && Number.isFinite(options.maxRateLimitRetries)
        ? Math.max(0, Math.min(5, Math.trunc(options.maxRateLimitRetries)))
        : 3;
    const baseDelayMs = typeof options.rateLimitBaseDelayMs === 'number' && Number.isFinite(options.rateLimitBaseDelayMs)
        ? Math.max(0, Math.min(15000, Math.trunc(options.rateLimitBaseDelayMs)))
        : 1200;
    try {
        validateLlmEndpointUrl(options.endpoint);
        const authHeaders = buildAuthHeaders(options.endpoint, options.apiKey, options.headers);
        const url = completionUrl(options.endpoint);
        const payloadBody = JSON.stringify({
            model: options.model,
            messages: [
                { role: 'system', content: options.system ?? 'You are a constrained Python function implementation engine. Follow the output contract exactly.' },
                { role: 'user', content: prompt },
            ],
            stream: true,
            temperature: 0.1,
            max_tokens: options.outputTokens,
        });
        let response: Response;
        for (let rateAttempt = 0; ; rateAttempt++) {
            response = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...authHeaders },
                redirect: 'error',
                body: payloadBody,
                signal: combined,
            });
            if (response.status === 429 && rateAttempt < maxRetries) {
                const retryAfter = response.headers?.get?.('retry-after') ?? null;
                await response.text().catch(() => '');
                const delayMs = computeRateLimitDelayMs(retryAfter, rateAttempt, baseDelayMs);
                await sleepWithSignal(delayMs, combined);
                continue;
            }
            break;
        }
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
