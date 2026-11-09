import { describe, expect, it } from 'vitest';
import {
    SlateFormatError, checkNodeCode, codeLines, codeText, emptyLayout, indexNode,
    nodeFromSignature, nodeIdForPath, parseConfig, parseLayout, parseNode,
    pathForNodeId, serializeLayout, serializeNode,
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
