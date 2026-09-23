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

import { commandCompletions, commandHelp, commandToAction, parseCommand, resolveTargets } from './commands';
import { demoSnapshot } from './demo';
import { buildGraph, SlateNodeData } from './graph';
import type { HarnessDocument, HarnessProposal, HarnessSearchResult, HarnessSnapshot, HostMessage, PacketPreview } from './types';
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
    const colorStyle = { '--slate-group': data.groupColor } as React.CSSProperties;
    return (
        <div
            className={`slate-node slate-node--${data.kind} ${data.container ? 'slate-node--container' : ''} ${selected ? 'is-selected' : ''} ${data.invalid ? 'is-invalid' : ''} ${data.stale ? 'is-stale' : ''}`}
            style={colorStyle}
        >
            {!data.container && <Handle type="target" position={Position.Left} className="slate-node__handle" />}
            <div className="slate-node__kind">
                <span>{data.kind.replace('_', ' ')}</span>
                <span>
                    {data.unit?.annotation?.locked === true && <span title="Generation is locked">LOCKED&nbsp;</span>}
                    {data.identity === 'provisional' && <span title="Not yet anchored with a Slate ID">◇</span>}
                </span>
            </div>
            <strong>{data.label}</strong>
            {!data.container && <code>{data.detail}</code>}
            {!data.container && <Handle type="source" position={Position.Right} className="slate-node__handle" />}
        </div>
    );
}

const nodeTypes = { slate: SlateNode };

function Inspector({
    node, document, snapshot, packet, packetError, generation, proposal, accepted,
}: {
    node: Node<SlateNodeData>;
    document?: HarnessDocument;
    snapshot: HarnessSnapshot;
    packet?: PacketPreview;
    packetError?: string;
    generation: string | null;
    proposal: HarnessProposal | null;
    accepted: boolean;
}) {
    const unit = node.data.unit;
    const intent = typeof unit?.annotation?.intent === 'string' ? unit.annotation.intent : '';
    const contract = typeof unit?.annotation?.contract === 'string' ? unit.annotation.contract : '';
    const dependencies = Array.isArray(unit?.annotation?.dependencies)
        ? unit.annotation.dependencies.filter(value => typeof value === 'string')
        : [];
    const [intentDraft, setIntentDraft] = useState(intent);
    const [contractDraft, setContractDraft] = useState(contract);
    const [contextChoice, setContextChoice] = useState('');
    useEffect(() => { setIntentDraft(intent); setContractDraft(contract); }, [unit?.id, intent, contract]);
    const availableContext = snapshot.documents.flatMap(item => item.units)
        .filter(candidate => candidate.identity === 'durable' && candidate.id !== unit?.id && !dependencies.includes(candidate.id));
    const namedDependency = (id: string) => snapshot.documents.flatMap(item => item.units).find(candidate => candidate.id === id);
    const action = (value: unknown) => vscode?.postMessage({ type: 'action', action: value, revision: snapshot.revision });
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
                        <dt>Intent</dt><dd><textarea value={intentDraft} onChange={event => setIntentDraft(event.target.value)} aria-label="Function intent" /></dd>
                        <dt>Contract</dt><dd><textarea value={contractDraft} onChange={event => setContractDraft(event.target.value)} aria-label="Function contract" /></dd>
                    </dl>
                    <div className="harness-inspector__actions">
                        <button className="secondary" onClick={() => action({ kind: 'setAnnotationField', target: unit.id, field: 'intent', text: intentDraft })}>Save intent</button>
                        <button className="secondary" onClick={() => action({ kind: 'setAnnotationField', target: unit.id, field: 'contract', text: contractDraft })}>Save contract</button>
                    </div>
                    <section className="context-workbench">
                        <h3>Required context</h3>
                        <p>Reference material only; this does not imply an import or call dependency.</p>
                        <div className="context-chips">
                            {dependencies.map(id => {
                                const dependency = namedDependency(id);
                                return <button key={id} title={`Remove ${dependency?.qualifiedName ?? id}`} onClick={() => action({ kind: 'setContext', consumer: unit.id, dependency: id, enabled: false })}>{dependency?.qualifiedName ?? id} ×</button>;
                            })}
                            {dependencies.length === 0 && <span>None</span>}
                        </div>
                        <div className="context-picker">
                            <select value={contextChoice} onChange={event => setContextChoice(event.target.value)} aria-label="Add context">
                                <option value="">Add context…</option>
                                {availableContext.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.qualifiedName}</option>)}
                            </select>
                            <button className="secondary" disabled={!contextChoice} onClick={() => {
                                action({ kind: 'setContext', consumer: unit.id, dependency: contextChoice, enabled: true });
                                setContextChoice('');
                            }}>Add</button>
                        </div>
                    </section>
                    <section className="packet-preview">
                        <h3>Exact packet</h3>
                        {packetError && <p className="error">{packetError}</p>}
                        {packet && <>
                            <p>{packet.estimatedInputTokens} / {packet.inputBudgetTokens} estimated input tokens · {packet.outputBudgetTokens} reserved output</p>
                            <ul>{packet.items.map(item => <li key={`${item.role}:${item.id}`}><strong>{item.role === 'target' ? 'TARGET' : 'CONTEXT'}</strong> {item.qualifiedName} <small>{item.path} · {item.characters} chars</small></li>)}</ul>
                        </>}
                    </section>
                    {generation && <div className="generation-activity"><span className="spinner" />{generation}<button className="secondary" onClick={() => vscode?.postMessage({ type: 'cancelGeneration' })}>Cancel</button></div>}
                    {proposal?.unitId === unit.id && <section className="proposal-review">
                        <h3>Confined proposal</h3>
                        {proposal.staleMessage && <p className="error">{proposal.staleMessage}</p>}
                        <pre>{proposal.candidate}</pre>
                        <ul>{proposal.checks.map(check => <li key={check}>✓ {check}</li>)}</ul>
                        <button disabled={Boolean(proposal.staleMessage)} onClick={() => vscode?.postMessage({ type: 'acceptProposal', proposalId: proposal.id })}>Accept WorkspaceEdit</button>
                    </section>}
                    {!generation && (!proposal || proposal.unitId !== unit.id) && <button disabled={!packet} onClick={() => vscode?.postMessage({ type: 'generate', unitId: unit.id })}>Generate with llama.cpp</button>}
                    {accepted && <button className="secondary" onClick={() => vscode?.postMessage({ type: 'undoAccepted' })}>Undo accepted edit</button>}
                    <button onClick={() => vscode?.postMessage({ type: 'reveal', unitId: unit.id, focus: true })}>
                        Edit in code
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
    const [searchMode, setSearchMode] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<HarnessSearchResult[]>([]);
    const [history, setHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [packets, setPackets] = useState<Record<string, { packet?: PacketPreview; error?: string }>>({});
    const [generation, setGeneration] = useState<{ unitId: string; message: string } | null>(null);
    const [proposal, setProposal] = useState<HarnessProposal | null>(null);
    const [acceptedUnitId, setAcceptedUnitId] = useState<string | null>(null);
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
            if (event.data.type === 'commandResult') setCommandResult(event.data.message);
            if (event.data.type === 'searchResults') {
                setSearchMode(false);
                setSearchQuery(event.data.query);
                setSearchResults(event.data.results);
                setCommandResult(event.data.stale
                    ? 'SEARCH: source graph changed; search again'
                    : `SEARCH: ${event.data.results.length} result${event.data.results.length === 1 ? '' : 's'} for “${event.data.query}”`);
            }
            if (event.data.type === 'packetPreview') {
                setPackets(current => ({ ...current, [event.data.unitId]: { packet: event.data.packet, error: event.data.error } }));
            }
            if (event.data.type === 'generationStarted') {
                setProposal(null);
                setAcceptedUnitId(null);
                setGeneration({ unitId: event.data.unitId, message: event.data.message });
            }
            if (event.data.type === 'generationProgress') {
                setGeneration(current => current?.unitId === event.data.unitId
                    ? { ...current, message: `Receiving candidate from llama.cpp… ${event.data.receivedCharacters} characters` }
                    : current);
            }
            if (event.data.type === 'generationFailed') {
                setGeneration(null);
                setCommandResult(`GENERATE: ${event.data.message}`);
            }
            if (event.data.type === 'proposalReady') { setGeneration(null); setProposal(event.data.proposal); }
            if (event.data.type === 'proposalStale') {
                setProposal(current => current?.id === event.data.proposalId ? { ...current, staleMessage: event.data.message } : current);
            }
            if (event.data.type === 'proposalAccepted') {
                setProposal(null);
                setAcceptedUnitId(event.data.unitId);
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
        const unitId = selected?.data.unit?.id;
        if (unitId) vscode?.postMessage({ type: 'packetPreview', unitId });
    }, [selected?.data.unit?.id, snapshot.revision]);

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

    useEffect(() => {
        const focusSelectedUnit = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (event.key !== 'Enter' || target?.matches('input, textarea, button, [contenteditable="true"]')) return;
            if (!selected?.data.unit) return;
            event.preventDefault();
            vscode?.postMessage({ type: 'reveal', unitId: selected.data.unit.id, focus: true });
        };
        window.addEventListener('keydown', focusSelectedUnit);
        return () => window.removeEventListener('keydown', focusSelectedUnit);
    }, [selected?.data.unit]);

    const runCommand = () => {
        const raw = query.trim();
        const searchText = searchMode
            ? raw
            : raw.toLowerCase().startsWith('/search')
                ? raw.slice('/search'.length).trim()
                : raw.toUpperCase().startsWith('SEARCH ')
                    ? raw.slice('SEARCH '.length).trim()
                    : null;
        if (searchText !== null) {
            if (!searchText) {
                setSearchMode(true);
                setCommandResult('SEARCH: what should Slate find?');
            } else if (vscode) {
                vscode.postMessage({ type: 'search', query: searchText, revision: snapshot.revision });
                setCommandResult(`SEARCH: scanning indexed source for “${searchText}”…`);
            } else {
                setCommandResult('SEARCH: requires the VS Code extension');
            }
            setQuery('');
            return;
        }
        if (raw.toLowerCase() === '/search' || raw.toUpperCase() === 'SEARCH') {
            setSearchMode(true);
            setQuery('');
            setCommandResult('SEARCH: what should Slate find?');
            return;
        }
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
        } else if (command.name === 'REVEAL' || command.name === 'EDIT') {
            const matches = argument
                ? resolveTargets(targets, argument)
                : selectedNodes;
            const match = matches.length === 1 ? nodes.find(node => node.id === matches[0].id) : undefined;
            if (match?.data.unit) {
                vscode?.postMessage({ type: 'reveal', unitId: match.data.unit.id, focus: command.name === 'EDIT' });
                setCommandResult(`${command.name}: ${match.data.unit.qualifiedName}`);
            } else {
                setCommandResult(matches.length > 1 ? `${command.name}: selection is ambiguous` : `${command.name}: select one code unit`);
            }
        } else if (command.name === 'HELP') {
            setCommandResult(commandHelp(command.args[0]));
        } else if (['STUB', 'INTENT', 'CONTRACT', 'CONTEXT', 'UNCONTEXT', 'LOCK', 'COMPILE', 'RECOMPILE', 'SAVE'].includes(command.name)) {
            const action = commandToAction(command);
            if (!action) {
                setCommandResult(`INVALID ACTION: ${commandHelp(command.name)}`);
            } else if (vscode) {
                vscode.postMessage({ type: 'action', action, revision: snapshot.revision });
                setCommandResult(`${command.name}: working…`);
            } else {
                setCommandResult(`${command.name}: requires the VS Code extension`);
            }
        } else {
            setCommandResult(`UNKNOWN COMMAND: ${command.name}`);
        }
        setQuery('');
    };

    const completions = searchMode ? [] : commandCompletions(query);

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
                    onNodeClick={(_, node) => {
                        if (node.data.unit) vscode?.postMessage({ type: 'reveal', unitId: node.data.unit.id, focus: false });
                    }}
                    onNodeDoubleClick={(_, node) => {
                        if (node.data.unit) vscode?.postMessage({ type: 'reveal', unitId: node.data.unit.id, focus: true });
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
            {searchQuery && (
                <section className="harness-search-results" aria-label={`Search results for ${searchQuery}`}>
                    <header>
                        <strong>Results for “{searchQuery}”</strong>
                        <button aria-label="Close search results" onClick={() => { setSearchQuery(''); setSearchResults([]); }}>×</button>
                    </header>
                    {searchResults.length === 0 && <p className="harness-search-results__empty">No indexed code matched.</p>}
                    <div className="harness-search-results__list">
                        {searchResults.map(result => (
                            <button
                                key={`${result.path}:${result.unitId}`}
                                className="harness-search-result"
                                onClick={() => {
                                    setNodes(current => current.map(node => ({ ...node, selected: node.id === result.unitId })));
                                    const node = nodes.find(candidate => candidate.id === result.unitId);
                                    if (node) flow.current?.setCenter(node.position.x + 130, node.position.y + 36, { zoom: 1.2, duration: 300 });
                                    vscode?.postMessage({ type: 'reveal', unitId: result.unitId, focus: false });
                                }}
                                onDoubleClick={() => vscode?.postMessage({ type: 'reveal', unitId: result.unitId, focus: true })}
                            >
                                <span><strong>{result.qualifiedName}</strong><small>{result.reason} match</small></span>
                                <code>{result.path} · {result.signature ?? 'class'}</code>
                                <em>{result.snippet}</em>
                            </button>
                        ))}
                    </div>
                </section>
            )}
            {selected && <Inspector
                node={selected}
                document={selectedDocument}
                snapshot={snapshot}
                packet={selected.data.unit ? packets[selected.data.unit.id]?.packet : undefined}
                packetError={selected.data.unit ? packets[selected.data.unit.id]?.error : undefined}
                generation={generation?.unitId === selected.data.unit?.id ? generation.message : null}
                proposal={proposal}
                accepted={acceptedUnitId === selected.data.unit?.id}
            />}
            <div className="harness-commandline">
                <div className="harness-commandline__result">{commandResult}</div>
                {query && completions.length > 0 && (
                    <div className="harness-commandline__completions">{completions.join('   ')}</div>
                )}
                <div className="harness-command">
                    <span>{searchMode ? 'SEARCH:' : 'ACTION:'}</span>
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
                            if (event.key === 'Escape') { setQuery(''); setSearchMode(false); setHistoryIndex(-1); }
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
                        placeholder={searchMode ? 'Name, signature, annotation, or source text' : 'Type /search or HELP'}
                        aria-label={searchMode ? 'Search indexed code' : 'Slate action'}
                        autoComplete="off"
                        spellCheck={false}
                    />
                </div>
            </div>
        </main>
    );
}

createRoot(document.getElementById('harness-root')!).render(<HarnessApp />);
