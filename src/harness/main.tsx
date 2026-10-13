import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
    Background,
    BackgroundVariant,
    PanOnScrollMode,
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
import { basicSetup, EditorView } from 'codemirror';
import { python } from '@codemirror/lang-python';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

import { demoSnapshot } from './demo';
import { buildGraph, nodeIdOf, SlateNodeData } from './graph';
import { rankPalette, type Rankable } from './palette';
import type { HarnessDocument, HarnessProposal, HarnessSearchResult, HarnessSnapshot, HarnessUnit, HostMessage, PacketPreview } from './types';
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

function InlineIntent({ unitId, intent }: { unitId: string; intent: string }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(intent);
    useEffect(() => { if (!editing) setDraft(intent); }, [intent, editing]);
    const save = () => {
        setEditing(false);
        if (draft.trim() !== intent.trim()) {
            vscode?.postMessage({ type: 'action', action: { kind: 'setAnnotationField', target: unitId, field: 'intent', text: draft } });
        }
    };
    if (editing) {
        return <textarea
            className="slate-node__intent-edit nodrag nopan nowheel"
            aria-label="Edit intent"
            autoFocus
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onBlur={save}
            onDoubleClick={event => event.stopPropagation()}
            onKeyDown={event => {
                event.stopPropagation();
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); save(); }
                if (event.key === 'Escape') { setDraft(intent); setEditing(false); }
            }}
        />;
    }
    return <p
        className={`slate-node__intent nodrag ${intent ? '' : 'is-empty'}`}
        title="Click to edit intent"
        onClick={() => setEditing(true)}
        onDoubleClick={event => event.stopPropagation()}
    >{intent || 'add intent…'}</p>;
}

function SlateNode({ data, selected }: NodeProps<Node<SlateNodeData>>) {
    const colorStyle = { '--slate-group': data.groupColor } as React.CSSProperties;
    return (
        <div
            className={`slate-node slate-node--${data.kind} ${data.container ? 'slate-node--container' : ''} ${selected ? 'is-selected' : ''} ${data.invalid ? 'is-invalid' : ''} ${data.stale ? 'is-stale' : ''}`}
            style={colorStyle}
        >
            {!data.container && data.kind !== 'module' && <Handle type="target" position={Position.Left} className="slate-node__handle" />}
            <div className="slate-node__kind">
                <span>{data.kind.replace('_', ' ')}</span>
                <span>
                    {data.problem && <span className="slate-node__problem" title={data.problem}>!&nbsp;</span>}
                    {data.unit?.annotation?.locked === true && <span title="Generation is locked">LOCKED&nbsp;</span>}
                    {data.identity === 'provisional' && <span title="Not yet anchored with a Slate ID">◇</span>}
                </span>
            </div>
            <strong>{data.label}</strong>
            {!data.container && <code>{data.detail}</code>}
            {data.editableIntent && data.unit && !data.container
                ? <InlineIntent unitId={data.unit.id} intent={data.intent ?? ''} />
                : data.intent && !data.container && <p className="slate-node__intent">{data.intent}</p>}
            {!data.container && data.kind !== 'module' && <Handle type="source" position={Position.Right} className="slate-node__handle" />}
        </div>
    );
}

const nodeTypes = { slate: SlateNode };

const editorTheme = EditorView.theme({
    '&': { fontSize: '11px', backgroundColor: 'var(--strata-bg, #101214)', color: 'var(--strata-text-primary, #f3f4f6)' },
    '.cm-gutters': { backgroundColor: 'var(--strata-layer-01, #191d21)', color: 'var(--strata-text-secondary, #9da5ad)', border: 'none' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgba(98, 217, 255, 0.06)' },
    '&.cm-focused': { outline: '1px solid var(--strata-info, #62d9ff)' },
    '.cm-content': { caretColor: 'var(--strata-info, #62d9ff)' },
}, { dark: true });

const editorHighlight = syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword], color: '#c792ea' },
    { tag: [tags.function(tags.variableName), tags.function(tags.definition(tags.variableName))], color: '#62d9ff' },
    { tag: [tags.definition(tags.variableName), tags.variableName], color: '#e6edf3' },
    { tag: [tags.typeName, tags.className], color: '#f6c453' },
    { tag: [tags.string], color: '#a5e075' },
    { tag: [tags.number, tags.bool, tags.null], color: '#f78c6c' },
    { tag: [tags.comment], color: '#7f8a96', fontStyle: 'italic' },
    { tag: [tags.operator, tags.punctuation], color: '#9da5ad' },
]));

function CodeEditor({ initial, onChange }: { initial: string; onChange(value: string): void }) {
    const host = useRef<HTMLDivElement | null>(null);
    const change = useRef(onChange);
    change.current = onChange;
    useEffect(() => {
        const view = new EditorView({
            doc: initial,
            parent: host.current!,
            extensions: [
                basicSetup, python(), editorTheme, editorHighlight,
                EditorView.updateListener.of(update => { if (update.docChanged) change.current(update.state.doc.toString()); }),
            ],
        });
        return () => view.destroy();
    }, [initial]);
    return <div className="node-code-editor" ref={host} aria-label="Node code" />;
}

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
    const note = node.data.note;
    const intent = typeof unit?.annotation?.intent === 'string' ? unit.annotation.intent : '';
    const contract = typeof unit?.annotation?.contract === 'string' ? unit.annotation.contract : '';
    const dependencies = Array.isArray(unit?.annotation?.dependencies)
        ? unit.annotation.dependencies.filter(value => typeof value === 'string')
        : [];
    const [intentDraft, setIntentDraft] = useState(intent);
    const [contractDraft, setContractDraft] = useState(contract);
    const [noteTitle, setNoteTitle] = useState(note?.title ?? '');
    const [noteBody, setNoteBody] = useState(note?.body ?? '');
    const [noteAttachment, setNoteAttachment] = useState(note?.attachedTo ?? '');
    const nodeCode = unit?.parentId === null || node.data.kind === 'module' ? document?.source ?? '' : null;
    const [codeDraft, setCodeDraft] = useState(nodeCode ?? '');
    useEffect(() => { setCodeDraft(nodeCode ?? ''); }, [unit?.id, document?.sourceHash]);
    useEffect(() => { setIntentDraft(intent); setContractDraft(contract); }, [unit?.id, intent, contract]);
    useEffect(() => {
        setNoteTitle(note?.title ?? '');
        setNoteBody(note?.body ?? '');
        setNoteAttachment(note?.attachedTo ?? '');
    }, [note?.id, note?.title, note?.body, note?.attachedTo]);
    const availableContext = snapshot.documents.flatMap(item => item.units)
        .filter(candidate => candidate.identity === 'durable' && candidate.id !== unit?.id && !dependencies.includes(candidate.id)
            && candidate.parentId === null);
    const namedDependency = (id: string) => snapshot.documents.flatMap(item => item.units).find(candidate => candidate.id === id);
    const action = (value: unknown) => vscode?.postMessage({ type: 'action', action: value, revision: snapshot.revision });
    return (
        <aside className="harness-inspector harness-inspector--wide" aria-label="Selected node details">
            <div className="harness-inspector__eyebrow">{node.data.kind.replace('_', ' ')}</div>
            <h2>{node.data.label}</h2>
            <code className="harness-inspector__path">{node.data.path}</code>
            {note && <>
                <p className="board-note-explainer">Board notes stay in Slate project metadata and never modify Python source.</p>
                <label className="board-note-field">Title
                    <input aria-label="Note title" value={noteTitle} onChange={event => setNoteTitle(event.target.value)} />
                </label>
                <label className="board-note-field">Note
                    <textarea aria-label="Note body" value={noteBody} onChange={event => setNoteBody(event.target.value)} />
                </label>
                <label className="board-note-field">Attached function
                    <select aria-label="Attach note to function" value={noteAttachment} onChange={event => setNoteAttachment(event.target.value)}>
                        <option value="">Unattached board note</option>
                        {snapshot.documents.flatMap(item => item.units).map(candidate => (
                            <option key={candidate.id} value={candidate.id}>{candidate.qualifiedName} · {candidate.signature ?? candidate.kind}</option>
                        ))}
                    </select>
                </label>
                <button onClick={() => vscode?.postMessage({
                    type: 'noteUpdate', revision: snapshot.revision, noteId: note.id,
                    title: noteTitle, body: noteBody, attachedTo: noteAttachment || null,
                })}>Save board note</button>
                <button className="danger" onClick={() => vscode?.postMessage({
                    type: 'noteDelete', revision: snapshot.revision, noteId: note.id,
                })}>Delete board note</button>
            </>}
            {node.data.kind === 'module' && nodeCode !== null && <section className="node-code">
                <p>{document?.nodeKind === 'prelude'
                    ? 'Module-level statements that compile right after the imports, before the nodes.'
                    : 'Module-level statements that compile after the nodes, such as the main guard.'}</p>
                <CodeEditor key={`${node.id}:${document?.sourceHash}`} initial={nodeCode} onChange={setCodeDraft} />
                <div className="harness-inspector__actions">
                    <button disabled={codeDraft === nodeCode} onClick={() => action({
                        kind: 'setNodeCode', target: node.id, code: codeDraft, baseHash: document?.sourceHash,
                    })}>Save code</button>
                </div>
            </section>}
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
                    {document && document.diagnostics.length > 0 && <div className="harness-inspector__diagnostic">
                        {document.diagnostics.map(item => <p key={`${item.code}:${item.message}`}>{item.message}</p>)}
                    </div>}
                    {nodeCode !== null && <section className="node-code">
                        <h3>Code</h3>
                        <CodeEditor key={`${unit.id}:${document?.sourceHash}`} initial={nodeCode} onChange={setCodeDraft} />
                        <div className="harness-inspector__actions">
                            <button disabled={codeDraft === nodeCode} onClick={() => action({
                                kind: 'setNodeCode', target: unit.id, code: codeDraft, baseHash: document?.sourceHash,
                            })}>Save code</button>
                            <button className="secondary" onClick={() => action({
                                kind: 'setLock', target: unit.id, locked: unit.annotation?.locked !== true,
                            })}>{unit.annotation?.locked === true ? 'Unlock' : 'Lock'}</button>
                        </div>
                    </section>}
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
                        <ContextPicker
                            candidates={availableContext}
                            onPick={id => action({ kind: 'setContext', consumer: unit.id, dependency: id, enabled: true })}
                        />
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
                    <button className="secondary" onClick={() => vscode?.postMessage({ type: 'reveal', unitId: unit.id, focus: true })}>
                        Open node file
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

function ContextPicker({ candidates, onPick }: { candidates: HarnessUnit[]; onPick(id: string): void }) {
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const [index, setIndex] = useState(0);
    const ranked = useMemo(() => rankPalette(candidates.map(candidate => ({
        id: candidate.id,
        label: candidate.qualifiedName,
        detail: candidate.signature,
        keywords: typeof candidate.annotation?.intent === 'string' ? candidate.annotation.intent : undefined,
        group: 'node' as const,
    })), query).slice(0, 8), [candidates, query]);
    useEffect(() => setIndex(0), [query]);
    const pick = (id: string | undefined) => {
        if (!id) return;
        onPick(id);
        setQuery('');
        setOpen(false);
    };
    return <div className="context-picker">
        <input
            aria-label="Add context"
            placeholder="Add context… (type to search nodes)"
            value={query}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            onChange={event => { setQuery(event.target.value); setOpen(true); }}
            onKeyDown={event => {
                if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(current => Math.min(ranked.length - 1, current + 1)); }
                if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(current => Math.max(0, current - 1)); }
                if (event.key === 'Enter') { event.preventDefault(); pick(ranked[index]?.id); }
                if (event.key === 'Escape') setOpen(false);
            }}
            autoComplete="off"
            spellCheck={false}
        />
        {open && <ul role="listbox" aria-label="Context candidates">
            {ranked.map((entry, position) => <li
                key={entry.id}
                role="option"
                aria-selected={position === index}
                onMouseDown={event => { event.preventDefault(); pick(entry.id); }}
            >
                <span>{entry.label}</span>
                {entry.keywords && <small>{entry.keywords}</small>}
            </li>)}
            {ranked.length === 0 && <li className="palette__empty">No matching nodes.</li>}
        </ul>}
    </div>;
}

type BoardMenuState = {
    screenX: number;
    screenY: number;
    flowX: number;
    flowY: number;
    node: Node<SlateNodeData> | null;
    /** A right-clicked context edge: dependency → consumer. */
    edge?: { dependency: string; consumer: string };
};

function BoardContextMenu({ menu, snapshot, onClose, onFit, onSelect }: {
    menu: BoardMenuState;
    snapshot: HarnessSnapshot;
    onClose(): void;
    onFit(): void;
    onSelect(id: string): void;
}) {
    const unit = menu.node?.data.unit;
    const note = menu.node?.data.note;
    const createNote = (attachedTo: string | null) => {
        vscode?.postMessage({
            type: 'noteCreate', revision: snapshot.revision,
            x: menu.flowX, y: menu.flowY, attachedTo,
        });
        onClose();
    };
    return <div
        className="board-context-menu"
        role="menu"
        aria-label={menu.edge ? 'Context edge actions' : menu.node ? `${menu.node.data.kind} actions` : 'Board actions'}
        style={{ left: Math.min(menu.screenX, window.innerWidth - 240), top: Math.min(menu.screenY, window.innerHeight - 200) }}
    >
        {menu.edge && <>
            <div className="board-context-menu__label">{menu.edge.dependency} → {menu.edge.consumer}</div>
            <button role="menuitem" className="danger" onClick={() => {
                vscode?.postMessage({ type: 'action', revision: snapshot.revision, action: {
                    kind: 'setContext', consumer: menu.edge!.consumer, dependency: menu.edge!.dependency, enabled: false,
                } });
                onClose();
            }}>Remove context</button>
        </>}
        {!menu.node && !menu.edge && <>
            <button role="menuitem" onClick={() => {
                vscode?.postMessage({ type: 'action', action: { kind: 'createNode', x: menu.flowX, y: menu.flowY }, revision: snapshot.revision });
                onClose();
            }}>New node…</button>
            <button role="menuitem" onClick={() => createNote(null)}>New board note</button>
            <button role="menuitem" onClick={() => { onFit(); onClose(); }}>Fit project to view</button>
            <button role="menuitem" onClick={() => {
                vscode?.postMessage({ type: 'action', action: { kind: 'refreshIndex' }, revision: snapshot.revision });
                onClose();
            }}>Refresh source index</button>
        </>}
        {unit && <>
            <div className="board-context-menu__label">{unit.qualifiedName}</div>
            <button role="menuitem" onClick={() => createNote(unit.id)}>Add note attached here</button>
            <button role="menuitem" onClick={() => {
                vscode?.postMessage({ type: 'reveal', unitId: unit.id, focus: true });
                onClose();
            }}>Open node file</button>
            {['function', 'method'].includes(unit.kind) && <button role="menuitem" onClick={() => {
                vscode?.postMessage({ type: 'generate', unitId: unit.id });
                onClose();
            }}>Generate implementation</button>}
        </>}
        {note && <>
            <div className="board-context-menu__label">{note.title}</div>
            <button role="menuitem" onClick={() => { onSelect(note.id); onClose(); }}>Edit board note</button>
            <button role="menuitem" className="danger" onClick={() => {
                vscode?.postMessage({ type: 'noteDelete', revision: snapshot.revision, noteId: note.id });
                onClose();
            }}>Delete board note</button>
        </>}
    </div>;
}

type PaletteEntry = Rankable & { id: string; run(): void };

const GROUP_LABELS: Record<PaletteEntry['group'], string> = {
    selection: 'Selected', canvas: 'Canvas', node: 'Go to', search: 'Search',
};

function CommandPalette({ items, query, setQuery, onClose }: {
    items: PaletteEntry[];
    query: string;
    setQuery(value: string): void;
    onClose(): void;
}) {
    const [index, setIndex] = useState(0);
    const ranked = useMemo(() => rankPalette(items, query).slice(0, 60), [items, query]);
    const list = useRef<HTMLUListElement | null>(null);
    useEffect(() => setIndex(0), [query]);
    useEffect(() => {
        list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [index]);
    const run = (entry: PaletteEntry | undefined) => {
        if (!entry) return;
        onClose();
        entry.run();
    };
    return <div className="palette-backdrop" onMouseDown={onClose}>
        <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={event => event.stopPropagation()}>
            <input
                autoFocus
                aria-label="Command palette input"
                placeholder="Type a command, a node name, or text to search code…"
                value={query}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                    if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(current => Math.min(ranked.length - 1, current + 1)); }
                    if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(current => Math.max(0, current - 1)); }
                    if (event.key === 'Enter') { event.preventDefault(); run(ranked[index]); }
                    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
                }}
                autoComplete="off"
                spellCheck={false}
            />
            <ul role="listbox" aria-label="Commands" ref={list}>
                {ranked.map((entry, position) => <li
                    key={entry.id}
                    role="option"
                    aria-selected={position === index}
                    onMouseEnter={() => setIndex(position)}
                    onClick={() => run(entry)}
                >
                    <span>{entry.label}</span>
                    <small>{entry.detail ?? GROUP_LABELS[entry.group]}</small>
                </li>)}
                {ranked.length === 0 && <li className="palette__empty">Nothing matches.</li>}
            </ul>
        </div>
    </div>;
}

function HarnessApp() {
    const search = new URLSearchParams(window.location.search);
    const showDemo = import.meta.env.DEV && search.has('demo');
    const [snapshot, setSnapshot] = useState<HarnessSnapshot>(showDemo
        ? demoSnapshot
        : { revision: 0, projectName: 'Slate', documents: [] });
    const [paletteQuery, setPaletteQuery] = useState('');
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [commandResult, setCommandResult] = useState('Ready — press ⌘K for commands');
    const [describing, setDescribing] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<HarnessSearchResult[]>([]);
    const [packets, setPackets] = useState<Record<string, { packet?: PacketPreview; error?: string }>>({});
    const [generation, setGeneration] = useState<{ unitId: string; message: string } | null>(null);
    const [proposal, setProposal] = useState<HarnessProposal | null>(null);
    const [acceptedUnitId, setAcceptedUnitId] = useState<string | null>(null);
    const [boardMenu, setBoardMenu] = useState<BoardMenuState | null>(null);
    const flow = useRef<ReactFlowInstance<Node<SlateNodeData>, Edge> | null>(null);
    const graph = useMemo(() => buildGraph(snapshot), [snapshot]);
    const [nodes, setNodes, onNodesChange] = useNodesState<Node<SlateNodeData>>(graph.nodes);
    const selectedNodes = nodes.filter(node => node.selected);
    const selected = selectedNodes[0] ?? null;
    const selectedDocument = selected
        ? snapshot.documents.find(document => nodeIdOf(document.path) === selected.data.path)
        : undefined;
    const invalidCount = snapshot.documents.filter(document => !document.valid).length;
    const staleCount = snapshot.documents.filter(document => document.stale).length;
    const contextCount = graph.edges.filter(edge => edge.id.startsWith('context:')).length;
    const noteCount = snapshot.notes?.length ?? 0;

    useEffect(() => {
        const onMessage = (event: MessageEvent<HostMessage>) => {
            const data = event.data;
            if (!data || typeof data !== 'object') return;
            if (data.type === 'snapshot') setSnapshot(data.snapshot);
            if (data.type === 'selectUnit') {
                setNodes(current => current.map(node => ({
                    ...node,
                    selected: node.id === data.unitId,
                })));
            }
            if (data.type === 'commandResult') setCommandResult(data.message);
            if (data.type === 'searchResults') {
                setSearchQuery(data.query);
                setSearchResults(data.results);
                setCommandResult(data.stale
                    ? 'Search: the graph changed; search again'
                    : `Search: ${data.results.length} result${data.results.length === 1 ? '' : 's'} for “${data.query}”`);
            }
            if (data.type === 'packetPreview') {
                setPackets(current => ({ ...current, [data.unitId]: { packet: data.packet, error: data.error } }));
            }
            if (data.type === 'generationStarted') {
                setProposal(null);
                setAcceptedUnitId(null);
                setGeneration({ unitId: data.unitId, message: data.message });
            }
            if (data.type === 'generationProgress') {
                setGeneration(current => current?.unitId === data.unitId
                    ? { ...current, message: `Receiving candidate from llama.cpp… ${data.receivedCharacters} characters` }
                    : current);
            }
            if (data.type === 'generationFailed') {
                setGeneration(null);
                setCommandResult(`Generate: ${data.message}`);
            }
            if (data.type === 'proposalReady') { setGeneration(null); setProposal(data.proposal); }
            if (data.type === 'proposalStale') {
                setProposal(current => current?.id === data.proposalId ? { ...current, staleMessage: data.message } : current);
            }
            if (data.type === 'proposalAccepted') {
                setProposal(null);
                setAcceptedUnitId(data.unitId);
            }
            if (data.type === 'describeState') setDescribing(data.running);
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
        const openPalette = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                setPaletteQuery('');
                setPaletteOpen(open => !open);
                return;
            }
            const target = event.target as HTMLElement | null;
            if (target?.matches('input, textarea, [contenteditable="true"]') || target?.closest('.cm-editor')) return;
            if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
            event.preventDefault();
            setPaletteQuery('');
            setPaletteOpen(true);
        };
        window.addEventListener('keydown', openPalette);
        return () => window.removeEventListener('keydown', openPalette);
    }, []);

    useEffect(() => {
        const focusSelectedUnit = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (event.key !== 'Enter' || target?.matches('input, textarea, button, [contenteditable="true"]') || target?.closest('.cm-editor')) return;
            if (!selected?.data.unit) return;
            event.preventDefault();
            vscode?.postMessage({ type: 'reveal', unitId: selected.data.unit.id, focus: true });
        };
        window.addEventListener('keydown', focusSelectedUnit);
        return () => window.removeEventListener('keydown', focusSelectedUnit);
    }, [selected?.data.unit]);

    useEffect(() => {
        if (!boardMenu) return;
        const close = () => setBoardMenu(null);
        const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
        window.addEventListener('click', close);
        window.addEventListener('keydown', escape);
        return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', escape); };
    }, [boardMenu]);

    const selectNode = (id: string) => setNodes(current => current.map(node => ({ ...node, selected: node.id === id })));

    const openBoardMenu = (event: React.MouseEvent | MouseEvent, node: Node<SlateNodeData> | null) => {
        event.preventDefault();
        event.stopPropagation();
        const point = flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY })
            ?? { x: event.clientX, y: event.clientY };
        if (node) selectNode(node.id);
        setBoardMenu({ screenX: event.clientX, screenY: event.clientY, flowX: point.x, flowY: point.y, node });
    };

    const isContextEndpoint = (id: string | null) => {
        const unit = id ? snapshot.documents.flatMap(document => document.units).find(candidate => candidate.id === id) : undefined;
        return Boolean(unit && unit.identity === 'durable' && unit.parentId === null);
    };
    const post = (action: Record<string, unknown>) => vscode?.postMessage({ type: 'action', action, revision: snapshot.revision });
    const centerOn = (id: string) => {
        selectNode(id);
        flow.current?.fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.2, padding: 0.8 });
    };
    const viewCenter = () => {
        const pane = document.querySelector('.react-flow__pane')?.getBoundingClientRect();
        return pane && flow.current
            ? flow.current.screenToFlowPosition({ x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 })
            : { x: 0, y: 0 };
    };
    const runSearch = (text: string) => {
        if (!vscode) { setCommandResult('Search needs the VS Code extension.'); return; }
        vscode.postMessage({ type: 'search', query: text, revision: snapshot.revision });
        setCommandResult(`Search: scanning for “${text}”…`);
    };

    const paletteItems = useMemo<PaletteEntry[]>(() => {
        const items: PaletteEntry[] = [];
        const units = snapshot.documents.flatMap(document => document.units);
        const unit = selected?.data.unit;
        if (unit) {
            const locked = unit.annotation?.locked === true;
            const dependencies = Array.isArray(unit.annotation?.dependencies)
                ? unit.annotation.dependencies.filter((value): value is string => typeof value === 'string')
                : [];
            items.push({ id: 'open', group: 'selection', label: `Open ${unit.name} in editor`,
                run: () => vscode?.postMessage({ type: 'reveal', unitId: unit.id, focus: true }) });
            if (['function', 'method'].includes(unit.kind)) {
                items.push({ id: 'generate', group: 'selection', label: `Generate ${unit.name} with llama.cpp`,
                    run: () => vscode?.postMessage({ type: 'generate', unitId: unit.id }) });
            }
            items.push({ id: 'lock', group: 'selection', label: `${locked ? 'Unlock' : 'Lock'} ${unit.name}`,
                run: () => post({ kind: 'setLock', target: unit.id, locked: !locked }) });
            items.push({ id: 'note-here', group: 'selection', label: `Add note attached to ${unit.name}`,
                run: () => {
                    const point = viewCenter();
                    vscode?.postMessage({ type: 'noteCreate', revision: snapshot.revision, x: point.x, y: point.y, attachedTo: unit.id });
                } });
            for (const candidate of units) {
                if (candidate.id === unit.id || candidate.identity !== 'durable' || candidate.parentId !== null) continue;
                const intent = typeof candidate.annotation?.intent === 'string' ? candidate.annotation.intent : undefined;
                if (dependencies.includes(candidate.id)) {
                    items.push({ id: `uncontext:${candidate.id}`, group: 'selection', label: `Remove context: ${candidate.qualifiedName}`, keywords: intent,
                        run: () => post({ kind: 'setContext', consumer: unit.id, dependency: candidate.id, enabled: false }) });
                } else {
                    items.push({ id: `context:${candidate.id}`, group: 'selection', label: `Add context: ${candidate.qualifiedName}`, keywords: intent,
                        run: () => post({ kind: 'setContext', consumer: unit.id, dependency: candidate.id, enabled: true }) });
                }
            }
        }
        items.push({ id: 'new-node', group: 'canvas', label: 'New node…', detail: 'Typed signature + intent',
            run: () => { const point = viewCenter(); post({ kind: 'createNode', x: point.x, y: point.y }); } });
        items.push(describing
            ? { id: 'describe-stop', group: 'canvas', label: 'Stop describing', run: () => post({ kind: 'cancelDescribe' }) }
            : { id: 'describe', group: 'canvas', label: 'Describe nodes with llama.cpp', detail: 'Fills missing intents, leaves first',
                run: () => post({ kind: 'describeNodes' }) });
        items.push({ id: 'compile', group: 'canvas', label: 'Compile project', detail: 'slate/ → Python modules',
            run: () => post({ kind: 'compile' }) });
        items.push(
            { id: 'new-note', group: 'canvas', label: 'New board note',
                run: () => { const point = viewCenter(); vscode?.postMessage({ type: 'noteCreate', revision: snapshot.revision, x: point.x, y: point.y, attachedTo: null }); } },
            { id: 'fit', group: 'canvas', label: 'Fit view', run: () => flow.current?.fitView({ padding: 0.2, duration: 300 }) },
            { id: 'refresh', group: 'canvas', label: 'Refresh index', run: () => post({ kind: 'refreshIndex' }) },
            { id: 'save', group: 'canvas', label: 'Save all files', run: () => post({ kind: 'saveWorkspace' }) },
            { id: 'clear', group: 'canvas', label: 'Clear selection', run: () => setNodes(current => current.map(node => ({ ...node, selected: false }))) },
        );
        for (const candidate of units) {
            items.push({
                id: `goto:${candidate.id}`, group: 'node', label: candidate.qualifiedName,
                detail: candidate.signature ?? candidate.kind.replace('_', ' '),
                keywords: typeof candidate.annotation?.intent === 'string' ? candidate.annotation.intent : undefined,
                run: () => centerOn(candidate.id),
            });
        }
        for (const note of snapshot.notes ?? []) {
            items.push({ id: `goto:${note.id}`, group: 'node', label: `Note: ${note.title}`, detail: note.body, run: () => centerOn(note.id) });
        }
        const text = paletteQuery.trim();
        if (text) items.push({ id: 'search', group: 'search', always: true, label: `Search code for “${text}”`, run: () => runSearch(text) });
        return items;
    }, [snapshot, selected?.data.unit, paletteQuery, describing]);

    return (
        <main className="harness-shell">
            <header className="harness-topbar">
                <div><strong>SLATE</strong><span>{snapshot.projectName}</span></div>
                <div className="harness-status">
                    <span>{snapshot.documents.length} nodes</span>
                    {noteCount > 0 && <span>{noteCount} note{noteCount === 1 ? '' : 's'}</span>}
                    {selectedNodes.length > 0 && <span>{selectedNodes.length} selected</span>}
                    {contextCount > 0 && <span className="status-context">{contextCount} context</span>}
                    {staleCount > 0 && <span className="status-warning">{staleCount} stale</span>}
                    {invalidCount > 0 && <span className="status-error">{invalidCount} invalid</span>}
                </div>
            </header>
            <section className="harness-canvas" aria-label="Python project graph">
                {graph.nodes.length === 0 && <div className="harness-empty">Right-click the canvas → New node… to start.</div>}
                <ReactFlow
                    nodes={nodes}
                    edges={graph.edges}
                    nodeTypes={nodeTypes}
                    onNodesChange={onNodesChange}
                    onInit={instance => { flow.current = instance; instance.fitView({ padding: 0.2 }); }}
                    onNodeDoubleClick={(_, node) => {
                        if (node.data.unit) vscode?.postMessage({ type: 'reveal', unitId: node.data.unit.id, focus: true });
                    }}
                    onNodeContextMenu={(event, node) => openBoardMenu(event, node)}
                    onPaneContextMenu={event => openBoardMenu(event, null)}
                    onPaneClick={() => setBoardMenu(null)}
                    onNodeDragStop={(_, node) => vscode?.postMessage({
                        type: 'layout',
                        revision: snapshot.revision,
                        positions: { [node.id]: node.position },
                    })}
                    fitView
                    minZoom={0.1}
                    maxZoom={2.5}
                    panOnScroll
                    panOnScrollMode={PanOnScrollMode.Free}
                    zoomOnScroll={false}
                    zoomOnPinch
                    panOnDrag={[0, 1]}
                    nodesDraggable
                    nodesConnectable
                    connectionLineStyle={{ stroke: 'var(--strata-info, #62d9ff)', strokeDasharray: '4 4' }}
                    isValidConnection={connection => isContextEndpoint(connection.source) && isContextEndpoint(connection.target)
                        && connection.source !== connection.target}
                    onConnect={connection => {
                        if (!connection.source || !connection.target) return;
                        vscode?.postMessage({ type: 'action', revision: snapshot.revision, action: {
                            kind: 'setContext', consumer: connection.target, dependency: connection.source, enabled: true,
                        } });
                        setCommandResult(`Context: ${connection.source} → ${connection.target}`);
                    }}
                    onEdgeContextMenu={(event, edge) => {
                        if (!edge.id.startsWith('context:')) return;
                        event.preventDefault();
                        setBoardMenu({ screenX: event.clientX, screenY: event.clientY, flowX: 0, flowY: 0, node: null,
                            edge: { dependency: edge.source, consumer: edge.target } });
                    }}
                    deleteKeyCode={null}
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
                generation={generation && generation.unitId === selected.data.unit?.id ? generation.message : null}
                proposal={proposal}
                accepted={acceptedUnitId === selected.data.unit?.id}
            />}
            {boardMenu && <BoardContextMenu
                menu={boardMenu}
                snapshot={snapshot}
                onClose={() => setBoardMenu(null)}
                onFit={() => flow.current?.fitView({ padding: 0.2, duration: 300 })}
                onSelect={selectNode}
            />}
            <footer className="harness-statusbar">
                <span className="harness-statusbar__result" role="status">{commandResult}</span>
                <button onClick={() => { setPaletteQuery(''); setPaletteOpen(true); }}>⌘K Commands</button>
            </footer>
            {paletteOpen && <CommandPalette
                items={paletteItems}
                query={paletteQuery}
                setQuery={setPaletteQuery}
                onClose={() => setPaletteOpen(false)}
            />}
        </main>
    );
}

createRoot(document.getElementById('harness-root')!).render(<HarnessApp />);
