import { v4 as uuidv4 } from 'uuid';
import { marked } from 'marked';
import Modal from './modal.js';

// Configure marked for better rendering
marked.setOptions({
    breaks: true,        // Convert \n to <br>
    gfm: true,          // GitHub Flavored Markdown
    headerIds: false,   // Don't add IDs to headers
    mangle: false       // Don't escape email addresses
});

class Card {
    constructor(title, content, modal = null, updateNetworkCallback = null, prompt = "") {
        this.title = title;
        this.content = content;
        this.prompt = prompt; // the original prompt that created this card
        this.id = null; // unique identifier
        this.links = []; // array of linked card titles (extracted from prompt)
        this.parent = null; // reference to the parent doc
        this.innerHTML = null;
        this.modal = modal || new Modal(); // use provided modal or create new one
        this.updateNetworkCallback = updateNetworkCallback; // callback to update network viz
    }

    create() {
        const cardElement = document.createElement("div");
        cardElement.classList.add("card");
        
        // Render markdown content (AI response)
        const renderedContent = marked.parse(this.content);
        
        // Build prompt section with highlighted @references
        let promptHTML = '';
        if (this.prompt && this.prompt.trim() !== '') {
            // Highlight @references in the prompt
            let highlightedPrompt = this.prompt;
            
            // Find all @references and make them clickable spans
            highlightedPrompt = highlightedPrompt.replace(/@([\w]+)/g, (match, cardTitle) => {
                return `<span class="card-link-inline" data-link="${cardTitle}">@${cardTitle}</span>`;
            });
            
            promptHTML = `
                <div class="card-prompt-section">
                    <span class="card-prompt-label">Prompt:</span>
                    <div class="card-prompt-text">${highlightedPrompt}</div>
                </div>
            `;
        }
        
        cardElement.innerHTML = `
            <div class="card_header">
                <div class="card_actions" style="justify-content: flex-end;">
                    <button class="alert_btn">x</button>
                </div>
                <br>
                <div class="card_details">
                    <h4>${this.title}</h4>
                    <p class="">${this.id}</p>
                </div>
            </div>
            ${promptHTML}
            <div class="card-content markdown-body">${renderedContent}</div>`;
        return cardElement;
    }

    async remove() {
        // Remove the card from the DOM and from parent doc
        const confirmed = await this.modal.confirm("Are you sure you want to remove this card?");
        if (confirmed) {
            // Remove from DOM
            if (this.innerHTML && this.innerHTML.parentNode) {
                this.innerHTML.remove();
            }
            
            // Remove from parent doc
            if (this.parent && this.id) {
                this.parent.removeCard(this.id);
                console.log("Card removed from doc:", this.id);
            }
            
            // Update the network visualization
            if (this.updateNetworkCallback) {
                this.updateNetworkCallback();
            }
        }
    }

    init(){
        // Only generate ID if it doesn't exist (for new cards)
        if (!this.id) {
            this.id = uuidv4();
        }
        
        // Create/recreate the DOM element
        this.innerHTML = this.create();
        
        // Attach event listener to the remove button
        const removeBtn = this.innerHTML.querySelector('.alert_btn');
        if (removeBtn) {
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.remove();
            });
        }
        
        // Attach click handlers to all @reference links in the prompt
        const linkElements = this.innerHTML.querySelectorAll('.card-link-inline');
        linkElements.forEach(linkEl => {
            linkEl.addEventListener('click', (e) => {
                e.stopPropagation();
                const linkedCardTitle = linkEl.getAttribute('data-link');
                this.navigateToCard(linkedCardTitle);
            });
        });
    }
    
    navigateToCard(cardTitle) {
        // Navigate to a referenced card by finding it and switching to its document
        console.log("Navigating to card:", cardTitle);
        
        // Access the main manager through the global window object
        if (!window.mainManager) {
            console.error("MainManager not found");
            return;
        }
        
        const project = window.mainManager.currentProject;
        if (!project) {
            console.error("No current project");
            return;
        }
        
        // Search for the card across all documents
        const allDocs = project.getAllDocs();
        for (const doc of allDocs) {
            const targetCard = doc.getAllCards().find(c => c.title === cardTitle);
            if (targetCard) {
                console.log("Found card in doc:", doc.title);
                
                // Switch to the document
                window.mainManager.switchToDoc(doc);
                
                // Scroll to the card after switching
                setTimeout(() => {
                    const docContent = document.getElementById('doc-content');
                    const cardElements = Array.from(docContent.querySelectorAll('.card'));
                    const cardElement = cardElements.find(el => {
                        const titleEl = el.querySelector('.card_details h4');
                        return titleEl && titleEl.textContent === cardTitle;
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
                
                return;
            }
        }
        
        console.warn("Card not found:", cardTitle);
        if (this.modal) {
            this.modal.alert(`Card "@${cardTitle}" not found`);
        }
    }
}

export default Card;