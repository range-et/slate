/**
 * terminal_handoff — copies the active doc's compiled Python source to
 * the system clipboard so it can be pasted into a running REPL/terminal.
 * VS Code-only by capability gate (`caps.terminalHandoff`).
 *
 * Phase C-c, issue #46.
 *
 * The full ⌘⇧R paste-block flow described in v0.2 §4.2 lands as #20 in
 * issues.md. This applet is the registration seam under the new applet
 * convention; mount() is unconditional but no-ops in web. When mounted
 * in the vscode target it currently exposes a global hook
 * (`window.__slateTerminalHandoff`) that future surfaces (a key binding,
 * a status-bar button, or the Phase D command palette) can call. No new
 * UI chrome is added here on purpose — keeps the doc heading uncluttered
 * until the real flow ships.
 */
import { can } from '../../capabilities.js';
import { compileDocToPython } from '../../code_compile.js';

let _state = null;

export function mount(deps = {}) {
    if (_state) destroyImpl();
    if (!can('terminalHandoff')) {
        return { destroy: () => {} };
    }

    /**
     * Copy the active doc's compiled source to the clipboard. Returns a
     * Promise<{ ok, error? }> so the caller (future #20 trigger) can
     * surface a confirmation toast.
     */
    async function handoffActiveDoc() {
        const mm = (typeof window !== 'undefined' && window.mainManager) || null;
        const doc = mm && mm.currentDoc;
        if (!doc) return { ok: false, error: 'No active document.' };

        try {
            const { source } = compileDocToPython(doc, mm.currentProject);
            if (typeof navigator !== 'undefined' && navigator.clipboard) {
                await navigator.clipboard.writeText(source);
                return { ok: true };
            }
            return { ok: false, error: 'Clipboard API unavailable.' };
        } catch (err) {
            return { ok: false, error: (err && err.message) || String(err) };
        }
    }

    if (typeof window !== 'undefined') {
        window.__slateTerminalHandoff = handoffActiveDoc;
    }
    _state = { hookAttached: true };
    return { destroy: destroyImpl, handoffActiveDoc };
}

function destroyImpl() {
    if (!_state) return;
    if (typeof window !== 'undefined' && window.__slateTerminalHandoff) {
        delete window.__slateTerminalHandoff;
    }
    _state = null;
}
