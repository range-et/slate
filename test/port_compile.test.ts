import { describe, expect, it } from 'vitest';

import { compilePython } from '../vscode-extension/src/compile/python';
import { portPythonProject } from '../vscode-extension/src/port/python_importer';
import { indexNode, parseNode, pathForNodeId, serializeNode, type SlateNode } from '../vscode-extension/src/slate_folder';

const config = { slate: 3 as const, name: 'demo', language: 'python' };

const project = new Map([
    ['shapes/geometry.py', [
        'import math, os',
        'from typing import Dict, List as L',
        'from shapes.util import clamp, LIMIT, helper as h',
        '',
        '# Cache of computed areas.',
        'CACHE: Dict[str, float] = {}',
        '',
        'def area(r: float) -> float:',
        '    global CACHE',
        '    return clamp(math.pi * r * r, 0, LIMIT)',
        '',
        '@decorate',
        'def areas(rs: L[float]) -> L[float]:',
        '    return [area(r) for r in rs]',
        '',
        'TABLE = {"area": area}',
        'if __name__ == "__main__":',
        '    print(areas([1.0]))',
        '',
    ].join('\n')],
    ['shapes/util.py', [
        'from os.path import *',
        'LIMIT = 100',
        'def clamp(value, lower, upper):',
        '    return max(lower, min(value, upper))',
        'def helper():',
        '    return 1',
        'if True:',
        '    def hidden():',
        '        pass',
        'def clamp(value, lower, upper):',
        '    return min(upper, max(value, lower))',
        '',
    ].join('\n')],
    ['broken.py', 'def nope(:\n'],
    ['README.md', '# not python'],
]);

function node(fields: Partial<SlateNode> & { code: string[] }): SlateNode {
    return { name: 'x', intent: '', contract: '', context: [], examples: [], locked: false, imports: [], uses: [], extra: {}, ...fields };
}

describe('Python importer', () => {
    const { nodes, report } = portPythonProject(project);

    it('splits definitions into nodes and module statements into a prelude and an epilogue', () => {
        expect([...nodes.keys()].sort()).toEqual([
            'shapes/geometry/_epilogue', 'shapes/geometry/_prelude', 'shapes/geometry/area', 'shapes/geometry/areas',
            'shapes/util/_prelude', 'shapes/util/clamp', 'shapes/util/helper',
        ]);
        expect(nodes.get('shapes/geometry/_prelude')!.code).toEqual(['# Cache of computed areas.', 'CACHE: Dict[str, float] = {}']);
        // The first statement that needs a definition starts the epilogue, and everything after stays with it.
        expect(nodes.get('shapes/geometry/_epilogue')!.code).toEqual(['TABLE = {"area": area}', 'if __name__ == "__main__":', '    print(areas([1.0]))']);
        expect(nodes.get('shapes/geometry/areas')!.code[0]).toBe('@decorate');
        expect(nodes.get('shapes/util/clamp')!.code[1]).toContain('min(upper');
        expect(report).toMatchObject({ modules: ['shapes/geometry.py', 'shapes/util.py'], nodes: 4, preludes: 2, epilogues: 1 });
    });

    it('gives each node only the imports it uses and turns ported names into uses', () => {
        const area = nodes.get('shapes/geometry/area')!;
        expect(area.imports).toEqual(['import math']);
        expect(area.uses).toEqual(['shapes/geometry/_prelude', 'shapes/util/_prelude', 'shapes/util/clamp']);
        const areas = nodes.get('shapes/geometry/areas')!;
        expect(areas.imports).toEqual(['from typing import List as L']);
        expect(areas.uses).toEqual(['shapes/geometry/area']);
        expect(nodes.get('shapes/geometry/_prelude')!.imports).toEqual(['from typing import Dict']);
        expect(nodes.get('shapes/geometry/_epilogue')!.uses).toEqual(['shapes/geometry/area', 'shapes/geometry/areas']);
        expect(nodes.get('shapes/util/helper')!.imports).toEqual(['from os.path import *']);
    });

    it('reports what it could not split cleanly', () => {
        const text = report.warnings.join('\n');
        expect(text).toContain('broken.py: could not be parsed');
        expect(text).toContain('aliased import "from shapes.util import helper as h"');
        expect(text).toContain('shapes/geometry/area uses global CACHE');
        expect(text).toContain('conditional definition hidden stays in the prelude');
        expect(text).toContain('clamp is defined more than once');
        expect(text).toContain('star import copied to every node');
    });

    it('writes node files that load as clean nodes', () => {
        for (const [nodeId, value] of nodes) {
            const { document } = indexNode(pathForNodeId(nodeId), serializeNode(value), 'python', null);
            expect(document.diagnostics, nodeId).toEqual([]);
            expect(document.nodeKind).toBe(value.kind);
        }
    });
});

describe('Python compile', () => {
    it('compiles a ported project back to modules with merged imports and node stamps', () => {
        const { nodes } = portPythonProject(new Map([
            ['ops.py', 'from typing import Dict\nOPS: Dict[str, object] = {}\ndef add(a, b):\n    return a + b\n'],
            ['app.py', [
                'from typing import Dict, List',
                'from ops import OPS, add',
                'from ops import add',
                'def run(xs: List[int]) -> int:',
                '    OPS["+"] = add',
                '    return add(*xs)',
                'def table() -> Dict[str, int]:',
                '    return {"run": run([1, 2])}',
                'if __name__ == "__main__":',
                '    print(table())',
            ].join('\n')],
        ]));
        const run = nodes.get('app/run')!;
        run.intent = 'Add numbers';
        run.contract = 'Registers +\nfirst';
        const result = compilePython(new Map([...nodes].map(([id, value]) => [id, parseNode(serializeNode(value))])), config);
        expect(result.diagnostics).toEqual([]);
        expect([...result.files.keys()]).toEqual(['app.py', 'ops.py']);
        expect(result.files.get('app.py')).toBe([
            '# Generated by Slate from slate/nodes/app/; edit the node files, not this file.',
            '',
            'from typing import List, Dict',
            'from ops import OPS, add',
            '',
            '',
            '# slate: nodes/app/run',
            '# intent: Add numbers',
            '# contract: Registers +',
            '#   first',
            'def run(xs: List[int]) -> int:',
            '    OPS["+"] = add',
            '    return add(*xs)',
            '',
            '',
            '# slate: nodes/app/table',
            'def table() -> Dict[str, int]:',
            '    return {"run": run([1, 2])}',
            '',
            '',
            '# slate: nodes/app/_epilogue',
            'if __name__ == "__main__":',
            '    print(table())',
            '',
        ].join('\n'));
        expect(result.files.get('ops.py')).toContain('from typing import Dict\n\n\n# slate: nodes/ops/_prelude\nOPS: Dict[str, object] = {}\n\n\n# slate: nodes/ops/add\n');
    });

    it('lays out packages, root nodes, and resolves bare names to a unique node elsewhere', () => {
        const result = compilePython(new Map([
            ['clamp', node({ name: 'clamp', code: ['def clamp(v):', '    return v'] })],
            ['pkg/base', node({ name: 'base', code: ['def base():', '    return clamp(1)'] })],
            ['pkg/deep/leaf', node({ name: 'leaf', imports: ['import os.path', 'import os'], code: ['def leaf():', '    return base(), os.sep'] })],
        ]), config);
        expect(result.diagnostics).toEqual([]);
        expect([...result.files.keys()]).toEqual(['demo.py', 'pkg/__init__.py', 'pkg/deep.py']);
        expect(result.files.get('pkg/__init__.py')).toContain('from demo import clamp\n');
        expect(result.files.get('pkg/deep.py')).toContain('import os.path\nimport os\nfrom pkg import base\n');
    });

    it('diagnoses name collisions, ambiguous names, missing uses, and import cycles', () => {
        const result = compilePython(new Map([
            ['a/floor', node({ name: 'floor', code: ['def floor(x):', '    return x'] })],
            ['a/user', node({ name: 'user', imports: ['from math import floor'], uses: ['b/ping'], code: ['def user():', '    return floor(1.5) + ping()'] })],
            ['b/ping', node({ name: 'ping', code: ['def ping():', '    return user()'] })],
            ['c/ping', node({ name: 'ping', code: ['def ping():', '    return 0'] })],
            ['c/caller', node({ name: 'caller', uses: ['gone/node', 'b/ping'], code: ['def caller():', '    return ping()'] })],
            ['e/amb', node({ name: 'amb', code: ['def amb():', '    return ping()'] })],
            ['d/bad', node({ name: 'bad', code: ['def bad(:'] })],
        ]), config);
        const messages = result.diagnostics.map(item => `${item.severity}: ${item.message}`).join('\n');
        expect(messages).toContain('error: a.py: name collision on "floor" (node a/floor vs "from math import floor"');
        expect(messages).toContain('error: e/amb: "ping" matches b/ping, c/ping');
        expect(messages).toContain('error: c/caller uses gone/node, which does not exist');
        expect(messages).toContain('error: d/bad: code is not valid Python');
        expect(messages).toContain('warning: Import cycle: a.py → b.py → a.py');
        // c/caller names c/ping locally, so `uses: b/ping` must not import a second ping.
        expect(messages).toContain('c.py: name collision on "ping" (node c/ping vs "from b import ping"');
    });
});
