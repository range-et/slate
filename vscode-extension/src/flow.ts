import type { FlowInstance, FlowPort, FlowWire, ParsedUnit, SlateFlow, UnitParam } from './harness_protocol';

// Flows (slate/flows/<id>.json): instances of nodes, flows, library units, or
// literal values, connected by data wires, with named inputs and outputs.
// Pure and language-agnostic; shared by the host, compile, and the webview.

export const FLOWS_DIR = 'slate/flows';
/** The root canvas's data wires live in this flow. */
export const MAIN_FLOW = 'main';
const FLOW_KEYS = ['slate', 'name', 'inputs', 'outputs', 'instances', 'wires'];

export class FlowFormatError extends Error {}

export function flowIdForPath(relativePath: string): string | null {
    const normalized = relativePath.replace(/\\/g, '/');
    if (!normalized.startsWith(`${FLOWS_DIR}/`) || !normalized.endsWith('.json')) return null;
    return normalized.slice(FLOWS_DIR.length + 1, -'.json'.length);
}

export function pathForFlowId(flowId: string): string {
    return `${FLOWS_DIR}/${flowId}.json`;
}

export function emptyFlow(name: string): SlateFlow {
    return { name, inputs: [], outputs: [], instances: [], wires: [], extra: {} };
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ports(value: unknown, label: string): FlowPort[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new FlowFormatError(`${label} must be a list`);
    return value.map(item => {
        if (!isRecord(item) || typeof item.name !== 'string' || !IDENTIFIER.test(item.name)) throw new FlowFormatError(`${label} entries need an identifier name`);
        if (item.annotation !== undefined && item.annotation !== null && typeof item.annotation !== 'string') throw new FlowFormatError(`${label} annotation must be a string`);
        return { name: item.name, annotation: (item.annotation as string | undefined) ?? null };
    });
}

export function parseFlow(text: string): SlateFlow {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new FlowFormatError(`not valid JSON: ${(error as Error).message}`);
    }
    if (!isRecord(value) || value.slate !== 3) throw new FlowFormatError('a flow must be an object declaring "slate": 3');
    if (typeof value.name !== 'string' || !IDENTIFIER.test(value.name)) throw new FlowFormatError('name must be an identifier');
    const instances = value.instances === undefined ? [] : value.instances;
    if (!Array.isArray(instances)) throw new FlowFormatError('instances must be a list');
    const parsedInstances = instances.map((item): FlowInstance => {
        if (!isRecord(item) || typeof item.id !== 'string' || !item.id || item.id.includes('.')) throw new FlowFormatError('instances need an id without dots');
        if (item.kind === 'value') return { id: item.id, kind: 'value', value: typeof item.value === 'string' ? item.value : JSON.stringify(item.value ?? null) };
        if (typeof item.node !== 'string') throw new FlowFormatError(`instance ${item.id} needs a node`);
        return { id: item.id, node: item.node };
    });
    const ids = parsedInstances.map(item => item.id);
    if (new Set(ids).size !== ids.length) throw new FlowFormatError('instance ids must be unique');
    const wires = value.wires === undefined ? [] : value.wires;
    if (!Array.isArray(wires) || !wires.every(wire => isRecord(wire) && typeof wire.from === 'string' && typeof wire.to === 'string')) {
        throw new FlowFormatError('wires must be a list of { from, to }');
    }
    const extra: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (!FLOW_KEYS.includes(key)) extra[key] = item;
    return {
        name: value.name,
        inputs: ports(value.inputs, 'inputs'),
        outputs: ports(value.outputs, 'outputs'),
        instances: parsedInstances,
        wires: (wires as FlowWire[]).map(wire => ({ from: wire.from, to: wire.to })),
        extra,
    };
}

export function serializeFlow(flow: SlateFlow): string {
    return `${JSON.stringify({
        slate: 3,
        name: flow.name,
        inputs: flow.inputs,
        outputs: flow.outputs,
        instances: flow.instances,
        wires: flow.wires,
        ...flow.extra,
    }, null, 2)}\n`;
}

// Signatures and ports

export interface CallableSignature {
    name: string;
    params: UnitParam[];
    returns: string | null;
    /** Flows only: named outputs (a tuple when more than one). */
    outputs?: FlowPort[];
}

export interface Port {
    /** Handle id: `in:<param>`, `out`, or `out:<name>`. */
    id: string;
    name: string;
    annotation: string | null;
    /** Inputs with a default may stay unwired. */
    optional?: boolean;
}

/** A function's parameters, or a class's `__init__` parameters without `self`. */
export function unitSignature(unit: ParsedUnit, units: ParsedUnit[]): CallableSignature {
    if (unit.kind === 'class' || unit.kind === 'nested_class') {
        const init = units.find(candidate => candidate.parentId === unit.id && candidate.name === '__init__');
        return { name: unit.name, params: init?.params?.slice(1) ?? [], returns: unit.name };
    }
    return { name: unit.name, params: unit.params ?? [], returns: unit.returnAnnotation ?? null };
}

export function flowSignature(flow: SlateFlow): CallableSignature {
    return {
        name: flow.name,
        params: flow.inputs.map(input => ({ name: input.name, annotation: input.annotation, default: null, kind: 'keyword' })),
        returns: flow.outputs.length === 1 ? flow.outputs[0].annotation : null,
        outputs: flow.outputs,
    };
}

export function inputPorts(signature: CallableSignature): Port[] {
    return signature.params
        .filter(param => param.kind === 'positional' || param.kind === 'keyword')
        .map(param => ({ id: `in:${param.name}`, name: param.name, annotation: param.annotation, optional: param.default !== null }));
}

export function outputPorts(signature: CallableSignature): Port[] {
    if (!signature.outputs) return [{ id: 'out', name: 'out', annotation: signature.returns }];
    if (signature.outputs.length === 1) return [{ id: 'out', name: signature.outputs[0].name, annotation: signature.outputs[0].annotation }];
    return signature.outputs.map(output => ({ id: `out:${output.name}`, name: output.name, annotation: output.annotation }));
}

export function parseEndpoint(value: string): { instance: string | null; port: string } {
    if (value.startsWith('input:') || value.startsWith('output:')) return { instance: null, port: value };
    const dot = value.indexOf('.');
    return dot < 0 ? { instance: value, port: 'out' } : { instance: value.slice(0, dot), port: value.slice(dot + 1) };
}

export function uniqueName(base: string, taken: Iterable<string>): string {
    const used = new Set(taken);
    const clean = base.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=[0-9])/, '_') || 'value';
    if (!used.has(clean)) return clean;
    let index = 2;
    while (used.has(`${clean}_${index}`)) index++;
    return `${clean}_${index}`;
}

// Edits (pure; return new flows)

/** Add a wire; an input accepts one wire, so an existing wire into `to` is replaced. */
export function connect(flow: SlateFlow, from: string, to: string): SlateFlow {
    return { ...flow, wires: [...flow.wires.filter(wire => wire.to !== to), { from, to }] };
}

export function disconnect(flow: SlateFlow, from: string, to: string): SlateFlow {
    return { ...flow, wires: flow.wires.filter(wire => wire.from !== from || wire.to !== to) };
}

export function removeInstances(flow: SlateFlow, ids: Iterable<string>): SlateFlow {
    const removed = new Set(ids);
    const touches = (endpoint: string) => {
        const instance = parseEndpoint(endpoint).instance;
        return instance !== null && removed.has(instance);
    };
    return {
        ...flow,
        instances: flow.instances.filter(instance => !removed.has(instance.id)),
        wires: flow.wires.filter(wire => !touches(wire.from) && !touches(wire.to)),
    };
}

/**
 * Move the selected instances into a new flow. Wires crossing the selection
 * become the new flow's inputs (one per distinct outside source) and outputs
 * (one per distinct inside source); the parent gets one instance of the new flow.
 */
export function extractFlow(
    parent: SlateFlow,
    ids: string[],
    child: { id: string; name: string; instanceId: string },
    portsOf: (instance: FlowInstance) => { inputs: Port[]; outputs: Port[] },
): { parent: SlateFlow; child: SlateFlow } {
    const selected = new Set(ids.filter(id => parent.instances.some(instance => instance.id === id)));
    const inside = (endpoint: string) => {
        const instance = parseEndpoint(endpoint).instance;
        return instance !== null && selected.has(instance);
    };
    const instanceOf = (endpoint: string) => parent.instances.find(instance => instance.id === parseEndpoint(endpoint).instance)!;
    const inner = parent.wires.filter(wire => inside(wire.from) && inside(wire.to));
    const incoming = parent.wires.filter(wire => !inside(wire.from) && inside(wire.to));
    const outgoing = parent.wires.filter(wire => inside(wire.from) && !inside(wire.to));

    const inputs: FlowPort[] = [];
    const childWires: FlowWire[] = [...inner];
    const parentWires: FlowWire[] = parent.wires.filter(wire => !inside(wire.from) && !inside(wire.to));
    const inputBySource = new Map<string, string>();
    for (const wire of incoming) {
        let name = inputBySource.get(wire.from);
        if (!name) {
            const port = parseEndpoint(wire.to).port;
            const target = portsOf(instanceOf(wire.to)).inputs.find(candidate => candidate.id === port);
            name = uniqueName(port.replace(/^in:/, ''), inputs.map(input => input.name));
            inputs.push({ name, annotation: target?.annotation ?? null });
            inputBySource.set(wire.from, name);
            parentWires.push({ from: wire.from, to: `${child.instanceId}.in:${name}` });
        }
        childWires.push({ from: `input:${name}`, to: wire.to });
    }

    const outputs: FlowPort[] = [];
    const outputBySource = new Map<string, string>();
    for (const wire of outgoing) {
        if (outputBySource.has(wire.from)) continue;
        const source = instanceOf(wire.from);
        const port = parseEndpoint(wire.from).port;
        const output = portsOf(source).outputs.find(candidate => candidate.id === port);
        const base = port === 'out' ? (source.node?.split(/[/:]/).pop() ?? source.id) : port.replace(/^out:/, '');
        const name = uniqueName(base, outputs.map(item => item.name));
        outputs.push({ name, annotation: output?.annotation ?? null });
        outputBySource.set(wire.from, name);
        childWires.push({ from: wire.from, to: `output:${name}` });
    }
    for (const wire of outgoing) {
        const name = outputBySource.get(wire.from)!;
        parentWires.push({ from: `${child.instanceId}.${outputs.length === 1 ? 'out' : `out:${name}`}`, to: wire.to });
    }

    return {
        parent: {
            ...parent,
            instances: [...parent.instances.filter(instance => !selected.has(instance.id)), { id: child.instanceId, node: child.id }],
            wires: parentWires,
        },
        child: {
            name: child.name,
            inputs,
            outputs,
            instances: parent.instances.filter(instance => selected.has(instance.id)),
            wires: childWires,
            extra: {},
        },
    };
}
