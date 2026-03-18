class Modal {
    constructor() {
        this.overlay = document.getElementById("overlay");
        this.modal = document.getElementById("modal");
        this.modalContent = document.getElementById("modal-content");
        this.modalActions = document.getElementById("modal-actions");
        
        // Hide modal by default
        this.hide();
        
        // Close modal when clicking overlay
        this.overlay.addEventListener("click", (e) => {
            if (e.target === this.overlay) {
                this.hide();
            }
        });
    }

    show() {
        this.overlay.style.display = "flex";
    }

    hide() {
        this.overlay.style.display = "none";
        this.modalContent.innerHTML = "";
        this.modalActions.innerHTML = "";
    }

    /**
     * Display an alert modal with a message and OK button
     * @param {string} message - The message to display
     * @returns {Promise<void>} - Resolves when OK is clicked
     */
    alert(message) {
        return new Promise((resolve) => {
            // Set the message
            this.modalContent.innerHTML = `<p>${message}</p>`;
            
            // Create OK button
            const okButton = document.createElement("button");
            okButton.textContent = "OK";
            okButton.className = "info_btn";
            okButton.addEventListener("click", () => {
                this.hide();
                resolve();
            });
            
            this.modalActions.innerHTML = "";
            this.modalActions.appendChild(okButton);
            
            this.show();
        });
    }

    /**
     * Display a confirm modal with a message and OK/Cancel buttons
     * @param {string} message - The message to display
     * @returns {Promise<boolean>} - Resolves to true if OK clicked, false if Cancel clicked
     */
    confirm(message) {
        return new Promise((resolve) => {
            // Set the message
            this.modalContent.innerHTML = `<p>${message}</p>`;
            
            // Create Cancel button
            const cancelButton = document.createElement("button");
            cancelButton.textContent = "Cancel";
            cancelButton.className = "alert_btn";
            cancelButton.addEventListener("click", () => {
                this.hide();
                resolve(false);
            });
            
            // Create OK button
            const okButton = document.createElement("button");
            okButton.textContent = "OK";
            okButton.className = "success_btn";
            okButton.addEventListener("click", () => {
                this.hide();
                resolve(true);
            });
            
            this.modalActions.innerHTML = "";
            this.modalActions.appendChild(cancelButton);
            this.modalActions.appendChild(okButton);
            
            this.show();
        });
    }

    /**
     * Display a selection modal with a list of options
     * @param {string} message - The message/prompt to display
     * @param {Array<string>} options - Array of option strings
     * @returns {Promise<number|null>} - Resolves to index of selected option, or null if cancelled
     */
    select(message, options) {
        return new Promise((resolve) => {
            // Create the select interface
            const container = document.createElement("div");
            container.innerHTML = `
                <p style="margin-bottom: 12px;">${message}</p>
                <select class="modal-select" style="width: 100%; padding: 8px; font-size: small; background: var(--strata-layer-01); color: var(--strata-text-primary); border: 1px solid var(--strata-interactive);">
                    ${options.map((opt, index) => `<option value="${index}">${opt}</option>`).join('')}
                </select>
            `;
            
            this.modalContent.innerHTML = "";
            this.modalContent.appendChild(container);
            
            const selectElement = container.querySelector('select');
            
            // Create Cancel button
            const cancelButton = document.createElement("button");
            cancelButton.textContent = "Cancel";
            cancelButton.className = "alert_btn";
            cancelButton.addEventListener("click", () => {
                this.hide();
                resolve(null);
            });
            
            // Create OK button
            const okButton = document.createElement("button");
            okButton.textContent = "Move";
            okButton.className = "success_btn";
            okButton.addEventListener("click", () => {
                const selectedIndex = parseInt(selectElement.value);
                this.hide();
                resolve(selectedIndex);
            });
            
            this.modalActions.innerHTML = "";
            this.modalActions.appendChild(cancelButton);
            this.modalActions.appendChild(okButton);
            
            this.show();
            
            // Focus the select element
            selectElement.focus();
        });
    }

    /**
     * Display a custom modal with custom content and actions
     * @param {string|HTMLElement} content - The content to display
     * @param {Array<{text: string, className: string, callback: function}>} actions - Array of action button configs
     */
    custom(content, actions = []) {
        return new Promise((resolve) => {
            // Set content
            if (typeof content === "string") {
                this.modalContent.innerHTML = content;
            } else {
                this.modalContent.innerHTML = "";
                this.modalContent.appendChild(content);
            }
            
            // Create action buttons
            this.modalActions.innerHTML = "";
            actions.forEach(action => {
                const button = document.createElement("button");
                button.textContent = action.text;
                button.className = action.className || "info_btn";
                button.addEventListener("click", () => {
                    const result = action.callback ? action.callback() : null;
                    this.hide();
                    resolve(result);
                });
                this.modalActions.appendChild(button);
            });
            
            this.show();
        });
    }
}

export default Modal;

