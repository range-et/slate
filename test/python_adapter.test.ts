import { describe, expect, it } from 'vitest';

import { AdapterError, parseModule, PythonAdapter } from '../vscode-extension/src/python_adapter';

const serviceSource = `# A plain comment, even one that looks like ## @slate id=old
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
    it('indexes decorated, async, nested units; the node definition is durable and keeps UTF-16 ranges', () => {
        const result = parseModule(serviceSource, 'slate/nodes/svc/Service.json', 'svc/Service');

        expect(result.valid).toBe(true);
        expect(result.units.map(unit => [unit.kind, unit.qualifiedName, unit.identity])).toEqual([
            ['class', 'Service', 'durable'],
            ['method', 'Service.fetch', 'provisional'],
            ['nested_function', 'Service.fetch.normalize', 'provisional'],
        ]);
        const [service, fetch] = result.units;
        expect(service.id).toBe('svc/Service');
        expect(service.annotation).toBeNull();
        expect(service.decorators).toEqual(['registered']);
        expect(fetch).toMatchObject({
            async: true,
            parameters: 'value: int,\n',
            returnAnnotation: 'str',
            decorators: ['staticmethod'],
        });
        expect(service.ranges.declaration.end).toEqual({ line: 9, character: 19 });
        expect(parseModule(serviceSource, 'other.py').units[0].identity).toBe('provisional');
    });

    it('rejects invalid Python', () => {
        const invalid = parseModule('def broken(:\n    pass\n', 'broken.py');
        expect(invalid.valid).toBe(false);
        expect(invalid.units).toEqual([]);
        expect(invalid.diagnostics[0].code).toBe('python-syntax');
    });

    it('replaces only the function code while preserving its decorators', async () => {
        const adapter = new PythonAdapter();
        const source = `@cache\ndef fetch(value: int) -> int:\n    return value\n`;
        const parsed = await adapter.parseModule(source, 'fetch.json', 'fetch');
        const changed = await adapter.replaceUnit({
            source,
            path: 'fetch.json',
            nodeId: 'fetch',
            expectedHash: parsed.sourceHash,
            unitId: 'fetch',
            replacement: 'def fetch(value: int) -> int:\n    return value + 1',
        });
        expect(changed.proposedSource).toBe('@cache\ndef fetch(value: int) -> int:\n    return value + 1\n');

        await expect(adapter.replaceUnit({
            source,
            path: 'fetch.json',
            nodeId: 'fetch',
            expectedHash: parsed.sourceHash,
            unitId: 'fetch',
            replacement: 'side_effect = True\ndef fetch(value: int) -> int:\n    return value + 1',
        })).rejects.toThrow('exactly one valid function');
        await expect(adapter.replaceUnit({
            source, path: 'fetch.json', nodeId: 'fetch', expectedHash: 'sha256:stale', unitId: 'fetch', replacement: 'def fetch(value: int) -> int:\n    return 1',
        })).rejects.toBeInstanceOf(AdapterError);
    });
});
