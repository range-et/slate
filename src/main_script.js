import { NetworkViz } from "./network_viz.js";
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
    resetZoom:resetZoom,
    search_input:search_input,
    search_btn:search_btn,
    summary_btn:summary_btn,
    add_doc:add_doc,
    remove_doc:remove_doc,
    undo_btn:undo_btn,
    export_btn:export_btn,
    import_btn:import_btn,
    send_prompt:send_prompt,
    add_to_doc:add_to_doc,
    prompt:prompt
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

    mapButtons() {
        this.buttons.resetZoom.addEventListener("click", () => this.resetZoom());
        this.buttons.summary_btn.addEventListener("click", () => this.summary_btn());
        this.buttons.add_to_doc.addEventListener("click", () => this.add_to_doc());
    }

    async init() {
        // Initialize the network visualization
        this.viz = new NetworkViz("#network", data, this.network.clientWidth, this.network.clientHeight);
        // map all the buttons
        this.mapButtons();
    }
}



// Initialize the main manager
const mainManager = new MainManager(network, doc_content, chat_content, data, buttons);
await mainManager.init();