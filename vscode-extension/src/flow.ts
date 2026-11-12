import type { CanvasRef, FlowInstance, FlowPort, FlowWire, ParsedUnit, SlateFlow, TestCase, UnitParam } from './harness_protocol';

// Flows (slate/flows/<id>.json): instances of nodes, flows, library units, or
// literal values, connected by data wires, with named inputs and outputs.
// Pure and language-agnostic; shared by the host, compile, and the webview.

export const FLOWS_DIR = 'slate/flows';
/** The root canvas's data wires live in this flow. */
export const MAIN_FLOW = 'main';
const FLOW_KEYS = ['slate', 'name', 'inputs', 'outputs', 'instances', 'wires', 'cases'];

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
        if (item.kind === 'viewer') return { id: item.id, kind: 'viewer', pinned: item.pinned !== false };
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
    const rawCases = value.cases ?? (isRecord(value.extra) ? value.extra.cases : undefined);
    const parsedCases: TestCase[] | undefined = Array.isArray(rawCases) ? rawCases.map((c, i) => {
        if (!isRecord(c)) return { id: `case_${i + 1}`, inputs: {} };
        return {
            id: typeof c.id === 'string' ? c.id : `case_${i + 1}`,
            description: typeof c.description === 'string' ? c.description : undefined,
            inputs: isRecord(c.inputs) ? c.inputs as Record<string, unknown> : {},
            expected: c.expected ?? c.output,
            error: typeof c.error === 'string' ? c.error : undefined,
        };
    }) : undefined;
    return {
        name: value.name,
        inputs: ports(value.inputs, 'inputs'),
        outputs: ports(value.outputs, 'outputs'),
        instances: parsedInstances,
        wires: (wires as FlowWire[]).map(wire => ({ from: wire.from, to: wire.to })),
        cases: parsedCases,
        extra,
    };
}

export function serializeFlow(flow: SlateFlow): string {
    const obj: Record<string, unknown> = {
        slate: 3,
        name: flow.name,
        inputs: flow.inputs,
        outputs: flow.outputs,
        instances: flow.instances,
        wires: flow.wires,
    };
    if (flow.cases && flow.cases.length > 0) {
        obj.cases = flow.cases;
    }
    Object.assign(obj, flow.extra);
    return `${JSON.stringify(obj, null, 2)}\n`;
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

export type ValueType = 'number' | 'boolean' | 'string' | 'json' | 'null' | 'expr';

export function inferValueType(val: unknown): ValueType {
    if (val === undefined || val === null) return 'null';
    if (typeof val === 'boolean') return 'boolean';
    if (typeof val === 'number') return 'number';
    if (typeof val === 'object') {
        if (isRecord(val) && 'expr' in val) return 'expr';
        return 'json';
    }
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed === 'null' || trimmed === 'None') return 'null';
        if (trimmed === 'true' || trimmed === 'false' || trimmed === 'True' || trimmed === 'False') return 'boolean';
        if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) return 'number';
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            return 'json';
        }
        if (/[+\-*/%&|^<>=]/.test(trimmed) || /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*\(.*\)$/.test(trimmed)) {
            return 'expr';
        }
        return 'string';
    }
    return 'string';
}

export function parseValueLiteral(raw: unknown): { type: ValueType; value: unknown; text: string; error?: string } {
    const type = inferValueType(raw);
    if (raw === undefined || raw === null) {
        return { type: 'null', value: null, text: 'null' };
    }
    if (typeof raw === 'boolean') {
        return { type: 'boolean', value: raw, text: raw ? 'true' : 'false' };
    }
    if (typeof raw === 'number') {
        return { type: 'number', value: raw, text: String(raw) };
    }
    if (typeof raw === 'object') {
        if (isRecord(raw) && 'expr' in raw) {
            return { type: 'expr', value: raw, text: String(raw.expr) };
        }
        return { type: 'json', value: raw, text: JSON.stringify(raw) };
    }
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (type === 'null') return { type: 'null', value: null, text: 'null' };
        if (type === 'boolean') {
            const b = trimmed.toLowerCase() === 'true';
            return { type: 'boolean', value: b, text: b ? 'true' : 'false' };
        }
        if (type === 'number') {
            const n = Number(trimmed);
            return { type: 'number', value: n, text: trimmed };
        }
        if (type === 'json') {
            try {
                const parsed = JSON.parse(trimmed);
                return { type: 'json', value: parsed, text: trimmed };
            } catch (e) {
                return { type: 'json', value: trimmed, text: trimmed, error: (e as Error).message };
            }
        }
        if (type === 'expr') {
            return { type: 'expr', value: { expr: trimmed }, text: trimmed };
        }
        if ((trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
            (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)) {
            return { type: 'string', value: trimmed.slice(1, -1), text: trimmed };
        }
        return { type: 'string', value: raw, text: raw };
    }
    return { type: 'string', value: String(raw), text: String(raw) };
}

export function compileValueToPython(val: unknown): string {
    if (val === undefined || val === null) return 'None';
    if (typeof val === 'boolean') return val ? 'True' : 'False';
    if (typeof val === 'number') {
        if (Number.isNaN(val)) return 'float("nan")';
        if (val === Infinity) return 'float("inf")';
        if (val === -Infinity) return 'float("-inf")';
        return String(val);
    }
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed === 'True' || trimmed === 'true') return 'True';
        if (trimmed === 'False' || trimmed === 'false') return 'False';
        if (trimmed === 'None' || trimmed === 'null') return 'None';
        if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) return trimmed;
        if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
            try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') return JSON.stringify(parsed);
            } catch {
                return trimmed;
            }
        }
        if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
            return JSON.stringify(trimmed.slice(1, -1));
        }
        if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
            try {
                const parsed = JSON.parse(trimmed);
                return compileValueToPython(parsed);
            } catch {
                return trimmed;
            }
        }
        if (/[+\-*/%&|^<>=]/.test(trimmed) || /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*\(.*\)$/.test(trimmed)) {
            return trimmed;
        }
        return JSON.stringify(val);
    }
    if (typeof val === 'object') {
        if (isRecord(val) && 'expr' in val && typeof val.expr === 'string') {
            return val.expr;
        }
        if (Array.isArray(val)) {
            return `[${val.map(compileValueToPython).join(', ')}]`;
        }
        const entries = Object.entries(val).map(([k, v]) => `${JSON.stringify(k)}: ${compileValueToPython(v)}`);
        return `{${entries.join(', ')}}`;
    }
    return String(val);
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

/** Rename an input or output port of a flow and update its internal wires. */
export function renameFlowPort(flow: SlateFlow, direction: 'input' | 'output', oldName: string, newName: string): SlateFlow {
    if (!IDENTIFIER.test(newName)) throw new FlowFormatError('port name must be an identifier');
    if (oldName === newName) return flow;
    const listKey = direction === 'input' ? 'inputs' : 'outputs';
    if (flow[listKey].some(port => port.name === newName)) throw new FlowFormatError(`port ${newName} already exists`);
    const portIndex = flow[listKey].findIndex(port => port.name === oldName);
    if (portIndex < 0) throw new FlowFormatError(`port ${oldName} does not exist`);
    const updatedPorts = [...flow[listKey]];
    updatedPorts[portIndex] = { ...updatedPorts[portIndex], name: newName };

    const oldEndpoint = direction === 'input' ? `input:${oldName}` : `output:${oldName}`;
    const newEndpoint = direction === 'input' ? `input:${newName}` : `output:${newName}`;

    const wires = flow.wires.map(wire => {
        if (direction === 'input' && wire.from === oldEndpoint) return { ...wire, from: newEndpoint };
        if (direction === 'output' && wire.to === oldEndpoint) return { ...wire, to: newEndpoint };
        return wire;
    });

    return {
        ...flow,
        [listKey]: updatedPorts,
        wires,
    };
}

/** Delete an input or output port of a flow and unplug its internal wires. */
export function deleteFlowPort(flow: SlateFlow, direction: 'input' | 'output', name: string): SlateFlow {
    const listKey = direction === 'input' ? 'inputs' : 'outputs';
    const targetEndpoint = direction === 'input' ? `input:${name}` : `output:${name}`;
    return {
        ...flow,
        [listKey]: flow[listKey].filter(port => port.name !== name),
        wires: flow.wires.filter(wire => direction === 'input' ? wire.from !== targetEndpoint : wire.to !== targetEndpoint),
    };
}

/** Update caller wires when a referenced flow's input or output port is renamed. */
export function repairCallerWiresOnPortRename(
    callerFlow: SlateFlow,
    calleeFlowId: string,
    direction: 'input' | 'output',
    oldName: string,
    newName: string,
    calleeOutputsCount = 1,
): SlateFlow {
    const matchingInstanceIds = new Set(
        callerFlow.instances
            .filter(instance => instance.node === calleeFlowId || instance.node === `flow:${calleeFlowId}`)
            .map(instance => instance.id),
    );
    if (matchingInstanceIds.size === 0) return callerFlow;

    const wires = callerFlow.wires.map(wire => {
        const from = parseEndpoint(wire.from);
        const to = parseEndpoint(wire.to);
        if (direction === 'input') {
            if (to.instance && matchingInstanceIds.has(to.instance) && to.port === `in:${oldName}`) {
                return { ...wire, to: `${to.instance}.in:${newName}` };
            }
        } else {
            if (from.instance && matchingInstanceIds.has(from.instance)) {
                if (from.port === `out:${oldName}`) {
                    return { ...wire, from: `${from.instance}.out:${newName}` };
                }
                if (calleeOutputsCount === 1 && from.port === 'out') {
                    // Single output callers might use out:oldName
                    return wire;
                }
            }
        }
        return wire;
    });

    return { ...callerFlow, wires };
}

/** Update caller wires when a referenced flow's input or output port is deleted. */
export function repairCallerWiresOnPortDelete(
    callerFlow: SlateFlow,
    calleeFlowId: string,
    direction: 'input' | 'output',
    name: string,
    calleeOutputsCount = 1,
    survivingOutputName?: string,
): SlateFlow {
    const matchingInstanceIds = new Set(
        callerFlow.instances
            .filter(instance => instance.node === calleeFlowId || instance.node === `flow:${calleeFlowId}`)
            .map(instance => instance.id),
    );
    if (matchingInstanceIds.size === 0) return callerFlow;

    const wires: FlowWire[] = [];
    for (const wire of callerFlow.wires) {
        const from = parseEndpoint(wire.from);
        const to = parseEndpoint(wire.to);
        if (direction === 'input') {
            if (to.instance && matchingInstanceIds.has(to.instance) && to.port === `in:${name}`) {
                continue;
            }
            wires.push(wire);
        } else {
            if (from.instance && matchingInstanceIds.has(from.instance)) {
                if (from.port === `out:${name}`) {
                    continue;
                }
                if (calleeOutputsCount <= 0 && from.port === 'out') {
                    continue;
                }
                if (calleeOutputsCount === 1) {
                    if (survivingOutputName && from.port === `out:${survivingOutputName}`) {
                        wires.push({ ...wire, from: `${from.instance}.out` });
                        continue;
                    }
                    if (!survivingOutputName && from.port.startsWith('out:')) {
                        wires.push({ ...wire, from: `${from.instance}.out` });
                        continue;
                    }
                }
            }
            wires.push(wire);
        }
    }

    return { ...callerFlow, wires };
}

/** Remove all instances referencing a deleted node definition from a flow, unplugging their wires. */
export function removeNodeReferences(flow: SlateFlow, targetNodeId: string): SlateFlow {
    const matchingIds = flow.instances
        .filter(instance => instance.node === targetNodeId || instance.node === `flow:${targetNodeId}`)
        .map(instance => instance.id);
    return matchingIds.length > 0 ? removeInstances(flow, matchingIds) : flow;
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

export interface RootMigrationResult {
    main: SlateFlow | null;
    positions: Record<string, { x: number; y: number }>;
    changed: boolean;
}

/**
 * Migrate legacy `layout.refs` and implied/pruned root instances into `flows/main.json`
 * without breaking wires. Showing a definition on the root canvas does not make it run.
 */
export function migrateRootOccurrences(
    main: SlateFlow | null | undefined,
    refs: ReadonlyArray<CanvasRef> = [],
    positions: Readonly<Record<string, { x: number; y: number }>> = {},
    definitionIds: Iterable<string> = [],
    flowIds: Iterable<string> = [],
): RootMigrationResult {
    const defs = new Set(definitionIds);
    const flows = new Set([...flowIds].filter(id => id !== MAIN_FLOW));
    const nextPositions: Record<string, { x: number; y: number }> = { ...positions };
    if (!main && refs.length === 0) return { main: null, positions: nextPositions, changed: false };

    const base = main ?? emptyFlow(MAIN_FLOW);
    let changed = !main || refs.length > 0;
    const instances: FlowInstance[] = base.instances.map(item => ({ ...item }));
    let wires: FlowWire[] = base.wires.map(wire => ({ ...wire }));

    for (const ref of refs) {
        const existing = instances.find(item => item.id === ref.id);
        if (!existing) {
            instances.push({ id: ref.id, node: ref.target });
            changed = true;
        } else if (existing.kind !== 'value' && existing.node !== ref.target) {
            existing.node = ref.target;
            changed = true;
        }
    }

    for (const wire of wires) {
        for (const endpoint of [wire.from, wire.to]) {
            const { instance } = parseEndpoint(endpoint);
            if (instance === null || instances.some(item => item.id === instance)) continue;
            if (instance.startsWith('flow:')) {
                const target = instance.slice('flow:'.length);
                if (flows.size === 0 || flows.has(target)) {
                    instances.push({ id: instance, node: target });
                    changed = true;
                }
            } else if (defs.has(instance) || flows.has(instance) || instance.startsWith('lib:')) {
                instances.push({ id: instance, node: instance });
                changed = true;
            }
        }
    }

    const taken = new Set<string>([
        ...defs,
        ...[...flows].map(id => `flow:${id}`),
        ...instances.map(item => item.id),
    ]);
    for (const item of instances) {
        if (item.kind === 'value') continue;
        const isFlowCard = item.id.startsWith('flow:');
        const isDefCard = defs.has(item.id);
        if (!isFlowCard && !isDefCard) continue;
        const oldId = item.id;
        const target = item.node ?? (isFlowCard ? oldId.slice('flow:'.length) : oldId);
        const short = (target.startsWith('lib:') ? target.split(':').pop()! : target.split('/').pop()!) || 'call';
        const newId = uniqueName(`ref_${short}`, taken);
        taken.add(newId);
        item.id = newId;
        item.node = target;
        wires = wires.map(wire => {
            const from = parseEndpoint(wire.from);
            const to = parseEndpoint(wire.to);
            return {
                from: from.instance === oldId ? `${newId}.${from.port}` : wire.from,
                to: to.instance === oldId ? `${newId}.${to.port}` : wire.to,
            };
        });
        if (nextPositions[oldId] && !nextPositions[newId]) {
            nextPositions[newId] = { x: nextPositions[oldId].x + 320, y: nextPositions[oldId].y };
        }
        changed = true;
    }

    return {
        main: { ...base, instances, wires },
        positions: nextPositions,
        changed,
    };
}
