import { describe, expect, it } from 'vitest';
import { AdapterError, PythonAdapter, identifierNames, parseModule, splitImport, topLevelBindings } from '../vscode-extension/src/python_adapter';
import { compilePython, flowToNode, libraryImport, nodeSignature, projectModuleName } from '../vscode-extension/src/compile/python';
import { formatPortReport, portPythonProject } from '../vscode-extension/src/port/python_importer';
import { emptyFlow } from '../vscode-extension/src/flow';
import { parseNode } from '../vscode-extension/src/slate_folder';

describe('Python analysis matrix', () => {
    it.each([
        ['import os.path', [{ line: 'import os.path', binding: 'os', module: 'os.path', name: null }]],
        ['import os as operating, sys', [{ line: 'import os as operating', binding: 'operating', module: 'os', name: null }, { line: 'import sys', binding: 'sys', module: 'sys', name: null }]],
        ['from ..helpers import (run as r, stop)', [{ line: 'from ..helpers import run as r', binding: 'r', module: '..helpers', name: 'run' }, { line: 'from ..helpers import stop', binding: 'stop', module: '..helpers', name: 'stop' }]],
        ['from helpers import *', [{ line: 'from helpers import *', binding: null, module: 'helpers', name: '*' }]],
        ['', []], ['value = 1', []],
    ])('splits %s', (source, expected) => expect(splitImport(source)).toEqual(expected));

    it.each([
        ['x = value\n# comment_name\ntext = "string_name"', ['text', 'value', 'x']],
        ['def run(x):\n    return helper(x)', ['helper', 'run', 'x']],
        ['', []],
    ])('collects identifiers in %s', (source, expected) => expect([...identifierNames(source)].sort()).toEqual(expected));

    it.each([
        ['x = y = 1\nlabel: str = "a"', ['label', 'x', 'y']],
        ['import os.path\nfrom math import floor as f', ['f', 'os']],
        ['if True:\n    def run():\n        local = 1\nclass Box:\n    member = 2', ['Box', 'run']],
        ['@cache\ndef run():\n    pass', ['run']], ['', []],
    ])('collects module bindings in %s', (source, expected) => expect([...topLevelBindings(source)].sort()).toEqual(expected));

    const source = 'def run(x: int) -> int:\n    return x\n';
    it.each([
        ['source type', { source: null }, /source must be a string/],
        ['path type', { path: null }, /path must be a string/],
        ['stale hash', { expectedHash: 'old' }, /stale source/],
        ['missing unit', { unitId: 'missing' }, /resolved to 0/],
        ['unit type', { unitId: 1 }, /unitId must be a string/],
        ['replacement type', { replacement: null }, /replacement must be a string/],
        ['renamed function', { replacement: 'def other(x: int) -> int:\n    return x' }, /preserve/],
        ['changed signature', { replacement: 'def run(x: str) -> int:\n    return 1' }, /preserve/],
        ['decorator', { replacement: '@cache\ndef run(x: int) -> int:\n    return x' }, /exactly one valid function/],
        ['invalid syntax', { replacement: 'def run(:' }, /exactly one valid function/],
        ['extra statement', { replacement: source + '\nprint(1)' }, /exactly one valid function/],
    ])('rejects unsafe replacement: %s', async (_label, patch, message) => {
        const adapter = new PythonAdapter();
        const params = { source, path: 'run.py', nodeId: 'run', unitId: 'run', expectedHash: parseModule(source).sourceHash,
            replacement: source, ...(patch as object) };
        await expect(adapter.replaceUnit(params)).rejects.toThrow(AdapterError);
        await expect(adapter.replaceUnit(params)).rejects.toThrow(message as RegExp);
    });
    it('replaces a method with indentation and surrounding members intact', async () => {
        const source = 'class Box:\n    def run(self, x: int) -> int:\n        return x\n\n    def keep(self):\n        return 2\n';
        const adapter = new PythonAdapter();
        const parsed = await adapter.parseModule(source, 'box.py');
        const result = await adapter.replaceUnit({ source, path: 'box.py', expectedHash: parsed.sourceHash,
            unitId: parsed.units.find(unit => unit.name === 'run')!.id,
            replacement: 'def run(self, x: int) -> int:\n    return x + 1' });
        expect(result.proposedSource).toBe(source.replace('return x', 'return x + 1'));
        expect(result.baseSourceHash).toBe(parsed.sourceHash);
        expect(result.proposedSourceHash).not.toBe(parsed.sourceHash);
        expect(result.parsed.valid).toBe(true);
        adapter.dispose();
    });
});

describe('port and compile matrix', () => {
    it.each([
        ['empty', '', []], ['imports only', 'import os\n', []],
        ['state only', 'VALUE = 1\n', ['pkg/_prelude']],
        ['definition', 'def run():\n    return 1\n', ['pkg/run']],
        ['class', 'class Box:\n    pass\n', ['pkg/Box']],
        ['reserved name', 'def _prelude():\n    pass\n', ['pkg/_prelude']],
        ['invalid', 'def broken(:', []],
    ])('ports %s', (_label, source, ids) => {
        const result = portPythonProject(new Map([['pkg.py', source], ['README.md', '# ignore']]));
        expect([...result.nodes.keys()]).toEqual(ids);
        expect(result.report.nodes + result.report.preludes + result.report.epilogues).toBe(ids.length);
        expect(result.report.modules).toEqual(_label === 'invalid' ? [] : ['pkg.py']);
        expect(result.report.warnings.length).toBe(['invalid', 'reserved name'].includes(_label) ? 1 : 0);
    });
    it.each(['from .ops import run', 'from pkg.ops import run'])('resolves %s to a node dependency', statement => {
        const { nodes } = portPythonProject(new Map([
            ['pkg/ops.py', 'def run():\n    return 1\n'],
            ['pkg/app.py', `${statement}\ndef main():\n    return run()\n`],
        ]));
        expect(nodes.get('pkg/app/main')).toMatchObject({ uses: ['pkg/ops/run'], imports: [] });
        const compiled = compilePython(nodes, { slate: 3, name: 'demo', language: 'python' });
        expect(compiled.diagnostics).toEqual([]);
        expect(compiled.files.get('pkg/app.py')).toContain('from pkg.ops import run');
        for (const [path, code] of compiled.files) expect(parseModule(code, path).valid, path).toBe(true);
    });
    it.each(['__init__.py', 'pkg/__init__.py'])('ports package %s', path => {
        const { nodes, report } = portPythonProject(new Map([[path, 'def run():\n    return 1\n']]));
        expect([...nodes.keys()]).toEqual([path === '__init__.py' ? 'run' : 'pkg/run']);
        expect(report.warnings.length).toBe(path === '__init__.py' ? 1 : 0);
    });
    it.each([false, true])('formats a report with warnings=%s', warnings => {
        expect(formatPortReport({ modules: ['app.py'], nodes: 2, preludes: 1, epilogues: 0, warnings: warnings ? ['Check import'] : [] }))
            .toBe('Ported 1 module(s) into 2 node(s), 1 prelude(s), 0 epilogue(s).\n  app.py\n'
                + (warnings ? 'Warnings (1):\n  - Check import' : 'No warnings.'));
    });
    it.each([['My Project', 'my_project'], ['123 App', '_123_app'], ['', 'project'], ['a.b-c', 'a_b_c']])('normalizes project %j', (name, expected) => {
        expect(projectModuleName(name)).toBe(expected);
    });
    it.each([
        ['lib:pkg/util.py:run', 'from pkg.util import run'], ['lib:pkg/__init__.py:Box', 'from pkg import Box'],
        ['pkg/run', null], ['lib:util.js:run', null], ['lib:util.py:bad-name', null],
    ])('resolves library target %s', (target, expected) => expect(libraryImport(target)).toBe(expected));
    it.each([
        ['def run(x: int) -> str:\n    return str(x)', undefined, 'run'],
        ['class run:\n    pass', undefined, 'run'], ['VALUE = 1', 'prelude', null],
        ['def other():\n    pass', undefined, null], ['def run(:', undefined, null],
    ])('derives node signature for %s', (source, kind, name) => {
        const node = parseNode(JSON.stringify({ slate: 3, name: 'run', code: source.split('\n'), kind }));
        expect(nodeSignature(node)?.name ?? null).toBe(name);
    });
    it('compiles empty projects and an empty flow without mutating inputs', () => {
        expect(compilePython(new Map(), { slate: 3, name: 'demo', language: 'python' })).toEqual({ files: new Map(), diagnostics: [] });
        const flow = emptyFlow('run');
        const diagnostics = [];
        const node = flowToNode('run', flow, () => null, diagnostics);
        expect(diagnostics).toEqual([]);
        expect(node?.code.join('\n')).toContain('pass');
        expect(flow).toEqual(emptyFlow('run'));
    });
    it('reports unsupported node languages without emitting their code', () => {
        const node = parseNode('{"slate":3,"name":"run","language":"ruby","code":["puts 1"]}');
        const result = compilePython(new Map([['run', node]]), { slate: 3, name: 'demo', language: 'python' });
        expect(result.files.size).toBe(0);
        expect(result.diagnostics).toEqual([{ severity: 'error', message: 'run: no compiler for language "ruby".' }]);
    });
});
