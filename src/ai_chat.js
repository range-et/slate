import Card from "./cards.js";
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
     * Set a helpful default message in the chat window
     */
    setDefaultMessage() {
        this.chatContent.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; opacity: 0.7; text-align: center; padding: var(--global_padding);">
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
     * Build a bibliography of referenced cards and docs
     * Searches across all documents in the project
     * @param {Array<string>} references - Array of card/doc titles
     * @returns {string} - Formatted bibliography text
     */
    buildBibliography(references) {
        if (references.length === 0) {
            return "";
        }

        const bibliography = [];
        bibliography.push("\n\n--- CONTEXT (Referenced Content) ---\n");

        references.forEach(ref => {
            let foundCard = null;
            let foundDoc = null;
            let foundInDocTitle = null;

            // First, check if it's a doc title
            if (window.mainManager && window.mainManager.currentProject) {
                const allDocs = window.mainManager.currentProject.getAllDocs();
                foundDoc = allDocs.find(d => d.title === ref);
                
                if (foundDoc) {
                    // Use doc summary if available
                    if (foundDoc.summary) {
                        bibliography.push(`\n@${foundDoc.title} (document summary):\n${foundDoc.summary}\n`);
                        return; // Skip card search
                    } else {
                        bibliography.push(`\n@${ref} (document - summary not yet generated)\n`);
                        return;
                    }
                }
            }

            // Not a doc, search for card in the current doc
            if (this.currentDoc) {
                foundCard = this.currentDoc.getAllCards().find(c => c.title === ref);
                if (foundCard) {
                    foundInDocTitle = this.currentDoc.title;
                }
            }

            // If not found in current doc, search across all docs
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
                // Extract plain text from HTML content
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = foundCard.content;
                const plainText = tempDiv.innerText || tempDiv.textContent;
                
                bibliography.push(`\n@${foundCard.title} (card from doc: ${foundInDocTitle}):\n${plainText}\n`);
            } else {
                // Reference not found - note it in the bibliography
                bibliography.push(`\n@${ref}: [Reference not found]\n`);
            }
        });

        bibliography.push("\n--- END CONTEXT ---\n");
        
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
     * Generate AI response based on user input
     */
    async askAI() {
        const userInput = getEditorText(this.promptEditor);
        console.log("User input:", userInput);
        
        // Parse @references from the input
        const references = this.parseReferences(userInput);
        console.log("Found references:", references);
        
        // Build bibliography with referenced card content
        const bibliography = this.buildBibliography(references);
        
        // Construct the full prompt with context
        const fullPrompt = userInput + bibliography;
        console.log("Full prompt with bibliography:", fullPrompt);
        
        // Generate a random card title if the field is empty
        if (this.cardTitleInput.value.trim() === "") {
            let randomTitle = generateRandomName();
            // Ensure the random title is unique
            if (this.currentDoc) {
                while (this.currentDoc.cardTitleExists(randomTitle)) {
                    randomTitle = generateRandomName();
                }
            }
            this.cardTitleInput.value = randomTitle;
        } else {
            // Sanitize the existing title (uniqueness will be checked when adding to doc)
            this.cardTitleInput.value = sanitizeTitle(this.cardTitleInput.value);
        }
        
        // Show loading animation
        this.chatContent.innerHTML = '<div class="loading-text">Waiting for response...</div>';
        
        // Send the full prompt (with bibliography) to the AI
        this.aiAgent.generateResponse(fullPrompt).then((res) => {
            // Render the response as markdown
            const renderedResponse = marked.parse(res);
            this.chatContent.innerHTML = `<div class="markdown-body">${renderedResponse}</div>`;
        }).catch((err) => {
            console.error("Error generating response:", err);
            this.chatContent.innerHTML = '<p style="color: var(--alert);">Error: Failed to generate response</p>';
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
            this.currentDoc.summaryError = err.message || "Unknown error occurred";
            
            // Notify mainManager to indicate error
            if (window.mainManager && window.mainManager.summaryError) {
                window.mainManager.summaryError(err.message);
            }
        }
    }

    /**
     * Add the current chat content to the document as a card
     */
    async addToDoc() {
        const confirmed = await this.modal.confirm("Add to document?");
        if (confirmed) {
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
                
                // Get the rendered markdown content (extract from the markdown-body div if present)
                const markdownBodyDiv = this.chatContent.querySelector('.markdown-body');
                const cardContent = markdownBodyDiv ? markdownBodyDiv.innerHTML : this.chatContent.innerHTML;
                
                // Create and add the card with the prompt
                const card = new Card(
                    cardTitle, 
                    cardContent, 
                    this.modal, 
                    this.updateNetworkCallback,
                    promptText  // Pass the original prompt
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
        } else {
            await this.modal.alert("Didn't add to document");
        }
    }
}

export default ChatManager;

