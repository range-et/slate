/**
 * prompt_bar — first applet under the Phase C convention. Owns the
 * response_control_panel inside the chat panel: the SEND, ADD TO DOC,
 * CODE toggle, ATTACH IMAGE, EXIT EDIT buttons, plus the cross-document
 * Escape-to-cancel binding. Adopts the existing DOM (defined in
 * src/index.html) rather than rendering it — that's a Phase D move once
 * applets own their full subtree.
 *
 * Convention (will be canonized in src/applets/README.md as more applets
 * land):
 *   mount(deps) → { destroy }
 *     - deps: every dependency the applet needs, injected explicitly. No
 *       reaching into window or globals from inside the applet.
 *     - destroy(): detach every listener the applet attached, idempotent.
 *
 * Boundaries:
 *   - DOES use:   the buttons map (passed in), the ChatManager surface
 *                 (askAI / addToDoc / cancelEdit / setupImageSupport), the
 *                 prompt editor's `setLanguage()`.
 *   - Does NOT:   know about the model, agent, network viz, project state,
 *                 or any other applet. CODE toggle just flips
 *                 ChatManager.codeMode and the editor language; it doesn't
 *                 send anything itself.
 *
 * Future sub-applets (per ARCHITECTURE.md § Phase C):
 *   model picker, language picker, send button as separate applets, stop
 *   button gated on `requires: ['streaming']`. For now they're inlined
 *   here so the bar is one mountable unit.
 */

let _state = null;

export function mount({ buttons, chatManager, promptEditor }) {
    if (_state) {
        // Defensive: caller shouldn't double-mount, but if they do, tear
        // down the previous instance so listeners don't pile up.
        destroyImpl();
    }

    const handlers = {
        send: () => chatManager.askAI(),
        addToDoc: () => chatManager.addToDoc(),
        toggleCode: () => toggleCodeMode(),
        attachImage: null, // owned by ChatManager.setupImageSupport
        exitEdit: () => chatManager.cancelEdit(),
        keydownEsc: (e) => {
            if (e.key === 'Escape' && document.body.classList.contains('slate-editing-card')) {
                chatManager.cancelEdit();
            }
        },
    };

    function toggleCodeMode() {
        chatManager.codeMode = !chatManager.codeMode;
        applyCodeModeUI();
    }

    function setCodeMode(value) {
        const next = !!value;
        if (chatManager.codeMode === next) return;
        chatManager.codeMode = next;
        applyCodeModeUI();
    }

    function applyCodeModeUI() {
        const btn = buttons.code_toggle;
        if (btn) {
            btn.setAttribute('aria-pressed', String(chatManager.codeMode));
            btn.classList.toggle('toggle-active', chatManager.codeMode);
        }
        if (promptEditor && typeof promptEditor.setLanguage === 'function') {
            promptEditor.setLanguage(chatManager.codeMode ? 'python' : 'markdown');
        }
    }

    if (buttons.send_prompt) buttons.send_prompt.addEventListener('click', handlers.send);
    if (buttons.add_to_doc) buttons.add_to_doc.addEventListener('click', handlers.addToDoc);
    if (buttons.code_toggle) buttons.code_toggle.addEventListener('click', handlers.toggleCode);
    if (buttons.exit_edit) buttons.exit_edit.addEventListener('click', handlers.exitEdit);
    document.addEventListener('keydown', handlers.keydownEsc);

    // Image support: ATTACH IMAGE wiring + paste handler still live in
    // ChatManager because they touch image state. We just hand off the
    // DOM nodes here so the applet remains the canonical mount point.
    if (buttons.attach_image && buttons.image_preview_container) {
        chatManager.setupImageSupport(buttons.attach_image, buttons.image_preview_container);
    }

    _state = { buttons, handlers, setCodeMode };

    return {
        /** Force codeMode true/false from outside (used by walkthrough). */
        setCodeMode,
        destroy: destroyImpl,
    };
}

function destroyImpl() {
    if (!_state) return;
    const { buttons, handlers } = _state;
    if (buttons.send_prompt) buttons.send_prompt.removeEventListener('click', handlers.send);
    if (buttons.add_to_doc) buttons.add_to_doc.removeEventListener('click', handlers.addToDoc);
    if (buttons.code_toggle) buttons.code_toggle.removeEventListener('click', handlers.toggleCode);
    if (buttons.exit_edit) buttons.exit_edit.removeEventListener('click', handlers.exitEdit);
    document.removeEventListener('keydown', handlers.keydownEsc);
    _state = null;
}
