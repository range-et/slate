/**
 * Pure unit tests for src/slate_annotations.js — the annotation block
 * emitter / parser that powers compile → rehydrate → compile round-trip
 * (issue #53).
 *
 * Why these are headless and fixture-free: the annotation format is the
 * one piece of "wire protocol" between compile and rehydrate. If it
 * silently changes shape we lose round-trip on every existing project
 * that's already been compiled. So we lock down the format here.
 */
import { describe, it, expect } from 'vitest';
import {
    emitAnnotation,
    parseAnnotations,
    ANNOTATION_TAG,
    ANNOTATION_PROMPT_PREFIX,
} from '../src/slate_annotations.js';

const card = (overrides = {}) => ({
    id: 'card-uuid-123',
    title: 'add',
    kind: 'body',
    prompt: 'Return a + b. Pure, no side effects.',
    ...overrides,
});
const doc = (overrides = {}) => ({ title: 'operations', ...overrides });

describe('emitAnnotation', () => {
    it('emits the canonical tag line with all four fields', () => {
        const out = emitAnnotation(card(), doc());
        expect(out.split('\n')[0]).toBe(
            '## @slate id=card-uuid-123 kind=body title=add doc=operations'
        );
    });

    it('emits one ## prompt: line per prompt line, in order', () => {
        const out = emitAnnotation(
            card({ prompt: 'first line\nsecond line\nthird' }),
            doc(),
        );
        const lines = out.split('\n');
        expect(lines[1]).toBe('## prompt: first line');
        expect(lines[2]).toBe('## prompt: second line');
        expect(lines[3]).toBe('## prompt: third');
    });

    it('omits the prompt block entirely when prompt is empty', () => {
        const out = emitAnnotation(card({ prompt: '' }), doc());
        expect(out).toBe(
            '## @slate id=card-uuid-123 kind=body title=add doc=operations'
        );
        expect(out).not.toContain('## prompt:');
    });

    it('handles header kind and missing doc title gracefully', () => {
        const out = emitAnnotation(card({ kind: 'header', title: '__header__', prompt: '' }), { title: '' });
        expect(out).toBe(
            '## @slate id=card-uuid-123 kind=header title=__header__ doc='
        );
    });

    it('returns "" when card is null/undefined', () => {
        expect(emitAnnotation(null, doc())).toBe('');
        expect(emitAnnotation(undefined, doc())).toBe('');
    });

    it('normalizes CRLF in prompts to LF', () => {
        const out = emitAnnotation(card({ prompt: 'a\r\nb\r\nc' }), doc());
        expect(out.split('\n').slice(1)).toEqual([
            '## prompt: a',
            '## prompt: b',
            '## prompt: c',
        ]);
    });
});

describe('parseAnnotations', () => {
    it('returns [] for empty / null source', () => {
        expect(parseAnnotations('')).toEqual([]);
        expect(parseAnnotations(null)).toEqual([]);
        expect(parseAnnotations(undefined)).toEqual([]);
    });

    it('produces a prelude section for content before the first annotation', () => {
        const src = [
            '# Compiled from slate doc: operations',
            'from typing import Callable',
            '',
            '## @slate id=u1 kind=body title=add doc=operations',
            'def add(a, b):',
            '    return a + b',
        ].join('\n');
        const parsed = parseAnnotations(src);
        expect(parsed).toHaveLength(2);
        expect(parsed[0].kind).toBe('prelude');
        expect(parsed[0].id).toBe(null);
        expect(parsed[0].body).toBe(
            '# Compiled from slate doc: operations\nfrom typing import Callable'
        );
    });

    it('parses multiple sections in source order with id/kind/title/doc', () => {
        const src = [
            '## @slate id=u1 kind=body title=add doc=operations',
            'def add(a, b):',
            '    return a + b',
            '',
            '## @slate id=u2 kind=body title=subtract doc=operations',
            'def subtract(a, b):',
            '    return a - b',
        ].join('\n');
        const parsed = parseAnnotations(src);
        expect(parsed).toHaveLength(2);
        expect(parsed[0].id).toBe('u1');
        expect(parsed[0].title).toBe('add');
        expect(parsed[0].kind).toBe('body');
        expect(parsed[0].doc).toBe('operations');
        expect(parsed[0].body).toBe('def add(a, b):\n    return a + b');
        expect(parsed[1].id).toBe('u2');
        expect(parsed[1].title).toBe('subtract');
        expect(parsed[1].body).toBe('def subtract(a, b):\n    return a - b');
    });

    it('joins multiple ## prompt: lines into a single prompt with \\n', () => {
        const src = [
            '## @slate id=u1 kind=body title=add doc=operations',
            '## prompt: line one',
            '## prompt: line two',
            '## prompt: line three',
            'def add(a, b):',
            '    return a + b',
        ].join('\n');
        const parsed = parseAnnotations(src);
        expect(parsed[0].prompt).toBe('line one\nline two\nline three');
        expect(parsed[0].body).toBe('def add(a, b):\n    return a + b');
    });

    it('round-trips: emit → parse recovers the same fields', () => {
        const c = card({
            id: 'rt-1',
            title: 'multiply',
            kind: 'body',
            prompt: 'Multiply two floats.\nReturn the product.',
        });
        const d = doc({ title: 'operations' });
        const annotated = emitAnnotation(c, d);
        const body = 'def multiply(a, b):\n    return a * b';
        const src = annotated + '\n' + body;
        const parsed = parseAnnotations(src);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].id).toBe('rt-1');
        expect(parsed[0].title).toBe('multiply');
        expect(parsed[0].kind).toBe('body');
        expect(parsed[0].doc).toBe('operations');
        expect(parsed[0].prompt).toBe('Multiply two floats.\nReturn the product.');
        expect(parsed[0].body).toBe(body);
    });

    it('tolerates CRLF source', () => {
        const src = '## @slate id=u1 kind=body title=add doc=operations\r\ndef add(a, b):\r\n    return a + b\r\n';
        const parsed = parseAnnotations(src);
        expect(parsed[0].id).toBe('u1');
        expect(parsed[0].body).toBe('def add(a, b):\n    return a + b');
    });

    it('returns [] of sections (no prelude entry) when source has no annotations', () => {
        const src = 'def add(a, b):\n    return a + b\n';
        const parsed = parseAnnotations(src);
        // Only a prelude (legacy file) — caller can detect this via id===null + kind==='prelude'.
        expect(parsed).toHaveLength(1);
        expect(parsed[0].kind).toBe('prelude');
        expect(parsed[0].id).toBe(null);
        expect(parsed[0].body).toBe('def add(a, b):\n    return a + b');
    });

    it('tolerates unknown extra key=value pairs in the tag (forward-compat)', () => {
        const src = '## @slate id=u1 kind=body title=add doc=operations future=42 more=hi\ndef add(a, b):\n    return a + b';
        const parsed = parseAnnotations(src);
        expect(parsed[0].id).toBe('u1');
        expect(parsed[0].title).toBe('add');
        expect(parsed[0]).not.toHaveProperty('future');
    });
});

describe('emit/parse fixed point', () => {
    it('parsing the output of emitAnnotation gives back input fields for all kinds', () => {
        const cases = [
            card({ id: 'h', kind: 'header', title: '__header__', prompt: '' }),
            card({ id: 'b1', kind: 'body', title: 'add', prompt: 'do add' }),
            card({ id: 'b2', kind: 'body', title: 'sub', prompt: '' }),
            card({ id: 'c1', kind: 'class', title: 'Calc', prompt: 'a class' }),
        ];
        const d = doc({ title: 'operations' });
        for (const c of cases) {
            const src = emitAnnotation(c, d) + '\npass';
            const parsed = parseAnnotations(src)[0];
            expect(parsed.id).toBe(c.id);
            expect(parsed.kind).toBe(c.kind);
            expect(parsed.title).toBe(c.title);
            expect(parsed.doc).toBe(d.title);
            expect(parsed.prompt).toBe(c.prompt);
        }
    });
});
