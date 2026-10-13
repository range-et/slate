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
});
