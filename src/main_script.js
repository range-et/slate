import { NetworkViz } from "./network_viz.js";

// Select all the dom elements
const network = document.getElementById("network");
const log = document.getElementById("log");
const chat = document.getElementById("chat");

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
        { id: "A", parent: "root" },
        { id: "B", parent: "root" },
        { id: "C", parent: "root" },
        { id: "A1", parent: "A" },
        { id: "A2", parent: "A" },
        { id: "A3", parent: "A" },
        { id: "B1", parent: "B" },
        { id: "B2", parent: "B" },
        { id: "B3", parent: "B" },
        { id: "C1", parent: "C" },
        { id: "C2", parent: "C" },
        { id: "C3", parent: "C" },
        { id: "A1a", parent: "A1" },
        { id: "A1b", parent: "A1" },
        { id: "B2a", parent: "B2" },
        { id: "C3a", parent: "C3" }
    ],
    links: [
        { source: "A1", target: "B1" },
        { source: "A2", target: "B2" },
        { source: "A3", target: "C1" },
        { source: "B1", target: "C2" },
        { source: "B2", target: "A1" },
        { source: "C1", target: "A2" },
        { source: "C2", target: "B3" },
        { source: "C3", target: "A3" },
        { source: "A1a", target: "B2a" },
        { source: "A1b", target: "C3a" },
        { source: "B2a", target: "C1" },
        { source: "C3a", target: "A1" }
    ]
};

// Initialize the visualization
const viz = new NetworkViz("#network", data, network.offsetWidth);

// Example usage
viz.addLink({ source: "A1", target: "C" });
viz.removeNode("B1");
viz.removeLink("A2", "B1");
