import type { HarnessDocument, ParsedUnit } from './harness_protocol';

export type SearchResult = {
    unitId: string;
    path: string;
    qualifiedName: string;
    signature: string | null;
    snippet: string;
    reason: 'exact name' | 'name' | 'signature' | 'annotation' | 'source' | 'path';
    score: number;
};

function annotationText(unit: ParsedUnit): string {
    if (!unit.annotation) return '';
    const values = [unit.annotation.intent, unit.annotation.contract];
    return values.filter(value => typeof value === 'string').join('\n');
}

function sourceSnippet(source: string, unit: ParsedUnit, query: string): string {
    const lines = source.split(/\r?\n/);
    const start = unit.ranges.declaration.start.line;
    const end = Math.min(unit.ranges.declaration.end.line, lines.length - 1);
    for (let line = start; line <= end; line++) {
        if (lines[line].toLowerCase().includes(query)) return lines[line].trim().slice(0, 180);
    }
    return (unit.signature ?? unit.qualifiedName).slice(0, 180);
}

export function searchUnits(
    documents: HarnessDocument[],
    sources: ReadonlyMap<string, string>,
    rawQuery: string,
    limit = 50,
): SearchResult[] {
    const query = rawQuery.trim().toLowerCase();
    if (!query) return [];
    const results: SearchResult[] = [];

    for (const document of documents) {
        const source = sources.get(document.path) ?? '';
        for (const unit of document.units) {
            const name = unit.name.toLowerCase();
            const qualifiedName = unit.qualifiedName.toLowerCase();
            const signature = (unit.signature ?? '').toLowerCase();
            const annotation = annotationText(unit).toLowerCase();
            const declarationLines = source.split(/\r?\n/).slice(
                unit.ranges.declaration.start.line,
                unit.ranges.declaration.end.line + 1,
            ).join('\n').toLowerCase();
            let score = 0;
            let reason: SearchResult['reason'] | null = null;
            if (unit.id.toLowerCase() === query || name === query || qualifiedName === query) {
                score = 100;
                reason = 'exact name';
            } else if (name.startsWith(query) || qualifiedName.startsWith(query)) {
                score = 90;
                reason = 'name';
            } else if (qualifiedName.includes(query)) {
                score = 82;
                reason = 'name';
            } else if (signature.includes(query)) {
                score = 72;
                reason = 'signature';
            } else if (annotation.includes(query)) {
                score = 62;
                reason = 'annotation';
            } else if (declarationLines.includes(query)) {
                score = 52;
                reason = 'source';
            } else if (document.path.toLowerCase().includes(query)) {
                score = 42;
                reason = 'path';
            }
            if (!reason) continue;
            results.push({
                unitId: unit.id,
                path: document.path,
                qualifiedName: unit.qualifiedName,
                signature: unit.signature ?? null,
                snippet: reason === 'annotation'
                    ? annotationText(unit).split('\n').find(line => line.toLowerCase().includes(query))?.slice(0, 180) ?? ''
                    : sourceSnippet(source, unit, query),
                reason,
                score,
            });
        }
    }

    return results.sort((left, right) =>
        right.score - left.score
        || left.qualifiedName.localeCompare(right.qualifiedName)
        || left.path.localeCompare(right.path)
        || left.unitId.localeCompare(right.unitId)
    ).slice(0, limit);
}
