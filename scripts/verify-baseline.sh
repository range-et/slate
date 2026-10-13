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

npm test
npm run build
npm --prefix vscode-extension run compile

# Frozen legacy notebook: still deployed to GitHub Pages, so keep it green.
npm run legacy:test
npm run legacy:build
(
  cd legacy
  node scripts/slate_roundtrip.js examples/calculator/calculator.slate.json
  node scripts/slate_roundtrip.js examples/tic_tac_toe/tic_tac_toe.slate.json
  node scripts/compile_examples.mjs "$TMP"
)

SLATE_CALCULATOR_DIR="$TMP/calculator" \
  "$PYTHON" -m pytest --import-mode=importlib legacy/examples/calculator/tests
SLATE_TIC_TAC_TOE_FILE="$TMP/tic_tac_toe/game.py" \
  "$PYTHON" -m pytest --import-mode=importlib legacy/examples/tic_tac_toe/tests

# Phase 2 gate: port the example Python into slate/ nodes, compile them back,
# and run the original suites against the output. The checked-in tic-tac-toe
# game.py lacks its imports, so its legacy compile output is the port source.
node scripts/port-compile.js legacy/examples/calculator "$TMP/ported/calculator"
node scripts/port-compile.js "$TMP/tic_tac_toe" "$TMP/ported/tic_tac_toe"
SLATE_CALCULATOR_DIR="$TMP/ported/calculator" \
  "$PYTHON" -m pytest --import-mode=importlib legacy/examples/calculator/tests
SLATE_TIC_TAC_TOE_FILE="$TMP/ported/tic_tac_toe/game.py" \
  "$PYTHON" -m pytest --import-mode=importlib legacy/examples/tic_tac_toe/tests

echo "Slate baseline verification passed."
