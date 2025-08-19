import { generateSummary } from "./ai_utils";

class Doc{
    constructor(title) {
        this.title = title;
        this.cards = [];
        this.id = Doc.generateId();
        this.summary = "";
    }

    static generateId() {
        return uuidv4();
    }

    addCard(card) {
        this.cards.push(card);
    }

    async generateSummary() {
        let content = "";

        this.cards.forEach(element => {
            content += element.content + " ";
        });

        content = content.trim();

        // send this off to the ai service
        this.summary = await generateSummary(content);
    }

    render() {
        const docElement = document.createElement("div");
        docElement.classList.add("doc");
        docElement.innerHTML = `
            <h2>${this.title}</h2>
            <p>${this.content}</p>
        `;
        return docElement;
    }
}

export default Doc;
