import type { HarnessSnapshot, HarnessUnit } from './types';

const range = (line: number) => ({
    start: { line, character: 4 },
    end: { line, character: 20 },
});

function nodeDocument(
    nodeId: string,
    source: string,
    units: HarnessUnit[],
    diagnostics: HarnessSnapshot['documents'][number]['diagnostics'] = [],
): HarnessSnapshot['documents'][number] {
    return {
        id: `node:${nodeId}`, path: `slate/nodes/${nodeId}.json`, valid: true, stale: false,
        sourceHash: `sha256:${nodeId}`, version: null, diagnostics, units, source,
    };
}

function nodeUnit(
    id: string,
    signature: string,
    annotation: Record<string, unknown> | null,
    kind: HarnessUnit['kind'] = 'function',
    parentId: string | null = null,
): HarnessUnit {
    const name = id.split('.').pop()!.split('/').pop()!;
    return {
        id, identity: parentId ? 'provisional' : 'durable', kind, name,
        qualifiedName: parentId ? `${parentId.split('/').pop()}.${name}` : name,
        parentId, ranges: { name: range(0), declaration: { start: { line: 0, character: 0 }, end: { line: 50, character: 0 } } },
        annotation, decorators: [], signature: kind.includes('class') ? undefined : signature,
        ...(kind.includes('class') ? {} : { parameters: signature.slice(signature.indexOf('(') + 1, signature.lastIndexOf(')')), returnAnnotation: 'int' }),
    } as HarnessUnit;
}

const clampCode = 'def clamp(value: int, lower: int, upper: int) -> int:\n    return max(lower, min(value, upper))\n';
const normalizeCode = 'def normalize_score(score: int, maximum: int) -> int:\n    raise NotImplementedError\n';

export const demoSnapshot: HarnessSnapshot = {
    revision: 1,
    projectName: 'llama-demo',
    notes: [{
        id: 'board-note-port',
        title: 'Port the grading script next',
        body: 'Split grade.py into nodes, then describe each one with llama.',
        attachedTo: null,
    }],
    layout: { 'board-note-port': { x: 760, y: 60 } },
    documents: [
        nodeDocument('clamp', clampCode, [nodeUnit('clamp', 'def clamp(value: int, lower: int, upper: int) -> int', {
            intent: 'Clamp an integer to the inclusive lower and upper bounds', contract: 'Raise ValueError when lower > upper',
            dependencies: [], examples: ['clamp(5, 0, 3) == 3'], locked: true,
        })]),
        nodeDocument('scoring/normalize_score', normalizeCode, [nodeUnit('scoring/normalize_score', 'def normalize_score(score: int, maximum: int) -> int', {
            intent: 'Convert a score to an integer percentage from 0 through 100', contract: '',
            dependencies: ['clamp'], examples: [], locked: false,
        })]),
        { ...nodeDocument('scoring/_prelude', '# Letter grade cutoffs.\nCUTOFFS = {90: "A", 80: "B", 70: "C"}\n', []), nodeKind: 'prelude' },
        nodeDocument('scoring/Grader', 'class Grader:\n    def grade(self, score: int) -> int:\n        ...\n', [
            nodeUnit('scoring/Grader', '', { intent: 'Assign letter grades', contract: '', dependencies: [], examples: [], locked: false }, 'class'),
            nodeUnit('scoring/Grader.grade', 'def grade(self, score: int) -> int', null, 'method', 'scoring/Grader'),
        ], [{ code: 'node-extra-statements', message: 'code must contain exactly one definition.', range: range(0) }]),
    ],
};
