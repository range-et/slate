import {
    csharpIdentifierNames,
    csharpTopLevelBindings,
    parseCSharpDetailed,
    type CSharpUsing,
} from '../csharp_adapter';
import { codeLines } from '../language_types';
import type { NodeKind, SlateNode } from '../slate_folder';
import type { PortReport } from './python_importer';

export const PRELUDE = '_prelude';
export const EPILOGUE = '_epilogue';

interface CSharpDefinition {
    name: string;
    nodeId: string;
    code: string;
    intent: string;
    contract: string;
    namespace: string | null;
    className: string | null;
    classModifiers: string | null;
    classDeclaration: string | null;
    overloadKey: string;
    overloadIndex?: number;
}

interface CSharpPrelude {
    name: string;
    code: string;
    namespace: string | null;
    className: string | null;
    classModifiers: string | null;
    classDeclaration: string | null;
    topLevelStatements?: boolean;
}

interface CSharpModuleScan {
    path: string;
    folder: string;
    namespace: string | null;
    className: string | null;
    classModifiers: string | null;
    classDeclaration: string | null;
    usings: CSharpUsing[];
    definitions: CSharpDefinition[];
    preludes: CSharpPrelude[];
}

const join = (...parts: string[]) => parts.filter(Boolean).join('/');

function moduleFolder(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    return normalized.endsWith('.cs') ? normalized.slice(0, -'.cs'.length) : normalized;
}

function unindentBlock(text: string): string {
    const normalized = text.replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    const nonEmpty = lines.filter(l => l.trim().length > 0);
    if (nonEmpty.length === 0) return '';
    const minIndent = Math.min(...nonEmpty.map(l => l.match(/^[ \t]*/)?.[0].length ?? 0));
    return lines.map(l => l.slice(minIndent)).join('\n');
}

function extractLeadingXmlSummary(source: string, declarationLineStart: number): { intent: string; contract: string } {
    const before = source.slice(0, declarationLineStart).replace(/\r\n?/g, '\n');
    const lines = before.split('\n');
    if (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

    const docLines: string[] = [];
    const intentLines: string[] = [];
    const contractLines: string[] = [];
    let currentMeta: 'intent' | 'contract' | null = null;

    while (lines.length > 0) {
        const line = lines[lines.length - 1].trim();
        if (line.startsWith('///') || line.startsWith('//')) {
            docLines.unshift(line);
            lines.pop();
        } else {
            break;
        }
    }
    if (docLines.length === 0) return { intent: '', contract: '' };

    const plainDoc: string[] = [];
    for (const raw of docLines) {
        const stripped = raw.replace(/^\/\/\/?\s?/, '');
        if (stripped.startsWith('slate:')) {
            currentMeta = null;
            continue;
        }
        if (stripped.startsWith('intent:')) {
            currentMeta = 'intent';
            intentLines.push(stripped.slice('intent:'.length).trim());
            continue;
        }
        if (stripped.startsWith('contract:')) {
            currentMeta = 'contract';
            contractLines.push(stripped.slice('contract:'.length).trim());
            continue;
        }
        if (currentMeta === 'intent' && raw.startsWith('//   ')) {
            intentLines.push(raw.replace(/^\/\/\s{2,3}/, ''));
            continue;
        }
        if (currentMeta === 'contract' && raw.startsWith('//   ')) {
            contractLines.push(raw.replace(/^\/\/\s{2,3}/, ''));
            continue;
        }
        currentMeta = null;
        plainDoc.push(stripped);
    }

    if (intentLines.length > 0 || contractLines.length > 0) {
        return {
            intent: intentLines.join('\n').trim(),
            contract: contractLines.join('\n').trim(),
        };
    }

    const joined = plainDoc.join(' ').trim();
    const summaryMatch = joined.match(/<summary>([\s\S]*?)<\/summary>/i);
    if (summaryMatch) {
        return { intent: summaryMatch[1].replace(/\s+/g, ' ').trim(), contract: '' };
    }
    return {
        intent: joined.replace(/<\/?[a-zA-Z0-9_]+>/g, '').replace(/\s+/g, ' ').trim(),
        contract: '',
    };
}

function extractClassPrelude(
    source: string,
    classFrom: number,
    classTo: number,
    memberRanges: Array<{ from: number; to: number }>,
): string {
    const openBrace = source.indexOf('{', classFrom);
    const closeBrace = source.lastIndexOf('}', classTo);
    if (openBrace < 0 || openBrace >= classTo || closeBrace <= openBrace) return '';

    const sorted = [...memberRanges]
        .filter(r => r.from > openBrace && r.to <= closeBrace)
        .sort((a, b) => a.from - b.from);

    const chunks: string[] = [];
    let cursor = openBrace + 1;
    for (const range of sorted) {
        let end = range.from;
        const lineStart = source.lastIndexOf('\n', end - 1) + 1;
        if (source.slice(lineStart, end).trim() === '') {
            end = lineStart;
        }
        const slice = source.slice(cursor, end);
        const lines = slice.replace(/\r\n?/g, '\n').split('\n');
        // Strip trailing comments right before the member declaration (doc comments / slate stamps)
        while (lines.length > 0) {
            const last = lines[lines.length - 1].trim();
            if (last === '' || last.startsWith('//')) {
                lines.pop();
            } else {
                break;
            }
        }
        // Strip leading slate stamp / metadata comments on the prelude itself
        const filtered = lines.filter(l => {
            const t = l.trim();
            if (!t) return false;
            if (t.startsWith('// slate:') || t.startsWith('// intent:') || t.startsWith('// contract:')) return false;
            return true;
        });
        const hasCodeLine = filtered.some(l => !l.trim().startsWith('//'));
        if (hasCodeLine) {
            chunks.push(unindentBlock(filtered.join('\n')));
        }
        cursor = range.to;
    }

    const tail = source.slice(cursor, closeBrace);
    const tailLines = tail
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .filter(l => {
            const t = l.trim();
            return t.length > 0 && !t.startsWith('//');
        });
    if (tailLines.length > 0) {
        chunks.push(unindentBlock(tailLines.join('\n')));
    }

    return chunks.filter(Boolean).join('\n');
}

function scanCSharpModule(filePath: string, source: string, warnings: string[]): CSharpModuleScan | null {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const folder = moduleFolder(normalizedPath);
    const parsed = parseCSharpDetailed(source, normalizedPath);
    if (!parsed.valid) {
        warnings.push(`${normalizedPath}: could not be parsed; not ported.`);
        return null;
    }

    const definitions: CSharpDefinition[] = [];
    const methodUnits = parsed.units.filter(u => u.kind === 'method' || u.kind === 'function');
    const classUnits = parsed.units.filter(u => u.kind === 'class' || u.kind === 'nested_class');
    const memberRangesByClass = new Map<string, Array<{ from: number; to: number }>>();
    const classesWithMethods = new Set<string>();

    let primaryClassName: string | null = classUnits[0]?.name ?? null;
    let primaryClassModifiers: string | null = classUnits[0]
        ? (parsed.unitDetails.get(classUnits[0].id)?.classModifiers ?? 'public static')
        : null;
    let primaryClassDeclaration: string | null = classUnits[0]
        ? (parsed.unitDetails.get(classUnits[0].id)?.classDeclaration ?? null)
        : null;

    for (const unit of methodUnits) {
        const offsets = parsed.offsets.get(unit.id);
        const details = parsed.unitDetails.get(unit.id);
        if (!offsets) continue;
        if (unit.parentId) {
            classesWithMethods.add(unit.parentId);
            const list = memberRangesByClass.get(unit.parentId) ?? [];
            list.push({ from: offsets.wrapper.from, to: offsets.code.to });
            memberRangesByClass.set(unit.parentId, list);
        }

        if (unit.name === PRELUDE || unit.name === EPILOGUE) {
            warnings.push(`${normalizedPath}: ${unit.name} is a reserved node name; skipped.`);
            continue;
        }

        const ns = details?.namespace ?? parsed.namespace;
        const clsName = details?.className ?? primaryClassName;
        const clsMods = details?.classModifiers ?? primaryClassModifiers;
        const clsDecl = details?.classDeclaration ?? primaryClassDeclaration;
        const paramSig = (unit.params ?? []).map(p => (p.annotation ?? '').replace(/\s+/g, '')).join(',');
        const overloadKey = `${clsName ?? ''}|${unit.name}(${paramSig})`;

        let overloadIndex: number | undefined;
        const existingSameSigIdx = definitions.findIndex(d => d.overloadKey === overloadKey);
        if (existingSameSigIdx >= 0) {
            warnings.push(`${normalizedPath}: ${unit.name} is defined more than once; kept the last definition.`);
            overloadIndex = definitions[existingSameSigIdx].overloadIndex;
            definitions.splice(existingSameSigIdx, 1);
        } else {
            const sameNameCount = definitions.filter(d => d.name === unit.name).length;
            if (sameNameCount > 0) {
                overloadIndex = sameNameCount + 1;
            }
        }

        const lineStart = source.lastIndexOf('\n', offsets.wrapper.from - 1) + 1;
        const sliceFrom = source.slice(lineStart, offsets.wrapper.from).trim() === ''
            ? lineStart
            : offsets.wrapper.from;
        const rawMethod = source.slice(sliceFrom, offsets.code.to);
        const code = unindentBlock(rawMethod);
        const docMeta = extractLeadingXmlSummary(source, lineStart);

        const targetNodeId = overloadIndex
            ? join(folder, `${unit.name}__overload_${overloadIndex}`)
            : join(folder, unit.name);

        definitions.push({
            name: unit.name,
            nodeId: targetNodeId,
            code,
            intent: docMeta.intent,
            contract: docMeta.contract,
            namespace: ns,
            className: clsName,
            classModifiers: clsMods,
            classDeclaration: clsDecl,
            overloadKey,
            ...(overloadIndex !== undefined ? { overloadIndex } : {}),
        });
    }

    // Port data-only top-level types (interfaces, structs, records, classes without methods, enums, delegates)
    // even when method-bearing classes also exist in the same file.
    for (const unit of classUnits.filter(u => u.parentId === null)) {
        const hasOwnMethods = classesWithMethods.has(unit.id);
        const hasNestedMethods = parsed.units.some(u => u.parentId === unit.id && classesWithMethods.has(u.id));
        if (hasOwnMethods || hasNestedMethods) continue;
        if (unit.name === PRELUDE || unit.name === EPILOGUE) {
            warnings.push(`${normalizedPath}: ${unit.name} is a reserved node name; skipped.`);
            continue;
        }
        const offsets = parsed.offsets.get(unit.id);
        const details = parsed.unitDetails.get(unit.id);
        if (!offsets) continue;
        const lineStart = source.lastIndexOf('\n', offsets.wrapper.from - 1) + 1;
        const sliceFrom = source.slice(lineStart, offsets.wrapper.from).trim() === ''
            ? lineStart
            : offsets.wrapper.from;
        const code = unindentBlock(source.slice(sliceFrom, offsets.code.to));
        const docMeta = extractLeadingXmlSummary(source, lineStart);
        let nodeNameSuffix = unit.name;
        let targetNodeId = join(folder, nodeNameSuffix);
        let suffixIdx = 2;
        while (definitions.some(d => d.nodeId === targetNodeId)) {
            nodeNameSuffix = `${unit.name}__type_${suffixIdx++}`;
            targetNodeId = join(folder, nodeNameSuffix);
        }
        definitions.push({
            name: unit.name,
            nodeId: targetNodeId,
            code,
            intent: docMeta.intent,
            contract: docMeta.contract,
            namespace: details?.namespace ?? parsed.namespace,
            className: unit.name,
            classModifiers: details?.classModifiers ?? 'public',
            classDeclaration: details?.classDeclaration ?? null,
            overloadKey: `${details?.namespace ?? ''}|${unit.name}|type`,
        });
    }

    const preludes: CSharpPrelude[] = [];
    let usedDefaultPreludeName = false;
    for (const cls of classUnits.filter(u => u.parentId === null && classesWithMethods.has(u.id))) {
        const clsOffsets = parsed.offsets.get(cls.id);
        if (!clsOffsets) continue;
        const clsDetails = parsed.unitDetails.get(cls.id);
        const clsPrelude = extractClassPrelude(
            source,
            clsOffsets.code.from,
            clsOffsets.code.to,
            memberRangesByClass.get(cls.id) ?? [],
        );
        if (!clsPrelude.trim()) continue;
        const preludeName = !usedDefaultPreludeName ? PRELUDE : `${PRELUDE}_${cls.name}`;
        usedDefaultPreludeName = true;
        preludes.push({
            name: preludeName,
            code: clsPrelude,
            namespace: clsDetails?.namespace ?? parsed.namespace,
            className: cls.name,
            classModifiers: clsDetails?.classModifiers ?? primaryClassModifiers,
            classDeclaration: clsDetails?.classDeclaration ?? primaryClassDeclaration,
        });
    }

    if (parsed.topLevelStatements.length > 0) {
        const topCode = parsed.topLevelStatements
            .map(span => unindentBlock(source.slice(span.from, span.to)))
            .filter(Boolean)
            .join('\n');
        if (topCode.trim()) {
            const topName = !preludes.some(p => p.name === PRELUDE) && !definitions.some(d => d.name === PRELUDE)
                ? PRELUDE
                : `${PRELUDE}__top`;
            preludes.push({
                name: topName,
                code: topCode,
                namespace: null,
                className: null,
                classModifiers: null,
                classDeclaration: null,
                topLevelStatements: true,
            });
        }
    }

    return {
        path: normalizedPath,
        folder,
        namespace: parsed.namespace,
        className: primaryClassName,
        classModifiers: primaryClassModifiers,
        classDeclaration: primaryClassDeclaration,
        usings: parsed.usings,
        definitions,
        preludes,
    };
}

/**
 * Port a C# project (`.cs` files) into `SlateNode` definitions.
 * Extracts `imports` from `using ...;`, resolves `uses` across methods, and preserves
 * `extra.namespace`, `extra.className`, `extra.classModifiers`, and `extra.modulePath`.
 */
export function portCSharpProject(
    files: Record<string, string> | ReadonlyMap<string, string>,
): { nodes: Map<string, SlateNode>; report: PortReport } {
    const entries: Array<[string, string]> = files instanceof Map
        ? [...files.entries()]
        : Object.entries(files);

    const warnings: string[] = [];
    const scans: CSharpModuleScan[] = [];

    for (const [rawPath, source] of entries.sort(([a], [b]) => a.localeCompare(b))) {
        const normalizedPath = rawPath.replace(/\\/g, '/');
        if (!normalizedPath.endsWith('.cs')) continue;
        const scan = scanCSharpModule(normalizedPath, source, warnings);
        if (scan) scans.push(scan);
    }

    const scanPreludes = new Map(
        scans.map(s => [
            s.folder,
            s.preludes.map(p => ({
                ...p,
                nodeId: join(s.folder, p.name),
                bindings: csharpTopLevelBindings(p.code),
            })),
        ]),
    );

    // Build lookup of all ported definitions across the project
    const defsByName = new Map<string, CSharpDefinition[]>();
    const defsByClassAndName = new Map<string, CSharpDefinition>();
    for (const scan of scans) {
        for (const def of scan.definitions) {
            const list = defsByName.get(def.name) ?? [];
            list.push(def);
            defsByName.set(def.name, list);
            if (def.className) {
                defsByClassAndName.set(`${def.className}.${def.name}`, def);
            }
        }
    }

    const nodes = new Map<string, SlateNode>();
    let preludes = 0;

    for (const scan of scans) {
        const ownPreludes = scanPreludes.get(scan.folder) ?? [];
        const localDefs = new Map(scan.definitions.map(d => [d.name, d.nodeId]));
        const importLines = [...new Set(scan.usings.map(u => u.line))];

        const buildExtra = (
            ns: string | null,
            clsName: string | null,
            clsMods: string | null,
            clsDecl: string | null,
            overloadIdx?: number,
            topLevelStatements?: boolean,
        ): Record<string, unknown> => {
            const extra: Record<string, unknown> = {
                modulePath: scan.path,
            };
            if (ns) extra.namespace = ns;
            if (clsName) extra.className = clsName;
            if (clsMods) extra.classModifiers = clsMods;
            if (clsDecl) extra.classDeclaration = clsDecl;
            if (overloadIdx !== undefined) extra.overloadIndex = overloadIdx;
            if (topLevelStatements) extra.topLevelStatements = true;
            return extra;
        };

        const makeNode = (
            name: string,
            code: string,
            intent: string,
            contract: string,
            ns: string | null,
            clsName: string | null,
            clsMods: string | null,
            clsDecl: string | null,
            kind?: NodeKind,
            order?: number,
            overloadIdx?: number,
            topLevelStatements?: boolean,
        ): SlateNode => {
            const idents = csharpIdentifierNames(code);
            const uses = new Set<string>();

            // Same-module method dependencies
            for (const [otherName, otherNodeId] of localDefs) {
                if (otherName !== name && idents.has(otherName)) {
                    uses.add(otherNodeId);
                }
            }

            // Cross-module method dependencies (either `ClassName.MethodName` or unique `MethodName`)
            for (const [qualifiedKey, targetDef] of defsByClassAndName) {
                if (targetDef.nodeId === (overloadIdx ? join(scan.folder, `${name}__overload_${overloadIdx}`) : join(scan.folder, name))) continue;
                const [targetCls, targetMethod] = qualifiedKey.split('.');
                if (idents.has(targetCls) && idents.has(targetMethod)) {
                    uses.add(targetDef.nodeId);
                }
            }
            for (const ident of idents) {
                if (ident === name || localDefs.has(ident)) continue;
                const candidates = defsByName.get(ident);
                if (candidates && candidates.length === 1) {
                    uses.add(candidates[0].nodeId);
                }
            }

            // Same-module prelude constant/field/property dependencies scoped to matching container
            if (kind !== 'prelude') {
                for (const p of ownPreludes) {
                    if (p.topLevelStatements) continue;
                    if (p.className !== clsName || p.namespace !== ns) continue;
                    if ([...p.bindings].some(b => idents.has(b) && !localDefs.has(b))) {
                        uses.add(p.nodeId);
                    }
                }
            }

            // Filter aliased usings if alias is unused; keep standard namespace/static usings
            const nodeImports = scan.usings
                .filter(u => u.alias === null || idents.has(u.alias))
                .map(u => u.line);

            return {
                name,
                language: 'csharp',
                kind,
                order,
                intent,
                contract,
                context: [],
                examples: [],
                locked: false,
                imports: [...new Set(nodeImports.length > 0 ? nodeImports : importLines)],
                uses: [...uses].sort(),
                code: codeLines(code),
                extra: buildExtra(ns, clsName, clsMods, clsDecl, overloadIdx, topLevelStatements),
            };
        };

        for (const p of ownPreludes) {
            if (!p.code.trim()) continue;
            nodes.set(
                p.nodeId,
                makeNode(
                    p.name,
                    p.code,
                    '',
                    '',
                    p.namespace,
                    p.className,
                    p.classModifiers,
                    p.classDeclaration,
                    'prelude',
                    undefined,
                    undefined,
                    p.topLevelStatements,
                ),
            );
            preludes++;
        }

        scan.definitions.forEach((def, order) => {
            nodes.set(
                def.nodeId,
                makeNode(
                    def.name,
                    def.code,
                    def.intent,
                    def.contract,
                    def.namespace,
                    def.className,
                    def.classModifiers,
                    def.classDeclaration,
                    undefined,
                    order,
                    def.overloadIndex,
                ),
            );
        });
    }

    return {
        nodes,
        report: {
            modules: scans.map(s => s.path),
            nodes: nodes.size - preludes,
            preludes,
            epilogues: 0,
            warnings,
        },
    };
}
