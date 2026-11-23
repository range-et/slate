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
import {
    checkCSharpNodeCode,
    CSHARP_GENERATED_HEADER,
    csharpIdentifierNames,
    csharpTopLevelBindings,
    parseCSharpDetailed,
    parseCSharpModule,
    splitCSharpUsing,
} from '../csharp_adapter';
import {
    isSlateGeneratedContent,
    normalizeCompileOutputPath,
} from '../language_types';
import type { SlateConfig, SlateNode } from '../slate_folder';
import type { CompileDiagnostic, CompileResult } from './python';

export { CSHARP_GENERATED_HEADER };

const folderOf = (nodeId: string) => (nodeId.includes('/') ? nodeId.slice(0, nodeId.lastIndexOf('/')) : '');

function toPascalIdentifier(raw: string, fallback = 'SlateModule'): string {
    const parts = raw
        .replace(/\.cs$/i, '')
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean);
    if (parts.length === 0) return fallback;
    const joined = parts
        .map(p => p[0].toUpperCase() + p.slice(1))
        .join('');
    return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}

export function projectCSharpNamespace(projectName: string, folder = ''): string {
    const rootNs = toPascalIdentifier(projectName, 'SlateProject');
    if (!folder) return rootNs;
    const subParts = folder
        .split('/')
        .filter(Boolean)
        .map(seg => toPascalIdentifier(seg, 'Module'));
    // If the last folder segment is the class name (e.g. `Shapes/Geometry`), use parent segments for namespace if any
    if (subParts.length > 1) {
        return [rootNs, ...subParts.slice(0, -1)].join('.');
    }
    return rootNs;
}

export function defaultCSharpClassName(folder: string, projectName: string): string {
    if (!folder) return toPascalIdentifier(projectName, 'Program');
    const lastSeg = folder.includes('/') ? folder.slice(folder.lastIndexOf('/') + 1) : folder;
    return toPascalIdentifier(lastSeg, 'Program');
}

function blockOrder(node: SlateNode): number {
    return node.kind === 'prelude' ? 0 : node.kind === 'epilogue' ? 2 : 1;
}

/** Map a Slate or Python-style type annotation into a valid C# type annotation. */
export function mapTypeToCSharp(annotation: string | null | undefined, forReturn = false): string {
    if (!annotation || !annotation.trim()) {
        return forReturn ? 'object' : 'object';
    }
    const trimmed = annotation.trim();
    const lower = trimmed.toLowerCase();
    if (lower === 'none' || lower === 'void') return forReturn ? 'void' : 'object';
    if (lower === 'bool' || lower === 'boolean') return 'bool';
    if (lower === 'str' || lower === 'string') return 'string';
    if (lower === 'int' || lower === 'int32' || lower === 'integer') return 'int';
    if (lower === 'float') return 'float';
    if (lower === 'double' || lower === 'number') return 'double';
    if (lower === 'any' || lower === 'object') return 'object';

    const listMatch = trimmed.match(/^(?:List|list|Sequence|sequence|IEnumerable)\[\s*(.+)\s*\]$/);
    if (listMatch) {
        return `List<${mapTypeToCSharp(listMatch[1])}>`;
    }

    const dictMatch = trimmed.match(/^(?:Dict|dict|Mapping)\[\s*([^,]+)\s*,\s*(.+)\s*\]$/);
    if (dictMatch) {
        return `Dictionary<${mapTypeToCSharp(dictMatch[1])}, ${mapTypeToCSharp(dictMatch[2])}>`;
    }

    const tupleMatch = trimmed.match(/^(?:Tuple|tuple)\[\s*(.+)\s*\]$/);
    if (tupleMatch) {
        const parts = tupleMatch[1].split(',').map(s => mapTypeToCSharp(s.trim()));
        return `(${parts.join(', ')})`;
    }

    return trimmed;
}

export function defaultValueForCSharpType(csType: string): string {
    const trimmed = csType.trim();
    if (trimmed === 'int' || trimmed === 'long' || trimmed === 'short' || trimmed === 'byte') return '0';
    if (trimmed === 'double') return '0.0';
    if (trimmed === 'float') return '0.0f';
    if (trimmed === 'decimal') return '0.0m';
    if (trimmed === 'bool') return 'false';
    if (trimmed === 'string') return '""';
    if (trimmed.startsWith('List<') || trimmed.startsWith('Dictionary<')) {
        return `new ${trimmed}()`;
    }
    return `default(${trimmed})`;
}

/** Compile a structured flow value literal into a valid C# expression. */
export function compileValueToCSharp(val: unknown): string {
    if (val === undefined || val === null) return 'null';
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    if (typeof val === 'number') {
        if (Number.isNaN(val)) return 'double.NaN';
        if (val === Infinity) return 'double.PositiveInfinity';
        if (val === -Infinity) return 'double.NegativeInfinity';
        return String(val);
    }
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed === 'true' || trimmed === 'True') return 'true';
        if (trimmed === 'false' || trimmed === 'False') return 'false';
        if (trimmed === 'null' || trimmed === 'None') return 'null';
        if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?[fFdDmM]?$/.test(trimmed)) return trimmed;
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
                return compileValueToCSharp(parsed);
            } catch {
                return trimmed;
            }
        }
        if (
            trimmed.startsWith('new ') ||
            /[+\-*/%&|^<>=]/.test(trimmed) ||
            /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*\(.*\)$/.test(trimmed)
        ) {
            return trimmed;
        }
        return JSON.stringify(val);
    }
    if (typeof val === 'object') {
        const rec = val as Record<string, unknown>;
        if ('expr' in rec && typeof rec.expr === 'string') {
            return rec.expr;
        }
        if (Array.isArray(val)) {
            if (val.length === 0) return 'new List<object>()';
            const elemTypes = new Set(
                val.map(item => {
                    if (typeof item === 'number') return Number.isInteger(item) ? 'int' : 'double';
                    if (typeof item === 'boolean') return 'bool';
                    if (typeof item === 'string') return 'string';
                    return 'object';
                }),
            );
            const elemType = elemTypes.size === 1 ? [...elemTypes][0] : 'object';
            return `new List<${elemType}> { ${val.map(compileValueToCSharp).join(', ')} }`;
        }
        const entries = Object.entries(rec).map(
            ([k, v]) => `{ ${JSON.stringify(k)}, ${compileValueToCSharp(v)} }`,
        );
        return `new Dictionary<string, object> { ${entries.join(', ')} }`;
    }
    return String(val);
}

/** Extract the `CallableSignature` of a C# `SlateNode`, or null if prelude/epilogue/invalid. */
export function csharpNodeSignature(node: SlateNode): CallableSignature | null {
    if (node.kind) return null;
    const parsed = parseCSharpModule(`${node.code.join('\n')}\n`, '<signature>', node.name);
    if (!parsed.valid) return null;
    const methodUnit =
        parsed.units.find(u => (u.kind === 'function' || u.kind === 'method') && u.name === node.name) ??
        parsed.units.find(u => u.name === node.name) ??
        parsed.units[0];
    return methodUnit ? unitSignature(methodUnit, parsed.units) : null;
}

const variable = (instanceId: string) => `v_${instanceId.replace(/[^A-Za-z0-9_]/g, '_')}`;

function csharpComment(label: string, text: string): string[] {
    return text.trim()
        ? text
              .trim()
              .split('\n')
              .map((line, index) => `// ${index === 0 ? `${label}: ` : '  '}${line}`)
        : [];
}

function indentLines(lines: string[], spaces: number): string[] {
    const pad = ' '.repeat(spaces);
    return lines.map(line => (line.trim().length > 0 ? `${pad}${line}` : ''));
}

/**
 * Compile one `SlateFlow` (including `branch`, `foreach`, and `repeat` regions)
 * into a deterministic C# static method `SlateNode`.
 */
export function flowToCSharpNode(
    flowId: string,
    flow: SlateFlow,
    resolve: (target: string) => { signature: CallableSignature; imports: string[]; flow?: SlateFlow } | null,
    diagnostics: CompileDiagnostic[],
): SlateNode | null {
    const label = `flows/${flowId}`;
    const errors: string[] = [];

    const resolveAny = (target: string) =>
        resolve(target) ?? (target.startsWith('flow:') ? resolve(target.slice('flow:'.length)) : null);

    const signatureToFlow = (sig: CallableSignature): SlateFlow => ({
        name: sig.name,
        inputs: sig.params
            .filter(p => p.kind === 'positional' || p.kind === 'keyword')
            .map(p => ({ name: p.name, annotation: p.annotation })),
        outputs: sig.outputs ?? [{ name: 'out', annotation: sig.returns }],
        instances: [],
        wires: [],
        extra: {},
    });

    const flowLookup = (childFlowId: string): SlateFlow | undefined => {
        const res = resolveAny(childFlowId);
        if (!res) return undefined;
        return res.flow ?? signatureToFlow(res.signature);
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
                returns: null,
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
            const thenRes = resolveAny(region.thenFlow);
            if (!thenRes) errors.push(`region ${region.id} calls ${region.thenFlow}, which does not exist`);
            if (region.elseFlow && !resolveAny(region.elseFlow)) {
                errors.push(`region ${region.id} calls ${region.elseFlow}, which does not exist`);
            }
        } else {
            if (!resolveAny(region.bodyFlow)) {
                errors.push(`region ${region.id} calls ${region.bodyFlow}, which does not exist`);
            }
        }
        try {
            regionPortMap.set(region.id, regionPorts(region, flowLookup));
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
        const sig = signatures.get(id);
        return sig ? outputPorts(sig) : [{ id: 'out', name: 'out', annotation: null }];
    };

    const incoming = new Map<string, string>();
    for (const wire of flow.wires) {
        const from = parseEndpoint(wire.from);
        const to = parseEndpoint(wire.to);
        const fromRegionPorts = from.instance !== null ? regionPortMap.get(from.instance) : undefined;
        const fromOk =
            from.instance === null
                ? from.port.startsWith('input:') && flow.inputs.some(input => `input:${input.name}` === from.port)
                : fromRegionPorts
                  ? fromRegionPorts.outputs.some(port => port.id === from.port) ||
                    (fromRegionPorts.outputs.length === 1 &&
                        (from.port === 'out' || from.port === `out:${fromRegionPorts.outputs[0].name}`))
                  : signatures.has(from.instance) && outputsOf(from.instance).some(port => port.id === from.port);

        const isViewerTo = flow.instances.find(i => i.id === to.instance)?.kind === 'viewer';
        const toRegionPorts = to.instance !== null ? regionPortMap.get(to.instance) : undefined;
        const toOk =
            to.instance === null
                ? to.port.startsWith('output:') && flow.outputs.some(output => `output:${output.name}` === to.port)
                : toRegionPorts
                  ? toRegionPorts.inputs.some(port => port.id === to.port)
                  : signatures.has(to.instance) &&
                    ((signatures.get(to.instance)?.params ?? []).some(param => `in:${param.name}` === to.port) ||
                        (isViewerTo && (to.port === 'in' || to.port === 'in:in')));

        if (!fromOk || !toOk) errors.push(`wire ${wire.from} → ${wire.to} has an unknown endpoint`);
        else if (incoming.has(wire.to)) errors.push(`${wire.to} has more than one wire`);
        else incoming.set(wire.to, wire.from);
    }

    const expression = (endpoint: string): string => {
        const { instance, port } = parseEndpoint(endpoint);
        if (instance === null) return port.slice('input:'.length);
        const rPorts = regionPortMap.get(instance);
        if (rPorts && rPorts.outputs.length === 1) {
            return variable(instance);
        }
        return port === 'out' ? variable(instance) : `${variable(instance)}_${port.slice('out:'.length)}`;
    };

    // Topological order via Kahn's algorithm
    const order: string[] = [];
    const pending = new Set([
        ...flow.instances.map(instance => instance.id),
        ...(flow.regions ?? []).map(region => region.id),
    ]);
    while (pending.size) {
        const ready = [...pending].find(id =>
            [...incoming].every(
                ([to, from]) =>
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
    let foreachCount = 0;

    const buildCSharpCall = (
        sig: CallableSignature,
        resolveParamExpr: (paramName: string, hasDefault: boolean) => string | null,
    ): string => {
        const args: string[] = [];
        let skippedOptional = false;
        for (const param of sig.params) {
            if (param.kind === 'var' || param.kind === 'kwvar') continue;
            const expr = resolveParamExpr(param.name, param.default !== null);
            if (expr === null) {
                skippedOptional = true;
                continue;
            }
            if (skippedOptional) {
                args.push(`${param.name}: ${expr}`);
            } else {
                args.push(expr);
            }
        }
        return `${sig.name}(${args.join(', ')})`;
    };

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

                const thenCall = buildCSharpCall(thenSig, (pName, hasDef) => {
                    const src = incoming.get(`${id}.in:${pName}`);
                    if (!src) {
                        if (!hasDef) errors.push(`${id}.in:${pName} is not wired and has no default`);
                        return null;
                    }
                    return expression(src);
                });

                const elseCall = elseSig
                    ? buildCSharpCall(elseSig, (pName, hasDef) => {
                          const src = incoming.get(`${id}.in:${pName}`);
                          if (!src) {
                              if (!hasDef) errors.push(`${id}.in:${pName} is not wired and has no default`);
                              return null;
                          }
                          return expression(src);
                      })
                    : null;

                if (rPorts.outputs.length === 0) {
                    body.push(`    if (${condExpr})`);
                    body.push('    {');
                    body.push(`        ${thenCall};`);
                    body.push('    }');
                    if (elseCall) {
                        body.push('    else');
                        body.push('    {');
                        body.push(`        ${elseCall};`);
                        body.push('    }');
                    }
                } else if (rPorts.outputs.length === 1) {
                    const outVar = variable(id);
                    const outType = mapTypeToCSharp(rPorts.outputs[0].annotation ?? thenSig.returns);
                    body.push(`    ${outType} ${outVar};`);
                    body.push(`    if (${condExpr})`);
                    body.push('    {');
                    body.push(`        ${outVar} = ${thenCall};`);
                    body.push('    }');
                    body.push('    else');
                    body.push('    {');
                    if (elseCall) {
                        body.push(`        ${outVar} = ${elseCall};`);
                    } else {
                        body.push(`        ${outVar} = ${defaultValueForCSharpType(outType)};`);
                    }
                    body.push('    }');
                } else {
                    const outVars = rPorts.outputs.map(p => `${variable(id)}_${p.name}`);
                    for (let i = 0; i < rPorts.outputs.length; i++) {
                        const outType = mapTypeToCSharp(rPorts.outputs[i].annotation);
                        body.push(`    ${outType} ${outVars[i]} = ${defaultValueForCSharpType(outType)};`);
                    }
                    body.push(`    if (${condExpr})`);
                    body.push('    {');
                    body.push(`        (${outVars.join(', ')}) = ${thenCall};`);
                    body.push('    }');
                    if (elseCall) {
                        body.push('    else');
                        body.push('    {');
                        body.push(`        (${outVars.join(', ')}) = ${elseCall};`);
                        body.push('    }');
                    }
                }
                continue;
            }

            if (region.kind === 'foreach') {
                const bodySig = resolveAny(region.bodyFlow)?.signature;
                const bodyFlow = flowLookup(region.bodyFlow);
                if (!bodySig || !bodyFlow) continue;

                const collPort = region.collectionPort ?? 'items';
                const itemPort = region.itemPort ?? 'item';
                const indexPort = region.indexPort ?? 'index';
                const collSource = incoming.get(`${id}.in:${collPort}`);
                if (!collSource) errors.push(`${id}.in:${collPort} is not wired and has no default`);
                const collExpr = collSource ? expression(collSource) : 'new List<object>()';

                foreachCount++;
                const idxVar = foreachCount === 1 ? '_idx' : `_idx_${slug}`;
                const needsIdx =
                    region.maxIterations !== undefined || bodySig.params.some(p => p.name === indexPort);

                const bodyCall = buildCSharpCall(bodySig, (pName, hasDef) => {
                    if (pName === itemPort) return '_item';
                    if (pName === indexPort) return idxVar;
                    const src = incoming.get(`${id}.in:${pName}`);
                    if (!src) {
                        if (!hasDef) errors.push(`${id}.in:${pName} is not wired and has no default`);
                        return null;
                    }
                    return expression(src);
                });

                const outVars =
                    rPorts.outputs.length === 1
                        ? [variable(id)]
                        : rPorts.outputs.map(p => `${variable(id)}_${p.name}`);

                for (let i = 0; i < outVars.length; i++) {
                    const rawElemAnn = bodyFlow.outputs[i]?.annotation ?? bodySig.returns ?? 'object';
                    const elemType = mapTypeToCSharp(rawElemAnn);
                    body.push(`    var ${outVars[i]} = new List<${elemType}>();`);
                }
                if (needsIdx) {
                    body.push(`    int ${idxVar} = 0;`);
                }
                body.push(`    foreach (var _item in ${collExpr})`);
                body.push('    {');
                if (region.maxIterations !== undefined) {
                    body.push(`        if (${idxVar} >= ${region.maxIterations})`);
                    body.push('        {');
                    body.push('            break;');
                    body.push('        }');
                }
                if (outVars.length === 0) {
                    body.push(`        ${bodyCall};`);
                } else if (outVars.length === 1) {
                    body.push(`        var _item_${slug} = ${bodyCall};`);
                    body.push(`        ${outVars[0]}.Add(_item_${slug});`);
                } else {
                    const itemVars = rPorts.outputs.map(p => `_item_${slug}_${p.name}`);
                    body.push(`        var (${itemVars.join(', ')}) = ${bodyCall};`);
                    for (let i = 0; i < outVars.length; i++) {
                        body.push(`        ${outVars[i]}.Add(${itemVars[i]});`);
                    }
                }
                if (needsIdx) {
                    body.push(`        ${idxVar}++;`);
                }
                body.push('    }');
                continue;
            }

            if (region.kind === 'repeat') {
                const bodySig = resolveAny(region.bodyFlow)?.signature;
                const bodyFlow = flowLookup(region.bodyFlow);
                if (!bodySig || !bodyFlow) continue;

                const inputNames = new Set(bodyFlow.inputs.map(p => p.name));
                const stateNames =
                    region.statePorts && region.statePorts.length > 0
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
                    const statePort = bodyFlow.inputs.find(p => p.name === sName);
                    const stateCsType = mapTypeToCSharp(statePort?.annotation);
                    const expr = src ? expression(src) : defaultValueForCSharpType(stateCsType);
                    body.push(`    var ${stateVarFor(sName)} = ${expr};`);
                }

                const bodyCall = buildCSharpCall(bodySig, (pName, hasDef) => {
                    if (stateNames.has(pName)) return stateVarFor(pName);
                    const src = incoming.get(`${id}.in:${pName}`);
                    if (!src) {
                        if (!hasDef) errors.push(`${id}.in:${pName} is not wired and has no default`);
                        return null;
                    }
                    return expression(src);
                });

                const bodyOutputs = bodyFlow.outputs;
                const needsSeparateCondVar =
                    Boolean(region.conditionPort) && !stateNames.has(region.conditionPort!);
                if (needsSeparateCondVar && bodyOutputs.length > 1) {
                    body.push(`    bool _cond_${slug} = false;`);
                }

                let callLine: string;
                if (bodyOutputs.length === 0) {
                    callLine = `${bodyCall};`;
                } else if (bodyOutputs.length === 1) {
                    const outName = bodyOutputs[0].name;
                    if (stateNames.has(outName)) {
                        callLine = `${stateVarFor(outName)} = ${bodyCall};`;
                    } else {
                        callLine = `var _cond_${slug} = ${bodyCall};`;
                    }
                } else {
                    const unpackVars = bodyOutputs.map(p => {
                        if (stateNames.has(p.name)) return stateVarFor(p.name);
                        if (region.conditionPort === p.name) return `_cond_${slug}`;
                        return `var _unused_${slug}_${p.name}`;
                    });
                    callLine = `(${unpackVars.join(', ')}) = ${bodyCall};`;
                }

                const condCheckVar = region.conditionPort
                    ? stateNames.has(region.conditionPort)
                        ? stateVarFor(region.conditionPort)
                        : `_cond_${slug}`
                    : null;

                body.push(`    for (int _iter = 0; _iter < ${region.maxIterations}; _iter++)`);
                body.push('    {');
                body.push(`        ${callLine}`);
                if (condCheckVar) {
                    body.push(`        if (!${condCheckVar})`);
                    body.push('        {');
                    body.push('            break;');
                    body.push('        }');
                }
                body.push('    }');
                continue;
            }
        }

        const instance = flow.instances.find(item => item.id === id)!;
        if (instance.kind === 'value') {
            body.push(`    var ${variable(id)} = ${compileValueToCSharp(instance.value)};`);
            continue;
        }
        if (instance.kind === 'viewer') {
            continue;
        }
        const signature = signatures.get(id);
        if (!signature) continue;

        const call = buildCSharpCall(signature, (pName, hasDef) => {
            const src = incoming.get(`${id}.in:${pName}`);
            if (!src) {
                if (!hasDef) errors.push(`${id}.in:${pName} is not wired and has no default`);
                return null;
            }
            return expression(src);
        });

        const outputs = outputPorts(signature);
        if (
            (signature.outputs && signature.outputs.length === 0) ||
            (!signature.outputs && signature.returns === 'void')
        ) {
            body.push(`    ${call};`);
        } else if (signature.outputs && signature.outputs.length > 1) {
            const tupleVars = outputs.map(port => expression(`${id}.${port.id}`)).join(', ');
            body.push(`    var (${tupleVars}) = ${call};`);
        } else {
            body.push(`    var ${variable(id)} = ${call};`);
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
        return source ? expression(source) : defaultValueForCSharpType(mapTypeToCSharp(output.annotation));
    });

    if (results.length === 1) {
        body.push(`    return ${results[0]};`);
    } else if (results.length > 1) {
        body.push(`    return (${results.join(', ')});`);
    }

    if (errors.length > 0) {
        for (const msg of errors) {
            diagnostics.push({ severity: 'error', message: `${label}: ${msg}.` });
        }
        return null;
    }

    const parameters = flow.inputs
        .map(inp => `${mapTypeToCSharp(inp.annotation)} ${inp.name}`)
        .join(', ');

    let returnType = 'void';
    if (flow.outputs.length === 1) {
        returnType = mapTypeToCSharp(flow.outputs[0].annotation, true);
    } else if (flow.outputs.length > 1) {
        returnType = `(${flow.outputs.map(o => mapTypeToCSharp(o.annotation)).join(', ')})`;
    }

    const code = [
        `public static ${returnType} ${flow.name}(${parameters})`,
        '{',
        ...body,
        '}',
    ];

    const regionTargets = (flow.regions ?? [])
        .flatMap(r => {
            if (r.kind === 'branch') return r.elseFlow ? [r.thenFlow, r.elseFlow] : [r.thenFlow];
            return [r.bodyFlow];
        })
        .map(t => (t.startsWith('flow:') ? t.slice('flow:'.length) : t));

    const instanceTargets = flow.instances.filter(inst => inst.node).map(inst => inst.node!);
    const targets = [...new Set([...instanceTargets, ...regionTargets])];
    const imports = new Set<string>(['using System;']);

    const fullCodeText = code.join('\n');
    if (fullCodeText.includes('List<') || fullCodeText.includes('Dictionary<')) {
        imports.add('using System.Collections.Generic;');
    }
    for (const target of targets) {
        for (const imp of resolveAny(target)?.imports ?? []) {
            imports.add(imp);
        }
    }

    return {
        name: flow.name,
        language: 'csharp',
        intent: '',
        contract: '',
        context: [],
        examples: [],
        locked: true,
        order: 1e9,
        imports: [...imports],
        uses: targets.sort(),
        code,
        extra: {
            flow: true,
            ...(flow.extra ?? {}),
        },
    };
}

function toNodeMap(input: ReadonlyMap<string, SlateNode> | Record<string, SlateNode>): Map<string, SlateNode> {
    if (input instanceof Map) return new Map(input);
    return new Map(Object.entries(input));
}

function toFlowMap(
    input?: ReadonlyMap<string, SlateFlow> | Record<string, SlateFlow>,
): Map<string, SlateFlow> {
    if (!input) return new Map();
    if (input instanceof Map) return new Map(input);
    return new Map(Object.entries(input));
}

function toStringMap(
    input?: ReadonlyMap<string, string> | Record<string, string>,
): Map<string, string> {
    if (!input) return new Map();
    const entries = input instanceof Map ? [...input.entries()] : Object.entries(input);
    const out = new Map<string, string>();
    for (const [k, v] of entries) {
        const norm = normalizeCompileOutputPath(k);
        if (norm) out.set(norm, v);
    }
    return out;
}

/**
 * Compile C# `SlateNode` definitions and wired `SlateFlow` graphs into deterministic `.cs` files
 * wrapped in their `namespace` and container `class` with the `// Generated by Slate — do not edit by hand.` header.
 */
export function compileCSharp(
    sourceNodesInput: ReadonlyMap<string, SlateNode> | Record<string, SlateNode>,
    config: SlateConfig,
    flowsInput?: ReadonlyMap<string, SlateFlow> | Record<string, SlateFlow>,
    library: ReadonlyMap<string, CallableSignature> = new Map(),
    options?: {
        checkJpl60?: boolean;
        existingFiles?: ReadonlyMap<string, string> | Record<string, string>;
    },
): CompileResult {
    const diagnostics: CompileDiagnostic[] = [];
    const error = (message: string) => diagnostics.push({ severity: 'error', message });

    const sourceNodes = toNodeMap(sourceNodesInput);
    const flows = toFlowMap(flowsInput);
    const existingFiles = toStringMap(options?.existingFiles);
    const nodes = new Map(sourceNodes);

    const resolve = (target: string) => {
        const clean = target.startsWith('flow:') ? target.slice('flow:'.length) : target;
        const node = sourceNodes.get(clean);
        const flow = node ? undefined : flows.get(clean);
        if (flow) return { signature: flowSignature(flow), imports: [], flow };
        const signature = node ? csharpNodeSignature(node) : library.get(target) ?? library.get(clean) ?? null;
        return signature ? { signature, imports: node?.imports ?? [] } : null;
    };

    for (const [flowId, flow] of [...flows].sort(([a], [b]) => a.localeCompare(b))) {
        if (flowId === MAIN_FLOW && flow.instances.length === 0 && (!flow.regions || flow.regions.length === 0)) {
            continue;
        }
        if (sourceNodes.has(flowId)) {
            error(`flows/${flowId} has the same id as a node.`);
            continue;
        }
        const flowNode = flowToCSharpNode(flowId, flow, resolve, diagnostics);
        if (flowNode) nodes.set(flowId, flowNode);
    }

    const valid = new Map<string, SlateNode>();
    for (const [nodeId, node] of nodes) {
        const rawLang = (node.language ?? config.language ?? 'csharp').toLowerCase();
        if (rawLang !== 'csharp' && rawLang !== 'cs' && rawLang !== 'c#') {
            error(`${nodeId}: no C# compiler for language "${node.language ?? config.language}".`);
            continue;
        }
        if (!node.kind && !parseCSharpModule(`${node.code.join('\n')}\n`, nodeId, nodeId).valid) {
            error(`${nodeId}: code is not valid C#.`);
            continue;
        }
        valid.set(nodeId, node);
    }

    if (options?.checkJpl60) {
        for (const [nodeId, node] of valid) {
            if (node.kind) continue;
            const jpl = checkCSharpNodeCode(node);
            for (const diag of jpl.diagnostics) {
                diagnostics.push({ severity: 'warning', message: `${nodeId}: ${diag.message}` });
            }
        }
    }

    // Determine target `.cs` file path for each node
    const existingFolders = [...new Set([...sourceNodes.keys()].map(folderOf))];
    const defaultSingleFolder = existingFolders.length === 1 ? existingFolders[0] : '';

    const modulePathForNode = (nodeId: string, node: SlateNode): string => {
        if (typeof node.extra?.modulePath === 'string' && node.extra.modulePath.trim()) {
            const p = node.extra.modulePath.trim().replace(/\\/g, '/');
            return p.endsWith('.cs') ? p : `${p}.cs`;
        }
        let folder = folderOf(nodeId);
        // If a generated root-level flow (`main` or `pipeline`) is compiled alongside a single module folder,
        // check if another node in that folder provides `modulePath`
        if (!folder && node.extra?.flow && defaultSingleFolder) {
            const samplePeer = [...sourceNodes.entries()].find(([id]) => folderOf(id) === defaultSingleFolder)?.[1];
            if (typeof samplePeer?.extra?.modulePath === 'string') {
                return samplePeer.extra.modulePath.replace(/\\/g, '/');
            }
            folder = defaultSingleFolder;
        }
        if (!folder) {
            return `${toPascalIdentifier(config.name, 'Program')}.cs`;
        }
        return folder.endsWith('.cs') ? folder : `${folder}.cs`;
    };

    const groupedByFile = new Map<string, Array<[string, SlateNode]>>();
    const nodeContainerInfo = new Map<string, { namespace: string; className: string; filePath: string }>();

    for (const [nodeId, node] of valid) {
        const rawFilePath = modulePathForNode(nodeId, node);
        const filePath = normalizeCompileOutputPath(rawFilePath);
        if (!filePath) {
            error(`${nodeId}: invalid unsafe output path "${rawFilePath}".`);
            continue;
        }
        const list = groupedByFile.get(filePath) ?? [];
        list.push([nodeId, node]);
        groupedByFile.set(filePath, list);
    }

    // First pass: resolve per-node namespace and container class metadata cleanly (preserving multi-class files)
    const fileDefaultMeta = new Map<
        string,
        { namespace: string; className: string; classModifiers: string; classDeclaration: string | null }
    >();
    const memberContainerMeta = new Map<
        string,
        { namespace: string; className: string; classModifiers: string; classDeclaration: string }
    >();

    for (const [filePath, members] of groupedByFile) {
        const folder = filePath.endsWith('.cs') ? filePath.slice(0, -'.cs'.length) : filePath;
        const defaultNs = members
            .map(([, n]) => (typeof n.extra?.namespace === 'string' ? n.extra.namespace.trim() : ''))
            .find(Boolean) || projectCSharpNamespace(config.name, folder);
        const defaultClass = members
            .map(([, n]) => (typeof n.extra?.className === 'string' ? n.extra.className.trim() : ''))
            .find(Boolean) || defaultCSharpClassName(folder, config.name);
        const defaultMods = members
            .map(([, n]) => (typeof n.extra?.classModifiers === 'string' ? n.extra.classModifiers.trim() : ''))
            .find(Boolean) || 'public static';
        const defaultDecl = members
            .map(([, n]) => (typeof n.extra?.classDeclaration === 'string' ? n.extra.classDeclaration.trim() : ''))
            .find(Boolean) || null;

        fileDefaultMeta.set(filePath, {
            namespace: defaultNs,
            className: defaultClass,
            classModifiers: defaultMods,
            classDeclaration: defaultDecl,
        });

        for (const [nodeId, n] of members) {
            const ns = typeof n.extra?.namespace === 'string' && n.extra.namespace.trim()
                ? n.extra.namespace.trim()
                : defaultNs;
            const cls = typeof n.extra?.className === 'string' && n.extra.className.trim()
                ? n.extra.className.trim()
                : defaultClass;
            const mods = typeof n.extra?.classModifiers === 'string' && n.extra.classModifiers.trim()
                ? n.extra.classModifiers.trim()
                : defaultMods;
            const rawDecl = typeof n.extra?.classDeclaration === 'string' && n.extra.classDeclaration.trim()
                ? n.extra.classDeclaration.trim()
                : (cls === defaultClass && defaultDecl ? defaultDecl : `${mods} class ${cls}`);
            memberContainerMeta.set(nodeId, {
                namespace: ns,
                className: cls,
                classModifiers: mods,
                classDeclaration: rawDecl,
            });
            nodeContainerInfo.set(nodeId, { namespace: ns, className: cls, filePath });
        }
    }

    const preludeBindings = new Map<string, Set<string>>();
    for (const [nodeId, node] of valid) {
        if (node.kind === 'prelude') {
            preludeBindings.set(nodeId, csharpTopLevelBindings(node.code.join('\n')));
        }
    }

    const files = new Map<string, string>();

    for (const [filePath, rawMembers] of [...groupedByFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const existingContent = existingFiles.get(filePath);
        if (existingContent !== undefined && !isSlateGeneratedContent(existingContent) && !existingContent.includes('// Generated by Slate')) {
            error(`Refusing to overwrite existing file "${filePath}" without a "// Generated by Slate" header.`);
            continue;
        }

        const meta = fileDefaultMeta.get(filePath)!;
        const members = [...rawMembers].sort(
            ([leftId, left], [rightId, right]) =>
                blockOrder(left) - blockOrder(right) ||
                (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
                leftId.localeCompare(rightId),
        );

        const usingsSet = new Set<string>();
        const staticUsingsSet = new Set<string>();

        for (const [nodeId, node] of members) {
            const memberMeta = memberContainerMeta.get(nodeId)!;
            for (const rawImport of node.imports) {
                const parsedUsings = splitCSharpUsing(rawImport.endsWith(';') ? rawImport : `${rawImport};`);
                if (parsedUsings.length > 0) {
                    for (const u of parsedUsings) usingsSet.add(u.line);
                } else if (rawImport.trim().startsWith('using ')) {
                    const clean = rawImport.trim().endsWith(';') ? rawImport.trim() : `${rawImport.trim()};`;
                    usingsSet.add(clean);
                } else {
                    error(`${nodeId}: "${rawImport}" is not a valid C# using directive.`);
                }
            }

            const idents = csharpIdentifierNames(node.code.join('\n'));
            for (const target of node.uses) {
                const usedNode = valid.get(target);
                if (!usedNode) {
                    error(`${nodeId} uses ${target}, which ${nodes.has(target) ? 'did not compile' : 'does not exist'}.`);
                    continue;
                }
                const targetMeta = nodeContainerInfo.get(target);
                if (!targetMeta || (targetMeta.filePath === filePath && targetMeta.className === memberMeta.className && targetMeta.namespace === memberMeta.namespace)) {
                    continue;
                }
                if (targetMeta.namespace !== memberMeta.namespace) {
                    usingsSet.add(`using ${targetMeta.namespace};`);
                }
                // If the caller invokes the method by bare name without qualifying `TargetClass.Method`,
                // emit `using static TargetNs.TargetClass;` so C# resolves the static method directly.
                if (idents.has(usedNode.name) && !idents.has(targetMeta.className)) {
                    staticUsingsSet.add(`using static ${targetMeta.namespace}.${targetMeta.className};`);
                }
            }
        }

        const allUsings = [...usingsSet, ...staticUsingsSet];

        // Group members by namespace -> (standalone types vs class-container groups preserving declaration headers)
        interface ClassGroup {
            header: string;
            blocks: string[];
        }
        const nsGroups = new Map<string, { classes: Map<string, ClassGroup>; standalone: string[] }>();
        const ensureNsBucket = (ns: string) => {
            let bucket = nsGroups.get(ns);
            if (!bucket) {
                bucket = { classes: new Map(), standalone: [] };
                nsGroups.set(ns, bucket);
            }
            return bucket;
        };

        for (const [nodeId, node] of members) {
            const memberMeta = memberContainerMeta.get(nodeId)!;
            const nsBucket = ensureNsBucket(memberMeta.namespace);
            const stamp = `// slate: ${node.extra?.flow ? 'flows' : 'nodes'}/${nodeId}`;
            const intentLines = csharpComment('intent', node.intent);
            const contractLines = csharpComment('contract', node.contract);
            const detailed = !node.kind
                ? parseCSharpDetailed(`${node.code.join('\n')}\n`, nodeId, nodeId)
                : null;
            const isTopLevelType =
                detailed !== null &&
                detailed.valid &&
                detailed.units.length > 0 &&
                detailed.units[0].parentId === null &&
                detailed.units[0].kind === 'class';

            if (isTopLevelType) {
                const blockLines = [stamp, ...intentLines, ...contractLines, ...node.code];
                nsBucket.standalone.push(indentLines(blockLines, 4).join('\n'));
            } else {
                const blockLines = [stamp, ...intentLines, ...contractLines, ...node.code];
                const classKey = `${memberMeta.className}|${memberMeta.classDeclaration}`;
                let clsGroup = nsBucket.classes.get(classKey);
                if (!clsGroup) {
                    clsGroup = { header: memberMeta.classDeclaration, blocks: [] };
                    nsBucket.classes.set(classKey, clsGroup);
                }
                clsGroup.blocks.push(indentLines(blockLines, 8).join('\n'));
            }
        }

        const nsSections: string[] = [];
        for (const [ns, bucket] of nsGroups.entries()) {
            const namespaceBodyParts: string[] = [];
            for (const clsGroup of bucket.classes.values()) {
                const headerLines = clsGroup.header.split('\n').map(l => `    ${l}`);
                namespaceBodyParts.push([
                    ...headerLines,
                    '    {',
                    clsGroup.blocks.join('\n\n'),
                    '    }',
                ].join('\n'));
            }
            if (bucket.standalone.length > 0) {
                namespaceBodyParts.push(...bucket.standalone);
            }
            nsSections.push([
                `namespace ${ns}`,
                '{',
                namespaceBodyParts.join('\n\n'),
                '}',
            ].join('\n'));
        }
        if (nsSections.length === 0) {
            nsSections.push([`namespace ${meta.namespace}`, '{', '}'].join('\n'));
        }

        const fileSections: string[] = [CSHARP_GENERATED_HEADER];
        if (allUsings.length > 0) {
            fileSections.push(allUsings.join('\n'));
        }
        fileSections.push(...nsSections);

        files.set(filePath, `${fileSections.join('\n\n')}\n`);
    }

    return {
        files: new Map([...files].sort(([a], [b]) => a.localeCompare(b))),
        diagnostics,
    };
}
