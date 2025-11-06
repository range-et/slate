import { NetworkViz } from "./network_viz.js";
import OpenAIAgent from "./ai_utils.js";
import Card from "./cards.js";
import Doc from "./doc.js";
import Project from "./project.js";
import Modal from "./modal.js";
import ChatManager, { sanitizeTitle } from "./ai_chat.js";
import generateRandomName from "./random_name_generator.js";
import { setupCodeMirrorEditor } from "./codemirror_setup.js";
// dummy data
import data from "./dummy_data.js";

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
// chat stuff
const chat_content = document.getElementById("chat-content");
const prompt = document.getElementById("chat-prompt");
const send_prompt = document.getElementById("send_prompt");
const add_to_doc = document.getElementById("add_to_doc");
const card_title_input = document.getElementById("card_title_input");

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
    send_prompt: send_prompt,
    add_to_doc: add_to_doc,
    prompt: prompt,
    chat_content: chat_content,
    card_title_input: card_title_input
};

// main manager
class MainManager {
    constructor(network, log, chat, data, buttons) {
        this.network = network; // this is the network data structure
        this.log = log; // this is the log of events
        this.chat = chat; // this is the chat interface
        this.viz = null; // this will hold the network visualization instance
        this.buttons = buttons; // store button references
        this.data = data; // store data
        this.ai_agent = null;
        this.modal = new Modal(); // custom modal for alerts and confirms
        this.promptEditor = null; // will hold the CodeMirror editor instance
        this.chatManager = null; // will hold the chat manager instance
        this.currentProject = null; // will hold the current project instance (root node)
        this.currentDoc = null; // will hold the current document instance
    }

    resetZoom() {
        this.viz.resetZoom();
        this.viz.zoomToFit();
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

        // Show the summary in a modal
        const summaryContainer = document.createElement('div');
        summaryContainer.innerHTML = `
            <h4 style="margin-bottom: 15px;">Summary of "${this.currentDoc.title}"</h4>
            <div style="max-height: 400px; overflow-y: auto; padding: 10px; background: var(--background); border: 1px solid var(--information-2); border-radius: 4px; line-height: 1.6;">
                ${this.currentDoc.summary}
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
            
            // Remove success state after 3 seconds
            setTimeout(() => {
                if (this.buttons.summary_btn) {
                    this.buttons.summary_btn.classList.remove('summary-success');
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
            // Ensure card has the click callback for @referencing
            if (!card.onCardClick && this.chatManager) {
                card.onCardClick = (title) => this.chatManager.insertAtCursor(`@${title} `);
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
        
        // If it's a card node, we could potentially scroll to it or highlight it
        if (nodeData.type === "card") {
            console.log("Card node clicked:", nodeData.name);
            // For now, just log it. Could add scroll-to-card functionality later
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

    async show_api_key_modal() {
        // Create a custom modal with an input field for API key
        const currentKey = localStorage.getItem('openai_api_key');
        const inputContainer = document.createElement('div');
        inputContainer.innerHTML = `
            <h4 style="margin-bottom: 15px;">OpenAI API Key</h4>
            <input type="password" id="api_key_input" placeholder="sk-..." 
                   style="width: 100%; padding: 8px; font-family: 'Courier New', monospace; font-size: small; background: var(--background); color: var(--primary-text); border: 1px solid var(--information-2);" 
                   value="${currentKey || ''}">
            <p style="margin-top: 10px; font-size: x-small;">Your API key will be stored locally in your browser.</p>
        `;

        await this.modal.custom(inputContainer, [
            {
                text: 'Cancel',
                className: 'alert_btn',
                callback: () => null
            },
            {
                text: 'Clear',
                className: 'alert_btn',
                callback: () => {
                    localStorage.removeItem('openai_api_key');
                    return 'cleared';
                }
            },
            {
                text: 'Save',
                className: 'success_btn',
                callback: () => {
                    const apiKeyInput = document.getElementById('api_key_input');
                    const apiKey = apiKeyInput.value.trim();
                    if (apiKey) {
                        localStorage.setItem('openai_api_key', apiKey);
                        // Reinitialize the AI agent with the new key
                        this.ai_agent = new OpenAIAgent();
                        return 'saved';
                    }
                    return 'empty';
                }
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
                        // Brief highlight animation
                        cardElement.style.transition = 'background-color 0.3s';
                        const originalBg = cardElement.style.backgroundColor;
                        cardElement.style.backgroundColor = 'rgba(0, 188, 212, 0.2)';
                        setTimeout(() => {
                            cardElement.style.backgroundColor = originalBg;
                        }, 1000);
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
        
        // Initialize the AI agent
        this.ai_agent = new OpenAIAgent();
        
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
    }
}

// Initialize the main manager
const mainManager = new MainManager(network, doc_content, chat_content, data, buttons);
await mainManager.init();

// Expose mainManager globally for cross-component access (e.g., ChatManager accessing project)
window.mainManager = mainManager;
