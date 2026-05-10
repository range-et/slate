/**
 * chat_ctl.js — orchestrates AI generation. Second controller extracted from
 * the god objects, per ARCHITECTURE.md § Phase B.
 *
 * Boundaries:
 *   - DOES use:   ai_utils (provider clients, via the agent passed in by the
 *                 init context), event_bus, pure helpers from cards.js.
 *   - Does NOT:   touch the DOM, mount editors, show modals, or know that
 *                 CodeMirror exists.
 *
 * The view layer ([src/ai_chat.js](../ai_chat.js)) wires this controller in
 * its constructor with `initChatCtl(ctx)`, then subscribes to the events
 * below to drive the response editor + error modals.
 *
 * Event bus contract:
 *   emit  chat:send-requested  { userInput, references, codeMode, cardTitle,
 *                                docTitle, attachedImages }
 *      → controller resolves an agent, builds bibliography, sends, then emits:
 *
 *   emit  chat:started     { codeMode }
 *   emit  chat:streaming   { delta, codeMode }            (per token, when supported)
 *   emit  chat:complete    { text, codeMode, wasStreaming }
 *   emit  chat:error       { kind, err, codeMode }
 *
 * `kind` is a small enum for view-side branching:
 *   'no_agent'           — preflight failed (no key, no provider)
 *   'local_unreachable'  — Ollama not running / CORS-blocked
 *   'api_key_missing'    — 401, invalid_api_key, etc.
 *   'rate_limit'         — 429
 *   'other'              — anything else; view should show err.message
 *
 * Token-budget enforcement (#6) will plug in here, between `chat:send-
 * requested` and `chat:started`, by calling a future estimator and emitting
 * `chat:error { kind: 'over_budget' }` when the assembled context exceeds
 * the active model's window. ai_chat.js stays untouched for that change.
 */

import { stripPythonFences } from '../cards.js';
import { on, emit } from '../event_bus.js';

let _ctx = null;          // { getDoc, getProject, getAgent }
let _initialized = false;

/**
 * Wire the controller. Idempotent. The context provides the three pieces
 * chat_ctl needs from the host app without importing from main_script or
 * touching window.mainManager.
 *
 * @param {object} ctx
 * @param {() => object|null} ctx.getDoc       — current Doc (for refs in this doc)
 * @param {() => object|null} ctx.getProject   — current Project (for cross-doc refs)
 * @param {(codeMode: boolean) => object} ctx.getAgent  — agent factory
 */
export function initChatCtl(ctx) {
    if (!ctx || typeof ctx.getDoc !== 'function' ||
        typeof ctx.getProject !== 'function' ||
        typeof ctx.getAgent !== 'function') {
        throw new Error('initChatCtl: ctx must have getDoc, getProject, getAgent functions');
    }
    _ctx = ctx;
    if (_initialized) return;
    _initialized = true;
    on('chat:send-requested', (payload) => { send(payload); });
}

/**
 * Direct API surface for tests / advanced callers. Production code uses the
 * event bus instead.
 */
export async function send({
    userInput,
    references = [],
    codeMode = false,
    cardTitle = '',
    docTitle = 'untitled',
    attachedImages = [],
} = {}) {
    if (!_ctx) {
        emit('chat:error', { kind: 'other', err: new Error('chat_ctl not initialized'), codeMode });
        return;
    }

    const agent = _ctx.getAgent(codeMode);
    if (!agent || (typeof agent.hasApiKey === 'function' && !agent.hasApiKey())) {
        emit('chat:error', { kind: 'no_agent', err: null, codeMode });
        return;
    }

    const bibliography = buildBibliography(references, _ctx.getDoc(), _ctx.getProject(), { codeMode });
    const fullPrompt = (userInput || '') + bibliography;
    const generateOptions = codeMode
        ? { systemPrompt: composeCodeSystemPrompt(cardTitle, docTitle) }
        : {};

    // TODO(#6): token-budget check here. If estimate exceeds caps, emit
    // chat:error { kind: 'over_budget', estimate, limit } and return.

    emit('chat:started', { codeMode });

    const useStreaming = typeof agent.generateResponseStream === 'function';
    const onToken = (delta) => emit('chat:streaming', { delta, codeMode });

    try {
        const res = useStreaming
            ? await agent.generateResponseStream(fullPrompt, attachedImages, generateOptions, onToken)
            : await agent.generateResponse(fullPrompt, attachedImages, generateOptions);
        const text = codeMode ? stripPythonFences(res || '').trim() : (res || '');
        emit('chat:complete', { text, codeMode, wasStreaming: useStreaming });
    } catch (err) {
        console.error('chat_ctl: generation failed:', err);
        emit('chat:error', { kind: classifyError(err, { codeMode }), err, codeMode });
    }
}

/* ─── pure helpers (exported for tests) ──────────────────────────────────── */

/**
 * Build a bibliography of referenced cards and docs. Pure — does not read
 * window.mainManager or this.currentDoc. Caller supplies doc + project.
 *
 * In code mode, code-card refs render as `# from <doc>: <title>\n<source>`
 * comment blocks so the model sees them as Python it can call.
 *
 * The function still touches `document.createElement` to strip HTML out of
 * legacy markdown card content. That's the one DOM dependency; safe in any
 * browser-like host (jsdom for tests).
 */
export function buildBibliography(references, currentDoc, currentProject, { codeMode = false } = {}) {
    if (!references || references.length === 0) return '';

    const bibliography = [];
    const header = codeMode
        ? '\n\n# --- REFERENCED CODE ---\n'
        : '\n\n--- CONTEXT (Referenced Content) ---\n';
    bibliography.push(header);

    references.forEach(ref => {
        let foundCard = null;
        let foundInDocTitle = null;

        // Doc-title refs first.
        if (currentProject && typeof currentProject.getAllDocs === 'function') {
            const allDocs = currentProject.getAllDocs();
            const foundDoc = allDocs.find(d => d.title === ref);
            if (foundDoc) {
                if (codeMode) {
                    bibliography.push(`\n# @${foundDoc.title} (document) — refer to its code cards by name.\n`);
                    return;
                }
                if (foundDoc.summary) {
                    bibliography.push(`\n@${foundDoc.title} (document summary):\n${foundDoc.summary}\n`);
                    return;
                }
                bibliography.push(`\n@${ref} (document - summary not yet generated)\n`);
                return;
            }
        }

        // Card refs: current doc first, then any doc in the project.
        if (currentDoc) {
            foundCard = currentDoc.getAllCards().find(c => c.title === ref);
            if (foundCard) foundInDocTitle = currentDoc.title;
        }
        if (!foundCard && currentProject && typeof currentProject.getAllDocs === 'function') {
            const allDocs = currentProject.getAllDocs();
            for (const doc of allDocs) {
                foundCard = doc.getAllCards().find(c => c.title === ref);
                if (foundCard) {
                    foundInDocTitle = doc.title;
                    break;
                }
            }
        }

        if (foundCard) {
            if (codeMode && foundCard.cardType === 'code') {
                const source = (typeof foundCard.getPythonSource === 'function')
                    ? foundCard.getPythonSource()
                    : foundCard.content;
                bibliography.push(`\n# from ${foundInDocTitle}: ${foundCard.title}\n${source || ''}\n`);
            } else {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = foundCard.content;
                const plainText = tempDiv.innerText || tempDiv.textContent;
                const linePrefix = codeMode ? '# ' : '';
                bibliography.push(`\n${linePrefix}@${foundCard.title} (card from doc: ${foundInDocTitle}):\n${plainText}\n`);
            }
        } else {
            bibliography.push(codeMode
                ? `\n# @${ref}: [Reference not found]\n`
                : `\n@${ref}: [Reference not found]\n`);
        }
    });

    bibliography.push(codeMode ? '\n# --- END REFERENCED CODE ---\n' : '\n--- END CONTEXT ---\n');
    return bibliography.join('');
}

/**
 * Compose the heavy-handed Python codegen system prompt. Local code models
 * routinely ignore soft "no markdown" instructions, so we tell them very
 * loudly to emit raw source. We also strip fences after the fact in send().
 */
export function composeCodeSystemPrompt(cardTitle, docTitle) {
    return [
        `You are writing one Python symbol named \`${cardTitle}\` for the file \`${docTitle}.py\`.`,
        `Output ONLY raw Python source. The very first character of your reply must be a Python keyword (\`def\`, \`class\`, \`import\`, \`from\`, \`@\`, or \`#\`).`,
        `Do NOT write any prose before, between, or after the code.`,
        `Do NOT wrap the code in triple backticks (no \`\`\`python, no \`\`\`).`,
        `Do NOT add usage examples or explanations.`,
        `If you need to reference symbols mentioned as \`# from <doc>: <name>\` in the user message, treat them as already imported in scope.`,
    ].join(' ');
}

/**
 * Classify a thrown error into a small enum so the view can pick the right
 * modal copy without re-implementing string-matching everywhere.
 */
export function classifyError(err, { codeMode = false } = {}) {
    const msg = (err && err.message) || '';
    const status = (err && (err.status || err.response?.status || err.statusCode)) || null;
    const code = (err && (err.code || err.error?.code)) || null;

    const looksLikeNetwork = msg.includes('fetch') || msg.includes('Failed to fetch')
        || msg.includes('NetworkError') || msg.includes('ECONNREFUSED')
        || (err && err.cause && err.cause.code === 'ECONNREFUSED');
    if (codeMode && looksLikeNetwork) return 'local_unreachable';

    if (msg === 'API_KEY_MISSING' || msg.includes('API key') ||
        msg.includes('Invalid API key') || status === 401 || code === 'invalid_api_key') {
        return 'api_key_missing';
    }
    if (msg.includes('rate limit') || status === 429) return 'rate_limit';
    return 'other';
}

/** Test-only: drop the init context. */
export function __resetForTests() {
    _ctx = null;
    _initialized = false;
}
