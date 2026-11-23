import { describe, expect, it } from 'vitest';

import {
    buildForgePacket,
    buildGenerationPacket,
    DEFAULT_FORGE_OUTPUT_TOKENS,
    FORGE_INPUT_BUDGET_TOKENS,
    hoistPythonCandidateImports,
    parseForgeCandidate,
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

    it('defaults forge outputBudgetTokens to 1536 and extracts fenced section code with surrounding prose (#55)', () => {
        const node = indexNode('slate/nodes/double.json', JSON.stringify({
            slate: 3, name: 'double', intent: 'Double value', contract: 'Returns x * 2',
            locked: false, code: ['def double(x: int) -> int:', '    raise NotImplementedError'],
        }), 'python', null);
        const snapshot = { revision: 1, projectName: 'demo', documents: [node.document] };
        const packet = buildForgePacket(snapshot, new Map([[node.document.path, node.code]]), 'double');
        expect(DEFAULT_FORGE_OUTPUT_TOKENS).toBe(1536);
        expect(packet.outputBudgetTokens).toBe(1536);
        expect(packet.inputBudgetTokens).toBe(FORGE_INPUT_BUDGET_TOKENS);

        const pyWithProse = parseForgeCandidate([
            '### Implementation',
            'Here is the function:',
            '```python',
            'def double(x: int) -> int:',
            '    return x * 2',
            '```',
            'Runs in O(1) time.',
            '',
            '### Unit Check',
            'Tests doubling:',
            '```python',
            'def test_double():',
            '    assert double(3) == 6',
            '```',
            'All assertions hold.',
        ].join('\n'), 'python');
        expect(pyWithProse.implementation).toBe('def double(x: int) -> int:\n    return x * 2');
        expect(pyWithProse.check).toBe('def test_double():\n    assert double(3) == 6');

        const tsWithProse = parseForgeCandidate([
            '### Implementation',
            'Note:',
            '```ts',
            'export function dbl(x: number): number {',
            '    return x * 2;',
            '}',
            '```',
            'Typed.',
            '### Unit Check',
            '```typescript',
            "test('dbl', () => {",
            '    expect(dbl(3)).toBe(6);',
            '});',
            '```',
            'Done.',
        ].join('\n'), 'typescript');
        expect(tsWithProse.implementation).toBe('export function dbl(x: number): number {\n    return x * 2;\n}');
        expect(tsWithProse.check).toBe("test('dbl', () => {\n    expect(dbl(3)).toBe(6);\n});");

        // Wrong-language fence and unclosed truncated fence must NOT be silently stripped cleanly
        const wrongLang = parseForgeCandidate([
            '### Implementation',
            '```javascript',
            'function double(x) { return x * 2; }',
            '```',
            'Some prose',
        ].join('\n'), 'python');
        expect(wrongLang.implementation).toContain('```javascript');

        const truncated = parseForgeCandidate([
            '### Implementation',
            '```python',
            'def double(x: int) -> int:',
            '    return x * 2',
            '```',
            '### Unit Check',
            '```python',
            'def test_double():',
            '    assert double(',
        ].join('\n'), 'python');
        expect(truncated.check).toContain('```python');
    });

    it('packs neighbor signatures progressively across Tier 2 (drop contracts) and Tier 3 (signatures-only fallback) within 600 tokens (#55)', () => {
        const deps = ['helper_a', 'helper_b', 'helper_c'].map(name =>
            indexNode(`slate/nodes/${name}.json`, JSON.stringify({
                slate: 3,
                name,
                intent: `Compute ${name} cleanly from grid state.`,
                contract: `Verbose precondition and postcondition notes for ${name} `.repeat(8),
                locked: false,
                code: [`def ${name}(x: int) -> tuple[int, int, list[int]] | None:`, '    return None'],
            }), 'python', 1),
        );
        const target = indexNode('slate/nodes/orchestrator.json', JSON.stringify({
            slate: 3,
            name: 'orchestrator',
            intent: 'Combine helper_a, helper_b, and helper_c.',
            contract: 'Use all three helpers.',
            context: deps.map(d => d.document.units[0].id),
            locked: false,
            code: ['def orchestrator(x: int) -> int:', '    raise NotImplementedError'],
        }), 'python', 1);
        const snapshot = {
            revision: 1,
            projectName: 'progressive',
            documents: [...deps.map(d => d.document), target.document],
        };
        const sources = new Map([
            ...deps.map(d => [d.document.path, d.code] as const),
            [target.document.path, target.code] as const,
        ]);

        // Tier 2: dropping verbose neighbor contracts fits all 3 dependencies with Signature + Intent
        const tier2Packet = buildForgePacket(snapshot, sources, 'orchestrator');
        expect(tier2Packet.estimatedInputTokens).toBeLessThanOrEqual(FORGE_INPUT_BUDGET_TOKENS);
        expect(tier2Packet.neighbors?.map(n => n.id)).toEqual(['helper_a', 'helper_b', 'helper_c']);
        expect(tier2Packet.omittedNeighbors).toEqual([]);
        expect(tier2Packet.prompt).toContain('def helper_c(x: int) -> tuple[int, int, list[int]] | None:');
        expect(tier2Packet.prompt).not.toContain('Verbose precondition');

        // Tier 3: adding 5 more heavy dependencies forces Signature+Intent trimming + signatures-only fallback
        const extraDeps = [1, 2, 3, 4, 5].map(i =>
            indexNode(`slate/nodes/extra_${i}.json`, JSON.stringify({
                slate: 3,
                name: `extra_${i}`,
                intent: `Detailed multi-sentence intent specification for extra dependency ${i} `.repeat(6),
                contract: 'strict contract',
                locked: false,
                code: [`def extra_${i}(v: int) -> int:`, '    return v'],
            }), 'python', 1),
        );
        for (const extra of extraDeps) {
            snapshot.documents.push(extra.document);
            sources.set(extra.document.path, extra.code);
            target.document.units[0].annotation!.dependencies!.push(extra.document.units[0].id);
        }

        const tier3Packet = buildForgePacket(snapshot, sources, 'orchestrator');
        expect(tier3Packet.estimatedInputTokens).toBeLessThanOrEqual(FORGE_INPUT_BUDGET_TOKENS);
        expect(tier3Packet.omittedNeighbors!.length).toBeGreaterThan(0);
        expect((tier3Packet.neighbors?.length ?? 0) + (tier3Packet.omittedNeighbors?.length ?? 0)).toBe(8);
        expect(tier3Packet.prompt).toContain('### Additional dependencies in scope (signatures only):');
        expect(tier3Packet.prompt).toContain('def extra_5(v: int) -> int:');

        // Tier 3 under retry feedback on a 3-dependency target still reserves room for every dependency's bare signature
        const compact3Docs = ['dep_one', 'dep_two', 'dep_three'].map(name =>
            indexNode(`slate/nodes/${name}.json`, JSON.stringify({
                slate: 3,
                name,
                intent: `Compute ${name} using specialized backtracking heuristics over the 9x9 grid state `.repeat(2),
                contract: 'strict',
                locked: false,
                code: [`def ${name}(x: int) -> tuple[int, int, list[int]] | None:`, '    return None'],
            }), 'python', 1),
        );
        const target3 = indexNode('slate/nodes/main3.json', JSON.stringify({
            slate: 3,
            name: 'main3',
            intent: 'Run iterative DFS with backtracking across dep_one, dep_two, dep_three.',
            contract: 'Use all three helpers cleanly.',
            context: ['dep_one', 'dep_two', 'dep_three'],
            locked: false,
            code: ['def main3(x: int) -> int:', '    raise NotImplementedError'],
        }), 'python', 1);
        const snap3 = {
            revision: 1,
            projectName: 'reserve',
            documents: [...compact3Docs.map(d => d.document), target3.document],
        };
        const src3 = new Map([
            ...compact3Docs.map(d => [d.document.path, d.code] as const),
            [target3.document.path, target3.code] as const,
        ]);
        const retryPacket = buildForgePacket(snap3, src3, 'main3', {
            retryFeedback: 'Previous attempt raised ValueError: too many values to unpack when calling dep_three; inspect return type carefully.',
        });
        expect(retryPacket.estimatedInputTokens).toBeLessThanOrEqual(FORGE_INPUT_BUDGET_TOKENS);
        expect(retryPacket.prompt).toContain('def dep_one(x: int) -> tuple[int, int, list[int]] | None:');
        expect(retryPacket.prompt).toContain('def dep_two(x: int) -> tuple[int, int, list[int]] | None:');
        expect(retryPacket.prompt).toContain('def dep_three(x: int) -> tuple[int, int, list[int]] | None:');
    });

    it('rejects nested def/async def shadowing a declared dependency while allowing private helpers and strings (#55)', () => {
        const target = indexNode('slate/nodes/sudoku/solve.json', JSON.stringify({
            slate: 3,
            name: 'solve',
            intent: 'Solve using find_best_empty.',
            context: ['sudoku/find_best_empty'],
            locked: false,
            code: ['def solve(grid: list[list[int]]) -> int:', '    raise NotImplementedError'],
        }), 'python', null);
        const unit = target.document.units[0];

        const shadowedSync = validateForgeCandidate(unit, {
            implementation: [
                'def solve(grid: list[list[int]]) -> int:',
                '    def find_best_empty(g):',
                '        return None',
                '    return 0',
            ].join('\n'),
        });
        expect(shadowedSync.valid).toBe(false);
        expect(shadowedSync.diagnostics.some(d => d.includes('find_best_empty') && d.includes('redefining them locally'))).toBe(true);

        const shadowedAsync = validateForgeCandidate(unit, {
            implementation: [
                'def solve(grid: list[list[int]]) -> int:',
                '    async def find_best_empty(g):',
                '        return None',
                '    return 0',
            ].join('\n'),
        });
        expect(shadowedAsync.valid).toBe(false);
        expect(shadowedAsync.diagnostics.some(d => d.includes('find_best_empty'))).toBe(true);

        const allowedHelperAndComments = validateForgeCandidate(unit, {
            implementation: [
                'def solve(grid: list[list[int]]) -> int:',
                '    # def find_best_empty(g): mention in comment is fine',
                '    msg = "def find_best_empty(g): mention in string is fine"',
                '    def _local_helper() -> int:',
                '        return 1',
                '    _ = (msg, find_best_empty)',
                '    return _local_helper()',
            ].join('\n'),
        });
        expect(allowedHelperAndComments.valid).toBe(true);
    });
});
