import { createHash } from 'crypto';

import { parser } from '@lezer/python';
import type { SyntaxNode, Tree } from '@lezer/common';

import type { ParseModuleResult, ParsedUnit, SourcePosition, SourceProposal, SourceRange } from './harness_protocol';

type ParsedDetails = ParseModuleResult & {
    tree: Tree;
    offsets: Map<string, {
        code: { from: number; to: number };
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

// nodeId: when parsing a slate/nodes file, the top-level definition named like
// the file (the last path segment of nodeId) takes nodeId as its durable id.
function parseDetailed(source: string, documentPath: string, nodeId?: string): ParsedDetails {
    const nodeName = nodeId?.split('/').pop();
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
        const isNode = !parent && nodeName !== undefined && name === nodeName;
        const id = isNode ? nodeId! : stableId(documentPath, kind, qualifiedName);
        const declarationTo = meaningfulEnd(source, node.to);
        const declaration = rangeAt(starts, wrapper.from, declarationTo);
        const decorators = wrapper.name === 'DecoratedStatement'
            ? directChildren(wrapper)
                .filter(child => child.name === 'Decorator')
                .map(child => source.slice(child.from, child.to).trim().replace(/^@/, ''))
            : [];
        const unit: ParsedUnit = {
            id,
            identity: isNode ? 'durable' : 'provisional',
            kind,
            name,
            qualifiedName,
            parentId: parent?.id ?? null,
            ranges: {
                name: rangeAt(starts, nameNode.from, nameNode.to),
                declaration,
            },
            annotation: null,
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

    return { path: documentPath, sourceHash: sourceHash(source), valid: true, units, diagnostics: [], tree, offsets };
}

export function parseModule(source: string, documentPath = '<memory>', nodeId?: string): ParseModuleResult {
    const { tree: _tree, offsets: _offsets, ...result } = parseDetailed(source, documentPath, nodeId);
    return result;
}

/** One binding of an import statement, normalized to its own line. */
export interface PythonImport {
    /** e.g. `from typing import Dict as D` or `import a.b`. */
    line: string;
    /** Name bound in the importing module; null for `*`. */
    binding: string | null;
    /** Module as written, including leading dots for relative imports. */
    module: string;
    /** Imported name for `from` imports; null for plain `import`. */
    name: string | null;
}

/** Split an import statement (`ImportStatement` node or its text) into one import per binding. */
export function splitImport(statement: string): PythonImport[] {
    const node = parser.parse(statement).topNode.firstChild;
    if (!node || node.name !== 'ImportStatement') return [];
    const tokens = directChildren(node)
        .filter(child => !['(', ')'].includes(child.name))
        .map(child => ({ name: child.name, text: statement.slice(child.from, child.to) }));
    const imports: PythonImport[] = [];
    if (tokens[0]?.name === 'from') {
        const importAt = tokens.findIndex(token => token.name === 'import');
        const module = tokens.slice(1, importAt).map(token => token.text).join('');
        const rest = tokens.slice(importAt + 1);
        for (let index = 0; index < rest.length; index++) {
            const token = rest[index];
            if (token.name === '*') imports.push({ line: `from ${module} import *`, binding: null, module, name: '*' });
            if (token.name !== 'VariableName') continue;
            const alias = rest[index + 1]?.name === 'as' ? rest[index + 2]?.text : undefined;
            imports.push({
                line: `from ${module} import ${token.text}${alias ? ` as ${alias}` : ''}`,
                binding: alias ?? token.text,
                module,
                name: token.text,
            });
            if (alias) index += 2;
        }
        return imports;
    }
    let dotted: string[] = [];
    const flush = (alias?: string) => {
        if (!dotted.length) return;
        const module = dotted.join('.');
        imports.push({ line: `import ${module}${alias ? ` as ${alias}` : ''}`, binding: alias ?? dotted[0], module, name: null });
        dotted = [];
    };
    for (let index = 1; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.name === 'VariableName') dotted.push(token.text);
        else if (token.name === 'as') { flush(tokens[index + 1]?.text); index++; }
        else if (token.name === ',') flush();
    }
    flush();
    return imports;
}

/** Every `VariableName` in the source: references, parameters, and assignment targets. */
export function identifierNames(source: string): Set<string> {
    const names = new Set<string>();
    const cursor = parser.parse(source).cursor();
    do {
        if (cursor.name === 'VariableName') names.add(source.slice(cursor.from, cursor.to));
    } while (cursor.next());
    return names;
}

/** Names bound by top-level statements: assignment targets, definitions (also conditional ones), and imports. */
export function topLevelBindings(source: string): Set<string> {
    const names = new Set<string>();
    const visit = (node: SyntaxNode) => {
        if (node.name === 'AssignStatement') {
            const assignAt = directChildren(node).map(child => child.name).lastIndexOf('AssignOp');
            directChildren(node).slice(0, assignAt)
                .filter(child => child.name === 'VariableName')
                .forEach(child => names.add(source.slice(child.from, child.to)));
        } else if (node.name === 'FunctionDefinition' || node.name === 'ClassDefinition') {
            const name = firstDirect(node, 'VariableName');
            if (name) names.add(source.slice(name.from, name.to));
            return;
        } else if (node.name === 'ImportStatement') {
            for (const item of splitImport(source.slice(node.from, node.to))) if (item.binding) names.add(item.binding);
            return;
        }
        if (['Script', 'Body', 'IfStatement', 'TryStatement', 'WithStatement', 'DecoratedStatement'].includes(node.name)) {
            for (const child of directChildren(node)) visit(child);
        }
    };
    visit(parser.parse(source).topNode);
    return names;
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

function indentBlock(value: string, indent: string): string {
    return value.split('\n').map(line => `${indent}${line}`).join('\n');
}

export class PythonAdapter {
    async parseModule(source: string, documentPath: string, nodeId?: string): Promise<ParseModuleResult> {
        return parseModule(source, documentPath, nodeId);
    }

    async replaceUnit(params: Record<string, unknown>): Promise<SourceProposal> {
        const source = requireString(params, 'source');
        const documentPath = requireString(params, 'path');
        requireFresh(source, params.expectedHash);
        const nodeId = typeof params.nodeId === 'string' ? params.nodeId : undefined;
        const parsed = parseDetailed(source, documentPath, nodeId);
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
