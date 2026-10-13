// Ranking for the Cmd+K palette and the searchable context picker.

export type PaletteGroup = 'selection' | 'canvas' | 'node' | 'search';

export interface Rankable {
    label: string;
    detail?: string;
    keywords?: string;
    group: PaletteGroup;
    /** Always shown last, whatever the query (e.g. "Search code for …"). */
    always?: boolean;
}

const GROUP_ORDER: PaletteGroup[] = ['selection', 'canvas', 'node', 'search'];
const WORD_BREAK = /[\s_./:\-()]/;

/** Higher is better; null means no match. */
export function scoreMatch(text: string, query: string): number | null {
    const haystack = text.toLowerCase();
    const needle = query.trim().toLowerCase();
    if (!needle) return 1;
    if (haystack.startsWith(needle)) return 100 - Math.min(20, haystack.length - needle.length) / 10;
    const index = haystack.indexOf(needle);
    if (index > 0 && WORD_BREAK.test(haystack[index - 1])) return 80;
    if (index > 0) return 60;
    // Subsequence: every query character in order; tighter spans score higher.
    let position = -1;
    let first = -1;
    for (const character of needle) {
        position = haystack.indexOf(character, position + 1);
        if (position < 0) return null;
        if (first < 0) first = position;
    }
    return 40 - Math.min(20, position - first - needle.length + 1);
}

export function rankPalette<T extends Rankable>(items: T[], query: string): T[] {
    const scored: Array<{ item: T; score: number }> = [];
    for (const item of items) {
        if (item.always) continue;
        const candidates = [
            scoreMatch(item.label, query),
            item.keywords ? (scoreMatch(item.keywords, query) ?? -1) * 0.9 : null,
            item.detail ? (scoreMatch(item.detail, query) ?? -1) * 0.5 : null,
        ].filter((value): value is number => value !== null && value >= 0);
        if (candidates.length > 0) scored.push({ item, score: Math.max(...candidates) });
    }
    scored.sort((left, right) => right.score - left.score
        || GROUP_ORDER.indexOf(left.item.group) - GROUP_ORDER.indexOf(right.item.group)
        || left.item.label.localeCompare(right.item.label));
    return [...scored.map(entry => entry.item), ...items.filter(item => item.always)];
}
