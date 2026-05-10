/**
 * Generator for examples/calculator/calculator.slate.json (and the
 * prompts-only variant calculator.prompts_only.slate.json).
 *
 * Run with:
 *   node examples/calculator/scaffold.mjs
 *
 * Emits both files. The prompts-only variant has every body card's `content`
 * blanked so you can exercise the GENERATE ALL workflow end-to-end against a
 * local model — the prompts and structure are identical to the filled-in
 * variant, so once GENERATE ALL finishes you should see something close to
 * the working version.
 *
 * v0.2 phase 1 schema (no `targetId`, no `language`). All cards are functional
 * Python — no class nesting yet (#13).
 *
 * ── two-doc shape (split 2026-05-10) ──────────────────────────────────────
 * Project: calculator
 *   Doc 1: operations  → operations.py
 *     header        — module docstring, OPS dict scaffold, typing imports
 *     add / subtract / multiply / divide   — pure math (no cross-doc deps)
 *     register_ops  — populates OPS from the four math fns
 *     apply_operation — looks up an op in OPS and applies it
 *   Doc 2: calculator  → calculator.py (depends on operations.py)
 *     header        — module docstring + `from operations import ...`
 *     read_number / read_two_numbers / read_operator   — I/O
 *     main          — orchestration (uses cross-doc symbols via @-refs)
 *
 * Why split?
 *   1. Exercises the cross-doc @-reference resolver in chat_ctl's
 *      buildBibliography (the operations doc is a "leaf" with no deps;
 *      the calculator doc depends on it — perfect shape for the future
 *      DAG topo solver in #15).
 *   2. Exercises the per-doc compile pipeline twice — operations.py and
 *      calculator.py both land at examples/calculator/<file>.py, so the
 *      pytest suite needs both on sys.path.
 *   3. Demonstrates the project-wide import pattern: `from operations
 *      import ...` in the calculator header card.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ISO = '2026-05-10T12:00:00.000Z';

// ───────────────────────── operations doc ─────────────────────────
// Pure math + the registry table. No I/O, no cross-doc imports.
const ops_header_src = `"""Pure-math operations + the OPS registry table.

The four arithmetic functions are deliberately leaf-level (no slate
cross-doc dependencies) so the future DAG solver (#15) can prove it can
walk this doc bottom-up before touching the calculator doc.
"""
from typing import Callable, Dict

# Operations table is built once at import time so @apply_operation can
# look up the chosen op without an if/elif chain in every call.
OPS: Dict[str, Callable[[float, float], float]] = {}`;

const add_src = `def add(a: float, b: float) -> float:
    """Return a + b."""
    return a + b`;

const subtract_src = `def subtract(a: float, b: float) -> float:
    """Return a - b."""
    return a - b`;

const multiply_src = `def multiply(a: float, b: float) -> float:
    """Return a * b."""
    return a * b`;

const divide_src = `def divide(a: float, b: float) -> float:
    """Return a / b. Raises ZeroDivisionError if b is zero (caller must handle)."""
    if b == 0:
        raise ZeroDivisionError("Cannot divide by zero")
    return a / b`;

const register_ops_src = `def register_ops() -> None:
    """Populate the global OPS table once. Idempotent: safe to call twice."""
    OPS.clear()
    OPS['+'] = add
    OPS['-'] = subtract
    OPS['*'] = multiply
    OPS['/'] = divide`;

const apply_operation_src = `def apply_operation(op: str, a: float, b: float) -> float:
    """Look \`op\` up in OPS and apply it to (a, b). KeyError on unknown op."""
    if op not in OPS:
        raise KeyError(f"Unknown operator: {op!r}")
    return OPS[op](a, b)`;

// ───────────────────────── calculator doc ─────────────────────────
// I/O + orchestration. Imports the math/registry from operations.py so
// the relative-import path is exercised at compile time.
const calc_header_src = `"""Tiny CLI calculator — read two numbers + one op, print the result.

Imports its math kernel from the sibling \`operations\` doc, which the
slate compiler emits as operations.py at the same destination. This
demonstrates the cross-doc compile pattern: each doc is its own .py file,
and inter-doc deps are plain Python imports.
"""
from operations import OPS, register_ops, apply_operation`;

const read_number_src = `def read_number(prompt: str) -> float:
    """Prompt the user until they enter a parseable float."""
    while True:
        raw = input(prompt).strip()
        try:
            return float(raw)
        except ValueError:
            print(f"  '{raw}' is not a number — try again.")`;

const read_two_numbers_src = `def read_two_numbers() -> tuple[float, float]:
    """Read two floats from stdin via @read_number. Returns (a, b)."""
    a = read_number("Enter the first number: ")
    b = read_number("Enter the second number: ")
    return a, b`;

const read_operator_src = `def read_operator() -> str:
    """Prompt until the user picks one of the registered operators."""
    while True:
        op = input(f"Operator ({'/'.join(sorted(OPS))}): ").strip()
        if op in OPS:
            return op
        print(f"  '{op}' is not one of {sorted(OPS)}.")`;

const main_src = `def main() -> None:
    """Entry point. Wires @register_ops + @read_two_numbers + @read_operator
    + @apply_operation, prints the result, and handles divide-by-zero."""
    register_ops()
    a, b = read_two_numbers()
    op = read_operator()
    try:
        result = apply_operation(op, a, b)
    except ZeroDivisionError as exc:
        print(f"Error: {exc}")
        return
    print(f"{a} {op} {b} = {result}")


if __name__ == '__main__':
    main()`;

// ───────────────────────── external tests file ───────────────────
// Tests are NOT a slate doc — they're a static pytest file you run yourself
// against the compiled .py files. Slate just generates the apps; you run
// `pytest examples/calculator/tests` from the terminal to grade them.
//
// After the two-doc split there are TWO compiled files: operations.py and
// calculator.py. pytest needs both reachable on sys.path.
const tests_file_src = `"""Unit tests for the calculator example — run with \`pytest\` from this folder.

Compile both slate docs first (each compile writes its .py at the example
root):
    1. Open the calculator project in slate.
    2. Switch to the \`operations\` doc → click COMPILE.
    3. Switch to the \`calculator\` doc → click COMPILE.

Then run \`pytest examples/calculator/tests\` from the repo root.
"""
import importlib.util
import os
import sys
import pytest

HERE = os.path.dirname(__file__)
EXAMPLE_ROOT = os.path.abspath(os.path.join(HERE, '..'))
OPS_PY = os.path.join(EXAMPLE_ROOT, 'operations.py')
CALC_PY = os.path.join(EXAMPLE_ROOT, 'calculator.py')


def _load(name, path):
    if not os.path.exists(path):
        pytest.skip(f"{path} not yet compiled — run COMPILE on the matching slate doc")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_all():
    # Make EXAMPLE_ROOT discoverable so calculator.py's
    # \`from operations import ...\` works at exec time.
    if EXAMPLE_ROOT not in sys.path:
        sys.path.insert(0, EXAMPLE_ROOT)
    ops = _load('operations', OPS_PY)
    calc = _load('calculator', CALC_PY)
    ops.register_ops()
    return ops, calc


def test_add():
    """add returns the arithmetic sum."""
    ops, _ = _load_all()
    assert ops.add(2, 3) == 5
    assert ops.add(-1, 1) == 0
    assert ops.add(0.1, 0.2) == pytest.approx(0.3)


def test_subtract():
    """subtract is non-commutative and signed."""
    ops, _ = _load_all()
    assert ops.subtract(5, 3) == 2
    assert ops.subtract(3, 5) == -2


def test_multiply():
    """multiply returns the product."""
    ops, _ = _load_all()
    assert ops.multiply(4, 3) == 12
    assert ops.multiply(-2, 3) == -6
    assert ops.multiply(0, 99) == 0


def test_divide():
    """divide returns float quotient and raises on zero."""
    ops, _ = _load_all()
    assert ops.divide(10, 4) == 2.5
    with pytest.raises(ZeroDivisionError):
        ops.divide(1, 0)


def test_apply_operation():
    """apply_operation routes via the OPS table; unknown op raises KeyError."""
    ops, _ = _load_all()
    assert ops.apply_operation('+', 2, 3) == 5
    assert ops.apply_operation('-', 2, 3) == -1
    assert ops.apply_operation('*', 2, 3) == 6
    assert ops.apply_operation('/', 6, 3) == 2
    with pytest.raises(KeyError):
        ops.apply_operation('%', 1, 1)


def test_register_ops_idempotent():
    """Calling register_ops twice gives the same OPS table — no duplicates, no growth."""
    ops, _ = _load_all()
    ops.register_ops()
    first = dict(ops.OPS)
    ops.register_ops()
    assert ops.OPS == first


def test_calc_imports_from_ops():
    """calculator.py must successfully import from operations.py at exec time.

    This is the cross-doc-compile smoke test — proves the slate compiler
    emitted the \`from operations import ...\` line in calculator.py's
    header AND that the OPS/register_ops/apply_operation symbols actually
    live in operations.py.
    """
    _, calc = _load_all()
    # Whatever \`from operations import ...\` resolved to should be the
    # exact same objects the operations module exports.
    ops, _ = _load_all()
    assert calc.OPS is ops.OPS
    assert calc.register_ops is ops.register_ops
    assert calc.apply_operation is ops.apply_operation
`;

// ───────────────────────── assembly ─────────────────────────────────

function card({ id, title, src, prompt, links = [], cardType = 'code', kind = 'body' }) {
    return { id, title, content: src, prompt, images: [], links, cardType, kind };
}

function buildProject() {
    return {
        id: 'calc-project-001',
        name: 'calculator',
        docs: [
            // ── operations doc → compiles to examples/calculator/operations.py ──
            // Leaf doc: no cross-doc dependencies. The math kernel + OPS table.
            {
                id: 'calc-doc-ops-001',
                title: 'operations',
                summary: null,
                destination: '',
                createdAt: ISO,
                updatedAt: ISO,
                cardCount: 7,
                cards: [
                    card({ id: 'calc-ops-000', title: '__header__', src: ops_header_src,
                           prompt: '', cardType: 'markdown', kind: 'header' }),
                    card({ id: 'calc-ops-001', title: 'add', src: add_src,
                           prompt: 'Return a + b. Pure, no side effects.' }),
                    card({ id: 'calc-ops-002', title: 'subtract', src: subtract_src,
                           prompt: 'Return a - b. Pure, no side effects.' }),
                    card({ id: 'calc-ops-003', title: 'multiply', src: multiply_src,
                           prompt: 'Return a * b. Pure, no side effects.' }),
                    card({ id: 'calc-ops-004', title: 'divide', src: divide_src,
                           prompt: 'Return a / b. If b is zero, raise ZeroDivisionError("Cannot divide by zero") so the caller can handle it cleanly.' }),
                    card({ id: 'calc-ops-005', title: 'register_ops', src: register_ops_src,
                           links: ['add', 'subtract', 'multiply', 'divide'],
                           prompt: 'Populate the global OPS dict (defined in the header) with mappings from operator strings to the matching function: "+" → @add, "-" → @subtract, "*" → @multiply, "/" → @divide. Idempotent — clear OPS before populating so calling twice is safe.' }),
                    card({ id: 'calc-ops-006', title: 'apply_operation', src: apply_operation_src,
                           prompt: 'Look the op up in OPS (defined in the header) and apply it to (a, b). Raise KeyError with a clear message if the op is not registered.' }),
                ],
            },
            // ── calculator doc → compiles to examples/calculator/calculator.py ──
            // Orchestration. Imports register_ops/apply_operation/OPS from the
            // operations doc via the @-reference path; the model should infer
            // the `from operations import ...` line lives in the header.
            {
                id: 'calc-doc-main-001',
                title: 'calculator',
                summary: null,
                destination: '',
                createdAt: ISO,
                updatedAt: ISO,
                cardCount: 5,
                cards: [
                    card({ id: 'calc-main-000', title: '__header__', src: calc_header_src,
                           prompt: '', cardType: 'markdown', kind: 'header' }),
                    card({ id: 'calc-main-001', title: 'read_number', src: read_number_src,
                           prompt: 'Prompt the user with the given string and re-prompt until they enter a parseable float. Returns the float.' }),
                    card({ id: 'calc-main-002', title: 'read_two_numbers', src: read_two_numbers_src,
                           links: ['read_number'],
                           prompt: 'Use @read_number twice — once with prompt "Enter the first number: " and once with "Enter the second number: " — and return them as a tuple (a, b).' }),
                    card({ id: 'calc-main-003', title: 'read_operator', src: read_operator_src,
                           prompt: 'Prompt the user (showing the keys of OPS sorted) until they enter one of the registered operators. Return the operator string. OPS is imported from the operations doc via the header.' }),
                    card({ id: 'calc-main-004', title: 'main', src: main_src,
                           links: ['register_ops', 'read_two_numbers', 'read_operator', 'apply_operation'],
                           prompt: 'Entry point. Call @register_ops (cross-doc — from operations), then read inputs via @read_two_numbers and @read_operator, then call @apply_operation (cross-doc — from operations). Print the formatted result. Catch ZeroDivisionError and print an error message instead of crashing. Include `if __name__ == "__main__": main()` at the bottom.' }),
                ],
            },
        ],
        createdAt: ISO,
        updatedAt: ISO,
        docCount: 2,
        totalCards: 12,
    };
}

/**
 * Return a deep clone of the project with every body card's `content` blanked.
 * Cards stay as cardType='code' — they're still code cards, just empty. If
 * we reset them to 'markdown', loadCardForEdit would flip the chat into
 * markdown mode and the AI would emit prose instead of raw Python.
 * Header cards keep their content — they're the doc-level prelude (and the
 * calculator header carries the cross-doc import that everything below
 * depends on, so blanking it would break the prompts-only walkthrough).
 */
function blankBodies(project) {
    const clone = JSON.parse(JSON.stringify(project));
    for (const doc of clone.docs) {
        for (const card of doc.cards) {
            if (card.kind !== 'header') {
                card.content = '';
                // cardType stays 'code' — see comment above.
            }
        }
    }
    clone.id = clone.id + '-prompts-only';
    clone.name = clone.name + ' (prompts only)';
    return clone;
}

const filled = buildProject();
const promptsOnly = blankBodies(filled);

writeFileSync(join(HERE, 'calculator.slate.json'), JSON.stringify(filled, null, 2) + '\n');
writeFileSync(join(HERE, 'calculator.prompts_only.slate.json'), JSON.stringify(promptsOnly, null, 2) + '\n');

// Tests live OUTSIDE slate — written once, run with pytest from a terminal
// against whatever .py files the slate compile step produces.
mkdirSync(join(HERE, 'tests'), { recursive: true });
writeFileSync(join(HERE, 'tests', 'test_units.py'), tests_file_src);

console.log('Wrote calculator.slate.json + calculator.prompts_only.slate.json + tests/test_units.py');
