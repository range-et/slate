import { v4 as uuidv4 } from 'uuid';
import Card, { CARD_KIND_HEADER, CARD_KIND_BODY, HEADER_CARD_TITLE, isValidCardKind } from './cards.js';

/**
 * Build the auto-created header card for a doc. Empty content; the user fills
 * it with module-scope setup (imports, constants, type aliases). Pinned at
 * index 0 by Doc.addCard, undeletable by Doc.removeCard. v0.2 §2.
 */
function buildHeaderCard() {
    const card = new Card(HEADER_CARD_TITLE, '', null, null, '', [], 'markdown', CARD_KIND_HEADER);
    card.id = uuidv4();
    return card;
}

/**
 * Strip a destination path to a safe, forward-slash relative path. Drops
 * `..` segments, leading/trailing slashes, and collapses internal whitespace.
 * Empty input → empty string (= "compile at workspace root").
 */
export function sanitizeDestination(raw) {
    if (raw === null || typeof raw === 'undefined') return '';
    return String(raw)
        .replace(/\\/g, '/')
        .split('/')
        .map(s => s.trim())
        .filter(seg => seg.length > 0 && seg !== '.' && seg !== '..')
        .join('/');
}

/**
 * Document class - represents a collection of cards with a title and unique ID
 */
class Doc {
    constructor(title) {
        this.title = title;
        this.id = null; // unique identifier
        this.cards = []; // array of card objects
        // (#51) The legacy AI-generated `summary` was removed — the doc's
        // header card (always at index 0) now serves as the canonical
        // overview. Cross-doc @-refs resolve to the header's content.
        this.createdAt = null; // timestamp when doc was created
        this.updatedAt = null; // timestamp when doc was last updated
        this.destination = ''; // relative folder path under workspace root for compiled .py output
    }

    /**
     * Update where this doc compiles to. Sanitizes to a forward-slash relative
     * path with no leading/trailing slashes and no `..` segments — both for
     * filesystem safety and so the compiler can derive a valid Python module
     * path from it.
     */
    updateDestination(rawPath) {
        const cleaned = sanitizeDestination(rawPath);
        this.destination = cleaned;
        this.updatedAt = new Date().toISOString();
        return cleaned;
    }

    /**
     * Initialize the document with a UUID, timestamps, and the auto-created
     * header card (v0.2 §2 — every doc has exactly one header card pinned at
     * index 0).
     */
    init() {
        this.id = uuidv4();
        this.createdAt = new Date().toISOString();
        this.updatedAt = new Date().toISOString();
        // Auto-create header card. addCard handles the index-0 pinning.
        this.addCard(buildHeaderCard());
    }

    /**
     * Add a card to the document.
     *
     * Header cards (kind: 'header') are pinned to index 0 and a doc may have
     * at most one. Non-header cards are appended after the header (or at end
     * if no header exists yet — only happens during deserialization).
     *
     * @param {Card} card - The card to add
     * @returns {boolean} - True on success, false on rejection (duplicate id,
     *                      second header, or non-Card argument)
     */
    addCard(card) {
        if (!(card instanceof Card)) {
            console.error("Can only add Card instances to a document");
            return false;
        }

        // Check if card already exists in this document (prevent duplicates)
        const existingCard = this.cards.find(c => c.id === card.id);
        if (existingCard) {
            console.warn(`Card ${card.id} already exists in document ${this.title}, skipping add`);
            return false;
        }

        // v0.2 §2 — at most one header card per doc.
        if (card.isHeader && card.isHeader()) {
            const existingHeader = this.cards.find(c => c.isHeader && c.isHeader());
            if (existingHeader) {
                console.warn(`Doc ${this.title} already has a header card; refusing to add another.`);
                return false;
            }
            // Pin to index 0.
            this.cards.unshift(card);
        } else {
            this.cards.push(card);
        }

        card.parent = this; // Set parent reference
        this.updatedAt = new Date().toISOString();
        return true;
    }

    /**
     * Remove a card from the document by its ID. Header cards (kind: 'header')
     * are undeletable per v0.2 §2 — the call returns false and logs a warning.
     *
     * @param {string} cardId - The UUID of the card to remove
     * @returns {boolean} - True if card was found and removed, false otherwise
     */
    removeCard(cardId) {
        const index = this.cards.findIndex(card => card.id === cardId);
        if (index === -1) return false;

        const target = this.cards[index];
        if (target.isHeader && target.isHeader()) {
            console.warn(`Refusing to remove header card from doc "${this.title}" (header cards are pinned per v0.2 §2).`);
            return false;
        }

        this.cards.splice(index, 1);
        this.updatedAt = new Date().toISOString();
        return true;
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
     * Flatten every non-header card's content into one plain-text blob,
     * suitable as input for an AI summarizer. Header is excluded because
     * it's the destination of the resulting summary
     * (`summarize_header` applet writes back into the header card).
     *
     * Card content can be raw markdown OR rendered HTML depending on
     * cardType, so we route everything through a throwaway div to strip
     * tags. Returns '' if there are no body cards yet.
     */
    getFlattenedContent() {
        const tmp = document.createElement('div');
        return this.cards
            .filter(card => !(card.isHeader && card.isHeader()))
            .map(card => {
                tmp.innerHTML = card.content || '';
                const plain = (tmp.innerText || tmp.textContent || '').trim();
                return `[${card.title}]\n${plain}`;
            })
            .join('\n\n');
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
     * Serialize the document to JSON. (#51) The legacy `summary` field is
     * no longer written; the header card carries the doc's overview now.
     * Older files with `summary` set still load — fromJSON drops the field.
     */
    toJSON() {
        return {
            id: this.id,
            title: this.title,
            destination: this.destination || '',
            cards: this.cards.map(card => ({
                id: card.id,
                title: card.title,
                content: card.content,
                prompt: card.prompt || "",
                images: card.images || [],
                links: card.links,
                cardType: card.cardType || 'markdown',
                kind: card.kind || CARD_KIND_BODY
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
        // Self-heal IDs the same way Project.fromJSON does — see comment there.
        doc.id = jsonData.id || uuidv4();
        // (#51) jsonData.summary is silently dropped — the header card is
        // the doc's overview now.
        doc.destination = sanitizeDestination(jsonData.destination || '');
        doc.createdAt = jsonData.createdAt;
        doc.updatedAt = jsonData.updatedAt;

        if (jsonData.cards && Array.isArray(jsonData.cards)) {
            jsonData.cards.forEach(cardData => {
                const kind = isValidCardKind(cardData.kind) ? cardData.kind : CARD_KIND_BODY;
                const card = new Card(
                    cardData.title,
                    cardData.content,
                    null,
                    null,
                    cardData.prompt || "",
                    cardData.images || [],
                    cardData.cardType || 'markdown',
                    kind
                );
                card.id = cardData.id || uuidv4();
                card.links = cardData.links || [];
                card.parent = doc;
                doc.cards.push(card);
            });
        }

        // v0.2 §2 — legacy projects predate header cards. If this doc has no
        // header, synthesize an empty one and pin it at index 0. The synthesized
        // header has a fresh UUID and will persist on the next save.
        const hasHeader = doc.cards.some(c => c.isHeader && c.isHeader());
        if (!hasHeader) {
            const header = buildHeaderCard();
            header.parent = doc;
            doc.cards.unshift(header);
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

