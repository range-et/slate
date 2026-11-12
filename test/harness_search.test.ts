import { describe, expect, it } from 'vitest';

import { demoSnapshot } from '../src/harness/demo';
import { searchUnits } from '../vscode-extension/src/search';

describe('harness-owned search', () => {
    const sources = new Map(demoSnapshot.documents.map(document => [document.path, document.source ?? '']));

    it('ranks exact names above source matches with stable provenance', () => {
        const results = searchUnits(demoSnapshot.documents, sources, 'clamp');
        expect(results[0]).toMatchObject({
            qualifiedName: 'clamp',
            path: 'slate/nodes/clamp.json',
            reason: 'exact name',
            score: 100,
        });
    });

    it('searches node code rather than only graph labels', () => {
        const results = searchUnits(demoSnapshot.documents, sources, 'min(value');
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ qualifiedName: 'clamp', reason: 'source' });
        expect(results[0].snippet).toBe('return max(lower, min(value, upper))');
    });

    it('returns no broad fallback for an empty query', () => {
        expect(searchUnits(demoSnapshot.documents, sources, '  ')).toEqual([]);
    });

    it('falls back to an empty snippet when a multiline query spans annotation lines', () => {
        const results = searchUnits(demoSnapshot.documents, sources, 'inclusive lower and upper bounds\nraise valueerror');
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ unitId: 'clamp', reason: 'annotation', snippet: '' });
    });
});

it('uses name, path, and durable ID to order tied search results before applying a limit', () => {
    const document = structuredClone(demoSnapshot.documents[0]);
    const unit = document.units[0];
    const make = (path: string, id: string, qualifiedName: string) => ({
        ...document, path, units: [{ ...unit, id, name: 'same', qualifiedName, signature: null, annotation: null }],
    });
    const documents = [make('b.json', 'z', 'Zulu'), make('b.json', 'b', 'Alpha'),
        make('a.json', 'z', 'Alpha'), make('b.json', 'a', 'Alpha')];
    const before = structuredClone(documents);
    expect(searchUnits(documents, new Map(), 'same').map(hit => [hit.qualifiedName, hit.path, hit.unitId, hit.snippet])).toEqual([
        ['Alpha', 'a.json', 'z', 'Alpha'], ['Alpha', 'b.json', 'a', 'Alpha'],
        ['Alpha', 'b.json', 'b', 'Alpha'], ['Zulu', 'b.json', 'z', 'Zulu'],
    ]);
    expect(searchUnits(documents, new Map(), 'same', 2).map(hit => hit.unitId)).toEqual(['z', 'a']);
    expect(documents).toEqual(before);
});
