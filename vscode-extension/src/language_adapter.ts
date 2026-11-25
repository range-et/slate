import { compileArduino, compileCpp } from './compile/cpp';
import { compileCSharp } from './compile/csharp';
import { compileProse } from './compile/prose';
import { compilePython, type CompileResult } from './compile/python';
import { compileTypeScript } from './compile/ts';
import { checkCppNodeCode, createCppStub, parseCppModule, replaceCppUnit } from './cpp_adapter';
import { checkCSharpNodeCode, createCSharpStub, parseCSharpModule, replaceCSharpUnit } from './csharp_adapter';
import type { CallableSignature } from './flow';
import type { ParseModuleResult, SlateFlow, SourceProposal, UnitParam } from './harness_protocol';
import {
    formatGeneratedHeaderForLanguage,
    GENERATED_HASH_HEADER,
    GENERATED_HASH_PREFIX,
    GENERATED_MD_HEADER,
    GENERATED_SLASH_HEADER,
    GENERATED_SLASH_PREFIX,
    GENERATED_TEX_HEADER,
    inferLanguageFromPath,
    isSlateGeneratedContent,
    normalizeCompileOutputPath,
    normalizeLanguage,
    tryNormalizeLanguage,
    type CanonicalLanguage,
    type CheckNodeCodeOptions,
    type CreateStubOptions,
    type LanguageAdapter,
} from './language_types';
import { portArduinoProject, portCppProject } from './port/cpp_importer';
import { portCSharpProject } from './port/csharp_importer';
import { portProseProject } from './port/prose_importer';
import { portPythonProject, type PortReport } from './port/python_importer';
import { portTsProject } from './port/ts_importer';
import { parseProseModule, parseProseNode, verifyProseNode } from './prose_adapter';
import { parseModule, PythonAdapter } from './python_adapter';
import { checkJpl60, codeLines, type Jpl60CheckResult, type SlateConfig, type SlateNode } from './slate_folder';
import { TypeScriptAdapter } from './ts_adapter';

export {
    formatGeneratedHeaderForLanguage,
    GENERATED_HASH_HEADER,
    GENERATED_HASH_PREFIX,
    GENERATED_MD_HEADER,
    GENERATED_SLASH_HEADER,
    GENERATED_SLASH_PREFIX,
    GENERATED_TEX_HEADER,
    inferLanguageFromPath,
    isSlateGeneratedContent,
    normalizeCompileOutputPath,
    normalizeLanguage,
    tryNormalizeLanguage,
    type CanonicalLanguage,
    type CheckNodeCodeOptions,
    type CreateStubOptions,
    type LanguageAdapter,
};

class PythonLanguageAdapter implements LanguageAdapter {
    readonly language = 'python' as const;
    private readonly inner = new PythonAdapter();

    parseModule(source: string, documentPath = '<memory>.py', nodeId?: string): Promise<ParseModuleResult> {
        return this.inner.parseModule(source, documentPath, nodeId);
    }

    replaceUnit(params: Record<string, unknown>): Promise<SourceProposal> {
        return this.inner.replaceUnit(params);
    }

    createStub(
        name: string,
        params: ReadonlyArray<UnitParam | { name: string; annotation?: string | null; default?: string | null; kind?: UnitParam['kind'] }>,
        returnType: string | null,
        kind: 'function' | 'arrow' | 'method' | 'class' | 'component' | 'operator' = 'function',
        options?: CreateStubOptions,
    ): string {
        if (kind === 'class') {
            return `class ${name}:\n    pass\n`;
        }
        const formattedParams = params
            .map(p => {
                const ann = p.annotation?.trim() ? `: ${p.annotation.trim()}` : '';
                const def = p.default?.trim() ? ` = ${p.default.trim()}` : '';
                return `${p.name}${ann}${def}`;
            })
            .join(', ');
        const ret = returnType?.trim() ? ` -> ${returnType.trim()}` : '';
        const prefix = options?.async ? 'async def' : 'def';
        return `${prefix} ${name}(${formattedParams})${ret}:\n    raise NotImplementedError\n`;
    }

    checkNodeCode(
        code: string | readonly string[],
        expectedName: string,
        options?: CheckNodeCodeOptions,
    ): Jpl60CheckResult {
        const lines = typeof code === 'string' ? codeLines(code) : [...code];
        const syntheticNode: SlateNode = {
            name: expectedName,
            language: 'python',
            intent: '',
            contract: options?.contract ?? 'contract',
            context: [],
            examples: [],
            locked: false,
            imports: [],
            uses: [],
            code: lines,
            extra: {},
        };
        return checkJpl60(syntheticNode, lines.join('\n'));
    }

    formatGeneratedHeader(path?: string): string {
        return formatGeneratedHeaderForLanguage(path ?? 'python');
    }

    isGeneratedFile(content: string): boolean {
        return isSlateGeneratedContent(content);
    }

    dispose(): void {
        this.inner.dispose();
    }
}

class CSharpLanguageAdapter implements LanguageAdapter {
    readonly language = 'csharp' as const;

    parseModule(source: string, documentPath = '<memory>.cs', nodeId?: string): ParseModuleResult {
        return parseCSharpModule(source, documentPath, nodeId);
    }

    replaceUnit(params: Record<string, unknown>): SourceProposal {
        return replaceCSharpUnit(params);
    }

    createStub(
        name: string,
        params: ReadonlyArray<UnitParam | { name: string; annotation?: string | null; default?: string | null; kind?: UnitParam['kind'] }>,
        returnType: string | null,
        kind: 'function' | 'arrow' | 'method' | 'class' | 'component' | 'operator' = 'method',
        options?: CreateStubOptions,
    ): string {
        if (kind === 'class') {
            const visibility = options?.visibility ?? 'public';
            return `${visibility} class ${name}\n{\n}\n`;
        }
        return createCSharpStub(name, params, returnType, {
            visibility: options?.visibility ?? 'public',
            isStatic: options?.static ?? true,
            async: options?.async ?? false,
        });
    }

    checkNodeCode(
        code: string | readonly string[],
        expectedName: string,
        options?: CheckNodeCodeOptions,
    ): Jpl60CheckResult {
        return checkCSharpNodeCode(
            typeof code === 'string' ? code : [...code],
            expectedName,
            {
                enforceJpl60: options?.enforceJpl60,
                contract: options?.contract,
                requireContract: options?.contract !== undefined,
            },
        );
    }

    formatGeneratedHeader(path?: string): string {
        return formatGeneratedHeaderForLanguage(path ?? 'csharp');
    }

    isGeneratedFile(content: string): boolean {
        return isSlateGeneratedContent(content);
    }

    dispose(): void {}
}

class CppLanguageAdapter implements LanguageAdapter {
    readonly language: 'cpp' | 'arduino';

    constructor(language: 'cpp' | 'arduino' = 'cpp') {
        this.language = language;
    }

    parseModule(source: string, documentPath = '<memory>.cpp', nodeId?: string): ParseModuleResult {
        return parseCppModule(source, documentPath, nodeId);
    }

    replaceUnit(params: Record<string, unknown>): SourceProposal {
        return replaceCppUnit(params);
    }

    createStub(
        name: string,
        params: ReadonlyArray<UnitParam | { name: string; annotation?: string | null; default?: string | null; kind?: UnitParam['kind'] }>,
        returnType: string | null,
        kind: 'function' | 'arrow' | 'method' | 'class' | 'component' | 'operator' = 'function',
    ): string {
        const unitParams: UnitParam[] = params.map(p => ({
            name: p.name,
            annotation: p.annotation ?? null,
            default: p.default ?? null,
            kind: p.kind ?? 'keyword',
        }));
        return createCppStub(name, unitParams, returnType, kind === 'class' ? 'class' : 'function');
    }

    checkNodeCode(
        code: string | readonly string[],
        expectedName: string,
        options?: CheckNodeCodeOptions,
    ): Jpl60CheckResult {
        const text = typeof code === 'string' ? code : code.join('\n');
        return checkCppNodeCode(text, expectedName, {
            strictTypes: options?.strictTypes,
            enforceJpl60: options?.enforceJpl60,
            contract: options?.contract,
            requireContract: options?.contract !== undefined,
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

class ProseLanguageAdapter implements LanguageAdapter {
    readonly language = 'prose' as const;

    parseModule(source: string, documentPath = '<memory>.md', nodeId?: string): ParseModuleResult {
        const lines = codeLines(source);
        const name = (nodeId ?? documentPath.replace(/\.(?:md|tex)$/i, '')).split('/').pop() || 'passage';
        const node: SlateNode = {
            name,
            language: 'prose',
            intent: '',
            contract: '',
            context: [],
            examples: [],
            locked: false,
            imports: [],
            uses: [],
            code: lines,
            extra: {},
        };
        return parseProseModule(source, documentPath, nodeId ?? name, node);
    }

    replaceUnit(params: Record<string, unknown>): SourceProposal {
        const replacement = typeof params.replacement === 'string' ? params.replacement : '';
        const rawExpected = typeof params.expectedHash === 'string' ? params.expectedHash : '';
        const baseSourceHash: `sha256:${string}` = rawExpected.startsWith('sha256:')
            ? (rawExpected as `sha256:${string}`)
            : 'sha256:prose-base';
        return {
            baseSourceHash,
            proposedSourceHash: 'sha256:prose-replaced',
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: replacement }],
            proposedSource: replacement,
            parsed: this.parseModule(replacement, String(params.path ?? '<memory>.md')),
        };
    }

    createStub(
        name: string,
        params: ReadonlyArray<UnitParam | { name: string; annotation?: string | null; default?: string | null; kind?: UnitParam['kind'] }>,
        returnType: string | null,
    ): string {
        const formattedParams = params
            .map(p => `${p.name}: ${p.annotation?.trim() || 'passage'}`)
            .join(', ');
        const ret = returnType?.trim() || 'passage';
        return `operator ${name}(${formattedParams}) -> ${ret}:\n    `;
    }

    checkNodeCode(
        code: string | readonly string[],
        expectedName: string,
        options?: CheckNodeCodeOptions,
    ): Jpl60CheckResult {
        const lines = typeof code === 'string' ? codeLines(code) : [...code];
        const node: SlateNode = {
            name: expectedName,
            language: 'prose',
            intent: '',
            contract: options?.contract ?? '',
            context: [],
            examples: [],
            locked: false,
            imports: [],
            uses: [],
            code: lines,
            extra: {},
        };
        const verified = verifyProseNode(node, { nodeId: expectedName });
        return {
            valid: verified.valid,
            lineCount: lines.length,
            executableLines: lines.filter(l => l.trim().length > 0).length,
            diagnostics: verified.diagnostics
                .filter(d => d.severity === 'error')
                .map(d => ({ code: d.code, message: d.message })),
        };
    }

    formatGeneratedHeader(path?: string): string {
        return formatGeneratedHeaderForLanguage(path ?? 'prose');
    }

    isGeneratedFile(content: string): boolean {
        return isSlateGeneratedContent(content);
    }

    dispose(): void {}
}

/**
 * Resolve a `LanguageAdapter` instance for any supported Slate language or file path.
 */
export function getLanguageAdapter(languageOrPath: string): LanguageAdapter {
    const lang = inferLanguageFromPath(languageOrPath) ?? normalizeLanguage(languageOrPath);
    switch (lang) {
        case 'python':
            return new PythonLanguageAdapter();
        case 'typescript':
        case 'javascript':
            return new TypeScriptAdapter(lang);
        case 'csharp':
            return new CSharpLanguageAdapter();
        case 'cpp':
        case 'arduino':
            return new CppLanguageAdapter(lang);
        case 'prose':
            return new ProseLanguageAdapter();
    }
}

/**
 * Detect the dominant canonical language from a map/record of project source files.
 */
export function detectProjectLanguage(
    files: ReadonlyMap<string, string> | Record<string, string>,
    fallback: CanonicalLanguage = 'python',
): CanonicalLanguage {
    const keys = files instanceof Map ? [...files.keys()] : Object.keys(files);
    const counts = new Map<CanonicalLanguage, number>();
    for (const key of keys) {
        const lang = inferLanguageFromPath(key);
        if (lang) {
            counts.set(lang, (counts.get(lang) ?? 0) + 1);
        }
    }
    if (counts.has('arduino')) return 'arduino';
    let best: CanonicalLanguage = fallback;
    let bestCount = 0;
    for (const [lang, count] of counts) {
        if (count > bestCount) {
            best = lang;
            bestCount = count;
        }
    }
    return best;
}

/**
 * Unified multi-language project importer dispatching across Python, TypeScript/JavaScript,
 * C#, C++/Arduino, and Markdown/LaTeX Prose.
 */
export function portProjectForLanguage(
    files: ReadonlyMap<string, string> | Record<string, string>,
    language?: string,
): {
    language: CanonicalLanguage;
    nodes: Map<string, SlateNode>;
    report: PortReport;
    config?: SlateConfig;
    flows?: Map<string, SlateFlow>;
} {
    const canonical = language
        ? normalizeLanguage(language)
        : detectProjectLanguage(files);
    const mapFiles = files instanceof Map
        ? new Map(files)
        : new Map(Object.entries(files));

    switch (canonical) {
        case 'python': {
            const res = portPythonProject(mapFiles);
            return { language: 'python', nodes: res.nodes, report: res.report };
        }
        case 'typescript':
        case 'javascript': {
            const res = portTsProject(mapFiles, canonical);
            return { language: canonical, nodes: res.nodes, report: res.report };
        }
        case 'csharp': {
            const res = portCSharpProject(mapFiles);
            return { language: 'csharp', nodes: res.nodes, report: res.report };
        }
        case 'cpp': {
            const res = portCppProject(mapFiles, 'cpp');
            return { language: 'cpp', nodes: res.nodes, report: res.report, config: res.config };
        }
        case 'arduino': {
            const res = portArduinoProject(mapFiles);
            return { language: 'arduino', nodes: res.nodes, report: res.report, config: res.config };
        }
        case 'prose': {
            const res = portProseProject(mapFiles);
            return {
                language: 'prose',
                nodes: res.nodes,
                report: res.report,
                config: res.config,
                flows: res.flows,
            };
        }
    }
}

/**
 * Unified multi-language project compiler dispatching across Python, TypeScript/JavaScript,
 * C#, C++/Arduino, and Prose (`.md`/`.tex`).
 */
export function compileProjectForLanguage(
    nodes: ReadonlyMap<string, SlateNode>,
    config: SlateConfig,
    flows: ReadonlyMap<string, SlateFlow> = new Map(),
    library: ReadonlyMap<string, CallableSignature> = new Map(),
    existingFiles?: ReadonlyMap<string, string> | Record<string, string>,
): CompileResult {
    const canonical = tryNormalizeLanguage(config.language) ?? 'python';
    switch (canonical) {
        case 'python':
            return compilePython(nodes, config, flows, library, { existingFiles });
        case 'typescript':
        case 'javascript':
            return compileTypeScript(nodes, config, flows, library, existingFiles);
        case 'csharp':
            return compileCSharp(nodes, config, flows, library, { existingFiles });
        case 'cpp':
            return compileCpp(nodes, config, flows, library, { existingFiles });
        case 'arduino':
            return compileArduino(nodes, config, flows, library, { existingFiles });
        case 'prose':
            return compileProse(nodes, config, flows, undefined, { existingFiles });
    }
}

