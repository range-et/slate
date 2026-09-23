import { describe, expect, it } from 'vitest';

import { demoSnapshot } from '../src/harness/demo';
import { searchUnits } from '../vscode-extension/src/search';

describe('harness-owned search', () => {
    const sources = new Map([
        ['calculator.py', `${'\n'.repeat(12)}    return execute(config)\n`],
        ['operations.py', ''],
    ]);

    it('ranks exact names above source matches with stable provenance', () => {
        const results = searchUnits(demoSnapshot.documents, sources, 'run');
        expect(results[0]).toMatchObject({
            qualifiedName: 'run',
            path: 'calculator.py',
            reason: 'exact name',
            score: 100,
        });
    });

    it('searches dirty-buffer source text rather than only graph labels', () => {
        const results = searchUnits(demoSnapshot.documents, sources, 'execute(config)');
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ qualifiedName: 'run', reason: 'source' });
        expect(results[0].snippet).toBe('return execute(config)');
    });

    it('returns no broad fallback for an empty query', () => {
        expect(searchUnits(demoSnapshot.documents, sources, '  ')).toEqual([]);
    });
});
