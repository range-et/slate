import { createHash } from 'crypto';

import { parser } from '@lezer/python';
import type { SyntaxNode, Tree } from '@lezer/common';

import type { ParseModuleResult, ParsedUnit, SourcePosition, SourceProposal, SourceRange } from './harness_protocol';

const ANNOTATION_START = '## @slate';
const ANNOTATION_END = '## @slate-end';

type Annotation = Record<string, unknown>;

type ParsedDetails = ParseModuleResult & {
    tree: Tree;
    offsets: Map<string, {
        code: { from: number; to: number };
        declaration: { from: number; to: number };
        full: { from: number; to: number };
    }>;
};

export class AdapterError extends Error {}

function sourceHash(source: string): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(source, 'utf8').digest('hex')}`;
}

function stableId(documentPath: string, kind: ParsedUnit['kind'], qualifiedName: string): string {
    const hex = createHash('sha1').update(`slate:${documentPath}:${kind}:${qualifiedName}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function lineStarts(source: string): number[] {
    const starts = [0];
    for (let index = 0; index < source.length; index++) {
        if (source[index] === '\n') starts.push(index + 1);
    }
    return starts;
}

function positionAt(starts: number[], offset: number): SourcePosition {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (starts[middle] <= offset) low = middle;
        else high = middle;
    }
    return { line: low, character: offset - starts[low] };
}

function rangeAt(starts: number[], from: number, to: number): SourceRange {
    return { start: positionAt(starts, from), end: positionAt(starts, to) };
}

export function offsetAt(source: string, position: SourcePosition): number {
    const starts = lineStarts(source);
    if (position.line < 0 || position.line >= starts.length) throw new AdapterError('source position line is out of range');
    const lineEnd = position.line + 1 < starts.length ? starts[position.line + 1] - 1 : source.length;
    const offset = starts[position.line] + position.character;
    if (offset > lineEnd) throw new AdapterError('source position character is out of range');
    return offset;
}

function directChildren(node: SyntaxNode): SyntaxNode[] {
    const children: SyntaxNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) children.push(child);
    return children;
}

function firstDirect(node: SyntaxNode, name: string): SyntaxNode | null {
    return directChildren(node).find(child => child.name === name) ?? null;
}

function meaningfulEnd(source: string, to: number): number {
    while (to > 0 && (source[to - 1] === '\n' || source[to - 1] === '\r')) to--;
    return to;
}

function declarationIndent(source: string, from: number): string {
    const lineStart = source.lastIndexOf('\n', from - 1) + 1;
    return source.slice(lineStart, from).match(/^[ \t]*/)?.[0] ?? '';
}

function normalizeParameters(raw: string): string {
    const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    if (lines.length === 1) return normalized;
    if (lines[0].trim() === '') lines.shift();
    const closedOnOwnLine = lines.at(-1)?.trim() === '';
    if (closedOnOwnLine) lines.pop();
    const indents = lines.filter(line => line.trim()).map(line => line.match(/^[ \t]*/)?.[0].length ?? 0);
    const common = indents.length ? Math.min(...indents) : 0;
    const value = lines.map(line => line.slice(common)).join('\n');
    return closedOnOwnLine ? `${value}\n` : value;
}

function parseAnnotation(source: string, anchor: number, starts: number[]): {
    annotation: Annotation | null;
    range: SourceRange | null;
    from: number;
} {
    const lines = source.split(/\r?\n/);
    const anchorPosition = positionAt(starts, anchor);
    let end = anchorPosition.line - 1;
    if (end < 0 || lines[end]?.trim() !== ANNOTATION_END) return { annotation: null, range: null, from: anchor };
    let start = end - 1;
    while (start >= 0 && !lines[start].trim().startsWith(ANNOTATION_START)) start--;
    if (start < 0) return { annotation: null, range: null, from: anchor };
    for (let line = start; line <= end; line++) {
        if (!lines[line].trim().startsWith('##')) return { annotation: null, range: null, from: anchor };
    }

    const first = lines[start].trim();
    const annotation: Annotation = { version: null, unknown: { tag: {}, fields: {} } };
    for (const token of first.slice(ANNOTATION_START.length).trim().split(/\s+/)) {
        if (!token.includes('=')) continue;
        const [key, ...rest] = token.split('=');
        const value = rest.join('=');
        if (key === 'v') annotation.version = /^\d+$/.test(value) ? Number(value) : value;
        else if (key === 'id') annotation.id = value;
        else ((annotation.unknown as { tag: Record<string, string> }).tag)[key] = value;
    }

    const repeated = new Map<string, string[]>();
    for (let line = start + 1; line < end; line++) {
        const value = lines[line].trim();
        if (!value.startsWith('## ') || !value.includes(':')) continue;
        const separator = value.indexOf(':');
        const key = value.slice(3, separator).trim();
        const entry = value.slice(separator + 1).trimStart();
        repeated.set(key, [...(repeated.get(key) ?? []), entry]);
    }
    for (const [key, values] of repeated) {
        if (key === 'depends-on') annotation.dependencies = values;
        else if (key === 'example') annotation.examples = values;
        else if (key === 'locked') annotation.locked = values.at(-1)?.toLowerCase() === 'true';
        else if (key === 'intent' || key === 'contract') annotation[key] = values.join('\n');
        else ((annotation.unknown as { fields: Record<string, string[]> }).fields)[key] = values;
    }
    const from = starts[start];
    const to = end + 1 < starts.length ? starts[end + 1] : source.length;
    return { annotation, range: rangeAt(starts, from, to), from };
}

function syntaxErrors(tree: Tree): SyntaxNode[] {
    const errors: SyntaxNode[] = [];
    const cursor = tree.cursor();
    const visit = () => {
        if (cursor.type.isError) errors.push(cursor.node);
        if (cursor.firstChild()) {
            do visit(); while (cursor.nextSibling());
            cursor.parent();
        }
    };
    visit();
    return errors;
}

function parseDetailed(source: string, documentPath: string): ParsedDetails {
    const tree = parser.parse(source);
    const starts = lineStarts(source);
    const errors = syntaxErrors(tree);
    if (errors.length > 0) {
        const first = errors[0];
        return {
            path: documentPath,
            sourceHash: sourceHash(source),
            valid: false,
            units: [],
            diagnostics: [{
                code: 'python-syntax',
                message: 'Python syntax could not be parsed at this position.',
                range: rangeAt(starts, first.from, Math.max(first.from, first.to)),
            }],
            tree,
            offsets: new Map(),
        };
    }

    const units: ParsedUnit[] = [];
    const offsets: ParsedDetails['offsets'] = new Map();

    const addUnit = (node: SyntaxNode, wrapper: SyntaxNode, parent: ParsedUnit | null): ParsedUnit => {
        const isClass = node.name === 'ClassDefinition';
        const nameNode = firstDirect(node, 'VariableName');
        if (!nameNode) throw new AdapterError(`Python declaration in ${documentPath} has no name`);
        const name = source.slice(nameNode.from, nameNode.to);
        const qualifiedName = parent ? `${parent.qualifiedName}.${name}` : name;
        let kind: ParsedUnit['kind'];
        if (isClass) kind = parent ? 'nested_class' : 'class';
        else if (parent && ['class', 'nested_class'].includes(parent.kind)) kind = 'method';
        else kind = parent ? 'nested_function' : 'function';
        const annotationResult = parseAnnotation(source, wrapper.from, starts);
        const durableId = typeof annotationResult.annotation?.id === 'string' ? annotationResult.annotation.id : null;
        const id = durableId ?? stableId(documentPath, kind, qualifiedName);
        const declarationTo = meaningfulEnd(source, node.to);
        const declaration = rangeAt(starts, wrapper.from, declarationTo);
        const full = rangeAt(starts, annotationResult.from, declarationTo);
        const decorators = wrapper.name === 'DecoratedStatement'
            ? directChildren(wrapper)
                .filter(child => child.name === 'Decorator')
                .map(child => source.slice(child.from, child.to).trim().replace(/^@/, ''))
            : [];
        const unit: ParsedUnit = {
            id,
            identity: durableId ? 'durable' : 'provisional',
            kind,
            name,
            qualifiedName,
            parentId: parent?.id ?? null,
            ranges: {
                name: rangeAt(starts, nameNode.from, nameNode.to),
                declaration,
                annotation: annotationResult.range,
                full,
            },
            annotation: annotationResult.annotation,
            decorators,
        };
        if (!isClass) {
            const params = firstDirect(node, 'ParamList');
            const returnType = directChildren(node).find(child => child.name === 'TypeDef' && child.from > (params?.to ?? 0));
            const rawParams = params ? source.slice(params.from + 1, params.to - 1) : '';
            const parameters = normalizeParameters(rawParams);
            const returnAnnotation = returnType
                ? source.slice(returnType.from, returnType.to).replace(/^\s*->\s*/, '').trim()
                : null;
            const asynchronous = directChildren(node).some(child => child.name === 'async');
            unit.async = asynchronous;
            unit.parameters = parameters;
            unit.returnAnnotation = returnAnnotation;
            unit.signature = `${asynchronous ? 'async ' : ''}def ${name}(${parameters})${returnAnnotation ? ` -> ${returnAnnotation}` : ''}`;
        }
        units.push(unit);
        offsets.set(id, {
            code: { from: node.from, to: declarationTo },
            declaration: { from: wrapper.from, to: declarationTo },
            full: { from: annotationResult.from, to: declarationTo },
        });
        return unit;
    };

    const visit = (node: SyntaxNode, parent: ParsedUnit | null): void => {
        if (node.name === 'DecoratedStatement') {
            const declaration = directChildren(node).find(child =>
                child.name === 'FunctionDefinition' || child.name === 'ClassDefinition'
            );
            if (!declaration) return;
            const unit = addUnit(declaration, node, parent);
            for (const child of directChildren(declaration)) visit(child, unit);
            return;
        }
        if (node.name === 'FunctionDefinition' || node.name === 'ClassDefinition') {
            const unit = addUnit(node, node, parent);
            for (const child of directChildren(node)) visit(child, unit);
            return;
        }
        for (const child of directChildren(node)) visit(child, parent);
    };
    visit(tree.topNode, null);

    const diagnostics: ParseModuleResult['diagnostics'] = [];
    const durable = new Map<string, ParsedUnit[]>();
    for (const unit of units.filter(candidate => candidate.identity === 'durable')) {
        durable.set(unit.id, [...(durable.get(unit.id) ?? []), unit]);
    }
    for (const [id, matches] of durable) {
        if (matches.length > 1) {
            diagnostics.push({
                code: 'duplicate-slate-id',
                message: `Slate id ${id} is attached to ${matches.length} declarations.`,
                range: matches[1].ranges.annotation ?? matches[1].ranges.name,
            });
        }
    }
    return { path: documentPath, sourceHash: sourceHash(source), valid: true, units, diagnostics, tree, offsets };
}

export function parseModule(source: string, documentPath = '<memory>'): ParseModuleResult {
    const { tree: _tree, offsets: _offsets, ...result } = parseDetailed(source, documentPath);
    return result;
}

function requireFresh(source: string, expectedHash: unknown): void {
    const actual = sourceHash(source);
    if (expectedHash !== actual) throw new AdapterError(`stale source: expected ${String(expectedHash)}, current ${actual}`);
}

function requireString(params: Record<string, unknown>, key: string): string {
    if (typeof params[key] !== 'string') throw new AdapterError(`${key} must be a string`);
    return params[key] as string;
}

function requireUnit(parsed: ParsedDetails, unitId: string): ParsedUnit {
    const matches = parsed.units.filter(unit => unit.id === unitId);
    if (matches.length !== 1) throw new AdapterError(`unit id ${JSON.stringify(unitId)} resolved to ${matches.length} declarations; expected exactly one`);
    return matches[0];
}

function annotationLines(annotation: Annotation, indent = ''): string {
    const id = annotation.id;
    if (typeof id !== 'string' || !id) throw new AdapterError('annotation.id must be a non-empty string');
    const unknown = annotation.unknown as { tag?: Record<string, string>; fields?: Record<string, string[]> } | undefined;
    const tags = Object.entries(unknown?.tag ?? {}).map(([key, value]) => ` ${key}=${value}`).join('');
    const lines = [`${indent}## @slate v=2 id=${id}${tags}`];
    for (const key of ['intent', 'contract'] as const) {
        const value = annotation[key];
        if (typeof value === 'string') {
            for (const line of value.split('\n')) lines.push(`${indent}## ${key}: ${line}`);
        }
    }
    for (const value of Array.isArray(annotation.dependencies) ? annotation.dependencies : []) {
        if (typeof value === 'string') lines.push(`${indent}## depends-on: ${value}`);
    }
    for (const value of Array.isArray(annotation.examples) ? annotation.examples : []) {
        if (typeof value === 'string') lines.push(`${indent}## example: ${value}`);
    }
    lines.push(`${indent}## locked: ${annotation.locked === true ? 'true' : 'false'}`);
    for (const [key, values] of Object.entries(unknown?.fields ?? {})) {
        for (const value of values) lines.push(`${indent}## ${key}: ${value}`);
    }
    lines.push(`${indent}## @slate-end`);
    return `${lines.join('\n')}\n`;
}

function proposal(source: string, documentPath: string, from: number, to: number, newText: string): SourceProposal {
    const starts = lineStarts(source);
    const proposedSource = source.slice(0, from) + newText + source.slice(to);
    const parsed = parseModule(proposedSource, documentPath);
    if (!parsed.valid) throw new AdapterError('proposed edit produces invalid Python');
    return {
        baseSourceHash: sourceHash(source),
        proposedSourceHash: sourceHash(proposedSource),
        edits: [{ range: rangeAt(starts, from, to), newText }],
        proposedSource,
        parsed,
    };
}

function typedFunction(signature: string): ParsedUnit {
    const candidate = `${signature.trim().replace(/:$/, '')}:\n    pass\n`;
    const detailed = parseDetailed(candidate, '<signature>');
    if (!detailed.valid || detailed.units.length !== 1 || detailed.units[0].kind !== 'function') {
        throw new AdapterError('stub signature must define exactly one top-level function');
    }
    const unit = detailed.units[0];
    if (!unit.returnAnnotation) throw new AdapterError('stub signature requires a return annotation');
    const functionNode = detailed.tree.topNode.getChild('FunctionDefinition');
    const params = functionNode?.getChild('ParamList');
    if (!params) throw new AdapterError('stub signature has invalid parameters');
    const children = directChildren(params);
    for (let index = 0; index < children.length; index++) {
        const child = children[index];
        if (child.name !== 'VariableName') continue;
        const name = candidate.slice(child.from, child.to);
        if (name === 'self' || name === 'cls') continue;
        if (children[index + 1]?.name !== 'TypeDef') {
            throw new AdapterError(`stub parameter ${JSON.stringify(name)} requires a type annotation`);
        }
    }
    return unit;
}

function indentBlock(value: string, indent: string): string {
    return value.split('\n').map(line => `${indent}${line}`).join('\n');
}

export class PythonAdapter {
    async parseModule(source: string, documentPath: string): Promise<ParseModuleResult> {
        return parseModule(source, documentPath);
    }

    async adoptUnit(params: Record<string, unknown>): Promise<SourceProposal> {
        const source = requireString(params, 'source');
        const documentPath = requireString(params, 'path');
        requireFresh(source, params.expectedHash);
        const parsed = parseDetailed(source, documentPath);
        if (!parsed.valid) throw new AdapterError('cannot adopt a unit while the module is invalid');
        const unit = requireUnit(parsed, requireString(params, 'unitId'));
        if (unit.annotation) throw new AdapterError('unit already has a Slate annotation');
        const from = parsed.offsets.get(unit.id)!.declaration.from;
        return proposal(source, documentPath, from, from, annotationLines(params.annotation as Annotation, declarationIndent(source, from)));
    }

    async updateAnnotation(params: Record<string, unknown>): Promise<SourceProposal> {
        const source = requireString(params, 'source');
        const documentPath = requireString(params, 'path');
        requireFresh(source, params.expectedHash);
        const parsed = parseDetailed(source, documentPath);
        const unit = requireUnit(parsed, requireString(params, 'unitId'));
        if (!unit.ranges.annotation) throw new AdapterError('unit has no v2 Slate annotation; adopt it first');
        if (unit.annotation?.version !== 2) throw new AdapterError('unsupported Slate annotation version');
        const from = offsetAt(source, unit.ranges.annotation.start);
        const to = offsetAt(source, unit.ranges.annotation.end);
        return proposal(source, documentPath, from, to, annotationLines(params.annotation as Annotation, declarationIndent(source, parsed.offsets.get(unit.id)!.declaration.from)));
    }

    async insertStub(params: Record<string, unknown>): Promise<SourceProposal> {
        const source = requireString(params, 'source');
        const documentPath = requireString(params, 'path');
        requireFresh(source, params.expectedHash);
        const signature = requireString(params, 'signature').trim().replace(/:$/, '');
        typedFunction(signature);
        const parsed = parseDetailed(source, documentPath);
        if (!parsed.valid) throw new AdapterError('cannot insert a stub while the module is invalid');
        const parentId = params.parentId === null || params.parentId === undefined ? null : requireString(params, 'parentId');
        let insertion = source.length;
        let indent = '';
        if (parentId) {
            const parent = requireUnit(parsed, parentId);
            if (!['class', 'nested_class'].includes(parent.kind)) throw new AdapterError('stub parent must be a class');
            insertion = parsed.offsets.get(parent.id)!.declaration.to;
            indent = `${declarationIndent(source, parsed.offsets.get(parent.id)!.declaration.from)}    `;
        }
        const separator = insertion === 0 ? '' : source.slice(0, insertion).endsWith('\n\n') ? '' : source.slice(0, insertion).endsWith('\n') ? '\n' : '\n\n';
        const stub = `${annotationLines(params.annotation as Annotation, indent)}${indentBlock(`${signature}:\n    raise NotImplementedError("Slate stub")`, indent)}\n`;
        return proposal(source, documentPath, insertion, insertion, `${separator}${stub}`);
    }

    async replaceUnit(params: Record<string, unknown>): Promise<SourceProposal> {
        const source = requireString(params, 'source');
        const documentPath = requireString(params, 'path');
        requireFresh(source, params.expectedHash);
        const parsed = parseDetailed(source, documentPath);
        const unit = requireUnit(parsed, requireString(params, 'unitId'));
        if (!['function', 'method'].includes(unit.kind)) throw new AdapterError('only top-level functions and methods can be replaced');
        if (unit.annotation?.locked === true) throw new AdapterError('unit is locked');
        const replacement = requireString(params, 'replacement').trim();
        const candidate = parseDetailed(`${replacement}\n`, '<replacement>');
        const topLevelStatements = directChildren(candidate.tree.topNode);
        if (!candidate.valid || candidate.units.length !== 1 || candidate.units[0].parentId !== null
            || topLevelStatements.length !== 1 || topLevelStatements[0].name !== 'FunctionDefinition') {
            throw new AdapterError('replacement must contain exactly one valid function');
        }
        if (candidate.units[0].name !== unit.name || candidate.units[0].signature !== unit.signature || candidate.units[0].decorators.length > 0) {
            throw new AdapterError('replacement must preserve the function name, signature, and decorators');
        }
        const target = parsed.offsets.get(unit.id)!.code;
        const indent = declarationIndent(source, target.from);
        return proposal(source, documentPath, target.from, target.to, indentBlock(replacement, indent));
    }

    dispose(): void {}
}
