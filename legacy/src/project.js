import { v4 as uuidv4 } from 'uuid';
import Doc from './doc.js';

/**
 * Project class - represents the root node containing all documents
 */
class Project {
    constructor(name) {
        this.name = name;
        this.id = null; // unique identifier
        this.docs = []; // array of document objects
        this.createdAt = null; // timestamp when project was created
        this.updatedAt = null; // timestamp when project was last updated
    }

    /**
     * Initialize the project with a UUID and timestamps
     */
    init() {
        this.id = uuidv4();
        this.createdAt = new Date().toISOString();
        this.updatedAt = new Date().toISOString();
    }

    /**
     * Add a document to the project
     * @param {Doc} doc - The document to add
     */
    addDoc(doc) {
        if (doc instanceof Doc) {
            this.docs.push(doc);
            this.updatedAt = new Date().toISOString();
        } else {
            console.error("Can only add Doc instances to a project");
        }
    }

    /**
     * Remove a document from the project by its ID
     * @param {string} docId - The UUID of the document to remove
     * @returns {boolean} - True if doc was found and removed, false otherwise
     */
    removeDoc(docId) {
        const index = this.docs.findIndex(doc => doc.id === docId);
        if (index !== -1) {
            this.docs.splice(index, 1);
            this.updatedAt = new Date().toISOString();
            return true;
        }
        return false;
    }

    /**
     * Get a document by its ID
     * @param {string} docId - The UUID of the document to find
     * @returns {Doc|null} - The document if found, null otherwise
     */
    getDoc(docId) {
        return this.docs.find(doc => doc.id === docId) || null;
    }

    /**
     * Get all documents in the project
     * @returns {Array<Doc>} - Array of all documents
     */
    getAllDocs() {
        return this.docs;
    }

    /**
     * Get the number of documents in the project
     * @returns {number} - The number of documents
     */
    getDocCount() {
        return this.docs.length;
    }

    /**
     * Check if a document title already exists in the project
     * @param {string} title - The title to check
     * @returns {boolean} - True if title exists, false otherwise
     */
    docTitleExists(title) {
        return this.docs.some(doc => doc.title === title);
    }

    /**
     * Get a unique document title by appending numbers if needed
     * @param {string} title - The desired title
     * @returns {string} - A unique title (may have _1, _2, etc. appended)
     */
    getUniqueDocTitle(title) {
        if (!this.docTitleExists(title)) {
            return title;
        }
        
        let counter = 1;
        let uniqueTitle = `${title}_${counter}`;
        while (this.docTitleExists(uniqueTitle)) {
            counter++;
            uniqueTitle = `${title}_${counter}`;
        }
        return uniqueTitle;
    }

    /**
     * Get the total number of cards across all documents
     * @returns {number} - The total number of cards
     */
    getTotalCardCount() {
        return this.docs.reduce((total, doc) => total + doc.getCardCount(), 0);
    }

    /**
     * Update the project name
     * @param {string} newName - The new name
     */
    updateName(newName) {
        this.name = newName;
        this.updatedAt = new Date().toISOString();
    }

    /**
     * Generate graph data structure for network visualization
     * @returns {object} - Object with nodes and links arrays for D3
     */
    toGraphData() {
        const nodes = [];
        const links = [];

        // Add project as root node
        nodes.push({
            id: this.id,
            name: this.name,
            type: 'project',
            parent: null
        });

        // Add all documents as children of project
        this.docs.forEach(doc => {
            nodes.push({
                id: doc.id,
                name: doc.title,
                type: 'doc',
                parent: this.id
            });

            // Link project to document (hierarchy edge)
            links.push({
                source: this.id,
                target: doc.id,
                type: 'hierarchy'
            });

            // Add all cards as children of their document
            doc.getAllCards().forEach(card => {
                nodes.push({
                    id: card.id,
                    name: card.title,
                    type: 'card',
                    parent: doc.id
                });

                // Link document to card (hierarchy edge)
                links.push({
                    source: doc.id,
                    target: card.id,
                    type: 'hierarchy'
                });
            });
        });

        // Add card-to-card reference links (directed graph edges)
        this.docs.forEach(doc => {
            doc.getAllCards().forEach(card => {
                if (card.links && card.links.length > 0) {
                    // For each referenced title, find the target card
                    card.links.forEach(linkedTitle => {
                        // Search across all docs for the referenced card
                        for (const targetDoc of this.docs) {
                            const targetCard = targetDoc.getAllCards().find(c => c.title === linkedTitle);
                            if (targetCard) {
                                // Add reference link (thinner edge)
                                links.push({
                                    source: card.id,
                                    target: targetCard.id,
                                    type: 'reference'
                                });
                                break; // Found the target, stop searching
                            }
                        }
                    });
                }
            });
        });

        return { nodes, links };
    }

    /**
     * Serialize the project to JSON
     * @returns {object} - JSON representation of the project
     */
    toJSON() {
        return {
            id: this.id,
            name: this.name,
            docs: this.docs.map(doc => doc.toJSON()),
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            docCount: this.docs.length,
            totalCards: this.getTotalCardCount()
        };
    }

    /**
     * Create a project from JSON data
     * @param {object} jsonData - The JSON data to restore from
     * @returns {Project} - A new Project instance with the restored data
     */
    static fromJSON(jsonData) {
        const project = new Project(jsonData.name);
        // Self-heal IDs: external tools (the workspace scanner, hand-authored
        // slate.json, copy-pasted projects) often skip the UUIDs. The graph
        // viz keys nodes by id, so missing ids would silently kill all edges.
        project.id = jsonData.id || uuidv4();
        project.createdAt = jsonData.createdAt;
        project.updatedAt = jsonData.updatedAt;

        if (jsonData.docs && Array.isArray(jsonData.docs)) {
            jsonData.docs.forEach(docData => {
                const doc = Doc.fromJSON(docData);
                project.docs.push(doc);
            });
        }

        return project;
    }

    /**
     * Clear all documents from the project
     */
    clearDocs() {
        this.docs = [];
        this.updatedAt = new Date().toISOString();
    }
}

export default Project;

