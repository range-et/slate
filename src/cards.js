import { v4 as uuidv4 } from 'uuid';

class Card {
    constructor(title, content) {
        this.title = title;
        this.content = content;
        this.id = Card.generateId();
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
}

export default Card;