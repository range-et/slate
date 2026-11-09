import { describe, expect, it } from 'vitest';

import { rankPalette, scoreMatch, type Rankable } from '../src/harness/palette';

const item = (label: string, group: Rankable['group'] = 'node', extra: Partial<Rankable> = {}): Rankable => ({ label, group, ...extra });

describe('palette ranking', () => {
    it('ranks prefix over word-start over substring over subsequence', () => {
        const items = [item('s_c_o_r_e_x'), item('rescore'), item('normalize_score'), item('scorer'), item('clamp')];
        expect(rankPalette(items, 'score').map(entry => entry.label)).toEqual(['scorer', 'normalize_score', 'rescore', 's_c_o_r_e_x']);
    });

    it('matches intent keywords and signature details, but below an equal label match', () => {
        const items = [
            item('clamp', 'node', { keywords: 'Clamp an integer to bounds', detail: 'def clamp(value: int) -> int' }),
            item('bounds', 'node'),
        ];
        expect(rankPalette(items, 'bounds').map(entry => entry.label)).toEqual(['bounds', 'clamp']);
        expect(rankPalette(items, 'value').map(entry => entry.label)).toEqual(['clamp']);
    });

    it('orders ties by group so actions on the selection come before canvas actions and nodes', () => {
        const items = [item('Generate', 'node'), item('Generate', 'canvas'), item('Generate', 'selection')];
        expect(rankPalette(items, 'gen').map(entry => entry.group)).toEqual(['selection', 'canvas', 'node']);
    });

    it('keeps always-on items last regardless of the query and drops non-matches', () => {
        const items = [item('Search code for “zzz”', 'search', { always: true }), item('clamp'), item('fit view', 'canvas')];
        expect(rankPalette(items, 'zzz').map(entry => entry.label)).toEqual(['Search code for “zzz”']);
        expect(rankPalette(items, '').map(entry => entry.label)).toEqual(['fit view', 'clamp', 'Search code for “zzz”']);
    });
});


describe('mutation regressions for palette boundaries', () => {
    it('requires distinct ordered character occurrences', () => {
        expect(scoreMatch('abc', 'aac')).toBeNull();
        expect(scoreMatch('abc', 'ca')).toBeNull();
        expect(scoreMatch('xxa_b_c', 'abc')).toBe(38);
    });
    it('caps long prefix and subsequence penalties', () => {
        expect(scoreMatch('a' + 'x'.repeat(100), 'a')).toBe(98);
        expect(scoreMatch('a' + 'x'.repeat(100) + 'b', 'ab')).toBe(20);
    });
    it('weights equal keyword and detail matches below label matches', () => {
        const label = item('run');
        const keywords = item('keyword', 'node', { keywords: 'run' });
        const detail = item('detail', 'node', { detail: 'run' });
        expect(rankPalette([detail, keywords, label], 'run')).toEqual([label, keywords, detail]);
        expect(rankPalette([keywords, detail], 'missing')).toEqual([]);
    });
    it('orders all four groups on equal scores', () => {
        const items = ['search', 'node', 'canvas', 'selection'].map(group => item('run', group as Rankable['group']));
        expect(rankPalette(items, 'run').map(entry => entry.group)).toEqual(['selection', 'canvas', 'node', 'search']);
    });
});


describe('ranking entries with multiple matching fields', () => {
    it.each([
        ['label', item('run', 'node', { keywords: 'run', detail: 'run' }), item('run task')],
        ['keywords', item('a_run', 'node', { keywords: 'run', detail: 'r_u_n' }), item('rerun')],
        ['detail', item('r____u____n', 'node', { detail: 'run' }), item('r_u_n')],
    ])('uses the strongest %s match instead of penalizing weaker matching fields', (_field, target, competitor) => {
        // Each competitor scores between the target's best and worst fields.
        // Choosing the minimum instead of the maximum reverses the visible order.
        expect(rankPalette([competitor, target], 'run')).toEqual([target, competitor]);
        expect(rankPalette([target, competitor], 'run')).toEqual([target, competitor]);
        expect(rankPalette([target, competitor], 'absent')).toEqual([]);
    });
});
