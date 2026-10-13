import { describe, expect, it } from 'vitest';

import { buildGenerationPacket } from '../vscode-extension/src/generation';
import {
    checkNodeCode, indexNode, nodeFromSignature, parseConfig, parseLayout, parseNode, serializeNode, SlateFormatError,
} from '../vscode-extension/src/slate_folder';

const normalize = {
    slate: 3,
    name: 'normalize',
    intent: 'Convert a score to a percentage',
    context: ['clamp'],
    owner: 'scoring-team',
    locked: false,
    imports: ['import math'],
    uses: ['scoring/clamp'],
    order: 2,
    code: [
        'def normalize(score: int, maximum: int) -> int:',
        '    raise NotImplementedError',
    ],
};

const clamp = {
    slate: 3,
    name: 'clamp',
    intent: 'Clamp to bounds',
    locked: true,
    code: [
        'def clamp(value: int, lower: int, upper: int) -> int:',
        '    return max(lower, min(value, upper))',
    ],
};

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe('slate/ folder format', () => {
    it('round-trips a node with unknown keys preserved and code written last', () => {
        const node = parseNode(json(normalize));
        expect(node).toMatchObject({ uses: ['scoring/clamp'], order: 2, extra: { owner: 'scoring-team' } });
        expect(() => parseNode(json({ ...normalize, kind: 'module' }))).toThrow(SlateFormatError);
        const text = serializeNode(node);
        const parsed = JSON.parse(text);
        expect(parsed.owner).toBe('scoring-team');
        expect(Object.keys(parsed).at(-1)).toBe('code');
        expect(parsed.code).toEqual(normalize.code);
        expect(serializeNode(parseNode(text))).toBe(text);
    });

    it('indexes a nested node path as a durable unit whose id is the path and whose annotation comes from JSON fields', () => {
        const { document, code } = indexNode('slate/nodes/scoring/normalize.json', json(normalize), 'python', 3);
        expect(document.valid).toBe(true);
        expect(document.diagnostics).toEqual([]);
        expect(document.units).toHaveLength(1);
        const unit = document.units[0];
        expect(unit.id).toBe('scoring/normalize');
        expect(unit.identity).toBe('durable');
        expect(unit.signature).toBe('def normalize(score: int, maximum: int) -> int');
        expect(unit.annotation).toMatchObject({ intent: 'Convert a score to a percentage', dependencies: ['clamp'], locked: false });
        // Ranges are relative to the code text, which is what the host keeps in `sources`.
        expect(code.split('\n')[unit.ranges.name.start.line]).toContain('def normalize');
        expect(unit.ranges.name.start.line).toBe(0);
    });

    it('flags a file name that differs from name, imports inside code, and a missing definition', () => {
        const misnamed = indexNode('slate/nodes/other.json', json(normalize), 'python', null).document;
        expect(misnamed.diagnostics.map(item => item.code)).toContain('node-name-mismatch');

        const withImport = indexNode('slate/nodes/normalize.json', json({ ...normalize, code: ['import math', ...normalize.code] }), 'python', null).document;
        expect(withImport.diagnostics.map(item => item.code)).toContain('node-extra-statements');

        const wrongDef = indexNode('slate/nodes/normalize.json', json({ ...normalize, code: ['def other() -> None:', '    pass'] }), 'python', null).document;
        expect(wrongDef.diagnostics.map(item => item.code)).toContain('node-definition-missing');
    });

    it('reports malformed node JSON and unsupported languages as invalid documents', () => {
        expect(indexNode('slate/nodes/x.json', '{ not json', 'python', null).document.valid).toBe(false);
        const csharp = indexNode('slate/nodes/normalize.json', json({ ...normalize, language: 'csharp' }), 'python', null);
        expect(csharp.document.valid).toBe(false);
        expect(csharp.node?.language).toBe('csharp');
    });

    it('accepts replacement code only when it is one definition with the node name', () => {
        const node = parseNode(json(normalize));
        expect(() => checkNodeCode(node, 'normalize', 'def normalize(score: int, maximum: int) -> int:\n    return 1\n')).not.toThrow();
        expect(() => checkNodeCode(node, 'normalize', 'def renamed(score: int, maximum: int) -> int:\n    return 1\n')).toThrow(SlateFormatError);
        expect(() => checkNodeCode(node, 'normalize', 'import math\ndef normalize(score: int, maximum: int) -> int:\n    return 1\n')).toThrow(SlateFormatError);
        expect(() => checkNodeCode(node, 'normalize', 'def normalize(:\n')).toThrow(SlateFormatError);
    });

    it('creates a new node from a typed signature and rejects non-signatures', () => {
        const node = nodeFromSignature('def add(a: int, b: int) -> int:', 'Add two numbers');
        expect(node.name).toBe('add');
        expect(node.code[0]).toBe('def add(a: int, b: int) -> int:');
        expect(() => nodeFromSignature('x = 1', 'nope')).toThrow(SlateFormatError);
        expect(() => nodeFromSignature('class Thing', 'nope')).toThrow(SlateFormatError);
    });

    it('validates slate.json and tolerates a missing or partial layout.json', () => {
        expect(parseConfig('{"slate": 3, "name": "demo"}')).toEqual({ slate: 3, name: 'demo', language: 'python' });
        expect(() => parseConfig('{"slate": 2, "name": "demo"}')).toThrow(SlateFormatError);
        expect(parseLayout(undefined)).toEqual({ positions: {}, notes: [] });
        expect(parseLayout('{"positions": {"a": {"x": 1, "y": 2}, "b": {"x": "no"}}}').positions).toEqual({ a: { x: 1, y: 2 } });
    });

    it('builds a generation packet from node documents, pulling context nodes by id', () => {
        const target = indexNode('slate/nodes/normalize.json', json(normalize), 'python', null);
        const context = indexNode('slate/nodes/clamp.json', json(clamp), 'python', null);
        const snapshot = { revision: 1, projectName: 'demo', mode: 'folder' as const, documents: [target.document, context.document] };
        const sources = new Map([[target.document.path, target.code], [context.document.path, context.code]]);
        const packet = buildGenerationPacket(snapshot, sources, 'normalize', 4096, 512);
        expect(packet.items.map(item => [item.role, item.id])).toEqual([['target', 'normalize'], ['required-context', 'clamp']]);
        expect(packet.items[1].source).toContain('return max(lower, min(value, upper))');
        expect(() => buildGenerationPacket(snapshot, sources, 'clamp', 4096, 512)).toThrow(/locked/);
    });
});
