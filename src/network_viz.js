import * as d3 from "d3";

export class NetworkViz {
  constructor(container, data, width) {
    this.container = container;
    this.data = {
      nodes: [...(data.nodes || [])],
      links: [...(data.links || [])]
    };
    this.svg = null;
    this.width = width;
    this.radius = this.width / 2;
    this.render();
  }

  addNode(node) {
    if (this.data.nodes.some(n => n.id === node.id)) {
      console.error("Node id must be unique:", node.id);
      return;
    }
    this.data.nodes.push(node);
    this.render();
  }

  removeNode(nodeId) {
    this.data.nodes = this.data.nodes.filter(n => n.id !== nodeId);
    this.data.links = this.data.links.filter(l => l.source !== nodeId && l.target !== nodeId);
    this.render();
  }

  addLink(link) {
    this.data.links.push(link);
    this.render();
  }

  removeLink(source, target) {
    this.data.links = this.data.links.filter(l => !(l.source === source && l.target === target));
    this.render();
  }

  render() {
    d3.select(this.container).selectAll("svg").remove();

    const svg = d3.select(this.container)
      .append("svg")
      .attr("width", this.width)
      .attr("height", this.width)
      .attr("viewBox", [-this.radius, -this.radius, this.width, this.width])
      .style("font", "10px sans-serif");

    // Convert node-link data to hierarchy
    if (this.data.nodes.length === 0) return;

    const root = d3.stratify()
      .id(d => d.id)
      .parentId(d => d.parent)(this.data.nodes);

    d3.cluster()
      .size([360, this.radius - 120])(root);

    const nodeById = new Map(root.descendants().map(d => [d.id, d]));
    const links = this.data.links
      .map(d => ({
        source: nodeById.get(d.source),
        target: nodeById.get(d.target)
      }))
      .filter(d => d.source && d.target);

    svg.append("g")
      .attr("stroke", "#aaa")
      .attr("fill", "none")
      .selectAll("path")
      .data(links)
      .join("path")
      .attr("d", d => d3.linkRadial()
        .angle(d => d.x * Math.PI / 180)
        .radius(d => d.y)({ source: d.source, target: d.target }));

    svg.append("g")
      .selectAll("text")
      .data(root.leaves())
      .join("text")
      .attr("transform", d => `
        rotate(${d.x - 90})
        translate(${d.y},0)
        rotate(${d.x < 180 ? 0 : 180})
      `)
      .attr("dy", "0.31em")
      .attr("x", d => d.x < 180 ? 6 : -6)
      .attr("text-anchor", d => d.x < 180 ? "start" : "end")
      .text(d => d.id)
      .attr("font-size", 10)
      .attr("fill", "#333");

    this.svg = svg;
  }
}
