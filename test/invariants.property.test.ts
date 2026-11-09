import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { rankPalette, scoreMatch } from '../src/harness/palette';
import { codeLines, codeText, parseNode, serializeNode, SlateFormatError } from '../vscode-extension/src/slate_folder';

// Fixed CI seed; fast-check reports a seed/path for every shrunk failure.
const options = { seed: 20261109, numRuns: 500 };
const strings = fc.array(fc.string(), { maxLength: 20 });

describe('generated invariants', () => {
    it('preserves valid node data and extension metadata through serialization', () => {
        fc.assert(fc.property(fc.record({
            intent: fc.string(), contract: fc.string(), context: strings,
            examples: strings, code: strings, imports: strings, uses: strings,
            locked: fc.boolean(), order: fc.integer(), extensionData: fc.jsonValue(),
        }), fields => {
            const node = parseNode(JSON.stringify({ slate: 3, name: 'generated', ...fields }));
            const before = structuredClone(node);
            const serialized = serializeNode(node);
            expect(parseNode(serialized)).toEqual(node);
            expect(serializeNode(parseNode(serialized))).toBe(serialized);
            expect(node).toEqual(before);
            expect(node.extra.extensionData).toEqual(fields.extensionData);
        }), options);
    });

    it('rejects scalar and mixed-list contract violations', () => {
        const invalid = fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.string(),
            fc.array(fc.string()).map(values => [...values, 42]));
        fc.assert(fc.property(fc.constantFrom('code', 'context', 'examples', 'imports', 'uses'), invalid,
            (field, value) => {
                expect(() => parseNode(JSON.stringify({ slate: 3, name: 'valid', [field]: value })))
                    .toThrow(SlateFormatError);
            }), options);
    });

    it('normalizes line endings and trailing blanks idempotently', () => {
        fc.assert(fc.property(fc.string(), text => {
            const lines = codeLines(text);
            expect(codeLines(codeText({ code: lines }))).toEqual(lines);
            expect(lines.every(line => !/[\r\n]/.test(line))).toBe(true);
            if (lines.length) expect(lines.at(-1)!.trim()).not.toBe('');
        }), options);
    });

    it('ranks without losing, duplicating, or mutating empty-query entries', () => {
        const entry = fc.record({ label: fc.string(),
            group: fc.constantFrom('selection', 'canvas', 'node', 'search'), always: fc.boolean() });
        fc.assert(fc.property(fc.array(entry, { maxLength: 30 }), items => {
            const before = structuredClone(items);
            const result = rankPalette(items, '');
            expect(result).toHaveLength(items.length);
            expect(result.filter(item => item.always)).toEqual(items.filter(item => item.always));
            expect(result.slice(result.filter(item => !item.always).length).every(item => item.always)).toBe(true);
            expect(new Set(result)).toEqual(new Set(items));
            expect(items).toEqual(before);
            expect(rankPalette(result, '')).toEqual(result);
        }), options);
    });

    it('has bounded scores and normalizes query whitespace', () => {
        fc.assert(fc.property(fc.string(), fc.string(), (text, query) => {
            const score = scoreMatch(text, query);
            expect(scoreMatch(text, `  ${query}  `)).toBe(score);
            if (score !== null) {
                expect(score).toBeGreaterThanOrEqual(1);
                expect(score).toBeLessThanOrEqual(100);
            }
        }), options);
    });
});

it('pins the persisted node wire format, including unknown metadata and code-last ordering', () => {
    const node = parseNode(JSON.stringify({ slate: 3, name: 'increment', language: 'python',
        intent: 'Increment café count', contract: 'Return value + 1', context: ['base'],
        examples: ['increment(0) == 1'], describedBy: 'human', locked: true, order: 0,
        imports: ['import math'], uses: ['base'], custom: { enabled: true },
        code: ['def increment(value: int) -> int:', '    return value + 1'] }));
    expect(serializeNode(node)).toMatchSnapshot();
});
