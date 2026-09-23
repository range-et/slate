import { describe, expect, it } from 'vitest';

import { AdapterError, parseModule, PythonAdapter } from '../vscode-extension/src/python_adapter';

const annotatedSource = `## @slate v=2 id=service-id owner=core
## intent: Provide values
## contract: Never return an empty string
## depends-on: repository-id
## example: fetch(1)
## locked: false
## custom: keep-me
## @slate-end
@registered
class Service:
    @staticmethod
    async def fetch(
        value: int,
    ) -> str:
        def normalize(raw: str) -> str:
            return raw.strip()
        return "😀"
`;

describe('TypeScript Python adapter', () => {
    it('indexes decorated, async, nested units with durable annotations and UTF-16 ranges', () => {
        const result = parseModule(annotatedSource, 'src/service.py');

        expect(result.valid).toBe(true);
        expect(result.units.map(unit => [unit.kind, unit.qualifiedName])).toEqual([
            ['class', 'Service'],
            ['method', 'Service.fetch'],
            ['nested_function', 'Service.fetch.normalize'],
        ]);
        const service = result.units[0];
        const fetch = result.units[1];
        expect(service.id).toBe('service-id');
        expect(service.annotation).toMatchObject({
            version: 2,
            intent: 'Provide values',
            dependencies: ['repository-id'],
            examples: ['fetch(1)'],
            unknown: { tag: { owner: 'core' }, fields: { custom: ['keep-me'] } },
        });
        expect(service.decorators).toEqual(['registered']);
        expect(fetch).toMatchObject({
            async: true,
            parameters: 'value: int,\n',
            returnAnnotation: 'str',
            decorators: ['staticmethod'],
        });
        expect(service.ranges.declaration.end).toEqual({ line: 16, character: 19 });
    });

    it('does not interpret annotation markers inside strings and rejects invalid Python', () => {
        const valid = parseModule('def text() -> str:\n    return "## @slate v=2 id=fake"\n', 'text.py');
        expect(valid.units[0].identity).toBe('provisional');

        const invalid = parseModule('def broken(:\n    pass\n', 'broken.py');
        expect(invalid.valid).toBe(false);
        expect(invalid.units).toEqual([]);
        expect(invalid.diagnostics[0].code).toBe('python-syntax');
    });

    it('adopts a provisional unit and preserves unknown fields when updating it', async () => {
        const adapter = new PythonAdapter();
        const source = 'def greet(name: str) -> str:\n    return f"Hello {name}"\n';
        const parsed = await adapter.parseModule(source, 'greet.py');
        const adopted = await adapter.adoptUnit({
            source,
            path: 'greet.py',
            expectedHash: parsed.sourceHash,
            unitId: parsed.units[0].id,
            annotation: {
                id: 'greet-id',
                intent: 'Greet one person',
                locked: false,
                unknown: { tag: { owner: 'ui' }, fields: { note: ['retain'] } },
            },
        });
        expect(adopted.proposedSource).toContain('## @slate v=2 id=greet-id owner=ui');
        expect(adopted.parsed.units[0].id).toBe('greet-id');

        const updated = await adapter.updateAnnotation({
            source: adopted.proposedSource,
            path: 'greet.py',
            expectedHash: adopted.proposedSourceHash,
            unitId: 'greet-id',
            annotation: {
                ...adopted.parsed.units[0].annotation,
                contract: 'Return visible text',
            },
        });
        expect(updated.proposedSource).toContain('## note: retain');
        expect(updated.proposedSource).toContain('## contract: Return visible text');
    });

    it('inserts typed stubs and rejects untyped signatures or stale source', async () => {
        const adapter = new PythonAdapter();
        const parsed = await adapter.parseModule('', 'empty.py');
        const inserted = await adapter.insertStub({
            source: '',
            path: 'empty.py',
            expectedHash: parsed.sourceHash,
            signature: 'def total(values: list[int]) -> int',
            annotation: { id: 'total-id', intent: 'Sum values' },
        });
        expect(inserted.proposedSource).toContain('def total(values: list[int]) -> int:');
        expect(inserted.parsed.units[0].id).toBe('total-id');

        await expect(adapter.insertStub({
            source: '', path: 'empty.py', expectedHash: parsed.sourceHash,
            signature: 'def total(values) -> int', annotation: { id: 'bad' },
        })).rejects.toThrow('requires a type annotation');
        await expect(adapter.insertStub({
            source: '', path: 'empty.py', expectedHash: 'sha256:stale',
            signature: 'def total(values: list[int]) -> int', annotation: { id: 'bad' },
        })).rejects.toBeInstanceOf(AdapterError);
    });

    it('replaces only the function code while preserving its annotation and decorators', async () => {
        const adapter = new PythonAdapter();
        const source = `## @slate v=2 id=fetch-id\n## locked: false\n## @slate-end\n@cache\ndef fetch(value: int) -> int:\n    return value\n`;
        const parsed = await adapter.parseModule(source, 'fetch.py');
        const changed = await adapter.replaceUnit({
            source,
            path: 'fetch.py',
            expectedHash: parsed.sourceHash,
            unitId: 'fetch-id',
            replacement: 'def fetch(value: int) -> int:\n    return value + 1',
        });
        expect(changed.proposedSource).toContain('## @slate v=2 id=fetch-id');
        expect(changed.proposedSource).toContain('@cache\ndef fetch');
        expect(changed.proposedSource).toContain('return value + 1');

        await expect(adapter.replaceUnit({
            source,
            path: 'fetch.py',
            expectedHash: parsed.sourceHash,
            unitId: 'fetch-id',
            replacement: 'side_effect = True\ndef fetch(value: int) -> int:\n    return value + 1',
        })).rejects.toThrow('exactly one valid function');
    });
});
