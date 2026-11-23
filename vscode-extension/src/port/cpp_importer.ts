import {
    cppIdentifierNames,
    cppTopLevelBindings,
    isCppGeneratedFile,
    parseCppDetailed,
    splitCppInclude,
    type CppInclude,
} from '../cpp_adapter';
import { codeLines, FORMAT_VERSION } from '../language_types';
import type { NodeKind, SlateConfig, SlateNode } from '../slate_folder';
import { EPILOGUE, formatPortReport, PRELUDE, type PortReport } from './python_importer';

export { EPILOGUE, formatPortReport, PRELUDE, type PortReport };

interface CppDefinition {
    name: string;
    nodeIdName: string;
    kind: 'function' | 'class';
    signature: string;
    code: string;
    namespaceScopes: string[];
    overloadKey: string;
    overloadIndex?: number;
}

interface CppModuleScan {
    path: string;
    folder: string;
    extension: string;
    isArduino: boolean;
    includes: CppInclude[];
    definitions: CppDefinition[];
    prelude: string;
    epilogue: string;
}

const join = (...parts: string[]) => parts.filter(Boolean).join('/');

const CPP_EXTENSIONS = ['.ino', '.pde', '.hpp', '.hxx', '.hh', '.cpp', '.cxx', '.cc', '.h', '.c'];

function matchCppExtension(path: string): string | null {
    const lower = path.toLowerCase();
    for (const ext of CPP_EXTENSIONS) {
        if (lower.endsWith(ext)) return path.slice(path.length - ext.length);
    }
    return null;
}

function normalizeFilesInput(files: Record<string, string> | ReadonlyMap<string, string>): Array<[string, string]> {
    if (files instanceof Map || (typeof (files as ReadonlyMap<string, string>).entries === 'function' && !(files instanceof Array))) {
        return [...(files as ReadonlyMap<string, string>).entries()].map(([k, v]) => [k.replace(/\\/g, '/'), v]);
    }
    return Object.entries(files as Record<string, string>).map(([k, v]) => [k.replace(/\\/g, '/'), v]);
}

function computeModuleFolder(path: string, ext: string, allPaths: Set<string>): string {
    const stem = path.slice(0, path.length - ext.length);
    const lowerExt = ext.toLowerCase();
    if (lowerExt === '.h' || lowerExt === '.hpp' || lowerExt === '.hh' || lowerExt === '.hxx') {
        const hasSourcePair = ['.cpp', '.cc', '.cxx', '.c', '.ino'].some(srcExt => allPaths.has(`${stem}${srcExt}`));
        if (hasSourcePair) {
            return `${stem}_h`;
        }
    }
    return stem;
}

function offsetFromPosition(source: string, line: number, character: number): number {
    let curLine = 0;
    let idx = 0;
    while (idx < source.length && curLine < line) {
        if (source[idx] === '\n') curLine++;
        idx++;
    }
    return Math.min(source.length, idx + character);
}

function isForwardPrototypeOf(stmt: string, definedNames: Set<string>): boolean {
    const trimmed = stmt.trim();
    if (!trimmed.endsWith(';') || trimmed.includes('{') || trimmed.startsWith('#')) return false;
    if (/^(?:typedef|using|const|constexpr|struct|class|enum)\b/.test(trimmed) && !trimmed.includes('(')) {
        return false;
    }
    const match = trimmed.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?;\s*$/);
    if (!match) return false;
    const fnName = match[1];
    return definedNames.has(fnName);
}

function detectArduinoModule(
    path: string,
    includes: CppInclude[],
    definitions: CppDefinition[],
    source: string,
    mode?: 'cpp' | 'arduino',
): boolean {
    if (mode === 'arduino') return true;
    const lower = path.toLowerCase();
    if (lower.endsWith('.ino') || lower.endsWith('.pde')) return true;
    if (includes.some(inc => inc.header.toLowerCase() === 'arduino.h')) return true;
    const defNames = new Set(definitions.map(d => d.name));
    if (defNames.has('setup') && defNames.has('loop')) return true;
    if ((defNames.has('setup') || defNames.has('loop')) && /\b(?:pinMode|digitalWrite|digitalRead|analogRead|analogWrite|Serial|delay)\b/.test(source)) {
        return true;
    }
    return false;
}

function scanCppModule(
    path: string,
    source: string,
    ext: string,
    allPaths: Set<string>,
    warnings: string[],
    mode?: 'cpp' | 'arduino',
): CppModuleScan | null {
    const parsed = parseCppDetailed(source, path);
    if (!parsed.valid) {
        warnings.push(`${path}: could not be parsed; not ported.`);
        return null;
    }

    const folder = computeModuleFolder(path, ext, allPaths);
    const topUnits = parsed.units.filter(u => u.parentId === null);

    // Compute character ranges for top-level units (including immediately preceding doc comments)
    const unitSpans: Array<{ from: number; to: number; unit: typeof topUnits[number] }> = [];
    const lines = source.split('\n');
    const lineStartOffsets: number[] = [0];
    for (let i = 0; i < source.length; i++) {
        if (source[i] === '\n') lineStartOffsets.push(i + 1);
    }

    for (const unit of topUnits) {
        let startLine = unit.ranges.declaration.start.line;
        // Include contiguous preceding doc/comment lines (`//` or `/* ... */`) that aren't generated headers
        while (startLine > 0) {
            const prevLine = (lines[startLine - 1] ?? '').trim();
            if (
                (prevLine.startsWith('//') && !prevLine.startsWith('// Generated by Slate') && !prevLine.startsWith('// slate:')) ||
                prevLine.startsWith('/*') ||
                prevLine.startsWith('*') ||
                prevLine.endsWith('*/')
            ) {
                startLine--;
            } else {
                break;
            }
        }
        const from = startLine < unit.ranges.declaration.start.line
            ? lineStartOffsets[startLine]
            : offsetFromPosition(source, unit.ranges.declaration.start.line, unit.ranges.declaration.start.character);
        const to = offsetFromPosition(source, unit.ranges.declaration.end.line, unit.ranges.declaration.end.character);
        unitSpans.push({ from, to, unit });
    }

    const definitions: CppDefinition[] = [];
    const definedNames = new Set<string>();

    for (const span of unitSpans) {
        const name = span.unit.name;
        if (name === PRELUDE || name === EPILOGUE) {
            warnings.push(`${path}: ${name} is a reserved node name; it stays in the prelude.`);
            continue;
        }
        const nsScopes = parsed.unitNamespaces.get(span.unit.id) ?? [];
        const paramSig = (span.unit.params ?? []).map(p => (p.annotation ?? '').replace(/\s+/g, '')).join(',');
        const overloadKey = `${nsScopes.join('::')}|${name}(${paramSig})`;

        let overloadIndex: number | undefined;
        const existingSameSigIdx = definitions.findIndex(d => d.overloadKey === overloadKey);
        if (existingSameSigIdx >= 0) {
            warnings.push(`${path}: ${name} is defined more than once; kept the last definition.`);
            overloadIndex = definitions[existingSameSigIdx].overloadIndex;
            definitions.splice(existingSameSigIdx, 1);
        } else {
            const sameNameCount = definitions.filter(d => d.name === name).length;
            if (sameNameCount > 0) {
                overloadIndex = sameNameCount + 1;
            }
        }

        const nodeIdName = overloadIndex ? `${name}__overload_${overloadIndex}` : name;
        definitions.push({
            name,
            nodeIdName,
            kind: span.unit.kind === 'class' || span.unit.kind === 'nested_class' ? 'class' : 'function',
            signature: span.unit.signature ?? name,
            code: source.slice(span.from, span.to).trim(),
            namespaceScopes: nsScopes,
            overloadKey,
            ...(overloadIndex !== undefined ? { overloadIndex } : {}),
        });
        definedNames.add(name);
    }

    // Collect gaps outside unitSpans AND outside `namespace ... {` / `}` wrappers to extract `#include`, prelude, and epilogue
    const excludedSpans: Array<{ from: number; to: number }> = [
        ...unitSpans.map(s => ({ from: s.from, to: s.to })),
        ...parsed.namespaceSpans.flatMap(ns => [
            { from: ns.headerFrom, to: ns.braceFrom + 1 },
            { from: ns.closeFrom, to: ns.closeFrom + 1 },
        ]),
    ].sort((a, b) => a.from - b.from || a.to - b.to);

    const mergedExcluded: Array<{ from: number; to: number }> = [];
    for (const s of excludedSpans) {
        const last = mergedExcluded[mergedExcluded.length - 1];
        if (last && s.from <= last.to) {
            last.to = Math.max(last.to, s.to);
        } else {
            mergedExcluded.push({ ...s });
        }
    }

    const lastUnitEnd = unitSpans.length > 0 ? Math.max(...unitSpans.map(s => s.to)) : 0;
    const gaps: Array<{ from: number; to: number; afterDefinitions: boolean }> = [];
    let cursor = 0;
    for (const span of mergedExcluded) {
        if (span.from > cursor) {
            gaps.push({
                from: cursor,
                to: span.from,
                afterDefinitions: unitSpans.length > 0 && cursor >= lastUnitEnd,
            });
        }
        cursor = Math.max(cursor, span.to);
    }
    if (cursor < source.length) {
        gaps.push({
            from: cursor,
            to: source.length,
            afterDefinitions: unitSpans.length > 0 && cursor >= lastUnitEnd,
        });
    }

    const includes: CppInclude[] = [];
    const seenIncludeLines = new Set<string>();
    const preludeLines: string[] = [];
    const epilogueLines: string[] = [];

    for (const gap of gaps) {
        const chunk = source.slice(gap.from, gap.to).replace(/\r\n?/g, '\n');
        const chunkLines = chunk.split('\n');
        let idx = 0;
        while (idx < chunkLines.length) {
            const rawLine = chunkLines[idx];
            const trimmed = rawLine.trim();

            if (!trimmed) {
                idx++;
                continue;
            }
            if (isCppGeneratedFile(trimmed) || trimmed.startsWith('// slate:') || trimmed.startsWith('// intent:') || trimmed.startsWith('// contract:')) {
                idx++;
                continue;
            }

            // Check #include
            if (/^#\s*include\b/.test(trimmed)) {
                for (const inc of splitCppInclude(trimmed)) {
                    if (!seenIncludeLines.has(inc.line)) {
                        seenIncludeLines.add(inc.line);
                        includes.push(inc);
                    }
                }
                idx++;
                continue;
            }

            // Check multiline preprocessor directive (e.g. `#define ... \`)
            if (trimmed.startsWith('#')) {
                const block = [rawLine.trimEnd()];
                while (block[block.length - 1].endsWith('\\') && idx + 1 < chunkLines.length) {
                    idx++;
                    block.push(chunkLines[idx].trimEnd());
                }
                preludeLines.push(block.join('\n'));
                idx++;
                continue;
            }

            // Skip redundant forward function prototypes for functions defined in this module
            if (isForwardPrototypeOf(trimmed, definedNames)) {
                idx++;
                continue;
            }

            const targetBucket = gap.afterDefinitions && [...cppIdentifierNames(trimmed)].some(n => definedNames.has(n))
                ? epilogueLines
                : preludeLines;
            targetBucket.push(rawLine.trimEnd());
            idx++;
        }
    }

    const isArduino = detectArduinoModule(path, includes, definitions, source, mode);
    if (isArduino && !includes.some(inc => inc.header.toLowerCase() === 'arduino.h')) {
        includes.unshift({
            line: '#include <Arduino.h>',
            header: 'Arduino.h',
            system: true,
            binding: 'Arduino',
        });
    }

    return {
        path,
        folder,
        extension: ext,
        isArduino,
        includes,
        definitions,
        prelude: preludeLines.join('\n').trim(),
        epilogue: epilogueLines.join('\n').trim(),
    };
}

/**
 * Port a C++ (`.cpp`, `.cc`, `.h`, `.hpp`) or Arduino (`.ino`) project into Slate nodes.
 */
export function portCppProject(
    files: Record<string, string> | ReadonlyMap<string, string>,
    mode?: 'cpp' | 'arduino',
): {
    nodes: Map<string, SlateNode>;
    config: SlateConfig;
    report: PortReport;
} {
    const warnings: string[] = [];
    const entries = normalizeFilesInput(files).sort(([a], [b]) => a.localeCompare(b));
    const allPaths = new Set(entries.map(([p]) => p));
    const scans: CppModuleScan[] = [];

    for (const [path, source] of entries) {
        const ext = matchCppExtension(path);
        if (!ext) continue;
        const scan = scanCppModule(path, source, ext, allPaths, warnings, mode);
        if (scan) scans.push(scan);
    }

    const preludeBindingsByFolder = new Map<string, Set<string>>();
    const defNodeIdByName = new Map<string, string[]>();

    for (const scan of scans) {
        preludeBindingsByFolder.set(scan.folder, cppTopLevelBindings(scan.prelude));
        for (const def of scan.definitions) {
            const nodeId = join(scan.folder, def.nodeIdName);
            const list = defNodeIdByName.get(def.name) ?? [];
            if (!list.includes(nodeId)) list.push(nodeId);
            defNodeIdByName.set(def.name, list);
        }
    }

    const nodes = new Map<string, SlateNode>();
    let preludes = 0;
    let epilogues = 0;

    for (const scan of scans) {
        const ownPreludeBindings = preludeBindingsByFolder.get(scan.folder) ?? new Set<string>();
        const localDefNames = new Set(scan.definitions.map(d => d.name));
        const includeLines = scan.includes.map(inc => inc.line);
        const nodeLanguage = scan.isArduino ? 'arduino' : 'cpp';

        const makeNode = (
            name: string,
            code: string,
            kind?: NodeKind,
            order?: number,
            defKind?: 'function' | 'class',
            namespaceScopes?: string[],
            overloadIndex?: number,
        ): SlateNode => {
            const idents = cppIdentifierNames(code);
            const uses = new Set<string>();

            // Local definitions in the same translation unit
            for (const otherName of localDefNames) {
                if (otherName !== name && idents.has(otherName)) {
                    const targetDefs = scan.definitions.filter(d => d.name === otherName);
                    for (const td of targetDefs) {
                        uses.add(join(scan.folder, td.nodeIdName));
                    }
                }
            }

            // Own module prelude (`#define` constants, global pin constants, typedefs)
            if (kind !== 'prelude') {
                for (const binding of ownPreludeBindings) {
                    if (!localDefNames.has(binding) && idents.has(binding)) {
                        uses.add(join(scan.folder, PRELUDE));
                        break;
                    }
                }
            }

            // Cross-module definitions and header preludes
            for (const ident of idents) {
                if (ident === name || localDefNames.has(ident) || ownPreludeBindings.has(ident)) continue;
                const candidates = (defNodeIdByName.get(ident) ?? []).filter(id => !id.startsWith(`${scan.folder}/`));
                if (candidates.length === 1) {
                    uses.add(candidates[0]);
                }
                for (const otherScan of scans) {
                    if (otherScan.folder === scan.folder) continue;
                    const otherPrelude = preludeBindingsByFolder.get(otherScan.folder);
                    if (otherPrelude?.has(ident) && otherScan.prelude) {
                        uses.add(join(otherScan.folder, PRELUDE));
                    }
                }
            }

            const extra: Record<string, unknown> = {
                modulePath: scan.path,
                extension: scan.extension,
            };
            if (scan.isArduino) {
                extra.arduinoSketch = true;
            }
            if (defKind === 'class') {
                extra.cppKind = 'class';
            }
            if (namespaceScopes && namespaceScopes.length > 0) {
                extra.namespaceScopes = namespaceScopes;
            }
            if (overloadIndex !== undefined) {
                extra.overloadIndex = overloadIndex;
            }

            return {
                name,
                language: nodeLanguage,
                kind,
                order,
                intent: '',
                contract: '',
                context: [],
                examples: [],
                locked: false,
                imports: [...includeLines],
                uses: [...uses].sort(),
                code: codeLines(code),
                extra,
            };
        };

        if (scan.prelude) {
            nodes.set(join(scan.folder, PRELUDE), makeNode(PRELUDE, scan.prelude, 'prelude'));
            preludes++;
        }

        scan.definitions.forEach((def, index) => {
            const nodeId = join(scan.folder, def.nodeIdName);
            nodes.set(nodeId, makeNode(def.name, def.code, undefined, index, def.kind, def.namespaceScopes, def.overloadIndex));
        });

        if (scan.epilogue) {
            nodes.set(join(scan.folder, EPILOGUE), makeNode(EPILOGUE, scan.epilogue, 'epilogue'));
            epilogues++;
        }
    }

    const anyArduino = mode === 'arduino' || scans.some(s => s.isArduino);
    const firstStem = scans[0]?.folder.split('/').pop() || 'firmware';
    const config: SlateConfig = {
        slate: FORMAT_VERSION,
        name: firstStem,
        language: anyArduino ? 'arduino' : 'cpp',
        compile: { outDir: 'src' },
    };

    return {
        nodes,
        config,
        report: {
            modules: scans.map(s => s.path),
            nodes: nodes.size - preludes - epilogues,
            preludes,
            epilogues,
            warnings,
        },
    };
}

export function portArduinoProject(
    files: Record<string, string> | ReadonlyMap<string, string>,
): ReturnType<typeof portCppProject> {
    return portCppProject(files, 'arduino');
}
