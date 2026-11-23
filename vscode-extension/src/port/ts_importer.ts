import * as ts from 'typescript';

import { codeLines, normalizeLanguage, type CanonicalLanguage } from '../language_types';
import { EPILOGUE, PRELUDE, type PortReport } from './python_importer';
import type { NodeKind, SlateNode } from '../slate_folder';
import {
    parseTsModule,
    scriptKindForPath,
    splitTsImport,
    tsIdentifierNames,
    tsTopLevelBindings,
    type TsImport,
} from '../ts_adapter';

export { EPILOGUE, PRELUDE, type PortReport };

const SUPPORTED_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'] as const;
export type TsFileExtension = (typeof SUPPORTED_EXTENSIONS)[number];

interface TsDefinition {
    name: string;
    code: string;
    exported: boolean;
    defaultExport: boolean;
}

interface TsModuleScan {
    path: string;
    folder: string;
    extension: TsFileExtension;
    language: 'typescript' | 'javascript';
    imports: TsImport[];
    definitions: TsDefinition[];
    prelude: string;
    epilogue: string;
}

const join = (...parts: string[]) => parts.filter(Boolean).join('/');
const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function detectExtension(filePath: string): TsFileExtension | null {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.d.ts')) return null;
    for (const ext of SUPPORTED_EXTENSIONS) {
        if (lower.endsWith(ext)) return ext;
    }
    return null;
}

function moduleFolder(path: string, ext: TsFileExtension): string {
    const stem = path.slice(0, -ext.length);
    if (stem === 'index') return '';
    return stem.endsWith('/index') ? stem.slice(0, -'/index'.length) : stem;
}

function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function topLevelDefinitionName(stmt: ts.Statement, sf: ts.SourceFile): string | null {
    if (
        (ts.isFunctionDeclaration(stmt) ||
            ts.isClassDeclaration(stmt) ||
            ts.isInterfaceDeclaration(stmt) ||
            ts.isTypeAliasDeclaration(stmt) ||
            ts.isEnumDeclaration(stmt)) &&
        stmt.name
    ) {
        return stmt.name.text;
    }
    if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.length === 1) {
        const decl = stmt.declarationList.declarations[0];
        if (ts.isIdentifier(decl.name) && decl.initializer) {
            if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
                return decl.name.text;
            }
            if (ts.isCallExpression(decl.initializer) && decl.initializer.arguments.length > 0) {
                const firstArg = decl.initializer.arguments[0];
                if (ts.isArrowFunction(firstArg) || ts.isFunctionExpression(firstArg)) {
                    return decl.name.text;
                }
            }
        }
    }
    void sf;
    return null;
}

function isExportedStatement(stmt: ts.Statement): boolean {
    if (!ts.canHaveModifiers(stmt)) return false;
    const mods = ts.getModifiers(stmt);
    return Boolean(mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
}

function isDefaultExportStatement(stmt: ts.Statement): boolean {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) return true;
    if (!ts.canHaveModifiers(stmt)) return false;
    const mods = ts.getModifiers(stmt);
    return Boolean(mods?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword));
}

function scanTsModule(
    path: string,
    source: string,
    ext: TsFileExtension,
    defaultLanguage: 'typescript' | 'javascript',
    warnings: string[],
): TsModuleScan {
    const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKindForPath(path, source));
    const language: 'typescript' | 'javascript' =
        ext === '.js' || ext === '.jsx' ? 'javascript' : defaultLanguage;

    const imports: TsImport[] = [];
    const definitions: TsDefinition[] = [];
    const buckets = { prelude: [] as string[], epilogue: [] as string[] };
    const defined = new Set<string>();
    let bucket: 'prelude' | 'epilogue' = 'prelude';

    for (const stmt of sf.statements) {
        const fullText = source.slice(stmt.getStart(sf), stmt.getEnd()).trim();
        if (!fullText) continue;

        if (ts.isImportDeclaration(stmt)) {
            imports.push(...splitTsImport(fullText));
            continue;
        }

        const defName = topLevelDefinitionName(stmt, sf);
        if (defName !== null) {
            if (defName === PRELUDE || defName === EPILOGUE) {
                warnings.push(`${path}: ${defName} is a reserved node name; it stays in the ${bucket}.`);
                buckets[bucket].push(fullText);
                continue;
            }
            const existingIdx = definitions.findIndex(d => d.name === defName);
            if (existingIdx >= 0) {
                warnings.push(`${path}: ${defName} is defined more than once; kept the last definition.`);
                definitions.splice(existingIdx, 1);
            }
            definitions.push({
                name: defName,
                code: fullText,
                exported: isExportedStatement(stmt),
                defaultExport: isDefaultExportStatement(stmt),
            });
            defined.add(defName);
            continue;
        }

        const stmtIds = tsIdentifierNames(fullText, path);
        if (bucket === 'prelude' && [...stmtIds].some(name => defined.has(name))) {
            bucket = 'epilogue';
        }
        buckets[bucket].push(fullText);
    }

    return {
        path,
        folder: moduleFolder(path, ext),
        extension: ext,
        language,
        imports,
        definitions,
        prelude: buckets.prelude.join('\n'),
        epilogue: buckets.epilogue.join('\n'),
    };
}

function toEntries(files: ReadonlyMap<string, string> | Record<string, string>): Array<[string, string]> {
    if (files instanceof Map) {
        return [...files.entries()].map(([k, v]) => [normalizePath(k), v]);
    }
    return Object.entries(files).map(([k, v]) => [normalizePath(k), v]);
}

function resolveRelativeImport(fromPath: string, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;
    const parts = dirname(fromPath).split('/').filter(Boolean);
    for (const seg of specifier.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
    }
    const resolved = parts.join('/');
    // Strip known extensions if present on the import specifier
    for (const ext of ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs']) {
        if (resolved.toLowerCase().endsWith(ext)) {
            const stem = resolved.slice(0, -ext.length);
            return stem === 'index' ? '' : stem.endsWith('/index') ? stem.slice(0, -'/index'.length) : stem;
        }
    }
    return resolved === 'index' ? '' : resolved.endsWith('/index') ? resolved.slice(0, -'/index'.length) : resolved;
}

/**
 * Port a TypeScript or JavaScript project (`.ts`, `.tsx`, `.js`, `.jsx`) into atomic `SlateNode` definitions.
 * Preserves module path and extension metadata in `node.extra.modulePath` and `node.extra.extension`.
 */
export function portTsProject(
    files: ReadonlyMap<string, string> | Record<string, string>,
    language: 'typescript' | 'javascript' | string = 'typescript',
): { nodes: Map<string, SlateNode>; report: PortReport } {
    const canonicalLang: CanonicalLanguage = normalizeLanguage(language);
    const defaultLang: 'typescript' | 'javascript' =
        canonicalLang === 'javascript' ? 'javascript' : 'typescript';

    const warnings: string[] = [];
    const scans: TsModuleScan[] = [];
    const sortedEntries = toEntries(files).sort(([left], [right]) => left.localeCompare(right));

    for (const [path, source] of sortedEntries) {
        const ext = detectExtension(path);
        if (!ext) continue;
        const parsed = parseTsModule(source, path);
        if (!parsed.valid) {
            warnings.push(`${path}: could not be parsed; not ported.`);
            continue;
        }
        scans.push(scanTsModule(path, source, ext, defaultLang, warnings));
    }

    const byFolder = new Map<string, TsModuleScan>();
    for (const scan of scans) {
        byFolder.set(scan.folder, scan);
    }
    const preludeNames = new Map(scans.map(scan => [scan.folder, tsTopLevelBindings(scan.prelude, scan.path)]));

    const resolveTargetFolder = (scan: TsModuleScan, moduleSpec: string): string | null => {
        const rel = resolveRelativeImport(scan.path, moduleSpec);
        if (rel !== null) {
            if (byFolder.has(rel)) return rel;
            return null;
        }
        if (byFolder.has(moduleSpec)) return moduleSpec;
        return null;
    };

    const nodes = new Map<string, SlateNode>();
    let preludes = 0;
    let epilogues = 0;

    for (const scan of scans) {
        const kept: TsImport[] = [];
        const provided = new Map<string, string>();

        for (const item of scan.imports) {
            const targetFolder = item.binding ? resolveTargetFolder(scan, item.module) : null;
            if (targetFolder === null || !item.binding || !item.name) {
                kept.push(item);
                continue;
            }
            const target = byFolder.get(targetFolder)!;
            if (item.name === '*') {
                warnings.push(`${scan.path}: namespace import "${item.line}" from ported module kept as is.`);
                kept.push(item);
            } else if (item.name !== 'default' && item.binding !== item.name) {
                warnings.push(`${scan.path}: aliased import "${item.line}" kept as is.`);
                kept.push(item);
            } else if (item.name === 'default') {
                const defaultDef = target.definitions.find(d => d.defaultExport && d.name === item.binding)
                    ?? (target.definitions.filter(d => d.defaultExport).length === 1
                        ? target.definitions.find(d => d.defaultExport)
                        : undefined);
                if (defaultDef && defaultDef.name === item.binding) {
                    provided.set(item.binding, join(targetFolder, defaultDef.name));
                } else {
                    kept.push(item);
                }
            } else {
                const lookupName = item.name;
                const matchedDef = target.definitions.find(d => d.name === lookupName);
                if (matchedDef) {
                    provided.set(item.binding, join(targetFolder, matchedDef.name));
                } else if (preludeNames.get(targetFolder)?.has(lookupName)) {
                    provided.set(item.binding, join(targetFolder, PRELUDE));
                } else {
                    kept.push(item);
                }
            }
        }

        const ownPrelude = preludeNames.get(scan.folder)!;
        const localDefs = new Set(scan.definitions.map(d => d.name));

        const makeNode = (
            name: string,
            code: string,
            kind?: NodeKind,
            order?: number,
            exported?: boolean,
            defaultExport?: boolean,
        ): SlateNode => {
            const names = tsIdentifierNames(code, scan.path);
            const uses = new Set<string>();
            for (const [binding, targetNodeId] of provided) {
                if (names.has(binding)) uses.add(targetNodeId);
            }
            for (const other of localDefs) {
                if (other !== name && names.has(other)) uses.add(join(scan.folder, other));
            }
            if (kind !== 'prelude' && [...ownPrelude].some(binding => names.has(binding) && !localDefs.has(binding))) {
                uses.add(join(scan.folder, PRELUDE));
            }
            return {
                name,
                language: scan.language,
                kind,
                order,
                intent: '',
                contract: '',
                context: [],
                examples: [],
                locked: false,
                imports: [...new Set(kept.filter(item => item.binding === null || names.has(item.binding)).map(item => item.line))],
                uses: [...uses].sort(),
                code: codeLines(code),
                extra: {
                    modulePath: scan.path,
                    extension: scan.extension,
                    ...(exported !== undefined ? { exported } : {}),
                    ...(defaultExport ? { defaultExport: true } : {}),
                },
            };
        };

        if (scan.prelude.trim()) {
            nodes.set(join(scan.folder, PRELUDE), makeNode(PRELUDE, scan.prelude, 'prelude'));
            preludes++;
        }
        scan.definitions.forEach((def, order) => {
            const nodeId = join(scan.folder, def.name);
            nodes.set(nodeId, makeNode(def.name, def.code, undefined, order, def.exported, def.defaultExport));
            if (ownPrelude.has(def.name)) {
                warnings.push(`${nodeId}: the prelude also binds ${def.name}.`);
            }
        });
        if (scan.epilogue.trim()) {
            nodes.set(join(scan.folder, EPILOGUE), makeNode(EPILOGUE, scan.epilogue, 'epilogue'));
            epilogues++;
        }
    }

    return {
        nodes,
        report: {
            modules: scans.map(s => s.path),
            nodes: nodes.size - preludes - epilogues,
            preludes,
            epilogues,
            warnings,
        },
    };
}
