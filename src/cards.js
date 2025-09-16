import { v4 as uuidv4 } from 'uuid';

class Card {
    constructor(title, content) {
        this.title = title;
        this.content = content;
        this.id = null; // unique identifier
        this.links = []; // array of linked card IDs
        this.parent = null; // reference to the parent doc
        this.innerHTML = null;
    }

    static generateId() {
        return uuidv4();
    }

    create() {
        const cardElement = document.createElement("div");
        cardElement.classList.add("card");
        cardElement.innerHTML = `
            <div class="card_header">
                            <div class="card_actions" style="justify-content: space-between;">
                                <input type="checkbox" id="card_selector" name="card_selector" value="false">
                                <button class="alert_btn">x</button>
                            </div>
                            <br>
                            <div class="card_details">
                                <h4>${this.title}</h4>
                                <p class="">${this.id}</p>
                            </div>
                            
                        </div>
                        <p>${this.content}</p>
                    </div>`;
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

    init(){
        this.id = Card.generateId();
        this.innerHTML = this.create();
    }
}

export default Card;