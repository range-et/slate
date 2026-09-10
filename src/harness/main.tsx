import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
    Background,
    BackgroundVariant,
    Controls,
    Edge,
    Handle,
    Node,
    NodeProps,
    Position,
    ReactFlow,
    ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { demoSnapshot } from './demo';
import { buildGraph, SlateNodeData } from './graph';
import type { HarnessDocument, HarnessSnapshot, HarnessUnit, HostMessage } from './types';
import './styles.css';

interface VsCodeApi {
    postMessage(message: unknown): void;
}

declare global {
    interface Window {
        acquireVsCodeApi?: () => VsCodeApi;
    }
}

const vscode = typeof window.acquireVsCodeApi === 'function'
    ? window.acquireVsCodeApi()
    : null;

function SlateNode({ data, selected }: NodeProps<Node<SlateNodeData>>) {
    return (
        <div className={`slate-node slate-node--${data.kind} ${selected ? 'is-selected' : ''} ${data.invalid ? 'is-invalid' : ''} ${data.stale ? 'is-stale' : ''}`}>
            <Handle type="target" position={Position.Left} className="slate-node__handle" />
            <div className="slate-node__kind">
                <span>{data.kind.replace('_', ' ')}</span>
                {data.identity === 'provisional' && <span title="Not yet anchored with a Slate ID">◇</span>}
            </div>
            <strong>{data.label}</strong>
            <code>{data.detail}</code>
            <Handle type="source" position={Position.Right} className="slate-node__handle" />
        </div>
    );
}

const nodeTypes = { slate: SlateNode };

function Inspector({ node, document }: { node: Node<SlateNodeData>; document?: HarnessDocument }) {
    const unit = node.data.unit;
    return (
        <aside className="harness-inspector" aria-label="Selected node details">
            <div className="harness-inspector__eyebrow">{node.data.kind.replace('_', ' ')}</div>
            <h2>{node.data.label}</h2>
            <code className="harness-inspector__path">{node.data.path}</code>
            {unit && (
                <>
                    <dl>
                        <dt>Identity</dt><dd>{unit.identity}</dd>
                        <dt>Qualified name</dt><dd>{unit.qualifiedName}</dd>
                        <dt>Source</dt><dd>line {unit.ranges.name.start.line + 1}</dd>
                        <dt>Signature</dt><dd><code>{unit.signature ?? 'class container'}</code></dd>
                    </dl>
                    <button onClick={() => vscode?.postMessage({ type: 'reveal', path: node.data.path, range: unit.ranges.name })}>
                        Reveal in code
                    </button>
                </>
            )}
            {!unit && document && document.diagnostics.length > 0 && (
                <div className="harness-inspector__diagnostic">
                    {document.diagnostics.map(item => <p key={`${item.code}:${item.message}`}>{item.message}</p>)}
                </div>
            )}
        </aside>
    );
}

function HarnessApp() {
    const showDemo = import.meta.env.DEV && new URLSearchParams(window.location.search).has('demo');
    const [snapshot, setSnapshot] = useState<HarnessSnapshot>(showDemo
        ? demoSnapshot
        : { revision: 0, projectName: 'Slate', documents: [] });
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const flow = useRef<ReactFlowInstance<Node<SlateNodeData>, Edge> | null>(null);
    const graph = useMemo(() => buildGraph(snapshot), [snapshot]);
    const selected = graph.nodes.find(node => node.id === selectedId) ?? null;
    const selectedDocument = selected
        ? snapshot.documents.find(document => document.path === selected.data.path)
        : undefined;
    const invalidCount = snapshot.documents.filter(document => !document.valid).length;
    const staleCount = snapshot.documents.filter(document => document.stale).length;

    useEffect(() => {
        const onMessage = (event: MessageEvent<HostMessage>) => {
            if (event.data.type === 'snapshot') setSnapshot(event.data.snapshot);
            if (event.data.type === 'selectUnit') setSelectedId(event.data.unitId);
        };
        window.addEventListener('message', onMessage);
        vscode?.postMessage({ type: 'ready' });
        return () => window.removeEventListener('message', onMessage);
    }, []);

    const runCommand = () => {
        const command = query.trim();
        if (!command) return;
        if (command === 'fit') {
            flow.current?.fitView({ padding: 0.2, duration: 300 });
        } else {
            const term = command.replace(/^find\s+/, '').toLowerCase();
            const match = graph.nodes.find(node =>
                node.data.label.toLowerCase().includes(term)
                || node.data.detail.toLowerCase().includes(term)
            );
            if (match) {
                setSelectedId(match.id);
                flow.current?.setCenter(match.position.x + 130, match.position.y + 36, { zoom: 1.2, duration: 300 });
            }
        }
        setQuery('');
    };

    return (
        <main className="harness-shell">
            <header className="harness-topbar">
                <div><strong>SLATE</strong><span>{snapshot.projectName}</span></div>
                <div className="harness-status">
                    <span>{snapshot.documents.length} files</span>
                    <span>{graph.nodes.length - snapshot.documents.length} units</span>
                    {staleCount > 0 && <span className="status-warning">{staleCount} stale</span>}
                    {invalidCount > 0 && <span className="status-error">{invalidCount} invalid</span>}
                </div>
            </header>
            <section className="harness-canvas" aria-label="Python project graph">
                {graph.nodes.length === 0 && <div className="harness-empty">Open a Python workspace to build its graph.</div>}
                <ReactFlow
                    nodes={graph.nodes}
                    edges={graph.edges}
                    nodeTypes={nodeTypes}
                    onInit={instance => { flow.current = instance; instance.fitView({ padding: 0.2 }); }}
                    onNodeClick={(_, node) => {
                        setSelectedId(node.id);
                        if (node.data.unit) vscode?.postMessage({ type: 'reveal', path: node.data.path, range: node.data.unit.ranges.name });
                    }}
                    onPaneClick={() => setSelectedId(null)}
                    fitView
                    minZoom={0.1}
                    maxZoom={2.5}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    elementsSelectable
                >
                    <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
                    <Controls showInteractive={false} />
                </ReactFlow>
            </section>
            {selected && <Inspector node={selected} document={selectedDocument} />}
            <div className="harness-command">
                <span>&gt;</span>
                <input
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    onKeyDown={event => { if (event.key === 'Enter') runCommand(); }}
                    placeholder="find <symbol>  ·  fit"
                    aria-label="Slate command"
                />
            </div>
        </main>
    );
}

createRoot(document.getElementById('harness-root')!).render(<HarnessApp />);
