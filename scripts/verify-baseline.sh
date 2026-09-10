#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -x "$ROOT/.venv/bin/python" ]]; then
  PYTHON="$ROOT/.venv/bin/python"
else
  PYTHON="${PYTHON_BIN:-python3}"
fi

if ! "$PYTHON" -c 'import libcst, pytest' >/dev/null 2>&1; then
  echo "Python engine dependencies are missing. Run: npm run setup:python-engine" >&2
  exit 2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/slate-baseline.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

npm test
npm run build
npm --prefix vscode-extension run compile
"$PYTHON" -m pytest python-engine/tests

node scripts/slate_roundtrip.js examples/calculator/calculator.slate.json
node scripts/slate_roundtrip.js examples/tic_tac_toe/tic_tac_toe.slate.json
node scripts/compile_examples.mjs "$TMP"

SLATE_CALCULATOR_DIR="$TMP/calculator" \
  "$PYTHON" -m pytest --import-mode=importlib examples/calculator/tests
SLATE_TIC_TAC_TOE_FILE="$TMP/tic_tac_toe/game.py" \
  "$PYTHON" -m pytest --import-mode=importlib examples/tic_tac_toe/tests

echo "Slate baseline verification passed."
