import { describe, expect, it } from 'vitest';

import {
    buildForgePacket,
    buildGenerationPacket,
    hoistPythonCandidateImports,
    stripModelEnvelope,
    validateForgeCandidate,
} from '../vscode-extension/src/generation';
import { indexNode } from '../vscode-extension/src/slate_folder';

describe('bounded generation packet', () => {
    it('fails rather than dropping required context when the packet is oversized', () => {
        const target = indexNode('slate/nodes/target.json', JSON.stringify({
            slate: 3, name: 'target', intent: 'Long intent '.repeat(500), locked: false,
            code: ['def target(value: int) -> int:', '    return value'],
        }), 'python', null);
        const snapshot = { revision: 1, projectName: 'demo', documents: [target.document] };
        expect(() => buildGenerationPacket(snapshot, new Map([[target.document.path, target.code]]), 'target', 1024, 512))
            .toThrow(/was not truncated/);
    });

    it('unwraps one model markdown fence but leaves code otherwise intact', () => {
        expect(stripModelEnvelope('```python\ndef run() -> int:\n    return 1\n```')).toBe('def run() -> int:\n    return 1');
    });

    it('omits slate node file paths from Python forge prompts and documents pre-declared imports & scope', () => {
        const dep = indexNode('slate/nodes/scientific/power.json', JSON.stringify({
            slate: 3, name: 'power', intent: 'Raise base to exponent', contract: 'Returns float',
            locked: false, code: ['def power(base: float, exponent: float) -> float:', '    raise NotImplementedError'],
        }), 'python', null);
        const target = indexNode('slate/nodes/scientific/hypotenuse.json', JSON.stringify({
            slate: 3, name: 'hypotenuse', intent: 'Compute hypotenuse', contract: 'Returns float >= 0',
            imports: ['import math'], context: ['scientific/power'], locked: false,
            cases: [
                { name: 'approx_case', input: { a: 3, b: 4 }, expected: 5, approx: true },
                { name: 'err_alias', input: { a: 0, b: -1 }, expectedError: 'ValueError' },
                { name: 'code_case', code: 'assert hypotenuse(0.0, 0.0) == 0.0' },
            ],
            code: ['def hypotenuse(a: float, b: float) -> float:', '    raise NotImplementedError'],
        }), 'python', null);
        const snapshot = { revision: 1, projectName: 'sci', documents: [dep.document, target.document] };
        const sources = new Map([[dep.document.path, dep.code], [target.document.path, target.code]]);

        const packet = buildForgePacket(snapshot, sources, 'scientific/hypotenuse');
        expect(packet.prompt).not.toContain('slate/nodes/');
        expect(packet.prompt).toContain('NEVER import from slate.*');
        expect(packet.prompt).toContain('Pre-declared imports (already at module top): import math');
        expect(packet.prompt).toContain('pytest.approx');
        expect(packet.prompt).toContain('error="ValueError"');
        expect(packet.prompt).toContain('approx=true');
        expect(packet.prompt).toContain('code="assert hypotenuse(0.0, 0.0) == 0.0"');
    });

    it('hoists leading Python imports cleanly and rejects internal slate.* imports', () => {
        const clean = hoistPythonCandidateImports(
            'import math\nfrom decimal import Decimal as D\n\ndef f(x: float) -> float:\n    return math.sqrt(x)\n',
        );
        expect(clean.forbiddenImports).toEqual([]);
        expect(clean.imports).toEqual(['import math', 'from decimal import Decimal as D']);
        expect(clean.implementation).toBe('def f(x: float) -> float:\n    return math.sqrt(x)');

        const badImpl = hoistPythonCandidateImports(
            'def f(x: float) -> float:\n    from slate.nodes.scientific.power import power\n    return power(x, 2.0)',
            'from slate.nodes.scientific import f\ndef test_f():\n    assert f(2.0) == 4.0',
        );
        expect(badImpl.forbiddenImports).toEqual([
            'from slate.nodes.scientific.power import power',
            'from slate.nodes.scientific import f',
        ]);

        const target = indexNode('slate/nodes/f.json', JSON.stringify({
            slate: 3, name: 'f', intent: 'Sqrt', contract: 'x >= 0', locked: false,
            code: ['def f(x: float) -> float:', '    raise NotImplementedError'],
        }), 'python', null);
        const unit = target.document.units[0];

        const okVal = validateForgeCandidate(unit, {
            implementation: 'import math\n\ndef f(x: float) -> float:\n    return math.sqrt(x)',
        });
        expect(okVal.valid).toBe(true);
        expect(okVal.hoistedImports).toEqual(['import math']);
        expect(okVal.normalizedImplementation).toBe('def f(x: float) -> float:\n    return math.sqrt(x)');

        const badVal = validateForgeCandidate(unit, {
            implementation: 'from slate.nodes.math.sqrt import sqrt\n\ndef f(x: float) -> float:\n    return sqrt(x)',
        });
        expect(badVal.valid).toBe(false);
        expect(badVal.diagnostics.some(d => d.includes('must not import internal Slate modules'))).toBe(true);
    });
});
