import Ajv, { type ValidateFunction } from 'ajv';
import * as fs from 'fs';
import * as path from 'path';

import { compilePython } from './compile/python';
import { EMBEDDED_FLOW_SCHEMA, EMBEDDED_NODE_SCHEMA } from './contract_schemas';
import { parseFlow, unitSignature, type CallableSignature } from './flow';
import type { ParsedUnit, SlateFlow } from './harness_protocol';
import { compileProjectForLanguage, tryNormalizeLanguage } from './language_adapter';
import { parseModule } from './python_adapter';
import { extractClassFrameMetadata, isMethodReceiverParam, parseConfig, parseNode, type SlateCiConfig, type SlateConfig, type SlateNode } from './slate_folder';
import { parseTsModule } from './ts_adapter';

export interface ResolvedCiConfig {
    srcRoots: string[];
    testRoots: string[];
    requireTests: boolean;
}

export interface CiVerifyOptions {
    srcRoots?: string[];
    testRoots?: string[];
    requireTests?: boolean;
}

export interface SchemaCheckResult {
    valid: boolean;
    errors: string[];
}

export interface AstCheckResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
    unit: ParsedUnit | null;
}

export interface LibraryReadResult {
    documents: Array<{ path: string; units: ParsedUnit[]; valid: boolean }>;
    libraryFiles: Set<string>;
    libraryUnits: Set<string>;
}

export interface ParityCheckResult {
    valid: boolean;
    errors: string[];
    documentedUnits: string[];
    scannedFiles: string[];
    srcRoots: string[];
}

export interface DriftCheckResult {
    valid: boolean;
    errors: string[];
    filesChecked: string[];
}

export interface TestPillarResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
    testRoots: string[];
    requireTests: boolean;
    testFilesScanned: string[];
    coveredNodes: string[];
    missingNodes: string[];
    unmappedTestFiles: string[];
}

export interface CiPillarStatus {
    valid: boolean;
    errors: string[];
    warnings?: string[];
}

export interface CiVerificationReport {
    valid: boolean;
    projectDir: string;
    config: ResolvedCiConfig;
    pillars: {
        schema: CiPillarStatus;
        stub: CiPillarStatus;
        code: CiPillarStatus & {
            parityFilesChecked: string[];
            driftFilesChecked: string[];
        };
        test: TestPillarResult;
    };
    errors: string[];
    warnings: string[];
    stats: {
        nodesCount: number;
        flowsCount: number;
        atomicNodesCount: number;
        parityFilesChecked: number;
        driftFilesChecked: number;
        testFilesScanned: number;
        coveredNodesCount: number;
        missingTestsCount: number;
    };
}

let cachedValidators: {
    validateNodeAjv: ValidateFunction;
    validateFlowAjv: ValidateFunction;
} | null = null;

function loadSchemaObject(filename: string, fallback: unknown): unknown {
    const candidates = [
        path.resolve(__dirname, '..', '..', 'contracts', filename),
        path.resolve(__dirname, '..', 'contracts', filename),
        path.resolve(__dirname, '..', '..', '..', 'contracts', filename),
    ];
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                return JSON.parse(fs.readFileSync(candidate, 'utf8'));
            }
        } catch {
            // Fall back to embedded schema
        }
    }
    return fallback;
}

function getValidators(): { validateNodeAjv: ValidateFunction; validateFlowAjv: ValidateFunction } {
    if (cachedValidators) return cachedValidators;
    const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
    const nodeSchema = loadSchemaObject('slate-node.schema.json', EMBEDDED_NODE_SCHEMA);
    const flowSchema = loadSchemaObject('slate-flow.schema.json', EMBEDDED_FLOW_SCHEMA);
    cachedValidators = {
        validateNodeAjv: ajv.compile(nodeSchema as Record<string, unknown>),
        validateFlowAjv: ajv.compile(flowSchema as Record<string, unknown>),
    };
    return cachedValidators;
}

function normalizeRelativeRoot(raw: string, label: string): string {
    if (typeof raw !== 'string' || /[\0\r\n]/.test(raw)) {
        throw new Error(`${label} entries must be relative paths without control characters.`);
    }
    const norm = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!norm) {
        throw new Error(`${label} entries must be non-empty relative paths.`);
    }
    if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) {
        throw new Error(`Unsafe ${label} path "${raw}": must be relative to the project root.`);
    }
    if (norm.split('/').some(seg => seg === '..' || seg === '.')) {
        throw new Error(`Unsafe ${label} path "${raw}": "." and ".." segments are rejected.`);
    }
    return norm;
}

function normalizeRootArray(roots: readonly string[] | undefined, label: string): string[] | undefined {
    if (roots === undefined) return undefined;
    if (!Array.isArray(roots)) {
        throw new Error(`${label} must be an array of relative path strings.`);
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const entry of roots) {
        const norm = normalizeRelativeRoot(entry, label);
        if (!seen.has(norm)) {
            seen.add(norm);
            out.push(norm);
        }
    }
    return out;
}

/**
 * Resolves effective CI roots and strictness from `slate.json` `ci` config plus optional CLI/MCP overrides.
 */
export function resolveCiConfig(config?: SlateConfig | null, overrides?: Partial<SlateCiConfig>): ResolvedCiConfig {
    const defaultSrc = normalizeRelativeRoot(config?.compile?.outDir ?? 'src', 'compile.outDir');
    const overrideSrc = normalizeRootArray(overrides?.srcRoots, 'srcRoots');
    const configSrc = normalizeRootArray(config?.ci?.srcRoots, 'slate.json ci.srcRoots');
    const srcRoots = overrideSrc && overrideSrc.length > 0
        ? overrideSrc
        : (configSrc && configSrc.length > 0 ? configSrc : [defaultSrc]);

    const overrideTests = normalizeRootArray(overrides?.testRoots, 'testRoots');
    const configTests = normalizeRootArray(config?.ci?.testRoots, 'slate.json ci.testRoots');
    const testRoots = overrideTests && overrideTests.length > 0
        ? overrideTests
        : (configTests && configTests.length > 0 ? configTests : ['tests', 'test']);

    const requireTests = typeof overrides?.requireTests === 'boolean'
        ? overrides.requireTests
        : (config?.ci?.requireTests === true);

    return { srcRoots, testRoots, requireTests };
}

/** Validate a node object against `contracts/slate-node.schema.json` using Ajv plus whitespace/JPL-60 checks. */
export function validateNodeSchema(data: unknown, sourceLabel = '<node>'): SchemaCheckResult {
    const errors: string[] = [];
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { valid: false, errors: [`${sourceLabel}: must be a JSON object`] };
    }
    const record = data as Record<string, unknown>;
    const { validateNodeAjv } = getValidators();
    const valid = validateNodeAjv(record);
    if (!valid && validateNodeAjv.errors) {
        for (const err of validateNodeAjv.errors) {
            const missingProp = typeof (err.params as { missingProperty?: unknown })?.missingProperty === 'string'
                ? `/${(err.params as { missingProperty: string }).missingProperty}`
                : '';
            const loc = err.instancePath ? err.instancePath : missingProp;
            errors.push(`${sourceLabel}: ${loc} ${err.message}`.trim());
        }
    }

    if (typeof record.intent === 'string' && record.intent.trim().length === 0) {
        errors.push(`${sourceLabel}: "intent" is required and must be a non-empty string`);
    }
    if (typeof record.contract === 'string' && record.contract.trim().length === 0) {
        errors.push(`${sourceLabel}: "contract" is required documentation and must be a non-empty string`);
    }
    const isExemptLineLimit = record.kind === 'class' || record.kind === 'prelude' || record.kind === 'epilogue';
    if (!isExemptLineLimit && Array.isArray(record.code)) {
        const flatLines = record.code.flatMap(line => (typeof line === 'string' ? line.split(/\r?\n/) : [line]));
        if (flatLines.length > 60) {
            errors.push(`${sourceLabel}: code exceeds JPL-60 limit of 60 lines (${flatLines.length} lines > 60)`);
        }
    }

    return { valid: errors.length === 0, errors };
}

/** Validate a flow object against `contracts/slate-flow.schema.json` using Ajv. */
export function validateFlowSchema(data: unknown, sourceLabel = '<flow>'): SchemaCheckResult {
    const errors: string[] = [];
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { valid: false, errors: [`${sourceLabel}: must be a JSON object`] };
    }
    const { validateFlowAjv } = getValidators();
    const valid = validateFlowAjv(data);
    if (!valid && validateFlowAjv.errors) {
        for (const err of validateFlowAjv.errors) {
            const missingProp = typeof (err.params as { missingProperty?: unknown })?.missingProperty === 'string'
                ? `/${(err.params as { missingProperty: string }).missingProperty}`
                : '';
            const loc = err.instancePath ? err.instancePath : missingProp;
            errors.push(`${sourceLabel}: ${loc} ${err.message}`.trim());
        }
    }

    return { valid: errors.length === 0, errors };
}

function isTsLikeLanguage(lang: string | undefined): 'typescript' | 'javascript' | null {
    const norm = lang ? tryNormalizeLanguage(lang) : null;
    if (norm === 'typescript' || norm === 'javascript') return norm;
    return null;
}

/** Validate node AST via Lezer (Python) or TypeScript compiler: strict typing, JPL-60, and single definition match. */
export function validateNodeAst(
    node: Partial<SlateNode> & { name?: string; kind?: string; code?: unknown[]; language?: string },
    relativePath = '<node>',
    defaultLanguage?: string,
): AstCheckResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const rawLines = Array.isArray(node.code) ? node.code : [];
    const codeLines = rawLines.flatMap(line => String(line).split(/\r?\n/));
    const codeText = `${codeLines.join('\n')}\n`;
    const nodeName = typeof node.name === 'string' ? node.name : '';
    const tsLang = isTsLikeLanguage(node.language ?? defaultLanguage);

    if (node.kind === 'prelude' || node.kind === 'epilogue') {
        const parsed = tsLang
            ? parseTsModule(codeText, relativePath.replace(/\.json$/, tsLang === 'javascript' ? '.js' : '.ts'))
            : parseModule(codeText, relativePath);
        if (!parsed.valid) {
            const label = tsLang ? 'TypeScript/JavaScript' : 'Python';
            errors.push(`${relativePath}: ${label} syntax error in module ${node.kind}: ${parsed.diagnostics.map(d => d.message).join('; ')}`);
        }
        return { valid: errors.length === 0, errors, warnings, unit: null };
    }

    if (node.kind === 'class') {
        const parsedClass = tsLang
            ? parseTsModule(codeText, relativePath.replace(/\.json$/, tsLang === 'javascript' ? '.js' : '.ts'), nodeName)
            : parseModule(codeText, relativePath, nodeName);
        if (!parsedClass.valid) {
            const label = tsLang ? 'TypeScript/JavaScript' : 'Python';
            errors.push(`${relativePath}: ${label} syntax error in class frame "${nodeName}": ${parsedClass.diagnostics.map(d => d.message).join('; ')}`);
            return { valid: false, errors, warnings, unit: null };
        }
        const topLevelClass = parsedClass.units.filter(u => u.parentId === null);
        if (topLevelClass.length !== 1 || topLevelClass[0].name !== nodeName || topLevelClass[0].kind !== 'class') {
            errors.push(`${relativePath}: class frame "${nodeName}" must contain exactly one class definition named "${nodeName}".`);
            return { valid: false, errors, warnings, unit: null };
        }
        if (!tsLang) {
            const classMeta = extractClassFrameMetadata(codeLines);
            if (classMeta.hasMethods) {
                errors.push(`${relativePath}: [CLASS_FRAME_METHOD] Class frame "${nodeName}" cannot embed methods; define methods as owned nodes instead.`);
            }
        }
        return { valid: errors.length === 0, errors, warnings, unit: topLevelClass[0] };
    }

    const parsed = tsLang
        ? parseTsModule(codeText, relativePath.replace(/\.json$/, tsLang === 'javascript' ? '.js' : '.ts'), nodeName)
        : parseModule(codeText, relativePath, nodeName);

    if (!parsed.valid) {
        const label = tsLang ? 'TypeScript/JavaScript' : 'Python';
        errors.push(`${relativePath}: ${label} syntax error: ${parsed.diagnostics.map(d => d.message).join('; ')}`);
        return { valid: false, errors, warnings, unit: null };
    }

    const topLevel = parsed.units.filter(unit => unit.parentId === null);
    if (topLevel.length !== 1 || topLevel[0].name !== nodeName) {
        errors.push(`${relativePath}: code must contain exactly one definition named "${nodeName}" (found ${topLevel.length}: ${topLevel.map(u => u.name).join(', ') || 'none'})`);
        return { valid: false, errors, warnings, unit: null };
    }

    const definition = topLevel[0];
    const isOwnedMethod = typeof node.classOwner === 'string' && node.classOwner.trim().length > 0;
    if (definition.kind !== 'function' && !(isOwnedMethod && definition.kind === 'method')) {
        errors.push(`${relativePath}: atomic unit "${nodeName}" must be a function, but is "${definition.kind}"`);
    }

    if (isOwnedMethod && !tsLang && definition.params) {
        const isStatic = definition.decorators.some(d => d === 'staticmethod' || d.endsWith('.staticmethod'));
        if (!isStatic && (definition.params.length === 0 || (definition.params[0].name !== 'self' && definition.params[0].name !== 'cls'))) {
            errors.push(`${relativePath}: [METHOD_RECEIVER] Owned method "${nodeName}" must accept "self" or "cls" as its first parameter unless decorated with @staticmethod`);
        }
    }

    if (definition.params) {
        definition.params.forEach((param, idx) => {
            if (!tsLang && isMethodReceiverParam(param.name, idx, definition.decorators, isOwnedMethod)) {
                return;
            }
            if (!param.annotation || param.annotation.trim().length === 0) {
                errors.push(`${relativePath}: [STRICT_TYPING] Parameter "${param.name}" in function "${nodeName}" is missing a type annotation`);
            }
        });
    }

    if (!definition.returnAnnotation || definition.returnAnnotation.trim().length === 0) {
        errors.push(`${relativePath}: [STRICT_TYPING] Function "${nodeName}" is missing a return type annotation (-> ReturnType)`);
    }

    if (codeLines.length > 60) {
        errors.push(`${relativePath}: [JPL-60] Function "${nodeName}" exceeds 60 total lines (${codeLines.length} lines > 60). Split or refactor into stubs and a flow.`);
    }

    const executableLines = codeLines.filter(line => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        return tsLang ? !trimmed.startsWith('//') : !trimmed.startsWith('#');
    });
    if (executableLines.length > 60) {
        errors.push(`${relativePath}: [JPL-60] Function "${nodeName}" exceeds 60 executable lines (${executableLines.length} lines > 60). Split or refactor into stubs and a flow.`);
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        unit: definition,
    };
}

function isSupportedLibraryFile(filePath: string, tsMode: boolean): boolean {
    if (tsMode) {
        return /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(filePath);
    }
    return filePath.endsWith('.py');
}

/** Read and index all library documents and files declared in `config.library`. */
export function readProjectLibrary(projectDir: string, config: SlateConfig): LibraryReadResult {
    const documents: Array<{ path: string; units: ParsedUnit[]; valid: boolean }> = [];
    const libraryFiles = new Set<string>();
    const libraryUnits = new Set<string>();
    const tsMode = isTsLikeLanguage(config.language) !== null;

    function visit(relativePath: string): void {
        const fullPath = path.join(projectDir, relativePath);
        if (!fs.existsSync(fullPath)) return;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
                if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'node_modules') continue;
                const childRel = `${relativePath.replace(/\/+$/, '')}/${entry.name}`;
                if (entry.isDirectory() || (entry.isFile() && isSupportedLibraryFile(entry.name, tsMode))) {
                    visit(childRel);
                }
            }
            return;
        }
        if (!isSupportedLibraryFile(relativePath, tsMode)) return;
        const normalizedRel = path.normalize(relativePath).replace(/\\/g, '/');
        libraryFiles.add(normalizedRel);
        const text = fs.readFileSync(fullPath, 'utf8');
        const parsed = tsMode ? parseTsModule(text, relativePath) : parseModule(text, relativePath);
        documents.push({
            path: normalizedRel,
            units: parsed.units,
            valid: parsed.valid,
        });
        for (const unit of parsed.units) {
            libraryUnits.add(unit.name);
        }
    }

    for (const entry of config.library ?? []) {
        visit(entry.replace(/\\/g, '/'));
    }

    return { documents, libraryFiles, libraryUnits };
}

function listJsonFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { recursive: true })
        .map(String)
        .filter(name => name.endsWith('.json'))
        .map(name => name.replace(/\\/g, '/'))
        .sort();
}

const SKIP_PARITY_DIRS = new Set(['tests', 'test', 'vendor', '__pycache__', '.venv', 'venv', 'env', 'node_modules', '.git', 'slate', '.slate']);

function isParityTestFilename(name: string): boolean {
    return name.startsWith('test_')
        || name.endsWith('_test.py')
        || /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(name);
}

/**
 * Scan configured `srcRoots` (not the whole repo) to ensure 100% of defined functions
 * originate from and map to a documented `slate/nodes/`, `slate/flows/`, or `slate.json` library unit.
 */
export function checkProjectParity(projectDir: string, options?: { srcRoots?: string[] }): ParityCheckResult {
    const errors: string[] = [];
    const configPath = path.join(projectDir, 'slate', 'slate.json');
    if (!fs.existsSync(configPath)) {
        return { valid: true, errors: [], documentedUnits: [], scannedFiles: [], srcRoots: [] };
    }

    const config = parseConfig(fs.readFileSync(configPath, 'utf8'));
    const resolvedCi = resolveCiConfig(config, options?.srcRoots ? { srcRoots: options.srcRoots } : undefined);
    const tsMode = isTsLikeLanguage(config.language) !== null;
    const nodesDir = path.join(projectDir, 'slate', 'nodes');
    const flowsDir = path.join(projectDir, 'slate', 'flows');
    const documentedUnits = new Set<string>();
    const parsedNodes = new Map<string, SlateNode>();
    const classFrameMethods = new Map<string, Set<string>>();

    for (const file of listJsonFiles(nodesDir)) {
        try {
            const nodeId = file.slice(0, -'.json'.length);
            const node = parseNode(fs.readFileSync(path.join(nodesDir, file), 'utf8'));
            parsedNodes.set(nodeId, node);
            if (!node.classOwner) {
                documentedUnits.add(node.name);
                documentedUnits.add(nodeId);
            }
            if (node.kind === 'class' && !classFrameMethods.has(node.name)) {
                classFrameMethods.set(node.name, new Set<string>());
            }
        } catch {
            // Node parse errors reported by schema/AST pillars
        }
    }
    for (const [, node] of parsedNodes) {
        if (!node.classOwner) continue;
        const ownerNode = parsedNodes.get(node.classOwner);
        if (ownerNode?.kind === 'class') {
            const methods = classFrameMethods.get(ownerNode.name) ?? new Set<string>();
            methods.add(node.name);
            classFrameMethods.set(ownerNode.name, methods);
        }
    }

    for (const file of listJsonFiles(flowsDir)) {
        try {
            const flow = parseFlow(fs.readFileSync(path.join(flowsDir, file), 'utf8'));
            documentedUnits.add(flow.name);
            documentedUnits.add(file.slice(0, -'.json'.length));
        } catch {
            // Flow parse errors reported by schema pillar
        }
    }

    const { libraryFiles, libraryUnits } = readProjectLibrary(projectDir, config);
    for (const unitName of libraryUnits) {
        documentedUnits.add(unitName);
    }

    const scannedFiles: string[] = [];
    const seenFiles = new Set<string>();

    function collectSourceFiles(dir: string, relativeTo: string): void {
        if (!fs.existsSync(dir)) return;
        const stat = fs.statSync(dir);
        if (stat.isFile()) {
            const normalizedRel = path.normalize(relativeTo).replace(/\\/g, '/');
            if (!isParityTestFilename(path.basename(normalizedRel))
                && !libraryFiles.has(normalizedRel)
                && !seenFiles.has(normalizedRel)) {
                seenFiles.add(normalizedRel);
                scannedFiles.push(normalizedRel);
            }
            return;
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const entryRel = relativeTo ? `${relativeTo}/${entry.name}` : entry.name;
            const normalizedRel = path.normalize(entryRel).replace(/\\/g, '/');
            if (entry.isDirectory()) {
                if (SKIP_PARITY_DIRS.has(entry.name)) continue;
                collectSourceFiles(path.join(dir, entry.name), entryRel);
            } else if (entry.isFile() && isSupportedLibraryFile(entry.name, tsMode)) {
                if (isParityTestFilename(entry.name)) continue;
                if (libraryFiles.has(normalizedRel)) continue;
                if (!seenFiles.has(normalizedRel)) {
                    seenFiles.add(normalizedRel);
                    scannedFiles.push(normalizedRel);
                }
            }
        }
    }

    const shouldScan = Boolean(config.compile || config.ci?.srcRoots || (options?.srcRoots && options.srcRoots.length > 0));
    if (shouldScan) {
        for (const rootRel of resolvedCi.srcRoots) {
            collectSourceFiles(path.resolve(projectDir, rootRel), rootRel);
        }
    }

    for (const relativePath of scannedFiles.sort()) {
        const fullPath = path.resolve(projectDir, relativePath);
        const content = fs.readFileSync(fullPath, 'utf8');
        const parsed = tsMode ? parseTsModule(content, relativePath) : parseModule(content, relativePath);
        if (!parsed.valid) continue;

        for (const unit of parsed.units) {
            if (unit.parentId === null && unit.kind === 'function') {
                if (!documentedUnits.has(unit.name)) {
                    errors.push(
                        `[ROGUE_FUNCTION] Undocumented function "${unit.name}" found at ${relativePath}:${unit.ranges.name.start.line + 1}. Every defined function must originate from and map to a documented slate/nodes/ or slate/flows/ unit.`,
                    );
                }
            } else if (unit.parentId === null && unit.kind === 'class') {
                if (!documentedUnits.has(unit.name)) {
                    errors.push(
                        `[ROGUE_CLASS] Undocumented class "${unit.name}" found at ${relativePath}:${unit.ranges.name.start.line + 1}. Every defined class must originate from and map to a documented slate/nodes/ class frame unit.`,
                    );
                } else {
                    const frameMethods = classFrameMethods.get(unit.name);
                    if (frameMethods && !libraryUnits.has(unit.name)) {
                        for (const member of parsed.units) {
                            if (member.parentId === unit.id && member.kind === 'method' && !frameMethods.has(member.name)) {
                                errors.push(
                                    `[ROGUE_METHOD] Undocumented method "${unit.name}.${member.name}" found at ${relativePath}:${member.ranges.name.start.line + 1}. Every method on class "${unit.name}" must map to an owned node under slate/nodes/.`,
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        documentedUnits: [...documentedUnits],
        scannedFiles,
        srcRoots: resolvedCi.srcRoots,
    };
}

/** Verify compiled output matches committed disk output in `compile.outDir` (default `src`). */
export function checkProjectDrift(projectDir: string): DriftCheckResult {
    const errors: string[] = [];
    const filesChecked: string[] = [];
    const configPath = path.join(projectDir, 'slate', 'slate.json');
    if (!fs.existsSync(configPath)) {
        return { valid: true, errors: [], filesChecked };
    }

    const config = parseConfig(fs.readFileSync(configPath, 'utf8'));
    if (!config.compile) {
        return { valid: true, errors: [], filesChecked };
    }

    const outDirRel = (config.compile.outDir ?? 'src').replace(/\\/g, '/').replace(/\/+$/, '');
    const outDir = path.resolve(projectDir, outDirRel);
    if (!fs.existsSync(outDir)) {
        errors.push(`[COMPILE_DRIFT] Output directory "${outDirRel}" does not exist in project ${projectDir}. Compiled output must be generated and committed.`);
        return { valid: false, errors, filesChecked };
    }

    const nodes = new Map<string, SlateNode>();
    for (const file of listJsonFiles(path.join(projectDir, 'slate', 'nodes'))) {
        const nodeId = file.slice(0, -'.json'.length);
        nodes.set(nodeId, parseNode(fs.readFileSync(path.join(projectDir, 'slate', 'nodes', file), 'utf8')));
    }

    const flows = new Map<string, SlateFlow>();
    for (const file of listJsonFiles(path.join(projectDir, 'slate', 'flows'))) {
        const flowId = file.slice(0, -'.json'.length);
        flows.set(flowId, parseFlow(fs.readFileSync(path.join(projectDir, 'slate', 'flows', file), 'utf8')));
    }

    const library = new Map<string, CallableSignature>();
    const { documents } = readProjectLibrary(projectDir, config);
    for (const doc of documents) {
        for (const unit of doc.units.filter(item => item.parentId === null)) {
            const sig = unitSignature(unit, doc.units);
            if (sig) library.set(`lib:${doc.path}:${unit.name}`, sig);
        }
    }

    const tsMode = isTsLikeLanguage(config.language);
    const result = tsMode
        ? compileProjectForLanguage(nodes, config, flows, library)
        : compilePython(nodes, config, flows, library);

    for (const diag of result.diagnostics) {
        if (diag.severity === 'error') {
            errors.push(`Compile error in ${projectDir}: ${diag.message}`);
        }
    }

    const compiledRelativePaths = new Set<string>();
    for (const [relPath, expectedText] of result.files) {
        compiledRelativePaths.add(relPath);
        const diskFile = path.join(outDir, relPath);
        filesChecked.push(relPath);

        if (!fs.existsSync(diskFile)) {
            errors.push(`[COMPILE_DRIFT] Missing compiled file on disk: ${path.join(outDirRel, relPath)}`);
            continue;
        }

        const diskContent = fs.readFileSync(diskFile, 'utf8').replace(/\r\n/g, '\n');
        const expectedNormalized = expectedText.replace(/\r\n/g, '\n');
        if (diskContent !== expectedNormalized) {
            errors.push(`[COMPILE_DRIFT] File content mismatch in ${path.join(outDirRel, relPath)}. Compile output does not match committed disk file.`);
        }
    }

    if (fs.existsSync(outDir)) {
        const diskFiles = fs.readdirSync(outDir, { recursive: true })
            .map(String)
            .filter(name => (tsMode ? /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(name) : name.endsWith('.py')))
            .map(name => name.replace(/\\/g, '/'));

        for (const diskRel of diskFiles) {
            if (!compiledRelativePaths.has(diskRel)) {
                errors.push(`[COMPILE_DRIFT] Unexpected extra file in ${outDirRel}: ${diskRel}`);
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        filesChecked,
    };
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectTestFilesUnderRoots(projectDir: string, testRoots: readonly string[], tsMode: boolean): string[] {
    const files: string[] = [];
    const seen = new Set<string>();

    function visit(fullPath: string, relPath: string): void {
        if (!fs.existsSync(fullPath)) return;
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
            const base = path.basename(relPath);
            const isTest = tsMode
                ? /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(base)
                : (base.endsWith('.py') && base !== '__init__.py' && base !== 'conftest.py');
            if (isTest && !seen.has(relPath)) {
                seen.add(relPath);
                files.push(relPath);
            }
            return;
        }
        for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'node_modules') continue;
            const childRel = `${relPath}/${entry.name}`;
            visit(path.join(fullPath, entry.name), childRel);
        }
    }

    for (const rootRel of testRoots) {
        visit(path.resolve(projectDir, rootRel), rootRel);
    }
    return files.sort();
}

function extractTestBodyText(content: string, relativePath: string, tsMode: boolean): { hasExecutableTests: boolean; text: string } {
    if (tsMode) {
        const hasTests = /\b(?:test|it)\s*\(/.test(content);
        return { hasExecutableTests: hasTests, text: content };
    }
    const parsed = parseModule(content, relativePath);
    if (parsed.valid) {
        const lines = content.replace(/\r\n?/g, '\n').split('\n');
        const testChunks: string[] = [];
        for (const unit of parsed.units) {
            if (unit.kind === 'function' && unit.name.startsWith('test_')) {
                const start = Math.max(0, unit.ranges.declaration.start.line);
                const end = Math.min(lines.length - 1, unit.ranges.declaration.end.line);
                testChunks.push(lines.slice(start, end + 1).join('\n'));
            }
        }
        return { hasExecutableTests: testChunks.length > 0, text: testChunks.join('\n') };
    }
    const hasPyTests = /^\s*(?:async\s+)?def\s+test_[A-Za-z0-9_]*\s*\(/m.test(content);
    return { hasExecutableTests: hasPyTests, text: content };
}

/**
 * Pillar 4: Verify atomic node test coverage across `node.cases`, `node.check`, and `testRoots`,
 * reporting missing coverage and unmapped test files cleanly.
 */
export function checkProjectTests(
    projectDir: string,
    options?: { testRoots?: string[]; requireTests?: boolean },
): TestPillarResult {
    const configPath = path.join(projectDir, 'slate', 'slate.json');
    if (!fs.existsSync(configPath)) {
        return {
            valid: true,
            errors: [],
            warnings: [],
            testRoots: options?.testRoots ?? ['tests', 'test'],
            requireTests: options?.requireTests === true,
            testFilesScanned: [],
            coveredNodes: [],
            missingNodes: [],
            unmappedTestFiles: [],
        };
    }

    const config = parseConfig(fs.readFileSync(configPath, 'utf8'));
    const resolvedCi = resolveCiConfig(config, options);
    const tsMode = isTsLikeLanguage(config.language) !== null;

    const nodesById = new Map<string, SlateNode>();
    const atomicNodes: Array<{ nodeId: string; node: SlateNode; ownerClassName?: string }> = [];
    const classNames = new Set<string>();
    for (const file of listJsonFiles(path.join(projectDir, 'slate', 'nodes'))) {
        try {
            const nodeId = file.slice(0, -'.json'.length);
            const node = parseNode(fs.readFileSync(path.join(projectDir, 'slate', 'nodes', file), 'utf8'));
            nodesById.set(nodeId, node);
            if (node.kind === 'class') {
                classNames.add(node.name);
            }
        } catch {
            // Node parse errors reported by schema/AST pillars
        }
    }
    for (const [nodeId, node] of nodesById) {
        if (node.kind === 'prelude' || node.kind === 'epilogue' || node.kind === 'class') continue;
        const ownerClassName = node.classOwner ? nodesById.get(node.classOwner)?.name : undefined;
        atomicNodes.push({ nodeId, node, ownerClassName });
    }

    const flowNames = new Set<string>();
    for (const file of listJsonFiles(path.join(projectDir, 'slate', 'flows'))) {
        try {
            const flow = parseFlow(fs.readFileSync(path.join(projectDir, 'slate', 'flows', file), 'utf8'));
            flowNames.add(flow.name);
        } catch {
            // Flow parse errors reported by schema pillar
        }
    }

    const testFilesScanned = collectTestFilesUnderRoots(projectDir, resolvedCi.testRoots, tsMode);
    const parsedTests = testFilesScanned.map(relPath => {
        const content = fs.readFileSync(path.resolve(projectDir, relPath), 'utf8');
        const extracted = extractTestBodyText(content, relPath, tsMode);
        return { relPath, ...extracted };
    });

    const coveredByExternalTests = new Set<string>();
    const unmappedTestFiles: string[] = [];

    for (const testEntry of parsedTests) {
        if (!testEntry.hasExecutableTests) {
            unmappedTestFiles.push(testEntry.relPath);
            continue;
        }
        let mappedAny = false;
        for (const { nodeId, node, ownerClassName } of atomicNodes) {
            const namePattern = new RegExp(`\\b${escapeRegExp(node.name)}\\b`);
            const initMatch = Boolean(
                ownerClassName
                && node.name === '__init__'
                && new RegExp(`\\b${escapeRegExp(ownerClassName)}\\s*\\(`).test(testEntry.text),
            );
            const methodOnClassMatch = Boolean(
                ownerClassName
                && new RegExp(`\\b${escapeRegExp(ownerClassName)}\\b`).test(testEntry.text)
                && (node.name === '__init__' || namePattern.test(testEntry.text)),
            );
            if (namePattern.test(testEntry.text) || initMatch || methodOnClassMatch) {
                coveredByExternalTests.add(nodeId);
                mappedAny = true;
            }
        }
        if (!mappedAny) {
            for (const clsName of classNames) {
                if (new RegExp(`\\b${escapeRegExp(clsName)}\\b`).test(testEntry.text)) {
                    mappedAny = true;
                    break;
                }
            }
        }
        if (!mappedAny) {
            for (const flowName of flowNames) {
                if (new RegExp(`\\b${escapeRegExp(flowName)}\\b`).test(testEntry.text)) {
                    mappedAny = true;
                    break;
                }
            }
        }
        if (!mappedAny) {
            unmappedTestFiles.push(testEntry.relPath);
        }
    }

    const coveredNodes: string[] = [];
    const missingNodes: string[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const { nodeId, node } of atomicNodes) {
        const hasCases = Array.isArray(node.cases) && node.cases.length > 0;
        const hasCheck = Array.isArray(node.check) && node.check.some(line => line.trim().length > 0);
        const hasExternal = coveredByExternalTests.has(nodeId);
        if (hasCases || hasCheck || hasExternal) {
            coveredNodes.push(nodeId);
        } else {
            missingNodes.push(nodeId);
            const msg = `[MISSING_TEST] Atomic node "${nodeId}" (${node.name}) has no node.cases, node.check, or mapped test in ${resolvedCi.testRoots.join(', ')}.`;
            if (resolvedCi.requireTests) {
                errors.push(msg);
            } else {
                warnings.push(msg);
            }
        }
    }

    for (const unmapped of unmappedTestFiles) {
        warnings.push(`[UNMAPPED_TEST] Test file "${unmapped}" does not reference any documented Slate node or flow.`);
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        testRoots: resolvedCi.testRoots,
        requireTests: resolvedCi.requireTests,
        testFilesScanned,
        coveredNodes,
        missingNodes,
        unmappedTestFiles,
    };
}

/**
 * Execute all 4 Slate CI pillars against a project directory:
 * 1. Schema (`slate/nodes/` & `slate/flows/` against `contracts/slate-*.schema.json`)
 * 2. Stub (strict typing, JPL-60 `<= 60` lines, non-empty intent + contract)
 * 3. Code (`srcRoots` parity + compile drift)
 * 4. Test (`testRoots` + `node.cases`/`node.check` coverage)
 */
export function verifyProjectCi(projectDir: string, options?: CiVerifyOptions): CiVerificationReport {
    const resolvedProjectDir = path.resolve(projectDir);
    const configPath = path.join(resolvedProjectDir, 'slate', 'slate.json');
    if (!fs.existsSync(configPath)) {
        throw new Error(`No Slate project found at "${resolvedProjectDir}" (missing slate/slate.json).`);
    }
    const config = parseConfig(fs.readFileSync(configPath, 'utf8'));
    const resolvedCi = resolveCiConfig(config, options);

    const schemaErrors: string[] = [];
    const stubErrors: string[] = [];
    const stubWarnings: string[] = [];
    let nodesCount = 0;
    let flowsCount = 0;
    let atomicNodesCount = 0;

    const nodesDir = path.join(resolvedProjectDir, 'slate', 'nodes');
    const parsedNodeRecords = new Map<string, Record<string, unknown>>();
    for (const file of listJsonFiles(nodesDir)) {
        nodesCount++;
        const nodeId = file.slice(0, -'.json'.length);
        const fullPath = path.join(nodesDir, file);
        let raw: string;
        try {
            raw = fs.readFileSync(fullPath, 'utf8');
        } catch (err) {
            schemaErrors.push(`${file}: read failure: ${err instanceof Error ? err.message : String(err)}`);
            continue;
        }
        let data: Record<string, unknown>;
        try {
            data = JSON.parse(raw) as Record<string, unknown>;
        } catch (err) {
            schemaErrors.push(`${file}: not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
            continue;
        }
        parsedNodeRecords.set(nodeId, data);
        if (data.kind !== 'prelude' && data.kind !== 'epilogue' && data.kind !== 'class') {
            atomicNodesCount++;
        }

        const schemaRes = validateNodeSchema(data, file);
        if (!schemaRes.valid) {
            schemaErrors.push(...schemaRes.errors);
        }

        const astRes = validateNodeAst(data as Partial<SlateNode>, file, config.language);
        if (!astRes.valid) {
            stubErrors.push(...astRes.errors);
        }
        stubWarnings.push(...astRes.warnings);
    }

    for (const [nodeId, data] of parsedNodeRecords) {
        if (typeof data.classOwner === 'string' && data.classOwner.trim()) {
            const ownerId = data.classOwner.trim();
            const ownerRec = parsedNodeRecords.get(ownerId);
            if (!ownerRec || ownerRec.kind !== 'class') {
                stubErrors.push(`${nodeId}.json: [ORPHAN_METHOD] Owned method references missing or non-class-frame classOwner "${ownerId}".`);
            }
        }
    }

    const flowsDir = path.join(resolvedProjectDir, 'slate', 'flows');
    for (const file of listJsonFiles(flowsDir)) {
        flowsCount++;
        const fullPath = path.join(flowsDir, file);
        let data: unknown;
        try {
            data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        } catch (err) {
            schemaErrors.push(`${file}: not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
            continue;
        }
        const schemaRes = validateFlowSchema(data, file);
        if (!schemaRes.valid) {
            schemaErrors.push(...schemaRes.errors);
        }
    }

    const parityRes = checkProjectParity(resolvedProjectDir, { srcRoots: resolvedCi.srcRoots });
    const driftRes = checkProjectDrift(resolvedProjectDir);
    const codeErrors = [...parityRes.errors, ...driftRes.errors];

    const testRes = checkProjectTests(resolvedProjectDir, {
        testRoots: resolvedCi.testRoots,
        requireTests: resolvedCi.requireTests,
    });

    const errors = [...schemaErrors, ...stubErrors, ...codeErrors, ...testRes.errors];
    const warnings = [...stubWarnings, ...testRes.warnings];

    return {
        valid: errors.length === 0,
        projectDir: resolvedProjectDir,
        config: resolvedCi,
        pillars: {
            schema: { valid: schemaErrors.length === 0, errors: schemaErrors },
            stub: { valid: stubErrors.length === 0, errors: stubErrors, warnings: stubWarnings },
            code: {
                valid: codeErrors.length === 0,
                errors: codeErrors,
                parityFilesChecked: parityRes.scannedFiles,
                driftFilesChecked: driftRes.filesChecked,
            },
            test: testRes,
        },
        errors,
        warnings,
        stats: {
            nodesCount,
            flowsCount,
            atomicNodesCount,
            parityFilesChecked: parityRes.scannedFiles.length,
            driftFilesChecked: driftRes.filesChecked.length,
            testFilesScanned: testRes.testFilesScanned.length,
            coveredNodesCount: testRes.coveredNodes.length,
            missingTestsCount: testRes.missingNodes.length,
        },
    };
}

/** Backwards-compatible project validator combining all 4 pillars. */
export function validateProjectContracts(projectDir: string, options?: CiVerifyOptions) {
    const report = verifyProjectCi(projectDir, options);
    return {
        valid: report.valid,
        errors: report.errors,
        warnings: report.warnings,
        nodesCount: report.stats.nodesCount,
        flowsCount: report.stats.flowsCount,
        report,
    };
}

/** Top-level runner verifying either specified directories or default Slate example projects. */
export function verifyAll(projectDirs: string[] = [], options?: CiVerifyOptions) {
    const repoRoot = path.resolve(__dirname, '..', '..');
    let targets = projectDirs;
    if (targets.length === 0) {
        const candidates = [
            path.join(repoRoot, 'examples', 'flow_demo'),
            path.join(repoRoot, 'examples', 'llama_demo'),
        ];
        targets = candidates.filter(dir => fs.existsSync(path.join(dir, 'slate', 'slate.json')));
    }

    const allErrors: string[] = [];
    const allWarnings: string[] = [];
    const reports: CiVerificationReport[] = [];
    let totalNodes = 0;
    let totalFlows = 0;

    for (const target of targets) {
        const report = verifyProjectCi(target, options);
        reports.push(report);
        totalNodes += report.stats.nodesCount;
        totalFlows += report.stats.flowsCount;
        allErrors.push(...report.errors);
        allWarnings.push(...report.warnings);
    }

    return {
        success: allErrors.length === 0,
        errors: allErrors,
        warnings: allWarnings,
        reports,
        stats: {
            projectsCount: targets.length,
            nodesCount: totalNodes,
            flowsCount: totalFlows,
        },
    };
}

/** Format a human-readable 4-pillar CI report for CLI output. */
export function formatCiReportText(report: CiVerificationReport): string {
    const lines: string[] = [];
    const badge = (ok: boolean) => (ok ? 'PASS' : 'FAIL');
    lines.push(`Slate 4-Pillar CI Verification: ${report.valid ? 'PASSED' : 'FAILED'} (${report.projectDir})`);
    lines.push(`  Scope: srcRoots=[${report.config.srcRoots.join(', ')}], testRoots=[${report.config.testRoots.join(', ')}], requireTests=${report.config.requireTests}`);
    lines.push(`  [1/4 Schema] ${badge(report.pillars.schema.valid)} (${report.stats.nodesCount} nodes, ${report.stats.flowsCount} flows)`);
    lines.push(`  [2/4 Stub]   ${badge(report.pillars.stub.valid)} (strict typing, JPL-60 <=60 lines, intent+contract)`);
    lines.push(`  [3/4 Code]   ${badge(report.pillars.code.valid)} (parity files=${report.stats.parityFilesChecked}, drift files=${report.stats.driftFilesChecked})`);
    lines.push(`  [4/4 Test]   ${badge(report.pillars.test.valid)} (covered=${report.stats.coveredNodesCount}/${report.stats.atomicNodesCount}, missing=${report.stats.missingTestsCount}, testFiles=${report.stats.testFilesScanned})`);
    if (report.pillars.test.unmappedTestFiles.length > 0) {
        lines.push(`  Unmapped test files (${report.pillars.test.unmappedTestFiles.length}): ${report.pillars.test.unmappedTestFiles.join(', ')}`);
    }
    if (report.warnings.length > 0) {
        lines.push(`Warnings (${report.warnings.length}):`);
        for (const w of report.warnings) lines.push(`  ! ${w}`);
    }
    if (report.errors.length > 0) {
        lines.push(`Violations (${report.errors.length}):`);
        for (const e of report.errors) lines.push(`  ✗ ${e}`);
    }
    return lines.join('\n');
}
