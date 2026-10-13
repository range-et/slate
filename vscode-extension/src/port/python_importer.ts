import { parser } from '@lezer/python';
import type { SyntaxNode } from '@lezer/common';

import { identifierNames, splitImport, topLevelBindings, type PythonImport } from '../python_adapter';
import { codeLines, type NodeKind, type SlateNode } from '../slate_folder';

// Port a Python project into slate/ nodes: module `a/b.py` becomes folder `a/b/`,
// each top-level def/class becomes `a/b/<name>`, and other module-level
// statements become `a/b/_prelude` (before the first statement that needs a
// definition) and `a/b/_epilogue` (from there on, e.g. `if __name__ == ...`).

export interface PortReport {
    modules: string[];
    nodes: number;
    preludes: number;
    epilogues: number;
    warnings: string[];
}

export const PRELUDE = '_prelude';
export const EPILOGUE = '_epilogue';

interface Definition { name: string; code: string; globals: string[] }
interface ModuleScan {
    path: string;
    folder: string;
    imports: PythonImport[];
    definitions: Definition[];
    prelude: string;
    epilogue: string;
}

const join = (...parts: string[]) => parts.filter(Boolean).join('/');
const dirname = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

function moduleFolder(path: string): string {
    const stem = path.slice(0, -'.py'.length);
    if (stem === '__init__') return '';
    return stem.endsWith('/__init__') ? stem.slice(0, -'/__init__'.length) : stem;
}

function hasSyntaxError(source: string): boolean {
    const cursor = parser.parse(source).cursor();
    do if (cursor.type.isError) return true; while (cursor.next());
    return false;
}

function contains(node: SyntaxNode, names: string[]): SyntaxNode[] {
    const found: SyntaxNode[] = [];
    const cursor = node.cursor();
    do if (names.includes(cursor.name)) found.push(cursor.node); while (cursor.next() && cursor.from < node.to);
    return found.filter(item => item.from >= node.from && item.to <= node.to);
}

function definitionName(node: SyntaxNode, source: string): string | null {
    const definition = node.name === 'DecoratedStatement'
        ? node.getChild('FunctionDefinition') ?? node.getChild('ClassDefinition')
        : node;
    const name = definition?.getChild('VariableName');
    return name ? source.slice(name.from, name.to) : null;
}

function scanModule(path: string, source: string, warnings: string[]): ModuleScan {
    const top = parser.parse(source).topNode;
    const children: SyntaxNode[] = [];
    for (let child = top.firstChild; child; child = child.nextSibling) children.push(child);
    const isDefinition = (node: SyntaxNode) => ['FunctionDefinition', 'ClassDefinition'].includes(node.name)
        || (node.name === 'DecoratedStatement' && definitionName(node, source) !== null);

    const imports: PythonImport[] = [];
    const definitions: Definition[] = [];
    const buckets = { prelude: [] as string[], epilogue: [] as string[] };
    const defined = new Set<string>();
    let bucket: 'prelude' | 'epilogue' = 'prelude';
    let commentFrom: number | null = null;
    let lastTo: Record<'prelude' | 'epilogue', number | null> = { prelude: null, epilogue: null };

    const push = (target: 'prelude' | 'epilogue', from: number, to: number) => {
        const previous = lastTo[target];
        if (previous !== null && /\n[ \t]*\n/.test(source.slice(previous, from))) buckets[target].push('');
        buckets[target].push(source.slice(from, to).trimEnd());
        lastTo[target] = to;
    };

    for (const child of children) {
        if (child.name === 'Comment') {
            commentFrom ??= child.from;
            continue;
        }
        const from = commentFrom ?? child.from;
        commentFrom = null;
        if (child.name === 'ImportStatement') {
            imports.push(...splitImport(source.slice(child.from, child.to)));
            continue;
        }
        if (isDefinition(child)) {
            const name = definitionName(child, source)!;
            if (name === PRELUDE || name === EPILOGUE) {
                warnings.push(`${path}: ${name} is a reserved node name; it stays in the prelude.`);
                push(bucket, from, child.to);
                continue;
            }
            const existing = definitions.findIndex(definition => definition.name === name);
            if (existing >= 0) {
                warnings.push(`${path}: ${name} is defined more than once; kept the last definition.`);
                definitions.splice(existing, 1);
            }
            const globals = contains(child, ['ScopeStatement'])
                .filter(statement => statement.firstChild?.name === 'global')
                .map(statement => source.slice(statement.from, statement.to).replace(/^global\s+/, '').trim());
            definitions.push({ name, code: source.slice(from, child.to), globals });
            defined.add(name);
            continue;
        }
        const statement = source.slice(child.from, child.to);
        if (bucket === 'prelude' && [...identifierNames(statement)].some(name => defined.has(name))) bucket = 'epilogue';
        for (const nested of contains(child, ['FunctionDefinition', 'ClassDefinition'])) {
            const name = nested.getChild('VariableName');
            warnings.push(`${path}: conditional definition ${name ? source.slice(name.from, name.to) : ''} stays in the ${bucket}.`);
        }
        push(bucket, from, child.to);
    }
    if (commentFrom !== null) push(bucket, commentFrom, source.length);
    return {
        path,
        folder: moduleFolder(path),
        imports,
        definitions,
        prelude: buckets.prelude.join('\n'),
        epilogue: buckets.epilogue.join('\n'),
    };
}

export function portPythonProject(files: ReadonlyMap<string, string>): { nodes: Map<string, SlateNode>; report: PortReport } {
    const warnings: string[] = [];
    const scans: ModuleScan[] = [];
    for (const [path, source] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
        if (!path.endsWith('.py')) continue;
        if (hasSyntaxError(source)) {
            warnings.push(`${path}: could not be parsed; not ported.`);
            continue;
        }
        if (path === '__init__.py') warnings.push(`${path}: root package definitions become root-level nodes.`);
        scans.push(scanModule(path, source, warnings));
    }
    const byFolder = new Map(scans.map(scan => [scan.folder, scan]));
    const preludeNames = new Map(scans.map(scan => [scan.folder, topLevelBindings(scan.prelude)]));

    const moduleAt = (candidate: string) => byFolder.has(candidate) ? candidate : null;
    const resolveModule = (scan: ModuleScan, module: string): string | null => {
        const dots = module.match(/^\.*/)![0].length;
        const rest = module.slice(dots).split('.').filter(Boolean).join('/');
        if (dots > 0) {
            let base = dirname(scan.path);
            for (let level = 1; level < dots; level++) base = dirname(base);
            return moduleAt(join(base, rest));
        }
        return moduleAt(rest) ?? moduleAt(join(dirname(scan.path), rest));
    };

    const nodes = new Map<string, SlateNode>();
    let preludes = 0;
    let epilogues = 0;
    for (const scan of scans) {
        // Imports either stay external or, when they name a ported definition or
        // prelude binding, are dropped and become `uses` of that node.
        const kept: PythonImport[] = [];
        const provided = new Map<string, string>();
        for (const item of scan.imports) {
            const folder = item.name ? resolveModule(scan, item.module) : null;
            if (folder === null || !item.name || moduleAt(join(folder, item.name))) {
                kept.push(item);
                continue;
            }
            const target = byFolder.get(folder)!;
            if (item.name === '*') {
                warnings.push(`${scan.path}: star import from ported module ${item.module} kept as is.`);
                kept.push(item);
            } else if (item.binding !== item.name) {
                warnings.push(`${scan.path}: aliased import "${item.line}" kept as is.`);
                kept.push(item);
            } else if (target.definitions.some(definition => definition.name === item.name)) {
                provided.set(item.binding, join(folder, item.name));
            } else if (preludeNames.get(folder)!.has(item.name)) {
                provided.set(item.binding, join(folder, PRELUDE));
            } else {
                warnings.push(`${scan.path}: "${item.line}" names something in ${target.path} that is not a node; kept as is.`);
                kept.push(item);
            }
        }
        if (kept.some(item => item.binding === null)) warnings.push(`${scan.path}: star import copied to every node in the module.`);

        const ownPrelude = preludeNames.get(scan.folder)!;
        const local = new Set(scan.definitions.map(definition => definition.name));
        const makeNode = (name: string, code: string, kind?: NodeKind, order?: number): SlateNode => {
            const names = identifierNames(code);
            const uses = new Set<string>();
            for (const [binding, nodeId] of provided) if (names.has(binding)) uses.add(nodeId);
            for (const other of local) if (other !== name && names.has(other)) uses.add(join(scan.folder, other));
            if (kind !== 'prelude' && [...ownPrelude].some(binding => names.has(binding) && !local.has(binding))) {
                uses.add(join(scan.folder, PRELUDE));
            }
            return {
                name, kind, order, intent: '', contract: '', context: [], examples: [], locked: false,
                imports: [...new Set(kept.filter(item => item.binding === null || names.has(item.binding)).map(item => item.line))],
                uses: [...uses].sort(),
                code: codeLines(code),
                extra: {},
            };
        };

        if (scan.prelude.trim()) {
            nodes.set(join(scan.folder, PRELUDE), makeNode(PRELUDE, scan.prelude, 'prelude'));
            preludes++;
        }
        scan.definitions.forEach((definition, order) => {
            const nodeId = join(scan.folder, definition.name);
            nodes.set(nodeId, makeNode(definition.name, definition.code, undefined, order));
            for (const name of definition.globals) warnings.push(`${nodeId} uses global ${name}.`);
            if (ownPrelude.has(definition.name)) warnings.push(`${nodeId}: the prelude also binds ${definition.name}.`);
        });
        if (scan.epilogue.trim()) {
            nodes.set(join(scan.folder, EPILOGUE), makeNode(EPILOGUE, scan.epilogue, 'epilogue'));
            epilogues++;
        }
    }
    return {
        nodes,
        report: {
            modules: scans.map(scan => scan.path),
            nodes: nodes.size - preludes - epilogues,
            preludes,
            epilogues,
            warnings,
        },
    };
}

/** Plain-text port report for the output channel. */
export function formatPortReport(report: PortReport): string {
    return [
        `Ported ${report.modules.length} module(s) into ${report.nodes} node(s), ${report.preludes} prelude(s), ${report.epilogues} epilogue(s).`,
        ...report.modules.map(module => `  ${module}`),
        report.warnings.length ? `Warnings (${report.warnings.length}):` : 'No warnings.',
        ...report.warnings.map(warning => `  - ${warning}`),
    ].join('\n');
}
