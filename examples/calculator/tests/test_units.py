"""Unit tests for calculator.py — run with `pytest` from this folder.

Compile the slate calculator doc first (it writes calculator.py at the
example root), then `pytest examples/calculator/tests`.
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
