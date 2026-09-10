import { describe, expect, it } from 'vitest';

import { demoSnapshot } from '../src/harness/demo';
import {
    legacyContextEdges,
    readProjectBinding,
    readProjectLayout,
    writeProjectLayout,
} from '../vscode-extension/src/legacy_project';

describe('legacy project context migration', () => {
    it('maps an unambiguous title-based @ reference onto source unit IDs', () => {
        const project = JSON.stringify({
            docs: [{
                title: 'calculator',
                destination: '',
                cards: [{ title: 'main', links: ['run'] }],
            }],
        });

        expect(legacyContextEdges(project, demoSnapshot.documents)).toEqual([{
            sourceId: 'durable-run',
            targetId: 'provisional-main',
            kind: 'context',
        }]);
    });

    it('does not guess when a referenced name is ambiguous', () => {
        const documents = structuredClone(demoSnapshot.documents);
        documents[1].units.push({ ...documents[0].units[0], id: 'other-run' });
        const project = JSON.stringify({
            docs: [{ title: 'calculator', cards: [{ title: 'main', links: ['run'] }] }],
        });

        expect(legacyContextEdges(project, documents)).toEqual([]);
    });

    it('ignores malformed project JSON', () => {
        expect(legacyContextEdges('{', demoSnapshot.documents)).toEqual([]);
    });

    it('round-trips finite layout points while rejecting malformed points', () => {
        const raw = JSON.stringify({ name: 'demo', layout: {
            keep: { x: 1, y: 2 },
            reject: { x: 'left', y: 3 },
        } }, null, 2) + '\n';
        const updated = writeProjectLayout(raw, { moved: { x: 40, y: -5 } });

        expect(readProjectLayout(updated!)).toEqual({
            keep: { x: 1, y: 2 },
            moved: { x: 40, y: -5 },
        });
        expect(updated?.endsWith('\n')).toBe(true);
    });

    it('reads a relative v2 project root but refuses absolute bindings', () => {
        expect(readProjectBinding('{"name":"api","root":"packages/api"}'))
            .toEqual({ name: 'api', root: 'packages/api' });
        expect(readProjectBinding('{"root":"/tmp/elsewhere"}')).toEqual({ root: '.' });
    });
});
