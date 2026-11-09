#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf coverage/unit coverage/browser coverage/native coverage/combined
mkdir -p coverage
node --input-type=module -e "import { sourceFingerprint } from './scripts/coverage-scope.mjs'; import { writeFileSync } from 'node:fs'; writeFileSync('coverage/source-manifest.json', JSON.stringify(sourceFingerprint()));"
export SLATE_SOURCE_COVERAGE=1
npm test
touch coverage/unit/.passed
npm run test:webview
touch coverage/browser/.passed
npm run test:electron
touch coverage/native/.passed
node scripts/coverage-report.mjs "$@"
