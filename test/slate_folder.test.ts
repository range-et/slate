import { describe, expect, it } from 'vitest';

import { buildGenerationPacket } from '../vscode-extension/src/generation';
import {
    assertSafeNodeId, checkJpl60, checkNodeCode, indexNode, nodeFromSignature, parseConfig, parseLayout, parseNode,
    serializeConfig, serializeNode, SlateFormatError, tsNodeFromSignature, validateNodeStub, validateStubBody, validateTsStubBody,
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
        const rust = indexNode('slate/nodes/normalize.json', json({ ...normalize, language: 'rust' }), 'python', null);
        expect(rust.document.valid).toBe(false);
        expect(rust.node?.language).toBe('rust');
        const brokenCode = indexNode('custom/normalize.json', json({ ...normalize, code: ['def normalize(:'] }), 'python', null);
        expect(brokenCode.document.valid).toBe(false);
        expect(brokenCode.document.id).toBe('node:custom/normalize.json');
        expect(brokenCode.document.diagnostics[0].code).toBe('python-syntax');
    });

    it('indexes TypeScript, TSX, C#, C++, and Arduino nodes validly and supports TS stub helpers', () => {
        const tsNode = tsNodeFromSignature('export function add(a: number, b: number): number', 'Add numbers', 'typescript', '.ts');
        expect(indexNode('slate/nodes/add.json', serializeNode(tsNode), 'typescript', null).document.valid).toBe(true);
        expect(validateNodeStub(tsNode, 'typescript').valid).toBe(true);
        expect(validateTsStubBody('export function add(a: number, b: number): number', 'return a + b;', '.ts').valid).toBe(false);
        expect(validateTsStubBody('export function add(a: number, b: number): number', 'throw new Error("todo");', '.ts').valid).toBe(true);

        const tsxNode = tsNodeFromSignature('export function Badge(label: string): JSX.Element', 'Render badge', 'typescript', '.tsx');
        expect(indexNode('slate/nodes/Badge.json', serializeNode(tsxNode), 'typescript', null).document.valid).toBe(true);

        const csNode = { slate: 3, name: 'Double', language: 'csharp', code: ['public static int Double(int x) { return x * 2; }'] };
        expect(indexNode('slate/nodes/Double.json', json(csNode), 'csharp', null).document.valid).toBe(true);

        const cppNode = { slate: 3, name: 'inc', language: 'cpp', code: ['int inc(int x) { return x + 1; }'] };
        expect(indexNode('slate/nodes/inc.json', json(cppNode), 'cpp', null).document.valid).toBe(true);

        const inoNode = { slate: 3, name: 'setup', language: 'arduino', code: ['void setup() { pinMode(13, OUTPUT); }'] };
        expect(indexNode('slate/nodes/setup.json', json(inoNode), 'arduino', null).document.valid).toBe(true);
    });

    it('accepts replacement code only when it is one definition with the node name', () => {
        const node = parseNode(json(normalize));
        expect(() => checkNodeCode(node, 'normalize', 'def normalize(score: int, maximum: int) -> int:\n    return 1\n')).not.toThrow();
        expect(() => checkNodeCode(node, 'normalize', 'def renamed(score: int, maximum: int) -> int:\n    return 1\n')).toThrow(SlateFormatError);
        expect(() => checkNodeCode(node, 'normalize', 'import math\ndef normalize(score: int, maximum: int) -> int:\n    return 1\n')).toThrow(SlateFormatError);
        expect(() => checkNodeCode(node, 'normalize', 'def normalize(:\n')).toThrow(SlateFormatError);
    });

    it('validates JPL-60 line boundaries (59, 60, 61 lines) and strict type annotations', () => {
        const baseNode = parseNode(json({ ...normalize, contract: 'Valid contract' }));

        const lines59 = ['def normalize(score: int, maximum: int) -> int:', ...Array.from({ length: 57 }, (_, i) => `    x${i} = ${i}`), '    return 1'];
        expect(lines59.length).toBe(59);
        expect(checkJpl60(baseNode, lines59.join('\n')).valid).toBe(true);

        const lines60 = ['def normalize(score: int, maximum: int) -> int:', ...Array.from({ length: 58 }, (_, i) => `    x${i} = ${i}`), '    return 1'];
        expect(lines60.length).toBe(60);
        expect(checkJpl60(baseNode, lines60.join('\n')).valid).toBe(true);

        const lines61 = ['def normalize(score: int, maximum: int) -> int:', ...Array.from({ length: 59 }, (_, i) => `    x${i} = ${i}`), '    return 1'];
        expect(lines61.length).toBe(61);
        const res61 = checkJpl60(baseNode, lines61.join('\n'));
        expect(res61.valid).toBe(false);
        expect(res61.diagnostics.some(d => d.code === 'jpl60-line-count')).toBe(true);

        // checkNodeCode with enforceJpl60 throws on line count violation
        expect(() => checkNodeCode(baseNode, 'normalize', lines61.join('\n'), { enforceJpl60: true })).toThrow(/JPL-60/);

        // Missing param annotation
        const untypedParam = 'def normalize(score, maximum: int) -> int:\n    return 1\n';
        const resUntyped = checkJpl60(baseNode, untypedParam);
        expect(resUntyped.diagnostics.some(d => d.code === 'jpl60-param-annotation')).toBe(true);

        // Missing return annotation
        const untypedRet = 'def normalize(score: int, maximum: int):\n    return 1\n';
        const resNoRet = checkJpl60(baseNode, untypedRet);
        expect(resNoRet.diagnostics.some(d => d.code === 'jpl60-return-annotation')).toBe(true);

        // indexNode with checkJpl60 surfaces diagnostics
        const indexed61 = indexNode('slate/nodes/normalize.json', json({ ...normalize, contract: 'ok', code: lines61 }), 'python', null, { checkJpl60: true });
        expect(indexed61.document.diagnostics.some(d => d.code === 'jpl60-line-count')).toBe(true);
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
        expect(parseLayout(undefined)).toEqual({ positions: {}, notes: [], refs: [], placeholders: [], mapPositions: {}, flowPositions: {} });
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

    it('parses and round-trips non-secret llm config in slate.json while rejecting raw secrets', () => {
        const config = parseConfig(JSON.stringify({
            slate: 3,
            name: 'self_host',
            language: 'python',
            compile: { outDir: 'dist' },
            library: ['lib.py'],
            llm: {
                provider: 'openrouter',
                endpoint: 'https://openrouter.ai/api/v1',
                model: 'qwen/qwen3-coder-30b-a3b-instruct',
                apiKeyEnv: 'OPENROUTER_API_KEY',
                concurrency: 4,
                timeoutSeconds: 90,
                outputTokens: 768,
                contextWindow: 8192,
            },
        }));
        expect(config.llm).toEqual({
            provider: 'openrouter',
            endpoint: 'https://openrouter.ai/api/v1',
            model: 'qwen/qwen3-coder-30b-a3b-instruct',
            apiKeyEnv: 'OPENROUTER_API_KEY',
            concurrency: 4,
            timeoutSeconds: 90,
            outputTokens: 768,
            contextWindow: 8192,
        });
        expect(parseConfig(serializeConfig(config))).toEqual(config);

        for (const provider of ['llama.cpp', 'ollama', 'openrouter', 'openai-compatible'] as const) {
            expect(parseConfig(JSON.stringify({ slate: 3, name: 'p', llm: { provider } })).llm?.provider).toBe(provider);
        }

        for (const secretField of ['apiKey', 'api_key', 'token', 'secret', 'authorization']) {
            expect(() => parseConfig(JSON.stringify({
                slate: 3,
                name: 'p',
                llm: { [secretField]: 'sk-fake-secret' },
            }))).toThrow(/must not contain raw API keys/);
        }

        expect(() => parseConfig(JSON.stringify({
            slate: 3,
            name: 'p',
            llm: { apiKeyEnv: 'sk-fake-test-secret' },
        }))).toThrow(/not a raw API key/);

        expect(() => parseConfig(JSON.stringify({
            slate: 3,
            name: 'p',
            llm: { apiKeyEnv: 'Bearer fake' },
        }))).toThrow(/not a raw API key/);

        expect(() => parseConfig(JSON.stringify({ slate: 3, name: 'p', llm: 'bad' }))).toThrow(/must be an object/);
        expect(() => parseConfig(JSON.stringify({ slate: 3, name: 'p', llm: { provider: 'unknown' } }))).toThrow(/provider/);
        expect(() => parseConfig(JSON.stringify({ slate: 3, name: 'p', llm: { endpoint: 'ftp://bad' } }))).toThrow(/http/);
        expect(() => parseConfig(JSON.stringify({ slate: 3, name: 'p', llm: { model: '   ' } }))).toThrow(/model/);
        expect(() => parseConfig(JSON.stringify({ slate: 3, name: 'p', llm: { concurrency: 0 } }))).toThrow(/concurrency/);
        expect(() => parseConfig(JSON.stringify({ slate: 3, name: 'p', llm: { concurrency: 17 } }))).toThrow(/concurrency/);
        expect(() => parseConfig(JSON.stringify({ slate: 3, name: 'p', llm: { timeoutSeconds: 4 } }))).toThrow(/timeoutSeconds/);
        expect(() => parseConfig(JSON.stringify({ slate: 3, name: 'p', llm: { outputTokens: 32 } }))).toThrow(/outputTokens/);
        expect(() => parseConfig(JSON.stringify({ slate: 3, name: 'p', llm: { contextWindow: 512 } }))).toThrow(/contextWindow/);
    });

    it('detects multiline stubs vs implemented nodes with validateNodeStub', () => {
        const multilineStub = parseNode(json({
            slate: 3,
            name: 'compute',
            code: [
                'def compute(',
                '    value: int,',
                '    scale: int,',
                ') -> int:',
                '    raise NotImplementedError',
            ],
        }));
        expect(validateNodeStub(multilineStub).valid).toBe(true);

        const implemented = parseNode(json(clamp));
        expect(validateNodeStub(implemented).valid).toBe(false);
    });

    it('rejects traversal node IDs and AST-smuggled Python/TS stub signatures and defaults (P0-6, P0-7)', () => {
        for (const badId of ['../evil', 'pkg/../evil', '/abs/id', 'C:/win/id', 'bad\nid', '', 'pkg//run']) {
            expect(() => assertSafeNodeId(badId), badId).toThrow(/Path traversal rejected/);
        }
        expect(assertSafeNodeId('pkg\\run')).toBe('pkg/run');

        // Python stub signature/default/annotation bypasses
        expect(validateStubBody('@evil\ndef f(x: int) -> int', 'pass').valid).toBe(false);
        expect(validateStubBody('def f(x: int = boom()) -> int', 'pass').valid).toBe(false);
        expect(validateStubBody('def f(x: int = f"{os.getpid()}") -> int', 'pass').valid).toBe(false);
        expect(validateStubBody('def f(x: __import__("os")) -> int', 'pass').valid).toBe(false);
        expect(validateStubBody('def f(x: int) -> int:\n    import os', 'pass').valid).toBe(false);
        expect(validateStubBody('def f(x: int = 1) -> int', 'raise NotImplementedError("todo")').valid).toBe(true);
        expect(() => nodeFromSignature('def bad(x: int) -> int:\n    return x', 'nope')).toThrow(/enter one function signature/i);
        expect(() => nodeFromSignature('def bad(x: int = boom()) -> int', 'nope')).toThrow(/enter one function signature/i);

        // TS stub signature/default/arrow bypasses
        expect(validateTsStubBody('export function f(x: number = evil()): number', 'throw new Error("Not implemented");').valid).toBe(false);
        expect(validateTsStubBody('export function f(x: number = `hi ${x}`): number', 'throw new Error("Not implemented");').valid).toBe(false);
        expect(validateTsStubBody('export function f(x: number): number { evil(); }', 'throw new Error("Not implemented");').valid).toBe(false);
        expect(validateTsStubBody('export function f(x: number = 1): number', 'throw new Error("Not implemented");').valid).toBe(true);
        expect(() => tsNodeFromSignature('export const f = (x: number): number => x * 2', 'nope')).toThrow();
    });
});
