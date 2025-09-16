import { NetworkViz } from "./network_viz.js";
import OpenAIAgent from "./ai_utils.js";
import Card from "./cards.js";
// dummy data
import data from "./dummy_data.js";

// Select all the dom elements
const network = document.getElementById("network");
const resetZoom = document.getElementById("resetZoom");
// search stuff
const search_input = document.getElementById("search_input");
const search_btn = document.getElementById("search_btn");
// docs stuff
const doc_content = document.getElementById("doc-content");
const summary_btn = document.getElementById("summary_btn");
const add_doc = document.getElementById("add_doc");
const remove_doc = document.getElementById("remove_doc");
// editor actions
const undo_btn = document.getElementById("undo_btn");
const export_btn = document.getElementById("export_btn");
const import_btn = document.getElementById("import_btn");
// chat stuff
const chat_content = document.getElementById("chat-content");
const prompt = document.getElementById("chat-prompt");
const send_prompt = document.getElementById("send_prompt");
const add_to_doc = document.getElementById("add_to_doc");

const buttons = {
    resetZoom: resetZoom,
    search_input: search_input,
    search_btn: search_btn,
    summary_btn: summary_btn,
    add_doc: add_doc,
    remove_doc: remove_doc,
    undo_btn: undo_btn,
    export_btn: export_btn,
    import_btn: import_btn,
    send_prompt: send_prompt,
    add_to_doc: add_to_doc,
    prompt: prompt,
    chat_content: chat_content
};

// main manager
class MainManager {
    constructor(network, log, chat, data, buttons) {
        this.network = network; // this is the network data structure
        this.log = log; // this is the log of events
        this.chat = chat; // this is the chat interface
        this.viz = null; // this will hold the network visualization instance
        this.buttons = buttons; // store button references
        this.data = data; // store data
        this.ai_agent = null;
    }

    resetZoom() {
        this.viz.resetZoom();
        this.viz.zoomToFit();
    }

    summary_btn() {
        alert("Show summary?");
    }

    add_to_doc() {
        if (confirm("Add to document?")) {
            // Logic to add to document
        } else {
            alert("Didnt add to document");
        }
    }

    async ask_ai() {
        const userInput = this.buttons.prompt.innerText;
        console.log("User input:", userInput);
        this.ai_agent.generateResponse(userInput).then((res) => {
            this.buttons.chat_content.innerHTML = res;
        });
        // update the chat content
        this.buttons.chat_content.innerHTML = "Waiting for response...";
    }

    mapButtons() {
        this.buttons.resetZoom.addEventListener("click", () => this.resetZoom());
        this.buttons.summary_btn.addEventListener("click", () => this.summary_btn());
        this.buttons.add_to_doc.addEventListener("click", () => this.add_to_doc());
        this.buttons.send_prompt.addEventListener("click", () => this.ask_ai());
    }

    async init() {
        // Initialize the network visualization
        this.viz = new NetworkViz("#network", data, this.network.clientWidth, this.network.clientHeight);
        // Initialize the AI agent
        this.ai_agent = new OpenAIAgent();
        // map all the buttons
        this.mapButtons();
    }
}



// Initialize the main manager
const mainManager = new MainManager(network, doc_content, chat_content, data, buttons);
await mainManager.init();


// create a fake card and add to doc_content
var card = new Card("Test Card", "This is a test card");
card.init();
console.log(card);
doc_content.appendChild(card.innerHTML);