import { describe, expect, it } from 'vitest';

import {
    AdapterError,
    checkCSharpNodeCode,
    createCSharpStub,
    CSHARP_GENERATED_HEADER,
    CSharpAdapter,
    csharpIdentifierNames,
    csharpTopLevelBindings,
    parseCSharpDetailed,
    parseCSharpModule,
    replaceCSharpUnit,
    splitCSharpUsing,
} from '../vscode-extension/src/csharp_adapter';
import {
    compileCSharp,
    compileValueToCSharp,
    flowToCSharpNode,
    mapTypeToCSharp,
} from '../vscode-extension/src/compile/csharp';
import { portCSharpProject } from '../vscode-extension/src/port/csharp_importer';
import type { SlateFlow } from '../vscode-extension/src/harness_protocol';
import type { SlateConfig, SlateNode } from '../vscode-extension/src/slate_folder';

const csharpConfig: SlateConfig = {
    slate: 3,
    name: 'DemoApp',
    language: 'csharp',
};

function makeNode(fields: Partial<SlateNode> & { name: string; code: string[] }): SlateNode {
    return {
        language: 'csharp',
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

describe('C# language adapter (csharp_adapter.ts)', () => {
    it('parses using directives, namespaces, classes, structs, and methods with structured UnitParam[], returnAnnotation, durable nodeId, and UTF-16 ranges', () => {
        const source = [
            'using System;',
            'using System.Collections.Generic;',
            'using static System.Math;',
            '',
            'namespace Demo.Numerics',
            '{',
            '    [Serializable]',
            '    public static class MathOps',
            '    {',
            '        [Obsolete("Use ClampSafe")]',
            '        public static int Clamp(int x, int low = 0, int high = 10)',
            '        {',
            '            if (x < low) return low;',
            '            if (x > high) return high;',
            '            return x;',
            '        }',
            '',
            '        public static async Task<string> FormatValues(List<int> items, string sep = ", ", params string[] tags)',
            '        {',
            '            return string.Join(sep, items);',
            '        }',
            '    }',
            '',
            '    public struct Point2D',
            '    {',
            '        public double LengthSquared(double x, double y) => x * x + y * y;',
            '    }',
            '}',
            '',
        ].join('\n');

        const detailed = parseCSharpDetailed(source, 'MathOps.cs', 'MathOps/Clamp');
        expect(detailed.valid).toBe(true);
        expect(detailed.namespace).toBe('Demo.Numerics');
        expect(detailed.usings.map(u => u.line)).toEqual([
            'using System;',
            'using System.Collections.Generic;',
            'using static System.Math;',
        ]);

        const result = parseCSharpModule(source, 'MathOps.cs', 'MathOps/Clamp');
        expect(result.valid).toBe(true);
        expect(result.units.map(u => [u.kind, u.qualifiedName, u.identity])).toEqual([
            ['class', 'MathOps', 'provisional'],
            ['method', 'MathOps.Clamp', 'durable'],
            ['method', 'MathOps.FormatValues', 'provisional'],
            ['class', 'Point2D', 'provisional'],
            ['method', 'Point2D.LengthSquared', 'provisional'],
        ]);

        const clamp = result.units.find(u => u.name === 'Clamp')!;
        expect(clamp.id).toBe('MathOps/Clamp');
        expect(clamp.decorators).toEqual(['Obsolete("Use ClampSafe")']);
        expect(clamp.returnAnnotation).toBe('int');
        expect(clamp.async).toBe(false);
        expect(clamp.parameters).toBe('int x, int low = 0, int high = 10');
        expect(clamp.signature).toBe('int Clamp(int x, int low = 0, int high = 10)');
        expect(clamp.params).toEqual([
            { name: 'x', annotation: 'int', default: null, kind: 'positional' },
            { name: 'low', annotation: 'int', default: '0', kind: 'positional' },
            { name: 'high', annotation: 'int', default: '10', kind: 'positional' },
        ]);
        expect(clamp.ranges.name).toEqual({
            start: { line: 10, character: 26 },
            end: { line: 10, character: 31 },
        });
        expect(clamp.ranges.declaration).toEqual({
            start: { line: 9, character: 8 },
            end: { line: 15, character: 9 },
        });

        const formatValues = result.units.find(u => u.name === 'FormatValues')!;
        expect(formatValues.async).toBe(true);
        expect(formatValues.returnAnnotation).toBe('Task<string>');
        expect(formatValues.params).toEqual([
            { name: 'items', annotation: 'List<int>', default: null, kind: 'positional' },
            { name: 'sep', annotation: 'string', default: '", "', kind: 'positional' },
            { name: 'tags', annotation: 'string[]', default: null, kind: 'var' },
        ]);

        const lengthSq = result.units.find(u => u.name === 'LengthSquared')!;
        expect(lengthSq.returnAnnotation).toBe('double');
        expect(lengthSq.params).toEqual([
            { name: 'x', annotation: 'double', default: null, kind: 'positional' },
            { name: 'y', annotation: 'double', default: null, kind: 'positional' },
        ]);
    });

    it('parses file-scoped namespaces, nested classes, and standalone atomic method snippets', () => {
        const fileScoped = [
            'namespace Demo.FileScoped;',
            '',
            'public class Outer',
            '{',
            '    public class Inner',
            '    {',
            '        public static int Ping(int v) => v + 1;',
            '    }',
            '}',
        ].join('\n');

        const parsed = parseCSharpDetailed(fileScoped, 'Outer.cs', 'Outer');
        expect(parsed.valid).toBe(true);
        expect(parsed.namespace).toBe('Demo.FileScoped');
        expect(parsed.units.map(u => [u.kind, u.qualifiedName, u.identity])).toEqual([
            ['class', 'Outer', 'durable'],
            ['nested_class', 'Outer.Inner', 'provisional'],
            ['method', 'Outer.Inner.Ping', 'provisional'],
        ]);

        const standaloneMethod = [
            'public static int Clamp(int x, int low = 0, int high = 10)',
            '{',
            '    return x < low ? low : (x > high ? high : x);',
            '}',
        ].join('\n');
        const standaloneParsed = parseCSharpModule(standaloneMethod, 'slate/nodes/math/Clamp.json', 'math/Clamp');
        expect(standaloneParsed.valid).toBe(true);
        expect(standaloneParsed.units).toHaveLength(1);
        expect(standaloneParsed.units[0]).toMatchObject({
            id: 'math/Clamp',
            identity: 'durable',
            kind: 'function',
            name: 'Clamp',
            returnAnnotation: 'int',
        });
    });

    it('splits C# using directives and ignores using disposal statements', () => {
        const text = [
            'global using System;',
            'using System.Collections.Generic;',
            'using static System.Math;',
            'using StringMap = System.Collections.Generic.Dictionary<string, string>;',
            'using (var stream = Open()) { }',
            'using var disposable = Create();',
        ].join('\n');

        const usings = splitCSharpUsing(text);
        expect(usings).toEqual([
            {
                line: 'global using System;',
                namespace: 'System',
                alias: null,
                isStatic: false,
                isGlobal: true,
            },
            {
                line: 'using System.Collections.Generic;',
                namespace: 'System.Collections.Generic',
                alias: null,
                isStatic: false,
                isGlobal: false,
            },
            {
                line: 'using static System.Math;',
                namespace: 'System.Math',
                alias: null,
                isStatic: true,
                isGlobal: false,
            },
            {
                line: 'using StringMap = System.Collections.Generic.Dictionary<string, string>;',
                namespace: 'System.Collections.Generic.Dictionary<string, string>',
                alias: 'StringMap',
                isStatic: false,
                isGlobal: false,
            },
        ]);
    });

    it('rejects invalid C# syntax with csharp-syntax diagnostics', () => {
        const unclosedBrace = parseCSharpModule('public static class Broken {\n    public static int Run(int x) {\n        return x;\n', 'Broken.cs');
        expect(unclosedBrace.valid).toBe(false);
        expect(unclosedBrace.diagnostics[0].code).toBe('csharp-syntax');

        const unclosedString = parseCSharpModule('public static class Broken { public static string S() => "unterminated\n }', 'Broken.cs');
        expect(unclosedString.valid).toBe(false);
        expect(unclosedString.diagnostics[0].code).toBe('csharp-syntax');

        const mismatchedParen = parseCSharpModule('public static int Clamp(int x ] { return x; }', 'Broken.cs');
        expect(mismatchedParen.valid).toBe(false);
        expect(mismatchedParen.diagnostics[0].code).toBe('csharp-syntax');
    });

    it('replaces a C# method while preserving attributes, indentation, and signature invariants', async () => {
        const source = [
            'namespace Demo',
            '{',
            '    public static class MathOps',
            '    {',
            '        [Obsolete]',
            '        public static int Clamp(int x, int low = 0, int high = 10)',
            '        {',
            '            return x;',
            '        }',
            '    }',
            '}',
            '',
        ].join('\n');

        const adapter = new CSharpAdapter();
        const parsed = await adapter.parseModule(source, 'MathOps.cs', 'MathOps/Clamp');
        const proposal = replaceCSharpUnit({
            source,
            path: 'MathOps.cs',
            nodeId: 'MathOps/Clamp',
            expectedHash: parsed.sourceHash,
            unitId: 'MathOps/Clamp',
            replacement: [
                'public static int Clamp(int x, int low = 0, int high = 10)',
                '{',
                '    if (x < low) return low;',
                '    if (x > high) return high;',
                '    return x;',
                '}',
            ].join('\n'),
        });

        expect(proposal.proposedSource).toContain('[Obsolete]');
        expect(proposal.proposedSource).toContain('if (x < low) return low;');
        expect(proposal.baseSourceHash).toBe(parsed.sourceHash);
        expect(proposal.parsed.valid).toBe(true);

        // Stale hash check
        expect(() =>
            replaceCSharpUnit({
                source,
                path: 'MathOps.cs',
                nodeId: 'MathOps/Clamp',
                expectedHash: 'sha256:stale',
                unitId: 'MathOps/Clamp',
                replacement: 'public static int Clamp(int x, int low = 0, int high = 10) { return x; }',
            }),
        ).toThrow(AdapterError);

        // Signature mismatch check
        await expect(
            adapter.replaceUnit({
                source,
                path: 'MathOps.cs',
                nodeId: 'MathOps/Clamp',
                expectedHash: parsed.sourceHash,
                unitId: 'MathOps/Clamp',
                replacement: 'public static double Clamp(int x) { return x; }',
            }),
        ).rejects.toThrow(/preserve the C# method name, return type, and parameters/);

        // Replacing a class directly is refused
        const classUnit = parsed.units.find(u => u.kind === 'class')!;
        expect(() =>
            replaceCSharpUnit({
                source,
                path: 'MathOps.cs',
                expectedHash: parsed.sourceHash,
                unitId: classUnit.id,
                replacement: 'public static int Clamp(int x, int low = 0, int high = 10) { return x; }',
            }),
        ).toThrow(/only functions and methods can be replaced/);
    });

    it('emits typed C# method stubs throwing new NotImplementedException(...)', () => {
        const stubFromParams = createCSharpStub(
            'Clamp',
            [
                { name: 'x', annotation: 'int' },
                { name: 'low', annotation: 'int', default: '0' },
                { name: 'high', annotation: 'int', default: '10' },
            ],
            'int',
            { message: 'Clamp stub pending forge' },
        );

        expect(stubFromParams).toBe(
            [
                'public static int Clamp(int x, int low = 0, int high = 10)',
                '{',
                '    throw new NotImplementedException("Clamp stub pending forge");',
                '}',
            ].join('\n'),
        );
        expect(parseCSharpModule(stubFromParams, 'Clamp.cs', 'Clamp').valid).toBe(true);

        const stubFromSignature = createCSharpStub(
            'public static string FormatItem(string prefix, int index = 1)',
            'Not yet forged',
        );
        expect(stubFromSignature).toContain('public static string FormatItem(string prefix, int index = 1)');
        expect(stubFromSignature).toContain('throw new NotImplementedException("Not yet forged");');
    });

    it('enforces JPL-60 (<=60 lines) and explicit C# parameter and return types in checkCSharpNodeCode', () => {
        const validMethod = [
            'public static int Clamp(int x, int low = 0, int high = 10)',
            '{',
            '    if (x < low) return low;',
            '    if (x > high) return high;',
            '    return x;',
            '}',
        ].join('\n');

        const okResult = checkCSharpNodeCode(validMethod, 'Clamp');
        expect(okResult.valid).toBe(true);
        expect(okResult.diagnostics).toEqual([]);
        expect(okResult.lineCount).toBe(6);

        // > 60 lines fails JPL-60 line limit
        const bodyLines = Array.from({ length: 60 }, (_, i) => `    x += ${i};`);
        const oversizedMethod = [
            'public static int Oversized(int x)',
            '{',
            ...bodyLines,
            '    return x;',
            '}',
        ].join('\n');
        const oversizedResult = checkCSharpNodeCode(oversizedMethod, 'Oversized');
        expect(oversizedResult.valid).toBe(false);
        expect(oversizedResult.lineCount).toBeGreaterThan(60);
        expect(oversizedResult.diagnostics.some(d => d.code === 'jpl60-line-count')).toBe(true);

        // Missing parameter type annotation fails
        const untypedParamMethod = [
            'public static int Compute(int a, b)',
            '{',
            '    return a;',
            '}',
        ].join('\n');
        const untypedParamRes = checkCSharpNodeCode(untypedParamMethod, 'Compute');
        expect(untypedParamRes.valid).toBe(false);
        expect(untypedParamRes.diagnostics.some(d => d.code === 'jpl60-param-annotation')).toBe(true);

        // `dynamic` return type or missing return type fails
        const dynamicReturnMethod = [
            'public static dynamic Compute(int a)',
            '{',
            '    return a;',
            '}',
        ].join('\n');
        const dynamicReturnRes = checkCSharpNodeCode(dynamicReturnMethod, 'Compute');
        expect(dynamicReturnRes.valid).toBe(false);
        expect(dynamicReturnRes.diagnostics.some(d => d.code === 'jpl60-return-annotation')).toBe(true);

        const missingReturnMethod = [
            'public static Compute(int a)',
            '{',
            '    return a;',
            '}',
        ].join('\n');
        const missingReturnRes = checkCSharpNodeCode(missingReturnMethod, 'Compute');
        expect(missingReturnRes.valid).toBe(false);
        expect(missingReturnRes.diagnostics.some(d => d.code === 'jpl60-return-annotation')).toBe(true);

        // enforceJpl60 throws AdapterError
        expect(() =>
            checkCSharpNodeCode(oversizedMethod, 'Oversized', { enforceJpl60: true }),
        ).toThrow(AdapterError);
    });

    it('extracts C# identifier names and top-level bindings accurately', () => {
        const snippet = 'public const int MaxLimit = 100;\npublic static int Scale(int val) { return val * MaxLimit; }';
        const idents = csharpIdentifierNames(snippet);
        expect(idents.has('MaxLimit')).toBe(true);
        expect(idents.has('Scale')).toBe(true);
        expect(idents.has('val')).toBe(true);
        expect(idents.has('public')).toBe(false);
        expect(idents.has('static')).toBe(false);

        const bindings = csharpTopLevelBindings(snippet);
        expect(bindings.has('MaxLimit')).toBe(true);
        expect(bindings.has('Scale')).toBe(true);
    });
});

describe('C# importer and compiler round-trip (csharp_importer.ts & compile/csharp.ts)', () => {
    it('ports .cs files into SlateNodes preserving using imports, uses across methods, namespace, and className, and round-trips through compileCSharp', () => {
        const inputFiles: Record<string, string> = {
            'Math/Geometry.cs': [
                'using System;',
                'using System.Collections.Generic;',
                '',
                'namespace DemoApp.Math',
                '{',
                '    public static class Geometry',
                '    {',
                '        public const double MaxArea = 500.0;',
                '',
                '        /// <summary>Clamp a double value between low and high bounds.</summary>',
                '        public static double Clamp(double x, double low = 0.0, double high = 100.0)',
                '        {',
                '            if (x < low) return low;',
                '            if (x > high) return high;',
                '            return x;',
                '        }',
                '',
                '        /// <summary>Compute bounded circle area.</summary>',
                '        public static double CircleArea(double r)',
                '        {',
                '            return Clamp(Math.PI * r * r, 0.0, MaxArea);',
                '        }',
                '    }',
                '}',
                '',
            ].join('\n'),
            'Math/Stats.cs': [
                'using System;',
                'using System.Collections.Generic;',
                '',
                'namespace DemoApp.Math',
                '{',
                '    public static class Stats',
                '    {',
                '        public static List<double> BoundedAreas(List<double> radii)',
                '        {',
                '            var result = new List<double>();',
                '            foreach (var r in radii)',
                '            {',
                '                result.Add(Geometry.CircleArea(r));',
                '            }',
                '            return result;',
                '        }',
                '    }',
                '}',
                '',
            ].join('\n'),
        };

        const ported = portCSharpProject(inputFiles);
        expect(ported.report.warnings).toEqual([]);
        expect(ported.report.modules).toEqual(['Math/Geometry.cs', 'Math/Stats.cs']);
        expect(ported.report.nodes).toBe(3);
        expect(ported.report.preludes).toBe(1);

        const clampNode = ported.nodes.get('Math/Geometry/Clamp')!;
        expect(clampNode).toBeDefined();
        expect(clampNode.language).toBe('csharp');
        expect(clampNode.intent).toBe('Clamp a double value between low and high bounds.');
        expect(clampNode.imports).toEqual(['using System;', 'using System.Collections.Generic;']);
        expect(clampNode.extra.namespace).toBe('DemoApp.Math');
        expect(clampNode.extra.className).toBe('Geometry');

        const areaNode = ported.nodes.get('Math/Geometry/CircleArea')!;
        expect(areaNode.uses).toEqual(['Math/Geometry/Clamp', 'Math/Geometry/_prelude']);
        expect(areaNode.extra.namespace).toBe('DemoApp.Math');
        expect(areaNode.extra.className).toBe('Geometry');

        const statsNode = ported.nodes.get('Math/Stats/BoundedAreas')!;
        expect(statsNode.uses).toEqual(['Math/Geometry/CircleArea']);
        expect(statsNode.extra.namespace).toBe('DemoApp.Math');
        expect(statsNode.extra.className).toBe('Stats');

        // Compile back to C#
        const compiled = compileCSharp(ported.nodes, csharpConfig);
        expect(compiled.diagnostics).toEqual([]);
        expect([...compiled.files.keys()]).toEqual(['Math/Geometry.cs', 'Math/Stats.cs']);

        const geometryCs = compiled.files.get('Math/Geometry.cs')!;
        expect(geometryCs.startsWith(CSHARP_GENERATED_HEADER)).toBe(true);
        expect(geometryCs).toContain('using System;');
        expect(geometryCs).toContain('namespace DemoApp.Math');
        expect(geometryCs).toContain('public static class Geometry');
        expect(geometryCs).toContain('public const double MaxArea = 500.0;');
        expect(geometryCs).toContain('public static double Clamp(double x, double low = 0.0, double high = 100.0)');
        expect(geometryCs).toContain('public static double CircleArea(double r)');

        // Re-port compiled output and verify round-trip stability
        const rePorted = portCSharpProject(compiled.files);
        expect(rePorted.report.warnings).toEqual([]);
        expect([...rePorted.nodes.keys()]).toEqual([...ported.nodes.keys()]);
        for (const [id, origNode] of ported.nodes) {
            const roundTripNode = rePorted.nodes.get(id)!;
            expect(roundTripNode.name).toBe(origNode.name);
            expect(roundTripNode.code).toEqual(origNode.code);
            expect(roundTripNode.uses).toEqual(origNode.uses);
            expect(roundTripNode.extra.namespace).toBe(origNode.extra.namespace);
            expect(roundTripNode.extra.className).toBe(origNode.extra.className);
        }
    });

    it('reports warnings on unparseable .cs files and duplicate method names', () => {
        const ported = portCSharpProject({
            'Broken.cs': 'namespace Bad { public class X { public static int F(int a { return a; } } }',
            'Dup.cs': [
                'namespace Demo {',
                '    public static class Dup {',
                '        public static int Run(int x) { return x; }',
                '        public static int Run(int x) { return x + 1; }',
                '    }',
                '}',
            ].join('\n'),
        });

        expect(ported.report.warnings).toContain('Broken.cs: could not be parsed; not ported.');
        expect(ported.report.warnings.some(w => w.includes('Run is defined more than once'))).toBe(true);
        expect(ported.nodes.get('Dup/Run')?.code.join('\n')).toContain('return x + 1;');
    });
});

describe('C# flow and control-flow region compilation (branch, foreach, repeat)', () => {
    const baseNodes = new Map<string, SlateNode>([
        [
            'ops/DoubleVal',
            makeNode({
                name: 'DoubleVal',
                imports: ['using System;'],
                code: ['public static int DoubleVal(int x)', '{', '    return x * 2;', '}'],
                extra: { namespace: 'DemoApp.Flows', className: 'PipelineOps', modulePath: 'Flows/PipelineOps.cs' },
            }),
        ],
        [
            'ops/NegateVal',
            makeNode({
                name: 'NegateVal',
                imports: ['using System;'],
                code: ['public static int NegateVal(int x)', '{', '    return -x;', '}'],
                extra: { namespace: 'DemoApp.Flows', className: 'PipelineOps', modulePath: 'Flows/PipelineOps.cs' },
            }),
        ],
        [
            'ops/AddOffset',
            makeNode({
                name: 'AddOffset',
                imports: ['using System;'],
                code: ['public static int AddOffset(int item, int index = 0, int bias = 1)', '{', '    return item + index + bias;', '}'],
                extra: { namespace: 'DemoApp.Flows', className: 'PipelineOps', modulePath: 'Flows/PipelineOps.cs' },
            }),
        ],
        [
            'ops/StepConverge',
            makeNode({
                name: 'StepConverge',
                imports: ['using System;'],
                code: [
                    'public static (int, bool) StepConverge(int state, int limit)',
                    '{',
                    '    int next = state + 1;',
                    '    return (next, next < limit);',
                    '}',
                ],
                extra: { namespace: 'DemoApp.Flows', className: 'PipelineOps', modulePath: 'Flows/PipelineOps.cs' },
            }),
        ],
    ]);

    it('compiles a wired flow with branch (if/else), foreach (List<T> collection), and repeat (for (int _iter = 0; _iter < maxIterations; _iter++)) regions into valid C#', () => {
        const flows = new Map<string, SlateFlow>([
            [
                'pos_branch',
                {
                    name: 'PosBranch',
                    inputs: [{ name: 'x', annotation: 'int' }],
                    outputs: [{ name: 'res', annotation: 'int' }],
                    instances: [{ id: 'd', node: 'ops/DoubleVal' }],
                    wires: [
                        { from: 'input:x', to: 'd.in:x' },
                        { from: 'd.out', to: 'output:res' },
                    ],
                    extra: { namespace: 'DemoApp.Flows', className: 'PipelineOps', modulePath: 'Flows/PipelineOps.cs' },
                },
            ],
            [
                'neg_branch',
                {
                    name: 'NegBranch',
                    inputs: [{ name: 'x', annotation: 'int' }],
                    outputs: [{ name: 'res', annotation: 'int' }],
                    instances: [{ id: 'n', node: 'ops/NegateVal' }],
                    wires: [
                        { from: 'input:x', to: 'n.in:x' },
                        { from: 'n.out', to: 'output:res' },
                    ],
                    extra: { namespace: 'DemoApp.Flows', className: 'PipelineOps', modulePath: 'Flows/PipelineOps.cs' },
                },
            ],
            [
                'item_body',
                {
                    name: 'ItemBody',
                    inputs: [
                        { name: 'item', annotation: 'int' },
                        { name: 'index', annotation: 'int' },
                        { name: 'bias', annotation: 'int' },
                    ],
                    outputs: [{ name: 'mapped', annotation: 'int' }],
                    instances: [{ id: 'add', node: 'ops/AddOffset' }],
                    wires: [
                        { from: 'input:item', to: 'add.in:item' },
                        { from: 'input:index', to: 'add.in:index' },
                        { from: 'input:bias', to: 'add.in:bias' },
                        { from: 'add.out', to: 'output:mapped' },
                    ],
                    extra: { namespace: 'DemoApp.Flows', className: 'PipelineOps', modulePath: 'Flows/PipelineOps.cs' },
                },
            ],
            [
                'repeat_body',
                {
                    name: 'RepeatBody',
                    inputs: [
                        { name: 'state', annotation: 'int' },
                        { name: 'limit', annotation: 'int' },
                    ],
                    outputs: [
                        { name: 'state', annotation: 'int' },
                        { name: 'keep_going', annotation: 'bool' },
                    ],
                    instances: [{ id: 'step', node: 'ops/StepConverge' }],
                    wires: [
                        { from: 'input:state', to: 'step.in:state' },
                        { from: 'input:limit', to: 'step.in:limit' },
                        { from: 'step.out', to: 'output:state' },
                        { from: 'step.out', to: 'output:keep_going' },
                    ],
                    extra: { namespace: 'DemoApp.Flows', className: 'PipelineOps', modulePath: 'Flows/PipelineOps.cs' },
                },
            ],
            [
                'main',
                {
                    name: 'RunPipeline',
                    inputs: [
                        { name: 'flag', annotation: 'bool' },
                        { name: 'seed', annotation: 'int' },
                        { name: 'numbers', annotation: 'List<int>' },
                    ],
                    outputs: [
                        { name: 'branched', annotation: 'int' },
                        { name: 'mappedList', annotation: 'List<int>' },
                        { name: 'finalState', annotation: 'int' },
                    ],
                    instances: [
                        { id: 'limit_val', kind: 'value', value: 10 },
                    ],
                    wires: [
                        { from: 'input:flag', to: 'branch_1.in:is_positive' },
                        { from: 'input:seed', to: 'branch_1.in:x' },
                        { from: 'input:numbers', to: 'foreach_1.in:items' },
                        { from: 'branch_1.out', to: 'foreach_1.in:bias' },
                        { from: 'branch_1.out', to: 'repeat_1.in:state' },
                        { from: 'limit_val.out', to: 'repeat_1.in:limit' },
                        { from: 'branch_1.out', to: 'output:branched' },
                        { from: 'foreach_1.out', to: 'output:mappedList' },
                        { from: 'repeat_1.out', to: 'output:finalState' },
                    ],
                    regions: [
                        {
                            id: 'branch_1',
                            kind: 'branch',
                            conditionPort: 'is_positive',
                            thenFlow: 'pos_branch',
                            elseFlow: 'neg_branch',
                        },
                        {
                            id: 'foreach_1',
                            kind: 'foreach',
                            bodyFlow: 'item_body',
                            collectionPort: 'items',
                            itemPort: 'item',
                            indexPort: 'index',
                            maxIterations: 25,
                        },
                        {
                            id: 'repeat_1',
                            kind: 'repeat',
                            bodyFlow: 'repeat_body',
                            maxIterations: 10,
                            statePorts: ['state'],
                            conditionPort: 'keep_going',
                        },
                    ],
                    extra: { namespace: 'DemoApp.Flows', className: 'PipelineOps', modulePath: 'Flows/PipelineOps.cs' },
                },
            ],
        ]);

        const compiled = compileCSharp(baseNodes, csharpConfig, flows);
        expect(compiled.diagnostics).toEqual([]);

        const csCode = compiled.files.get('Flows/PipelineOps.cs')!;
        expect(csCode).toBeDefined();
        expect(csCode.startsWith(CSHARP_GENERATED_HEADER)).toBe(true);
        expect(csCode).toContain('using System;');
        expect(csCode).toContain('using System.Collections.Generic;');
        expect(csCode).toContain('namespace DemoApp.Flows');
        expect(csCode).toContain('public static class PipelineOps');

        // Verify branch region compilation
        expect(csCode).toContain('if (flag)');
        expect(csCode).toContain('v_branch_1 = PosBranch(seed);');
        expect(csCode).toContain('v_branch_1 = NegBranch(seed);');

        // Verify foreach region compilation collecting List<int> with maxIterations guard
        expect(csCode).toContain('var v_foreach_1 = new List<int>();');
        expect(csCode).toContain('foreach (var _item in numbers)');
        expect(csCode).toContain('if (_idx >= 25)');
        expect(csCode).toContain('var _item_foreach_1 = ItemBody(_item, _idx, v_branch_1);');
        expect(csCode).toContain('v_foreach_1.Add(_item_foreach_1);');

        // Verify repeat region compilation with exact `for (int _iter = 0; _iter < maxIterations; _iter++)`
        expect(csCode).toContain('for (int _iter = 0; _iter < 10; _iter++)');
        expect(csCode).toContain('(v_repeat_1, _cond_repeat_1) = RepeatBody(v_repeat_1, v_limit_val);');
        expect(csCode).toContain('if (!_cond_repeat_1)');

        // Verify the entire compiled file parses cleanly as valid C#
        const reParsed = parseCSharpModule(csCode, 'Flows/PipelineOps.cs');
        expect(reParsed.valid).toBe(true);
        expect(reParsed.units.some(u => u.name === 'RunPipeline')).toBe(true);
    });

    it('compiles branch region without elseFlow using C# type defaults and handles helper value/type conversions', () => {
        expect(mapTypeToCSharp('List[int]')).toBe('List<int>');
        expect(mapTypeToCSharp('Dict[str, float]')).toBe('Dictionary<string, float>');
        expect(mapTypeToCSharp('Tuple[int, str]')).toBe('(int, string)');
        expect(compileValueToCSharp([1, 2, 3])).toBe('new List<int> { 1, 2, 3 }');
        expect(compileValueToCSharp(true)).toBe('true');
        expect(compileValueToCSharp(null)).toBe('null');

        const diags: Array<{ severity: 'error' | 'warning'; message: string }> = [];
        const flowNode = flowToCSharpNode(
            'only_then',
            {
                name: 'OnlyThen',
                inputs: [
                    { name: 'cond', annotation: 'bool' },
                    { name: 'val', annotation: 'int' },
                ],
                outputs: [{ name: 'out', annotation: 'int' }],
                instances: [],
                wires: [
                    { from: 'input:cond', to: 'b1.in:condition' },
                    { from: 'input:val', to: 'b1.in:x' },
                    { from: 'b1.out', to: 'output:out' },
                ],
                regions: [
                    {
                        id: 'b1',
                        kind: 'branch',
                        thenFlow: 'DoubleVal',
                    },
                ],
                extra: {},
            },
            target =>
                target === 'DoubleVal'
                    ? {
                          signature: {
                              name: 'DoubleVal',
                              params: [{ name: 'x', annotation: 'int', default: null, kind: 'positional' }],
                              returns: 'int',
                          },
                          imports: [],
                      }
                    : null,
            diags,
        );

        expect(diags).toEqual([]);
        expect(flowNode).not.toBeNull();
        expect(flowNode!.code.join('\n')).toContain('v_b1 = 0;');
    });

    it('refuses to overwrite existing files lacking the generated header', () => {
        const res = compileCSharp(
            baseNodes,
            csharpConfig,
            new Map(),
            new Map(),
            {
                existingFiles: {
                    'Flows/PipelineOps.cs': '// Hand-written file\nnamespace Custom {}\n',
                },
            },
        );
        expect(res.files.size).toBe(0);
        expect(res.diagnostics.some(d => d.severity === 'error' && d.message.includes('Refusing to overwrite'))).toBe(true);
    });
});
