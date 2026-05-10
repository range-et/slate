#!/usr/bin/env bash
# start_dev.sh — one-shot dev loop for the slate VS Code extension.
# Replaces the manual steps in dev_notes.md.
#
# Usage:  ./start_dev.sh
# Then:   open VS Code on this repo and hit F5 to launch the Extension Host
#         against examples/ (or any *.slate.json in your workspace).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$SCRIPT_DIR/vscode-extension"

cd "$EXT_DIR"

if [ ! -d node_modules ]; then
    echo "▶ installing vscode-extension deps (first run)…"
    npm install
else
    echo "▶ node_modules present — skipping install"
fi

# Open VS Code on vscode-extension/ — that's where .vscode/launch.json lives,
# so F5 binds to the "Run Slate Extension" extensionHost config. Skipped if
# `code` CLI isn't installed (Cmd+Shift+P → "Shell Command: Install 'code'").
if command -v code >/dev/null 2>&1; then
    echo "▶ opening VS Code on vscode-extension/ (hit F5 to launch ext host)"
    code "$EXT_DIR"
else
    echo "⚠ 'code' CLI not on PATH — open $EXT_DIR in VS Code manually."
fi

cat <<'EOF'

────────────────────────────────────────────────────────────
  TS watch is starting. Leave this terminal running.

  In the VS Code window that just opened:
    1. press F5  → launches the Extension Development Host
    2. in the host window, open any *.slate.json from
       examples/ (or anywhere in your workspace) to test.
────────────────────────────────────────────────────────────

EOF

exec npm run watch
