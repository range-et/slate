import { describe, expect, it } from 'vitest';

import { AdapterError, parseModule, PythonAdapter, topLevelBindings } from '../vscode-extension/src/python_adapter';

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

it.each([
    ['  a: int  ', '  a: int  '],
    ['   ', '   '],
    ['a: int,\n    b: str', 'a: int,\n    b: str'],
    ['\n    a: int,\n    b: str,\n', 'a: int,\nb: str,\n'],
    ['\n    a: int,\n\n    b: str,\n', 'a: int,\n\nb: str,\n'],
    ['\n    a: int,\n  \n    b: str,\n', 'a: int,\n\nb: str,\n'],
    ['\n    a: int,\n      b: str', 'a: int,\n  b: str'],
    ['\n    a: int,\n    b: str,\n        ', 'a: int,\nb: str,\n'],
    ['   \n    a: int,\n        ', 'a: int,\n'],
    [' \n\ta: int,\n\t', 'a: int,\n'],
    ['\n\n', '\n'],
    ['\r\n    a: int,\r\n    b: str,\r\n', 'a: int,\nb: str,\n'],
    ['\r    a: int,\r    b: str,\r', 'a: int,\nb: str,\n'],
])('preserves multiline parameter content and meaningful closing-line shape for %j', (parameters, expected) => {
    const parsed = parseModule(`def run(${parameters}) -> int:\n    return 1\n`, 'run.py');
    expect(parsed.valid).toBe(true);
    expect(parsed.units).toHaveLength(1);
    expect(parsed.units[0].parameters).toBe(expected);
    expect(parsed.units[0].signature).toBe(`def run(${expected}) -> int`);
    expect(parsed.units[0].params?.map(param => param.name)).toEqual(parameters.includes('b:') ? ['a', 'b'] : parameters.includes('a:') ? ['a'] : []);
});

it('preserves structured parameter defaults, annotations, positional and variadic kinds', () => {
    const parsed = parseModule('def run(a: int = 1, /, b = (2, 3), *args: str, flag: bool = True, **kwargs: object):\n    pass\n');
    expect(parsed.valid).toBe(true);
    expect(parsed.path).toBe('<memory>');
    expect(parsed.units[0].params).toEqual([
        { name: 'a', annotation: 'int', default: '1', kind: 'positional' },
        { name: 'b', annotation: null, default: '(2, 3)', kind: 'keyword' },
        { name: 'args', annotation: 'str', default: null, kind: 'var' },
        { name: 'flag', annotation: 'bool', default: 'True', kind: 'keyword' },
        { name: 'kwargs', annotation: 'object', default: null, kind: 'kwvar' },
    ]);
});

it.each([
    ['class', 'class Box:\n    pass\n', 'Box', /only top-level functions and methods/],
    ['nested function', 'def outer():\n    def inner():\n        pass\n', 'outer.inner', /only top-level functions and methods/],
    ['duplicate declarations', 'def run():\n    pass\ndef run():\n    return 1\n', 'run', /resolved to 2 declarations/],
] as const)('refuses replacement of %s', async (_label, source, qualifiedName, message) => {
    const parsed = parseModule(source, 'source.py');
    const unit = parsed.units.find(item => item.qualifiedName === qualifiedName)!;
    await expect(new PythonAdapter().replaceUnit({
        source, path: 'source.py', expectedHash: parsed.sourceHash, unitId: unit.id,
        replacement: 'def run():\n    return 2',
    })).rejects.toThrow(message);
});

it('trims replacement padding and returns the exact edit range and hashes', async () => {
    const source = '# prefix\ndef run():\n    return 1\n\n# suffix\n';
    const replacement = 'def run():\n    return 2';
    const parsed = parseModule(source, 'run.py', 'run');
    const result = await new PythonAdapter().replaceUnit({
        source, path: 'run.py', nodeId: 'run', expectedHash: parsed.sourceHash,
        unitId: 'run', replacement: `\n  ${replacement}\n\n`,
    });
    const expected = '# prefix\ndef run():\n    return 2\n\n# suffix\n';
    expect(result.proposedSource).toBe(expected);
    expect(result.edits).toEqual([{ range: { start: { line: 1, character: 0 }, end: { line: 2, character: 12 } }, newText: replacement }]);
    expect(result.baseSourceHash).toBe(parsed.sourceHash);
    expect(result.proposedSourceHash).toBe(parseModule(expected).sourceHash);
    expect(result.parsed).toEqual(parseModule(expected, 'run.py'));
});

it('handles nested classes, slash after variadic params, star/broken top-level bindings, and CR-only method replacements', async () => {
    const nested = parseModule('class Outer:\n    class Inner:\n        pass\n', 'nested.py');
    expect(nested.units.map(unit => [unit.kind, unit.qualifiedName])).toEqual([
        ['class', 'Outer'],
        ['nested_class', 'Outer.Inner'],
    ]);

    const variadicSlash = parseModule('def run(*args, /):\n    pass\n', 'slash.py');
    expect(variadicSlash.units[0].params).toEqual([{ name: 'args', annotation: null, default: null, kind: 'var' }]);

    expect([...topLevelBindings('from math import *\nx = 1\n')]).toEqual(['x']);

    const classSource = 'class Box:\n    def f(self):\n        return 1\n';
    const parsedClass = parseModule(classSource, 'box.py');
    const methodUnit = parsedClass.units.find(unit => unit.qualifiedName === 'Box.f')!;
    const adapter = new PythonAdapter();
    await expect(adapter.replaceUnit({
        source: classSource,
        path: 'box.py',
        expectedHash: parsedClass.sourceHash,
        unitId: methodUnit.id,
        replacement: 'def f(self):\r    return 2',
    })).rejects.toThrow('proposed edit produces invalid Python');

    await expect(adapter.replaceUnit({
        source: classSource,
        path: 'box.py',
        expectedHash: parsedClass.sourceHash,
        unitId: methodUnit.id,
        replacement: 'def f(self):\n    def inner():\n        return 1\n    return inner()',
    })).rejects.toThrow('replacement must contain exactly one valid function');

    const replacedWithNonStringNodeId = await adapter.replaceUnit({
        source: classSource,
        path: 'box.py',
        nodeId: 123 as unknown as string,
        expectedHash: parsedClass.sourceHash,
        unitId: methodUnit.id,
        replacement: 'def f(self):\n    return 2',
    });
    expect(replacedWithNonStringNodeId.proposedSource).toContain('return 2');
});
