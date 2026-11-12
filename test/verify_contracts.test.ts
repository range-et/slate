import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
    validateNodeSchema,
    validateFlowSchema,
    validateNodeAst,
    checkProjectParity,
    checkProjectDrift,
    validateProjectContracts,
    verifyAll,
} from '../scripts/verify-contracts.mjs';

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
        expect(validateNodeSchema({ ...validNode, slate: 4 }).errors[0]).toContain('"slate" must be 3');
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
        expect(result61.errors[0]).toContain('exceeds JPL-60 limit of 60 lines (61 lines > 60)');
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

    it('rejects invalid flow structure', () => {
        expect(validateFlowSchema({ ...validFlow, slate: 1 }).valid).toBe(false);
        expect(validateFlowSchema({ ...validFlow, name: 'bad-name' }).valid).toBe(false);
        expect(validateFlowSchema({ ...validFlow, inputs: 'not-array' }).valid).toBe(false);
        expect(validateFlowSchema({ ...validFlow, wires: null }).valid).toBe(false);
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

    it('reports definition name mismatch', () => {
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
        expect(result.errors[0]).toContain('code must define top-level function named "calculate_tax"');
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
