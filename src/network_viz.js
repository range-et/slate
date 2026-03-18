import * as d3 from "d3";

export class NetworkViz {
  constructor(container, data, width, height, onNodeClick = null) {
    this.container = container;
    this.data = {
      nodes: [...(data.nodes || [])],
      links: [...(data.links || [])]
    };
    this.svg = null;
    this.width = width;
    this.height = height;
    this.onNodeClick = onNodeClick;
    
    // Force simulation
    this.simulation = null;
    
    // Zoom behavior setup
    this.zoom = d3.zoom()
      .scaleExtent([0.1, 5])
      .on("zoom", (event) => this.handleZoom(event));
    
    // Add CSS styles for interactivity
    this.addStyles();
    this.render();
  }

  addStyles() {
    if (document.getElementById('networkviz-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'networkviz-styles';
    style.textContent = `
      .networkviz-container {
        cursor: grab;
      }
      .networkviz-container:active {
        cursor: grabbing;
      }
      .node-circle {
        stroke: var(--strata-bg);
        stroke-width: 2px;
        cursor: pointer;
        transition: opacity var(--threshold-fast), stroke-width var(--threshold-fast);
      }
      .node-circle:hover {
        stroke-width: 3px;
      }
      .node-circle.dimmed {
        opacity: 0.15;
      }
      .node-circle.highlighted {
        opacity: 1;
        stroke-width: 3px;
      }
      .node-label {
        pointer-events: none;
        user-select: none;
        font-family: var(--font-mono);
        fill: var(--strata-text-primary);
        text-anchor: middle;
        dominant-baseline: middle;
        transition: opacity var(--threshold-fast);
      }
      .node-label.dimmed {
        opacity: 0.15;
      }
      .node-label.highlighted {
        opacity: 1;
      }
      .node-label-bg {
        fill: var(--strata-overlay);
        transition: opacity var(--threshold-fast);
      }
      .node-label-bg.dimmed {
        opacity: 0.15;
      }
      .node-label-bg.highlighted {
        opacity: 1;
      }
      .link {
        stroke-linecap: square;
        transition: opacity var(--threshold-fast);
        cursor: pointer;
      }
      .link--hierarchy {
        stroke: var(--strata-interactive);
        stroke-opacity: 0.6;
      }
      .link--reference {
        stroke: var(--strata-error);
        stroke-opacity: 0.4;
        stroke-dasharray: 4 2;
      }
      .link.dimmed {
        opacity: 0.1;
      }
      .link.highlighted {
        opacity: 1;
        stroke-width: 4px !important;
      }
    `;
    document.head.appendChild(style);
  }

  handleZoom(event) {
    const { transform } = event;
    this.zoomGroup.attr("transform", transform);
  }

  zoomTo(scale, x = 0, y = 0, duration = 750) {
    this.svg.transition()
      .duration(duration)
      .call(
        this.zoom.transform,
        d3.zoomIdentity.translate(x, y).scale(scale)
      );
  }

  resetZoom(duration = 750) {
    // Reset to centered view (scale 1, centered at viewport center)
    // Account for the zoomGroup being at (width/2, height/2)
    this.svg.transition()
      .duration(duration)
      .call(
        this.zoom.transform,
        d3.zoomIdentity.translate(this.width / 2, this.height / 2).scale(1)
      );
  }

  zoomToFit(padding = 100, duration = 750) {
    if (!this.zoomGroup) return;
    
    const bounds = this.zoomGroup.node().getBBox();
    const width = bounds.width;
    const height = bounds.height;
    const midX = bounds.x + width / 2;
    const midY = bounds.y + height / 2;
    
    if (width === 0 || height === 0) return;
    
    const scale = Math.min(
      (this.width - padding) / width,
      (this.height - padding) / height,
      1.5 // Cap max zoom
    );
    
    const translate = [
      this.width / 2 - scale * midX,
      this.height / 2 - scale * midY
    ];
    
    this.svg.transition()
      .duration(duration)
      .call(
        this.zoom.transform,
        d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale)
      );
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
    // Clear previous content
    d3.select(this.container).selectAll("svg").remove();
    
    // Stop previous simulation if exists
    if (this.simulation) {
      this.simulation.stop();
    }
    
    // Create SVG with zoom behavior
    this.svg = d3.select(this.container)
      .append("svg")
      .attr("width", this.width)
      .attr("height", this.height)
      .attr("class", "networkviz-container")
      .call(this.zoom);
    
    // Create zoom group - DON'T pre-translate, let zoom behavior handle it
    this.zoomGroup = this.svg.append("g");
    
    // Set initial zoom transform to center the graph
    this.svg.call(
      this.zoom.transform,
      d3.zoomIdentity.translate(this.width / 2, this.height / 2).scale(1)
    );

    // If no nodes, return early
    if (this.data.nodes.length === 0) return;

    // Read Strata colors from CSS custom properties at render time
    const cs = getComputedStyle(document.documentElement);
    const strataColors = {
      info:        cs.getPropertyValue('--strata-info').trim(),
      interactive: cs.getPropertyValue('--strata-interactive').trim(),
      success:     cs.getPropertyValue('--strata-success').trim(),
      disabled:    cs.getPropertyValue('--strata-disabled').trim(),
    };

    // Prepare nodes with visual properties based on type
    const nodes = this.data.nodes.map(d => {
      let radius, color, fontSize, fontWeight;
      
      switch(d.type) {
        case 'project':
          radius = 20;
          color = strataColors.info;
          fontSize = '18px';
          fontWeight = '700';
          break;
        case 'doc':
          radius = 14;
          color = strataColors.interactive;
          fontSize = '15px';
          fontWeight = '600';
          break;
        case 'card':
          radius = 9;
          color = strataColors.success;
          fontSize = '13px';
          fontWeight = '400';
          break;
        default:
          radius = 10;
          color = strataColors.disabled;
          fontSize = '12px';
          fontWeight = '400';
      }
      
      return {
        ...d,
        radius,
        color,
        fontSize,
        fontWeight
      };
    });

    // Prepare links
    const links = this.data.links.map(d => ({ ...d }));
    
    // Filter links for force simulation - only use hierarchy links
    const hierarchyLinks = links.filter(d => d.type === 'hierarchy');

    // Create force simulation with only hierarchy links
    this.simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(hierarchyLinks)
        .id(d => d.id)
        .distance(d => {
          // Longer distances for parent-child connections
          if (d.source.type === 'project') return 180;
          if (d.source.type === 'doc') return 160;
          return 140;
        })
        .strength(0.5))  // Weaker links allow more spacing
      .force("charge", d3.forceManyBody()
        .strength(d => {
          // Very strong repulsion to push nodes apart
          if (d.type === 'project') return -2500;
          if (d.type === 'doc') return -1200;
          return -800;
        }))
      .force("center", d3.forceCenter(0, 0))
      .force("collision", d3.forceCollide()
        .radius(d => {
          // Much larger collision radius to absolutely prevent overlap
          // Include space for labels
          const textPadding = 60; // Account for text labels
          if (d.type === 'project') return d.radius + textPadding + 20;
          if (d.type === 'doc') return d.radius + textPadding + 15;
          return d.radius + textPadding;
        })
        .strength(1.5)  // Extra strong collision force (>1.0 for aggressive prevention)
        .iterations(5))  // Many more iterations for perfect collision detection
      .force("x", d3.forceX(0).strength(0.01))
      .force("y", d3.forceY(0).strength(0.01))
      .alphaDecay(0.01)  // Slower cooldown = more time to settle
      .velocityDecay(0.3);  // Lower velocity decay = smoother movement

    // Create link elements
    const linkGroup = this.zoomGroup.append("g")
      .attr("class", "links");

    const link = linkGroup.selectAll("line")
      .data(links)
      .enter().append("line")
      .attr("class", d => `link link--${d.type || 'hierarchy'}`)
      .attr("stroke-width", d => d.type === 'reference' ? 2 : 3)
      .on("mouseover", (event, d) => this.highlightLink(d, nodes, links))
      .on("mouseout", () => this.clearHighlight());

    // Create node groups
    const nodeGroup = this.zoomGroup.append("g")
      .attr("class", "nodes");

    const node = nodeGroup.selectAll("g")
      .data(nodes)
      .enter().append("g")
      .attr("class", "node")
      .call(d3.drag()
        .on("start", (event, d) => this.dragstarted(event, d))
        .on("drag", (event, d) => this.dragged(event, d))
        .on("end", (event, d) => this.dragended(event, d)));

    // Add circles with entrance animation
    node.append("circle")
      .attr("class", "node-circle")
      .attr("r", 0)
      .attr("fill", d => d.color)
      .on("click", (event, d) => {
        event.stopPropagation();
        if (this.onNodeClick) {
          this.onNodeClick(d);
        }
      })
      .on("mouseover", (event, d) => this.highlightNode(d, nodes, links))
      .on("mouseout", () => this.clearHighlight())
      .transition()
      .duration(500)
      .ease(d3.easeBounceOut)
      .attr("r", d => d.radius);

    // Add text background rectangles
    const textBg = node.append("rect")
      .attr("class", "node-label-bg")
      .attr("opacity", 0);

    // Add text labels (fill comes from .node-label CSS class)
    const text = node.append("text")
      .attr("class", "node-label")
      .attr("dy", d => d.radius + 20)
      .attr("font-size", d => d.fontSize)
      .attr("font-weight", d => d.fontWeight)
      .attr("opacity", 0)
      .text(d => d.name || d.id);

    // Calculate text dimensions and set background sizes
    text.each(function(d) {
      const bbox = this.getBBox();
      d.textWidth = bbox.width;
      d.textHeight = bbox.height;
    });

    textBg
      .attr("x", d => -(d.textWidth / 2 + 6))
      .attr("y", d => d.radius + 20 - d.textHeight / 2 - 4)
      .attr("width", d => d.textWidth + 12)
      .attr("height", d => d.textHeight + 8)
      .transition()
      .delay(300)
      .duration(300)
      .attr("opacity", 1);

    text
      .transition()
      .delay(300)
      .duration(300)
      .attr("opacity", 1);

    // Store references
    this.linkElements = link;
    this.nodeElements = node;
    
    // Create node lookup map for reference links
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    // Update positions on each tick
    this.simulation.on("tick", () => {
      link
        .attr("x1", d => {
          // For reference links, look up the node
          if (d.type === 'reference') {
            const sourceNode = nodeMap.get(d.source);
            return sourceNode ? sourceNode.x : 0;
          }
          // For hierarchy links, use the simulation's source object
          return d.source.x;
        })
        .attr("y1", d => {
          if (d.type === 'reference') {
            const sourceNode = nodeMap.get(d.source);
            return sourceNode ? sourceNode.y : 0;
          }
          return d.source.y;
        })
        .attr("x2", d => {
          if (d.type === 'reference') {
            const targetNode = nodeMap.get(d.target);
            return targetNode ? targetNode.x : 0;
          }
          return d.target.x;
        })
        .attr("y2", d => {
          if (d.type === 'reference') {
            const targetNode = nodeMap.get(d.target);
            return targetNode ? targetNode.y : 0;
          }
          return d.target.y;
        });

      node
        .attr("transform", d => `translate(${d.x},${d.y})`);
    });

    // Don't auto-zoom to fit - keep graph centered as the simulation settles
    // The force simulation with center(0,0) keeps everything naturally centered
  }

  // Drag handlers
  dragstarted(event, d) {
    if (!event.active) this.simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }

  dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }

  dragended(event, d) {
    if (!event.active) this.simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }

  // Highlight a node and its neighbors
  highlightNode(hoveredNode, nodes, links) {
    const connectedNodeIds = new Set();
    const connectedLinks = new Set();
    
    // Add the hovered node itself
    connectedNodeIds.add(hoveredNode.id);
    
    // Find all connected nodes and links
    links.forEach(link => {
      const sourceId = link.source.id || link.source;
      const targetId = link.target.id || link.target;
      
      if (sourceId === hoveredNode.id) {
        connectedNodeIds.add(targetId);
        connectedLinks.add(link);
      } else if (targetId === hoveredNode.id) {
        connectedNodeIds.add(sourceId);
        connectedLinks.add(link);
      }
    });
    
    // Apply dimmed/highlighted classes to nodes
    this.nodeElements.selectAll("circle")
      .classed("dimmed", d => !connectedNodeIds.has(d.id))
      .classed("highlighted", d => connectedNodeIds.has(d.id));
    
    this.nodeElements.selectAll("text")
      .classed("dimmed", d => !connectedNodeIds.has(d.id))
      .classed("highlighted", d => connectedNodeIds.has(d.id));
    
    this.nodeElements.selectAll("rect")
      .classed("dimmed", d => !connectedNodeIds.has(d.id))
      .classed("highlighted", d => connectedNodeIds.has(d.id));
    
    // Apply dimmed/highlighted classes to links
    this.linkElements
      .classed("dimmed", l => !connectedLinks.has(l))
      .classed("highlighted", l => connectedLinks.has(l));
  }

  // Highlight a link and its connected nodes
  highlightLink(hoveredLink, nodes, links) {
    const sourceId = hoveredLink.source.id || hoveredLink.source;
    const targetId = hoveredLink.target.id || hoveredLink.target;
    const connectedNodeIds = new Set([sourceId, targetId]);
    
    // Apply dimmed/highlighted classes to nodes
    this.nodeElements.selectAll("circle")
      .classed("dimmed", d => !connectedNodeIds.has(d.id))
      .classed("highlighted", d => connectedNodeIds.has(d.id));
    
    this.nodeElements.selectAll("text")
      .classed("dimmed", d => !connectedNodeIds.has(d.id))
      .classed("highlighted", d => connectedNodeIds.has(d.id));
    
    this.nodeElements.selectAll("rect")
      .classed("dimmed", d => !connectedNodeIds.has(d.id))
      .classed("highlighted", d => connectedNodeIds.has(d.id));
    
    // Apply dimmed/highlighted classes to links
    this.linkElements
      .classed("dimmed", l => l !== hoveredLink)
      .classed("highlighted", l => l === hoveredLink);
  }

  // Clear all highlighting
  clearHighlight() {
    this.nodeElements.selectAll("circle")
      .classed("dimmed", false)
      .classed("highlighted", false);
    
    this.nodeElements.selectAll("text")
      .classed("dimmed", false)
      .classed("highlighted", false);
    
    this.nodeElements.selectAll("rect")
      .classed("dimmed", false)
      .classed("highlighted", false);
    
    this.linkElements
      .classed("dimmed", false)
      .classed("highlighted", false);
  }

  // Method to update data and re-render
  updateData(newData) {
    // Create fresh copies of nodes and links to ensure D3 doesn't hold stale references
    this.data = {
      nodes: (newData.nodes || []).map(node => ({ ...node })),
      links: (newData.links || []).map(link => ({ ...link }))
    };
    
    // Force a complete re-render to ensure old nodes are removed
    this.render();
  }

  // Resize the SVG and zoom transform when the container size changes
  resize(width, height) {
    if (width <= 0 || height <= 0) return;
    this.width = width;
    this.height = height;
    if (!this.svg) return;
    this.svg
      .attr("width", this.width)
      .attr("height", this.height);
    this.svg.call(
      this.zoom.transform,
      d3.zoomIdentity.translate(this.width / 2, this.height / 2).scale(1)
    );
  }
}
