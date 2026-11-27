import { describe, expect, it } from 'vitest';
import {
    SlateFormatError, checkJpl60, checkNodeCode, classFrameFromHeader, codeLines, codeText,
    emptyLayout, extractClassFrameMetadata, indexNode, isMethodReceiverParam, nodeFromSignature,
    nodeIdForPath, parseConfig, parseLayout, parseNode, pathForNodeId, serializeLayout, serializeNode,
} from '../vscode-extension/src/slate_folder';

const base = { slate: 3, name: 'run', code: ['def run(x: int) -> int:', '    return x'] };

describe('node format validation matrix', () => {
    it.each([
        ['version', { slate: 2 }, /declare/],
        ['name', { name: 'not-valid' }, /identifier/],
        ['language', { language: 3 }, /language/],
        ['author', { describedBy: 'bot' }, /describedBy/],
        ['lock', { locked: 'false' }, /locked/],
        ['kind', { kind: 'function' }, /kind/],
        ['order', { order: 1.5 }, /order/],
        ['intent', { intent: null }, /intent/],
        ['contract', { contract: [] }, /contract/],
        ...['context', 'examples', 'imports', 'uses', 'code'].flatMap<[string, Record<string, unknown>, RegExp]>(key => [
            [`${key} scalar`, { [key]: 'text' }, /list of strings/],
            [`${key} mixed`, { [key]: ['text', 1] }, /list of strings/],
        ]),
    ])('rejects invalid %s', (_label, patch, message) => {
        const read = () => parseNode(JSON.stringify({ ...base, ...(patch as object) }));
        expect(read).toThrow(SlateFormatError);
        expect(read).toThrow(message as RegExp);
    });

    it.each(['{', 'null', '[]', '42'])('rejects invalid node document %s', text => {
        expect(() => parseNode(text)).toThrow(SlateFormatError);
    });

    it.each(['human', 'llama'] as const)('round-trips metadata from %s', describedBy => {
        const node = parseNode(JSON.stringify({ ...base, describedBy, order: 0, locked: true,
            context: ['lib/helper'], examples: ['run(1) == 1'], imports: ['import math'],
            uses: ['lib/helper'], extension: { nested: [1, 2] } }));
        expect(parseNode(serializeNode(node))).toEqual(node);
        expect(node.extra).toEqual({ extension: { nested: [1, 2] } });
    });

    it.each([
        ['function', 'def run(x):\n    return x', true],
        ['async', 'async def run(x):\n    return x', true],
        ['decorated', '@cache\ndef run(x):\n    return x', true],
        ['class', 'class run:\n    pass', true],
        ['wrong name', 'def other():\n    pass', false],
        ['two definitions', 'def run():\n    pass\ndef other():\n    pass', false],
        ['module import', 'import os\ndef run():\n    pass', false],
        ['module assignment', 'x = 1\ndef run():\n    pass', false],
        ['empty', '', false],
        ['syntax', 'def run(:', false],
    ])('checks replacement: %s', (_label, code, valid) => {
        const check = () => checkNodeCode(parseNode(JSON.stringify(base)), 'run', code);
        if (valid) expect(check).not.toThrow();
        else expect(check).toThrow(SlateFormatError);
    });

    it.each(['prelude', 'epilogue'] as const)('indexes and validates %s module state', kind => {
        const result = indexNode(`slate/nodes/_${kind}.json`, JSON.stringify({
            slate: 3, name: `_${kind}`, kind, code: ['VALUE = 1'],
        }), 'python', 7);
        expect(result.document).toMatchObject({ valid: true, version: 7, nodeKind: kind, units: [], diagnostics: [] });
        expect(() => checkNodeCode(result.node!, `_${kind}`, 'VALUE = 2')).not.toThrow();
        expect(() => checkNodeCode(result.node!, `_${kind}`, 'def broken(:')).toThrow(/valid Python/);
    });

    it.each(['def run(x: int) -> int', 'def run(x: int) -> int:', ' async def run() -> int '])('creates %s', signature => {
        const node = nodeFromSignature(signature, '  Return a value  ');
        expect(node).toMatchObject({ name: 'run', intent: 'Return a value', describedBy: 'human' });
        expect(() => checkNodeCode(node, 'run', codeText(node))).not.toThrow();
    });
    it.each(['', 'class Run', 'run(x)', 'def broken(', 'import os\ndef run()'])('rejects signature %j', signature => {
        expect(() => nodeFromSignature(signature, '')).toThrow(SlateFormatError);
    });
});

describe('config, layout, and path matrix', () => {
    it.each([
        [null, /object/], [[], /object/], [{ slate: 2, name: 'x' }, /declare/],
        [{ slate: 3, name: ' ' }, /name/], [{ slate: 3, name: 'x', language: null }, /language/],
        [{ slate: 3, name: 'x', compile: {} }, /outDir/],
        [{ slate: 3, name: 'x', library: [1] }, /library/],
    ])('rejects config %j', (value, error) => {
        expect(() => parseConfig(JSON.stringify(value))).toThrow(error);
    });
    it('defaults the language and preserves compile/library settings', () => {
        expect(parseConfig('{"slate":3,"name":"demo","compile":{"outDir":"src"},"library":["lib.py"]}'))
            .toEqual({ slate: 3, name: 'demo', language: 'python', compile: { outDir: 'src' }, library: ['lib.py'] });
        expect(() => parseConfig('{')).toThrow(SlateFormatError);
    });
    it('round-trips valid pythonPath and ci configuration and rejects unsafe/malformed values', () => {
        const parsed = parseConfig(JSON.stringify({
            slate: 3,
            name: 'hawa_cfd',
            language: 'python',
            compile: { outDir: 'hawa' },
            pythonPath: '  .venv/bin/python  ',
            ci: {
                srcRoots: ['hawa', 'solvers\\flux/'],
                testRoots: ['tests'],
                requireTests: true,
            },
        }));
        expect(parsed.pythonPath).toBe('.venv/bin/python');
        expect(parsed.ci).toEqual({
            srcRoots: ['hawa', 'solvers/flux'],
            testRoots: ['tests'],
            requireTests: true,
        });
        expect(parseConfig(
            `{"slate":3,"name":"hawa_cfd","language":"python","compile":{"outDir":"hawa"},"pythonPath":".venv/bin/python","ci":{"srcRoots":["hawa","solvers/flux"],"testRoots":["tests"],"requireTests":true}}`,
        )).toEqual(parsed);

        for (const bad of [
            { slate: 3, name: 'x', pythonPath: '' },
            { slate: 3, name: 'x', pythonPath: 'python\n--version' },
            { slate: 3, name: 'x', pythonPath: 42 },
            { slate: 3, name: 'x', ci: 'bad' },
            { slate: 3, name: 'x', ci: { srcRoots: ['../escape'] } },
            { slate: 3, name: 'x', ci: { srcRoots: ['/abs/path'] } },
            { slate: 3, name: 'x', ci: { testRoots: ['C:\\abs'] } },
            { slate: 3, name: 'x', ci: { requireTests: 'yes' } },
        ]) {
            expect(() => parseConfig(JSON.stringify(bad))).toThrow(SlateFormatError);
        }
    });
    it.each([undefined, '', '  ', '{}'])('defaults empty layout %j', text => {
        expect(parseLayout(text)).toEqual(emptyLayout());
    });
    it('filters malformed layout entries and round-trips all sections', () => {
        const point = { x: -12.5, y: 0 };
        const layout = parseLayout(JSON.stringify({
            positions: { good: point, bad: { x: '1', y: 2 }, missing: { x: 1 } },
            notes: [{ id: 'n', title: 'Title', body: 'Body', attachedTo: null }, { id: 'bad' }],
            refs: [{ id: 'r', target: 'run', ignored: true }, null],
            placeholders: [{ id: 'p', name: 'future', signature: 'def future()' }, { id: 'bad', name: 3 }],
            mapPositions: { run: point }, flowPositions: { main: { run: point, bad: null } },
        }));
        expect(layout).toEqual({ positions: { good: point },
            notes: [{ id: 'n', title: 'Title', body: 'Body', attachedTo: null }],
            refs: [{ id: 'r', target: 'run' }], placeholders: [{ id: 'p', name: 'future', signature: 'def future()' }],
            mapPositions: { run: point }, flowPositions: { main: { run: point } } });
        expect(parseLayout(serializeLayout(layout))).toEqual(layout);
        expect(JSON.parse(serializeLayout({ ...layout, refs: [] })).refs).toBeUndefined();
        expect(JSON.parse(serializeLayout(emptyLayout()))).toEqual({ positions: {}, notes: [] });
        const other = emptyLayout();
        other.notes.push(layout.notes[0]);
        expect(emptyLayout().notes).toEqual([]);
    });
    it.each(['null', '[]', '1', '{'])('rejects malformed layout %s', text => {
        expect(() => parseLayout(text)).toThrow();
    });
    it.each([
        ['slate/nodes/run.json', 'run'], ['slate\\nodes\\pkg\\run.json', 'pkg/run'],
        ['slate/nodes/pkg/run.json', 'pkg/run'], ['nodes/run.json', null],
        ['slate/nodes/run.py', null], ['other/slate/nodes/run.json', null],
    ])('maps node path %s', (path, id) => {
        expect(nodeIdForPath(path)).toBe(id);
        if (id !== null) expect(nodeIdForPath(pathForNodeId(id))).toBe(id);
    });
    it.each([
        ['', []], ['\n \n', []], ['a\r\nb\r\n', ['a', 'b']],
        ['a\rb\r', ['a', 'b']], ['a\n\n  b\n \n', ['a', '', '  b']],
    ])('normalizes code %j', (text, lines) => {
        expect(codeLines(text)).toEqual(lines);
        expect(codeText({ code: lines })).toBe(lines.join('\n') + '\n');
    });
});

describe('schema boundaries exposed by surviving mutations', () => {
    it.each([undefined, null, false, 0, [], ['valid_name'], {}, ''])('rejects non-name config value %j with a format error', name => {
        const read = () => parseConfig(JSON.stringify({ slate: 3, name }));
        expect(read).toThrow(SlateFormatError);
        expect(read).toThrow('slate.json needs a name');
    });
    it('keeps JSON parse failures identifiable instead of reporting an unrelated object error', () => {
        expect(() => parseConfig('{')).toThrow(/^slate.json is not valid JSON:/);
        expect(() => parseNode('{')).toThrow(/^not valid JSON:/);
    });
    it.each(['id', 'title', 'body'])('filters notes with invalid %s independently of other valid fields', field => {
        const valid = { id: 'n', title: '', body: '', attachedTo: null };
        const invalid = [undefined, null, 1, false, [], {}].map(value => ({ ...valid, [field]: value }));
        expect(parseLayout(JSON.stringify({ notes: [...invalid, valid] })).notes).toEqual([valid]);
    });
    it('requires note attachments to be null or an identifier string', () => {
        const base = { id: 'n', title: 'Title', body: 'Body' };
        const values = [undefined, 0, false, [], {}, null, 'target'];
        expect(parseLayout(JSON.stringify({ notes: values.map(attachedTo => ({ ...base, attachedTo })) })).notes)
            .toEqual([{ ...base, attachedTo: null }, { ...base, attachedTo: 'target' }]);
    });
    it.each(['id', 'target'])('filters references with invalid %s', field => {
        const valid = { id: 'r', target: 'run' };
        const invalid = [undefined, null, 1, false, [], {}].map(value => ({ ...valid, [field]: value }));
        expect(parseLayout(JSON.stringify({ refs: [...invalid, valid] })).refs).toEqual([valid]);
    });
    it.each(['id', 'name'])('filters placeholders with invalid %s', field => {
        const valid = { id: 'p', name: 'future' };
        const invalid = [undefined, null, 1, false, [], {}].map(value => ({ ...valid, [field]: value }));
        expect(parseLayout(JSON.stringify({ placeholders: [...invalid, valid] })).placeholders).toEqual([valid]);
    });
    it('filters non-string placeholder signatures but preserves omitted and empty signatures', () => {
        const base = { id: 'p', name: 'future' };
        const signatures = [null, 1, false, [], {}, undefined, '', 'def future()'];
        expect(parseLayout(JSON.stringify({ placeholders: signatures.map(signature => ({ ...base, signature })) })).placeholders)
            .toEqual([base, base, { ...base, signature: 'def future()' }]);
    });
});

describe('class frame format, owned methods, and JPL-60 boundaries', () => {
    it('parses, serializes, and indexes kind="class" frames with bases, decorators, and fields', () => {
        const frameCode = [
            '@dataclass',
            'class ConvBlock(nn.Module, Generic[T]):',
            '    channels: int',
            '    bias: bool = True',
            '    SCALE = 1.0',
        ];
        const raw = serializeNode({
            name: 'ConvBlock',
            kind: 'class',
            intent: 'Convolution block container',
            contract: 'channels > 0',
            context: [],
            examples: [],
            describedBy: 'human',
            locked: false,
            imports: ['from dataclasses import dataclass'],
            uses: [],
            code: frameCode,
            extra: {},
        });
        const parsed = parseNode(raw);
        expect(parsed.kind).toBe('class');
        expect(parsed.owner).toBeUndefined();

        const indexed = indexNode('slate/nodes/models/ConvBlock.json', raw, 'python', 3, { checkJpl60: true });
        expect(indexed.document.valid).toBe(true);
        expect(indexed.document.nodeKind).toBe('class');
        expect(indexed.document.diagnostics).toEqual([]);
        expect(indexed.document.classMeta).toMatchObject({
            name: 'ConvBlock',
            decorators: ['@dataclass'],
            bases: ['nn.Module', 'Generic[T]'],
            hasMethods: false,
        });
        expect(indexed.document.classMeta?.fields).toEqual([
            { name: 'channels', annotation: 'int', defaultValue: null, raw: 'channels: int' },
            { name: 'bias', annotation: 'bool', defaultValue: 'True', raw: 'bias: bool = True' },
            { name: 'SCALE', annotation: null, defaultValue: '1.0', raw: 'SCALE = 1.0' },
        ]);
    });

    it('parses, indexes, and validates owned method nodes under JPL-60 while exempting self/cls', () => {
        expect(isMethodReceiverParam('self', 0, [], true)).toBe(true);
        expect(isMethodReceiverParam('cls', 0, ['@classmethod'], true)).toBe(true);
        expect(isMethodReceiverParam('self', 1, [], true)).toBe(false);
        expect(isMethodReceiverParam('x', 0, ['@staticmethod'], true)).toBe(false);
        expect(isMethodReceiverParam('self', 0, ['@staticmethod'], true)).toBe(false);

        const rawMethod = serializeNode({
            name: 'forward',
            classOwner: 'models/ConvBlock',
            intent: 'Apply block',
            contract: 'Preserves batch dim',
            context: [],
            examples: [],
            describedBy: 'human',
            locked: false,
            imports: [],
            uses: [],
            code: ['def forward(self, x: int) -> int:', '    return x * 2'],
            extra: {},
        });
        const methodNode = parseNode(rawMethod);
        expect(methodNode.classOwner).toBe('models/ConvBlock');

        const indexed = indexNode('slate/nodes/models/ConvBlock/forward.json', rawMethod, 'python', 1, { checkJpl60: true });
        expect(indexed.document.classOwner).toBe('models/ConvBlock');
        expect(indexed.document.diagnostics).toEqual([]);
        expect(indexed.document.units[0].kind).toBe('method');

        expect(() => parseNode(JSON.stringify({ slate: 3, name: 'bad', kind: 'class', classOwner: 'Other', code: ['pass'] }))).toThrow(/both "kind" and "classOwner"/);
        expect(() => parseNode(JSON.stringify({ slate: 3, name: 'bad', classOwner: '../escape', code: ['pass'] }))).toThrow(/Path traversal/);

        // Owned method >60 lines is rejected by JPL-60; class frame >60 lines of fields is allowed
        const longFields = ['class BigStruct:', ...Array.from({ length: 65 }, (_, i) => `    field_${i}: int = ${i}`)];
        const longFrameCheck = checkJpl60({
            name: 'BigStruct', kind: 'class', intent: 'Struct', contract: 'Valid fields',
            context: [], examples: [], locked: false, imports: [], uses: [], code: longFields, extra: {},
        });
        expect(longFrameCheck.valid).toBe(true);

        const longMethodLines = ['def forward(self, x: int) -> int:', ...Array.from({ length: 61 }, (_, i) => `    v_${i} = ${i}`), '    return x'];
        const longMethodCheck = checkJpl60({
            name: 'forward', classOwner: 'BigStruct', intent: 'Forward', contract: 'Returns int',
            context: [], examples: [], locked: false, imports: [], uses: [], code: longMethodLines, extra: {},
        });
        expect(longMethodCheck.valid).toBe(false);
        expect(longMethodCheck.diagnostics.some(d => d.code === 'jpl60-line-count')).toBe(true);

        // @staticmethod still requires explicit annotation on first parameter
        const staticMethodCheck = checkJpl60({
            name: 'helper', classOwner: 'BigStruct', intent: 'Helper', contract: 'Returns int',
            context: [], examples: [], locked: false, imports: [], uses: [],
            code: ['@staticmethod', 'def helper(x) -> int:', '    return x'],
            extra: {},
        });
        expect(staticMethodCheck.valid).toBe(false);
        expect(staticMethodCheck.diagnostics.some(d => d.code === 'jpl60-param-annotation')).toBe(true);
    });

    it('constructs valid class frames via classFrameFromHeader and rejects embedded methods in frames', () => {
        const frame = classFrameFromHeader(
            'class ConvBlock(nn.Module)',
            'Residual conv block',
            ['dim: int', 'scale: float = 1.0'],
            ['@dataclass'],
            'dim > 0',
        );
        expect(frame.kind).toBe('class');
        expect(extractClassFrameMetadata(frame.code)).toMatchObject({
            name: 'ConvBlock',
            bases: ['nn.Module'],
            decorators: ['@dataclass'],
            hasMethods: false,
        });
        expect(() => checkNodeCode(frame, 'ConvBlock', 'class ConvBlock:\n    def f(self) -> None:\n        pass')).toThrow(/cannot contain method definitions/);
        expect(() => classFrameFromHeader('def wrong(x: int) -> int', 'Nope')).toThrow(SlateFormatError);
        expect(() => classFrameFromHeader('class Foo', 'Bad', ['def bar(self): pass'])).toThrow(/Move methods into owned method nodes/);
    });
});
