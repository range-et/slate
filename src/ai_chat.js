import Card, { CARD_TYPE_CODE, CARD_TYPE_MARKDOWN, stripPythonFences, escapeHtml } from "./cards.js";
import generateRandomName from "./random_name_generator.js";
import { getEditorText, setEditorText, clearEditor, insertAtCursor as cmInsertAtCursor, setupCodeMirrorEditor } from "./codemirror_setup.js";
import { marked } from 'marked';

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
        this.responseEditor = setupCodeMirrorEditor(
            wrap,
            () => this.currentDoc,
            () => window.mainManager?.currentProject,
            { language: isCode ? 'python' : 'plain' }
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
     * Build a bibliography of referenced cards and docs.
     * In code mode, code-card refs render as `# from <doc>: <title>\n<source>`
     * comment blocks so the model sees them as Python it can call.
     */
    buildBibliography(references, { codeMode = false } = {}) {
        if (references.length === 0) {
            return "";
        }

        const bibliography = [];
        const header = codeMode
            ? "\n\n# --- REFERENCED CODE ---\n"
            : "\n\n--- CONTEXT (Referenced Content) ---\n";
        bibliography.push(header);

        references.forEach(ref => {
            let foundCard = null;
            let foundDoc = null;
            let foundInDocTitle = null;

            // First, check if it's a doc title
            if (window.mainManager && window.mainManager.currentProject) {
                const allDocs = window.mainManager.currentProject.getAllDocs();
                foundDoc = allDocs.find(d => d.title === ref);

                if (foundDoc) {
                    if (codeMode) {
                        bibliography.push(`\n# @${foundDoc.title} (document) — refer to its code cards by name.\n`);
                        return;
                    }
                    if (foundDoc.summary) {
                        bibliography.push(`\n@${foundDoc.title} (document summary):\n${foundDoc.summary}\n`);
                        return;
                    } else {
                        bibliography.push(`\n@${ref} (document - summary not yet generated)\n`);
                        return;
                    }
                }
            }

            if (this.currentDoc) {
                foundCard = this.currentDoc.getAllCards().find(c => c.title === ref);
                if (foundCard) foundInDocTitle = this.currentDoc.title;
            }
            if (!foundCard && window.mainManager && window.mainManager.currentProject) {
                const allDocs = window.mainManager.currentProject.getAllDocs();
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

        bibliography.push(codeMode ? "\n# --- END REFERENCED CODE ---\n" : "\n--- END CONTEXT ---\n");

        return bibliography.join("");
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
     * Generate AI response based on user input.
     * In code mode, the system prompt is swapped, the response is rendered as
     * a syntax-highlighted Python block, and routing favors the local provider.
     */
    async askAI() {
        const userInput = getEditorText(this.promptEditor);
        const codeMode = !!this.codeMode;
        console.log("User input:", userInput, "| codeMode:", codeMode);

        if (!userInput || !userInput.trim()) {
            await this.modal.alert("Type a prompt before clicking SEND.");
            return;
        }

        // Preflight: make sure we have a usable agent before showing the loading state.
        const preflightAgent = this.resolveAgentFor(codeMode);
        if (!preflightAgent || (typeof preflightAgent.hasApiKey === 'function' && !preflightAgent.hasApiKey())) {
            const which = codeMode ? "Local model" : "AI provider";
            await this.modal.alert(
                `${which} not configured. Click API KEY in the toolbar to add a key, ` +
                `or switch the provider to Local (Ollama) for code cards.`
            );
            return;
        }

        const references = this.parseReferences(userInput);
        console.log("Found references:", references);
        const bibliography = this.buildBibliography(references, { codeMode });

        // Pick the title now (random if empty), so we can pass it into the system prompt.
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
        const cardTitle = this.cardTitleInput.value;
        const docTitle = this.currentDoc ? this.currentDoc.title : 'untitled';

        const fullPrompt = userInput + bibliography;
        console.log("Full prompt with bibliography:", fullPrompt);

        // Resolve which agent to use. Code cards prefer the local agent if one is configured.
        const agent = this.resolveAgentFor(codeMode);
        const codeSystemPrompt = `Output only valid Python source for one symbol named \`${cardTitle}\`. No prose, no markdown fences, no triple backticks, no commentary. The output will be saved as the body of \`${cardTitle}\` in \`${docTitle}.py\`. Reference any \`# from <doc>: <name>\` blocks above as if they were already importable.`;
        const generateOptions = codeMode ? { systemPrompt: codeSystemPrompt } : {};

        this.disposeResponseEditor();
        this.chatContent.innerHTML = '<div class="loading-text">Waiting for response...</div>';

        agent.generateResponse(fullPrompt, this.attachedImages, generateOptions).then((res) => {
            const text = codeMode ? stripPythonFences(res).trim() : (res || '');
            this.renderResponseEditor(text, { isCode: codeMode });
        }).catch(async (err) => {
            console.error("Error generating response:", err);

            const errorMessage = err.message || "";
            const errorStatus = err.status || err.response?.status || err.statusCode;
            const errorCode = err.code || err.error?.code;

            // Local model unreachable — most common when Ollama isn't running or CORS blocks the browser.
            const looksLikeNetwork = errorMessage.includes("fetch") || errorMessage.includes("Failed to fetch")
                || errorMessage.includes("NetworkError") || errorMessage.includes("ECONNREFUSED")
                || err.cause?.code === 'ECONNREFUSED';
            if (codeMode && looksLikeNetwork) {
                await this.modal.alert(
                    "Couldn't reach the local model. Make sure Ollama is running:\n\n" +
                    "  OLLAMA_ORIGINS='*' ollama serve\n\n" +
                    "and that the model in the API KEY modal matches an installed tag (e.g. `qwen2.5-coder:7b`)."
                );
                this.disposeResponseEditor();
                this.chatContent.innerHTML = '<p style="color: var(--alert);">Local model unreachable. Start Ollama and try again.</p>';
                return;
            }

            if (err.message === "API_KEY_MISSING" ||
                errorMessage.includes("API key") ||
                errorMessage.includes("Invalid API key") ||
                errorStatus === 401 ||
                errorCode === "invalid_api_key") {
                // API key is missing or invalid
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
                    [
                        {
                            text: 'OK',
                            className: 'info_btn',
                            callback: () => null
                        }
                    ]
                );
                this.disposeResponseEditor();
                this.chatContent.innerHTML = '<p style="color: var(--alert);">Please set your API key to continue.</p>';
            } else if (err.message?.includes("rate limit") || err.status === 429) {
                await this.modal.alert("Rate limit exceeded. Please wait a moment and try again.");
                this.disposeResponseEditor();
                this.chatContent.innerHTML = '<p style="color: var(--alert);">Rate limit exceeded. Please try again later.</p>';
            } else {
                await this.modal.alert(`Failed to generate response: ${err.message || "Unknown error"}. Please check your API key and try again.`);
                this.disposeResponseEditor();
                this.chatContent.innerHTML = '<p style="color: var(--alert);">Error: Failed to generate response. Please try again.</p>';
            }
        });
    }

    /**
     * Generate summary for the current document asynchronously
     */
    async generateDocSummary() {
        if (!this.currentDoc || this.currentDoc.getCardCount() === 0) {
            return;
        }

        // Clear any previous error
        this.currentDoc.summaryError = null;
        
        // Mark as generating
        this.currentDoc.summaryGenerating = true;
        
        // Notify mainManager to start animation (if available)
        if (window.mainManager && window.mainManager.startSummaryAnimation) {
            window.mainManager.startSummaryAnimation();
        }

        console.log("Generating summary for doc:", this.currentDoc.title);

        try {
            // Get flattened content from all cards
            const content = this.currentDoc.getFlattenedContent();
            
            // Generate summary using AI
            const summary = await this.aiAgent.generateSummary(content);
            
            // Update doc with summary
            this.currentDoc.updateSummary(summary);
            
            console.log("Summary generated successfully");
            
            // Notify mainManager to indicate success
            if (window.mainManager && window.mainManager.summarySuccess) {
                window.mainManager.summarySuccess();
            }
        } catch (err) {
            console.error("Failed to generate summary:", err);
            this.currentDoc.summaryGenerating = false;
            
            // Extract error details
            const errorMessage = err.message || "";
            const errorStatus = err.status || err.response?.status || err.statusCode;
            const errorCode = err.code || err.error?.code;
            
            // Handle API key errors specifically
            if (err.message === "API_KEY_MISSING" || 
                errorMessage.includes("API key") || 
                errorMessage.includes("Invalid API key") ||
                errorStatus === 401 ||
                errorCode === "invalid_api_key") {
                this.currentDoc.summaryError = "API key required";
                // Show helpful modal
                await this.modal.alert("API key required to generate summaries. Please set your API key using the API KEY button in the top bar.");
            } else {
                this.currentDoc.summaryError = err.message || "Unknown error occurred";
            }
            
            // Notify mainManager to indicate error
            if (window.mainManager && window.mainManager.summaryError) {
                window.mainManager.summaryError(this.currentDoc.summaryError);
            }
        }
    }

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
                this.generateDocSummary();
                this.clearAll();
                console.log("Card updated in place:", card.id);
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

            this.generateDocSummary();
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

