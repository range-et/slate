import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    validateNodeSchema,
    validateFlowSchema,
    validateNodeAst,
    checkProjectParity,
    checkProjectDrift,
    checkProjectTests,
    resolveCiConfig,
    verifyProjectCi,
    validateProjectContracts,
    verifyAll,
} from '../scripts/verify-contracts.mjs';
import { EMBEDDED_FLOW_SCHEMA, EMBEDDED_NODE_SCHEMA } from '../vscode-extension/src/contract_schemas';
import { runSlateVerifyCiCli } from '../vscode-extension/src/cli/slate_verify_ci';

const validNode = {
    slate: 3,
    name: 'calculate_tax',
    intent: 'Compute sales tax for amount',
    contract: 'Raise ValueError if amount or rate is negative',
    context: ['tax_rates'],
    examples: ['calculate_tax(100.0, 0.05) == 5.0'],
    locked: false,
    imports: ['from typing import Dict'],
    uses: ['tax_rates'],
    code: [
        'def calculate_tax(amount: float, rate: float = 0.05) -> float:',
        '    if amount < 0 or rate < 0:',
        '        raise ValueError("amount and rate must be non-negative")',
        '    return amount * rate',
    ],
};

const validFlow = {
    slate: 3,
    name: 'billing_flow',
    inputs: [
        { name: 'amount', annotation: 'float' },
    ],
    outputs: [
        { name: 'total', annotation: 'float' },
    ],
    instances: [
        { id: 'tax', node: 'calculate_tax' },
    ],
    wires: [
        { from: 'input:amount', to: 'tax.in:amount' },
        { from: 'tax.out', to: 'output:total' },
    ],
};

describe('contracts/slate-node.schema.json & validateNodeSchema', () => {
    it('accepts a fully compliant atomic library node', () => {
        const result = validateNodeSchema(validNode, 'calculate_tax.json');
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('rejects missing or wrong slate format version', () => {
        expect(validateNodeSchema({ ...validNode, slate: 2 }).valid).toBe(false);
        expect(validateNodeSchema({ ...validNode, slate: 4 }).errors[0]).toContain('/slate must be equal to constant');
    });

    it('rejects invalid node identifier names', () => {
        expect(validateNodeSchema({ ...validNode, name: 'invalid-name' }).valid).toBe(false);
        expect(validateNodeSchema({ ...validNode, name: '123bad' }).valid).toBe(false);
        expect(validateNodeSchema({ ...validNode, name: '' }).valid).toBe(false);
        expect(validateNodeSchema({ ...validNode, name: 'valid_name_2' }).valid).toBe(true);
    });

    it('enforces required non-empty intent documentation', () => {
        expect(validateNodeSchema({ ...validNode, intent: '' }).valid).toBe(false);
        expect(validateNodeSchema({ ...validNode, intent: '   ' }).valid).toBe(false);
        const withoutIntent = { ...validNode };
        delete withoutIntent.intent;
        expect(validateNodeSchema(withoutIntent).valid).toBe(false);
    });

    it('enforces required non-empty contract documentation', () => {
        expect(validateNodeSchema({ ...validNode, contract: '' }).valid).toBe(false);
        expect(validateNodeSchema({ ...validNode, contract: '   ' }).valid).toBe(false);
        const withoutContract = { ...validNode };
        delete withoutContract.contract;
        expect(validateNodeSchema(withoutContract).valid).toBe(false);
    });

    it('enforces JPL-60 line boundary at the schema level (<=60 lines)', () => {
        const lines59 = Array.from({ length: 59 }, (_, i) => `line_${i} = ${i}`);
        const lines60 = Array.from({ length: 60 }, (_, i) => `line_${i} = ${i}`);
        const lines61 = Array.from({ length: 61 }, (_, i) => `line_${i} = ${i}`);

        expect(validateNodeSchema({ ...validNode, code: lines59 }).valid).toBe(true);
        expect(validateNodeSchema({ ...validNode, code: lines60 }).valid).toBe(true);

        const result61 = validateNodeSchema({ ...validNode, code: lines61 });
        expect(result61.valid).toBe(false);
        expect(result61.errors.some(e => e.includes('must NOT have more than 60 items') || e.includes('exceeds JPL-60 limit'))).toBe(true);
    });

    it('rejects non-array or non-string code lines', () => {
        expect(validateNodeSchema({ ...validNode, code: 'print(1)' }).valid).toBe(false);
        expect(validateNodeSchema({ ...validNode, code: [123] }).valid).toBe(false);
    });

    it('validates optional metadata fields when present', () => {
        expect(validateNodeSchema({ ...validNode, context: 'not-an-array' }).valid).toBe(false);
        expect(validateNodeSchema({ ...validNode, examples: [123] }).valid).toBe(false);
        expect(validateNodeSchema({ ...validNode, imports: ['import math'] }).valid).toBe(true);
        expect(validateNodeSchema({ ...validNode, uses: ['other_node'] }).valid).toBe(true);
        expect(validateNodeSchema({ ...validNode, kind: 'unknown' }).valid).toBe(false);
        expect(validateNodeSchema({ ...validNode, kind: 'prelude' }).valid).toBe(true);
        expect(validateNodeSchema({ ...validNode, describedBy: 'robot' }).valid).toBe(false);
        expect(validateNodeSchema({ ...validNode, describedBy: 'llama' }).valid).toBe(true);
        expect(validateNodeSchema({ ...validNode, locked: 'true' }).valid).toBe(false);
        expect(validateNodeSchema({ ...validNode, order: 1.5 }).valid).toBe(false);
    });
});

describe('contracts/slate-flow.schema.json & validateFlowSchema', () => {
    it('accepts a fully compliant composition flow', () => {
        const result = validateFlowSchema(validFlow, 'billing_flow.json');
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('rejects invalid flow structure via Ajv schema validation', () => {
        expect(validateFlowSchema({ ...validFlow, slate: 1 }).valid).toBe(false);
        expect(validateFlowSchema({ ...validFlow, name: 'bad-name' }).valid).toBe(false);
        expect(validateFlowSchema({ ...validFlow, inputs: 'not-array' }).valid).toBe(false);
        expect(validateFlowSchema({ ...validFlow, wires: null }).valid).toBe(false);
        // Deep schema check: inputs must contain objects with required name
        const badInputs = validateFlowSchema({ ...validFlow, inputs: [42] });
        expect(badInputs.valid).toBe(false);
        expect(badInputs.errors[0]).toContain('/inputs/0 must be object');
    });
});

describe('AST Contract Validation & JPL-60 strict typing (validateNodeAst)', () => {
    it('passes for a well-typed, JPL-60 compliant function', () => {
        const result = validateNodeAst(validNode, 'calculate_tax.json');
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.unit?.name).toBe('calculate_tax');
    });

    it('enforces JPL-60 boundary cases: 59, 60, and 61 lines', () => {
        const header = ['def compute(x: int) -> int:'];
        const body58 = Array.from({ length: 58 }, (_, i) => `    v${i} = ${i}`);
        const ret = ['    return x'];

        // 59 total lines (1 header + 57 body + 1 return)
        const code59 = [...header, ...body58.slice(0, 57), ...ret];
        expect(code59.length).toBe(59);
        expect(validateNodeAst({ ...validNode, name: 'compute', code: code59 }).valid).toBe(true);

        // 60 total lines (1 header + 58 body + 1 return)
        const code60 = [...header, ...body58, ...ret];
        expect(code60.length).toBe(60);
        expect(validateNodeAst({ ...validNode, name: 'compute', code: code60 }).valid).toBe(true);

        // 61 total lines (1 header + 58 body + 1 extra + 1 return)
        const code61 = [...header, ...body58, '    v_extra = 99', ...ret];
        expect(code61.length).toBe(61);
        const result61 = validateNodeAst({ ...validNode, name: 'compute', code: code61 });
        expect(result61.valid).toBe(false);
        expect(result61.errors.some(e => e.includes('[JPL-60]') && e.includes('61 lines > 60'))).toBe(true);
    });

    it('enforces mandatory parameter type annotations', () => {
        // Missing annotation on parameter y
        const untypedParam = {
            ...validNode,
            code: [
                'def calculate_tax(amount: float, rate = 0.05) -> float:',
                '    return amount * rate',
            ],
        };
        const result1 = validateNodeAst(untypedParam, 'calculate_tax.json');
        expect(result1.valid).toBe(false);
        expect(result1.errors.some(e => e.includes('[STRICT_TYPING]') && e.includes('rate') && e.includes('missing a type annotation'))).toBe(true);

        // All untyped params
        const allUntyped = {
            ...validNode,
            code: [
                'def calculate_tax(amount, rate):',
                '    return amount * rate',
            ],
        };
        const result2 = validateNodeAst(allUntyped, 'calculate_tax.json');
        expect(result2.valid).toBe(false);
        expect(result2.errors.filter(e => e.includes('[STRICT_TYPING]')).length).toBeGreaterThanOrEqual(2);
    });

    it('enforces mandatory return type annotation (-> ReturnType)', () => {
        const noReturnType = {
            ...validNode,
            code: [
                'def calculate_tax(amount: float, rate: float = 0.05):',
                '    return amount * rate',
            ],
        };
        const result = validateNodeAst(noReturnType, 'calculate_tax.json');
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('[STRICT_TYPING]') && e.includes('missing a return type annotation'))).toBe(true);
    });

    it('enforces parameter type annotations even if named self or cls', () => {
        const untypedSelf = {
            ...validNode,
            name: 'method_like',
            code: [
                'def method_like(self, x: int) -> int:',
                '    return x',
            ],
        };
        const result = validateNodeAst(untypedSelf, 'method_like.json');
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('[STRICT_TYPING]') && e.includes('self'))).toBe(true);
    });

    it('detects embedded newlines in code strings exceeding JPL-60', () => {
        // Single string element in code array with 65 lines embedded via newlines
        const longBody = Array.from({ length: 65 }, (_, i) => `    v${i} = ${i}`).join('\n');
        const embeddedCode = [
            `def calculate_tax(amount: float) -> float:\n${longBody}\n    return amount`,
        ];
        expect(embeddedCode.length).toBe(1);

        // AST validator detects >60 normalized lines
        const astResult = validateNodeAst({ ...validNode, code: embeddedCode }, 'calculate_tax.json');
        expect(astResult.valid).toBe(false);
        expect(astResult.errors.some(e => e.includes('[JPL-60]') && e.includes('lines > 60'))).toBe(true);

        // Schema validator also rejects normalized line count > 60
        const schemaResult = validateNodeSchema({ ...validNode, code: embeddedCode }, 'calculate_tax.json');
        expect(schemaResult.valid).toBe(false);
        expect(schemaResult.errors.some(e => e.includes('exceeds JPL-60 limit of 60 lines'))).toBe(true);
    });

    it('allows prelude and epilogue module state nodes', () => {
        const preludeNode = {
            slate: 3,
            name: '_prelude',
            kind: 'prelude',
            intent: 'Module imports and constants',
            contract: 'Define global constants',
            code: ['LIMIT = 100', 'DEBUG = False'],
        };
        expect(validateNodeAst(preludeNode, '_prelude.json').valid).toBe(true);
    });

    it('reports Python syntax errors clearly', () => {
        const brokenCode = {
            ...validNode,
            code: ['def calculate_tax(amount: float -> float:', '    return 0'],
        };
        const result = validateNodeAst(brokenCode, 'broken.json');
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('Python syntax error');
    });

    it('reports definition name mismatch or multiple top-level definitions', () => {
        const wrongName = {
            ...validNode,
            name: 'calculate_tax',
            code: [
                'def other_function(x: int) -> int:',
                '    return x',
            ],
        };
        const result = validateNodeAst(wrongName, 'calculate_tax.json');
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('code must contain exactly one definition named "calculate_tax"');

        const multipleDefs = {
            ...validNode,
            name: 'calculate_tax',
            code: [
                'def calculate_tax(amount: float, rate: float = 0.05) -> float:',
                '    return amount * rate',
                'def helper(x: int) -> int:',
                '    return x',
            ],
        };
        const resultMulti = validateNodeAst(multipleDefs, 'calculate_tax.json');
        expect(resultMulti.valid).toBe(false);
        expect(resultMulti.errors[0]).toContain('code must contain exactly one definition named "calculate_tax"');
    });
});

describe('Parity check (checkProjectParity)', () => {
    it('passes for flow_demo with 100% parity across all documented units', () => {
        const flowDemoPath = path.resolve(__dirname, '..', 'examples', 'flow_demo');
        const result = checkProjectParity(flowDemoPath);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.documentedUnits).toContain('clamp');
        expect(result.documentedUnits).toContain('percent');
        expect(result.documentedUnits).toContain('label');
        expect(result.documentedUnits).toContain('grade');
        expect(result.documentedUnits).toContain('report');
        expect(result.documentedUnits).toContain('main');
    });

    it('detects and flags undocumented rogue functions in project Python files', () => {
        const tmpDir = path.resolve(__dirname, '..', 'node_modules', '.tmp_parity_test');
        fs.mkdirSync(path.join(tmpDir, 'slate', 'nodes'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

        try {
            // Write slate.json
            fs.writeFileSync(path.join(tmpDir, 'slate', 'slate.json'), JSON.stringify({
                slate: 3,
                name: 'parity_test',
                language: 'python',
                compile: { outDir: 'src' },
            }));

            // Write 1 documented node
            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'add.json'), JSON.stringify({
                slate: 3,
                name: 'add',
                intent: 'Add two numbers',
                contract: 'Return sum',
                code: ['def add(a: int, b: int) -> int:', '    return a + b'],
            }));

            // Write compiled python file with a documented function AND an undocumented rogue function
            fs.writeFileSync(path.join(tmpDir, 'src', 'math_ops.py'), [
                'def add(a: int, b: int) -> int:',
                '    return a + b',
                '',
                'def backdoor_rogue_fn(secret: str) -> None:',
                '    print("rogue")',
            ].join('\n'));

            const result = checkProjectParity(tmpDir);
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBe(1);
            expect(result.errors[0]).toContain('[ROGUE_FUNCTION] Undocumented function "backdoor_rogue_fn"');
            expect(result.errors[0]).toContain('math_ops.py:4');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Drift check (checkProjectDrift)', () => {
    it('passes for flow_demo with zero compilation drift against committed output', () => {
        const flowDemoPath = path.resolve(__dirname, '..', 'examples', 'flow_demo');
        const result = checkProjectDrift(flowDemoPath);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.filesChecked).toEqual(expect.arrayContaining(['flow_demo.py', 'scoring.py', 'text.py']));
    });

    it('detects and flags content drift when a committed file differs from compile output', () => {
        const tmpDir = path.resolve(__dirname, '..', 'node_modules', '.tmp_drift_test');
        fs.mkdirSync(path.join(tmpDir, 'slate', 'nodes'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'slate', 'flows'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'slate', 'slate.json'), JSON.stringify({
                slate: 3,
                name: 'drift_test',
                language: 'python',
                compile: { outDir: 'src' },
            }));

            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'add.json'), JSON.stringify({
                slate: 3,
                name: 'add',
                intent: 'Add numbers',
                contract: 'Return sum',
                code: ['def add(a: int, b: int) -> int:', '    return a + b'],
            }));

            // Write modified/drifted file on disk
            fs.writeFileSync(path.join(tmpDir, 'src', 'drift_test.py'), '# Drifted manual edit\n');

            const result = checkProjectDrift(tmpDir);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('[COMPILE_DRIFT]') && e.includes('File content mismatch'))).toBe(true);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('detects unexpected extra files in compiled outDir', () => {
        const tmpDir = path.resolve(__dirname, '..', 'node_modules', '.tmp_extra_drift_test');
        fs.mkdirSync(path.join(tmpDir, 'slate', 'nodes'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'slate', 'slate.json'), JSON.stringify({
                slate: 3,
                name: 'extra_drift_test',
                language: 'python',
                compile: { outDir: 'src' },
            }));

            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'add.json'), JSON.stringify({
                slate: 3,
                name: 'add',
                intent: 'Add numbers',
                contract: 'Return sum',
                code: ['def add(a: int, b: int) -> int:', '    return a + b'],
            }));

            // Write extra rogue python file in outDir
            fs.writeFileSync(path.join(tmpDir, 'src', 'extra_rogue.py'), '# extra file\n');

            const result = checkProjectDrift(tmpDir);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('[COMPILE_DRIFT]') && e.includes('Unexpected extra file'))).toBe(true);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('fails when output directory does not exist on disk', () => {
        const tmpDir = path.resolve(__dirname, '..', 'node_modules', '.tmp_missing_outdir_test');
        fs.mkdirSync(path.join(tmpDir, 'slate', 'nodes'), { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'slate', 'slate.json'), JSON.stringify({
                slate: 3,
                name: 'missing_outdir',
                language: 'python',
                compile: { outDir: 'src/generated' },
            }));

            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'add.json'), JSON.stringify({
                slate: 3,
                name: 'add',
                intent: 'Add numbers',
                contract: 'Return sum',
                code: ['def add(a: int, b: int) -> int:', '    return a + b'],
            }));

            // outDir src/generated does not exist
            const result = checkProjectDrift(tmpDir);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('[COMPILE_DRIFT]') && e.includes('Output directory "src/generated" does not exist'))).toBe(true);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('recursively processes directory entries in config.library without error', () => {
        const tmpDir = path.resolve(__dirname, '..', 'node_modules', '.tmp_lib_dir_test');
        fs.mkdirSync(path.join(tmpDir, 'slate', 'nodes'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'vendor', 'nested'), { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'slate', 'slate.json'), JSON.stringify({
                slate: 3,
                name: 'lib_dir_test',
                language: 'python',
                compile: { outDir: 'src' },
                library: ['vendor'], // directory entry!
            }));

            fs.writeFileSync(path.join(tmpDir, 'vendor', 'nested', 'helpers.py'), [
                'def helper_util(x: int) -> int:',
                '    return x * 2',
            ].join('\n'));

            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'add.json'), JSON.stringify({
                slate: 3,
                name: 'add',
                intent: 'Add numbers',
                contract: 'Return sum',
                code: ['def add(a: int, b: int) -> int:', '    return a + b'],
            }));

            fs.writeFileSync(path.join(tmpDir, 'src', 'lib_dir_test.py'), [
                '# Generated by Slate from slate/nodes/; edit the node files, not this file.',
                '',
                '',
                '# slate: nodes/add',
                '# intent: Add numbers',
                '# contract: Return sum',
                'def add(a: int, b: int) -> int:',
                '    return a + b',
                '',
            ].join('\n'));

            // Neither parity nor drift should crash on directory entry 'vendor', and helper_util shouldn't be rogue
            const parity = checkProjectParity(tmpDir);
            expect(parity.valid).toBe(true);
            expect(parity.documentedUnits).toContain('helper_util');

            const drift = checkProjectDrift(tmpDir);
            expect(drift.valid).toBe(true);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Workspace-wide contract verification (verifyAll)', () => {
    it('verifies all active workspace projects cleanly', () => {
        const result = verifyAll();
        expect(result.success).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.stats.projectsCount).toBeGreaterThanOrEqual(2);
        expect(result.stats.nodesCount).toBeGreaterThanOrEqual(5);
    });
});

describe('4-Pillar CI gate (ci_verifier & standalone CLI)', () => {
    it('keeps embedded node and flow schemas identical to contracts/*.schema.json', () => {
        const diskNode = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'contracts', 'slate-node.schema.json'), 'utf8'));
        const diskFlow = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'contracts', 'slate-flow.schema.json'), 'utf8'));
        expect(EMBEDDED_NODE_SCHEMA).toEqual(diskNode);
        expect(EMBEDDED_FLOW_SCHEMA).toEqual(diskFlow);
    });

    it('resolves ci defaults and overrides cleanly', () => {
        expect(resolveCiConfig({ slate: 3, name: 'p', language: 'python' })).toEqual({
            srcRoots: ['src'],
            testRoots: ['tests', 'test'],
            requireTests: false,
        });
        expect(resolveCiConfig({
            slate: 3,
            name: 'p',
            language: 'python',
            compile: { outDir: 'pkg/cfd' },
            ci: { srcRoots: ['pkg/cfd', 'custom'], testRoots: ['unit_tests'], requireTests: true },
        })).toEqual({
            srcRoots: ['pkg/cfd', 'custom'],
            testRoots: ['unit_tests'],
            requireTests: true,
        });
    });

    it('scopes parity strictly to srcRoots without scanning unrelated repo scripts, and verifies Pillar 4 test coverage', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-4pillar-ci-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'slate', 'nodes'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'slate', 'flows'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'cfd_src'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'my_tests'), { recursive: true });

            fs.writeFileSync(path.join(tmpDir, 'slate', 'slate.json'), JSON.stringify({
                slate: 3,
                name: 'hawa_demo',
                language: 'python',
                compile: { outDir: 'cfd_src' },
                ci: {
                    srcRoots: ['cfd_src'],
                    testRoots: ['my_tests'],
                    requireTests: true,
                },
            }, null, 2));

            // 1 node covered via node.cases, 1 via external test file, 1 missing coverage, plus 1 prelude
            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', '_prelude.json'), JSON.stringify({
                slate: 3,
                name: '_prelude',
                kind: 'prelude',
                intent: 'Constants',
                contract: 'Defines GAMMA',
                code: ['GAMMA = 1.4'],
            }));
            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'step_flux.json'), JSON.stringify({
                slate: 3,
                name: 'step_flux',
                intent: 'Compute flux',
                contract: 'Returns x * 2.0',
                cases: [{ name: 'c1', inputs: { x: 2.0 }, expected: 4.0 }],
                code: ['def step_flux(x: float) -> float:', '    return x * 2.0'],
            }));
            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'calc_cfl.json'), JSON.stringify({
                slate: 3,
                name: 'calc_cfl',
                intent: 'Compute CFL',
                contract: 'Returns dt',
                code: ['def calc_cfl(dx: float) -> float:', '    return dx * 0.5'],
            }));
            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'untested_fn.json'), JSON.stringify({
                slate: 3,
                name: 'untested_fn',
                intent: 'Untested helper',
                contract: 'Returns x',
                code: ['def untested_fn(x: float) -> float:', '    return x'],
            }));

            // Unrelated repo script outside srcRoots has an arbitrary unmapped function (must NOT be scanned)
            fs.writeFileSync(path.join(tmpDir, 'scripts', 'train_cfd.py'), [
                'def ad_hoc_plot(data):',
                '    return data',
            ].join('\n'));

            // External tests: one covering calc_cfl, one orphan unmapped test
            fs.writeFileSync(path.join(tmpDir, 'my_tests', 'test_cfl.py'), [
                'def test_cfl_basic():',
                '    assert calc_cfl(2.0) == 1.0',
            ].join('\n'));
            fs.writeFileSync(path.join(tmpDir, 'my_tests', 'test_orphan.py'), [
                'def test_nothing():',
                '    assert True',
            ].join('\n'));

            // Compiled output in cfd_src (initially skip compile drift by matching compiler output)
            const initial = verifyProjectCi(tmpDir);
            expect(initial.pillars.schema.valid).toBe(true);
            expect(initial.pillars.stub.valid).toBe(true);
            // Only drift error so far because cfd_src/hawa_demo.py not written yet; parity ignored scripts/train_cfd.py
            expect(initial.pillars.code.parityFilesChecked).toEqual([]);
            expect(initial.pillars.test.valid).toBe(false);
            expect(initial.pillars.test.coveredNodes).toEqual(['calc_cfl', 'step_flux']);
            expect(initial.pillars.test.missingNodes).toEqual(['untested_fn']);
            expect(initial.pillars.test.unmappedTestFiles).toEqual(['my_tests/test_orphan.py']);
            expect(initial.pillars.test.errors).toHaveLength(1);
            expect(initial.pillars.test.errors[0]).toContain('[MISSING_TEST] Atomic node "untested_fn"');

            // With requireTests: false override, test pillar succeeds with clean warnings
            const relaxedTests = checkProjectTests(tmpDir, { requireTests: false });
            expect(relaxedTests.valid).toBe(true);
            expect(relaxedTests.warnings.some(w => w.includes('[MISSING_TEST]'))).toBe(true);
            expect(relaxedTests.warnings.some(w => w.includes('[UNMAPPED_TEST]'))).toBe(true);

            // Adding a rogue function inside srcRoots fails Pillar 3 parity
            fs.writeFileSync(path.join(tmpDir, 'cfd_src', 'rogue.py'), 'def rogue_cfd(x: int) -> int:\n    return x\n');
            const parity = checkProjectParity(tmpDir);
            expect(parity.valid).toBe(false);
            expect(parity.errors[0]).toContain('[ROGUE_FUNCTION] Undocumented function "rogue_cfd"');

            // Standalone CLI helper reports failure exit code 1 with JSON output
            let stdout = '';
            let stderr = '';
            const code = runSlateVerifyCiCli(['--workspace', tmpDir, '--json'], {
                stdout: s => { stdout += s; },
                stderr: s => { stderr += s; },
            });
            expect(code).toBe(1);
            expect(stderr).toBe('');
            const parsedJson = JSON.parse(stdout);
            expect(parsedJson.valid).toBe(false);
            expect(parsedJson.pillars.test.missingNodes).toEqual(['untested_fn']);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('runs the bundled standalone out/cli/slate_verify_ci.js CLI cleanly against examples/flow_demo', () => {
        const cliBundle = path.resolve(__dirname, '..', 'vscode-extension', 'out', 'cli', 'slate_verify_ci.js');
        const flowDemo = path.resolve(__dirname, '..', 'examples', 'flow_demo');
        const out = execFileSync(process.execPath, [cliBundle, '--workspace', flowDemo, '--json'], {
            encoding: 'utf8',
            timeout: 15000,
        });
        const report = JSON.parse(out);
        expect(report.valid).toBe(true);
        expect(report.pillars.schema.valid).toBe(true);
        expect(report.pillars.stub.valid).toBe(true);
        expect(report.pillars.code.valid).toBe(true);
        expect(report.pillars.test.valid).toBe(true);
    });

    it('validates class frames + owned methods across all 4 CI pillars and catches rogue classes, rogue methods, and orphan methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-ci-class-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'slate', 'nodes', 'models', 'ConvBlock'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'slate', 'flows'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'src', 'models'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });

            fs.writeFileSync(path.join(tmpDir, 'slate', 'slate.json'), JSON.stringify({
                slate: 3,
                name: 'nn_app',
                language: 'python',
                compile: { outDir: 'src' },
                ci: { srcRoots: ['src'], testRoots: ['tests'], requireTests: true },
            }, null, 2));

            // >60 line class frame of typed fields is exempt from JPL-60 line cap
            const longFields = Array.from({ length: 65 }, (_, i) => `    param_${i}: int = ${i}`);
            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'models', 'ConvBlock.json'), JSON.stringify({
                slate: 3,
                name: 'ConvBlock',
                kind: 'class',
                intent: 'Conv block container with configuration fields',
                contract: 'Immutable field defaults',
                context: [],
                examples: [],
                locked: false,
                imports: [],
                uses: [],
                code: ['class ConvBlock:', ...longFields],
            }));

            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'models', 'ConvBlock', '__init__.json'), JSON.stringify({
                slate: 3,
                name: '__init__',
                classOwner: 'models/ConvBlock',
                intent: 'Store scale',
                contract: 'scale >= 0',
                context: [],
                examples: [],
                locked: false,
                imports: [],
                uses: [],
                code: ['def __init__(self, scale: float = 1.0) -> None:', '    self.scale = scale'],
            }));

            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'models', 'ConvBlock', 'forward.json'), JSON.stringify({
                slate: 3,
                name: 'forward',
                classOwner: 'models/ConvBlock',
                intent: 'Scale value by self.scale',
                contract: 'Returns float',
                context: [],
                examples: [],
                locked: false,
                imports: [],
                uses: [],
                cases: [{ name: 'fwd', inputs: { x: 2.0 }, expected: 2.0 }],
                code: ['def forward(self, x: float) -> float:', '    return x * self.scale'],
            }));

            fs.writeFileSync(path.join(tmpDir, 'tests', 'test_conv.py'), [
                'def test_conv_init():',
                '    b = ConvBlock(2.0)',
                '    assert b.scale == 2.0',
            ].join('\n'));

            // Write matching compiled output so drift passes
            const driftBefore = verifyProjectCi(tmpDir);
            expect(driftBefore.pillars.schema.valid).toBe(true);
            expect(driftBefore.pillars.stub.valid).toBe(true);
            expect(driftBefore.pillars.test.valid).toBe(true);
            expect(driftBefore.pillars.test.missingNodes).toEqual([]);

            // Now simulate compiled models.py containing a rogue undocumented method and another file containing a rogue class
            fs.writeFileSync(path.join(tmpDir, 'src', 'models.py'), [
                'class ConvBlock:',
                ...longFields,
                '    def __init__(self, scale: float = 1.0) -> None:',
                '        self.scale = scale',
                '    def forward(self, x: float) -> float:',
                '        return x * self.scale',
                '    def rogue_method(self, x: float) -> float:',
                '        return x',
            ].join('\n'));
            fs.writeFileSync(path.join(tmpDir, 'src', 'extra.py'), 'class RogueLayer:\n    pass\n');

            const parity = checkProjectParity(tmpDir);
            expect(parity.valid).toBe(false);
            expect(parity.errors.some(e => e.includes('[ROGUE_METHOD] Undocumented method "ConvBlock.rogue_method"'))).toBe(true);
            expect(parity.errors.some(e => e.includes('[ROGUE_CLASS] Undocumented class "RogueLayer"'))).toBe(true);

            // Adding a method directly inside a class frame JSON triggers [CLASS_FRAME_METHOD]
            const badFrame = validateNodeAst({
                name: 'ConvBlock',
                kind: 'class',
                intent: 'Bad frame',
                contract: 'Bad',
                code: ['class ConvBlock:', '    def embedded(self) -> None:', '        pass'],
            }, 'models/ConvBlock.json', 'python');
            expect(badFrame.valid).toBe(false);
            expect(badFrame.errors.some(e => e.includes('[CLASS_FRAME_METHOD]'))).toBe(true);

            // An owned method pointing to a missing owner triggers [ORPHAN_METHOD]
            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'models', 'ConvBlock', 'orphan.json'), JSON.stringify({
                slate: 3,
                name: 'orphan',
                classOwner: 'models/MissingClass',
                intent: 'Orphan',
                contract: 'None',
                context: [],
                examples: [],
                locked: false,
                imports: [],
                uses: [],
                code: ['def orphan(self) -> None:', '    pass'],
            }));
            const orphanReport = verifyProjectCi(tmpDir);
            expect(orphanReport.pillars.stub.valid).toBe(false);
            expect(orphanReport.pillars.stub.errors.some(e => e.includes('[ORPHAN_METHOD]'))).toBe(true);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('counts collectable Test* class methods as coverage and rejects comment-only check or unusable cases', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-ci-test-validity-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'slate', 'nodes'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'slate', 'flows'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });

            fs.writeFileSync(path.join(tmpDir, 'slate', 'slate.json'), JSON.stringify({
                slate: 3,
                name: 'test_validity',
                language: 'python',
                compile: { outDir: 'src' },
                ci: { srcRoots: ['src'], testRoots: ['tests'], requireTests: true },
            }));

            const makePyNode = (name: string, patch: Record<string, unknown> = {}) => ({
                slate: 3,
                name,
                intent: `Compute ${name}`,
                contract: 'Returns int',
                context: [],
                examples: [],
                locked: false,
                imports: [],
                uses: [],
                code: [`def ${name}(x: int) -> int:`, '    return x'],
                ...patch,
            });

            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'fn_class_test.json'), JSON.stringify(makePyNode('fn_class_test')));
            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'fn_comment_check.json'), JSON.stringify(makePyNode('fn_comment_check', {
                check: ['# TODO: add real pytest'],
            })));
            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'fn_import_check.json'), JSON.stringify(makePyNode('fn_import_check', {
                check: ['import pytest'],
            })));
            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'fn_empty_case.json'), JSON.stringify(makePyNode('fn_empty_case', {
                cases: [{}, '# comment-only'],
            })));
            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'fn_helper_cls_only.json'), JSON.stringify(makePyNode('fn_helper_cls_only')));
            fs.writeFileSync(path.join(tmpDir, 'slate', 'nodes', 'fn_init_cls_only.json'), JSON.stringify(makePyNode('fn_init_cls_only')));

            fs.writeFileSync(path.join(tmpDir, 'tests', 'test_suite.py'), [
                'class TestSuite:',
                '    def test_class_based(self):',
                '        assert fn_class_test(2) == 2',
                'class HelperNotATest:',
                '    def test_ignored(self):',
                '        assert fn_helper_cls_only(2) == 2',
                'class TestWithInit:',
                '    def __init__(self):',
                '        pass',
                '    def test_uncollectable(self):',
                '        assert fn_init_cls_only(2) == 2',
            ].join('\n'));

            const testPillar = checkProjectTests(tmpDir);
            expect(testPillar.valid).toBe(false);
            expect(testPillar.coveredNodes).toEqual(['fn_class_test']);
            expect(testPillar.missingNodes).toEqual([
                'fn_comment_check',
                'fn_empty_case',
                'fn_helper_cls_only',
                'fn_import_check',
                'fn_init_cls_only',
            ]);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
