import type { Edge, Node } from '@xyflow/react';

import {
    flowSignature, inputPorts, MAIN_FLOW, outputPorts, parseEndpoint, unitSignature, type CallableSignature, type Port,
} from '../../vscode-extension/src/flow';
import type { BoardNote, HarnessSnapshot, HarnessUnit, Placeholder, SlateFlow } from './types';

const GROUP_COLORS = ['#3ecff5', '#a78bfa', '#f59e72', '#5ee0a0'];

/** Which canvas is showing: the root in Compose or Map view, or one flow. */
export type CanvasScope = { view: 'compose' | 'map'; flow: string | null };
export const ROOT_SCOPE: CanvasScope = { view: 'compose', flow: null };

export type SlateNodeData = {
    label: string;
    detail: string;
    kind: 'document' | 'note' | 'module' | 'ref' | 'placeholder' | 'flow' | 'instance' | 'value' | 'group' | 'folder' | HarnessUnit['kind'];
    identity?: HarnessUnit['identity'];
    invalid?: boolean;
    stale?: boolean;
    container?: boolean;
    groupColor?: string;
    /** Node id whose document the Inspector shows (a ref's or instance's target). */
    path: string;
    unit?: HarnessUnit;
    note?: BoardNote;
    /** The node's intent, shown under its signature. */
    intent?: string;
    /** First diagnostic, shown as a warning badge. */
    problem?: string;
    /** The intent can be edited inline on the node. */
    editableIntent?: boolean;
    /** Data ports (handle ids `in:<param>`, `out`, `out:<name>`, `input:<name>`, `output:<name>`). */
    inputs?: Port[];
    outputs?: Port[];
    /** Context handles (top in, bottom out) for definition nodes on the root canvas. */
    contextPorts?: boolean;
    /** What a ref, instance, or flow node calls. */
    target?: string;
    /** Flow id to enter (flow nodes, instances of flows). */
    flowId?: string;
    broken?: boolean;
    value?: string;
    placeholder?: Placeholder;
    resolvesTo?: string | null;
    /** Find references: the target and its refs are highlighted. */
    highlighted?: boolean;
};

/** Stable color per annotation; untyped ("any") is grey. */
export function typeColor(annotation: string | null | undefined): string {
    const type = (annotation ?? '').replace(/\s+/g, '');
    if (!type || type === 'Any' || type === 'any') return '#7d8590';
    let hash = 0;
    for (const character of type) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    return `hsl(${hash % 360} 70% 62%)`;
}

export function nodeIdOf(documentPath: string): string {
    return documentPath.replace(/^slate\/nodes\//, '').replace(/\.json$/, '');
}

function folderOf(nodeId: string): string {
    return nodeId.includes('/') ? nodeId.slice(0, nodeId.lastIndexOf('/')) : '';
}

const flowOf = (snapshot: HarnessSnapshot, id: string): SlateFlow | null =>
    snapshot.flows?.find(item => item.id === id)?.flow ?? null;

/** Every callable target: node definitions, library units, and flows (main excluded). */
export function callables(snapshot: HarnessSnapshot): Map<string, { signature: CallableSignature; unit?: HarnessUnit; detail: string; group: 'node' | 'flow' | 'library' }> {
    const result = new Map<string, { signature: CallableSignature; unit?: HarnessUnit; detail: string; group: 'node' | 'flow' | 'library' }>();
    for (const document of snapshot.documents) {
        const top = document.units.find(unit => unit.parentId === null);
        if (top && !document.nodeKind) result.set(top.id, { signature: unitSignature(top, document.units), unit: top, detail: top.signature ?? `class ${top.name}`, group: 'node' });
    }
    for (const document of snapshot.library ?? []) {
        for (const unit of document.units.filter(item => item.parentId === null)) {
            result.set(unit.id, { signature: unitSignature(unit, document.units), unit, detail: `${document.path} · ${unit.signature ?? `class ${unit.name}`}`, group: 'library' });
        }
    }
    for (const item of snapshot.flows ?? []) {
        if (item.flow && item.id !== MAIN_FLOW) result.set(item.id, { signature: flowSignature(item.flow), detail: `flow ${item.id}`, group: 'flow' });
    }
    return result;
}

function portsOf(signature: CallableSignature | undefined): { inputs: Port[]; outputs: Port[] } {
    return signature ? { inputs: inputPorts(signature), outputs: outputPorts(signature) } : { inputs: [], outputs: [] };
}

function directChildren(units: HarnessUnit[], parentId: string): HarnessUnit[] {
    return units.filter(unit => unit.parentId === parentId);
}

/** Root canvas definitions: every node file is one free node; classes still contain their methods. */
function buildDefinitionNodes(snapshot: HarnessSnapshot, nodes: Node<SlateNodeData>[], map: boolean): void {
    const folders = [...new Set(snapshot.documents.map(document => folderOf(nodeIdOf(document.path))))].sort();
    const rows = new Map<string, number>();
    const positions = map ? snapshot.mapPositions ?? {} : snapshot.layout ?? {};
    const targets = callables(snapshot);
    if (map) {
        folders.forEach((folder, column) => nodes.push({
            id: `folder:${folder}`, type: 'slate', draggable: false, selectable: false,
            position: { x: 80 + column * 340, y: 10 },
            data: { label: folder ? `${folder}/` : 'root', detail: '', kind: 'folder', groupColor: GROUP_COLORS[column % GROUP_COLORS.length], path: folder },
        }));
    }
    for (const document of snapshot.documents) {
        const nodeId = nodeIdOf(document.path);
        const folder = folderOf(nodeId);
        const column = folders.indexOf(folder);
        const row = rows.get(folder) ?? 0;
        const groupColor = GROUP_COLORS[column % GROUP_COLORS.length];
        const fallback = { x: 80 + column * 340, y: (map ? 70 : 60) + row * (map ? 150 : 170) };
        if (document.nodeKind) {
            // Module state: a small node showing the statement it starts with.
            rows.set(folder, row + 1);
            const firstLine = (document.source ?? '').split('\n').find(line => line.trim() && !line.trim().startsWith('#'));
            nodes.push({
                id: nodeId, type: 'slate', position: positions[nodeId] ?? fallback,
                data: {
                    label: document.nodeKind === 'prelude' ? 'module state' : 'module tail', detail: firstLine?.trim() ?? '',
                    kind: 'module', invalid: !document.valid, stale: document.stale, groupColor, path: nodeId,
                    problem: document.diagnostics[0]?.message,
                },
            });
            continue;
        }
        const top = document.units.find(unit => unit.parentId === null);
        const id = top?.id ?? document.id;
        const children = top && !map ? directChildren(document.units, top.id) : [];
        const isClass = top?.kind === 'class' && !map;
        const ports = map ? { inputs: [], outputs: [] } : portsOf(top ? targets.get(top.id)?.signature : undefined);
        const height = isClass ? Math.max(132, children.length * 96 + 72) : 0;
        rows.set(folder, row + (isClass ? Math.ceil(height / 170) : 1) + (ports.inputs.length > 2 ? 1 : 0));
        const intent = typeof top?.annotation?.intent === 'string' ? top.annotation.intent : '';
        nodes.push({
            id,
            type: 'slate',
            position: positions[id] ?? fallback,
            style: isClass ? { width: 320, height } : undefined,
            data: {
                label: top?.name ?? nodeId,
                detail: top?.signature ?? (top ? top.qualifiedName : 'unreadable node'),
                kind: top?.kind ?? 'document',
                identity: top?.identity,
                invalid: !document.valid,
                stale: document.stale,
                container: isClass,
                groupColor,
                path: nodeId,
                unit: top,
                intent,
                editableIntent: Boolean(top) && !isClass && !map,
                problem: document.diagnostics[0]?.message,
                ...ports,
                contextPorts: Boolean(top) && !map,
            },
        });
        children.forEach((unit, index) => nodes.push({
            id: unit.id,
            type: 'slate',
            parentId: id,
            extent: 'parent',
            position: positions[unit.id] ?? { x: 28, y: 58 + index * 96 },
            data: {
                label: unit.name,
                detail: unit.signature ?? unit.qualifiedName,
                kind: unit.kind,
                identity: unit.identity,
                stale: document.stale,
                groupColor,
                path: nodeId,
                unit,
            },
        }));
    }
}

/** A node for something that calls a target: a ref on the root canvas, or an instance in a flow. */
function callerNode(
    snapshot: HarnessSnapshot,
    targets: ReturnType<typeof callables>,
    id: string,
    target: string,
    kind: 'ref' | 'instance',
    position: { x: number; y: number },
): Node<SlateNodeData> {
    const callable = targets.get(target);
    const flowId = callable?.group === 'flow' ? target : undefined;
    return {
        id, type: 'slate', position,
        data: {
            label: callable?.signature.name ?? target.split(/[/:]/).pop() ?? target,
            detail: callable ? `${kind === 'ref' ? '→ ' : ''}${target}` : `missing: ${target}`,
            kind, broken: !callable, path: callable?.group === 'node' ? target : '', unit: callable?.group === 'node' ? callable.unit : undefined,
            target, flowId, groupColor: flowId ? '#f6c453' : callable?.group === 'library' ? '#9da5ad' : undefined,
            ...portsOf(callable?.signature),
        },
    };
}

function valueNode(id: string, value: string, position: { x: number; y: number }): Node<SlateNodeData> {
    return {
        id, type: 'slate', position,
        data: { label: 'value', detail: value, kind: 'value', value, path: '', outputs: [{ id: 'out', name: 'value', annotation: null }] },
    };
}

function dataEdges(flow: SlateFlow, nodeIds: Set<string>, colorOf: (endpoint: string) => string): Edge[] {
    const nodeFor = (endpoint: string, side: 'from' | 'to') => {
        const { instance, port } = parseEndpoint(endpoint);
        return instance === null ? { node: side === 'from' ? '__input' : '__output', handle: port } : { node: instance, handle: port };
    };
    return flow.wires.flatMap(wire => {
        const from = nodeFor(wire.from, 'from');
        const to = nodeFor(wire.to, 'to');
        if (!nodeIds.has(from.node) || !nodeIds.has(to.node)) return [];
        return [{
            id: `data:${wire.from}->${wire.to}`,
            source: from.node, sourceHandle: from.handle, target: to.node, targetHandle: to.handle,
            className: 'slate-edge slate-edge--data',
            style: { stroke: colorOf(wire.from), strokeWidth: 2 },
            data: { from: wire.from, to: wire.to },
        }];
    });
}

function buildRoot(snapshot: HarnessSnapshot, nodes: Node<SlateNodeData>[], edges: Edge[]): void {
    buildDefinitionNodes(snapshot, nodes, false);
    const targets = callables(snapshot);
    const layout = snapshot.layout ?? {};
    const nodeIds = snapshot.documents.map(document => nodeIdOf(document.path));
    (snapshot.refs ?? []).forEach((ref, index) => nodes.push(callerNode(snapshot, targets, ref.id, ref.target, 'ref', layout[ref.id] ?? { x: 760, y: 360 + index * 120 })));
    (snapshot.placeholders ?? []).forEach((placeholder, index) => {
        const matches = nodeIds.filter(id => id === placeholder.name || id.split('/').pop() === placeholder.name);
        const resolvesTo = matches.length === 1 ? matches[0] : null;
        nodes.push({
            id: placeholder.id, type: 'slate', position: layout[placeholder.id] ?? { x: 760, y: 60 + index * 110 },
            data: {
                label: placeholder.name, detail: resolvesTo ? `→ ${resolvesTo}` : 'not defined yet', kind: 'placeholder',
                path: '', placeholder, resolvesTo,
            },
        });
    });
    (snapshot.flows ?? []).filter(item => item.id !== MAIN_FLOW).forEach((item, index) => {
        const id = `flow:${item.id}`;
        nodes.push({
            id, type: 'slate', position: layout[id] ?? { x: 1080, y: 60 + index * 170 },
            data: {
                label: item.flow?.name ?? item.id, detail: item.flow ? `flow · ${item.flow.instances.length} nodes` : `unreadable: ${item.problem}`,
                kind: 'flow', flowId: item.id, target: item.id, invalid: !item.flow, path: '', groupColor: '#f6c453',
                ...portsOf(item.flow ? flowSignature(item.flow) : undefined),
            },
        });
    });
    const main = flowOf(snapshot, MAIN_FLOW);
    if (main) {
        main.instances.filter(instance => instance.kind === 'value')
            .forEach((instance, index) => nodes.push(valueNode(instance.id, instance.value ?? '', layout[instance.id] ?? { x: 760, y: 600 + index * 90 })));
        const byId = new Map(nodes.map(node => [node.id, node]));
        edges.push(...dataEdges(main, new Set(byId.keys()), endpoint => {
            const { instance, port } = parseEndpoint(endpoint);
            return typeColor(byId.get(instance ?? '')?.data.outputs?.find(item => item.id === port)?.annotation);
        }));
    }
}

function buildFlow(snapshot: HarnessSnapshot, flowId: string, nodes: Node<SlateNodeData>[], edges: Edge[]): void {
    const flow = flowOf(snapshot, flowId);
    if (!flow) return;
    const targets = callables(snapshot);
    const positions = snapshot.flowPositions?.[flowId] ?? {};
    const groupPort = (prefix: string) => (port: { name: string; annotation: string | null }): Port => ({ id: `${prefix}:${port.name}`, name: port.name, annotation: port.annotation });
    const empty = (prefix: string): Port => ({ id: `${prefix}:+`, name: '+', annotation: null, optional: true });
    nodes.push({
        id: '__input', type: 'slate', position: positions.__input ?? { x: 40, y: 120 },
        data: { label: 'Group input', detail: flow.name, kind: 'group', path: '', outputs: [...flow.inputs.map(groupPort('input')), empty('input')] },
    });
    nodes.push({
        id: '__output', type: 'slate', position: positions.__output ?? { x: 360 + Math.ceil(flow.instances.length / 3) * 300, y: 120 },
        data: { label: 'Group output', detail: flow.name, kind: 'group', path: '', inputs: [...flow.outputs.map(groupPort('output')), empty('output')] },
    });
    flow.instances.forEach((instance, index) => {
        const position = positions[instance.id] ?? { x: 340 + Math.floor(index / 3) * 300, y: 40 + (index % 3) * 190 };
        nodes.push(instance.kind === 'value'
            ? valueNode(instance.id, instance.value ?? '', position)
            : callerNode(snapshot, targets, instance.id, instance.node!, 'instance', position));
    });
    const byId = new Map(nodes.map(node => [node.id, node]));
    edges.push(...dataEdges(flow, new Set(byId.keys()), endpoint => {
        const { instance, port } = parseEndpoint(endpoint);
        if (instance === null) return typeColor(flow.inputs.find(input => `input:${input.name}` === port)?.annotation);
        return typeColor(byId.get(instance)?.data.outputs?.find(item => item.id === port)?.annotation);
    }));
}

export function buildGraph(snapshot: HarnessSnapshot, scope: CanvasScope = ROOT_SCOPE): { nodes: Node<SlateNodeData>[]; edges: Edge[] } {
    const nodes: Node<SlateNodeData>[] = [];
    const edges: Edge[] = [];
    if (scope.flow) {
        buildFlow(snapshot, scope.flow, nodes, edges);
        return { nodes, edges };
    }
    if (scope.view === 'map') {
        buildDefinitionNodes(snapshot, nodes, true);
        return { nodes, edges };
    }
    buildRoot(snapshot, nodes, edges);
    addNotesAndEdges(snapshot, nodes, edges);
    return { nodes, edges };
}

function addNotesAndEdges(snapshot: HarnessSnapshot, nodes: Node<SlateNodeData>[], edges: Edge[]): void {
    for (const [index, note] of (snapshot.notes ?? []).entries()) {
        nodes.push({
            id: note.id,
            type: 'slate',
            position: snapshot.layout?.[note.id] ?? { x: 1400, y: 60 + index * 150 },
            data: {
                label: note.title,
                detail: note.body || 'Board-only note',
                kind: 'note',
                groupColor: 'var(--strata-warning)',
                path: 'Board note — slate/layout.json',
                note,
            },
        });
    }

    const nodeIds = new Set(nodes.map(node => node.id));
    const contextEdges = new Map<string, { sourceId: string; targetId: string }>();
    for (const document of snapshot.documents) {
        for (const unit of document.units) {
            const dependencies = unit.annotation?.dependencies;
            if (!Array.isArray(dependencies)) continue;
            for (const dependency of dependencies) {
                if (typeof dependency !== 'string') continue;
                contextEdges.set(`${dependency}:${unit.id}`, { sourceId: dependency, targetId: unit.id });
            }
        }
    }
    for (const edge of snapshot.contextEdges ?? []) {
        if (edge.kind === 'context') contextEdges.set(`${edge.sourceId}:${edge.targetId}`, edge);
    }
    for (const [id, edge] of contextEdges) {
        if (!nodeIds.has(edge.sourceId) || !nodeIds.has(edge.targetId)) continue;
        edges.push({
            id: `context:${id}`,
            source: edge.sourceId,
            sourceHandle: 'ctx-out',
            target: edge.targetId,
            targetHandle: 'ctx-in',
            type: 'smoothstep',
            animated: true,
            className: 'slate-edge slate-edge--context',
        });
    }
    for (const note of snapshot.notes ?? []) {
        if (!note.attachedTo || !nodeIds.has(note.attachedTo)) continue;
        edges.push({
            id: `note:${note.id}:${note.attachedTo}`,
            source: note.id,
            target: note.attachedTo,
            targetHandle: 'ctx-in',
            type: 'smoothstep',
            selectable: false,
            focusable: false,
            interactionWidth: 0,
            className: 'slate-edge slate-edge--note',
        });
    }
}
