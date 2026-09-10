import type { HarnessSnapshot, HarnessUnit } from './types';

const range = (line: number) => ({
    start: { line, character: 4 },
    end: { line, character: 20 },
});

function unit(
    id: string,
    kind: HarnessUnit['kind'],
    name: string,
    qualifiedName: string,
    line: number,
    parentId: string | null = null,
): HarnessUnit {
    return {
        id,
        identity: id.startsWith('durable') ? 'durable' : 'provisional',
        kind,
        name,
        qualifiedName,
        parentId,
        ranges: { name: range(line), declaration: range(line), annotation: null, full: range(line) },
        annotation: null,
        decorators: [],
        signature: kind.includes('class') ? undefined : `def ${name}(value: int) -> int`,
    };
}

export const demoSnapshot: HarnessSnapshot = {
    revision: 1,
    projectName: 'calculator',
    documents: [
        {
            id: 'document:calculator.py', path: 'calculator.py', valid: true, stale: false,
            sourceHash: 'sha256:demo', version: 1, diagnostics: [],
            units: [
                unit('durable-run', 'function', 'run', 'run', 12),
                {
                    ...unit('provisional-main', 'function', 'main', 'main', 28),
                    annotation: { dependencies: ['durable-run'] },
                },
            ],
        },
        {
            id: 'document:operations.py', path: 'operations.py', valid: true, stale: false,
            sourceHash: 'sha256:demo', version: null, diagnostics: [],
            units: [
                unit('durable-operations', 'class', 'Operations', 'Operations', 7),
                unit('durable-add', 'method', 'add', 'Operations.add', 10, 'durable-operations'),
                unit('provisional-divide', 'method', 'divide', 'Operations.divide', 18, 'durable-operations'),
            ],
        },
    ],
};
