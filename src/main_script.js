import { NetworkViz } from "./network_viz.js";
import OpenAIAgent, { GeminiAgent } from "./ai_utils.js";
import Doc from "./doc.js";
import Project from "./project.js";
import Modal from "./modal.js";
import ChatManager, { sanitizeTitle } from "./ai_chat.js";
import generateRandomName from "./random_name_generator.js";
import { setupCodeMirrorEditor } from "./codemirror_setup.js";
import { marked } from 'marked';

// Select all the dom elements
const network = document.getElementById("network");
const resetZoom = document.getElementById("resetZoom");
const project_title_input = document.getElementById("project_title_input");
// search stuff
const search_input = document.getElementById("search_input");
const search_btn = document.getElementById("search_btn");
// docs stuff
const doc_content = document.getElementById("doc-content");
const summary_btn = document.getElementById("summary_btn");
const add_doc = document.getElementById("add_doc");
const remove_doc = document.getElementById("remove_doc");
const doc_title_input = document.getElementById("doc_title_input");
// editor actions
const undo_btn = document.getElementById("undo_btn");
const export_btn = document.getElementById("export_btn");
const import_btn = document.getElementById("import_btn");
const api_key_btn = document.getElementById("api_key_btn");
const feedback_btn = document.getElementById("feedback_btn");
const about_btn = document.getElementById("about_btn");
// chat stuff
const chat_content = document.getElementById("chat-content");
const prompt = document.getElementById("chat-prompt");
const send_prompt = document.getElementById("send_prompt");
const add_to_doc = document.getElementById("add_to_doc");
const card_title_input = document.getElementById("card_title_input");
const attach_image = document.getElementById("attach_image");
const image_preview_container = document.getElementById("image-preview-container");

const buttons = {
    resetZoom: resetZoom,
    project_title_input: project_title_input,
    search_input: search_input,
    search_btn: search_btn,
    summary_btn: summary_btn,
    add_doc: add_doc,
    remove_doc: remove_doc,
    doc_title_input: doc_title_input,
    undo_btn: undo_btn,
    export_btn: export_btn,
    import_btn: import_btn,
    api_key_btn: api_key_btn,
    feedback_btn: feedback_btn,
    about_btn: about_btn,
    send_prompt: send_prompt,
    add_to_doc: add_to_doc,
    prompt: prompt,
    chat_content: chat_content,
    card_title_input: card_title_input,
    attach_image: attach_image,
    image_preview_container: image_preview_container
};

// main manager
class MainManager {
    constructor(network, log, chat, buttons) {
        this.network = network; // this is the network data structure
        this.log = log; // this is the log of events
        this.chat = chat; // this is the chat interface
        this.viz = null; // this will hold the network visualization instance
        this.buttons = buttons; // store button references
        this.ai_agent = null;
        this.modal = new Modal(); // custom modal for alerts and confirms
        this.promptEditor = null; // will hold the CodeMirror editor instance
        this.chatManager = null; // will hold the chat manager instance
        this.currentProject = null; // will hold the current project instance (root node)
        this.currentDoc = null; // will hold the current document instance
    }

    resetZoom() {
        this.viz.resetZoom();
        // Don't call zoomToFit - keeps graph naturally centered
    }

    async summary_btn() {
        if (!this.currentDoc) {
            await this.modal.alert("No document to summarize");
            return;
        }

        if (this.currentDoc.summaryGenerating) {
            await this.modal.alert("Summary is still being generated. Please wait...");
            return;
        }

        // Check if there was an error
        if (this.currentDoc.summaryError) {
            await this.modal.alert(`Summary generation failed: ${this.currentDoc.summaryError}\n\nTry adding another card to regenerate.`);
            return;
        }

        if (!this.currentDoc.summary) {
            await this.modal.alert("No summary available yet. Summary will be generated when you add cards to the document.");
            return;
        }

        // Show the summary in a modal with markdown rendering
        const summaryContainer = document.createElement('div');
        const renderedSummary = marked.parse(this.currentDoc.summary);
        summaryContainer.innerHTML = `
            <h4 style="margin-bottom: 15px;">Summary of "${this.currentDoc.title}"</h4>
            <div class="markdown-body" style="max-height: 400px; overflow-y: auto; padding: 10px; background: var(--strata-layer-01); border: 1px solid var(--strata-interactive);">
                ${renderedSummary}
            </div>
        `;

        await this.modal.custom(summaryContainer, [
            {
                text: 'Close',
                className: 'info_btn',
                callback: () => null
            }
        ]);
    }

    startSummaryAnimation() {
        // Add pulsing/flashing gradient animation to summary button
        if (this.buttons.summary_btn) {
            this.buttons.summary_btn.classList.remove('summary-error', 'summary-success');
            this.buttons.summary_btn.classList.add('summary-generating');
        }
    }

    summarySuccess() {
        // Remove generating animation, show success briefly
        if (this.buttons.summary_btn) {
            this.buttons.summary_btn.classList.remove('summary-generating');
            this.buttons.summary_btn.classList.add('summary-success');
            
            // Remove success state after 3 seconds and restore original styling
            setTimeout(() => {
                if (this.buttons.summary_btn) {
                    this.buttons.summary_btn.classList.remove('summary-success');
                    // Force a style reset to ensure proper color restoration
                    this.buttons.summary_btn.style.removeProperty('background');
                    this.buttons.summary_btn.style.removeProperty('color');
                }
            }, 3000);
        }
    }

    summaryError(errorMessage) {
        // Remove generating animation, show error state
        if (this.buttons.summary_btn) {
            this.buttons.summary_btn.classList.remove('summary-generating');
            this.buttons.summary_btn.classList.add('summary-error');
            
            // Show error notification
            this.modal.alert(`Summary generation failed: ${errorMessage}`);
            
            // Keep error state (will be cleared on next attempt)
        }
    }

    createNewProject(name) {
        // Create a new project with the given name
        const project = new Project(name);
        project.init();
        this.currentProject = project;
        console.log("Created new project:", project.id, "with name:", project.name);
        return project;
    }

    createNewDoc(title) {
        // Create a new document with the given title
        const doc = new Doc(title);
        doc.init();
        this.currentDoc = doc;
        
        // Add document to the current project
        if (this.currentProject) {
            this.currentProject.addDoc(doc);
            console.log("Created new document:", doc.id, "with title:", doc.title);
            console.log("Project now has", this.currentProject.getDocCount(), "document(s)");
            
            // Update the network visualization
            this.updateNetworkViz();
        }
        
        return doc;
    }

    updateNetworkViz() {
        // Update the network visualization with current project graph data
        if (this.currentProject && this.viz) {
            const graphData = this.currentProject.toGraphData();
            this.viz.updateData(graphData);
            console.log("Network viz updated:", graphData.nodes.length, "nodes,", graphData.links.length, "links");
        }
    }

    addDocButton() {
        // Create a new blank document (current doc is saved in project)
        // Clear the DOM
        doc_content.innerHTML = "";
        
        // Generate new random name that doesn't already exist
        let newDocName = generateRandomName();
        if (this.currentProject) {
            // Keep generating until we get a unique name
            while (this.currentProject.docTitleExists(newDocName)) {
                newDocName = generateRandomName();
            }
        }
        this.buttons.doc_title_input.value = newDocName;
        
        // Create new document
        this.createNewDoc(newDocName);
        
        // Update ChatManager's reference to the new document and clear chat
        if (this.chatManager) {
            this.chatManager.currentDoc = this.currentDoc;
            this.chatManager.clearChat();
        }
        
        console.log("New document created and ready");
    }

    async removeDocButton() {
        // Remove the current document and all its cards
        if (!this.currentDoc) {
            await this.modal.alert("No document to remove");
            return;
        }
        
        const cardCount = this.currentDoc.getCardCount();
        const message = cardCount > 0 
            ? `Remove "${this.currentDoc.title}" and its ${cardCount} card(s)?`
            : `Remove "${this.currentDoc.title}"?`;
        
        const confirmed = await this.modal.confirm(message);
        if (confirmed) {
            const docIdToRemove = this.currentDoc.id;
            
            // Remove from project
            if (this.currentProject) {
                this.currentProject.removeDoc(docIdToRemove);
                console.log("Removed doc from project. Remaining docs:", this.currentProject.getDocCount());
            }
            
            // Clear the DOM
            doc_content.innerHTML = "";
            
            // If there are other docs, switch to the first one
            if (this.currentProject && this.currentProject.getDocCount() > 0) {
                const firstDoc = this.currentProject.getAllDocs()[0];
                this.switchToDoc(firstDoc);
            } else {
                // No docs left, create a new one
                const newDocName = generateRandomName();
                this.buttons.doc_title_input.value = newDocName;
                this.createNewDoc(newDocName);
                
                // Update ChatManager's reference and clear chat
                if (this.chatManager) {
                    this.chatManager.currentDoc = this.currentDoc;
                    this.chatManager.clearChat();
                }
            }
            
            // Update the visualization
            this.updateNetworkViz();
        }
    }

    switchToDoc(doc) {
        // Switch the view to display a different document
        console.log("Switching to doc:", doc.title, "with", doc.getCardCount(), "cards");
        
        // Update current doc reference
        this.currentDoc = doc;
        
        // Update the doc title input
        this.buttons.doc_title_input.value = doc.title;
        
        // Clear and repopulate the doc content area
        doc_content.innerHTML = "";
        
        // Render all cards from this doc
        doc.getAllCards().forEach(card => {
            // Ensure card has the network update callback
            if (!card.updateNetworkCallback) {
                card.updateNetworkCallback = () => this.updateNetworkViz();
            }
            // Ensure card has the modal
            if (!card.modal) {
                card.modal = this.modal;
            }
            // Re-initialize the card's DOM element
            card.init();
            doc_content.appendChild(card.innerHTML);
        });
        
        // Update ChatManager's reference (but don't clear chat to preserve prompt)
        if (this.chatManager) {
            this.chatManager.currentDoc = this.currentDoc;
        }
        
        console.log("Switched to doc successfully");
    }

    handleNodeClick(nodeData) {
        // Handle clicks on nodes in the network visualization
        console.log("Node clicked:", nodeData);
        
        // If it's the root project node (type: "project"), zoom to fit
        if (nodeData.type === "project") {
            console.log("Clicked on project root, zooming to fit...");
            this.resetZoom();
            return;
        }
        
        // If it's a doc node, switch to that document
        if (nodeData.type === "doc" && nodeData.id) {
            const doc = this.currentProject.getDoc(nodeData.id);
            if (doc) {
                console.log("Switching to doc:", doc.title);
                this.switchToDoc(doc);
            } else {
                console.error("Doc not found:", nodeData.id);
            }
            return;
        }
        
        // If it's a card node, switch to the document containing that card
        if (nodeData.type === "card" && nodeData.id) {
            console.log("Card node clicked:", nodeData.name);
            
            // Find which document contains this card
            const allDocs = this.currentProject.getAllDocs();
            for (const doc of allDocs) {
                const card = doc.getCard(nodeData.id);
                if (card) {
                    console.log("Found card in doc:", doc.title, "- switching to it");
                    this.switchToDoc(doc);
                    
                    // Scroll to the card after switching
                    setTimeout(() => {
                        const cardElements = Array.from(doc_content.querySelectorAll('.card'));
                        const cardElement = cardElements.find(el => {
                            const cardId = el.querySelector('.card_details p').textContent;
                            return cardId === nodeData.id;
                        });
                        
                        if (cardElement) {
                            cardElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            cardElement.classList.add('card--flash');
                            setTimeout(() => cardElement.classList.remove('card--flash'), 500);
                        }
                    }, 100);
                    
                    return;
                }
            }
            
            console.warn("Card not found in any document:", nodeData.id);
        }
    }

    setupProjectTitleSanitization() {
        // Auto-sanitize project title on blur
        this.buttons.project_title_input.addEventListener('blur', () => {
            if (this.buttons.project_title_input.value.trim() !== "") {
                this.buttons.project_title_input.value = sanitizeTitle(this.buttons.project_title_input.value);
                // Update the current project name
                if (this.currentProject) {
                    this.currentProject.updateName(this.buttons.project_title_input.value);
                    // Update the network visualization to reflect the new name
                    this.updateNetworkViz();
                }
            }
        });
    }

    setupDocTitleSanitization() {
        // Auto-sanitize doc title on blur and ensure uniqueness
        this.buttons.doc_title_input.addEventListener('blur', () => {
            if (this.buttons.doc_title_input.value.trim() !== "") {
                let sanitized = sanitizeTitle(this.buttons.doc_title_input.value);
                
                // Update the current document title
                if (this.currentDoc && this.currentProject) {
                    // If the title is different from the current doc title, ensure it's unique
                    if (sanitized !== this.currentDoc.title) {
                        // User changed the title - make it unique by appending numbers if needed
                        sanitized = this.currentProject.getUniqueDocTitle(sanitized);
                    }
                    
                    this.buttons.doc_title_input.value = sanitized;
                    this.currentDoc.updateTitle(sanitized);
                    // Update the network visualization to reflect the new name
                    this.updateNetworkViz();
                }
            }
        });
    }

    getAgentForProvider(provider, openaiKey, geminiKey) {
        if (provider === 'gemini') {
            const agent = new GeminiAgent();
            if (geminiKey) agent.updateApiKey(geminiKey);
            return agent;
        }
        const agent = new OpenAIAgent();
        if (openaiKey) agent.updateApiKey(openaiKey);
        return agent;
    }

    async show_api_key_modal() {
        const currentOpenAI = localStorage.getItem('openai_api_key') || '';
        const currentGemini = localStorage.getItem('gemini_api_key') || '';
        const currentProvider = localStorage.getItem('ai_provider') || 'openai';
        const inputContainer = document.createElement('div');
        inputContainer.innerHTML = `
            <h4 style="margin-bottom: 12px;">AI provider & API keys</h4>
            <label style="display: block; margin-bottom: 4px; font-size: small;">Use model</label>
            <select id="ai_provider_select" style="width: 100%; padding: 8px; margin-bottom: 12px; background: var(--background); color: var(--primary-text); border: 1px solid var(--information-2);">
                <option value="openai" ${currentProvider === 'openai' ? 'selected' : ''}>OpenAI (GPT)</option>
                <option value="gemini" ${currentProvider === 'gemini' ? 'selected' : ''}>Gemini</option>
            </select>
            <label style="display: block; margin-bottom: 4px; font-size: small;">OpenAI API key</label>
            <input type="password" id="openai_api_key_input" placeholder="sk-..." 
                   style="width: 100%; padding: 8px; font-family: 'Courier New', monospace; font-size: small; background: var(--background); color: var(--primary-text); border: 1px solid var(--information-2); margin-bottom: 12px;" 
                   value="${currentOpenAI}">
            <label style="display: block; margin-bottom: 4px; font-size: small;">Gemini API key</label>
            <input type="password" id="gemini_api_key_input" placeholder="Gemini key (Google AI Studio)..." 
                   style="width: 100%; padding: 8px; font-family: 'Courier New', monospace; font-size: small; background: var(--background); color: var(--primary-text); border: 1px solid var(--information-2);" 
                   value="${currentGemini}">
            <p style="margin-top: 10px; font-size: x-small;">Keys are stored locally in your browser.</p>
        `;

        const result = await this.modal.custom(inputContainer, [
            {
                text: 'Cancel',
                className: 'alert_btn',
                callback: () => null
            },
            {
                text: 'Clear all',
                className: 'alert_btn',
                callback: () => {
                    localStorage.removeItem('openai_api_key');
                    localStorage.removeItem('gemini_api_key');
                    localStorage.setItem('ai_provider', 'openai');
                    this.ai_agent = new OpenAIAgent();
                    if (this.chatManager && this.chatManager.aiAgent) {
                        this.chatManager.aiAgent = this.ai_agent;
                    }
                    return 'cleared';
                }
            },
            {
                text: 'Save',
                className: 'success_btn',
                callback: () => {
                    const provider = document.getElementById('ai_provider_select').value;
                    const openaiKey = document.getElementById('openai_api_key_input').value.trim();
                    const geminiKey = document.getElementById('gemini_api_key_input').value.trim();
                    localStorage.setItem('ai_provider', provider);
                    if (openaiKey) localStorage.setItem('openai_api_key', openaiKey);
                    else localStorage.removeItem('openai_api_key');
                    if (geminiKey) localStorage.setItem('gemini_api_key', geminiKey);
                    else localStorage.removeItem('gemini_api_key');
                    this.ai_agent = this.getAgentForProvider(provider, openaiKey, geminiKey);
                    if (this.chatManager && this.chatManager.aiAgent) {
                        this.chatManager.aiAgent = this.ai_agent;
                    }
                    return 'saved';
                }
            }
        ]);

        if (result === 'saved') {
            await this.modal.alert("Settings saved. You can use AI with the selected model.");
        } else if (result === 'cleared') {
            await this.modal.alert("API keys cleared. Set a key and choose a model to use AI.");
        }
    }

    async showAboutModal() {
        // Show about modal with creator info and link
        const aboutContent = document.createElement('div');
        aboutContent.innerHTML = `
            <p style="margin-bottom: 15px;">
                Check out more of my work at 
                <a href="https://www.indrajeethaldar.com" target="_blank" 
                   style="color: var(--information-1); text-decoration: underline;">
                    www.indrajeethaldar.com
                </a>
            </p>
            <p style="margin-bottom: 0; font-size: x-small; line-height: 1.6; border-top: 1px solid var(--information-2); padding-top: 15px;">
                <a href="https://www.slate-notepad.com/">slate notebook editor</a> © 2025 by <a href="https://www.indrajeethaldar.com/">Indrajeet Haldar</a> is licensed under <a href="https://creativecommons.org/licenses/by-nc-nd/4.0/">CC BY-NC-ND 4.0</a><img src="https://mirrors.creativecommons.org/presskit/icons/cc.svg" alt="" style="max-width: 1em;max-height:1em;margin-left: .2em;"><img src="https://mirrors.creativecommons.org/presskit/icons/by.svg" alt="" style="max-width: 1em;max-height:1em;margin-left: .2em;"><img src="https://mirrors.creativecommons.org/presskit/icons/nc.svg" alt="" style="max-width: 1em;max-height:1em;margin-left: .2em;"><img src="https://mirrors.creativecommons.org/presskit/icons/nd.svg" alt="" style="max-width: 1em;max-height:1em;margin-left: .2em;">
            </p>
        `;

        await this.modal.custom(aboutContent, [
            {
                text: 'OK',
                className: 'info_btn',
                callback: () => null
            }
        ]);
    }

    exportProject() {
        // Export the entire project as JSON
        if (!this.currentProject) {
            this.modal.alert("No project to export");
            return;
        }

        try {
            const projectData = this.currentProject.toJSON();
            const jsonString = JSON.stringify(projectData, null, 2);
            
            // Create a blob and download it
            const blob = new Blob([jsonString], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${sanitizeTitle(this.currentProject.name)}_${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            console.log("Project exported successfully:", this.currentProject.name);
        } catch (err) {
            console.error("Export failed:", err);
            this.modal.alert("Export failed: " + err.message);
        }
    }

    async importProject() {
        // Import a project from JSON file
        const confirmed = await this.modal.confirm("Import project? Current project will be replaced.");
        if (!confirmed) {
            return;
        }

        // Create a file input element
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'application/json,.json';
        
        fileInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) {
                return;
            }

            try {
                const text = await file.text();
                const projectData = JSON.parse(text);
                
                // Create project from JSON
                const importedProject = Project.fromJSON(projectData);
                
                // Replace current project
                this.currentProject = importedProject;
                this.buttons.project_title_input.value = importedProject.name;
                
                // Update network visualization
                this.updateNetworkViz();
                
                // Load the first document if it exists
                if (importedProject.getDocCount() > 0) {
                    const firstDoc = importedProject.getAllDocs()[0];
                    this.switchToDoc(firstDoc);
                } else {
                    // No docs in imported project, create a new one
                    const newDocName = generateRandomName();
                    this.buttons.doc_title_input.value = newDocName;
                    this.createNewDoc(newDocName);
                }
                
                // Clear chat content, prompt, and images
                if (this.chatManager) {
                    this.chatManager.clearAll();
                }
                
                console.log("Project imported successfully:", importedProject.name);
                await this.modal.alert("Project imported successfully!");
            } catch (err) {
                console.error("Import failed:", err);
                await this.modal.alert("Import failed: " + err.message);
            }
        };
        
        // Trigger file picker
        fileInput.click();
    }

    async searchAndNavigate() {
        // Search for docs or cards by title and navigate to them
        const searchQuery = this.buttons.search_input.value.trim().toLowerCase();
        
        if (!searchQuery) {
            await this.modal.alert("Please enter a search term");
            return;
        }

        if (!this.currentProject) {
            await this.modal.alert("No project loaded");
            return;
        }

        console.log("Searching for:", searchQuery);

        // Search for exact doc title match first
        const allDocs = this.currentProject.getAllDocs();
        const docMatch = allDocs.find(doc => doc.title.toLowerCase() === searchQuery);
        
        if (docMatch) {
            console.log("Found doc:", docMatch.title);
            this.switchToDoc(docMatch);
            this.buttons.search_input.value = ""; // Clear search after navigation
            return;
        }

        // Search for exact card title match across all docs
        for (const doc of allDocs) {
            const cardMatch = doc.getAllCards().find(card => card.title.toLowerCase() === searchQuery);
            if (cardMatch) {
                console.log("Found card:", cardMatch.title, "in doc:", doc.title);
                // Switch to the doc containing the card
                this.switchToDoc(doc);
                
                // Scroll to the card and highlight it briefly
                setTimeout(() => {
                    const cardElement = Array.from(doc_content.querySelectorAll('.card')).find(el => {
                        const titleEl = el.querySelector('h4');
                        return titleEl && titleEl.textContent.toLowerCase() === searchQuery;
                    });
                    
                    if (cardElement) {
                        cardElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        cardElement.classList.add('card--flash');
                        setTimeout(() => cardElement.classList.remove('card--flash'), 500);
                    }
                }, 100);
                
                this.buttons.search_input.value = ""; // Clear search after navigation
                return;
            }
        }

        // No exact match found, try partial matches
        const docPartialMatch = allDocs.find(doc => doc.title.toLowerCase().includes(searchQuery));
        if (docPartialMatch) {
            console.log("Found partial doc match:", docPartialMatch.title);
            this.switchToDoc(docPartialMatch);
            this.buttons.search_input.value = ""; // Clear search after navigation
            return;
        }

        // Search for partial card match
        for (const doc of allDocs) {
            const cardPartialMatch = doc.getAllCards().find(card => 
                card.title.toLowerCase().includes(searchQuery)
            );
            if (cardPartialMatch) {
                console.log("Found partial card match:", cardPartialMatch.title, "in doc:", doc.title);
                this.switchToDoc(doc);
                this.buttons.search_input.value = ""; // Clear search after navigation
                return;
            }
        }

        // Nothing found
        await this.modal.alert(`No results found for "${searchQuery}"`);
    }


    mapButtons() {
        this.buttons.resetZoom.addEventListener("click", () => this.resetZoom());
        this.buttons.summary_btn.addEventListener("click", () => this.summary_btn());
        this.buttons.add_doc.addEventListener("click", () => this.addDocButton());
        this.buttons.remove_doc.addEventListener("click", () => this.removeDocButton());
        this.buttons.add_to_doc.addEventListener("click", () => this.chatManager.addToDoc());
        this.buttons.send_prompt.addEventListener("click", () => this.chatManager.askAI());
        this.buttons.api_key_btn.addEventListener("click", () => this.show_api_key_modal());
        this.buttons.about_btn.addEventListener("click", () => this.showAboutModal());
        this.buttons.feedback_btn.addEventListener("click", () => {
            window.open("https://forms.gle/BVk3YMzqoRELDy2C9", "_blank");
        });
        this.buttons.export_btn.addEventListener("click", () => this.exportProject());
        this.buttons.import_btn.addEventListener("click", () => this.importProject());
        this.buttons.search_btn.addEventListener("click", () => this.searchAndNavigate());
        
        // Also allow Enter key in search input
        this.buttons.search_input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                this.searchAndNavigate();
            }
        });
    }

    attachExistingCardListeners() {
        // Attach event listeners to any existing static cards in the DOM
        const existingCards = doc_content.querySelectorAll('.card');
        existingCards.forEach(cardElement => {
            const removeBtn = cardElement.querySelector('.alert_btn');
            if (removeBtn) {
                removeBtn.addEventListener('click', async () => {
                    const confirmed = await this.modal.confirm("Are you sure you want to remove this card?");
                    if (confirmed) {
                        cardElement.remove();
                    }
                });
            }
        });
    }

    setupContentResizers() {
        const content = document.getElementById("content");
        const chat = document.getElementById("chat");
        const doc = document.getElementById("doc");
        const network = document.getElementById("network");
        const resizerChatDoc = document.getElementById("resizer-chat-doc");
        const resizerDocNetwork = document.getElementById("resizer-doc-network");
        const MIN_PANEL = 180;

        function startResize(resizer, leftPanel, rightPanel) {
            let startX = 0;
            let startLeft = 0;
            let startRight = 0;

            function onMove(e) {
                const dx = e.clientX - startX;
                const contentRect = content.getBoundingClientRect();
                const total = contentRect.width;
                const resizerW = 8;
                const minLeft = MIN_PANEL;
                const minRight = MIN_PANEL;
                let newLeft = startLeft + dx;
                let newRight = startRight - dx;
                if (newLeft < minLeft) {
                    newLeft = minLeft;
                    newRight = startLeft + startRight - minLeft;
                } else if (newRight < minRight) {
                    newRight = minRight;
                    newLeft = startLeft + startRight - minRight;
                }
                leftPanel.style.flex = `0 0 ${newLeft}px`;
                rightPanel.style.flex = `0 0 ${newRight}px`;
                startX = e.clientX;
                startLeft = newLeft;
                startRight = newRight;
            }

            function onUp() {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
            }

            resizer.addEventListener("mousedown", (e) => {
                e.preventDefault();
                startX = e.clientX;
                startLeft = leftPanel.getBoundingClientRect().width;
                startRight = rightPanel.getBoundingClientRect().width;
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
                document.body.style.cursor = "col-resize";
                document.body.style.userSelect = "none";
            });
        }

        startResize(resizerChatDoc, chat, doc);
        startResize(resizerDocNetwork, doc, network);
    }

    setupNetworkResizeObserver() {
        const container = this.network;
        if (!container || !this.viz) return;
        const ro = new ResizeObserver(() => {
            const w = container.clientWidth;
            const h = container.clientHeight;
            if (w > 0 && h > 0) this.viz.resize(w, h);
        });
        ro.observe(container);
    }

    setupMobileTabs() {
        const tabs = document.getElementById("bottom-tabs");
        if (!tabs) return;
        const panels = { chat: document.getElementById("chat"), doc: document.getElementById("doc"), network: document.getElementById("network") };
        const tabButtons = tabs.querySelectorAll(".mobile-tab");

        function showPanel(panelId) {
            tabButtons.forEach((btn) => {
                const id = btn.getAttribute("data-panel");
                const isActive = id === panelId;
                btn.classList.toggle("active", isActive);
                btn.setAttribute("aria-pressed", isActive ? "true" : "false");
                if (panels[id]) {
                    panels[id].classList.toggle("mobile-active", isActive);
                }
            });
        }

        tabButtons.forEach((btn) => {
            btn.addEventListener("click", () => showPanel(btn.getAttribute("data-panel")));
        });

        if (window.matchMedia("(max-width: 768px)").matches) {
            showPanel("chat");
        }
    }

    async init() {
        // Create a new project (root node)
        const projectName = generateRandomName();
        this.createNewProject(projectName);
        this.buttons.project_title_input.value = projectName;
        
        // Initialize the network visualization with empty data first and click callback
        this.viz = new NetworkViz(
            "#network", 
            { nodes: [], links: [] }, 
            this.network.clientWidth, 
            this.network.clientHeight,
            (nodeData) => this.handleNodeClick(nodeData)
        );
        
        // Initialize the AI agent (OpenAI or Gemini based on saved preference)
        const provider = localStorage.getItem('ai_provider') || 'openai';
        const openaiKey = localStorage.getItem('openai_api_key') || "";
        const geminiKey = localStorage.getItem('gemini_api_key') || "";
        this.ai_agent = this.getAgentForProvider(provider, openaiKey, geminiKey);
        
        // Generate and set random doc name
        const docName = generateRandomName();
        this.buttons.doc_title_input.value = docName;
        
        // Create a new blank document (will be added to project and update viz)
        this.createNewDoc(docName);
        
        // Initialize CodeMirror editor for the prompt
        this.promptEditor = setupCodeMirrorEditor(
            this.buttons.prompt,
            () => this.currentDoc,
            () => this.currentProject
        );
        
        // Initialize the chat manager
        this.chatManager = new ChatManager(
            this.buttons.chat_content,
            this.promptEditor,
            this.buttons.card_title_input,
            doc_content,
            this.ai_agent,
            this.modal,
            this.currentDoc,
            () => this.updateNetworkViz() // callback to update network viz
        );
        
        // Setup image support for the chat manager
        this.chatManager.setupImageSupport(
            this.buttons.attach_image,
            this.buttons.image_preview_container
        );
        
        // map all the buttons
        this.mapButtons();
        // attach listeners to existing static cards
        this.attachExistingCardListeners();
        // setup project title sanitization
        this.setupProjectTitleSanitization();
        // setup doc title sanitization
        this.setupDocTitleSanitization();
        // set default chat message
        this.chatManager.setDefaultMessage();
        // resizable content panels
        this.setupContentResizers();
        this.setupNetworkResizeObserver();
        this.setupMobileTabs();

        window.addEventListener("resize", () => {
            if (window.matchMedia("(max-width: 768px)").matches) {
                const active = document.querySelector("#content .panel.mobile-active");
                if (!active) {
                    document.getElementById("chat").classList.add("mobile-active");
                    document.querySelector('.mobile-tab[data-panel="chat"]').classList.add("active");
                    document.querySelector('.mobile-tab[data-panel="chat"]').setAttribute("aria-pressed", "true");
                }
            }
        });
    }
}

// Initialize the main manager
const mainManager = new MainManager(network, doc_content, chat_content, buttons);
await mainManager.init();

// Expose mainManager globally for cross-component access (e.g., ChatManager accessing project)
window.mainManager = mainManager;
