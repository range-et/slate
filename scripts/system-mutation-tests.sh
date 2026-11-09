#!/usr/bin/env bash
set -euo pipefail
node scripts/prepare-system-mutation.mjs
# Preserve live diagnostics without changing the failing test command's status.
npm run test:harness 2>&1 | tee system-test.log
