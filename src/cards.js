import { v4 as uuidv4 } from 'uuid';
import Modal from './modal.js';

class Card {
    constructor(title, content, modal = null, updateNetworkCallback = null, onCardClick = null) {
        this.title = title;
        this.content = content;
        this.id = null; // unique identifier
        this.links = []; // array of linked card titles
        this.parent = null; // reference to the parent doc
        this.innerHTML = null;
        this.modal = modal || new Modal(); // use provided modal or create new one
        this.updateNetworkCallback = updateNetworkCallback; // callback to update network viz
        this.onCardClick = onCardClick; // callback when card is clicked for referencing
    }

    create() {
        const cardElement = document.createElement("div");
        cardElement.classList.add("card");
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
            <p>${this.content}</p>`;
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
                e.stopPropagation(); // Prevent card click from firing
                this.remove();
            });
        }
        
        // Attach click listener to the card itself for @referencing
        if (this.onCardClick) {
            this.innerHTML.addEventListener('click', (e) => {
                // Only trigger if not clicking the remove button
                if (!e.target.classList.contains('alert_btn')) {
                    this.onCardClick(this.title);
                }
            });
            // Add visual feedback that card is clickable
            this.innerHTML.style.cursor = 'pointer';
        }
    }
}

export default Card;