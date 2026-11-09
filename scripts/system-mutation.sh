#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export SLATE_MUTATION_ROOT="$PWD"
export CI=1
unset SLATE_SOURCE_COVERAGE
exec node node_modules/@stryker-mutator/core/bin/stryker.js run stryker.system.config.json "$@"
