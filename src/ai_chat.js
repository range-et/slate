import Card, { CARD_TYPE_CODE, CARD_TYPE_MARKDOWN } from "./cards.js";
import generateRandomName from "./random_name_generator.js";
import { getEditorText, setEditorText, clearEditor, insertAtCursor as cmInsertAtCursor, setupCodeMirrorEditor } from "./codemirror_setup.js";
import { initChatCtl, buildBibliography, applyHeaderAdditions } from "./controllers/chat_ctl.js";
import { on, emit } from "./event_bus.js";

/**
 * Sanitize a title to follow naming conventions:
 * - Replace spaces with underscores
 * - Convert to lowercase
 * - Remove special characters except underscores
 * @param {string} title - The title to sanitize
 * @returns {string} The sanitized title
 */
export function sanitizeTitle(title) {
    return title
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')           // Replace spaces with underscores
        .replace(/[^a-z0-9_]/g, '');    // Remove special characters except underscores
}

/**
 * ChatManager handles all chat-related functionality
 */
export class ChatManager {
    constructor(chatContent, promptEditor, cardTitleInput, docContent, aiAgent, modal, currentDoc, updateNetworkCallback = null) {
        this.chatContent = chatContent;
        this.promptEditor = promptEditor; // CodeMirror EditorView instance
        this.cardTitleInput = cardTitleInput;
        this.docContent = docContent;
        this.aiAgent = aiAgent;
        this.modal = modal;
        this.currentDoc = currentDoc; // reference to the current document
        this.updateNetworkCallback = updateNetworkCallback; // callback to update network viz
        
        // Image support
        this.attachedImages = []; // Array of {data: base64String, mimeType: string, name: string}
        this.imagePreviewContainer = null; // Will be set by setupImageSupport

        // Code-card mode flag — set by the CODE toggle, consumed by askAI/addToDoc
        this.codeMode = false;

        // Response editor: a live CodeMirror instance over the AI response, so
        // the user can tweak it before committing to the doc. Null until the
        // first response arrives or after clearAll/setDefaultMessage.
        this.responseEditor = null;
        this.responseCardType = null;  // tracks whether the editor is for a code or markdown response

        // Edit-in-place state. When non-null, addToDoc updates the existing
        // card instead of creating a new one. Cleared by clearAll.
        this.editingCard = null;

        // (#50) Pending module-scope additions from the most recent
        // code-mode response, parsed by chat_ctl. Applied to the current
        // doc's header card on ADD TO DOC, then cleared.
        this.pendingHeaderAdditions = [];
        
        // Auto-sanitize title on blur (when user leaves the field) and ensure uniqueness
        this.cardTitleInput.addEventListener('blur', () => {
            if (this.cardTitleInput.value.trim() !== "") {
                let sanitized = sanitizeTitle(this.cardTitleInput.value);
                
                // Ensure the title is unique by appending numbers if needed
                if (this.currentDoc) {
                    sanitized = this.currentDoc.getUniqueCardTitle(sanitized);
                }
                
                this.cardTitleInput.value = sanitized;
            }
        });

        // Wire chat_ctl with this view's slice of state, then subscribe to its
        // emitted events. The controller drives the response editor + error
        // modals via these handlers; askAI() below just translates the user
        // intent into a chat:send-requested emit.
        initChatCtl({
            getDoc: () => this.currentDoc,
            getProject: () => window.mainManager?.currentProject || null,
            getAgent: (codeMode) => this.resolveAgentFor(codeMode),
        });
        this._setupChatEventListeners();
    }

    /**
     * Subscribe this view to chat_ctl's lifecycle events. Streaming token
     * deltas append to the response editor (mounting it lazily on the first
     * token); completion replaces the editor contents with the cleaned
     * final text; errors map to user-facing modals.
     */
    _setupChatEventListeners() {
        if (this._chatListenersWired) return;
        this._chatListenersWired = true;

        let _streamingMounted = false;

        on('chat:started', () => {
            _streamingMounted = false;
            this.disposeResponseEditor();
            this.chatContent.innerHTML = '<div class="loading-text">Streaming response…</div>';
        });

        on('chat:streaming', ({ delta, codeMode }) => {
            if (!_streamingMounted) {
                this.renderResponseEditor('', { isCode: !!codeMode });
                _streamingMounted = true;
            }
            if (!this.responseEditor) return;
            const view = this.responseEditor;
            const end = view.state.doc.length;
            view.dispatch({ changes: { from: end, to: end, insert: delta } });
        });

        on('chat:complete', ({ text, codeMode, headerAdditions }) => {
            // (#50) Stash module-scope additions for the upcoming
            // ADD TO DOC commit. clearAll() resets this back to [].
            this.pendingHeaderAdditions = Array.isArray(headerAdditions) ? headerAdditions : [];
            if (!_streamingMounted) {
                // Non-streaming agents land here without ever having emitted
                // chat:streaming — mount the editor with the final text.
                this.renderResponseEditor(text, { isCode: !!codeMode });
            } else if (codeMode) {
                // Replace the streamed buffer with the fence-stripped,
                // additions-stripped final text so the saved card is clean
                // Python (the function/class only — additions land on the
                // header card on commit).
                const view = this.responseEditor;
                if (view) {
                    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
                }
            }
        });

        on('chat:error', ({ kind, err, codeMode }) => {
            this._handleChatError(kind, err, codeMode);
        });
    }

    /**
     * Hydrate the prompt + response panes from an existing card so the user
     * can edit it in place. Sets editingCard so the next addToDoc updates
     * the same card instead of creating a new one. Toggles the edit-mode
     * styling (yellow diagonal stripes) on.
     */
    loadCardForEdit(card) {
        if (!card) return;

        // If we were already editing another card, abandon those edits.
        this.editingCard = card;

        // Match the card's mode so SEND re-generation respects code-vs-markdown.
        const isCode = card.cardType === CARD_TYPE_CODE;
        if (this.codeMode !== isCode && window.mainManager?.toggleCodeMode) {
            window.mainManager.toggleCodeMode();   // flips codeMode + button + prompt language
        }

        // Title.
        this.cardTitleInput.value = card.title || '';

        // Prompt.
        clearEditor(this.promptEditor);
        if (card.prompt) setEditorText(this.promptEditor, card.prompt);

        // Images.
        this.attachedImages = Array.isArray(card.images) ? [...card.images] : [];
        this.renderImagePreviews();

        // Response: code cards have raw source; markdown cards may have raw
        // markdown (new) or HTML (legacy). Either way, drop it into the editor.
        const responseText = isCode
            ? (card.getPythonSource() || '')
            : (card.content || '');
        this.renderResponseEditor(responseText, { isCode });

        // Visual: tag the response container so styles.css can paint the
        // diagonal yellow stripes that signal "you're editing".
        this.applyEditingChrome(true);

        // Pop the user up to the chat panel on mobile.
        const chatPanel = document.getElementById('chat');
        if (chatPanel && window.matchMedia('(max-width: 768px)').matches) {
            document.querySelectorAll('.panel.mobile-active').forEach(el => el.classList.remove('mobile-active'));
            chatPanel.classList.add('mobile-active');
        }
    }

    /**
     * Toggle the edit-mode styling on/off. Hooked up via a body-level class
     * so the CSS can style the prompt + response containers + add-to-doc
     * button without needing to wire each element individually.
     */
    applyEditingChrome(on) {
        document.body.classList.toggle('slate-editing-card', !!on);
    }

    /**
     * Bail out of edit-in-place mode without saving. Drops the editingCard
     * pointer, clears prompt/response/title/images, and removes the yellow
     * stripes. Wired to the EXIT EDIT button and the ESC key.
     */
    cancelEdit() {
        if (!this.editingCard) return;
        // EXIT EDIT also bails out of an in-progress GENERATE ALL walkthrough.
        if (window.mainManager && window.mainManager.walkthroughActive) {
            window.mainManager.endWalkthrough({ aborted: true });
        }
        this.clearAll();
    }

    /**
     * Tear down the live response editor (if any) and clear chatContent.
     * Safe to call when no editor is mounted.
     */
    disposeResponseEditor() {
        if (this.responseEditor) {
            try { this.responseEditor.destroy(); } catch (e) { /* already gone */ }
            this.responseEditor = null;
        }
        this.responseCardType = null;
        this.chatContent.innerHTML = '';
    }

    /**
     * Mount the response in an editable CodeMirror surface so the user can
     * tweak it before clicking ADD TO DOC. `isCode` flips the language mode.
     */
    renderResponseEditor(text, { isCode }) {
        this.disposeResponseEditor();
        const wrap = document.createElement('div');
        wrap.className = 'response-editor-wrap';
        wrap.style.height = '100%';
        wrap.style.display = 'flex';
        wrap.style.flexDirection = 'column';
        this.chatContent.appendChild(wrap);

        // Reuse the prompt editor factory — it already supplies the slate
        // theme, line wrapping, and (harmlessly) @-reference autocomplete.
        // Markdown gets full lang highlighting (headings, lists, code fences,
        // links) instead of 'plain' which leaves it as monospace text.
        this.responseEditor = setupCodeMirrorEditor(
            wrap,
            () => this.currentDoc,
            () => window.mainManager?.currentProject,
            { language: isCode ? 'python' : 'markdown' }
        );
        // Seed the editor with the response text.
        setEditorText(this.responseEditor, text || '');
        this.responseCardType = isCode ? CARD_TYPE_CODE : CARD_TYPE_MARKDOWN;
    }

    /**
     * Read the current text out of the response editor. Returns '' when no
     * editor is mounted (e.g. while the placeholder is showing).
     */
    getResponseText() {
        if (!this.responseEditor) return '';
        return getEditorText(this.responseEditor);
    }

    /**
     * Pick the agent to use for the next generation. Code cards prefer the local
     * provider regardless of what the user picked in the settings modal — that's
     * the whole point of slate-code. Falls back to the active agent if no local
     * is available, or if MainManager isn't reachable.
     */
    resolveAgentFor(codeMode) {
        if (!codeMode) return this.aiAgent;
        const mm = window.mainManager;
        if (mm && typeof mm.getAgentForProvider === 'function') {
            try {
                return mm.getAgentForProvider('local');
            } catch (err) {
                console.warn('Failed to construct local agent for code card; falling back:', err);
            }
        }
        return this.aiAgent;
    }

    /**
     * Set a helpful default message in the chat window
     */
    setDefaultMessage() {
        this.disposeResponseEditor();
        this.chatContent.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; opacity: 0.7; text-align: center; padding: var(--space-2);">
                <p style="line-height: 1.6;">
                    Write a prompt above and hit <strong>SEND</strong>.<br>
                    The response is editable here; <strong>ADD TO DOC</strong> commits it as a card.
                </p>
            </div>
        `;
    }

    /**
     * Clear the chat window and reset to default message
     */
    clearChat() {
        this.setDefaultMessage();
        this.cardTitleInput.value = "";
        // Note: We intentionally don't clear the prompt when switching docs
    }

    /**
     * Clear everything including the prompt (used after adding to doc).
     * Also exits edit-in-place mode if we were in it.
     */
    clearAll() {
        this.setDefaultMessage();
        this.cardTitleInput.value = "";
        clearEditor(this.promptEditor);
        this.clearImages();
        this.editingCard = null;
        this.applyEditingChrome(false);
        // (#50) Drop any unapplied additions; ADD TO DOC consumes them.
        this.pendingHeaderAdditions = [];
    }

    /**
     * (#50) On a successful ADD TO DOC commit, append any module-scope
     * additions the model emitted to the current doc's header card and
     * re-render that card's DOM in place. Pure no-op if there's nothing
     * to apply, no current doc, or no header card. Returns true if the
     * header was actually mutated (caller may use that to trigger a viz
     * refresh, though updateNetworkCallback already runs separately).
     */
    applyPendingHeaderAdditions() {
        const additions = this.pendingHeaderAdditions || [];
        if (additions.length === 0) return false;
        if (!this.currentDoc) return false;
        const header = this.currentDoc.getAllCards().find(c => c.isHeader && c.isHeader());
        if (!header) return false;

        const before = header.content || '';
        const after = applyHeaderAdditions(before, additions);
        if (after === before) return false;

        header.content = after;
        if (this.currentDoc.updatedAt !== undefined) {
            this.currentDoc.updatedAt = new Date().toISOString();
        }

        // Re-render the header card's DOM so the new lines show up
        // immediately. The original element lives inside #doc-content.
        const oldEl = header.innerHTML;
        const fresh = header.create();
        if (oldEl && oldEl.parentNode) {
            oldEl.parentNode.replaceChild(fresh, oldEl);
            header.innerHTML = fresh;
            // Re-bind the edit button's handler — same logic as
            // reattachCardHandlers, just for the header's edit-only action set.
            const editBtn = fresh.querySelector('.card-edit-btn');
            if (editBtn) {
                editBtn.addEventListener('click', () => this.loadCardForEdit(header));
            }
        }
        return true;
    }

    /**
     * Parse @references from the prompt text
     * @param {string} text - The text to parse
     * @returns {Array<string>} - Array of referenced card titles (without @)
     */
    parseReferences(text) {
        // Match @word patterns (including underscores and numbers)
        const regex = /@([\w]+)/g;
        const matches = [];
        let match;
        
        while ((match = regex.exec(text)) !== null) {
            matches.push(match[1]); // Get the word without the @
        }
        
        return [...new Set(matches)]; // Remove duplicates
    }

    /**
     * Thin shim for callers that used to invoke this.buildBibliography(...).
     * The real implementation now lives in
     * [chat_ctl.js](./controllers/chat_ctl.js) as a pure function.
     * Preserved here as an instance method so anything outside the class that
     * referenced `chatManager.buildBibliography(...)` keeps working.
     */
    buildBibliography(references, opts = {}) {
        return buildBibliography(
            references,
            this.currentDoc,
            window.mainManager?.currentProject || null,
            opts
        );
    }

    /**
     * Insert text at cursor position in the editor
     * @param {string} text - The text to insert
     */
    insertAtCursor(text) {
        // Use CodeMirror's insert function
        cmInsertAtCursor(this.promptEditor, text);
    }

    /**
     * Setup image support (attach button and paste events)
     * @param {HTMLElement} attachButton - The attach image button
     * @param {HTMLElement} previewContainer - Container for image previews
     */
    setupImageSupport(attachButton, previewContainer) {
        this.imagePreviewContainer = previewContainer;
        
        // Handle attach button click
        attachButton.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.multiple = true;
            input.onchange = (e) => {
                const files = Array.from(e.target.files);
                files.forEach(file => this.addImageFile(file));
            };
            input.click();
        });
        
        // Handle paste events for copy-paste images
        this._pasteHandler = (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;

            for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image') !== -1) {
                    const file = items[i].getAsFile();
                    if (file) {
                        e.preventDefault();
                        this.addImageFile(file);
                    }
                }
            }
        };
        document.addEventListener('paste', this._pasteHandler);
    }

    /**
     * Detach global listeners. Safe to call multiple times.
     */
    destroy() {
        if (this._pasteHandler) {
            document.removeEventListener('paste', this._pasteHandler);
            this._pasteHandler = null;
        }
    }

    /**
     * Convert an image file to base64
     * @param {File} file - The image file
     * @returns {Promise<{data: string, mimeType: string, name: string}>}
     */
    async addImageFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const base64 = e.target.result; // This includes the data:image/...;base64, prefix
                const imageData = {
                    data: base64,
                    mimeType: file.type,
                    name: file.name
                };
                this.attachedImages.push(imageData);
                this.renderImagePreviews();
                resolve(imageData);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    /**
     * Remove an image from the attached images array
     * @param {number} index - Index of the image to remove
     */
    removeImage(index) {
        this.attachedImages.splice(index, 1);
        this.renderImagePreviews();
    }

    /**
     * Render preview thumbnails for attached images
     */
    renderImagePreviews() {
        if (!this.imagePreviewContainer) return;
        
        if (this.attachedImages.length === 0) {
            this.imagePreviewContainer.innerHTML = '';
            this.imagePreviewContainer.style.display = 'none';
            return;
        }
        
        this.imagePreviewContainer.style.display = 'flex';
        this.imagePreviewContainer.innerHTML = this.attachedImages.map((img, index) => `
            <div class="image-preview-item">
                <img src="${img.data}" alt="${img.name}" />
                <button class="image-remove-btn" data-index="${index}">×</button>
            </div>
        `).join('');
        
        // Attach remove button listeners
        this.imagePreviewContainer.querySelectorAll('.image-remove-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const index = parseInt(btn.getAttribute('data-index'));
                this.removeImage(index);
            });
        });
    }

    /**
     * Clear attached images
     */
    clearImages() {
        this.attachedImages = [];
        this.renderImagePreviews();
    }

    /**
     * Thin view-side handler. Validates UI inputs (prompt non-empty, title
     * randomized if blank), then fires `chat:send-requested` for chat_ctl
     * to handle. Streaming + completion + error UI all happen via the
     * subscribers wired in `_setupChatEventListeners`.
     */
    async askAI() {
        const userInput = getEditorText(this.promptEditor);
        const codeMode = !!this.codeMode;
        console.log("User input:", userInput, "| codeMode:", codeMode);

        if (!userInput || !userInput.trim()) {
            await this.modal.alert("Type a prompt before clicking SEND.");
            return;
        }

        // Pick the title now (random if empty), so chat_ctl can pass it
        // into the codegen system prompt.
        if (this.cardTitleInput.value.trim() === "") {
            let randomTitle = generateRandomName();
            if (this.currentDoc) {
                while (this.currentDoc.cardTitleExists(randomTitle)) {
                    randomTitle = generateRandomName();
                }
            }
            this.cardTitleInput.value = randomTitle;
        } else {
            this.cardTitleInput.value = sanitizeTitle(this.cardTitleInput.value);
        }

        emit('chat:send-requested', {
            userInput,
            references: this.parseReferences(userInput),
            codeMode,
            cardTitle: this.cardTitleInput.value,
            docTitle: this.currentDoc ? this.currentDoc.title : 'untitled',
            attachedImages: this.attachedImages,
        });
    }

    /**
     * Map a chat_ctl error kind to the right user-facing modal + chatContent
     * fallback message. Keeps the wordy copy out of the controller.
     */
    async _handleChatError(kind, err, codeMode) {
        if (kind === 'no_agent') {
            const which = codeMode ? "Local model" : "AI provider";
            await this.modal.alert(
                `${which} not configured. Click API KEY in the toolbar to add a key, ` +
                `or switch the provider to Local (Ollama) for code cards.`
            );
            return;
        }
        if (kind === 'local_unreachable') {
            await this.modal.alert(
                "Couldn't reach the local model. Make sure Ollama is running:\n\n" +
                "  OLLAMA_ORIGINS='*' ollama serve\n\n" +
                "and that the model in the API KEY modal matches an installed tag (e.g. `qwen2.5-coder:7b`)."
            );
            this.disposeResponseEditor();
            this.chatContent.innerHTML = '<p style="color: var(--alert);">Local model unreachable. Start Ollama and try again.</p>';
            return;
        }
        if (kind === 'api_key_missing') {
            await this.modal.custom(
                `<div>
                    <p style="margin-bottom: 15px; line-height: 1.6;">
                        <strong>API Key Required</strong>
                    </p>
                    <p style="margin-bottom: 15px;">
                        You need to set your OpenAI API key to use AI features.
                    </p>
                    <p style="margin-bottom: 0; font-size: x-small;">
                        Click the <strong>API KEY</strong> button in the top bar to add your key.
                    </p>
                </div>`,
                [{ text: 'OK', className: 'info_btn', callback: () => null }]
            );
            this.disposeResponseEditor();
            this.chatContent.innerHTML = '<p style="color: var(--alert);">Please set your API key to continue.</p>';
            return;
        }
        if (kind === 'rate_limit') {
            await this.modal.alert("Rate limit exceeded. Please wait a moment and try again.");
            this.disposeResponseEditor();
            this.chatContent.innerHTML = '<p style="color: var(--alert);">Rate limit exceeded. Please try again later.</p>';
            return;
        }
        // 'other' — generic failure
        const msg = (err && err.message) || "Unknown error";
        await this.modal.alert(`Failed to generate response: ${msg}. Please check your API key and try again.`);
        this.disposeResponseEditor();
        this.chatContent.innerHTML = '<p style="color: var(--alert);">Error: Failed to generate response. Please try again.</p>';
    }

    // (#51) `generateDocSummary` was removed. The doc's header card (always
    // pinned at index 0, fully editable) is the doc's canonical overview
    // now — no second AI round-trip on every commit, no animated SUMMARY
    // button to babysit.

    /**
     * Add the current chat content to the document as a card
     */
    async addToDoc() {
        try {
            const responseText = this.getResponseText();
            let cardTitle = this.cardTitleInput.value.trim();

            if (!this.responseEditor || !responseText.trim()) {
                throw new Error("Please generate a response first");
            }
            if (cardTitle === "") {
                throw new Error("Card title is required");
            }

            const promptText = getEditorText(this.promptEditor);
            const referencedTitles = this.parseReferences(promptText);
            const isCodeCard = this.responseCardType === CARD_TYPE_CODE;
            const cardType = isCodeCard ? CARD_TYPE_CODE : CARD_TYPE_MARKDOWN;

            if (this.editingCard) {
                // Edit-in-place: mutate the existing card and re-render its DOM.
                const card = this.editingCard;
                const oldTitle = card.title;
                let newTitle = sanitizeTitle(cardTitle);
                // Title uniqueness check excludes the card itself (so re-saving with
                // the same title doesn't append _1).
                if (newTitle !== oldTitle && this.currentDoc) {
                    newTitle = this.currentDoc.getUniqueCardTitle(newTitle);
                }
                card.title = newTitle;
                card.content = responseText;
                card.cardType = cardType;
                card.prompt = promptText;
                card.images = [...this.attachedImages];
                card.links = referencedTitles;

                // Re-render: build a fresh DOM element and swap it in for the old one.
                const oldEl = card.innerHTML;
                card.innerHTML = card.create();
                if (oldEl && oldEl.parentNode) {
                    oldEl.parentNode.replaceChild(card.innerHTML, oldEl);
                }
                // Re-attach handlers on the new DOM (init() does this, but it would also re-set the id).
                this.reattachCardHandlers(card);

                if (this.updateNetworkCallback) this.updateNetworkCallback();
                // (#50) Apply any module-scope additions to the header card
                // BEFORE clearAll wipes the pending list.
                this.applyPendingHeaderAdditions();
                this.clearAll();
                console.log("Card updated in place:", card.id);
                // GENERATE ALL walkthrough: advance to the next unresolved card.
                if (window.mainManager && typeof window.mainManager.advanceWalkthrough === 'function') {
                    window.mainManager.advanceWalkthrough();
                }
                return;
            }

            // Create-new path.
            cardTitle = sanitizeTitle(cardTitle);
            if (this.currentDoc) {
                cardTitle = this.currentDoc.getUniqueCardTitle(cardTitle);
            }

            const card = new Card(
                cardTitle,
                responseText,    // raw markdown for prose cards, raw Python for code cards
                this.modal,
                this.updateNetworkCallback,
                promptText,
                [...this.attachedImages],
                cardType
            );
            card.init();
            card.links = referencedTitles;

            if (this.currentDoc) {
                this.currentDoc.addCard(card);
                console.log("Card added to document:", card.id, "| Doc now has", this.currentDoc.getCardCount(), "cards");
            }

            this.docContent.appendChild(card.innerHTML);

            if (this.updateNetworkCallback) {
                this.updateNetworkCallback();
            }

            // (#50) Apply any module-scope additions to the header card
            // BEFORE clearAll wipes the pending list.
            this.applyPendingHeaderAdditions();
            this.clearAll();
        } catch (err) {
            console.error("Didn't add card to document:", err);
            await this.modal.alert("Cannot add: " + err.message);
        }
    }

    /**
     * Re-bind the listeners that Card.init() normally attaches when the DOM
     * element was rebuilt by edit-in-place. We can't call card.init() again
     * because it would mint a new UUID via the missing-id branch.
     */
    reattachCardHandlers(card) {
        const removeBtn = card.innerHTML.querySelector('.alert_btn');
        if (removeBtn) removeBtn.addEventListener('click', (e) => { e.stopPropagation(); card.remove(); });
        const moveBtn = card.innerHTML.querySelector('.card-move-btn');
        if (moveBtn) moveBtn.addEventListener('click', (e) => { e.stopPropagation(); card.moveToAnotherDoc(); });
        const editBtn = card.innerHTML.querySelector('.card-edit-btn');
        if (editBtn) editBtn.addEventListener('click', (e) => { e.stopPropagation(); card.loadIntoEditor(); });
        card.innerHTML.addEventListener('contextmenu', (e) => {
            if (e.target.closest('.card-link-inline')) return;
            e.preventDefault();
            card.loadIntoEditor();
        });
        card.innerHTML.querySelectorAll('.card-link-inline').forEach(linkEl => {
            linkEl.addEventListener('click', (e) => {
                e.stopPropagation();
                card.navigateToCard(linkEl.getAttribute('data-link'));
            });
        });
    }
}

export default ChatManager;

