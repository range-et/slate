import { describe, expect, it } from 'vitest';

import { rankPalette, type Rankable } from '../src/harness/palette';

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
