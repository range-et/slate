import { v4 as uuidv4 } from 'uuid';

class Card {
    constructor(title, content) {
        this.title = title;
        this.content = content;
        this.id = Card.generateId();
        this.links = []; // array of linked card IDs
        this.parent = null; // reference to the parent doc
    }

    static generateId() {
        return uuidv4();
    }

    render() {
        const cardElement = document.createElement("div");
        cardElement.classList.add("card");
        cardElement.innerHTML = `
      <h2>${this.title}</h2>
      <p>${this.content}</p>
    `;
        return cardElement;
    }

    remove() {
        // Remove the card from the DOM
        if (window.confirm("Do you want to open in new tab?")) {
            console.log("Removing card...");
        } else {
            console.log("Keeping card...");
        }
    }
}

export default Card;