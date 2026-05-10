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

    // (#49) Auto-include the current doc's header card. The header is the
    // doc's module-scope ground truth (imports, constants, cross-doc
    // imports per the calc split) and the model needs to see it on every
    // generation. buildBibliography also dedupes by id if the user wrote
    // an explicit @__header__ themselves.
    const bibliography = buildBibliography(references, _ctx.getDoc(), _ctx.getProject(), {
        codeMode,
        includeCurrentDocHeader: true,
    });
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
        const cleaned = codeMode ? stripPythonFences(res || '').trim() : (res || '');

        // (#50) Split the two-section response in code mode. View shows the
        // function part in the response editor; addToDoc routes the
        // additions to the doc's header card on commit.
        let text = cleaned;
        let headerAdditions = [];
        if (codeMode) {
            const split = splitFunctionAndHeaderAdditions(cleaned);
            text = split.functionSrc;
            headerAdditions = split.headerAdditions;
        }

        emit('chat:complete', { text, codeMode, wasStreaming: useStreaming, headerAdditions });
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
export function buildBibliography(references, currentDoc, currentProject, { codeMode = false, includeCurrentDocHeader = false } = {}) {
    // (#49) Resolve the current doc's header card up front so we can both
    // auto-include it AND dedupe it from the user-supplied @-refs by id.
    const currentDocHeader = (includeCurrentDocHeader && currentDoc && typeof currentDoc.getAllCards === 'function')
        ? currentDoc.getAllCards().find(c => c.isHeader && c.isHeader())
        : null;
    const seenCardIds = new Set();
    const refList = references || [];

    // Skip out early only if there are no refs AND no auto-header to include.
    if (refList.length === 0 && !(currentDocHeader && (currentDocHeader.content || '').trim())) {
        return '';
    }

    const bibliography = [];
    const header = codeMode
        ? '\n\n# --- REFERENCED CODE ---\n'
        : '\n\n--- CONTEXT (Referenced Content) ---\n';
    bibliography.push(header);

    // Auto-include the current doc's header first so it sits at the top of
    // the bibliography and the model sees module-scope state (imports,
    // OPS table, cross-doc imports) before any individual card refs.
    if (currentDocHeader) {
        const src = (currentDocHeader.content || '').trim();
        if (src) {
            seenCardIds.add(currentDocHeader.id);
            bibliography.push(codeMode
                ? `\n# --- doc header (auto-included) ---\n${src}\n# --- end doc header ---\n`
                : `\n--- doc header (auto-included) ---\n${src}\n--- end doc header ---\n`);
        }
    }

    refList.forEach(ref => {
        let foundCard = null;
        let foundInDocTitle = null;

        // Doc-title refs first. (#51) Resolves to the doc's header card —
        // its module-scope preamble in code mode, or a context block in
        // markdown mode. The legacy AI-generated summary is gone.
        if (currentProject && typeof currentProject.getAllDocs === 'function') {
            const allDocs = currentProject.getAllDocs();
            const foundDoc = allDocs.find(d => d.title === ref);
            if (foundDoc) {
                const headerCard = foundDoc.getAllCards().find(c => c.isHeader && c.isHeader());
                const headerSrc = headerCard && (headerCard.content || '').trim();
                if (codeMode) {
                    bibliography.push(headerSrc
                        ? `\n# from doc @${foundDoc.title} (header):\n${headerSrc}\n`
                        : `\n# @${foundDoc.title} (document) — refer to its code cards by name.\n`);
                    return;
                }
                bibliography.push(headerSrc
                    ? `\n@${foundDoc.title} (document header):\n${headerSrc}\n`
                    : `\n@${ref} (document - header is empty)\n`);
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
            // (#49) Dedupe: if the user explicitly @-refs the same header
            // card we already auto-included, skip the second copy.
            if (seenCardIds.has(foundCard.id)) return;
            seenCardIds.add(foundCard.id);
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
 *
 * (#50) Two-section response schema. The model emits the function/class
 * body, and — if it needs new module-scope additions (an import, a typing
 * alias, a constant) — emits them under a separator line. We parse the
 * sections in `splitFunctionAndHeaderAdditions` so the addToDoc flow can
 * route them: function → its own card, additions → appended to the doc's
 * header card.
 *
 *   def your_symbol(...):
 *       ...
 *   # @slate:header-additions
 *   from typing import Final
 *   PI: Final[float] = 3.14159
 *
 * The additions section is OPTIONAL — omit the marker entirely if there's
 * nothing module-scope to add. The parser falls back cleanly.
 */
export function composeCodeSystemPrompt(cardTitle, docTitle) {
    return [
        `You are writing one Python symbol named \`${cardTitle}\` for the file \`${docTitle}.py\`.`,
        `Output ONLY raw Python source. The very first character of your reply must be a Python keyword (\`def\`, \`class\`, \`import\`, \`from\`, \`@\`, or \`#\`).`,
        `Do NOT write any prose before, between, or after the code.`,
        `Do NOT wrap the code in triple backticks (no \`\`\`python, no \`\`\`).`,
        `Do NOT add usage examples or explanations.`,
        `If you need to reference symbols mentioned as \`# from <doc>: <name>\` in the user message, treat them as already imported in scope.`,
        // (#50) Two-section schema. Optional second section.
        `If — and ONLY if — your function needs new module-scope additions (a new import, a new typing alias, a new module-level constant literal) that the doc header does not already contain, append a single separator line \`# @slate:header-additions\` after your function/class body, then list ONLY those additions on the lines below it (one per line, no comments other than the marker itself, no blank lines).`,
        `Header additions MUST be self-contained: imports, type aliases, or literal-value constants only. NEVER emit a header addition that references another function or value defined elsewhere in this file (e.g. \`OPS["+"] = add\` or \`HANDLERS = [foo, bar]\`) — those run at module import time, BEFORE the body symbols exist, and will crash the file. Wire-up code like that belongs inside an init function (often \`register_*()\`) that the entry point calls explicitly.`,
        `If you do not need any new module-scope additions, OMIT the marker entirely and emit only the function body.`,
        `Never repeat lines that already appear in the auto-included doc header — only emit additions that are genuinely new.`,
    ].join(' ');
}

/**
 * (#50) Pure helper: split a code-mode response into the function body
 * and any module-scope additions the model wanted to land on the doc's
 * header card.
 *
 * @param {string} text — raw model output, post-fence-strip.
 * @returns {{ functionSrc: string, headerAdditions: string[] }}
 *
 * Behavior:
 *   - No marker → everything is the function; headerAdditions = [].
 *   - Marker present but second section is empty/whitespace → same as
 *     no marker.
 *   - Marker matched case-insensitively, leading `#` optional, surrounding
 *     whitespace tolerated, so the model can write `# @slate:header-additions`,
 *     `# @SLATE:HEADER-ADDITIONS`, or `@slate:header-additions` and we
 *     accept all of them.
 */
export function splitFunctionAndHeaderAdditions(text) {
    const src = (text == null) ? '' : String(text);
    const lines = src.split('\n');
    let markerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const cleaned = lines[i].trim().replace(/^#\s*/, '').toLowerCase();
        if (cleaned === '@slate:header-additions') {
            markerIdx = i;
            break;
        }
    }
    if (markerIdx < 0) {
        return { functionSrc: src.trimEnd(), headerAdditions: [] };
    }
    const functionSrc = lines.slice(0, markerIdx).join('\n').trimEnd();
    const additions = lines.slice(markerIdx + 1)
        .map(l => l.replace(/\s+$/, ''))
        .filter(l => l.trim().length > 0);
    return { functionSrc, headerAdditions: additions };
}

/**
 * (#50) Pure helper: append new lines to an existing header source,
 * skipping any line already present (whitespace-insensitive). Returns
 * the new header text. Called by ai_chat.addToDoc on commit.
 */
export function applyHeaderAdditions(currentHeaderSrc, additions) {
    const additionsList = Array.isArray(additions) ? additions : [];
    if (additionsList.length === 0) return currentHeaderSrc || '';
    const existing = (currentHeaderSrc || '').split('\n').map(l => l.trim());
    const existingSet = new Set(existing);
    const fresh = additionsList.filter(l => !existingSet.has(l.trim()));
    if (fresh.length === 0) return currentHeaderSrc || '';
    const base = (currentHeaderSrc || '').replace(/\s+$/, '');
    const sep = base.length === 0 ? '' : '\n';
    return base + sep + fresh.join('\n') + '\n';
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
