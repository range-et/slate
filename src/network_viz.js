import * as d3 from "d3";

export class NetworkViz {
  constructor(container, data, width) {
    this.container = container;
    this.data = {
      nodes: [...(data.nodes || [])],
      links: [...(data.links || [])]
    };
    this.svg = null;
    this.width = width || 960;
    this.radius = this.width / 2;
    this.innerRadius = this.radius - 120;
    
    // Setup cluster layout and line generator
    this.cluster = d3.cluster().size([360, this.innerRadius]);
    this.line = d3.radialLine()
      .curve(d3.curveBundle.beta(0.85))
      .radius(d => d.y)
      .angle(d => d.x / 180 * Math.PI);
    
    // Add CSS styles for interactivity
    this.addStyles();
    this.render();
  }

  addStyles() {
    // Check if styles already exist
    if (document.getElementById('networkviz-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'networkviz-styles';
    style.textContent = `
      .node--internal {
        font: 400 9px "Helvetica Neue", Helvetica, Arial, sans-serif;
        fill: #E0E0E0;
      }
      .node--leaf {
        font: 300 10px "Helvetica Neue", Helvetica, Arial, sans-serif;
        fill: #B0B0B0;
      }
      .node:hover {
        fill: #FFEB3B;
      }
      .link {
        stroke: #00BCD4;
        fill: none;
        pointer-events: none;
      }
      .node:hover,
      .node--source,
      .node--target {
        font-weight: 700;
      }
      .node--source {
        fill: #2ca02c;
      }
      .node--target {
        fill: #9C27B0;
      }
      .link--source,
      .link--target {
        stroke-opacity: 1;
        stroke-width: 2px;
      }
      .link--source {
        stroke: #2ca02c;
      }
      .link--target {
        stroke: #9C27B0;
      }
    `;
    document.head.appendChild(style);
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

  // Convert hierarchical class names to package hierarchy
  packageHierarchy(classes) {
    const map = {};
    
    function find(name, data) {
      let node = map[name];
      if (!node) {
        node = map[name] = data || { name: name, children: [] };
        if (name.length) {
          const i = name.lastIndexOf(".");
          node.parent = find(name.substring(0, i));
          node.parent.children.push(node);
          node.key = name.substring(i + 1);
        }
      }
      return node;
    }
    
    classes.forEach(d => find(d.name, d));
    return d3.hierarchy(map[""]);
  }

  // Generate imports/links between nodes
  packageImports(nodes) {
    const map = {};
    const imports = [];
    
    // Create name to node mapping
    nodes.forEach(d => {
      map[d.data.name || d.data.id] = d;
    });
    
    // Generate paths between connected nodes
    nodes.forEach(d => {
      if (d.data.imports) {
        d.data.imports.forEach(i => {
          const sourcePath = map[d.data.name || d.data.id];
          const targetPath = map[i];
          if (sourcePath && targetPath) {
            const path = sourcePath.path(targetPath);
            // Ensure the path has proper source and target endpoints
            if (path && path.length >= 2) {
              imports.push(path);
            }
          }
        });
      }
    });
    
    return imports;
  }

  render() {
    // Clear previous content
    d3.select(this.container).selectAll("svg").remove();
    
    // Create SVG
    this.svg = d3.select(this.container)
      .append("svg")
      .attr("width", this.width)
      .attr("height", this.width)
      .append("g")
      .attr("transform", `translate(${this.radius},${this.radius})`);

    // If no nodes, return early
    if (this.data.nodes.length === 0) return;

    // Convert flat node/link structure to hierarchy if needed
    let root;
    
    // Check if nodes have hierarchical names (contain dots)
    const hasHierarchicalNames = this.data.nodes.some(n => n.name && n.name.includes('.'));
    
    if (hasHierarchicalNames) {
      // Use hierarchical structure with package names
      root = this.packageHierarchy(this.data.nodes);
      if (root.children && root.children.length > 0) {
        root = root.children[0]; // Use first child as root if empty root
      }
    } else {
      // Convert flat structure to hierarchy using parent/child relationships
      try {
        root = d3.stratify()
          .id(d => d.id)
          .parentId(d => d.parent)(this.data.nodes);
      } catch (e) {
        // Fallback: create artificial hierarchy
        const rootNode = { id: "root", name: "root" };
        const hierarchicalNodes = [rootNode, ...this.data.nodes.map(n => ({ ...n, parent: "root" }))];
        root = d3.stratify()
          .id(d => d.id)
          .parentId(d => d.parent)(hierarchicalNodes);
      }
    }

    // Apply cluster layout
    this.cluster(root);

    // Create node map for link generation
    const nodeById = new Map();
    root.descendants().forEach(d => {
      const key = d.data.name || d.data.id;
      if (key) {
        nodeById.set(key, d);
      }
    });

    // Also map by just the leaf name for better matching
    root.leaves().forEach(d => {
      const fullName = d.data.name || d.data.id;
      const leafName = d.data.key || (fullName && fullName.split('.').pop()) || fullName;
      if (leafName && !nodeById.has(leafName)) {
        nodeById.set(leafName, d);
      }
    });

    // Generate links
    let linkData = [];
    
    if (hasHierarchicalNames) {
      // Use package imports method for hierarchical data
      linkData = this.packageImports(root.leaves());
    } else {
      // Convert regular links to paths
      linkData = this.data.links
        .map(l => {
          const source = nodeById.get(l.source);
          const target = nodeById.get(l.target);
          if (source && target) {
            const path = source.path(target);
            return path && path.length >= 2 ? path : null;
          }
          return null;
        })
        .filter(d => d !== null);
    }

    // Create link group
    const linkGroup = this.svg.append("g").selectAll(".link");
    const nodeGroup = this.svg.append("g").selectAll(".node");

    // Draw links with bundled curves
    const links = linkGroup
      .data(linkData)
      .enter().append("path")
      .each(function(d) { 
        d.source = d[0];
        d.target = d[d.length - 1]; 
      })
      .attr("class", "link")
      .attr("d", d => {
        // Ensure we have a valid path array
        if (!Array.isArray(d) || d.length < 2) return null;
        return this.line(d);
      })
      .attr("fill", "none")
      .attr("stroke", "steelblue")
      .attr("stroke-opacity", 0.4)
      .attr("stroke-width", 1)
      .style("pointer-events", "none");

    // Draw nodes as text labels with interactivity
    const allNodes = root.descendants().filter(d => d.depth > 0); // Exclude root
    const nodes = nodeGroup
      .data(allNodes)
      .enter().append("text")
      .attr("class", d => d.children ? "node node--internal" : "node node--leaf")
      .attr("dy", "0.31em")
      .attr("transform", d => {
        const rotation = d.x - 90;
        const translation = d.y + 8;
        const textRotation = d.x < 180 ? 0 : 180;
        return `rotate(${rotation}) translate(${translation},0) rotate(${textRotation})`;
      })
      .attr("text-anchor", d => d.x < 180 ? "start" : "end")
      .text(d => {
        // For leaf nodes, show the key/name
        if (!d.children) {
          return d.data.key || d.data.name || d.data.id;
        }
        // For internal nodes, show the package name
        return d.data.key || d.data.name || d.data.id;
      })
      .attr("font-size", d => d.children ? "9px" : "10px")
      .attr("font-family", "Helvetica Neue, Helvetica, Arial, sans-serif")
      .attr("font-weight", d => d.children ? "400" : "300")
      .attr("fill", d => d.children ? "#666" : "#bbb")
      .style("cursor", "pointer")
      .on("mouseover", (event, d) => this.mouseovered(d))
      .on("mouseout", (event, d) => this.mouseouted(d));

    // Store references for interactivity
    this.linkElements = this.svg.selectAll(".link");
    this.nodeElements = nodes;
  }

  // Method to update data and re-render
  updateData(newData) {
    this.data = {
      nodes: [...(newData.nodes || [])],
      links: [...(newData.links || [])]
    };
    this.render();
  }

  // Interactive hover methods
  mouseovered(d) {
    this.nodeElements
      .each(function(n) { n.target = n.source = false; });

    this.linkElements
      .classed("link--target", l => {
        if (l.target === d) return l.source.source = true;
      })
      .classed("link--source", l => {
        if (l.source === d) return l.target.target = true;
      })
      .filter(l => l.target === d || l.source === d)
      .each(function() { this.parentNode.appendChild(this); }); // Raise to front

    this.nodeElements
      .classed("node--target", n => n.target)
      .classed("node--source", n => n.source);
  }

  mouseouted(d) {
    this.linkElements
      .classed("link--target", false)
      .classed("link--source", false);

    this.nodeElements
      .classed("node--target", false)
      .classed("node--source", false);
  }
}