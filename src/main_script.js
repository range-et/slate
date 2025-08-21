import { NetworkViz } from "./network_viz.js";

// Select all the dom elements
const network = document.getElementById("network");
const log = document.getElementById("log");
const chat = document.getElementById("chat");
const resetZoom = document.getElementById("resetZoom");

// main manager
class MainManager {
    constructor() {
        this.network = network; // this is the network data structure
        this.log = log; // this is the log of events
        this.chat = chat; // this is the chat interface
    }
}

// Initial node and link data
const data = {
    nodes: [
        { id: "root", parent: "" },
        { id: "doc_1", parent: "root" },
        { id: "doc_2", parent: "root" },
        { id: "doc_3", parent: "root" },
        { id: "doc_4", parent: "root" },
        { id: "doc_5", parent: "root" },
        { id: "doc_6", parent: "root" },
        { id: "card_1", parent: "doc_1" },
        { id: "card_2", parent: "doc_1" },
        { id: "card_3", parent: "doc_2" },
        { id: "card_4", parent: "doc_2" },
        { id: "card_5", parent: "doc_3" },
        { id: "card_6", parent: "doc_3" },
        { id: "card_7", parent: "doc_4" },
        { id: "card_8", parent: "doc_4" },
        { id: "card_9", parent: "doc_5" },
        { id: "card_10", parent: "doc_5" },
        { id: "card_11", parent: "doc_6" },
        { id: "card_12", parent: "doc_6" },
        { id: "card_13", parent: "doc_6" }
    ],
    links: [
        { source: "card_1", target: "card_4" },
        { source: "card_2", target: "card_5" },
        { source: "card_3", target: "card_6" },
        { source: "card_4", target: "card_7" },
        { source: "card_5", target: "card_8" },
        { source: "card_6", target: "card_9" },
        { source: "card_7", target: "card_10" },
        { source: "card_8", target: "card_11" },
        { source: "card_9", target: "card_12" },
        { source: "card_10", target: "card_13" },
        { source: "card_11", target: "card_1" },
        { source: "card_12", target: "card_2" },
        { source: "card_13", target: "card_3" }
    ]
};

// Initialize the visualization
const viz = new NetworkViz("#network", data, network.clientWidth, network.clientHeight);

// Example usage
viz.addLink({ source: "A1", target: "C" });
viz.removeNode("B1");
viz.removeLink("A2", "B1");


resetZoom.onclick = () => {
    viz.resetZoom();
    viz.zoomToFit(); 
};