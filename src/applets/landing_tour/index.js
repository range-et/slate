/**
 * landing_tour — first-visit welcome modal pointing newcomers at the
 * calculator example + the README. Web-only by capability gate
 * (`caps.landingTour`). One-shot per browser: persists a flag in
 * localStorage so refresh / re-open doesn't re-prompt.
 *
 * Phase C-c, issue #46.
 *
 * Convention: mount(deps) → { destroy }. Mount is unconditional; the
 * applet itself reads `caps.landingTour` and the localStorage flag, and
 * no-ops if either is false.
 */
import { can } from '../../capabilities.js';

const SEEN_KEY = 'slate.tourSeen.v1';

let _state = null;

export function mount({ modal } = {}) {
    if (_state) destroyImpl();
    if (!can('landingTour')) return { destroy: () => {} };
    if (!modal || typeof modal.custom !== 'function') return { destroy: () => {} };

    let seen = false;
    try {
        seen = localStorage.getItem(SEEN_KEY) === '1';
    } catch {
        // localStorage may throw in private mode / sandboxed iframes —
        // treat as unseen but don't crash the boot.
    }
    if (seen) {
        _state = { shown: false };
        return { destroy: destroyImpl, replay };
    }

    // Defer one tick so the rest of the bootstrap (chat manager, viz)
    // finishes painting before the welcome modal stops the show.
    const timer = setTimeout(() => showTour(modal), 0);
    _state = { shown: true, timer };

    return { destroy: destroyImpl, replay };

    /** Force-show the tour (e.g. wired to an "About → Show tour again" entry). */
    function replay() {
        showTour(modal);
    }
}

async function showTour(modal) {
    const container = document.createElement('div');
    container.innerHTML = `
        <h4 style="margin-bottom: 12px;">Welcome to Slate</h4>
        <p style="margin-bottom: 10px; line-height: 1.5;">
            Slate is a graph-shaped notebook for prompts and code. Each card
            holds one symbol; <strong>@-references</strong> wire them together;
            COMPILE turns a doc into a runnable <code>.py</code>.
        </p>
        <p style="margin-bottom: 10px; line-height: 1.5;">
            New here? Try the calculator example — open it from
            <code>examples/calculator/calculator.slate.json</code> with
            IMPORT in the top bar. The two-doc layout
            (<code>operations</code> + <code>calculator</code>) shows
            cross-doc <code>@</code>-refs and the auto-included header
            context working together.
        </p>
        <p style="font-size: x-small; opacity: 0.75; margin-top: 14px;">
            You can re-open this from the browser console:
            <code>window.__slateLandingTour?.replay()</code>.
        </p>
    `;
    try {
        await modal.custom(container, [
            { text: 'Got it', className: 'success_btn', callback: () => null },
        ]);
    } finally {
        try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignore */ }
    }
}

function destroyImpl() {
    if (!_state) return;
    if (_state.timer) clearTimeout(_state.timer);
    _state = null;
}
