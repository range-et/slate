/**
 * summarize_header — bring back the SUMMARY feature from #51, but route
 * the AI's output INTO the header card instead of into a separate
 * `Doc.summary` field. The header IS the doc overview now (#51), so the
 * summary literally becomes a Python module docstring at the top of the
 * header card. That keeps two nice properties:
 *   - the compiled .py is still valid (docstring = legal at module top)
 *   - the user can still hand-edit the header to refine imports etc.
 *
 * Convention: mount(deps) → { destroy }. Mount is unconditional. The
 * applet attaches a single delegated click handler on `document` for
 * `.card-summarize-btn` — that button is rendered onto the header card
 * by `applets/card_view/header_card.js`. Triggering the button:
 *   1. flattens every non-header card via `Doc.getFlattenedContent()`
 *   2. asks the active AI agent for a concise summary
 *   3. wraps it in `"""..."""` and merges into the header content,
 *      replacing any existing top-of-file docstring
 *   4. re-renders the header card DOM in place (same pattern as
 *      `ChatManager.applyPendingHeaderAdditions`).
 */

const SUMMARY_SYSTEM_PROMPT =
    "You are summarizing a Slate document for its header card. Produce a CONCISE, " +
    "plain-text overview (3-6 short sentences max) that describes what the document " +
    "defines, the key entities, and any cross-doc dependencies. No markdown, no " +
    "bullet points, no headings — just clean paragraph prose that reads well as a " +
    "Python module docstring. Do not wrap in triple quotes; the caller does that.";

let _state = null;

export function mount(deps = {}) {
    if (_state) destroyImpl();

    const onClick = (event) => {
        const btn = event.target && event.target.closest && event.target.closest('.card-summarize-btn');
        if (!btn) return;
        event.stopPropagation();
        runSummary(btn);
    };

    document.addEventListener('click', onClick);
    _state = { onClick };
    return { destroy: destroyImpl };
}

function destroyImpl() {
    if (!_state) return;
    document.removeEventListener('click', _state.onClick);
    _state = null;
}

async function runSummary(btn) {
    const mm = (typeof window !== 'undefined' && window.mainManager) || null;
    if (!mm) return;
    const doc = mm.currentDoc;
    if (!doc) {
        await mm.modal?.alert?.('No active document to summarize.');
        return;
    }
    const header = doc.getAllCards().find(c => c.isHeader && c.isHeader());
    if (!header) return;

    const body = (doc.getFlattenedContent() || '').trim();
    if (!body) {
        await mm.modal?.alert?.('Add at least one card before summarizing the doc.');
        return;
    }

    const aiAgent = mm.chatManager && mm.chatManager.aiAgent;
    if (!aiAgent || typeof aiAgent.generateResponse !== 'function') {
        await mm.modal?.alert?.('No AI agent configured.');
        return;
    }

    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = '...';

    try {
        const userPrompt =
            `Summarize the following Slate document titled "${doc.title}":\n\n${body}`;
        const summary = await aiAgent.generateResponse(userPrompt, [], {
            systemPrompt: SUMMARY_SYSTEM_PROMPT,
        });

        const cleaned = stripWrappingFences(summary).trim();
        const merged = mergeDocstring(header.content || '', cleaned);

        if (merged === header.content) {
            // Nothing actually changed (defensive — model returned identical content).
            return;
        }
        header.content = merged;
        if (doc.updatedAt !== undefined) {
            doc.updatedAt = new Date().toISOString();
        }

        // Re-render the header card DOM in place. Same shape as
        // ChatManager.applyPendingHeaderAdditions.
        const oldEl = header.innerHTML;
        const fresh = header.create();
        if (oldEl && oldEl.parentNode) {
            oldEl.parentNode.replaceChild(fresh, oldEl);
            header.innerHTML = fresh;
            // Re-bind the edit button (and our own SUM button gets picked
            // up by the document-level delegated listener so no rebind
            // needed for that one).
            const editBtn = fresh.querySelector('.card-edit-btn');
            if (editBtn && mm.chatManager) {
                editBtn.addEventListener('click', () => mm.chatManager.loadCardForEdit(header));
            }
        }
    } catch (err) {
        console.error('summarize_header: failed to generate summary', err);
        const msg = err && err.message === 'API_KEY_MISSING'
            ? 'API key required. Set it via the API KEY button in the top bar.'
            : `Failed to generate summary: ${(err && err.message) || err}`;
        await mm.modal?.alert?.(msg);
    } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
    }
}

/**
 * Local code models occasionally wrap their response in ```...``` even
 * when the system prompt forbids it. Strip a single outer fence if
 * present; leave inner content alone.
 */
function stripWrappingFences(text) {
    if (!text) return '';
    const m = String(text).match(/^\s*```[a-zA-Z0-9_+-]*\n?([\s\S]*?)\n?```\s*$/);
    return m ? m[1] : text;
}

/**
 * Merge the new summary into the header content as a top-of-file Python
 * docstring. If the header already starts with a `"""..."""` block, that
 * block is replaced (so re-summarizing doesn't stack docstrings). If the
 * header has no leading docstring, the new one is prepended and the
 * existing content is preserved below.
 */
export function mergeDocstring(existingContent, summaryText) {
    const summary = (summaryText || '').trim();
    if (!summary) return existingContent;

    const docstring = `"""\n${summary}\n"""`;

    const src = existingContent || '';
    // Match a leading triple-quoted block (single or double quotes), with
    // optional whitespace before it.
    const leading = src.match(/^\s*("""[\s\S]*?"""|'''[\s\S]*?''')\s*/);
    if (leading) {
        const rest = src.slice(leading[0].length);
        return rest.length > 0 ? `${docstring}\n\n${rest}` : docstring;
    }
    return src.trim().length > 0 ? `${docstring}\n\n${src}` : docstring;
}
