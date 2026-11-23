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
    GENERATED_SLASH_HEADER,
    isSlateGeneratedContent,
    normalizeLanguage,
    type CanonicalLanguage,
} from '../language_types';
import type { SlateConfig, SlateNode } from '../slate_folder';
import {
    checkTsNodeCode,
    parseTsModule,
    splitTsImport,
    tsIdentifierNames,
    tsTopLevelBindings,
} from '../ts_adapter';
import { projectModuleName, type CompileDiagnostic, type CompileResult } from './python';

export { GENERATED_SLASH_HEADER as TS_GENERATED_HEADER, type CompileDiagnostic, type CompileResult };

const folderOf = (nodeId: string) => (nodeId.includes('/') ? nodeId.slice(0, nodeId.lastIndexOf('/')) : '');
const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const variable = (instanceId: string) => `v_${instanceId.replace(/[^A-Za-z0-9_]/g, '_')}`;

function blockOrder(node: SlateNode): number {
    return node.kind === 'prelude' ? 0 : node.kind === 'epilogue' ? 2 : 1;
}

function commentLines(label: string, text: string): string[] {
    return text.trim()
        ? text
              .trim()
              .split('\n')
              .map((line, index) => `// ${index === 0 ? `${label}: ` : '  '}${line}`)
        : [];
}

/**
 * Compile a literal value from a flow value instance into a TypeScript/JavaScript expression.
 */
export function compileValueToTs(val: unknown): string {
    if (val === undefined) return 'undefined';
    if (val === null) return 'null';
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    if (typeof val === 'number') {
        if (Number.isNaN(val)) return 'NaN';
        if (val === Infinity) return 'Infinity';
        if (val === -Infinity) return '-Infinity';
        return String(val);
    }
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed === 'true' || trimmed === 'True') return 'true';
        if (trimmed === 'false' || trimmed === 'False') return 'false';
        if (trimmed === 'null' || trimmed === 'None') return 'null';
        if (trimmed === 'undefined') return 'undefined';
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
                return compileValueToTs(parsed);
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
        if (val && !Array.isArray(val) && 'expr' in val && typeof (val as { expr?: unknown }).expr === 'string') {
            return (val as { expr: string }).expr;
        }
        if (Array.isArray(val)) {
            return `[${val.map(compileValueToTs).join(', ')}]`;
        }
        const entries = Object.entries(val as Record<string, unknown>).map(
            ([k, v]) => `${JSON.stringify(k)}: ${compileValueToTs(v)}`,
        );
        return `{ ${entries.join(', ')} }`;
    }
    return String(val);
}

/**
 * Extract the callable signature of a TypeScript/JavaScript `SlateNode`.
 */
export function tsNodeSignature(node: SlateNode): CallableSignature | null {
    if (node.kind) return null;
    const ext = typeof node.extra?.extension === 'string' ? node.extra.extension : '.tsx';
    const units = parseTsModule(`${node.code.join('\n')}\n`, `<signature>${ext}`).units;
    const unit = units.find(item => item.parentId === null && item.name === node.name);
    return unit ? unitSignature(unit, units) : null;
}

function ensureExportedDeclaration(lines: string[]): string[] {
    if (lines.length === 0) return lines;
    const result = [...lines];
    for (let i = 0; i < result.length; i++) {
        const trimmed = result[i].trimStart();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('@')) {
            continue;
        }
        if (trimmed.startsWith('export ')) break;
        if (/^(async\s+)?function\s+|^(const|let|var|class|interface|type|enum)\s+/.test(trimmed)) {
            const indent = result[i].match(/^[ \t]*/)?.[0] ?? '';
            result[i] = `${indent}export ${trimmed}`;
        }
        break;
    }
    return result;
}

/**
 * Merge normalized `import { x } from "mod";` lines by module specifier while preserving default/namespace/side-effect imports.
 */
function mergeTsImports(lines: string[]): string[] {
    const namedByMod = new Map<string, { isType: boolean; specs: string[] }>();
    const orderedEntries: Array<{ kind: 'raw'; line: string } | { kind: 'named'; module: string; isType: boolean }> = [];
    const seenRaw = new Set<string>();

    for (const rawLine of lines) {
        const items = splitTsImport(rawLine);
        if (items.length === 1 && items[0].name !== null && items[0].name !== 'default' && items[0].name !== '*') {
            const item = items[0];
            const importedName = item.name!;
            const key = `${item.isTypeOnly ? 'type:' : ''}${item.module}`;
            const spec = item.binding && item.binding !== importedName ? `${importedName} as ${item.binding}` : importedName;
            const existing = namedByMod.get(key);
            if (!existing) {
                namedByMod.set(key, { isType: Boolean(item.isTypeOnly), specs: [spec] });
                orderedEntries.push({ kind: 'named', module: key, isType: Boolean(item.isTypeOnly) });
            } else if (!existing.specs.includes(spec)) {
                existing.specs.push(spec);
            }
        } else {
            if (!seenRaw.has(rawLine)) {
                seenRaw.add(rawLine);
                orderedEntries.push({ kind: 'raw', line: rawLine });
            }
        }
    }

    return orderedEntries.map(entry => {
        if (entry.kind === 'raw') return entry.line;
        const group = namedByMod.get(entry.module)!;
        const modSpec = entry.isType ? entry.module.slice('type:'.length) : entry.module;
        return `import ${entry.isType ? 'type ' : ''}{ ${group.specs.join(', ')} } from "${modSpec}";`;
    });
}

function relativeModuleSpecifier(fromFile: string, toFile: string): string {
    const stripExt = (p: string) => p.replace(/\.(tsx|ts|jsx|js)$/i, '');
    const fromDir = dirname(fromFile).split('/').filter(Boolean);
    const toStem = stripExt(toFile).replace(/\/index$/, '');
    const toParts = toStem.split('/').filter(Boolean);

    let common = 0;
    while (common < fromDir.length && common < toParts.length && fromDir[common] === toParts[common]) {
        common++;
    }
    const upCount = fromDir.length - common;
    const relParts = [
        ...(upCount === 0 ? ['.'] : Array.from({ length: upCount }, () => '..')),
        ...toParts.slice(common),
    ];
    const rel = relParts.join('/');
    return rel === '.' ? './index' : rel;
}

/**
 * Compile a wired `SlateFlow` (including `branch`, `foreach`, and `repeat` control-flow regions)
 * into a TypeScript or JavaScript function `SlateNode`.
 */
export function flowToTsNode(
    flowId: string,
    flow: SlateFlow,
    resolve: (target: string) => { signature: CallableSignature; imports: string[]; isClass?: boolean } | null,
    diagnostics: CompileDiagnostic[],
    options?: { language?: 'typescript' | 'javascript' },
): SlateNode | null {
    const isJs = options?.language === 'javascript';
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
        return res ? signatureToFlow(res.signature) : undefined;
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
            if (!resolveAny(region.thenFlow)) {
                errors.push(`region ${region.id} calls ${region.thenFlow}, which does not exist`);
            }
            if (region.elseFlow && !resolveAny(region.elseFlow)) {
                errors.push(`region ${region.id} calls ${region.elseFlow}, which does not exist`);
            }
        } else {
            if (!resolveAny(region.bodyFlow)) {
                errors.push(`region ${region.id} calls ${region.bodyFlow}, which does not exist`);
            }
        }
        try {
            const rp = regionPorts(region, flowLookup);
            if (region.kind === 'repeat' && rp.outputs.length === 0) {
                const bf = flowLookup(region.bodyFlow);
                if (bf && bf.outputs.length > 0) {
                    const stateName = region.statePorts?.[0] ?? bf.outputs[0].name;
                    rp.outputs.push({
                        id: 'out',
                        name: stateName,
                        annotation: bf.outputs[0].annotation,
                    });
                }
            }
            regionPortMap.set(region.id, rp);
        } catch {
            // Recorded above
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

    const expression = (endpoint: string) => {
        const { instance, port } = parseEndpoint(endpoint);
        if (instance === null) return port.slice('input:'.length);
        const rPorts = regionPortMap.get(instance);
        if (rPorts && rPorts.outputs.length === 1) {
            return variable(instance);
        }
        return port === 'out' ? variable(instance) : `${variable(instance)}_${port.slice('out:'.length)}`;
    };

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

    const buildPositionalArgs = (
        sig: CallableSignature,
        stepId: string,
        overrides?: ReadonlyMap<string, string>,
    ): string[] => {
        const args: string[] = [];
        for (const param of sig.params) {
            if (param.kind === 'var' || param.kind === 'kwvar') continue;
            if (overrides?.has(param.name)) {
                args.push(overrides.get(param.name)!);
                continue;
            }
            const src = incoming.get(`${stepId}.in:${param.name}`);
            if (!src) {
                if (param.default === null) {
                    errors.push(`${stepId}.in:${param.name} is not wired and has no default`);
                } else {
                    args.push('undefined');
                }
                continue;
            }
            args.push(expression(src));
        }
        while (args.length > 0 && args[args.length - 1] === 'undefined') {
            args.pop();
        }
        return args;
    };

    const body: string[] = [];
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

                const thenCall = `${thenSig.name}(${buildPositionalArgs(thenSig, id).join(', ')})`;
                const elseCall = elseSig ? `${elseSig.name}(${buildPositionalArgs(elseSig, id).join(', ')})` : null;

                const outVars =
                    rPorts.outputs.length === 1
                        ? [variable(id)]
                        : rPorts.outputs.map(p => `${variable(id)}_${p.name}`);

                for (const ov of outVars) {
                    body.push(`    let ${ov}${!isJs ? ': any' : ''};`);
                }
                body.push(`    if (${condExpr}) {`);
                if (outVars.length === 0) {
                    body.push(`        ${thenCall};`);
                } else if (outVars.length === 1) {
                    body.push(`        ${outVars[0]} = ${thenCall};`);
                } else {
                    body.push(`        [${outVars.join(', ')}] = ${thenCall};`);
                }
                body.push(`    } else {`);
                if (elseCall) {
                    if (outVars.length === 0) {
                        body.push(`        ${elseCall};`);
                    } else if (outVars.length === 1) {
                        body.push(`        ${outVars[0]} = ${elseCall};`);
                    } else {
                        body.push(`        [${outVars.join(', ')}] = ${elseCall};`);
                    }
                } else {
                    for (const ov of outVars) {
                        body.push(`        ${ov} = undefined;`);
                    }
                }
                body.push(`    }`);
                continue;
            }

            if (region.kind === 'foreach') {
                const bodySig = resolveAny(region.bodyFlow)?.signature;
                if (!bodySig) continue;

                const collPort = region.collectionPort ?? 'items';
                const itemPort = region.itemPort ?? 'item';
                const indexPort = region.indexPort ?? 'index';
                const collSource = incoming.get(`${id}.in:${collPort}`);
                if (!collSource) errors.push(`${id}.in:${collPort} is not wired and has no default`);
                const collExpr = collSource ? expression(collSource) : '[]';

                const overrides = new Map<string, string>([
                    [itemPort, 'item'],
                    [indexPort, 'idx'],
                ]);
                const bodyCall = `${bodySig.name}(${buildPositionalArgs(bodySig, id, overrides).join(', ')})`;
                const outVars =
                    rPorts.outputs.length === 1
                        ? [variable(id)]
                        : rPorts.outputs.map(p => `${variable(id)}_${p.name}`);

                for (const ov of outVars) {
                    body.push(`    const ${ov}${!isJs ? ': any[]' : ''} = [];`);
                }
                body.push(`    for (const [idx, item] of Array.from(${collExpr}).entries()) {`);
                if (region.maxIterations !== undefined) {
                    body.push(`        if (idx >= ${region.maxIterations}) break;`);
                }
                if (outVars.length === 0) {
                    body.push(`        ${bodyCall};`);
                } else if (outVars.length === 1) {
                    body.push(`        const _item_${slug} = ${bodyCall};`);
                    body.push(`        ${outVars[0]}.push(_item_${slug});`);
                } else {
                    const itemVars = rPorts.outputs.map(p => `_item_${slug}_${p.name}`);
                    body.push(`        const [${itemVars.join(', ')}] = ${bodyCall};`);
                    for (let i = 0; i < outVars.length; i++) {
                        body.push(`        ${outVars[i]}.push(${itemVars[i]});`);
                    }
                }
                body.push(`    }`);
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
                const effectiveStateNames =
                    stateNames.size > 0
                        ? [...stateNames]
                        : bodyFlow.inputs.length > 0
                          ? [bodyFlow.inputs[0].name]
                          : [];

                const stateVarFor = (sName: string) =>
                    (stateOutputs.length === 1 && stateOutputs[0].name === sName) ||
                    (stateOutputs.length === 0 && effectiveStateNames.length === 1 && effectiveStateNames[0] === sName)
                        ? variable(id)
                        : `${variable(id)}_${sName}`;

                const overrides = new Map<string, string>();
                for (const sName of effectiveStateNames) {
                    const src = incoming.get(`${id}.in:${sName}`);
                    if (!src) errors.push(`${id}.in:${sName} is not wired and has no default`);
                    const expr = src ? expression(src) : 'undefined';
                    const sVar = stateVarFor(sName);
                    body.push(`    let ${sVar}${!isJs ? ': any' : ''} = ${expr};`);
                    overrides.set(sName, sVar);
                }

                const bodyCall = `${bodySig.name}(${buildPositionalArgs(bodySig, id, overrides).join(', ')})`;
                const bodyOutputs = bodyFlow.outputs;
                const needsCondDecl = Boolean(region.conditionPort && !stateNames.has(region.conditionPort));
                if (needsCondDecl) {
                    body.push(`    let _cond_${slug}${!isJs ? ': any' : ''} = true;`);
                }

                body.push(`    for (let _iter = 0; _iter < ${region.maxIterations}; _iter++) {`);
                if (bodyOutputs.length === 0) {
                    body.push(`        ${bodyCall};`);
                } else if (bodyOutputs.length === 1) {
                    const outName = bodyOutputs[0].name;
                    const targetVar =
                        stateNames.has(outName) || effectiveStateNames.length === 1
                            ? stateVarFor(effectiveStateNames[0] ?? outName)
                            : `_cond_${slug}`;
                    body.push(`        ${targetVar} = ${bodyCall};`);
                } else {
                    const unpackVars = bodyOutputs.map(p => {
                        if (stateNames.has(p.name)) return stateVarFor(p.name);
                        if (region.conditionPort === p.name) return `_cond_${slug}`;
                        return `_unused_${slug}_${p.name}`;
                    });
                    const unusedDecls = unpackVars.filter(v => v.startsWith(`_unused_${slug}_`));
                    for (const uVar of unusedDecls) {
                        body.push(`        let ${uVar}${!isJs ? ': any' : ''};`);
                    }
                    body.push(`        [${unpackVars.join(', ')}] = ${bodyCall};`);
                }

                const condCheckVar = region.conditionPort
                    ? stateNames.has(region.conditionPort)
                        ? stateVarFor(region.conditionPort)
                        : `_cond_${slug}`
                    : null;
                if (condCheckVar) {
                    body.push(`        if (!${condCheckVar}) break;`);
                }
                body.push(`    }`);
                continue;
            }
        }

        const instance = flow.instances.find(item => item.id === id)!;
        if (instance.kind === 'value') {
            body.push(`    const ${variable(id)} = ${compileValueToTs(instance.value)};`);
            continue;
        }
        if (instance.kind === 'viewer') {
            continue;
        }
        const signature = signatures.get(id);
        if (!signature) continue;
        const resolved = resolveAny(instance.node!);
        const args = buildPositionalArgs(signature, id);
        const call = `${resolved?.isClass ? 'new ' : ''}${signature.name}(${args.join(', ')})`;
        const outputs = outputPorts(signature);
        if (signature.outputs && signature.outputs.length === 0) {
            body.push(`    ${call};`);
        } else if (signature.outputs && signature.outputs.length > 1) {
            body.push(`    const [${outputs.map(port => expression(`${id}.${port.id}`)).join(', ')}] = ${call};`);
        } else {
            body.push(`    const ${variable(id)} = ${call};`);
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
        return source ? expression(source) : 'undefined';
    });

    if (results.length === 1) {
        body.push(`    return ${results[0]};`);
    } else if (results.length > 1) {
        body.push(`    return [${results.join(', ')}];`);
    }

    if (errors.length) {
        for (const message of errors) {
            diagnostics.push({ severity: 'error', message: `${label}: ${message}.` });
        }
        return null;
    }

    const parameters = flow.inputs
        .map(input => (!isJs && input.annotation ? `${input.name}: ${input.annotation}` : input.name))
        .join(', ');
    const annotations = flow.outputs.map(output => output.annotation);
    const returns = isJs
        ? ''
        : flow.outputs.length === 0
          ? ': void'
          : annotations.every(Boolean)
            ? `: ${annotations.length === 1 ? annotations[0] : `[${annotations.join(', ')}]`}`
            : '';

    const code = [`export function ${flow.name}(${parameters})${returns} {`, ...body, `}`];
    const used = tsIdentifierNames(code.join('\n'));
    const regionTargets = (flow.regions ?? [])
        .flatMap(r => {
            if (r.kind === 'branch') return r.elseFlow ? [r.thenFlow, r.elseFlow] : [r.thenFlow];
            return [r.bodyFlow];
        })
        .map(t => (t.startsWith('flow:') ? t.slice('flow:'.length) : t));
    const instanceTargets = flow.instances.filter(instance => instance.node).map(instance => instance.node!);
    const targets = [...new Set([...instanceTargets, ...regionTargets])];
    const imports = [...new Set(targets.flatMap(target => resolveAny(target)?.imports ?? []))].filter(line =>
        splitTsImport(line).some(item => item.binding !== null && used.has(item.binding)),
    );

    return {
        name: flow.name,
        language: isJs ? 'javascript' : 'typescript',
        intent: '',
        contract: '',
        context: [],
        examples: [],
        locked: true,
        order: 1e9,
        imports,
        uses: targets.sort(),
        code,
        extra: { flow: true },
    };
}

function normalizeExistingFiles(
    existingFiles?: ReadonlyMap<string, string> | Record<string, string>,
): Map<string, string> {
    if (!existingFiles) return new Map();
    if (existingFiles instanceof Map) {
        return new Map([...existingFiles.entries()].map(([k, v]) => [k.replace(/\\/g, '/').replace(/^\.\//, ''), v]));
    }
    return new Map(Object.entries(existingFiles).map(([k, v]) => [k.replace(/\\/g, '/').replace(/^\.\//, ''), v]));
}

/**
 * Compile TypeScript and JavaScript `SlateNode` definitions and wired `SlateFlow` compositions into
 * `.ts`, `.tsx`, `.js`, and `.jsx` files with `// Generated by Slate — do not edit by hand.` headers.
 * Refuses to overwrite any existing file in `existingFiles` that lacks a `// Generated by Slate` header.
 */
export function compileTypeScript(
    sourceNodes: ReadonlyMap<string, SlateNode>,
    config: SlateConfig,
    flows: ReadonlyMap<string, SlateFlow> = new Map(),
    library: ReadonlyMap<string, CallableSignature> = new Map(),
    existingFiles?: ReadonlyMap<string, string> | Record<string, string>,
    options?: { checkJpl60?: boolean },
): CompileResult {
    const diagnostics: CompileDiagnostic[] = [];
    const error = (message: string) => diagnostics.push({ severity: 'error', message });
    const nodes = new Map(sourceNodes);

    let configCanonical: CanonicalLanguage;
    try {
        configCanonical = normalizeLanguage(config.language);
    } catch {
        configCanonical = 'typescript';
    }
    const defaultIsJs = configCanonical === 'javascript';

    const resolve = (target: string) => {
        const clean = target.startsWith('flow:') ? target.slice('flow:'.length) : target;
        const node = sourceNodes.get(clean);
        const flow = node ? undefined : flows.get(clean);
        if (flow) return { signature: flowSignature(flow), imports: [] };
        if (node) {
            const ext = typeof node.extra?.extension === 'string' ? node.extra.extension : '.tsx';
            const units = parseTsModule(`${node.code.join('\n')}\n`, `<sig>${ext}`).units;
            const unit = units.find(item => item.parentId === null && item.name === node.name);
            const sig = unit ? unitSignature(unit, units) : null;
            return sig
                ? { signature: sig, imports: node.imports ?? [], isClass: unit?.kind === 'class' }
                : null;
        }
        const libSig = library.get(target) ?? library.get(clean) ?? null;
        return libSig ? { signature: libSig, imports: [] } : null;
    };

    for (const [flowId, flow] of [...flows].sort(([left], [right]) => left.localeCompare(right))) {
        if (flowId === MAIN_FLOW && flow.instances.length === 0 && (!flow.regions || flow.regions.length === 0)) {
            continue;
        }
        if (sourceNodes.has(flowId)) {
            error(`flows/${flowId} has the same id as a node.`);
            continue;
        }
        const flowNode = flowToTsNode(flowId, flow, resolve, diagnostics, {
            language: defaultIsJs ? 'javascript' : 'typescript',
        });
        if (flowNode) nodes.set(flowId, flowNode);
    }

    const valid = new Map<string, SlateNode>();
    for (const [nodeId, node] of nodes) {
        const rawLang = node.language ?? config.language;
        let normLang: CanonicalLanguage | null = null;
        try {
            normLang = normalizeLanguage(rawLang);
        } catch {
            normLang = null;
        }
        if (normLang !== 'typescript' && normLang !== 'javascript') {
            error(`${nodeId}: no TypeScript/JavaScript compiler for language "${rawLang}".`);
            continue;
        }
        const ext = typeof node.extra?.extension === 'string'
            ? node.extra.extension
            : normLang === 'javascript'
              ? '.js'
              : '.ts';
        const parsed = parseTsModule(`${node.code.join('\n')}\n`, `${nodeId}${ext}`, nodeId);
        if (!parsed.valid) {
            error(`${nodeId}: code is not valid TypeScript/JavaScript.`);
            continue;
        }
        valid.set(nodeId, node);
    }

    if (options?.checkJpl60) {
        for (const [nodeId, node] of valid) {
            if (node.kind) continue;
            const jpl = checkTsNodeCode(node.code, node.name, {
                language: node.language ?? config.language,
                contract: node.contract,
            });
            for (const diag of jpl.diagnostics) {
                diagnostics.push({ severity: 'warning', message: `${nodeId}: ${diag.message}` });
            }
        }
    }

    const folders = [...new Set([...valid.keys()].map(folderOf))].sort();
    const rootModule = projectModuleName(config.name);
    if (folders.includes('') && folders.includes(rootModule)) {
        error(`Folder ${rootModule}/ collides with the module for root-level nodes.`);
    }
    const hasChildren = (folder: string) => folders.some(other => other !== folder && other.startsWith(`${folder}/`));

    const folderPathMap = new Map<string, string>();
    for (const folder of folders) {
        const members = [...valid].filter(([nodeId]) => folderOf(nodeId) === folder);
        const explicitPath = members
            .map(([, n]) => (typeof n.extra?.modulePath === 'string' ? n.extra.modulePath.replace(/\\/g, '/').replace(/^\.\//, '') : null))
            .find((p): p is string => Boolean(p));

        if (explicitPath) {
            folderPathMap.set(folder, explicitPath);
            continue;
        }

        const explicitExt = members
            .map(([, n]) => (typeof n.extra?.extension === 'string' ? n.extra.extension : null))
            .find((e): e is string => Boolean(e));

        const hasJsx = members.some(([, n]) => {
            const text = n.code.join('\n');
            return /<[A-Za-z][A-Za-z0-9.]*(\s|>|\/)/.test(text) && /return\s*\(?[\s\S]*</.test(text);
        });
        const folderIsJs = members.every(([, n]) => {
            const l = n.language ?? config.language;
            try {
                return normalizeLanguage(l) === 'javascript';
            } catch {
                return false;
            }
        });

        const ext = explicitExt ?? (folderIsJs ? (hasJsx ? '.jsx' : '.js') : hasJsx ? '.tsx' : '.ts');
        const outPath = !folder
            ? `${rootModule}${ext}`
            : hasChildren(folder)
              ? `${folder}/index${ext}`
              : `${folder}${ext}`;
        folderPathMap.set(folder, outPath);
    }

    const modulePath = (folder: string) => folderPathMap.get(folder) ?? `${folder || rootModule}.ts`;

    const preludeNames = new Map<string, Set<string>>();
    const definitions = new Map<string, string[]>();
    for (const [nodeId, node] of valid) {
        if (node.kind === 'prelude') {
            preludeNames.set(nodeId, tsTopLevelBindings(node.code.join('\n'), modulePath(folderOf(nodeId))));
        } else if (!node.kind) {
            definitions.set(node.name, [...(definitions.get(node.name) ?? []), nodeId]);
        }
    }

    const existingMap = normalizeExistingFiles(existingFiles);
    const files = new Map<string, string>();
    const moduleEdges = new Map<string, Set<string>>();

    for (const folder of folders) {
        const outFilePath = modulePath(folder);
        if (existingMap.has(outFilePath)) {
            const existingContent = existingMap.get(outFilePath)!;
            if (!isSlateGeneratedContent(existingContent)) {
                error(
                    `Refusing to overwrite existing non-generated file "${outFilePath}" (missing "${GENERATED_SLASH_HEADER}" header).`,
                );
                continue;
            }
        }

        const members = [...valid]
            .filter(([nodeId]) => folderOf(nodeId) === folder)
            .sort(
                ([leftId, left], [rightId, right]) =>
                    blockOrder(left) - blockOrder(right) ||
                    (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
                    leftId.localeCompare(rightId),
            );

        const localNames = new Set<string>();
        for (const [nodeId, node] of members) {
            if (node.kind === 'prelude') {
                preludeNames.get(nodeId)!.forEach(name => localNames.add(name));
            } else if (!node.kind) {
                localNames.add(node.name);
            }
        }

        const external: string[] = [];
        const crossModule: string[] = [];
        const origins = new Map<string, string>();
        const bind = (name: string, origin: string, nodeId: string) => {
            const previous = origins.get(name);
            if (previous && previous !== origin) {
                error(`${outFilePath}: name collision on "${name}" (${previous} vs ${origin}, in ${nodeId}).`);
            } else {
                origins.set(name, origin);
            }
        };

        for (const [nodeId, node] of members) {
            if (!node.kind) bind(node.name, `node ${nodeId}`, nodeId);
        }

        for (const [nodeId, node] of members) {
            const names = tsIdentifierNames(node.code.join('\n'), outFilePath);
            const own = new Set<string>();
            for (const line of node.imports) {
                const parsed = splitTsImport(line);
                if (!parsed.length) {
                    error(`${nodeId}: "${line}" is not a valid TypeScript/JavaScript import.`);
                }
                for (const item of parsed) {
                    external.push(item.line);
                    if (!item.binding) continue;
                    own.add(item.binding);
                    bind(item.binding, `"${item.line}"`, nodeId);
                }
            }

            const importFrom = (targetNodeId: string, name: string) => {
                const targetFolder = folderOf(targetNodeId);
                const targetFile = modulePath(targetFolder);
                const relSpec = relativeModuleSpecifier(outFilePath, targetFile);
                const line = `import { ${name} } from "${relSpec}";`;
                crossModule.push(line);
                own.add(name);
                bind(name, `"${line}"`, nodeId);
                moduleEdges.set(folder, (moduleEdges.get(folder) ?? new Set()).add(targetFolder));
            };

            for (const target of node.uses) {
                const used = valid.get(target);
                if (!used) {
                    error(`${nodeId} uses ${target}, which ${nodes.has(target) ? 'did not compile' : 'does not exist'}.`);
                    continue;
                }
                if (folderOf(target) === folder) continue;
                if (used.kind === 'prelude') {
                    [...preludeNames.get(target)!]
                        .filter(name => names.has(name))
                        .forEach(name => importFrom(target, name));
                } else if (!used.kind && names.has(used.name)) {
                    importFrom(target, used.name);
                }
            }

            for (const name of names) {
                if (name === node.name || own.has(name) || localNames.has(name)) continue;
                const candidates = (definitions.get(name) ?? []).filter(candidate => folderOf(candidate) !== folder);
                if (candidates.length === 1) {
                    importFrom(candidates[0], name);
                } else if (candidates.length > 1) {
                    error(`${nodeId}: "${name}" matches ${candidates.join(', ')}; add the intended one to "uses".`);
                }
            }
        }

        const mergedImports = [...mergeTsImports(external), ...mergeTsImports(crossModule)];
        const headerSection = [
            GENERATED_SLASH_HEADER,
            `// Source: slate/nodes/${folder}${folder ? '/' : ''}`,
        ].join('\n');

        const sections = [headerSection, ...(mergedImports.length ? [mergedImports.join('\n')] : [])];

        const neededFromPrelude = new Set<string>();
        for (const [ otherId, otherNode] of valid) {
            if (folderOf(otherId) !== folder && otherNode.uses.includes( folder ? `${folder}/_prelude` : '_prelude')) {
                const pSet = preludeNames.get(folder ? `${folder}/_prelude` : '_prelude');
                if (pSet) pSet.forEach(n => neededFromPrelude.add(n));
            }
        }

        const blocks = members.map(([nodeId, node]) => {
            let codeLinesOut = node.code;
            if (!node.kind && (node.extra?.exported !== false || definitions.get(node.name)?.length === 1)) {
                codeLinesOut = ensureExportedDeclaration(node.code);
            } else if (node.kind === 'prelude' && neededFromPrelude.size > 0) {
                codeLinesOut = ensureExportedDeclaration(node.code);
            }
            return [
                `// slate: ${node.extra?.flow ? 'flows' : 'nodes'}/${nodeId}`,
                ...commentLines('intent', node.intent),
                ...commentLines('contract', node.contract),
                ...codeLinesOut,
            ].join('\n');
        });

        files.set(outFilePath, `${[sections.join('\n\n'), ...blocks].join('\n\n')}\n`);
    }

    const visiting: string[] = [];
    const done = new Set<string>();
    const reported = new Set<string>();
    const visit = (folder: string) => {
        if (done.has(folder)) return;
        const at = visiting.indexOf(folder);
        if (at >= 0) {
            const cycle = [...visiting.slice(at), folder].map(modulePath).join(' → ');
            if (!reported.has(cycle)) diagnostics.push({ severity: 'warning', message: `Import cycle: ${cycle}.` });
            reported.add(cycle);
            return;
        }
        visiting.push(folder);
        for (const next of [...(moduleEdges.get(folder) ?? [])].sort()) visit(next);
        visiting.pop();
        done.add(folder);
    };
    folders.forEach(visit);

    return {
        files: new Map([...files].sort(([left], [right]) => left.localeCompare(right))),
        diagnostics,
    };
}
