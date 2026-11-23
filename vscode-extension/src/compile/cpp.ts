import {
    checkCppNodeCode,
    CPP_GENERATED_HEADER,
    cppIdentifierNames,
    isCppGeneratedFile,
    parseCppModule,
    splitCppInclude,
} from '../cpp_adapter';
import {
    flowSignature,
    MAIN_FLOW,
    outputPorts,
    parseEndpoint,
    regionPorts,
    unitSignature,
    type CallableSignature,
    type RegionPorts,
} from '../flow';
import type { FlowRegion, SlateFlow } from '../harness_protocol';
import type { SlateConfig, SlateNode } from '../slate_folder';
import { projectModuleName, type CompileDiagnostic, type CompileResult } from './python';

export { CPP_GENERATED_HEADER, type CompileDiagnostic, type CompileResult };

const folderOf = (nodeId: string) => (nodeId.includes('/') ? nodeId.slice(0, nodeId.lastIndexOf('/')) : '');
const variable = (instanceId: string) => `v_${instanceId.replace(/[^A-Za-z0-9_]/g, '_')}`;

function normalizeNodeMap(
    input: ReadonlyMap<string, SlateNode> | Record<string, SlateNode>,
): Map<string, SlateNode> {
    if (input instanceof Map || (typeof (input as ReadonlyMap<string, SlateNode>).entries === 'function' && !(input instanceof Array))) {
        return new Map(input as ReadonlyMap<string, SlateNode>);
    }
    return new Map(Object.entries(input as Record<string, SlateNode>));
}

function normalizeFlowMap(
    input?: ReadonlyMap<string, SlateFlow> | Record<string, SlateFlow>,
): Map<string, SlateFlow> {
    if (!input) return new Map();
    if (input instanceof Map || (typeof (input as ReadonlyMap<string, SlateFlow>).entries === 'function' && !(input instanceof Array))) {
        return new Map(input as ReadonlyMap<string, SlateFlow>);
    }
    return new Map(Object.entries(input as Record<string, SlateFlow>));
}

function normalizeStringMap(
    input?: ReadonlyMap<string, string> | Record<string, string>,
): Map<string, string> {
    if (!input) return new Map();
    if (input instanceof Map || (typeof (input as ReadonlyMap<string, string>).entries === 'function' && !(input instanceof Array))) {
        return new Map(input as ReadonlyMap<string, string>);
    }
    return new Map(Object.entries(input as Record<string, string>));
}

function isArduinoLanguage(lang: string | undefined): boolean {
    if (!lang) return false;
    const lower = lang.trim().toLowerCase();
    return lower === 'arduino' || lower === 'ino' || lower === 'pde';
}

function isCppOrArduinoLanguage(lang: string | undefined): boolean {
    if (!lang) return true;
    const lower = lang.trim().toLowerCase();
    return lower === 'cpp' || lower === 'c++' || lower === 'cc' || lower === 'cxx' || lower === 'c' || lower === 'h' || lower === 'hpp' || isArduinoLanguage(lower);
}

/** Map a Slate or Python-style type annotation to an idiomatic C++ / Arduino type. */
export function mapToCppType(annotation: string | null | undefined, isArduino = false): string {
    if (!annotation || !annotation.trim()) return 'int';
    const trimmed = annotation.trim();
    const lower = trimmed.toLowerCase();
    if (lower === 'none' || lower === 'null' || lower === 'void') return 'void';
    if (lower === 'bool' || lower === 'boolean') return 'bool';
    if (lower === 'int' || lower === 'integer') return 'int';
    if (lower === 'float') return 'float';
    if (lower === 'double' || lower === 'number') return 'double';
    if (lower === 'str' || lower === 'string') return isArduino ? 'String' : 'std::string';
    const listMatch = trimmed.match(/^(?:list|List|Sequence|vector)\s*\[\s*(.+)\s*\]$/);
    if (listMatch) {
        return `std::vector<${mapToCppType(listMatch[1], isArduino)}>`;
    }
    return trimmed;
}

function defaultCppValueForType(cppType: string): string {
    const clean = cppType.replace(/\bconst\b/g, '').replace(/&$/, '').trim();
    if (!clean || clean === 'void') return '0';
    if (clean.endsWith('*')) return 'nullptr';
    if (clean === 'bool') return 'false';
    if (clean === 'float') return '0.0f';
    if (clean === 'double') return '0.0';
    if (clean === 'String') return 'String("")';
    if (clean === 'std::string') return '""';
    if (/^(?:u?int(?:8|16|32|64)_t|size_t|short|int|long|unsigned|signed|byte)\b/.test(clean)) return '0';
    return `${clean}{}`;
}

/** Compile a literal value from a FlowInstance (`kind: 'value'`) into C++ expression syntax. */
export function compileValueToCpp(val: unknown, isArduino = false): string {
    if (val === undefined || val === null) return '0';
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    if (typeof val === 'number') {
        if (!Number.isFinite(val)) return '0.0';
        return String(val);
    }
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed === 'True' || trimmed === 'true') return 'true';
        if (trimmed === 'False' || trimmed === 'false') return 'false';
        if (trimmed === 'None' || trimmed === 'null' || trimmed === 'nullptr') return '0';
        if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?f?$/.test(trimmed)) return trimmed;
        if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
            return trimmed;
        }
        if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
            const inner = trimmed.slice(1, -1);
            return inner.length === 1 ? `'${inner}'` : JSON.stringify(inner);
        }
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) return compileValueToCpp(parsed, isArduino);
            } catch {
                return trimmed;
            }
        }
        if (/[+\-*/%&|^<>=]/.test(trimmed) || /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*\(.*\)$/.test(trimmed)) {
            return trimmed;
        }
        return isArduino ? `String(${JSON.stringify(val)})` : JSON.stringify(val);
    }
    if (Array.isArray(val)) {
        const items = val.map(v => compileValueToCpp(v, isArduino));
        const elemType = typeof val[0] === 'boolean'
            ? 'bool'
            : typeof val[0] === 'number' && !Number.isInteger(val[0])
                ? 'double'
                : typeof val[0] === 'string'
                    ? (isArduino ? 'String' : 'std::string')
                    : 'int';
        return `std::vector<${elemType}>{${items.join(', ')}}`;
    }
    if (typeof val === 'object') {
        const rec = val as Record<string, unknown>;
        if (typeof rec.expr === 'string') return rec.expr;
    }
    return String(val);
}

/** Extract the callable signature of a C++/Arduino `SlateNode` from its code. */
export function cppNodeSignature(node: SlateNode): CallableSignature | null {
    if (node.kind) return null;
    const parsed = parseCppModule(`${node.code.join('\n')}\n`, '<signature>', node.name);
    const unit = parsed.units.find(item => item.parentId === null && item.name === node.name)
        ?? parsed.units.find(item => item.parentId === null);
    if (!unit) return null;
    return unitSignature(unit, parsed.units);
}

function stripDefaultArgsFromSignature(signature: string): string {
    const openParen = signature.indexOf('(');
    const closeParen = signature.lastIndexOf(')');
    if (openParen < 0 || closeParen < openParen) return signature;
    const prefix = signature.slice(0, openParen).trim();
    const rawParams = signature.slice(openParen + 1, closeParen).trim();
    if (!rawParams || rawParams === 'void') return `${prefix}()`;

    const probe = parseCppModule(`${signature} {}\n`, '<proto>');
    const unit = probe.units[0];
    if (!unit || !unit.params) return `${prefix}(${rawParams})`;

    const cleanParams = unit.params
        .map(p => (p.annotation ? `${p.annotation} ${p.name}` : p.name))
        .join(', ');
    return `${prefix}(${cleanParams})`;
}

/**
 * Compile a wired `SlateFlow` (including `branch`, `foreach`, and `repeat` control-flow regions)
 * into a deterministic C++ / Arduino function `SlateNode`.
 */
export function cppFlowToNode(
    flowId: string,
    flow: SlateFlow,
    resolve: (target: string) => { signature: CallableSignature; imports: string[] } | null,
    diagnostics: CompileDiagnostic[],
    options?: { isArduino?: boolean },
): SlateNode | null {
    const isArduino = options?.isArduino === true;
    const label = `flows/${flowId}`;
    const errors: string[] = [];

    const resolveAny = (target: string) =>
        resolve(target) ?? (target.startsWith('flow:') ? resolve(target.slice('flow:'.length)) : null);

    const signatureToFlow = (sig: CallableSignature, forRegion?: FlowRegion): SlateFlow => {
        const inputs = sig.params
            .filter(p => p.kind === 'positional' || p.kind === 'keyword')
            .map(p => ({ name: p.name, annotation: p.annotation }));
        let outputs = sig.outputs;
        if (!outputs) {
            if (sig.returns && sig.returns !== 'void') {
                const stateOutName =
                    forRegion?.kind === 'repeat'
                        ? (forRegion.statePorts?.[0] ?? inputs[0]?.name ?? 'out')
                        : 'out';
                outputs = [{ name: stateOutName, annotation: sig.returns }];
            } else {
                outputs = [];
            }
        }
        return {
            name: sig.name,
            inputs,
            outputs,
            instances: [],
            wires: [],
            extra: {},
        };
    };

    const makeFlowLookup = (forRegion?: FlowRegion) => (childFlowId: string): SlateFlow | undefined => {
        const res = resolveAny(childFlowId);
        return res ? signatureToFlow(res.signature, forRegion) : undefined;
    };

    const signatures = new Map<string, CallableSignature | null>();
    for (const instance of flow.instances) {
        if (instance.kind === 'value') {
            signatures.set(instance.id, null);
            continue;
        }
        if (instance.kind === 'viewer') {
            signatures.set(instance.id, {
                name: 'viewer',
                params: [{ name: 'in', annotation: null, default: null, kind: 'positional' }],
                returns: 'void',
            });
            continue;
        }
        const resolved = resolveAny(instance.node!);
        if (!resolved) errors.push(`instance ${instance.id} calls ${instance.node}, which does not exist`);
        signatures.set(instance.id, resolved?.signature ?? null);
    }

    const regionsById = new Map<string, FlowRegion>();
    const regionPortMap = new Map<string, RegionPorts>();
    for (const region of flow.regions ?? []) {
        regionsById.set(region.id, region);
        if (region.kind === 'branch') {
            if (!resolveAny(region.thenFlow)) {
                errors.push(`region ${region.id} calls ${region.thenFlow}, which does not exist`);
            }
            if (region.elseFlow && !resolveAny(region.elseFlow)) {
                errors.push(`region ${region.id} calls ${region.elseFlow}, which does not exist`);
            }
        } else if (!resolveAny(region.bodyFlow)) {
            errors.push(`region ${region.id} calls ${region.bodyFlow}, which does not exist`);
        }
        try {
            regionPortMap.set(region.id, regionPorts(region, makeFlowLookup(region)));
        } catch {
            // Child flow resolution error already recorded above
        }
    }

    const names = new Map<string, string>();
    for (const instance of flow.instances) {
        const name = variable(instance.id);
        if (names.has(name) || flow.inputs.some(input => input.name === name)) {
            errors.push(`instance ${instance.id} needs a distinct variable name (${name})`);
        }
        names.set(name, instance.id);
    }
    for (const region of flow.regions ?? []) {
        const name = variable(region.id);
        if (names.has(name) || flow.inputs.some(input => input.name === name)) {
            errors.push(`region ${region.id} needs a distinct variable name (${name})`);
        }
        names.set(name, region.id);
    }

    const outputsOf = (id: string) => {
        if (regionsById.has(id)) {
            return regionPortMap.get(id)?.outputs ?? [];
        }
        const signature = signatures.get(id);
        return signature ? outputPorts(signature) : [{ id: 'out', name: 'out', annotation: null }];
    };

    const incoming = new Map<string, string>();
    for (const wire of flow.wires) {
        const from = parseEndpoint(wire.from);
        const to = parseEndpoint(wire.to);
        const fromRegionPorts = from.instance !== null ? regionPortMap.get(from.instance) : undefined;
        const fromOk = from.instance === null
            ? from.port.startsWith('input:') && flow.inputs.some(input => `input:${input.name}` === from.port)
            : fromRegionPorts
                ? fromRegionPorts.outputs.some(port => port.id === from.port) ||
                  (fromRegionPorts.outputs.length === 1 && (from.port === 'out' || from.port === `out:${fromRegionPorts.outputs[0].name}`))
                : signatures.has(from.instance) && outputsOf(from.instance).some(port => port.id === from.port);
        const isViewerTo = flow.instances.find(i => i.id === to.instance)?.kind === 'viewer';
        const toRegionPorts = to.instance !== null ? regionPortMap.get(to.instance) : undefined;
        const toOk = to.instance === null
            ? to.port.startsWith('output:') && flow.outputs.some(output => `output:${output.name}` === to.port)
            : toRegionPorts
                ? toRegionPorts.inputs.some(port => port.id === to.port)
                : signatures.has(to.instance) && (
                    (signatures.get(to.instance)?.params ?? []).some(param => `in:${param.name}` === to.port) ||
                    (isViewerTo && (to.port === 'in' || to.port === 'in:in'))
                );
        if (!fromOk || !toOk) errors.push(`wire ${wire.from} → ${wire.to} has an unknown endpoint`);
        else if (incoming.has(wire.to)) errors.push(`${wire.to} has more than one wire`);
        else incoming.set(wire.to, wire.from);
    }

    const expression = (endpoint: string) => {
        const { instance, port } = parseEndpoint(endpoint);
        if (instance === null) return port.slice('input:'.length);
        const rPorts = regionPortMap.get(instance);
        if (rPorts && rPorts.outputs.length === 1) {
            return variable(instance);
        }
        return port === 'out' ? variable(instance) : `${variable(instance)}_${port.slice('out:'.length)}`;
    };

    // Topological sort via Kahn's algorithm
    const order: string[] = [];
    const pending = new Set([
        ...flow.instances.map(instance => instance.id),
        ...(flow.regions ?? []).map(region => region.id),
    ]);
    while (pending.size) {
        const ready = [...pending].find(id =>
            [...incoming].every(([to, from]) =>
                parseEndpoint(to).instance !== id ||
                parseEndpoint(from).instance === null ||
                !pending.has(parseEndpoint(from).instance!),
            ),
        );
        if (!ready) {
            errors.push(`instances ${[...pending].join(', ')} form a cycle`);
            break;
        }
        order.push(ready);
        pending.delete(ready);
    }

    const body: string[] = [];
    let needsVectorInclude = false;
    let needsTupleInclude = false;

    for (const id of order) {
        const region = regionsById.get(id);
        if (region) {
            const rPorts = regionPortMap.get(id);
            if (!rPorts) continue;
            const slug = id.replace(/[^A-Za-z0-9_]/g, '_');

            if (region.kind === 'branch') {
                const thenSig = resolveAny(region.thenFlow)?.signature;
                const elseSig = region.elseFlow ? resolveAny(region.elseFlow)?.signature : undefined;
                if (!thenSig || (region.elseFlow && !elseSig)) continue;

                const condPort = region.conditionPort ?? 'condition';
                const condSource = incoming.get(`${id}.in:${condPort}`);
                if (!condSource) errors.push(`${id}.in:${condPort} is not wired and has no default`);
                const condExpr = condSource ? expression(condSource) : 'false';

                const buildBranchCall = (sig: CallableSignature) => {
                    const args: string[] = [];
                    for (const param of sig.params) {
                        if (param.kind === 'var' || param.kind === 'kwvar') continue;
                        const src = incoming.get(`${id}.in:${param.name}`);
                        if (!src) {
                            if (param.default === null) errors.push(`${id}.in:${param.name} is not wired and has no default`);
                            else args.push(param.default);
                            continue;
                        }
                        args.push(expression(src));
                    }
                    return `${sig.name}(${args.join(', ')})`;
                };

                const thenCall = buildBranchCall(thenSig);
                const elseCall = elseSig ? buildBranchCall(elseSig) : null;
                const outVars = rPorts.outputs.length === 1
                    ? [variable(id)]
                    : rPorts.outputs.map(p => `${variable(id)}_${p.name}`);

                for (let i = 0; i < rPorts.outputs.length; i++) {
                    const portType = mapToCppType(rPorts.outputs[i].annotation ?? thenSig.returns, isArduino);
                    const defVal = defaultCppValueForType(portType);
                    body.push(`    ${portType} ${outVars[i]} = ${defVal};`);
                }

                body.push(`    if (${condExpr}) {`);
                if (outVars.length === 0) {
                    body.push(`        ${thenCall};`);
                } else if (outVars.length === 1) {
                    body.push(`        ${outVars[0]} = ${thenCall};`);
                } else {
                    needsTupleInclude = true;
                    body.push(`        std::tie(${outVars.join(', ')}) = ${thenCall};`);
                }
                if (elseCall) {
                    body.push(`    } else {`);
                    if (outVars.length === 0) {
                        body.push(`        ${elseCall};`);
                    } else if (outVars.length === 1) {
                        body.push(`        ${outVars[0]} = ${elseCall};`);
                    } else {
                        needsTupleInclude = true;
                        body.push(`        std::tie(${outVars.join(', ')}) = ${elseCall};`);
                    }
                }
                body.push(`    }`);
                continue;
            }

            if (region.kind === 'foreach') {
                const bodySig = resolveAny(region.bodyFlow)?.signature;
                if (!bodySig) continue;
                needsVectorInclude = true;

                const collPort = region.collectionPort ?? 'items';
                const itemPort = region.itemPort ?? 'item';
                const indexPort = region.indexPort ?? 'index';
                const collSource = incoming.get(`${id}.in:${collPort}`);
                if (!collSource) errors.push(`${id}.in:${collPort} is not wired and has no default`);
                const collExpr = collSource ? expression(collSource) : 'std::vector<int>{}';

                const bodyArgs: string[] = [];
                for (const param of bodySig.params) {
                    if (param.kind === 'var' || param.kind === 'kwvar') continue;
                    if (param.name === itemPort) {
                        bodyArgs.push('_item');
                    } else if (param.name === indexPort) {
                        bodyArgs.push('static_cast<int>(_idx)');
                    } else {
                        const src = incoming.get(`${id}.in:${param.name}`);
                        if (!src) {
                            if (param.default === null) errors.push(`${id}.in:${param.name} is not wired and has no default`);
                            else bodyArgs.push(param.default);
                            continue;
                        }
                        bodyArgs.push(expression(src));
                    }
                }

                const bodyCall = `${bodySig.name}(${bodyArgs.join(', ')})`;
                const outVars = rPorts.outputs.length === 1
                    ? [variable(id)]
                    : rPorts.outputs.map(p => `${variable(id)}_${p.name}`);

                for (let i = 0; i < rPorts.outputs.length; i++) {
                    const elemType = mapToCppType(bodySig.outputs?.[i]?.annotation ?? bodySig.returns, isArduino);
                    body.push(`    std::vector<${elemType === 'void' ? 'int' : elemType}> ${outVars[i]};`);
                }

                body.push(`    for (size_t _idx = 0; _idx < ${collExpr}.size(); ++_idx) {`);
                if (region.maxIterations !== undefined) {
                    body.push(`        if (_idx >= ${region.maxIterations}) {`);
                    body.push(`            break;`);
                    body.push(`        }`);
                }
                body.push(`        const auto& _item = ${collExpr}[_idx];`);
                if (outVars.length === 0) {
                    body.push(`        ${bodyCall};`);
                } else if (outVars.length === 1) {
                    body.push(`        auto _item_${slug} = ${bodyCall};`);
                    body.push(`        ${outVars[0]}.push_back(_item_${slug});`);
                } else {
                    needsTupleInclude = true;
                    const itemVars = rPorts.outputs.map(p => `_item_${slug}_${p.name}`);
                    body.push(`        auto [${itemVars.join(', ')}] = ${bodyCall};`);
                    for (let i = 0; i < outVars.length; i++) {
                        body.push(`        ${outVars[i]}.push_back(${itemVars[i]});`);
                    }
                }
                body.push(`    }`);
                continue;
            }

            if (region.kind === 'repeat') {
                const bodySig = resolveAny(region.bodyFlow)?.signature;
                const bodyFlow = makeFlowLookup(region)(region.bodyFlow);
                if (!bodySig || !bodyFlow) continue;

                const inputNames = new Set(bodyFlow.inputs.map(p => p.name));
                const stateNames = region.statePorts && region.statePorts.length > 0
                    ? new Set(region.statePorts)
                    : new Set(bodyFlow.outputs.map(p => p.name).filter(n => inputNames.has(n)));
                const stateOutputs = bodyFlow.outputs.filter(p => stateNames.has(p.name));

                const stateVarFor = (sName: string) =>
                    stateOutputs.length === 1 && stateOutputs[0].name === sName
                        ? variable(id)
                        : `${variable(id)}_${sName}`;

                for (const sName of stateNames) {
                    const src = incoming.get(`${id}.in:${sName}`);
                    if (!src) errors.push(`${id}.in:${sName} is not wired and has no default`);
                    const expr = src ? expression(src) : '0';
                    body.push(`    auto ${stateVarFor(sName)} = ${expr};`);
                }

                const bodyArgs: string[] = [];
                for (const param of bodySig.params) {
                    if (param.kind === 'var' || param.kind === 'kwvar') continue;
                    if (stateNames.has(param.name)) {
                        bodyArgs.push(stateVarFor(param.name));
                    } else {
                        const src = incoming.get(`${id}.in:${param.name}`);
                        if (!src) {
                            if (param.default === null) errors.push(`${id}.in:${param.name} is not wired and has no default`);
                            else bodyArgs.push(param.default);
                            continue;
                        }
                        bodyArgs.push(expression(src));
                    }
                }

                const bodyCall = `${bodySig.name}(${bodyArgs.join(', ')})`;
                const bodyOutputs = bodyFlow.outputs;

                body.push(`    for (int _iter = 0; _iter < ${region.maxIterations}; ++_iter) {`);
                if (bodyOutputs.length === 0) {
                    body.push(`        ${bodyCall};`);
                } else if (bodyOutputs.length === 1) {
                    const outName = bodyOutputs[0].name;
                    if (stateNames.has(outName)) {
                        body.push(`        ${stateVarFor(outName)} = ${bodyCall};`);
                    } else {
                        body.push(`        auto _cond_${slug} = ${bodyCall};`);
                    }
                } else {
                    needsTupleInclude = true;
                    const tempVars = bodyOutputs.map(p => `_step_${slug}_${p.name}`);
                    body.push(`        auto [${tempVars.join(', ')}] = ${bodyCall};`);
                    for (let i = 0; i < bodyOutputs.length; i++) {
                        const pName = bodyOutputs[i].name;
                        if (stateNames.has(pName)) {
                            body.push(`        ${stateVarFor(pName)} = ${tempVars[i]};`);
                        } else if (region.conditionPort === pName) {
                            body.push(`        auto _cond_${slug} = ${tempVars[i]};`);
                        }
                    }
                }

                if (region.conditionPort) {
                    const condVar = stateNames.has(region.conditionPort)
                        ? stateVarFor(region.conditionPort)
                        : `_cond_${slug}`;
                    body.push(`        if (!${condVar}) {`);
                    body.push(`            break;`);
                    body.push(`        }`);
                }
                body.push(`    }`);
                continue;
            }
        }

        const instance = flow.instances.find(item => item.id === id)!;
        if (instance.kind === 'value') {
            const cppVal = compileValueToCpp(instance.value, isArduino);
            if (cppVal.includes('std::vector<')) needsVectorInclude = true;
            body.push(`    auto ${variable(id)} = ${cppVal};`);
            continue;
        }
        if (instance.kind === 'viewer') {
            continue;
        }

        const signature = signatures.get(id);
        if (!signature) continue;
        const args: string[] = [];
        for (const param of signature.params) {
            if (param.kind === 'var' || param.kind === 'kwvar') continue;
            const source = incoming.get(`${id}.in:${param.name}`);
            if (!source) {
                if (param.default === null) errors.push(`${id}.in:${param.name} is not wired and has no default`);
                else args.push(param.default);
                continue;
            }
            args.push(expression(source));
        }

        const call = `${signature.name}(${args.join(', ')})`;
        const outputs = outputPorts(signature);
        const isVoid = signature.returns === 'void' || (signature.outputs !== undefined && signature.outputs.length === 0);

        if (isVoid) {
            body.push(`    ${call};`);
        } else if (signature.outputs && signature.outputs.length > 1) {
            needsTupleInclude = true;
            body.push(`    auto [${outputs.map(port => expression(`${id}.${port.id}`)).join(', ')}] = ${call};`);
        } else {
            body.push(`    auto ${variable(id)} = ${call};`);
        }
    }

    for (const input of flow.inputs) {
        if (!flow.wires.some(wire => wire.from === `input:${input.name}`)) {
            diagnostics.push({ severity: 'warning', message: `${label}: input ${input.name} is unused.` });
        }
    }

    const results = flow.outputs.map(output => {
        const source = incoming.get(`output:${output.name}`);
        if (!source) errors.push(`output ${output.name} is not wired`);
        return source ? expression(source) : '0';
    });

    if (results.length === 1) {
        body.push(`    return ${results[0]};`);
    } else if (results.length > 1) {
        needsTupleInclude = true;
        body.push(`    return std::make_tuple(${results.join(', ')});`);
    }

    if (errors.length > 0) {
        for (const message of errors) {
            diagnostics.push({ severity: 'error', message: `${label}: ${message}.` });
        }
        return null;
    }

    const parameters = flow.inputs
        .map(input => `${mapToCppType(input.annotation, isArduino)} ${input.name}`)
        .join(', ');

    let returnType = 'void';
    if (flow.outputs.length === 1) {
        returnType = mapToCppType(flow.outputs[0].annotation, isArduino);
    } else if (flow.outputs.length > 1) {
        needsTupleInclude = true;
        const outTypes = flow.outputs.map(o => mapToCppType(o.annotation, isArduino));
        returnType = `std::tuple<${outTypes.join(', ')}>`;
    }

    const code = [`${returnType} ${flow.name}(${parameters}) {`, ...body, `}`];

    const regionTargets = (flow.regions ?? [])
        .flatMap(r => (r.kind === 'branch' ? (r.elseFlow ? [r.thenFlow, r.elseFlow] : [r.thenFlow]) : [r.bodyFlow]))
        .map(t => (t.startsWith('flow:') ? t.slice('flow:'.length) : t));
    const instanceTargets = flow.instances.filter(instance => instance.node).map(instance => instance.node!);
    const targets = [...new Set([...instanceTargets, ...regionTargets])];
    const imports = [...new Set(targets.flatMap(target => resolveAny(target)?.imports ?? []))];

    if (isArduino && !imports.some(l => l.toLowerCase().includes('arduino.h'))) {
        imports.unshift('#include <Arduino.h>');
    }
    if (needsVectorInclude && !imports.some(l => l.includes('<vector>'))) {
        imports.push('#include <vector>');
    }
    if (needsTupleInclude && !imports.some(l => l.includes('<tuple>'))) {
        imports.push('#include <tuple>');
    }

    return {
        name: flow.name,
        language: isArduino ? 'arduino' : 'cpp',
        intent: '',
        contract: '',
        context: [],
        examples: [],
        locked: true,
        order: 1e9,
        imports,
        uses: targets.sort(),
        code,
        extra: {
            flow: true,
            ...(isArduino ? { arduinoSketch: true } : {}),
        },
    };
}

function commentLines(label: string, text: string): string[] {
    if (!text.trim()) return [];
    return text
        .trim()
        .split('\n')
        .map((line, index) => `// ${index === 0 ? `${label}: ` : '  '}${line}`);
}

/**
 * Topologically order function nodes within a C++/Arduino translation unit so callees precede callers,
 * while keeping Arduino `setup()` and `loop()` at the bottom of the sketch.
 */
function orderCppDefinitions(members: Array<[string, SlateNode]>): Array<[string, SlateNode]> {
    const preludes = members.filter(([, n]) => n.kind === 'prelude');
    const epilogues = members.filter(([, n]) => n.kind === 'epilogue');
    const classes = members.filter(([, n]) => !n.kind && (n.extra?.cppKind === 'class' || /^(?:template\s*<[^>]*>\s*)?(?:class|struct)\b/.test(n.code.join('\n').trim())));
    const classIds = new Set(classes.map(([id]) => id));
    const functions = members.filter(([id, n]) => !n.kind && !classIds.has(id));

    const regularFns = functions.filter(([, n]) => n.name !== 'setup' && n.name !== 'loop');
    const setupFns = functions.filter(([, n]) => n.name === 'setup');
    const loopFns = functions.filter(([, n]) => n.name === 'loop');

    // Sort regular functions by base order first, then topological dependency order
    const baseSorted = [...regularFns].sort(([leftId, left], [rightId, right]) =>
        (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
        leftId.localeCompare(rightId),
    );

    const byId = new Map(baseSorted);
    const idByName = new Map(baseSorted.map(([id, n]) => [n.name, id]));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const topo: Array<[string, SlateNode]> = [];

    const visit = (id: string) => {
        if (visited.has(id) || visiting.has(id)) return;
        const node = byId.get(id);
        if (!node) return;
        visiting.add(id);
        for (const dep of node.uses) {
            const depId = byId.has(dep) ? dep : idByName.get(dep.split('/').pop() ?? dep);
            if (depId && byId.has(depId)) {
                visit(depId);
            }
        }
        visiting.delete(id);
        visited.add(id);
        topo.push([id, node]);
    };

    for (const [id] of baseSorted) {
        visit(id);
    }

    return [...preludes, ...classes, ...topo, ...setupFns, ...loopFns, ...epilogues];
}

/**
 * Deterministically compile C++ / Arduino `SlateNode` units and wired `SlateFlow` graphs
 * into `.cpp`, `.h`, or `.ino` Arduino sketch files.
 */
export function compileCpp(
    sourceNodesInput: ReadonlyMap<string, SlateNode> | Record<string, SlateNode>,
    config: SlateConfig,
    flowsInput: ReadonlyMap<string, SlateFlow> | Record<string, SlateFlow> = new Map(),
    library: ReadonlyMap<string, CallableSignature> = new Map(),
    optionsOrExistingFiles?:
        | { checkJpl60?: boolean; existingFiles?: ReadonlyMap<string, string> | Record<string, string> }
        | ReadonlyMap<string, string>
        | Record<string, string>,
): CompileResult {
    const sourceNodes = normalizeNodeMap(sourceNodesInput);
    const flows = normalizeFlowMap(flowsInput);

    let checkJpl = false;
    let existingFiles = new Map<string, string>();
    if (optionsOrExistingFiles) {
        if (
            optionsOrExistingFiles instanceof Map ||
            typeof (optionsOrExistingFiles as ReadonlyMap<string, string>).entries === 'function'
        ) {
            existingFiles = normalizeStringMap(optionsOrExistingFiles as ReadonlyMap<string, string>);
        } else if (
            typeof optionsOrExistingFiles === 'object' &&
            ('checkJpl60' in optionsOrExistingFiles || 'existingFiles' in optionsOrExistingFiles)
        ) {
            const opts = optionsOrExistingFiles as {
                checkJpl60?: boolean;
                existingFiles?: ReadonlyMap<string, string> | Record<string, string>;
            };
            checkJpl = opts.checkJpl60 === true;
            existingFiles = normalizeStringMap(opts.existingFiles);
        } else {
            existingFiles = normalizeStringMap(optionsOrExistingFiles as Record<string, string>);
        }
    }

    const diagnostics: CompileDiagnostic[] = [];
    const error = (message: string) => diagnostics.push({ severity: 'error', message });

    const projectIsArduino =
        isArduinoLanguage(config.language) ||
        [...sourceNodes.values()].some(n => isArduinoLanguage(n.language) || n.extra?.arduinoSketch === true);

    const nodes = new Map<string, SlateNode>(sourceNodes);

    // Build lookup by exact ID and by unique short name
    const findSourceNode = (target: string): [string, SlateNode] | null => {
        if (nodes.has(target)) return [target, nodes.get(target)!];
        const matches = [...nodes.entries()].filter(([, n]) => !n.kind && n.name === target);
        return matches.length === 1 ? matches[0] : null;
    };

    const resolve = (target: string): { signature: CallableSignature; imports: string[] } | null => {
        const clean = target.startsWith('flow:') ? target.slice('flow:'.length) : target;
        const foundNode = findSourceNode(clean);
        if (foundNode) {
            const sig = cppNodeSignature(foundNode[1]);
            return sig ? { signature: sig, imports: foundNode[1].imports } : null;
        }
        const flow = flows.get(clean) ?? [...flows.values()].find(f => f.name === clean);
        if (flow) {
            return { signature: flowSignature(flow), imports: [] };
        }
        const libSig = library.get(target) ?? library.get(clean) ?? null;
        return libSig ? { signature: libSig, imports: [] } : null;
    };

    // Determine primary folder so root-level flows attach to the main sketch/module when present
    const existingFolders = [...new Set([...sourceNodes.keys()].map(folderOf))];
    const primaryFolder = existingFolders.length === 1 ? existingFolders[0] : '';
    const primaryModulePath = primaryFolder
        ? [...sourceNodes.entries()].find(([id]) => folderOf(id) === primaryFolder)?.[1].extra?.modulePath
        : undefined;

    for (const [flowId, flow] of [...flows].sort(([left], [right]) => left.localeCompare(right))) {
        if (flowId === MAIN_FLOW && flow.instances.length === 0 && (!flow.regions || flow.regions.length === 0)) {
            continue;
        }
        if (sourceNodes.has(flowId)) {
            error(`flows/${flowId} has the same id as a node.`);
            continue;
        }
        const flowNode = cppFlowToNode(flowId, flow, resolve, diagnostics, { isArduino: projectIsArduino });
        if (flowNode) {
            let targetNodeId = flowId;
            if (!flowId.includes('/') && primaryFolder) {
                targetNodeId = `${primaryFolder}/${flow.name}`;
            }
            if (typeof primaryModulePath === 'string' && !flowId.includes('/')) {
                flowNode.extra = { ...flowNode.extra, modulePath: primaryModulePath };
            }
            nodes.set(targetNodeId, flowNode);
        }
    }

    const valid = new Map<string, SlateNode>();
    for (const [nodeId, node] of nodes) {
        const language = node.language ?? config.language;
        if (!isCppOrArduinoLanguage(language)) {
            error(`${nodeId}: no C++/Arduino compiler for language "${language}".`);
            continue;
        }
        if (!node.kind && !parseCppModule(`${node.code.join('\n')}\n`, nodeId, node.name).valid) {
            error(`${nodeId}: code is not valid C++.`);
            continue;
        }
        valid.set(nodeId, node);
    }

    if (checkJpl) {
        for (const [nodeId, node] of valid) {
            if (node.kind) continue;
            const jpl = checkCppNodeCode(node);
            for (const diag of jpl.diagnostics) {
                diagnostics.push({ severity: 'warning', message: `${nodeId}: ${diag.message}` });
            }
        }
    }

    const rootModule = projectModuleName(config.name || 'firmware');

    // Group valid nodes by output file path
    const fileGroups = new Map<string, Array<[string, SlateNode]>>();
    const fileForNodeId = new Map<string, string>();

    for (const [nodeId, node] of valid) {
        const folder = folderOf(nodeId);
        const isArd = projectIsArduino || isArduinoLanguage(node.language) || node.extra?.arduinoSketch === true;
        const defaultExt = isArd ? '.ino' : '.cpp';

        let outPath: string;
        if (typeof node.extra?.modulePath === 'string' && node.extra.modulePath.trim()) {
            outPath = node.extra.modulePath.trim().replace(/\\/g, '/');
        } else if (folder) {
            const ext = typeof node.extra?.extension === 'string' ? node.extra.extension : defaultExt;
            outPath = `${folder}${ext}`;
        } else {
            const ext = typeof node.extra?.extension === 'string' ? node.extra.extension : defaultExt;
            outPath = `${rootModule}${ext}`;
        }

        const group = fileGroups.get(outPath) ?? [];
        group.push([nodeId, node]);
        fileGroups.set(outPath, group);
        fileForNodeId.set(nodeId, outPath);
    }

    const files = new Map<string, string>();

    for (const [outPath, rawMembers] of [...fileGroups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        // Check overwrite protection on existingFiles
        const existingContent = existingFiles.get(outPath);
        if (existingContent !== undefined && !isCppGeneratedFile(existingContent)) {
            error(`Refusing to overwrite non-generated file "${outPath}" (missing "${CPP_GENERATED_HEADER}" header).`);
            continue;
        }

        const isArdFile =
            projectIsArduino ||
            outPath.toLowerCase().endsWith('.ino') ||
            rawMembers.some(([, n]) => isArduinoLanguage(n.language) || n.extra?.arduinoSketch === true);
        const isHeaderFile = /\.(h|hpp|hh|hxx)$/i.test(outPath);

        const orderedMembers = orderCppDefinitions(rawMembers);

        // Collect #include lines (system includes first, then local includes)
        const includeSet = new Set<string>();
        const includeLines: string[] = [];
        const addInclude = (line: string) => {
            const normalized = splitCppInclude(line)[0]?.line ?? line.trim();
            if (normalized && !includeSet.has(normalized)) {
                includeSet.add(normalized);
                includeLines.push(normalized);
            }
        };

        if (isArdFile) {
            addInclude('#include <Arduino.h>');
        }

        for (const [, node] of orderedMembers) {
            for (const imp of node.imports) {
                addInclude(imp);
            }
            // Add cross-module header includes if this node uses a node from a header file
            for (const usedId of node.uses) {
                const targetFile = fileForNodeId.get(usedId);
                if (targetFile && targetFile !== outPath && /\.(h|hpp|hh|hxx)$/i.test(targetFile)) {
                    addInclude(`#include "${targetFile}"`);
                }
            }
        }

        // Check if std::string, std::vector, std::tuple are used in member code
        const allCodeText = orderedMembers.map(([, n]) => n.code.join('\n')).join('\n');
        if (allCodeText.includes('std::vector') && !includeLines.some(l => l.includes('<vector>'))) {
            addInclude('#include <vector>');
        }
        if (allCodeText.includes('std::string') && !includeLines.some(l => l.includes('<string>'))) {
            addInclude('#include <string>');
        }
        if ((allCodeText.includes('std::tuple') || allCodeText.includes('std::make_tuple') || allCodeText.includes('std::tie')) && !includeLines.some(l => l.includes('<tuple>'))) {
            addInclude('#include <tuple>');
        }

        const preludeBlocks: string[] = [];
        const classBlocks: string[] = [];
        const forwardPrototypes: string[] = [];
        const functionBlocks: string[] = [];
        const epilogueBlocks: string[] = [];

        const definedFnNames = new Set<string>();

        for (const [nodeId, node] of orderedMembers) {
            const bodyCode = node.code.join('\n').trimEnd();
            if (node.kind === 'prelude') {
                preludeBlocks.push([`// slate: nodes/${nodeId}`, bodyCode].join('\n'));
                continue;
            }
            if (node.kind === 'epilogue') {
                epilogueBlocks.push([`// slate: nodes/${nodeId}`, bodyCode].join('\n'));
                continue;
            }

            const parsed = parseCppModule(`${bodyCode}\n`, nodeId, node.name);
            const topUnit = parsed.units.find(u => u.parentId === null);
            const blockLines = [
                `// slate: ${node.extra?.flow ? 'flows' : 'nodes'}/${nodeId}`,
                ...commentLines('intent', node.intent),
                ...commentLines('contract', node.contract),
                bodyCode,
            ];

            if (topUnit?.kind === 'class' || node.extra?.cppKind === 'class') {
                classBlocks.push(blockLines.join('\n'));
            } else {
                definedFnNames.add(node.name);
                if (topUnit?.signature && node.name !== 'main') {
                    forwardPrototypes.push(`${stripDefaultArgsFromSignature(topUnit.signature)};`);
                }
                functionBlocks.push(blockLines.join('\n'));
            }
        }

        // Synthesize setup() and loop() for Arduino `.ino` sketches when a flow is compiled and setup/loop are absent
        if (isArdFile && !isHeaderFile && outPath.toLowerCase().endsWith('.ino')) {
            const hasFlowNode = orderedMembers.some(([, n]) => n.extra?.flow === true);
            if (hasFlowNode) {
                if (!definedFnNames.has('setup')) {
                    forwardPrototypes.push('void setup();');
                    functionBlocks.push(['void setup() {', '}'].join('\n'));
                    definedFnNames.add('setup');
                }
                if (!definedFnNames.has('loop')) {
                    const mainFlowNode = orderedMembers.find(([, n]) => n.extra?.flow === true && n.name === 'main');
                    const mainSig = mainFlowNode ? cppNodeSignature(mainFlowNode[1]) : null;
                    const canCallMain = mainSig && mainSig.params.filter(p => p.default === null).length === 0;
                    forwardPrototypes.push('void loop();');
                    functionBlocks.push(
                        canCallMain
                            ? ['void loop() {', '    main();', '}'].join('\n')
                            : ['void loop() {', '}'].join('\n'),
                    );
                    definedFnNames.add('loop');
                }
            }
        }

        const sections: string[] = [CPP_GENERATED_HEADER];
        if (isHeaderFile && !preludeBlocks.some(b => b.includes('#pragma once') || b.includes('#ifndef'))) {
            sections.push('#pragma once');
        }
        if (includeLines.length > 0) {
            sections.push(includeLines.join('\n'));
        }
        if (preludeBlocks.length > 0) {
            sections.push(preludeBlocks.join('\n\n'));
        }
        if (classBlocks.length > 0) {
            sections.push(classBlocks.join('\n\n'));
        }
        if (forwardPrototypes.length > 0 && !isHeaderFile) {
            sections.push(forwardPrototypes.join('\n'));
        }
        if (functionBlocks.length > 0) {
            sections.push(functionBlocks.join('\n\n'));
        }
        if (epilogueBlocks.length > 0) {
            sections.push(epilogueBlocks.join('\n\n'));
        }

        files.set(outPath, `${sections.join('\n\n')}\n`);
    }

    if (diagnostics.some(d => d.severity === 'error')) {
        return { files: new Map(), diagnostics };
    }

    return { files, diagnostics };
}

export function compileArduino(
    sourceNodesInput: ReadonlyMap<string, SlateNode> | Record<string, SlateNode>,
    config: SlateConfig,
    flowsInput: ReadonlyMap<string, SlateFlow> | Record<string, SlateFlow> = new Map(),
    library: ReadonlyMap<string, CallableSignature> = new Map(),
    optionsOrExistingFiles?:
        | { checkJpl60?: boolean; existingFiles?: ReadonlyMap<string, string> | Record<string, string> }
        | ReadonlyMap<string, string>
        | Record<string, string>,
): CompileResult {
    return compileCpp(
        sourceNodesInput,
        { ...config, language: 'arduino' },
        flowsInput,
        library,
        optionsOrExistingFiles,
    );
}
