"""Run against a compiled flow_demo: SLATE_FLOW_DEMO_DIR=<outDir> pytest examples/flow_demo/tests"""
import importlib
import os
import sys

import pytest

OUT = os.environ.get('SLATE_FLOW_DEMO_DIR')
HERE = os.path.dirname(__file__)


@pytest.fixture(scope='module')
def demo():
    if not OUT:
        pytest.skip('set SLATE_FLOW_DEMO_DIR to the compiled output')
    sys.path[:0] = [OUT, os.path.join(HERE, '..')]  # compiled modules, then vendor/ for the library
    return importlib.import_module('flow_demo')


def test_grade_fans_out_and_returns_both_outputs(demo):
    assert demo.grade(45, 50) == (90, '90%')
    assert demo.grade(80, 50) == (100, '100%')  # clamped by the default upper bound


def test_report_unpacks_a_flow_and_calls_the_library(demo):
    assert demo.report(25) == '50%!'


def test_main_runs_the_root_canvas(demo):
    assert demo.main() is None
