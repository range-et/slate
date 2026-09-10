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
    useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { commandCompletions, parseCommand, resolveTargets } from './commands';
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
                <span>
                    {data.unit?.annotation?.locked === true && <span title="Generation is locked">LOCKED&nbsp;</span>}
                    {data.identity === 'provisional' && <span title="Not yet anchored with a Slate ID">◇</span>}
                </span>
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
    const intent = typeof unit?.annotation?.intent === 'string' ? unit.annotation.intent : null;
    const contract = typeof unit?.annotation?.contract === 'string' ? unit.annotation.contract : null;
    const dependencies = Array.isArray(unit?.annotation?.dependencies)
        ? unit.annotation.dependencies.filter(value => typeof value === 'string')
        : [];
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
                        {intent && <><dt>Intent</dt><dd>{intent}</dd></>}
                        {contract && <><dt>Contract</dt><dd>{contract}</dd></>}
                        {dependencies.length > 0 && <><dt>Context</dt><dd>{dependencies.join(', ')}</dd></>}
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
    const search = new URLSearchParams(window.location.search);
    const showDemo = import.meta.env.DEV && search.has('demo');
    const [snapshot, setSnapshot] = useState<HarnessSnapshot>(showDemo
        ? demoSnapshot
        : { revision: 0, projectName: 'Slate', documents: [] });
    const [query, setQuery] = useState(showDemo ? search.get('command') ?? '' : '');
    const [commandResult, setCommandResult] = useState('READY');
    const [history, setHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const flow = useRef<ReactFlowInstance<Node<SlateNodeData>, Edge> | null>(null);
    const commandInput = useRef<HTMLInputElement | null>(null);
    const graph = useMemo(() => buildGraph(snapshot), [snapshot]);
    const [nodes, setNodes, onNodesChange] = useNodesState<Node<SlateNodeData>>(graph.nodes);
    const selectedNodes = nodes.filter(node => node.selected);
    const selected = selectedNodes[0] ?? null;
    const selectedDocument = selected
        ? snapshot.documents.find(document => document.path === selected.data.path)
        : undefined;
    const invalidCount = snapshot.documents.filter(document => !document.valid).length;
    const staleCount = snapshot.documents.filter(document => document.stale).length;
    const contextCount = graph.edges.filter(edge => edge.id.startsWith('context:')).length;

    useEffect(() => {
        const onMessage = (event: MessageEvent<HostMessage>) => {
            if (event.data.type === 'snapshot') setSnapshot(event.data.snapshot);
            if (event.data.type === 'selectUnit') {
                setNodes(current => current.map(node => ({
                    ...node,
                    selected: node.id === event.data.unitId,
                })));
            }
        };
        window.addEventListener('message', onMessage);
        vscode?.postMessage({ type: 'ready' });
        return () => window.removeEventListener('message', onMessage);
    }, []);

    useEffect(() => {
        setNodes(current => {
            const selectedIds = new Set(current.filter(node => node.selected).map(node => node.id));
            return graph.nodes.map(node => ({ ...node, selected: selectedIds.has(node.id) }));
        });
    }, [graph.nodes, setNodes]);

    useEffect(() => {
        const focusCommandLine = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target?.matches('input, textarea, [contenteditable="true"]')) return;
            if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
            event.preventDefault();
            commandInput.current?.focus();
            setQuery(current => current + event.key);
        };
        window.addEventListener('keydown', focusCommandLine);
        return () => window.removeEventListener('keydown', focusCommandLine);
    }, []);

    const runCommand = () => {
        const raw = query.trim();
        const command = parseCommand(raw);
        if (!command) return;
        setHistory(current => [...current.filter(item => item !== raw), raw]);
        setHistoryIndex(-1);

        const targets = nodes.map(node => ({
            id: node.id,
            label: node.data.label,
            detail: node.data.detail,
            qualifiedName: node.data.unit?.qualifiedName,
        }));
        const argument = command.args.join(' ');
        if (command.name === 'FIT') {
            flow.current?.fitView({ padding: 0.2, duration: 300 });
            setCommandResult('FIT: drawing extents');
        } else if (command.name === 'CLEAR' || (command.name === 'SELECT' && argument.toUpperCase() === 'NONE')) {
            setNodes(current => current.map(node => ({ ...node, selected: false })));
            setCommandResult('SELECT: 0 objects');
        } else if (command.name === 'SELECT' && argument.toUpperCase() === 'ALL') {
            setNodes(current => current.map(node => ({ ...node, selected: true })));
            setCommandResult(`SELECT: ${nodes.length} objects`);
        } else if (command.name === 'SELECT') {
            const matches = resolveTargets(targets, argument);
            setNodes(current => current.map(node => ({ ...node, selected: matches.some(match => match.id === node.id) })));
            setCommandResult(matches.length > 0 ? `SELECT: ${matches.length} object${matches.length === 1 ? '' : 's'}` : 'SELECT: no match');
            const match = matches[0] && nodes.find(node => node.id === matches[0].id);
            if (match) flow.current?.setCenter(match.position.x + 130, match.position.y + 36, { zoom: 1.2, duration: 300 });
        } else if (command.name === 'REVEAL') {
            const matches = argument
                ? resolveTargets(targets, argument)
                : selectedNodes;
            const match = matches.length === 1 ? nodes.find(node => node.id === matches[0].id) : undefined;
            if (match?.data.unit) {
                vscode?.postMessage({ type: 'reveal', path: match.data.path, range: match.data.unit.ranges.name });
                setCommandResult(`REVEAL: ${match.data.unit.qualifiedName}`);
            } else {
                setCommandResult(matches.length > 1 ? 'REVEAL: selection is ambiguous' : 'REVEAL: select one code unit');
            }
        } else if (command.name === 'HELP') {
            setCommandResult('SELECT [ALL|NONE|name] · REVEAL [name] · FIT · CLEAR · HELP');
        } else {
            setCommandResult(`UNKNOWN COMMAND: ${command.name}`);
        }
        setQuery('');
    };

    const completions = commandCompletions(query);

    return (
        <main className="harness-shell">
            <header className="harness-topbar">
                <div><strong>SLATE</strong><span>{snapshot.projectName}</span></div>
                <div className="harness-status">
                    <span>{snapshot.documents.length} files</span>
                    <span>{graph.nodes.length - snapshot.documents.length} units</span>
                    {selectedNodes.length > 0 && <span>{selectedNodes.length} selected</span>}
                    {contextCount > 0 && <span className="status-context">{contextCount} context</span>}
                    {staleCount > 0 && <span className="status-warning">{staleCount} stale</span>}
                    {invalidCount > 0 && <span className="status-error">{invalidCount} invalid</span>}
                </div>
            </header>
            <section className="harness-canvas" aria-label="Python project graph">
                {graph.nodes.length === 0 && <div className="harness-empty">Open a Python workspace to build its graph.</div>}
                <ReactFlow
                    nodes={nodes}
                    edges={graph.edges}
                    nodeTypes={nodeTypes}
                    onNodesChange={onNodesChange}
                    onInit={instance => { flow.current = instance; instance.fitView({ padding: 0.2 }); }}
                    onNodeDoubleClick={(_, node) => {
                        if (node.data.unit) vscode?.postMessage({ type: 'reveal', path: node.data.path, range: node.data.unit.ranges.name });
                    }}
                    onNodeDragStop={(_, node) => vscode?.postMessage({
                        type: 'layout',
                        revision: snapshot.revision,
                        positions: { [node.id]: node.position },
                    })}
                    fitView
                    minZoom={0.1}
                    maxZoom={2.5}
                    nodesDraggable
                    nodesConnectable={false}
                    elementsSelectable
                >
                    <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
                    <Controls showInteractive={false} />
                </ReactFlow>
            </section>
            {selected && <Inspector node={selected} document={selectedDocument} />}
            <div className="harness-commandline">
                <div className="harness-commandline__result">{commandResult}</div>
                {query && completions.length > 0 && (
                    <div className="harness-commandline__completions">{completions.join('   ')}</div>
                )}
                <div className="harness-command">
                    <span>COMMAND:</span>
                    <input
                        ref={commandInput}
                        value={query}
                        onChange={event => setQuery(event.target.value)}
                        onKeyDown={event => {
                            if (event.key === 'Enter') runCommand();
                            if (event.key === 'Tab' && completions.length === 1) {
                                event.preventDefault();
                                setQuery(`${completions[0]} `);
                            }
                            if (event.key === 'Escape') { setQuery(''); setHistoryIndex(-1); }
                            if (event.key === 'ArrowUp' && history.length > 0) {
                                event.preventDefault();
                                const next = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
                                setHistoryIndex(next);
                                setQuery(history[next]);
                            }
                            if (event.key === 'ArrowDown' && historyIndex >= 0) {
                                event.preventDefault();
                                const next = historyIndex + 1;
                                setHistoryIndex(next >= history.length ? -1 : next);
                                setQuery(next >= history.length ? '' : history[next]);
                            }
                        }}
                        placeholder="Type HELP for commands"
                        aria-label="Slate command"
                        autoComplete="off"
                        spellCheck={false}
                    />
                </div>
            </div>
        </main>
    );
}

createRoot(document.getElementById('harness-root')!).render(<HarnessApp />);
