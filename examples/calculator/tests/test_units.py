"""Unit tests for the calculator example — run with `pytest` from this folder.

Compile both slate docs first (each compile writes its .py at the example
root):
    1. Open the calculator project in slate.
    2. Switch to the `operations` doc → click COMPILE.
    3. Switch to the `calculator` doc → click COMPILE.

Then run `pytest examples/calculator/tests` from the repo root.
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
    # Honor the sys.modules cache so calling _load_all() multiple times
    # (e.g. once per test, or twice inside one test) returns the SAME
    # module object. Without this, each call exec_module()s a fresh
    # `operations` module with its own brand-new OPS dict, and any
    # reference to a previously-loaded `calculator.OPS` ends up pointing
    # at a stale operations instance — exactly what made
    # test_calc_imports_from_ops flake.
    cached = sys.modules.get(name)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_all():
    # Make EXAMPLE_ROOT discoverable so calculator.py's
    # `from operations import ...` works at exec time.
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
    emitted the `from operations import ...` line in calculator.py's
    header AND that the OPS/register_ops/apply_operation symbols actually
    live in operations.py.
    """
    # One _load_all() — both modules from the same load cycle so
    # `calc.OPS` and `ops.OPS` are guaranteed to be the same object.
    ops, calc = _load_all()
    # Whatever `from operations import ...` resolved to should be the
    # exact same objects the operations module exports.
    assert calc.OPS is ops.OPS
    assert calc.register_ops is ops.register_ops
    assert calc.apply_operation is ops.apply_operation
