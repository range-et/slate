#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -x "$ROOT/.venv/bin/python" ]]; then
  PYTHON="$ROOT/.venv/bin/python"
else
  PYTHON="${PYTHON_BIN:-python3}"
fi

if ! "$PYTHON" -c 'import pytest' >/dev/null 2>&1; then
  echo "pytest is missing for $PYTHON. Run: python3 -m pip install pytest" >&2
  exit 2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/slate-baseline.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

npm run verify:static
npm test
npm run test:mutation
npm run build
npm --prefix vscode-extension run compile
npm run verify:contracts

# Example round-trips: port example Python into slate/ nodes, compile them back,
# and run their unit suites against the compiled output.
node scripts/port-compile.js examples/calculator "$TMP/ported/calculator"
node scripts/port-compile.js examples/tic_tac_toe "$TMP/ported/tic_tac_toe"
SLATE_CALCULATOR_DIR="$TMP/ported/calculator" \
  "$PYTHON" -m pytest --import-mode=importlib examples/calculator/tests
SLATE_TIC_TAC_TOE_FILE="$TMP/ported/tic_tac_toe/game.py" \
  "$PYTHON" -m pytest --import-mode=importlib examples/tic_tac_toe/tests

# Phase 4 gate: compile a project with flows and a library file, then run its tests.
node scripts/compile-slate.js examples/flow_demo "$TMP/flow_demo"
SLATE_FLOW_DEMO_DIR="$TMP/flow_demo" \
  "$PYTHON" -m pytest --import-mode=importlib examples/flow_demo/tests

echo "Slate baseline verification passed."
