import { describe, expect, it } from 'vitest';

import {
    formatGeneratedHeaderForLanguage,
    GENERATED_HASH_HEADER,
    GENERATED_MD_HEADER,
    GENERATED_SLASH_HEADER,
    GENERATED_TEX_HEADER,
    inferLanguageFromPath,
    isSlateGeneratedContent,
    normalizeCompileOutputPath,
    normalizeLanguage,
    tryNormalizeLanguage,
} from '../vscode-extension/src/language_adapter';
import {
    AdapterError,
    checkTsNodeCode,
    createTsStub,
    parseTsModule,
    replaceTsUnit,
    splitTsImport,
    tsIdentifierNames,
    tsTopLevelBindings,
    TypeScriptAdapter,
} from '../vscode-extension/src/ts_adapter';
import { portTsProject } from '../vscode-extension/src/port/ts_importer';
import { compileTypeScript, compileValueToTs, flowToTsNode, TS_GENERATED_HEADER, tsNodeSignature } from '../vscode-extension/src/compile/ts';
import type { SlateFlow } from '../vscode-extension/src/harness_protocol';
import type { SlateConfig, SlateNode } from '../vscode-extension/src/slate_folder';

function makeNode(fields: Partial<SlateNode> & { name: string; code: string[] }): SlateNode {
    return {
        intent: '',
        contract: '',
        context: [],
        examples: [],
        locked: false,
        imports: [],
        uses: [],
        extra: {},
        ...fields,
    };
}

describe('Unified LanguageAdapter & normalizeLanguage', () => {
    it.each([
        ['py', 'python'],
        ['python', 'python'],
        ['.py', 'python'],
        ['ts', 'typescript'],
        ['tsx', 'typescript'],
        ['typescript', 'typescript'],
        ['.tsx', 'typescript'],
        ['js', 'javascript'],
        ['jsx', 'javascript'],
        ['javascript', 'javascript'],
        ['cs', 'csharp'],
        ['c#', 'csharp'],
        ['csharp', 'csharp'],
        ['cpp', 'cpp'],
        ['c++', 'cpp'],
        ['ino', 'arduino'],
        ['arduino', 'arduino'],
        ['md', 'prose'],
        ['markdown', 'prose'],
        ['prose', 'prose'],
    ] as const)('normalizes %s to %s', (input, expected) => {
        expect(normalizeLanguage(input)).toBe(expected);
        expect(tryNormalizeLanguage(input)).toBe(expected);
    });

    it('rejects unsupported language strings and handles tryNormalizeLanguage / inferLanguageFromPath', () => {
        expect(() => normalizeLanguage('cobol')).toThrow(/Unsupported language "cobol"/);
        expect(tryNormalizeLanguage('cobol')).toBeNull();
        expect(tryNormalizeLanguage(null)).toBeNull();
        expect(tryNormalizeLanguage('')).toBeNull();

        expect(inferLanguageFromPath('src/components/Button.tsx')).toBe('typescript');
        expect(inferLanguageFromPath('src/utils/math.js')).toBe('javascript');
        expect(inferLanguageFromPath('src/App.cs')).toBe('csharp');
        expect(inferLanguageFromPath('firmware/blink.ino')).toBe('arduino');
        expect(inferLanguageFromPath('src/engine.cpp')).toBe('cpp');
        expect(inferLanguageFromPath('docs/grant.md')).toBe('prose');
        expect(inferLanguageFromPath('Makefile')).toBeNull();
    });

    it('formats generated headers and detects generated file markers across languages', () => {
        expect(formatGeneratedHeaderForLanguage('typescript')).toBe(GENERATED_SLASH_HEADER);
        expect(formatGeneratedHeaderForLanguage('src/index.ts', 'slate/nodes/')).toContain(GENERATED_SLASH_HEADER);
        expect(formatGeneratedHeaderForLanguage('python')).toBe(GENERATED_HASH_HEADER);
        expect(formatGeneratedHeaderForLanguage('paper.md')).toBe(GENERATED_MD_HEADER);
        expect(formatGeneratedHeaderForLanguage('paper.tex')).toBe(GENERATED_TEX_HEADER);

        expect(isSlateGeneratedContent(`${GENERATED_SLASH_HEADER}\nexport const x = 1;\n`)).toBe(true);
        expect(isSlateGeneratedContent(`${GENERATED_HASH_HEADER}\nx = 1\n`)).toBe(true);
        expect(isSlateGeneratedContent(`${GENERATED_MD_HEADER}\n# Title\n`)).toBe(true);
        expect(isSlateGeneratedContent(`${GENERATED_TEX_HEADER}\n\\section{Intro}\n`)).toBe(true);
        expect(isSlateGeneratedContent('export function handWritten() { return 1; }\n')).toBe(false);
    });
});

describe('TypeScript & JavaScript Adapter (ts_adapter.ts)', () => {
    it('parses functions, arrow functions, classes, interfaces, type aliases, and async declarations with durable nodeIds', () => {
        const source = [
            'export interface User {',
            '    id: string;',
            '    score: number;',
            '}',
            '',
            'export type ScoreMap = Record<string, number>;',
            '',
            'export async function fetchScore(userId: string, retries: number = 3): Promise<number> {',
            '    const normalize = (raw: number): number => raw * 2;',
            '    return normalize(retries);',
            '}',
            '',
            'export const computeBonus = (base: number, multiplier: number = 1.5): number => {',
            '    return base * multiplier;',
            '};',
            '',
            'export class ScoreService {',
            '    constructor(public prefix: string) {}',
            '    format(user: User): string {',
            '        return `${this.prefix}:${user.id}`;',
            '    }',
            '}',
            '',
        ].join('\n');

        const parsed = parseTsModule(source, 'src/score.ts', 'pkg/fetchScore');
        expect(parsed.valid).toBe(true);
        expect(parsed.units.map(u => [u.kind, u.qualifiedName, u.identity])).toEqual([
            ['class', 'User', 'provisional'],
            ['class', 'ScoreMap', 'provisional'],
            ['function', 'fetchScore', 'durable'],
            ['nested_function', 'fetchScore.normalize', 'provisional'],
            ['function', 'computeBonus', 'provisional'],
            ['class', 'ScoreService', 'provisional'],
            ['method', 'ScoreService.__init__', 'provisional'],
            ['method', 'ScoreService.format', 'provisional'],
        ]);

        const fetchUnit = parsed.units.find(u => u.name === 'fetchScore')!;
        expect(fetchUnit.id).toBe('pkg/fetchScore');
        expect(fetchUnit.async).toBe(true);
        expect(fetchUnit.returnAnnotation).toBe('Promise<number>');
        expect(fetchUnit.params).toEqual([
            { name: 'userId', annotation: 'string', default: null, kind: 'keyword' },
            { name: 'retries', annotation: 'number', default: '3', kind: 'keyword' },
        ]);

        const arrowUnit = parsed.units.find(u => u.name === 'computeBonus')!;
        expect(arrowUnit.params).toEqual([
            { name: 'base', annotation: 'number', default: null, kind: 'keyword' },
            { name: 'multiplier', annotation: 'number', default: '1.5', kind: 'keyword' },
        ]);
        expect(arrowUnit.returnAnnotation).toBe('number');
    });

    it('parses React .tsx components and infers JSX.Element return annotation when omitted', () => {
        const tsxSource = [
            'export interface BadgeProps { label: string; count?: number }',
            'export function Badge(props: BadgeProps) {',
            '    return <span className="badge">{props.label}: {props.count ?? 0}</span>;',
            '}',
            'export const IconBadge = (title: string): JSX.Element => <div title={title}><Badge label={title} /></div>;',
        ].join('\n');

        const parsed = parseTsModule(tsxSource, 'components/Badge.tsx', 'components/Badge');
        expect(parsed.valid).toBe(true);
        const badge = parsed.units.find(u => u.name === 'Badge')!;
        expect(badge.id).toBe('components/Badge');
        expect(badge.returnAnnotation).toBe('JSX.Element');

        const iconBadge = parsed.units.find(u => u.name === 'IconBadge')!;
        expect(iconBadge.returnAnnotation).toBe('JSX.Element');

        const ids = tsIdentifierNames(tsxSource, 'components/Badge.tsx');
        expect(ids.has('Badge')).toBe(true);
        expect(ids.has('BadgeProps')).toBe(true);
    });

    it('returns syntax diagnostics on invalid TypeScript/JavaScript', () => {
        const broken = parseTsModule('export function broken(a: number { return a; }', 'broken.ts');
        expect(broken.valid).toBe(false);
        expect(broken.units).toEqual([]);
        expect(broken.diagnostics[0].code).toBe('ts-syntax');
    });

    it('splits ES imports and extracts top-level bindings accurately', () => {
        expect(splitTsImport('import React, { useState, useEffect as useEff } from "react";')).toEqual([
            { line: 'import React from "react";', binding: 'React', module: 'react', name: 'default' },
            { line: 'import { useState } from "react";', binding: 'useState', module: 'react', name: 'useState' },
            { line: 'import { useEffect as useEff } from "react";', binding: 'useEff', module: 'react', name: 'useEffect' },
        ]);

        expect(splitTsImport('import type { Foo } from "./types";')).toEqual([
            { line: 'import type { Foo } from "./types";', binding: 'Foo', module: './types', name: 'Foo', isTypeOnly: true },
        ]);

        expect(splitTsImport('import * as path from "node:path";')).toEqual([
            { line: 'import * as path from "node:path";', binding: 'path', module: 'node:path', name: '*' },
        ]);

        expect(splitTsImport('import "./styles.css";')).toEqual([
            { line: 'import "./styles.css";', binding: null, module: './styles.css', name: null },
        ]);

        const bindings = tsTopLevelBindings([
            'import { helper } from "./helper";',
            'export const LIMIT = 100, { a, b } = { a: 1, b: 2 };',
            'export function calc(x: number): number { return x + LIMIT; }',
            'export interface Config { debug: boolean }',
        ].join('\n'));
        expect([...bindings].sort()).toEqual(['Config', 'LIMIT', 'a', 'b', 'calc', 'helper']);
    });

    it('replaces functions, arrow functions, and methods while enforcing signature preservation and fresh hashes', () => {
        const adapter = new TypeScriptAdapter('typescript');
        const source = [
            '// Prefix comment',
            'export function clamp(val: number, low: number = 0, high: number = 10): number {',
            '    return val;',
            '}',
            '',
        ].join('\n');
        const parsed = adapter.parseModule(source, 'clamp.ts', 'clamp');
        const proposal = adapter.replaceUnit({
            source,
            path: 'clamp.ts',
            nodeId: 'clamp',
            expectedHash: parsed.sourceHash,
            unitId: 'clamp',
            replacement: [
                'export function clamp(val: number, low: number = 0, high: number = 10): number {',
                '    return Math.min(high, Math.max(low, val));',
                '}',
            ].join('\n'),
        });
        expect(proposal.proposedSource).toContain('Math.min(high, Math.max(low, val))');
        expect(proposal.proposedSource.startsWith('// Prefix comment\n')).toBe(true);

        // Stale hash rejected
        expect(() =>
            replaceTsUnit({
                source,
                path: 'clamp.ts',
                nodeId: 'clamp',
                expectedHash: 'sha256:stale',
                unitId: 'clamp',
                replacement: 'export function clamp(val: number, low: number = 0, high: number = 10): number { return 0; }',
            }),
        ).toThrow(AdapterError);

        // Changed signature rejected
        expect(() =>
            replaceTsUnit({
                source,
                path: 'clamp.ts',
                nodeId: 'clamp',
                expectedHash: parsed.sourceHash,
                unitId: 'clamp',
                replacement: 'export function clamp(val: string): string { return val; }',
            }),
        ).toThrow(/preserve the function name and signature/);

        // Method replacement inside a class
        const classSrc = [
            'export class Calculator {',
            '    add(a: number, b: number): number {',
            '        return a;',
            '    }',
            '}',
        ].join('\n');
        const parsedClass = adapter.parseModule(classSrc, 'calc.ts');
        const methodUnit = parsedClass.units.find(u => u.qualifiedName === 'Calculator.add')!;
        const methodProp = adapter.replaceUnit({
            source: classSrc,
            path: 'calc.ts',
            expectedHash: parsedClass.sourceHash,
            unitId: methodUnit.id,
            replacement: 'add(a: number, b: number): number {\n    return a + b;\n}',
        });
        expect(methodProp.proposedSource).toContain('return a + b;');
    });

    it('creates stubs and validates JPL-60 line limits and strict TypeScript annotations', () => {
        const fnStub = createTsStub(
            'calculateTax',
            [
                { name: 'amount', annotation: 'number', default: null, kind: 'keyword' },
                { name: 'rate', annotation: 'number', default: '0.2', kind: 'keyword' },
            ],
            'number',
            'function',
        );
        expect(fnStub).toBe(
            'export function calculateTax(amount: number, rate: number = 0.2): number {\n    throw new Error("Not implemented: calculateTax");\n}',
        );
        expect(checkTsNodeCode(fnStub, 'calculateTax', { strictTypes: true }).valid).toBe(true);

        const arrowStub = createTsStub(
            'doubleVal',
            [{ name: 'x', annotation: 'number', default: null, kind: 'keyword' }],
            'number',
            'arrow',
        );
        expect(arrowStub).toContain('export const doubleVal = (x: number): number =>');
        expect(checkTsNodeCode(arrowStub, 'doubleVal', { strictTypes: true }).valid).toBe(true);

        // Untyped parameter & return fails strictTypes in TS, passes in JS mode
        const untypedCode = 'export function add(a, b) {\n    return a + b;\n}';
        const tsCheck = checkTsNodeCode(untypedCode, 'add', { strictTypes: true, language: 'typescript' });
        expect(tsCheck.valid).toBe(false);
        expect(tsCheck.diagnostics.map(d => d.code)).toContain('jpl60-param-annotation');
        expect(tsCheck.diagnostics.map(d => d.code)).toContain('jpl60-return-annotation');

        const jsCheck = checkTsNodeCode(untypedCode, 'add', { language: 'javascript' });
        expect(jsCheck.valid).toBe(true);

        // Exceeding 60 lines triggers jpl60-line-count
        const bodyLines = Array.from({ length: 61 }, (_, i) => `    const v${i} = ${i};`);
        const oversized = [
            'export function huge(x: number): number {',
            ...bodyLines,
            '    return x;',
            '}',
        ].join('\n');
        const jplOver = checkTsNodeCode(oversized, 'huge', { strictTypes: true });
        expect(jplOver.valid).toBe(false);
        expect(jplOver.lineCount).toBe(64);
        expect(jplOver.diagnostics[0].code).toBe('jpl60-line-count');
    });
});

describe('TypeScript/JavaScript Importer & Compiler Round-Trips', () => {
    it('ports a multi-file .ts and .tsx project and compiles it back with preserved extensions and headers', () => {
        const inputFiles: Record<string, string> = {
            'utils/math.ts': [
                'export const MAX_VALUE = 1000;',
                '',
                'export function clamp(val: number, min: number, max: number = MAX_VALUE): number {',
                '    return Math.min(max, Math.max(min, val));',
                '}',
                '',
                'export const scale = (val: number, factor: number): number => {',
                '    return clamp(val * factor, 0, MAX_VALUE);',
                '};',
            ].join('\n'),
            'components/Meter.tsx': [
                'import React from "react";',
                'import { scale, MAX_VALUE } from "../utils/math";',
                '',
                'export interface MeterProps {',
                '    value: number;',
                '    factor: number;',
                '}',
                '',
                'export function Meter(props: MeterProps): JSX.Element {',
                '    const scaled = scale(props.value, props.factor);',
                '    return <div data-max={MAX_VALUE}>{scaled}</div>;',
                '}',
                '',
                'console.log("Meter module loaded", Meter);',
            ].join('\n'),
        };

        const { nodes, report } = portTsProject(inputFiles, 'typescript');
        expect(report.warnings).toEqual([]);
        expect(report.modules).toEqual(['components/Meter.tsx', 'utils/math.ts']);
        expect(report.preludes).toBe(1);
        expect(report.epilogues).toBe(1);

        expect([...nodes.keys()].sort()).toEqual([
            'components/Meter/Meter',
            'components/Meter/MeterProps',
            'components/Meter/_epilogue',
            'utils/math/_prelude',
            'utils/math/clamp',
            'utils/math/scale',
        ]);

        const meterNode = nodes.get('components/Meter/Meter')!;
        expect(meterNode.extra.modulePath).toBe('components/Meter.tsx');
        expect(meterNode.extra.extension).toBe('.tsx');
        expect(meterNode.uses).toEqual([
            'components/Meter/MeterProps',
            'utils/math/_prelude',
            'utils/math/scale',
        ]);

        const scaleNode = nodes.get('utils/math/scale')!;
        expect(scaleNode.extra.modulePath).toBe('utils/math.ts');
        expect(scaleNode.extra.extension).toBe('.ts');
        expect(scaleNode.uses).toEqual(['utils/math/_prelude', 'utils/math/clamp']);

        // Compile back to TypeScript
        const config: SlateConfig = { slate: 3, name: 'dashboard', language: 'typescript' };
        const compiled = compileTypeScript(nodes, config);
        expect(compiled.diagnostics).toEqual([]);
        expect([...compiled.files.keys()]).toEqual(['components/Meter.tsx', 'utils/math.ts']);

        const compiledMath = compiled.files.get('utils/math.ts')!;
        expect(compiledMath.startsWith(TS_GENERATED_HEADER)).toBe(true);
        expect(compiledMath).toContain('export const MAX_VALUE = 1000;');
        expect(compiledMath).toContain('export function clamp(');
        expect(compiledMath).toContain('export const scale =');

        const compiledMeter = compiled.files.get('components/Meter.tsx')!;
        expect(compiledMeter.startsWith(TS_GENERATED_HEADER)).toBe(true);
        expect(compiledMeter).toContain('import { MAX_VALUE, scale } from "../utils/math";');
        expect(compiledMeter).toContain('export function Meter(props: MeterProps): JSX.Element');
        expect(compiledMeter).toContain('console.log("Meter module loaded", Meter);');
    });

    it('ports and compiles JavaScript (.js / .jsx) files accurately', () => {
        const jsFiles: Record<string, string> = {
            'helpers/format.js': [
                'export function formatCurrency(amount) {',
                '    return "$" + amount.toFixed(2);',
                '}',
            ].join('\n'),
            'views/PriceTag.jsx': [
                'import { formatCurrency } from "../helpers/format.js";',
                'export function PriceTag(props) {',
                '    return <span className="price">{formatCurrency(props.amount)}</span>;',
                '}',
            ].join('\n'),
        };

        const { nodes, report } = portTsProject(jsFiles, 'javascript');
        expect(report.warnings).toEqual([]);
        expect(nodes.get('views/PriceTag/PriceTag')?.extra.extension).toBe('.jsx');
        expect(nodes.get('views/PriceTag/PriceTag')?.uses).toEqual(['helpers/format/formatCurrency']);

        const compiled = compileTypeScript(nodes, { slate: 3, name: 'shop', language: 'javascript' });
        expect(compiled.diagnostics).toEqual([]);
        expect([...compiled.files.keys()]).toEqual(['helpers/format.js', 'views/PriceTag.jsx']);
        expect(compiled.files.get('views/PriceTag.jsx')).toContain('import { formatCurrency } from "../helpers/format";');
    });

    it('compiles wired SlateFlows with branch, foreach, and repeat regions into valid TypeScript', () => {
        const nodes = new Map<string, SlateNode>([
            [
                'math/doubleItem',
                makeNode({
                    name: 'doubleItem',
                    language: 'typescript',
                    code: ['export function doubleItem(item: number, index: number = 0): number {', '    return item * 2 + index;', '}'],
                }),
            ],
            [
                'math/sumList',
                makeNode({
                    name: 'sumList',
                    language: 'typescript',
                    code: ['export function sumList(items: number[]): number {', '    return items.reduce((a, b) => a + b, 0);', '}'],
                }),
            ],
            [
                'math/fallbackZero',
                makeNode({
                    name: 'fallbackZero',
                    language: 'typescript',
                    code: ['export function fallbackZero(items: number[]): number {', '    return 0;', '}'],
                }),
            ],
            [
                'math/stepIncrement',
                makeNode({
                    name: 'stepIncrement',
                    language: 'typescript',
                    code: ['export function stepIncrement(acc: number, delta: number): number {', '    return acc + delta;', '}'],
                }),
            ],
        ]);

        const mainFlow: SlateFlow = {
            name: 'processPipeline',
            inputs: [
                { name: 'rawItems', annotation: 'number[]' },
                { name: 'enabled', annotation: 'boolean' },
            ],
            outputs: [{ name: 'finalScore', annotation: 'number' }],
            instances: [
                { id: 'stepDelta', kind: 'value', value: 5 },
            ],
            regions: [
                {
                    id: 'mapItems',
                    kind: 'foreach',
                    bodyFlow: 'math/doubleItem',
                    collectionPort: 'items',
                    itemPort: 'item',
                    indexPort: 'index',
                    maxIterations: 10,
                },
                {
                    id: 'chooseTotal',
                    kind: 'branch',
                    conditionPort: 'condition',
                    thenFlow: 'math/sumList',
                    elseFlow: 'math/fallbackZero',
                },
                {
                    id: 'refineTotal',
                    kind: 'repeat',
                    bodyFlow: 'math/stepIncrement',
                    maxIterations: 3,
                    statePorts: ['acc'],
                },
            ],
            wires: [
                { from: 'input:rawItems', to: 'mapItems.in:items' },
                { from: 'input:enabled', to: 'chooseTotal.in:condition' },
                { from: 'mapItems.out', to: 'chooseTotal.in:items' },
                { from: 'chooseTotal.out', to: 'refineTotal.in:acc' },
                { from: 'stepDelta.out', to: 'refineTotal.in:delta' },
                { from: 'refineTotal.out', to: 'output:finalScore' },
            ],
            extra: {},
        };

        const flows = new Map<string, SlateFlow>([['main', mainFlow]]);
        const compiled = compileTypeScript(nodes, { slate: 3, name: 'pipeline', language: 'typescript' }, flows);
        expect(compiled.diagnostics).toEqual([]);

        const rootCode = compiled.files.get('pipeline.ts')!;
        expect(rootCode.startsWith(TS_GENERATED_HEADER)).toBe(true);
        expect(rootCode).toContain('export function processPipeline(rawItems: number[], enabled: boolean): number');
        expect(rootCode).toContain('for (const [idx, item] of Array.from(rawItems).entries())');
        expect(rootCode).toContain('if (idx >= 10) break;');
        expect(rootCode).toContain('if (enabled) {');
        expect(rootCode).toContain('v_chooseTotal = sumList(v_mapItems);');
        expect(rootCode).toContain('v_chooseTotal = fallbackZero(v_mapItems);');
        expect(rootCode).toContain('for (let _iter = 0; _iter < 3; _iter++)');
        expect(rootCode).toContain('v_refineTotal = stepIncrement(v_refineTotal, v_stepDelta);');
        expect(rootCode).toContain('return v_refineTotal;');

        // Verify the generated file parses cleanly as valid TypeScript
        const parsedRoot = parseTsModule(rootCode, 'pipeline.ts');
        expect(parsedRoot.valid).toBe(true);
    });

    it('refuses to overwrite existing files that lack the "// Generated by Slate" header', () => {
        const nodes = new Map<string, SlateNode>([
            [
                'utils/helper',
                makeNode({
                    name: 'helper',
                    language: 'typescript',
                    code: ['export function helper(x: number): number {', '    return x + 1;', '}'],
                    extra: { modulePath: 'utils/helper.ts', extension: '.ts' },
                }),
            ],
        ]);
        const config: SlateConfig = { slate: 3, name: 'app', language: 'typescript' };

        // Hand-written existing file without generated header -> error & not overwritten
        const blocked = compileTypeScript(nodes, config, new Map(), new Map(), {
            'utils/helper.ts': 'export function helper(x: number): number {\n    return x * 99; // hand-edited\n}\n',
        });
        expect(blocked.files.has('utils/helper.ts')).toBe(false);
        expect(blocked.diagnostics).toEqual([
            {
                severity: 'error',
                message: `Refusing to overwrite existing non-generated file "utils/helper.ts" (missing "${TS_GENERATED_HEADER}" header).`,
            },
        ]);

        // Existing file WITH generated header -> allowed to overwrite
        const allowed = compileTypeScript(nodes, config, new Map(), new Map(), {
            'utils/helper.ts': `${TS_GENERATED_HEADER}\nexport function helper(x: number): number { return x; }\n`,
        });
        expect(allowed.diagnostics).toEqual([]);
        expect(allowed.files.has('utils/helper.ts')).toBe(true);
    });

    it('covers compileValueToTs, tsNodeSignature, and flow validation diagnostics', () => {
        expect(compileValueToTs(undefined)).toBe('undefined');
        expect(compileValueToTs(null)).toBe('null');
        expect(compileValueToTs(true)).toBe('true');
        expect(compileValueToTs(42)).toBe('42');
        expect(compileValueToTs('True')).toBe('true');
        expect(compileValueToTs('None')).toBe('null');
        expect(compileValueToTs([1, 'two'])).toBe('[1, "two"]');
        expect(compileValueToTs({ a: 1 })).toBe('{ "a": 1 }');

        const classNode = makeNode({
            name: 'Counter',
            code: ['export class Counter {', '    constructor(public initial: number = 0) {}', '}'],
        });
        const sig = tsNodeSignature(classNode);
        expect(sig).toEqual({
            name: 'Counter',
            params: [{ name: 'initial', annotation: 'number', default: '0', kind: 'keyword' }],
            returns: 'Counter',
        });

        const diags: Array<{ severity: 'error' | 'warning'; message: string }> = [];
        const badFlow: SlateFlow = {
            name: 'brokenFlow',
            inputs: [{ name: 'unusedInput', annotation: 'number' }],
            outputs: [{ name: 'result', annotation: 'number' }],
            instances: [{ id: 'missingCall', node: 'nonexistent/node' }],
            wires: [],
            extra: {},
        };
        const flowNode = flowToTsNode('brokenFlow', badFlow, () => null, diags);
        expect(flowNode).toBeNull();
        expect(diags.some(d => d.severity === 'warning' && d.message.includes('unusedInput is unused'))).toBe(true);
        expect(diags.some(d => d.severity === 'error' && d.message.includes('nonexistent/node'))).toBe(true);
        expect(diags.some(d => d.severity === 'error' && d.message.includes('output result is not wired'))).toBe(true);
    });

    it('handles multi-output branch/foreach/repeat regions, import cycle warnings, and port warnings', () => {
        const { nodes: warnNodes, report: warnReport } = portTsProject({
            'a.ts': [
                'import * as ns from "./b";',
                'import { helper as h } from "./b";',
                'export function _prelude(): number { return 0; }',
                'export function dup(): number { return 1; }',
                'export function dup(): number { return 2; }',
            ].join('\n'),
            'b.ts': 'export function helper(): number { return 42; }',
            'bad.ts': 'export function broken( {',
        });
        expect(warnReport.warnings.some(w => w.includes('bad.ts: could not be parsed'))).toBe(true);
        expect(warnReport.warnings.some(w => w.includes('_prelude is a reserved node name'))).toBe(true);
        expect(warnReport.warnings.some(w => w.includes('dup is defined more than once'))).toBe(true);
        expect(warnReport.warnings.some(w => w.includes('namespace import'))).toBe(true);
        expect(warnReport.warnings.some(w => w.includes('aliased import'))).toBe(true);
        expect(warnNodes.get('a/dup')?.code.join('\n')).toContain('return 2;');

        // Multi-output child flows + cycle warning
        const cycleNodes = new Map<string, SlateNode>([
            ['m1/fnA', makeNode({ name: 'fnA', uses: ['m2/fnB'], code: ['export function fnA(x: number): number { return fnB(x); }'] })],
            ['m2/fnB', makeNode({ name: 'fnB', uses: ['m1/fnA'], code: ['export function fnB(x: number): number { return fnA(x); }'] })],
        ]);
        const cycleFlows = new Map<string, SlateFlow>([
            [
                'pairStep',
                {
                    name: 'pairStep',
                    inputs: [{ name: 'a', annotation: 'number' }, { name: 'b', annotation: 'number' }],
                    outputs: [
                        { name: 'a', annotation: 'number' },
                        { name: 'b', annotation: 'number' },
                        { name: 'keepGoing', annotation: 'boolean' },
                    ],
                    instances: [
                        { id: 'v1', kind: 'value', value: 1 },
                        { id: 'v2', kind: 'value', value: 2 },
                        { id: 'vc', kind: 'value', value: false },
                    ],
                    wires: [
                        { from: 'v1.out', to: 'output:a' },
                        { from: 'v2.out', to: 'output:b' },
                        { from: 'vc.out', to: 'output:keepGoing' },
                    ],
                    extra: {},
                },
            ],
            [
                'multiFlow',
                {
                    name: 'multiFlow',
                    inputs: [{ name: 'initA', annotation: 'number' }, { name: 'initB', annotation: 'number' }],
                    outputs: [{ name: 'outA', annotation: 'number' }, { name: 'outB', annotation: 'number' }],
                    instances: [],
                    regions: [
                        {
                            id: 'loopPair',
                            kind: 'repeat',
                            bodyFlow: 'pairStep',
                            maxIterations: 4,
                            statePorts: ['a', 'b'],
                            conditionPort: 'keepGoing',
                        },
                    ],
                    wires: [
                        { from: 'input:initA', to: 'loopPair.in:a' },
                        { from: 'input:initB', to: 'loopPair.in:b' },
                        { from: 'loopPair.out:a', to: 'output:outA' },
                        { from: 'loopPair.out:b', to: 'output:outB' },
                    ],
                    extra: {},
                },
            ],
        ]);
        const compiled = compileTypeScript(
            cycleNodes,
            { slate: 3, name: 'cyc', language: 'typescript' },
            cycleFlows,
            new Map(),
            undefined,
            { checkJpl60: true },
        );
        expect(compiled.diagnostics.some(d => d.severity === 'warning' && d.message.includes('Import cycle'))).toBe(true);
        const rootFile = compiled.files.get('cyc.ts')!;
        expect(rootFile).toContain('[v_loopPair_a, v_loopPair_b, _cond_loopPair] = pairStep(v_loopPair_a, v_loopPair_b);');
        expect(rootFile).toContain('if (!_cond_loopPair) break;');
        expect(rootFile).toContain('return [v_loopPair_a, v_loopPair_b];');
    });

    it('normalizes compile output paths, blocks escapes/raw-key bypasses, compiles distinct root modulePaths, and preserves default exports (#2, #3, #4)', () => {
        // #2: normalizeCompileOutputPath unit boundary checks
        expect(normalizeCompileOutputPath('a/b.ts')).toBe('a/b.ts');
        expect(normalizeCompileOutputPath('sub\\../victim.ts')).toBe('victim.ts');
        expect(normalizeCompileOutputPath('../../escape.ts')).toBeNull();
        expect(normalizeCompileOutputPath('/abs/path.ts')).toBeNull();
        expect(normalizeCompileOutputPath('C:/win/path.ts')).toBeNull();

        const escapeCompiled = compileTypeScript(
            new Map([
                ['bad', makeNode({ name: 'bad', code: ['export function bad(): number { return 1; }'], extra: { modulePath: '../../escape.ts' } })],
            ]),
            { slate: 3, name: 'app', language: 'typescript' },
        );
        expect(escapeCompiled.files.size).toBe(0);
        expect(escapeCompiled.diagnostics.some(d => d.severity === 'error' && /unsafe/i.test(d.message))).toBe(true);

        const dotBypass = compileTypeScript(
            new Map([
                ['victim', makeNode({ name: 'victim', code: ['export function victim(): number { return 1; }'], extra: { modulePath: 'sub/../victim.ts' } })],
            ]),
            { slate: 3, name: 'app', language: 'typescript' },
            undefined,
            new Map(),
            { 'victim.ts': '// Hand-written victim\nexport const keep = 1;\n' },
        );
        expect(dotBypass.files.size).toBe(0);
        expect(dotBypass.diagnostics.some(d => d.severity === 'error' && d.message.includes('Refusing to overwrite'))).toBe(true);

        // #3: two root-level nodes with distinct modulePaths compile into separate files with relative cross-import
        const splitCompiled = compileTypeScript(
            new Map([
                ['helper', makeNode({ name: 'helper', code: ['export function helper(x: number): number { return x + 1; }'], extra: { modulePath: 'a.ts' } })],
                ['caller', makeNode({ name: 'caller', uses: ['helper'], code: ['export function caller(x: number): number { return helper(x) * 2; }'], extra: { modulePath: 'b.ts' } })],
            ]),
            { slate: 3, name: 'app', language: 'typescript' },
        );
        expect(splitCompiled.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
        expect(splitCompiled.files.has('a.ts')).toBe(true);
        expect(splitCompiled.files.has('b.ts')).toBe(true);
        expect(splitCompiled.files.get('a.ts')).toContain('export function helper');
        expect(splitCompiled.files.get('b.ts')).toContain('import { helper } from "./a";');
        expect(splitCompiled.files.get('b.ts')).toContain('export function caller');

        // #4: default export/import round-trip preserves default import form
        const ported = portTsProject({
            'helper.ts': 'export default function helper(x: number): number {\n    return x + 10;\n}\n',
            'app.ts': 'import helper from "./helper";\nexport function run(x: number): number {\n    return helper(x);\n}\n',
        });
        expect(ported.nodes.get('helper/helper')?.extra?.defaultExport).toBe(true);
        const recompiled = compileTypeScript(ported.nodes, { slate: 3, name: 'app', language: 'typescript' });
        expect(recompiled.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
        expect(recompiled.files.get('helper.ts')).toContain('export default function helper');
        expect(recompiled.files.get('app.ts')).toContain('import helper from "./helper";');
        expect(recompiled.files.get('app.ts')).not.toContain('import { helper }');
    });
});
