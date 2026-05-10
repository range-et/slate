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
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ISO = '2026-05-09T22:30:00.000Z';

// ───────────────────────── header card ────────────────────────────
const header_src = `"""Tiny CLI calculator — read two numbers + one op, print the result."""
from typing import Callable, Dict

# Operations table is built once at import time so @apply_operation can
# look up the chosen op without an if/elif chain in every call.
OPS: Dict[str, Callable[[float, float], float]] = {}`;

// ───────────────────────── body cards ────────────────────────────
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

const read_operator_src = `def read_operator() -> str:
    """Prompt until the user picks one of the registered operators."""
    while True:
        op = input(f"Operator ({'/'.join(sorted(OPS))}): ").strip()
        if op in OPS:
            return op
        print(f"  '{op}' is not one of {sorted(OPS)}.")`;

const apply_operation_src = `def apply_operation(op: str, a: float, b: float) -> float:
    """Look \`op\` up in OPS and apply it to (a, b). KeyError on unknown op."""
    if op not in OPS:
        raise KeyError(f"Unknown operator: {op!r}")
    return OPS[op](a, b)`;

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
// against the compiled calculator.py. Slate just generates the app; you run
// `pytest examples/calculator/tests` from the terminal to grade it.
const tests_file_src = `"""Unit tests for calculator.py — run with \`pytest\` from this folder.

Compile the slate calculator doc first (it writes calculator.py at the
example root), then \`pytest examples/calculator/tests\`.
"""
import importlib.util
import os
import pytest

HERE = os.path.dirname(__file__)
COMPILED = os.path.abspath(os.path.join(HERE, '..', 'calculator.py'))


def _load_module():
    if not os.path.exists(COMPILED):
        pytest.skip(f"{COMPILED} not yet compiled — run COMPILE on the calculator doc in slate")
    spec = importlib.util.spec_from_file_location('calculator', COMPILED)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.register_ops()
    return module


def test_add():
    """add returns the arithmetic sum."""
    m = _load_module()
    assert m.add(2, 3) == 5
    assert m.add(-1, 1) == 0
    assert m.add(0.1, 0.2) == pytest.approx(0.3)


def test_subtract():
    """subtract is non-commutative and signed."""
    m = _load_module()
    assert m.subtract(5, 3) == 2
    assert m.subtract(3, 5) == -2


def test_multiply():
    """multiply returns the product."""
    m = _load_module()
    assert m.multiply(4, 3) == 12
    assert m.multiply(-2, 3) == -6
    assert m.multiply(0, 99) == 0


def test_divide():
    """divide returns float quotient and raises on zero."""
    m = _load_module()
    assert m.divide(10, 4) == 2.5
    with pytest.raises(ZeroDivisionError):
        m.divide(1, 0)


def test_apply_operation():
    """apply_operation routes via the OPS table; unknown op raises KeyError."""
    m = _load_module()
    assert m.apply_operation('+', 2, 3) == 5
    assert m.apply_operation('-', 2, 3) == -1
    assert m.apply_operation('*', 2, 3) == 6
    assert m.apply_operation('/', 6, 3) == 2
    with pytest.raises(KeyError):
        m.apply_operation('%', 1, 1)


def test_register_ops_idempotent():
    """Calling register_ops twice gives the same OPS table — no duplicates, no growth."""
    m = _load_module()
    m.register_ops()
    first = dict(m.OPS)
    m.register_ops()
    assert m.OPS == first
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
            // ── calculator doc → compiles to examples/calculator/calculator.py ──
            {
                id: 'calc-doc-main-001',
                title: 'calculator',
                summary: null,
                destination: '',
                createdAt: ISO,
                updatedAt: ISO,
                cardCount: 11,
                cards: [
                    card({ id: 'calc-main-000', title: '__header__', src: header_src, prompt: '', cardType: 'markdown', kind: 'header' }),
                    card({ id: 'calc-main-001', title: 'read_number', src: read_number_src,
                           prompt: 'Prompt the user with the given string and re-prompt until they enter a parseable float. Returns the float.' }),
                    card({ id: 'calc-main-002', title: 'read_two_numbers', src: read_two_numbers_src,
                           links: ['read_number'],
                           prompt: 'Use @read_number twice — once with prompt "Enter the first number: " and once with "Enter the second number: " — and return them as a tuple (a, b).' }),
                    card({ id: 'calc-main-003', title: 'add', src: add_src,
                           prompt: 'Return a + b. Pure, no side effects.' }),
                    card({ id: 'calc-main-004', title: 'subtract', src: subtract_src,
                           prompt: 'Return a - b. Pure, no side effects.' }),
                    card({ id: 'calc-main-005', title: 'multiply', src: multiply_src,
                           prompt: 'Return a * b. Pure, no side effects.' }),
                    card({ id: 'calc-main-006', title: 'divide', src: divide_src,
                           prompt: 'Return a / b. If b is zero, raise ZeroDivisionError("Cannot divide by zero") so the caller can handle it cleanly.' }),
                    card({ id: 'calc-main-007', title: 'register_ops', src: register_ops_src,
                           links: ['add', 'subtract', 'multiply', 'divide'],
                           prompt: 'Populate the global OPS dict with mappings from operator strings to the matching function: "+" → @add, "-" → @subtract, "*" → @multiply, "/" → @divide. Idempotent — clear OPS before populating so calling twice is safe.' }),
                    card({ id: 'calc-main-008', title: 'read_operator', src: read_operator_src,
                           prompt: 'Prompt the user (showing the keys of OPS sorted) until they enter one of the registered operators. Return the operator string.' }),
                    card({ id: 'calc-main-009', title: 'apply_operation', src: apply_operation_src,
                           prompt: 'Look the op up in OPS and apply it to (a, b). Raise KeyError with a clear message if the op is not registered.' }),
                    card({ id: 'calc-main-010', title: 'main', src: main_src,
                           links: ['register_ops', 'read_two_numbers', 'read_operator', 'apply_operation'],
                           prompt: 'Entry point. Call @register_ops, then read inputs via @read_two_numbers and @read_operator, then call @apply_operation. Print the formatted result. Catch ZeroDivisionError and print an error message instead of crashing.' }),
                ],
            },
        ],
        createdAt: ISO,
        updatedAt: ISO,
        docCount: 1,
        totalCards: 11,
    };
}

/**
 * Return a deep clone of the project with every body card's `content` blanked.
 * Cards stay as cardType='code' — they're still code cards, just empty. If
 * we reset them to 'markdown', loadCardForEdit would flip the chat into
 * markdown mode and the AI would emit prose instead of raw Python.
 * Header cards keep their content — they're the doc-level prelude.
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
// against whatever calculator.py the slate compile step produces.
mkdirSync(join(HERE, 'tests'), { recursive: true });
writeFileSync(join(HERE, 'tests', 'test_units.py'), tests_file_src);

console.log('Wrote calculator.slate.json + calculator.prompts_only.slate.json + tests/test_units.py');
