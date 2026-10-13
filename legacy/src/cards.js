import { v4 as uuidv4 } from 'uuid';
import Modal from './modal.js';
import { renderCard } from './applets/card_view/index.js';

// (Phase C-b, #45) Marked + the per-kind highlight pipeline now live
// inside src/applets/card_view/. cards.js is the model + the controller-
// side wiring (init / remove / move / navigate); render is fully owned
// by the card_view applet and delegated through `create()` below.

export const CARD_TYPE_MARKDOWN = 'markdown';
export const CARD_TYPE_CODE = 'code';

// v0.2 §2 — card kinds. Independent of cardType/language: a card has both
// a kind ('header' | 'body' | 'class') and a cardType/language. Default 'body'.
// Header cards are pinned to index 0, undeletable, and hold module-scope setup
// (imports, constants, type aliases).
export const CARD_KIND_HEADER = 'header';
export const CARD_KIND_BODY = 'body';
export const CARD_KIND_CLASS = 'class';     // wired in phase 5; accepted in serde now for forward-compat

// Reserved title for the auto-created header card. Not user-renameable.
export const HEADER_CARD_TITLE = '__header__';

export function isValidCardKind(kind) {
    return kind === CARD_KIND_HEADER || kind === CARD_KIND_BODY || kind === CARD_KIND_CLASS;
}

export function stripPythonFences(text) {
    if (!text) return "";
    // Local code models (Qwen, Llama, etc.) often ignore "no fences" in the
    // system prompt and return:
    //   <prose intro>
    //   ```python
    //   <the actual code we want>
    //   ```
    //   <prose explanation, bullet points, more fenced examples>
    //
    // Strategy: collect ALL fenced blocks. If any are explicitly tagged
    // python/py, prefer those (concatenated in order). Otherwise fall back
    // to all fenced blocks. If there are no fences at all, the response is
    // already raw — return it untouched. This is much more aggressive than
    // the old "first fenced block" extractor, which silently kept the
    // surrounding prose any time the model added an outer header line.
    const fenceRe = /```([a-zA-Z0-9_+-]*)\s*\n([\s\S]*?)```/g;
    const blocks = [];
    let m;
    while ((m = fenceRe.exec(text)) !== null) {
        blocks.push({ lang: (m[1] || '').toLowerCase(), body: m[2] });
    }
    if (blocks.length === 0) return text;
    // Prefer the FIRST python-tagged block (that's the answer); usage /
    // example blocks come after. If nothing is tagged python, take the first
    // block. Multi-block selection caused us to glue example code onto the
    // real function body — see #fence-stripping bug from the walkthrough.
    const firstPy = blocks.find(b => b.lang === 'python' || b.lang === 'py');
    const chosen = firstPy || blocks[0];
    return chosen.body.trimEnd();
}

export function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

class Card {
    constructor(title, content, modal = null, updateNetworkCallback = null, prompt = "", images = [], cardType = CARD_TYPE_MARKDOWN, kind = CARD_KIND_BODY) {
        this.title = title;
        this.content = content;
        this.prompt = prompt; // the original prompt that created this card
        this.images = images; // array of image objects {data: base64, mimeType: string, name: string}
        this.cardType = cardType === CARD_TYPE_CODE ? CARD_TYPE_CODE : CARD_TYPE_MARKDOWN;
        this.kind = isValidCardKind(kind) ? kind : CARD_KIND_BODY; // v0.2 §2 — header | body | class
        this.id = null; // unique identifier
        this.links = []; // array of linked card titles (extracted from prompt)
        this.parent = null; // reference to the parent doc
        this.innerHTML = null;
        this.modal = modal || new Modal(); // use provided modal or create new one
        this.updateNetworkCallback = updateNetworkCallback; // callback to update network viz
    }

    /**
     * v0.2 §2 — true if this is the doc's pinned header card. Header cards
     * cannot be removed, moved between docs, or have their position changed.
     */
    isHeader() {
        return this.kind === CARD_KIND_HEADER;
    }

    /**
     * For code cards, return the raw Python source with markdown fences stripped.
     * For markdown cards, returns null. Local models often ignore "no fences"
     * instructions, so this strips defensively.
     */
    getPythonSource() {
        if (this.cardType !== CARD_TYPE_CODE) return null;
        const raw = this.content || "";
        // Prefer plaintext if content was stored as HTML (innerText path).
        // Pure-node CLI / scripts (e.g. scripts/slate_roundtrip.js) won't
        // have a `document` global; in that case `content` is already
        // plain text from the JSON, so skip the HTML-strip step.
        let plain = raw;
        if (typeof document !== 'undefined') {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = raw;
            plain = tempDiv.innerText || tempDiv.textContent || raw;
        }
        return stripPythonFences(plain).trim();
    }

    /**
     * Build the DOM element for this card. Pure render — caller (init)
     * attaches event handlers afterwards. Implementation lives in the
     * card_view applet (src/applets/card_view/), one file per render kind
     * (header / code / markdown / class).
     */
    create() {
        return renderCard(this);
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
        
        // Attach event listener to the move button
        const moveBtn = this.innerHTML.querySelector('.card-move-btn');
        if (moveBtn) {
            moveBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.moveToAnotherDoc();
            });
        }

        // Edit button: pushes the card's prompt + response back into the
        // edit zone so the user can tweak and save in place.
        const editBtn = this.innerHTML.querySelector('.card-edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.loadIntoEditor();
            });
        }
        // Right-click anywhere on the card also enters edit mode (since
        // left-click on @-references is reserved for navigation).
        this.innerHTML.addEventListener('contextmenu', (e) => {
            // Don't hijack right-click on the inline @-reference links.
            if (e.target.closest('.card-link-inline')) return;
            e.preventDefault();
            this.loadIntoEditor();
        });

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
    
    /**
     * Forward to the active ChatManager so it can hydrate the prompt + response
     * panes from this card, ready for in-place edits.
     */
    loadIntoEditor() {
        const cm = window.mainManager?.chatManager;
        if (!cm || typeof cm.loadCardForEdit !== 'function') return;
        cm.loadCardForEdit(this);
    }

    async moveToAnotherDoc() {
        // Move this card to a different document
        if (!window.mainManager) {
            console.error("MainManager not found");
            return;
        }
        
        const project = window.mainManager.currentProject;
        if (!project) {
            console.error("No current project");
            return;
        }
        
        const allDocs = project.getAllDocs();
        
        // Filter out the current document
        const otherDocs = allDocs.filter(doc => doc !== this.parent);
        
        if (otherDocs.length === 0) {
            if (this.modal) {
                await this.modal.alert("No other documents available. Create a new document first.");
            }
            return;
        }
        
        // Create a selection list for the user
        const docTitles = otherDocs.map(doc => doc.title);
        const selection = await this.modal.select("Move card to which document?", docTitles);
        
        if (selection === null) {
            return; // User cancelled
        }
        
        const targetDoc = otherDocs[selection];
        const sourceDoc = this.parent; // Store reference before changing
        const sourceDocTitle = sourceDoc ? sourceDoc.title : 'unknown';
        const isTargetDocCurrentlyViewed = (targetDoc === window.mainManager.currentDoc);
        
        // Remove card from current document's data
        if (sourceDoc) {
            sourceDoc.removeCard(this.id);
            console.log(`Removed card from ${sourceDoc.title}, now has ${sourceDoc.getCardCount()} cards`);
        }
        
        // Remove from DOM
        if (this.innerHTML && this.innerHTML.parentNode) {
            this.innerHTML.remove();
        }
        
        // Clear parent reference before adding to new doc
        this.parent = null;
        
        // Add to target document's data (addCard will set parent)
        targetDoc.addCard(this);
        console.log(`Added card to ${targetDoc.title}, now has ${targetDoc.getCardCount()} cards`);
        
        // If the target document is currently being viewed, add the card to the DOM
        if (isTargetDocCurrentlyViewed) {
            // Re-initialize the card to create fresh DOM element
            this.init();
            // Add to the DOM
            const docContent = document.getElementById('doc-content');
            if (docContent) {
                docContent.appendChild(this.innerHTML);
            }
        }
        
        // Force update the network visualization by regenerating from current project state
        if (window.mainManager && window.mainManager.updateNetworkViz) {
            window.mainManager.updateNetworkViz();
        }
        
        console.log(`Card "${this.title}" moved from "${sourceDocTitle}" to "${targetDoc.title}"`);
        
        // Show success message
        if (this.modal) {
            await this.modal.alert(`Card moved to "${targetDoc.title}"`);
        }
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
                        cardElement.classList.add('card--flash');
                        setTimeout(() => cardElement.classList.remove('card--flash'), 500);
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