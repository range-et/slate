import { v4 as uuidv4 } from 'uuid';
import Card from './cards.js';

/**
 * Document class - represents a collection of cards with a title and unique ID
 */
class Doc {
    constructor(title) {
        this.title = title;
        this.id = null; // unique identifier
        this.cards = []; // array of card objects
        this.summary = null; // AI-generated summary of all cards
        this.summaryGenerating = false; // flag to track if summary is being generated
        this.summaryError = null; // stores error message if summary generation fails
        this.createdAt = null; // timestamp when doc was created
        this.updatedAt = null; // timestamp when doc was last updated
    }

    /**
     * Initialize the document with a UUID and timestamps
     */
    init() {
        this.id = uuidv4();
        this.createdAt = new Date().toISOString();
        this.updatedAt = new Date().toISOString();
    }

    /**
     * Add a card to the document
     * @param {Card} card - The card to add
     */
    addCard(card) {
        if (card instanceof Card) {
            // Check if card already exists in this document (prevent duplicates)
            const existingCard = this.cards.find(c => c.id === card.id);
            if (existingCard) {
                console.warn(`Card ${card.id} already exists in document ${this.title}, skipping add`);
                return;
            }
            
            this.cards.push(card);
            card.parent = this; // Set parent reference
            this.updatedAt = new Date().toISOString();
        } else {
            console.error("Can only add Card instances to a document");
        }
    }

    /**
     * Remove a card from the document by its ID
     * @param {string} cardId - The UUID of the card to remove
     * @returns {boolean} - True if card was found and removed, false otherwise
     */
    removeCard(cardId) {
        const index = this.cards.findIndex(card => card.id === cardId);
        if (index !== -1) {
            this.cards.splice(index, 1);
            this.updatedAt = new Date().toISOString();
            return true;
        }
        return false;
    }

    /**
     * Get a card by its ID
     * @param {string} cardId - The UUID of the card to find
     * @returns {Card|null} - The card if found, null otherwise
     */
    getCard(cardId) {
        return this.cards.find(card => card.id === cardId) || null;
    }

    /**
     * Get all cards in the document
     * @returns {Array<Card>} - Array of all cards
     */
    getAllCards() {
        return this.cards;
    }

    /**
     * Get the number of cards in the document
     * @returns {number} - The number of cards
     */
    getCardCount() {
        return this.cards.length;
    }

    /**
     * Check if a card title already exists in the document
     * @param {string} title - The title to check
     * @returns {boolean} - True if title exists, false otherwise
     */
    cardTitleExists(title) {
        return this.cards.some(card => card.title === title);
    }

    /**
     * Get a unique card title by appending numbers if needed
     * @param {string} title - The desired title
     * @returns {string} - A unique title (may have _1, _2, etc. appended)
     */
    getUniqueCardTitle(title) {
        if (!this.cardTitleExists(title)) {
            return title;
        }
        
        let counter = 1;
        let uniqueTitle = `${title}_${counter}`;
        while (this.cardTitleExists(uniqueTitle)) {
            counter++;
            uniqueTitle = `${title}_${counter}`;
        }
        return uniqueTitle;
    }

    /**
     * Update the document title
     * @param {string} newTitle - The new title
     */
    updateTitle(newTitle) {
        this.title = newTitle;
        this.updatedAt = new Date().toISOString();
    }

    /**
     * Get flattened content of all cards for summarization
     * @returns {string} - All card content as plain text
     */
    getFlattenedContent() {
        return this.cards.map(card => {
            // Extract plain text from HTML content
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = card.content;
            const plainText = tempDiv.innerText || tempDiv.textContent;
            return `[${card.title}]\n${plainText}`;
        }).join('\n\n');
    }

    /**
     * Update the document summary
     * @param {string} summary - The AI-generated summary
     */
    updateSummary(summary) {
        this.summary = summary;
        this.summaryGenerating = false;
        this.updatedAt = new Date().toISOString();
    }

    /**
     * Serialize the document to JSON
     * @returns {object} - JSON representation of the document
     */
    toJSON() {
        return {
            id: this.id,
            title: this.title,
            summary: this.summary,
            cards: this.cards.map(card => ({
                id: card.id,
                title: card.title,
                content: card.content,
                prompt: card.prompt || "",
                images: card.images || [],
                links: card.links,
                cardType: card.cardType || 'markdown'
            })),
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            cardCount: this.cards.length
        };
    }

    /**
     * Create a document from JSON data
     * @param {object} jsonData - The JSON data to restore from
     * @returns {Doc} - A new Doc instance with the restored data
     */
    static fromJSON(jsonData) {
        const doc = new Doc(jsonData.title);
        doc.id = jsonData.id;
        doc.summary = jsonData.summary || null;
        doc.createdAt = jsonData.createdAt;
        doc.updatedAt = jsonData.updatedAt;
        
        // Restore cards (Note: this creates new Card instances without DOM elements)
        if (jsonData.cards && Array.isArray(jsonData.cards)) {
            jsonData.cards.forEach(cardData => {
                const card = new Card(
                    cardData.title,
                    cardData.content,
                    null,
                    null,
                    cardData.prompt || "",
                    cardData.images || [],
                    cardData.cardType || 'markdown'  // backward-compat default
                );
                card.id = cardData.id;
                card.links = cardData.links || [];
                doc.cards.push(card);
            });
        }
        
        return doc;
    }

    /**
     * Clear all cards from the document
     */
    clearCards() {
        this.cards = [];
        this.updatedAt = new Date().toISOString();
    }
}

export default Doc;

