import { describe, expect, it } from 'vitest';

import { demoSnapshot } from '../src/harness/demo';
import { buildNodeHealthReport, diffNodeCode, normalizeNodeCode } from '../src/harness/health';
import { indexNode } from '../vscode-extension/src/slate_folder';

describe('Node health report and code normalization', () => {
    it('normalizes comments, docstrings, whitespace, and alpha-renamed function/parameter names', () => {
        const left = [
            'def clamp_score(val: int, lo: int, hi: int) -> int:',
            '    """Clamp val into [lo, hi]."""',
            '    # Ensure bounds are respected',
            '    return max(lo, min(val, hi))',
        ].join('\n');
        const right = [
            'def bound_value(x: int, minimum: int, maximum: int) -> int:',
            "    '''",
            '    Multi-line docstring with # hash inside.',
            "    '''",
            '    return max( minimum , min( x, maximum ) )  # trailing comment',
        ].join('\n');

        expect(normalizeNodeCode(left, 'clamp_score', ['val', 'lo', 'hi']))
            .toBe(normalizeNodeCode(right, 'bound_value', ['x', 'minimum', 'maximum']));

        // Preserves # inside string literals and keeps self/cls unrenamed
        const withStringHash = 'def tag(self, label: str) -> str:\n    return f"# {label}" # comment';
        expect(normalizeNodeCode(withStringHash, 'tag', ['self', 'label'])).toContain('"# {_p1}"');
        expect(normalizeNodeCode(withStringHash, 'tag', ['self', 'label'])).toContain('def _fn(self,_p1:str)->str:');
    });

    it('computes line-by-line LCS diffs with 1-based line numbers for unchanged, removed, and added lines', () => {
        const left = 'def f(x: int) -> int:\n    y = x + 1\n    return y\n';
        const right = 'def f(x: int) -> int:\n    y = x + 2\n    z = y * 3\n    return z\n';
        const diff = diffNodeCode(left, right);

        expect(diff).toEqual([
            { kind: 'same', leftLine: 1, rightLine: 1, text: 'def f(x: int) -> int:' },
            { kind: 'remove', leftLine: 2, rightLine: null, text: '    y = x + 1' },
            { kind: 'remove', leftLine: 3, rightLine: null, text: '    return y' },
            { kind: 'add', leftLine: null, rightLine: 2, text: '    y = x + 2' },
            { kind: 'add', leftLine: null, rightLine: 3, text: '    z = y * 3' },
            { kind: 'add', leftLine: null, rightLine: 4, text: '    return z' },
        ]);
    });

    it('identifies unreferenced candidates, distinguishes prompt-only context, and never claims safe to delete', () => {
        const snapshot = structuredClone(demoSnapshot);
        // Remove ref-clamp so clamp is only used as prompt context by scoring/normalize_score, plus called in source.
        // Add an unreferenced node `orphan` that is only used as prompt context by `clamp`.
        const orphan = indexNode('slate/nodes/orphan.json', JSON.stringify({
            slate: 3,
            name: 'orphan',
            intent: 'Helper with no runtime callers',
            code: ['def orphan(value: int) -> int:', '    return value * 2'],
        }), 'python', null).document;
        snapshot.documents.push(orphan);
        snapshot.documents[0].units[0].annotation = {
            ...snapshot.documents[0].units[0].annotation,
            dependencies: ['orphan'],
        };

        const report = buildNodeHealthReport(snapshot);

        // `clamp` is referenced on canvas (ref-clamp) and called in normalize_score; `normalize_score` is in flow `report`.
        // `scoring/Grader` and `orphan` have no flow instances, canvas refs, or calls.
        const unrefIds = report.unreferenced.map(item => item.nodeId);
        expect(unrefIds).toContain('orphan');
        expect(unrefIds).toContain('scoring/Grader');
        expect(unrefIds).not.toContain('clamp');
        expect(unrefIds).not.toContain('scoring/normalize_score');

        const orphanEntry = report.unreferenced.find(item => item.nodeId === 'orphan')!;
        expect(orphanEntry.contextOnlyBy).toEqual(['clamp']);
        expect(report.caveats.some(text => /does not mean safe to delete/i.test(text))).toBe(true);
    });

    it('detects exact duplicates, near duplicates, and dynamic/module import coverage caveats', () => {
        const a = indexNode('slate/nodes/math/clamp_a.json', JSON.stringify({
            slate: 3,
            name: 'clamp_a',
            imports: ['import importlib'],
            code: [
                'def clamp_a(value: int, low: int, high: int) -> int:',
                '    """Docstring A."""',
                '    return max(low, min(value, high))',
            ],
        }), 'python', null).document;

        const b = indexNode('slate/nodes/math/clamp_b.json', JSON.stringify({
            slate: 3,
            name: 'clamp_b',
            code: [
                'def clamp_b(x: int, lo: int, hi: int) -> int:',
                '    # Comment B',
                '    return max(lo, min(x, hi))',
            ],
        }), 'python', null).document;

        const near1 = indexNode('slate/nodes/scoring/scale_a.json', JSON.stringify({
            slate: 3,
            name: 'scale_a',
            imports: ['import math'],
            code: [
                'def scale_a(raw: int, total: int, weight: int) -> int:',
                '    if total <= 0:',
                '        raise ValueError("bad total")',
                '    scaled = (raw * weight) // total',
                '    return max(0, min(scaled, 100))',
            ],
        }), 'python', null).document;

        const near2 = indexNode('slate/nodes/scoring/scale_b.json', JSON.stringify({
            slate: 3,
            name: 'scale_b',
            uses: ['math/clamp_a'],
            code: [
                'def scale_b(score: int, maximum: int, factor: int) -> int:',
                '    if maximum <= 0:',
                '        raise ValueError("bad total")',
                '    scaled = (score * factor) // maximum',
                '    return max(0, min(scaled, 999))',
            ],
        }), 'python', null).document;

        const stub = indexNode('slate/nodes/scoring/stub.json', JSON.stringify({
            slate: 3,
            name: 'stub',
            code: [
                'def stub(x: int) -> int:',
                '    raise NotImplementedError',
            ],
        }), 'python', null).document;

        const report = buildNodeHealthReport({
            revision: 1,
            projectName: 'dup-check',
            documents: [a, b, near1, near2, stub],
        });

        expect(report.exactDuplicates).toEqual([
            expect.objectContaining({ nodeIds: ['math/clamp_a', 'math/clamp_b'] }),
        ]);
        expect(report.nearDuplicates).toEqual([
            expect.objectContaining({ leftId: 'scoring/scale_a', rightId: 'scoring/scale_b' }),
        ]);
        expect(report.nearDuplicates[0].similarity).toBeGreaterThanOrEqual(0.65);
        // `math/clamp_a` is in `near2.uses`, so it is not unreferenced.
        expect(report.unreferenced.map(item => item.nodeId)).not.toContain('math/clamp_a');
        expect(report.caveats.some(c => c.includes('Dynamic import or reflection in math/clamp_a'))).toBe(true);
        expect(report.caveats.some(c => c.includes('Module-style import "import math" in scoring/scale_a'))).toBe(true);
    });
});
