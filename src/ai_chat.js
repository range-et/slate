import Card, { CARD_TYPE_CODE, CARD_TYPE_MARKDOWN, stripPythonFences, escapeHtml } from "./cards.js";
import generateRandomName from "./random_name_generator.js";
import { getEditorText, setEditorText, clearEditor, insertAtCursor as cmInsertAtCursor } from "./codemirror_setup.js";
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
        this.chatContent.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; opacity: 0.7; text-align: center; padding: var(--space-2);">
                <p style="font-size: medium; line-height: 1.6;">
                    Enter a prompt below and click <strong>SEND</strong> to start a conversation.<br>
                    Your response will appear here.
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
     * Clear everything including the prompt (used after adding to doc)
     */
    clearAll() {
        this.setDefaultMessage();
        this.cardTitleInput.value = "";
        clearEditor(this.promptEditor);
        this.clearImages();
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

        this.chatContent.innerHTML = '<div class="loading-text">Waiting for response...</div>';
        delete this.chatContent.dataset.cardType;
        delete this.chatContent.dataset.codeSource;

        agent.generateResponse(fullPrompt, this.attachedImages, generateOptions).then((res) => {
            if (codeMode) {
                // Strip any markdown fences the model leaked despite instructions, then render as code.
                const stripped = stripPythonFences(res).trim();
                this.chatContent.innerHTML = `<pre class="card-code-block language-python"><code>${escapeHtml(stripped)}</code></pre>`;
                this.chatContent.dataset.cardType = 'code';
                this.chatContent.dataset.codeSource = stripped;
            } else {
                const renderedResponse = marked.parse(res);
                this.chatContent.innerHTML = `<div class="markdown-body">${renderedResponse}</div>`;
            }
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
                this.chatContent.innerHTML = '<p style="color: var(--alert);">Please set your API key to continue.</p>';
            } else if (err.message?.includes("rate limit") || err.status === 429) {
                // Rate limit error
                await this.modal.alert("Rate limit exceeded. Please wait a moment and try again.");
                this.chatContent.innerHTML = '<p style="color: var(--alert);">Rate limit exceeded. Please try again later.</p>';
            } else {
                // Other errors
                await this.modal.alert(`Failed to generate response: ${err.message || "Unknown error"}. Please check your API key and try again.`);
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
            // Get content and title
            const contentText = this.chatContent.innerText.trim();
            let cardTitle = this.cardTitleInput.value.trim();
                
                // Validate content is not empty, loading, or the default welcome message
                if (contentText === "" || 
                    contentText === "Waiting for response..." || 
                    contentText.includes("Welcome to Slate") ||
                    this.chatContent.querySelector('.loading-text')) {
                    throw new Error("Please generate a response first");
                }
                
                // Validate title is not empty
                if (cardTitle === "") {
                    throw new Error("Card title is required");
                }
                
                // Sanitize the title
                cardTitle = sanitizeTitle(cardTitle);
                
                // Ensure title is unique (append _1, _2, etc. if needed)
                if (this.currentDoc) {
                    cardTitle = this.currentDoc.getUniqueCardTitle(cardTitle);
                }
                
                // Parse @references from the prompt to establish links
                const promptText = getEditorText(this.promptEditor);
                const referencedTitles = this.parseReferences(promptText);
                console.log("Card will link to:", referencedTitles);
                
                // The chat preview holds the source for code cards or rendered markdown for prose cards.
                // Code cards persist plain text (the Python source after fence-stripping), prose cards keep HTML.
                const isCodeCard = this.chatContent.dataset.cardType === CARD_TYPE_CODE;
                const cardType = isCodeCard ? CARD_TYPE_CODE : CARD_TYPE_MARKDOWN;
                let cardContent;
                if (isCodeCard) {
                    cardContent = this.chatContent.dataset.codeSource || this.chatContent.innerText.trim();
                } else {
                    const markdownBodyDiv = this.chatContent.querySelector('.markdown-body');
                    cardContent = markdownBodyDiv ? markdownBodyDiv.innerHTML : this.chatContent.innerHTML;
                }

                // Create and add the card with the prompt and images
                const card = new Card(
                    cardTitle,
                    cardContent,
                    this.modal,
                    this.updateNetworkCallback,
                    promptText,  // Pass the original prompt
                    [...this.attachedImages],  // Pass a copy of attached images
                    cardType
                );
                card.init();
                
                // Set the links array with referenced card titles
                card.links = referencedTitles;
                
                // Add card to the current document instance
                if (this.currentDoc) {
                    this.currentDoc.addCard(card);
                    console.log("Card added to document:", card.id, "| Doc now has", this.currentDoc.getCardCount(), "cards");
                }
                
                // Add card to the DOM
                this.docContent.appendChild(card.innerHTML);
                
                // Update the network visualization
                if (this.updateNetworkCallback) {
                    this.updateNetworkCallback();
                }
                
                // Trigger async summary generation for the doc
                this.generateDocSummary();
                
                // Clear everything (including prompt) after adding card
                this.clearAll();
            }
        catch (err) {
            console.error("Didn't add card to document:", err);
            await this.modal.alert("Cannot add: " + err.message);
        }
    }
}

export default ChatManager;

