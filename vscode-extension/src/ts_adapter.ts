import { createHash } from 'crypto';
import * as ts from 'typescript';

import type { ParseModuleResult, ParsedUnit, SourcePosition, SourceProposal, SourceRange, UnitParam } from './harness_protocol';
import {
    codeLines,
    formatGeneratedHeaderForLanguage,
    GENERATED_SLASH_HEADER,
    isSlateGeneratedContent,
    type CanonicalLanguage,
    type CheckNodeCodeOptions,
    type CreateStubOptions,
    type Jpl60CheckResult,
    type LanguageAdapter,
} from './language_types';
import { AdapterError, sourceHash } from './python_adapter';

export { AdapterError, sourceHash };
export const TS_GENERATED_HEADER = GENERATED_SLASH_HEADER;

export interface TsImport {
    /** Normalized single-binding import line, e.g. `import { clamp } from "./util";` */
    line: string;
    /** Bound local identifier in the importing module; null for side-effect imports. */
    binding: string | null;
    /** Module specifier as written (without quotes), e.g. `./util` or `react`. */
    module: string;
    /** Exported name from the module (`default` for default imports, `*` for namespace imports, null for side-effect). */
    name: string | null;
    /** Whether the import uses `import type`. */
    isTypeOnly?: boolean;
}

type ParsedTsDetails = ParseModuleResult & {
    sourceFile: ts.SourceFile;
    offsets: Map<string, {
        code: { from: number; to: number };
        wrapper: { from: number; to: number };
    }>;
};

function stableTsId(documentPath: string, kind: ParsedUnit['kind'], qualifiedName: string): string {
    const hex = createHash('sha1').update(`slate:ts:${documentPath}:${kind}:${qualifiedName}`).digest('hex');
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

export function scriptKindForPath(documentPath: string, source?: string): ts.ScriptKind {
    const lower = documentPath.toLowerCase();
    if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
    if (lower.endsWith('.jsx')) return ts.ScriptKind.JSX;
    if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return ts.ScriptKind.JS;
    if (lower.endsWith('.ts')) return ts.ScriptKind.TS;
    if (source && /<[A-Za-z][A-Za-z0-9.]*(\s|>|\/)/.test(source) && /return\s*\(?[\s\S]*</.test(source)) {
        return ts.ScriptKind.TSX;
    }
    return ts.ScriptKind.TSX;
}

function getParseDiagnostics(sourceFile: ts.SourceFile): ts.DiagnosticWithLocation[] {
    const anyFile = sourceFile as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] };
    return anyFile.parseDiagnostics ?? [];
}

function hasExportModifier(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    const mods = ts.getModifiers(node);
    return Boolean(mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
}

function hasDefaultModifier(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    const mods = ts.getModifiers(node);
    return Boolean(mods?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword));
}

function hasAsyncModifier(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    const mods = ts.getModifiers(node);
    return Boolean(mods?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword));
}

function extractDecorators(node: ts.Node, sourceFile: ts.SourceFile): string[] {
    if (!ts.canHaveDecorators(node)) return [];
    const decorators = ts.getDecorators(node);
    if (!decorators?.length) return [];
    return decorators.map(d => d.expression.getText(sourceFile).trim());
}

function extractUnitParams(
    parameters: ts.NodeArray<ts.ParameterDeclaration>,
    sourceFile: ts.SourceFile,
): UnitParam[] {
    return parameters.map((param, idx): UnitParam => {
        const rawName = param.name.getText(sourceFile).trim();
        // Handle destructuring parameter names cleanly by assigning a fallback or sanitized identifier if needed
        const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rawName) ? rawName : `arg${idx}`;
        const annotation = param.type ? param.type.getText(sourceFile).trim() : null;
        const defaultVal = param.initializer
            ? param.initializer.getText(sourceFile).trim()
            : param.questionToken
                ? 'undefined'
                : null;
        const kind: UnitParam['kind'] = param.dotDotDotToken ? 'var' : 'keyword';
        return {
            name,
            annotation,
            default: defaultVal,
            kind,
        };
    });
}

function rawParameterSlice(
    fnNode: ts.SignatureDeclarationBase,
    source: string,
    sourceFile: ts.SourceFile,
): string {
    if (fnNode.parameters.length === 0) return '';
    const first = fnNode.parameters[0];
    const last = fnNode.parameters[fnNode.parameters.length - 1];
    const openParen = source.lastIndexOf('(', first.getStart(sourceFile));
    const closeParen = source.indexOf(')', last.getEnd());
    if (openParen >= 0 && closeParen > openParen) {
        return normalizeParameters(source.slice(openParen + 1, closeParen));
    }
    return fnNode.parameters.map(p => p.getText(sourceFile)).join(', ');
}

function inferJsxReturnAnnotation(fn: ts.FunctionLikeDeclarationBase, sourceFile: ts.SourceFile): string | null {
    if (fn.type) return fn.type.getText(sourceFile).trim();
    const bodyText = fn.body ? fn.body.getText(sourceFile) : '';
    if (bodyText && containsJsxSyntax(bodyText)) return 'JSX.Element';
    return null;
}

function parseTsDetailed(source: string, documentPath = '<memory>', nodeId?: string): ParsedTsDetails {
    const nodeName = nodeId?.split('/').pop();
    const starts = lineStarts(source);
    const scriptKind = scriptKindForPath(documentPath, source);
    const sourceFile = ts.createSourceFile(
        documentPath,
        source,
        ts.ScriptTarget.Latest,
        true,
        scriptKind,
    );

    const parseDiags = getParseDiagnostics(sourceFile);
    if (parseDiags.length > 0) {
        const first = parseDiags[0];
        const from = first.start ?? 0;
        const to = Math.max(from, from + (first.length ?? 0));
        const msg = ts.flattenDiagnosticMessageText(first.messageText, '\n');
        return {
            path: documentPath,
            sourceHash: sourceHash(source),
            valid: false,
            units: [],
            diagnostics: [{
                code: 'ts-syntax',
                message: `TypeScript/JavaScript syntax could not be parsed: ${msg}`,
                range: rangeAt(starts, from, to),
            }],
            sourceFile,
            offsets: new Map(),
        };
    }

    const units: ParsedUnit[] = [];
    const offsets: ParsedTsDetails['offsets'] = new Map();

    const registerUnit = (
        kind: ParsedUnit['kind'],
        nameNode: ts.Node,
        declNode: ts.Node,
        wrapperNode: ts.Node,
        parent: ParsedUnit | null,
        fnLike?: ts.FunctionLikeDeclarationBase,
        extraDecorators: string[] = [],
    ): ParsedUnit => {
        const name = nameNode.getText(sourceFile).trim();
        const qualifiedName = parent ? `${parent.qualifiedName}.${name}` : name;
        const isNode = !parent && nodeName !== undefined && name === nodeName;
        const id = isNode ? nodeId! : stableTsId(documentPath, kind, qualifiedName);

        const wrapperFrom = wrapperNode.getStart(sourceFile);
        const declFrom = declNode.getStart(sourceFile);
        const declTo = meaningfulEnd(source, wrapperNode.getEnd());
        const decorators = [
            ...extraDecorators,
            ...extractDecorators(wrapperNode, sourceFile),
            ...(wrapperNode !== declNode ? extractDecorators(declNode, sourceFile) : []),
        ];

        const unit: ParsedUnit = {
            id,
            identity: isNode ? 'durable' : 'provisional',
            kind,
            name,
            qualifiedName,
            parentId: parent?.id ?? null,
            ranges: {
                name: rangeAt(starts, nameNode.getStart(sourceFile), nameNode.getEnd()),
                declaration: rangeAt(starts, wrapperFrom, declTo),
            },
            annotation: null,
            decorators,
        };

        if (fnLike) {
            const asynchronous = hasAsyncModifier(fnLike);
            const parameters = rawParameterSlice(fnLike, source, sourceFile);
            const params = extractUnitParams(fnLike.parameters, sourceFile);
            const returnAnnotation = inferJsxReturnAnnotation(fnLike, sourceFile);
            const isExported = hasExportModifier(wrapperNode) || hasExportModifier(declNode);
            const isDefault = hasDefaultModifier(wrapperNode) || hasDefaultModifier(declNode);
            const exportPrefix = isExported ? (isDefault ? 'export default ' : 'export ') : '';
            const asyncPrefix = asynchronous ? 'async ' : '';
            const retSuffix = returnAnnotation ? `: ${returnAnnotation}` : '';

            unit.async = asynchronous;
            unit.parameters = parameters;
            unit.params = params;
            unit.returnAnnotation = returnAnnotation;

            if (ts.isArrowFunction(fnLike)) {
                unit.signature = `${exportPrefix}const ${name} = ${asyncPrefix}(${parameters})${retSuffix} =>`;
            } else if (ts.isMethodDeclaration(fnLike) || ts.isConstructorDeclaration(fnLike)) {
                unit.signature = `${asyncPrefix}${name}(${parameters})${retSuffix}`;
            } else {
                unit.signature = `${exportPrefix}${asyncPrefix}function ${name}(${parameters})${retSuffix}`;
            }
        } else if (ts.isInterfaceDeclaration(declNode)) {
            unit.signature = `interface ${name}`;
        } else if (ts.isTypeAliasDeclaration(declNode)) {
            unit.signature = `type ${name}`;
        }

        units.push(unit);
        offsets.set(id, {
            code: { from: wrapperFrom, to: declTo },
            wrapper: { from: wrapperFrom, to: declTo },
        });
        return unit;
    };

    const visit = (node: ts.Node, parent: ParsedUnit | null): void => {
        if (ts.isFunctionDeclaration(node) && node.name) {
            const kind: ParsedUnit['kind'] = parent ? 'nested_function' : 'function';
            const unit = registerUnit(kind, node.name, node, node, parent, node);
            if (node.body) {
                ts.forEachChild(node.body, child => visit(child, unit));
            }
            return;
        }

        if (ts.isClassDeclaration(node) && node.name) {
            const kind: ParsedUnit['kind'] = parent ? 'nested_class' : 'class';
            const unit = registerUnit(kind, node.name, node, node, parent);
            for (const member of node.members) {
                if (ts.isMethodDeclaration(member) && member.name) {
                    const methodUnit = registerUnit('method', member.name, member, member, unit, member);
                    if (member.body) {
                        ts.forEachChild(member.body, child => visit(child, methodUnit));
                    }
                } else if (ts.isConstructorDeclaration(member)) {
                    const ctorToken = member.getChildren(sourceFile).find(c => c.kind === ts.SyntaxKind.ConstructorKeyword) ?? member;
                    const ctorUnit: ParsedUnit = {
                        id: stableTsId(documentPath, 'method', `${unit.qualifiedName}.__init__`),
                        identity: 'provisional',
                        kind: 'method',
                        name: '__init__',
                        qualifiedName: `${unit.qualifiedName}.__init__`,
                        parentId: unit.id,
                        ranges: {
                            name: rangeAt(starts, ctorToken.getStart(sourceFile), ctorToken.getEnd()),
                            declaration: rangeAt(starts, member.getStart(sourceFile), meaningfulEnd(source, member.getEnd())),
                        },
                        annotation: null,
                        decorators: extractDecorators(member, sourceFile),
                        async: false,
                        parameters: rawParameterSlice(member, source, sourceFile),
                        params: [
                            { name: 'self', annotation: null, default: null, kind: 'positional' },
                            ...extractUnitParams(member.parameters, sourceFile),
                        ],
                        returnAnnotation: unit.name,
                        signature: `constructor(${rawParameterSlice(member, source, sourceFile)})`,
                    };
                    units.push(ctorUnit);
                    offsets.set(ctorUnit.id, {
                        code: { from: member.getStart(sourceFile), to: meaningfulEnd(source, member.getEnd()) },
                        wrapper: { from: member.getStart(sourceFile), to: meaningfulEnd(source, member.getEnd()) },
                    });
                }
            }
            return;
        }

        if (ts.isInterfaceDeclaration(node) && !parent) {
            registerUnit('class', node.name, node, node, null);
            return;
        }

        if (ts.isTypeAliasDeclaration(node) && !parent) {
            registerUnit('class', node.name, node, node, null);
            return;
        }

        if (ts.isVariableStatement(node)) {
            const declarations = node.declarationList.declarations;
            if (declarations.length === 1) {
                const decl = declarations[0];
                if (ts.isIdentifier(decl.name) && decl.initializer) {
                    let fnInit: ts.ArrowFunction | ts.FunctionExpression | null = null;
                    if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
                        fnInit = decl.initializer;
                    } else if (ts.isCallExpression(decl.initializer) && decl.initializer.arguments.length > 0) {
                        const firstArg = decl.initializer.arguments[0];
                        if (ts.isArrowFunction(firstArg) || ts.isFunctionExpression(firstArg)) {
                            fnInit = firstArg;
                        }
                    }
                    if (fnInit) {
                        const kind: ParsedUnit['kind'] = parent ? 'nested_function' : 'function';
                        const unit = registerUnit(kind, decl.name, decl, node, parent, fnInit);
                        if (fnInit.body) {
                            ts.forEachChild(fnInit.body, child => visit(child, unit));
                        }
                        return;
                    }
                }
            }
        }

        ts.forEachChild(node, child => visit(child, parent));
    };

    ts.forEachChild(sourceFile, child => visit(child, null));

    return {
        path: documentPath,
        sourceHash: sourceHash(source),
        valid: true,
        units,
        diagnostics: [],
        sourceFile,
        offsets,
    };
}

export function parseTsModule(source: string, documentPath = '<memory>', nodeId?: string): ParseModuleResult {
    const { sourceFile: _sf, offsets: _offsets, ...result } = parseTsDetailed(source, documentPath, nodeId);
    return result;
}

/**
 * Split a TypeScript/JavaScript `import` declaration into normalized per-binding `TsImport` items.
 */
export function splitTsImport(statement: string): TsImport[] {
    const sf = ts.createSourceFile('<import>.ts', statement, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    if (getParseDiagnostics(sf).length > 0 || sf.statements.length !== 1) return [];
    const stmt = sf.statements[0];
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) return [];

    const moduleSpec = stmt.moduleSpecifier.text;
    if (/[\0-\x1f\x7f\r\n]/.test(moduleSpec)) return [];
    const safeModuleSpec = JSON.stringify(moduleSpec);
    const clause = stmt.importClause;
    if (!clause) {
        return [{
            line: `import ${safeModuleSpec};`,
            binding: null,
            module: moduleSpec,
            name: null,
        }];
    }

    const isTypeOnly = clause.isTypeOnly;
    const typePrefix = isTypeOnly ? 'type ' : '';
    const results: TsImport[] = [];

    if (clause.name) {
        const local = clause.name.text;
        results.push({
            line: `import ${typePrefix}${local} from ${safeModuleSpec};`,
            binding: local,
            module: moduleSpec,
            name: 'default',
            ...(isTypeOnly ? { isTypeOnly: true } : {}),
        });
    }

    if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
            const local = clause.namedBindings.name.text;
            results.push({
                line: `import ${typePrefix}* as ${local} from ${safeModuleSpec};`,
                binding: local,
                module: moduleSpec,
                name: '*',
                ...(isTypeOnly ? { isTypeOnly: true } : {}),
            });
        } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
                const local = element.name.text;
                const imported = element.propertyName ? element.propertyName.text : local;
                const elType = isTypeOnly || element.isTypeOnly;
                const spec = element.propertyName ? `${imported} as ${local}` : local;
                results.push({
                    line: `import ${elType ? 'type ' : ''}{ ${spec} } from ${safeModuleSpec};`,
                    binding: local,
                    module: moduleSpec,
                    name: imported,
                    ...(elType ? { isTypeOnly: true } : {}),
                });
            }
        }
    }

    return results;
}

/**
 * Every identifier token (including JSX tag names and type references) referenced in the TypeScript/JS source.
 */
export function tsIdentifierNames(source: string, documentPath = '<memory>'): Set<string> {
    const names = new Set<string>();
    const sf = ts.createSourceFile(documentPath, source, ts.ScriptTarget.Latest, true, scriptKindForPath(documentPath, source));
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
            names.add(node.text);
        } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const tag = node.tagName.getText(sf).split('.')[0];
            if (tag) names.add(tag);
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    return names;
}

/**
 * Top-level bindings declared in a TypeScript/JavaScript source snippet (variables, functions, classes, interfaces, types, enums, and imports).
 */
export function tsTopLevelBindings(source: string, documentPath = '<memory>'): Set<string> {
    const names = new Set<string>();
    const sf = ts.createSourceFile(documentPath, source, ts.ScriptTarget.Latest, true, scriptKindForPath(documentPath, source));

    const collectBindingName = (nameNode: ts.BindingName): void => {
        if (ts.isIdentifier(nameNode)) {
            names.add(nameNode.text);
        } else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
            for (const el of nameNode.elements) {
                if (ts.isBindingElement(el)) collectBindingName(el.name);
            }
        }
    };

    for (const stmt of sf.statements) {
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                collectBindingName(decl.name);
            }
        } else if (
            (ts.isFunctionDeclaration(stmt) ||
                ts.isClassDeclaration(stmt) ||
                ts.isInterfaceDeclaration(stmt) ||
                ts.isTypeAliasDeclaration(stmt) ||
                ts.isEnumDeclaration(stmt)) &&
            stmt.name
        ) {
            names.add(stmt.name.text);
        } else if (ts.isImportDeclaration(stmt)) {
            for (const item of splitTsImport(stmt.getText(sf))) {
                if (item.binding) names.add(item.binding);
            }
        }
    }
    return names;
}

function normalizeSignatureComparison(sig: string | undefined): string {
    if (!sig) return '';
    return sig
        .replace(/^export\s+(default\s+)?/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function indentBlock(value: string, indent: string): string {
    return value.split('\n').map((line, index) => (index === 0 ? line : `${indent}${line}`)).join('\n');
}

function requireString(params: Record<string, unknown>, key: string): string {
    if (typeof params[key] !== 'string') throw new AdapterError(`${key} must be a string`);
    return params[key] as string;
}

function requireFresh(source: string, expectedHash: unknown): void {
    const actual = sourceHash(source);
    if (expectedHash !== actual) throw new AdapterError(`stale source: expected ${String(expectedHash)}, current ${actual}`);
}

/**
 * Replace a top-level function, arrow function, or class method in TypeScript/JavaScript source while verifying signature preservation.
 */
export function replaceTsUnit(params: Record<string, unknown>): SourceProposal {
    const source = requireString(params, 'source');
    const documentPath = requireString(params, 'path');
    requireFresh(source, params.expectedHash);
    const nodeId = typeof params.nodeId === 'string' ? params.nodeId : undefined;
    const unitId = requireString(params, 'unitId');
    const replacement = requireString(params, 'replacement').trim();

    const parsed = parseTsDetailed(source, documentPath, nodeId);
    const matches = parsed.units.filter(u => u.id === unitId);
    if (matches.length !== 1) {
        throw new AdapterError(`unit id ${JSON.stringify(unitId)} resolved to ${matches.length} declarations; expected exactly one`);
    }
    const unit = matches[0];
    if (!['function', 'method'].includes(unit.kind)) {
        throw new AdapterError('only top-level functions and methods can be replaced');
    }
    if (unit.annotation?.locked === true) {
        throw new AdapterError('unit is locked');
    }

    const candidateSource = unit.kind === 'method' ? `class _Holder {\n${replacement}\n}\n` : `${replacement}\n`;
    const candidate = parseTsDetailed(candidateSource, documentPath);
    if (!candidate.valid) {
        throw new AdapterError('replacement must contain valid TypeScript/JavaScript');
    }

    const candidateUnit = unit.kind === 'method'
        ? candidate.units.find(u => u.kind === 'method')
        : candidate.units.find(u => u.parentId === null && u.kind === 'function');

    if (!candidateUnit || (unit.kind === 'function' && candidate.units.filter(u => u.parentId === null).length !== 1)) {
        throw new AdapterError('replacement must contain exactly one valid function');
    }

    const sameParams = (candidateUnit.params ?? []).length === (unit.params ?? []).length &&
        (candidateUnit.params ?? []).every((p, i) => {
            const orig = unit.params![i];
            return p.name === orig.name && (p.annotation ?? null) === (orig.annotation ?? null);
        });
    const sameReturn = (candidateUnit.returnAnnotation ?? null) === (unit.returnAnnotation ?? null);

    if (
        candidateUnit.name !== unit.name ||
        (!sameParams || !sameReturn) &&
        normalizeSignatureComparison(candidateUnit.signature) !== normalizeSignatureComparison(unit.signature)
    ) {
        throw new AdapterError('replacement must preserve the function name and signature');
    }

    const target = parsed.offsets.get(unit.id)!.code;
    const indent = declarationIndent(source, target.from);
    const newText = indentBlock(replacement, indent);
    const proposedSource = source.slice(0, target.from) + newText + source.slice(target.to);
    const reparsed = parseTsModule(proposedSource, documentPath, nodeId);
    if (!reparsed.valid) {
        throw new AdapterError('proposed edit produces invalid TypeScript/JavaScript');
    }

    const starts = lineStarts(source);
    return {
        baseSourceHash: sourceHash(source),
        proposedSourceHash: sourceHash(proposedSource),
        edits: [{ range: rangeAt(starts, target.from, target.to), newText }],
        proposedSource,
        parsed: reparsed,
    };
}

/**
 * Generate a typed TypeScript or JavaScript stub function, arrow function, or React component.
 */
export function createTsStub(
    name: string,
    params: ReadonlyArray<UnitParam | { name: string; annotation?: string | null; default?: string | null; kind?: UnitParam['kind'] }>,
    returnType: string | null = 'void',
    kind: 'function' | 'arrow' | 'method' | 'class' | 'component' | 'operator' = 'function',
    options?: CreateStubOptions & { language?: 'typescript' | 'javascript' },
): string {
    const isJs = options?.language === 'javascript';
    const exported = options?.exported !== false;
    const isAsync = options?.async === true;
    const exportPrefix = exported && kind !== 'method' ? 'export ' : '';
    const asyncPrefix = isAsync ? 'async ' : '';

    const formattedParams = params.map(p => {
        const prefix = p.kind === 'var' ? '...' : '';
        const ann = !isJs && p.annotation ? `: ${p.annotation}` : '';
        const def = p.default !== undefined && p.default !== null && p.default !== 'undefined' ? ` = ${p.default}` : '';
        const opt = !isJs && p.default === 'undefined' ? '?' : '';
        return `${prefix}${p.name}${opt}${ann}${def}`;
    }).join(', ');

    const effectiveReturn = returnType ?? (kind === 'component' ? 'JSX.Element' : 'void');
    const retSuffix = !isJs && effectiveReturn ? `: ${effectiveReturn}` : '';

    if (kind === 'class') {
        return [
            `${exportPrefix}class ${name} {`,
            `    constructor(${formattedParams}) {`,
            `        throw new Error("Not implemented: ${name}");`,
            `    }`,
            `}`,
        ].join('\n');
    }

    if (kind === 'arrow' || options?.arrow) {
        return [
            `${exportPrefix}const ${name} = ${asyncPrefix}(${formattedParams})${retSuffix} => {`,
            `    throw new Error("Not implemented: ${name}");`,
            `};`,
        ].join('\n');
    }

    if (kind === 'method') {
        return [
            `${asyncPrefix}${name}(${formattedParams})${retSuffix} {`,
            `    throw new Error("Not implemented: ${name}");`,
            `}`,
        ].join('\n');
    }

    return [
        `${exportPrefix}${asyncPrefix}function ${name}(${formattedParams})${retSuffix} {`,
        `    throw new Error("Not implemented: ${name}");`,
        `}`,
    ].join('\n');
}

/**
 * Validate TypeScript/JavaScript node code against JPL-60 (`<=60` lines) and optional strict type annotations.
 */
export function checkTsNodeCode(
    code: string | readonly string[],
    expectedName: string,
    options?: CheckNodeCodeOptions,
): Jpl60CheckResult {
    const rawLines = typeof code === 'string' ? codeLines(code) : [...code];
    const lines = rawLines.flatMap(line => line.split(/\r?\n/));
    const executable = lines.filter(l => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*');
    }).length;
    const diagnostics: Array<{ code: string; message: string }> = [];

    if (lines.length > 60) {
        diagnostics.push({
            code: 'jpl60-line-count',
            message: `Node "${expectedName}" exceeds JPL-60 limit: ${lines.length} lines (>60). Split or refactor into stubs and a flow composition.`,
        });
    }

    const source = `${lines.join('\n')}\n`;
    const docPath = options?.language === 'javascript' ? `${expectedName}.jsx` : `${expectedName}.tsx`;
    const parsed = parseTsModule(source, docPath, expectedName);
    if (!parsed.valid) {
        for (const diag of parsed.diagnostics) {
            diagnostics.push({ code: diag.code, message: diag.message });
        }
        return {
            valid: false,
            lineCount: lines.length,
            executableLines: executable,
            diagnostics,
        };
    }

    const topLevel = parsed.units.filter(u => u.parentId === null);
    const def = topLevel.find(u => u.name === expectedName);
    if (!def) {
        diagnostics.push({
            code: 'node-definition-missing',
            message: `Code in "${expectedName}" must define a top-level unit named "${expectedName}".`,
        });
    } else if (topLevel.length > 1) {
        diagnostics.push({
            code: 'node-extra-statements',
            message: `Code in "${expectedName}" must contain exactly one top-level definition (found ${topLevel.length}).`,
        });
    }

    const strictTypes = options?.strictTypes ?? (options?.language !== 'javascript' && options?.language !== 'js' && options?.language !== 'jsx');
    if (def && def.kind === 'function' && strictTypes) {
        for (const p of def.params ?? []) {
            if (!p.annotation || !p.annotation.trim()) {
                diagnostics.push({
                    code: 'jpl60-param-annotation',
                    message: `Parameter "${p.name}" in "${expectedName}" is missing a TypeScript type annotation.`,
                });
            }
        }
        if (!def.returnAnnotation || !def.returnAnnotation.trim()) {
            diagnostics.push({
                code: 'jpl60-return-annotation',
                message: `Function "${expectedName}" is missing an explicit return type annotation.`,
            });
        }
    }

    if (options?.contract !== undefined && !options.contract.trim()) {
        diagnostics.push({
            code: 'jpl60-contract-missing',
            message: `Node "${expectedName}" is missing contract documentation.`,
        });
    }

    return {
        valid: diagnostics.length === 0,
        lineCount: lines.length,
        executableLines: executable,
        diagnostics,
    };
}

/**
 * Determine whether TypeScript/JavaScript source contains real JSX syntax (elements,
 * self-closing tags, or fragments) via the TypeScript AST or an explicit `.tsx`/`.jsx` extension hint.
 */
export function containsJsxSyntax(source: string, extHint?: string): boolean {
    const lowerExt = extHint?.toLowerCase() ?? '';
    if (lowerExt.endsWith('.tsx') || lowerExt.endsWith('.jsx')) {
        return true;
    }
    const sfTsx = ts.createSourceFile('<jsx-check>.tsx', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
    let found = false;
    const visit = (node: ts.Node) => {
        if (found) return;
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
            found = true;
            return;
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(sfTsx, visit);
    if (!found) return false;
    // Disambiguate TypeScript generics/type-assertions such as `<T>(x: T) => x`
    // which parse validly in `.ts` without JSX tags and trigger parse errors in `.tsx`.
    const sfTs = ts.createSourceFile(
        '<jsx-check>.ts',
        source,
        ts.ScriptTarget.Latest,
        false,
        lowerExt.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    const tsDiags = (sfTs as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length ?? 0;
    const tsxDiags = (sfTsx as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length ?? 0;
    if (tsDiags === 0 && tsxDiags > 0) {
        return false;
    }
    return true;
}

export class TypeScriptAdapter implements LanguageAdapter {
    readonly language: CanonicalLanguage;

    constructor(language: 'typescript' | 'javascript' = 'typescript') {
        this.language = language;
    }

    parseModule(source: string, documentPath = '<memory>.tsx', nodeId?: string): ParseModuleResult {
        return parseTsModule(source, documentPath, nodeId);
    }

    replaceUnit(params: Record<string, unknown>): SourceProposal {
        return replaceTsUnit(params);
    }

    createStub(
        name: string,
        params: ReadonlyArray<UnitParam | { name: string; annotation?: string | null; default?: string | null; kind?: UnitParam['kind'] }>,
        returnType: string | null,
        kind: 'function' | 'arrow' | 'method' | 'class' | 'component' | 'operator' = 'function',
        options?: CreateStubOptions,
    ): string {
        return createTsStub(name, params, returnType, kind, { ...options, language: this.language as 'typescript' | 'javascript' });
    }

    checkNodeCode(
        code: string | readonly string[],
        expectedName: string,
        options?: CheckNodeCodeOptions,
    ): Jpl60CheckResult {
        return checkTsNodeCode(code, expectedName, {
            language: this.language,
            ...options,
        });
    }

    formatGeneratedHeader(path?: string): string {
        return formatGeneratedHeaderForLanguage(path ?? this.language);
    }

    isGeneratedFile(content: string): boolean {
        return isSlateGeneratedContent(content);
    }

    dispose(): void {}
}
