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
import { buildGraph, callables, nodeIdOf, ROOT_SCOPE, typeColor, type CanvasScope, type SlateNodeData } from './graph';
import { inputPorts, outputPorts, type Port } from '../../vscode-extension/src/flow';
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

/** The flow the canvas shows (null = root), for node-local edits such as value literals. */
const ScopeContext = React.createContext<string | null>(null);

function PortRows({ inputs = [], outputs = [] }: { inputs?: Port[]; outputs?: Port[] }) {
    if (!inputs.length && !outputs.length) return null;
    const row = (port: Port, side: 'in' | 'out') => <div key={`${side}:${port.id}`} className={`slate-port slate-port--${side} ${port.name === '+' ? 'slate-port--add' : ''}`}>
        <Handle
            type={side === 'in' ? 'target' : 'source'}
            position={side === 'in' ? Position.Left : Position.Right}
            id={port.id}
            className="slate-port__handle"
            style={{ background: port.name === '+' ? 'transparent' : typeColor(port.annotation), borderColor: typeColor(port.annotation) }}
        />
        <span title={port.annotation ?? 'any'}>
            {port.name === '+' ? '+ new' : port.name}{port.optional && port.name !== '+' ? '?' : ''}
            {port.annotation && <small>{port.annotation}</small>}
        </span>
    </div>;
    return <div className="slate-ports">
        <div>{inputs.map(port => row(port, 'in'))}</div>
        <div>{outputs.map(port => row(port, 'out'))}</div>
    </div>;
}

function ValueEditor({ id, value }: { id: string; value: string }) {
    const flow = React.useContext(ScopeContext);
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    const save = () => {
        if (draft !== value) vscode?.postMessage({ type: 'action', action: { kind: 'setValue', flow, id, value: draft } });
    };
    return <input
        className="slate-node__value nodrag nopan"
        aria-label={`Value of ${id}`}
        value={draft}
        spellCheck={false}
        onChange={event => setDraft(event.target.value)}
        onBlur={save}
        onDoubleClick={event => event.stopPropagation()}
        onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'Enter') { event.preventDefault(); save(); (event.target as HTMLInputElement).blur(); }
            if (event.key === 'Escape') setDraft(value);
        }}
    />;
}

function SlateNode({ id, data, selected }: NodeProps<Node<SlateNodeData>>) {
    const colorStyle = { '--slate-group': data.groupColor } as React.CSSProperties;
    const plainHandles = data.kind === 'note';
    const kindLabel = data.kind === 'ref' ? 'reference' : data.kind === 'instance' ? (data.flowId ? 'flow' : 'node') : data.kind.replace('_', ' ');
    return (
        <div
            className={`slate-node slate-node--${data.kind} ${data.container ? 'slate-node--container' : ''} ${selected ? 'is-selected' : ''} ${data.invalid || data.broken ? 'is-invalid' : ''} ${data.stale ? 'is-stale' : ''} ${data.highlighted ? 'is-highlighted' : ''}`}
            style={colorStyle}
        >
            {data.contextPorts && !data.container && <Handle type="target" position={Position.Top} id="ctx-in" className="slate-node__ctx" title="Context in" />}
            {plainHandles && <Handle type="source" position={Position.Right} className="slate-node__handle" />}
            {data.kind !== 'folder' && <div className="slate-node__kind">
                <span>{kindLabel}</span>
                <span>
                    {data.problem && <span className="slate-node__problem" title={data.problem}>!&nbsp;</span>}
                    {data.broken && <span className="slate-node__problem" title="The target no longer exists">BROKEN&nbsp;</span>}
                    {data.unit?.annotation?.locked === true && data.kind !== 'ref' && data.kind !== 'instance' && <span title="Generation is locked">LOCKED&nbsp;</span>}
                    {data.identity === 'provisional' && <span title="Nested unit">◇</span>}
                </span>
            </div>}
            <strong>{data.label}</strong>
            {!data.container && data.kind !== 'value' && data.detail && <code>{data.detail}</code>}
            {data.kind === 'value' && <ValueEditor id={id} value={data.value ?? ''} />}
            {data.editableIntent && data.unit && !data.container
                ? <InlineIntent unitId={data.unit.id} intent={data.intent ?? ''} />
                : data.intent && !data.container && <p className="slate-node__intent">{data.intent}</p>}
            {!data.container && <PortRows inputs={data.inputs} outputs={data.outputs} />}
            {data.contextPorts && !data.container && <Handle type="source" position={Position.Bottom} id="ctx-out" className="slate-node__ctx" title="Context out: drag to a node's top to give it context" />}
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
    node, document, snapshot, packet, packetError, generation, proposal, accepted, onEnterFlow, onGoTo,
}: {
    onEnterFlow(flowId: string): void;
    onGoTo(target: string): void;
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
            {node.data.path && <code className="harness-inspector__path">{node.data.path}</code>}
            {!['function', 'class', 'method', 'nested_function', 'nested_class', 'note', 'module', 'document'].includes(node.data.kind) && <section className="canvas-item">
                <p>{node.data.kind === 'ref' ? `Reference to ${node.data.target}. Edits below change the definition.`
                    : node.data.kind === 'instance' ? `Calls ${node.data.target}.`
                    : node.data.kind === 'flow' ? `Flow slate/flows/${node.data.flowId}.json — compiles to def ${node.data.label}(…).`
                    : node.data.kind === 'placeholder' ? (node.data.resolvesTo ? `Resolves to ${node.data.resolvesTo}; right-click → Convert to reference.` : 'Not defined yet; right-click → Create node….')
                    : node.data.kind === 'value' ? 'A Python literal; edit it on the node.'
                    : node.data.detail}</p>
                {Boolean(node.data.inputs?.length || node.data.outputs?.length) && <dl>
                    {node.data.inputs?.filter(port => port.name !== '+').map(port => <React.Fragment key={port.id}><dt>in</dt><dd><code>{port.name}{port.annotation ? `: ${port.annotation}` : ''}{port.optional ? ' (optional)' : ''}</code></dd></React.Fragment>)}
                    {node.data.outputs?.filter(port => port.name !== '+').map(port => <React.Fragment key={port.id}><dt>out</dt><dd><code>{port.name}{port.annotation ? `: ${port.annotation}` : ''}</code></dd></React.Fragment>)}
                </dl>}
                <div className="harness-inspector__actions">
                    {node.data.flowId && <button onClick={() => onEnterFlow(node.data.flowId!)}>Open flow</button>}
                    {node.data.target && !node.data.broken && (node.data.kind === 'ref' || node.data.kind === 'instance') && <button className="secondary" onClick={() => onGoTo(node.data.target!)}>Go to definition</button>}
                </div>
            </section>}
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
    /** A right-clicked data wire (flow endpoints). */
    wire?: { from: string; to: string };
};

function BoardContextMenu({ menu, snapshot, scope, onClose, onFit, onSelect, onEnterFlow, onGoTo, onFindRefs, onAdd }: {
    menu: BoardMenuState;
    snapshot: HarnessSnapshot;
    scope: CanvasScope;
    onClose(): void;
    onFit(): void;
    onSelect(id: string): void;
    onEnterFlow(flowId: string): void;
    onGoTo(target: string): void;
    onFindRefs(target: string): void;
    onAdd(x: number, y: number): void;
}) {
    const node = menu.node;
    const data = node?.data;
    const unit = data?.kind !== 'ref' && data?.kind !== 'instance' ? data?.unit : undefined;
    const note = data?.note;
    const act = (action: Record<string, unknown>) => {
        vscode?.postMessage({ type: 'action', revision: snapshot.revision, action: { ...(scope.flow ? { flow: scope.flow } : {}), ...action } });
        onClose();
    };
    const createNote = (attachedTo: string | null) => {
        vscode?.postMessage({
            type: 'noteCreate', revision: snapshot.revision,
            x: menu.flowX, y: menu.flowY, attachedTo,
        });
        onClose();
    };
    const label = menu.edge ? 'Context edge actions' : menu.wire ? 'Wire actions' : node ? `${data!.kind} actions` : 'Board actions';
    return <div
        className="board-context-menu"
        role="menu"
        aria-label={label}
        style={{ left: Math.min(menu.screenX, window.innerWidth - 240), top: Math.min(menu.screenY, window.innerHeight - 260) }}
    >
        {menu.edge && <>
            <div className="board-context-menu__label">{menu.edge.dependency} → {menu.edge.consumer}</div>
            <button role="menuitem" className="danger" onClick={() => act({
                kind: 'setContext', consumer: menu.edge!.consumer, dependency: menu.edge!.dependency, enabled: false,
            })}>Remove context</button>
        </>}
        {menu.wire && <>
            <div className="board-context-menu__label">{menu.wire.from} → {menu.wire.to}</div>
            <button role="menuitem" className="danger" onClick={() => act({ kind: 'disconnectData', from: menu.wire!.from, to: menu.wire!.to })}>Remove wire</button>
        </>}
        {!node && !menu.edge && !menu.wire && <>
            <button role="menuitem" onClick={() => { onAdd(menu.flowX, menu.flowY); onClose(); }}>Add node…</button>
            {!scope.flow && <>
                <button role="menuitem" onClick={() => act({ kind: 'createNode', x: menu.flowX, y: menu.flowY })}>New node file…</button>
                <button role="menuitem" onClick={() => act({ kind: 'createPlaceholder', x: menu.flowX, y: menu.flowY })}>New placeholder…</button>
                <button role="menuitem" onClick={() => act({ kind: 'createFlow', x: menu.flowX, y: menu.flowY })}>New flow…</button>
                <button role="menuitem" onClick={() => createNote(null)}>New board note</button>
            </>}
            <button role="menuitem" onClick={() => { onFit(); onClose(); }}>Fit to view</button>
            {!scope.flow && <button role="menuitem" onClick={() => act({ kind: 'refreshIndex' })}>Refresh source index</button>}
        </>}
        {unit && <>
            <div className="board-context-menu__label">{unit.qualifiedName}</div>
            <button role="menuitem" onClick={() => createNote(unit.id)}>Add note attached here</button>
            <button role="menuitem" onClick={() => { onFindRefs(unit.id); onClose(); }}>Find references</button>
            <button role="menuitem" onClick={() => {
                vscode?.postMessage({ type: 'reveal', unitId: unit.id, focus: true });
                onClose();
            }}>Open node file</button>
            {['function', 'method'].includes(unit.kind) && <button role="menuitem" onClick={() => {
                vscode?.postMessage({ type: 'generate', unitId: unit.id });
                onClose();
            }}>Generate implementation</button>}
        </>}
        {(data?.kind === 'ref' || data?.kind === 'instance') && <>
            <div className="board-context-menu__label">{data.target}</div>
            {data.flowId && <button role="menuitem" onClick={() => { onEnterFlow(data.flowId!); onClose(); }}>Open flow</button>}
            {!data.broken && <button role="menuitem" onClick={() => { onGoTo(data.target!); onClose(); }}>Go to definition</button>}
            {!data.broken && <button role="menuitem" onClick={() => { onFindRefs(data.target!); onClose(); }}>Find references</button>}
            {data.unit && ['function', 'method'].includes(data.unit.kind) && data.path && <button role="menuitem" onClick={() => {
                vscode?.postMessage({ type: 'generate', unitId: data.target });
                onClose();
            }}>Generate body</button>}
            <button role="menuitem" className="danger" onClick={() => act({ kind: 'deleteItems', ids: [node!.id] })}>
                {data.kind === 'ref' ? 'Delete reference' : 'Remove from flow'}
            </button>
        </>}
        {data?.kind === 'placeholder' && <>
            <div className="board-context-menu__label">{data.label}</div>
            {data.resolvesTo && <button role="menuitem" onClick={() => act({ kind: 'placeholderToRef', id: node!.id })}>Convert to reference</button>}
            <button role="menuitem" onClick={() => act({ kind: 'placeholderToNode', id: node!.id })}>Create node…</button>
            <button role="menuitem" className="danger" onClick={() => act({ kind: 'deleteItems', ids: [node!.id] })}>Delete placeholder</button>
        </>}
        {data?.kind === 'flow' && <>
            <div className="board-context-menu__label">flows/{data.flowId}</div>
            <button role="menuitem" onClick={() => { onEnterFlow(data.flowId!); onClose(); }}>Open flow</button>
            <button role="menuitem" onClick={() => { onFindRefs(data.flowId!); onClose(); }}>Find references</button>
            <button role="menuitem" className="danger" onClick={() => act({ kind: 'deleteFlow', id: data.flowId })}>Delete flow…</button>
        </>}
        {data?.kind === 'value' && <button role="menuitem" className="danger" onClick={() => act({ kind: 'deleteItems', ids: [node!.id] })}>Delete value</button>}
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

function CommandPalette({ items, query, setQuery, onClose, label = 'Command palette', placeholder }: {
    items: PaletteEntry[];
    query: string;
    setQuery(value: string): void;
    onClose(): void;
    label?: string;
    placeholder?: string;
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
        <div className="palette" role="dialog" aria-label={label} onMouseDown={event => event.stopPropagation()}>
            <input
                autoFocus
                aria-label={`${label} input`}
                placeholder={placeholder ?? 'Type a command, a node name, or text to search code…'}
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

/** Left panel: nodes by folder, flows, and read-only library units. Click to find, drag onto the canvas to place. */
function LibrarySidebar({ snapshot, onPick, onAddLibrary }: { snapshot: HarnessSnapshot; onPick(target: string): void; onAddLibrary(): void }) {
    const [query, setQuery] = useState('');
    const entries = useMemo(() => [...callables(snapshot)].map(([id, item]) => ({
        id,
        label: item.group === 'library' ? item.signature.name : id,
        detail: item.detail,
        keywords: typeof item.unit?.annotation?.intent === 'string' ? item.unit.annotation.intent : undefined,
        group: 'node' as const,
        kind: item.group,
    })), [snapshot]);
    const shown = query.trim() ? rankPalette(entries, query) : entries;
    const section = (kind: 'node' | 'flow' | 'library', title: string) => {
        const items = shown.filter(entry => entry.kind === kind);
        if (!items.length) return null;
        let folder: string | null = null;
        return <section key={kind}>
            <h3>{title}</h3>
            <ul>{items.flatMap(entry => {
                const entryFolder = kind === 'node' && entry.id.includes('/') ? entry.id.slice(0, entry.id.lastIndexOf('/')) : kind === 'library' ? entry.detail.split(' · ')[0] : '';
                const header = entryFolder !== folder && entryFolder && !query.trim()
                    ? [<li key={`h:${entryFolder}`} className="library__folder">{kind === 'node' ? `${entryFolder}/` : entryFolder}</li>] : [];
                folder = entryFolder;
                return [...header, <li
                    key={entry.id}
                    draggable
                    title={entry.keywords ?? entry.detail}
                    onDragStart={event => { event.dataTransfer.setData('application/slate-target', entry.id); event.dataTransfer.effectAllowed = 'copy'; }}
                    onClick={() => onPick(entry.id)}
                >
                    <span>{entry.label.split('/').pop()}</span>
                    <small>{entry.keywords ?? entry.detail}</small>
                </li>];
            })}</ul>
        </section>;
    };
    return <aside className="library" aria-label="Library">
        <input aria-label="Filter library" placeholder="Filter nodes, flows, library…" value={query} onChange={event => setQuery(event.target.value)} spellCheck={false} />
        {section('node', 'Nodes')}
        {section('flow', 'Flows')}
        {section('library', 'Library (read-only)')}
        {shown.length === 0 && <p className="library__empty">Nothing matches.</p>}
        <button className="secondary" onClick={onAddLibrary}>Add library file…</button>
    </aside>;
}

type AddRequest = { x: number; y: number; connectFrom?: string; connectTo?: string; annotation?: string | null };

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
    const [view, setView] = useState<'compose' | 'map'>('compose');
    const [flowStack, setFlowStack] = useState<string[]>([]);
    const [libraryOpen, setLibraryOpen] = useState(true);
    const [adding, setAdding] = useState<AddRequest | null>(null);
    const [highlight, setHighlight] = useState<string | null>(null);
    const [pendingCenter, setPendingCenter] = useState<string | null>(null);
    const pointer = useRef<{ x: number; y: number } | null>(null);
    const scope = useMemo<CanvasScope>(() => ({ view: flowStack.length ? 'compose' : view, flow: flowStack.at(-1) ?? null }), [view, flowStack]);
    const flow = useRef<ReactFlowInstance<Node<SlateNodeData>, Edge> | null>(null);
    const graph = useMemo(() => {
        const built = buildGraph(snapshot, scope);
        if (!highlight) return built;
        return { ...built, nodes: built.nodes.map(node => node.id === highlight || node.data.target === highlight
            ? { ...node, data: { ...node.data, highlighted: true } } : node) };
    }, [snapshot, scope, highlight]);
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

    useEffect(() => {
        // Leave a flow that was deleted or renamed underneath us.
        if (scope.flow && !snapshot.flows?.some(item => item.id === scope.flow)) setFlowStack(stack => stack.slice(0, -1));
    }, [snapshot, scope.flow]);

    useEffect(() => {
        const timer = window.setTimeout(() => flow.current?.fitView({ padding: 0.2, duration: 200 }), 30);
        return () => window.clearTimeout(timer);
    }, [scope.view, scope.flow]);

    useEffect(() => {
        if (!pendingCenter || !graph.nodes.some(node => node.id === pendingCenter)) return;
        const id = pendingCenter;
        setPendingCenter(null);
        window.setTimeout(() => centerOn(id), 60);
    }, [graph.nodes, pendingCenter]);

    const enterFlow = (flowId: string) => {
        setBoardMenu(null);
        setHighlight(null);
        setFlowStack(stack => [...stack, flowId]);
    };
    const openAdd = (request?: Partial<AddRequest>) => {
        if (scope.view === 'map') { setCommandResult('Switch to Compose to add nodes.'); return; }
        const point = request?.x !== undefined ? { x: request.x, y: request.y! } : pointer.current ?? viewCenter();
        setPaletteQuery('');
        setAdding({ ...request, ...point });
    };
    const groupSelection = () => {
        const ids = nodes.filter(node => node.selected && ['ref', 'instance', 'value', 'flow', 'function', 'class'].includes(node.data.kind)).map(node => node.id);
        if (!ids.length) { setCommandResult('Select nodes, references, flows, or values to group.'); return; }
        post({ kind: 'extractFlow', ids });
    };
    const goTo = (target: string) => {
        const id = snapshot.flows?.some(item => item.id === target) ? `flow:${target}` : target;
        if (target.startsWith('lib:')) { setCommandResult(`${target} is read-only library code.`); return; }
        setFlowStack([]);
        setView('compose');
        setPendingCenter(id);
    };
    const findReferences = (target: string) => {
        setHighlight(target);
        const refs = (snapshot.refs ?? []).filter(ref => ref.target === target).length;
        const flows = (snapshot.flows ?? []).filter(item => item.flow?.instances.some(instance => instance.node === target)).map(item => item.id);
        setCommandResult(`${target}: ${refs} reference${refs === 1 ? '' : 's'} on the canvas${flows.length ? `; used in flows ${flows.join(', ')}` : ''}.`);
    };
    const endpointOf = (nodeId: string, handle: string | null | undefined) =>
        nodeId === '__input' || nodeId === '__output' ? handle ?? '' : `${nodeId}.${handle ?? 'out'}`;

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target?.matches('input, textarea, [contenteditable="true"]') || target?.closest('.cm-editor') || paletteOpen || adding) return;
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'g') {
                event.preventDefault();
                groupSelection();
            } else if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                if (selected?.data.flowId) enterFlow(selected.data.flowId);
                else openAdd();
            } else if (event.key === 'A' && event.shiftKey && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                openAdd();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    const isContextEndpoint = (id: string | null) => {
        const unit = id ? snapshot.documents.flatMap(document => document.units).find(candidate => candidate.id === id) : undefined;
        return Boolean(unit && unit.identity === 'durable' && unit.parentId === null);
    };
    const post = (action: Record<string, unknown>) => vscode?.postMessage({ type: 'action', action: { ...(scope.flow ? { flow: scope.flow } : {}), ...action }, revision: snapshot.revision });
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
        const selectedIds = selectedNodes.map(node => node.id);
        const removable = selectedNodes.filter(node => ['ref', 'instance', 'value', 'placeholder'].includes(node.data.kind)).map(node => node.id);
        items.push({ id: 'add-node', group: 'canvas', label: 'Add node…', detail: 'Tab · Shift+A · double-click', run: () => openAdd() });
        if (selectedIds.length) items.push({ id: 'group', group: 'canvas', label: 'Group selection into flow', detail: '⌘G', run: groupSelection });
        if (removable.length) items.push({ id: 'delete', group: 'canvas', label: `Delete selected (${removable.length})`, run: () => post({ kind: 'deleteItems', ids: removable }) });
        if (selected?.data.flowId) items.push({ id: 'enter', group: 'selection', label: `Open flow ${selected.data.flowId}`, detail: 'Tab', run: () => enterFlow(selected.data.flowId!) });
        if (selected?.data.target || selected?.data.unit) {
            const target = selected.data.target ?? selected.data.unit!.id;
            items.push({ id: 'refs', group: 'selection', label: `Find references of ${target}`, run: () => findReferences(target) });
        }
        if (scope.flow) items.push({ id: 'up', group: 'canvas', label: 'Back to parent canvas', run: () => setFlowStack(stack => stack.slice(0, -1)) });
        if (!scope.flow) {
            items.push({ id: 'view', group: 'canvas', label: view === 'map' ? 'Switch to Compose' : 'Switch to Map', detail: 'Map groups nodes by folder', run: () => setView(view === 'map' ? 'compose' : 'map') });
            items.push({ id: 'new-node', group: 'canvas', label: 'New node file…', detail: 'Typed signature + intent',
                run: () => { const point = viewCenter(); post({ kind: 'createNode', x: point.x, y: point.y }); } });
            items.push({ id: 'new-placeholder', group: 'canvas', label: 'New placeholder…', run: () => { const point = viewCenter(); post({ kind: 'createPlaceholder', x: point.x, y: point.y }); } });
            items.push({ id: 'new-flow', group: 'canvas', label: 'New flow…', run: () => { const point = viewCenter(); post({ kind: 'createFlow', x: point.x, y: point.y }); } });
        }
        items.push({ id: 'library', group: 'canvas', label: libraryOpen ? 'Hide library' : 'Show library', run: () => setLibraryOpen(open => !open) });
        items.push({ id: 'add-library', group: 'canvas', label: 'Add library file…', run: () => post({ kind: 'addLibrary' }) });
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
        for (const item of snapshot.flows ?? []) {
            if (item.id !== 'main') items.push({ id: `goto-flow:${item.id}`, group: 'node', label: `Flow: ${item.id}`, run: () => enterFlow(item.id) });
        }
        const text = paletteQuery.trim();
        if (text) items.push({ id: 'search', group: 'search', always: true, label: `Search code for “${text}”`, run: () => runSearch(text) });
        return items;
    }, [snapshot, selected?.data.unit, selected?.data.flowId, selected?.data.target, selectedNodes.length, paletteQuery, describing, scope, view, libraryOpen]);

    // Add-node search: every callable (minus the open flow), a literal value, and at the root a placeholder.
    const addItems = useMemo<PaletteEntry[]>(() => {
        if (!adding) return [];
        const wantInput = Boolean(adding.connectFrom);
        const matches = (ports: Port[]) => !adding.annotation || ports.some(port => !port.annotation || port.annotation === adding.annotation);
        const place = (extra: Record<string, unknown>, ports: Port[]) => {
            const port = ports.find(item => adding.annotation && item.annotation === adding.annotation) ?? ports[0];
            post({ kind: 'addInstance', x: adding.x, y: adding.y, connectFrom: adding.connectFrom, connectTo: adding.connectTo, connectPort: port?.id, ...extra });
        };
        const items: PaletteEntry[] = [];
        for (const [id, item] of callables(snapshot)) {
            if (id === scope.flow) continue;
            const ports = wantInput ? inputPorts(item.signature) : outputPorts(item.signature);
            if ((adding.connectFrom || adding.connectTo) && !matches(ports)) continue;
            items.push({
                id: `add:${id}`, group: 'node', label: item.group === 'library' ? item.signature.name : id, detail: item.detail,
                keywords: typeof item.unit?.annotation?.intent === 'string' ? item.unit.annotation.intent : undefined,
                run: () => place({ target: id }, ports),
            });
        }
        if (!wantInput) items.push({ id: 'add:value', group: 'node', label: 'Value', detail: 'A Python literal', run: () => place({ value: '0' }, [{ id: 'out', name: 'value', annotation: null }]) });
        const text = paletteQuery.trim();
        if (!scope.flow && /^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
            items.push({ id: 'add:placeholder', group: 'search', always: true, label: `New placeholder “${text}”`, run: () => post({ kind: 'createPlaceholder', name: text, x: adding.x, y: adding.y }) });
        }
        return items;
    }, [adding, snapshot, scope, paletteQuery]);

    return (
        <main className="harness-shell">
            <header className="harness-topbar">
                <nav className="harness-crumbs" aria-label="Canvas path">
                    <strong>SLATE</strong>
                    <button className={scope.flow ? '' : 'is-current'} onClick={() => setFlowStack([])}>{snapshot.projectName}</button>
                    {flowStack.map((id, index) => <React.Fragment key={`${id}:${index}`}>
                        <span>▸</span>
                        <button className={index === flowStack.length - 1 ? 'is-current' : ''} onClick={() => setFlowStack(stack => stack.slice(0, index + 1))}>{id}</button>
                    </React.Fragment>)}
                    {!scope.flow && <span className="harness-toggle" role="group" aria-label="View">
                        <button aria-pressed={view === 'compose'} onClick={() => setView('compose')}>Compose</button>
                        <button aria-pressed={view === 'map'} onClick={() => setView('map')}>Map</button>
                    </span>}
                    <button className="harness-library-toggle" aria-pressed={libraryOpen} onClick={() => setLibraryOpen(open => !open)}>Library</button>
                </nav>
                <div className="harness-status">
                    <span>{snapshot.documents.length} nodes</span>
                    {noteCount > 0 && <span>{noteCount} note{noteCount === 1 ? '' : 's'}</span>}
                    {selectedNodes.length > 0 && <span>{selectedNodes.length} selected</span>}
                    {contextCount > 0 && <span className="status-context">{contextCount} context</span>}
                    {staleCount > 0 && <span className="status-warning">{staleCount} stale</span>}
                    {invalidCount > 0 && <span className="status-error">{invalidCount} invalid</span>}
                </div>
            </header>
            {libraryOpen && <LibrarySidebar
                snapshot={snapshot}
                onAddLibrary={() => post({ kind: 'addLibrary' })}
                onPick={target => {
                    const id = scope.flow ? nodes.find(node => node.data.target === target)?.id
                        : nodes.find(node => node.id === target || node.id === `flow:${target}` || node.data.target === target)?.id;
                    if (id) centerOn(id);
                    else setCommandResult(`${target} is not on this canvas; drag it in to place it.`);
                }}
            />}
            <ScopeContext.Provider value={scope.flow}>
            <section
                className={`harness-canvas ${libraryOpen ? 'harness-canvas--library' : ''}`}
                aria-label="Python project graph"
                onMouseMove={event => { pointer.current = flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? null; }}
                onDragOver={event => { if (event.dataTransfer.types.includes('application/slate-target')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
                onDrop={event => {
                    const target = event.dataTransfer.getData('application/slate-target');
                    if (!target || scope.view === 'map') return;
                    event.preventDefault();
                    const point = flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 0, y: 0 };
                    post({ kind: 'addInstance', target, x: point.x, y: point.y });
                }}
                onDoubleClick={event => {
                    if (!(event.target as HTMLElement).classList.contains('react-flow__pane')) return;
                    const point = flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
                    if (point) openAdd(point);
                }}
            >
                {graph.nodes.length === 0 && <div className="harness-empty">{scope.flow
                    ? 'Empty flow: press Tab or double-click to add a node, then wire it to the group input and output.'
                    : 'Right-click the canvas → New node file… to start, or drag from the library.'}</div>}
                <ReactFlow
                    nodes={nodes}
                    edges={graph.edges}
                    nodeTypes={nodeTypes}
                    onNodesChange={onNodesChange}
                    onInit={instance => { flow.current = instance; instance.fitView({ padding: 0.2 }); }}
                    onNodeDoubleClick={(_, node) => {
                        if (node.data.flowId) enterFlow(node.data.flowId);
                        else if (node.data.unit && (node.data.path || !node.data.target)) vscode?.postMessage({ type: 'reveal', unitId: node.data.unit.id, focus: true });
                    }}
                    zoomOnDoubleClick={false}
                    onNodeContextMenu={(event, node) => openBoardMenu(event, node)}
                    onPaneContextMenu={event => openBoardMenu(event, null)}
                    onPaneClick={() => { setBoardMenu(null); setHighlight(null); }}
                    onNodeDragStop={(_, node, dragged) => vscode?.postMessage({
                        type: 'layout',
                        revision: snapshot.revision,
                        scope: scope.flow ?? (scope.view === 'map' ? 'map' : undefined),
                        positions: Object.fromEntries((dragged.length ? dragged : [node]).map(item => [item.id, item.position])),
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
                    nodesConnectable={scope.view !== 'map'}
                    connectionLineStyle={{ stroke: 'var(--strata-info, #62d9ff)', strokeDasharray: '4 4' }}
                    isValidConnection={connection => {
                        const from = connection.sourceHandle ?? '';
                        const to = connection.targetHandle ?? '';
                        if (connection.source === connection.target) return false;
                        if (from === 'ctx-out' || to === 'ctx-in') {
                            return from === 'ctx-out' && to === 'ctx-in' && isContextEndpoint(connection.source) && isContextEndpoint(connection.target);
                        }
                        return (from === 'out' || from.startsWith('out:') || from.startsWith('input:'))
                            && (to.startsWith('in:') || to.startsWith('output:')) && !(from === 'input:+' && to === 'output:+');
                    }}
                    onConnect={connection => {
                        if (!connection.source || !connection.target) return;
                        if (connection.sourceHandle === 'ctx-out') {
                            post({ kind: 'setContext', consumer: connection.target, dependency: connection.source, enabled: true });
                            setCommandResult(`Context: ${connection.source} → ${connection.target}`);
                            return;
                        }
                        const from = endpointOf(connection.source, connection.sourceHandle);
                        const to = endpointOf(connection.target, connection.targetHandle);
                        post({ kind: 'connectData', from, to });
                        setCommandResult(`Wire: ${from} → ${to}`);
                    }}
                    onConnectEnd={(event, state) => {
                        // Dropping a data wire on empty canvas opens add-node search filtered by the port's type.
                        const handle = state.fromHandle;
                        if (state.isValid || state.toNode || !handle?.id || handle.id.startsWith('ctx') || handle.id.endsWith(':+')) return;
                        const point = 'clientX' in event ? event : event.changedTouches[0];
                        const position = flow.current?.screenToFlowPosition({ x: point.clientX, y: point.clientY });
                        const source = nodes.find(node => node.id === handle.nodeId)?.data;
                        const port = [...(source?.inputs ?? []), ...(source?.outputs ?? [])].find(item => item.id === handle.id);
                        if (!position) return;
                        const endpoint = endpointOf(handle.nodeId, handle.id);
                        openAdd({ ...position, annotation: port?.annotation ?? null, ...(handle.type === 'source' ? { connectFrom: endpoint } : { connectTo: endpoint }) });
                    }}
                    onEdgeContextMenu={(event, edge) => {
                        event.preventDefault();
                        if (edge.id.startsWith('context:')) {
                            setBoardMenu({ screenX: event.clientX, screenY: event.clientY, flowX: 0, flowY: 0, node: null,
                                edge: { dependency: edge.source, consumer: edge.target } });
                        } else if (edge.id.startsWith('data:')) {
                            const wire = edge.data as { from: string; to: string };
                            setBoardMenu({ screenX: event.clientX, screenY: event.clientY, flowX: 0, flowY: 0, node: null, wire });
                        }
                    }}
                    deleteKeyCode={null}
                    multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
                    elementsSelectable
                >
                    <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
                    <Controls showInteractive={false} />
                </ReactFlow>
            </section>
            </ScopeContext.Provider>
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
            {selected && selected.data.kind !== 'group' && selected.data.kind !== 'folder' && <Inspector
                onEnterFlow={enterFlow}
                onGoTo={goTo}
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
                scope={scope}
                onEnterFlow={enterFlow}
                onGoTo={goTo}
                onFindRefs={findReferences}
                onAdd={(x, y) => openAdd({ x, y })}
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
            {adding && <CommandPalette
                items={addItems}
                query={paletteQuery}
                setQuery={setPaletteQuery}
                onClose={() => setAdding(null)}
                label="Add node"
                placeholder={adding.annotation ? `Add a node that takes or gives ${adding.annotation}…` : 'Add a node, flow, library function, or value…'}
            />}
        </main>
    );
}

createRoot(document.getElementById('harness-root')!).render(<HarnessApp />);
