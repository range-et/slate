# Layered verification

`npm run verify:launch` is the required gate. Its baseline now runs static checks,
all Vitest tests (including properties and snapshots), and mutation testing before
builds and Python round trips. Browser, native host, and workbench QA follow.
CI uses the same baseline; no live model is required.

| Python proposal | TypeScript/JavaScript implementation | Current scope |
| --- | --- | --- |
| Pyright / Ruff | strict `tsc` + ESLint AST correctness rules | Active webview and extension; not a ban on existing `any`, and not full typed ESLint |
| Pydantic / contracts | Existing `parseNode`, `parseConfig`, `parseFlow` validators and typed errors | File boundaries; generated invalid node fields supplement existing schema matrices. No redundant schema library or new production validation semantics |
| Hypothesis | fast-check + Vitest | 500 cases per property, fixed seed; node round trips, malformed lists, newline normalization, palette conservation/immutability and score bounds |
| Mutmut | Stryker with Vitest | Palette ranking only, minimum 80%; other modules remain a coverage gap |
| Syrupy / VCR | Vitest persisted-format snapshot + existing deterministic local HTTP server | Node JSON byte format; existing transport request/stream/error/cancel tests and Python execution differential tests |

Run `npm run verify:static`, `npm run test:properties`, or
`npm run test:mutation` independently while developing. Stryker writes HTML and
JSON reports to `reports/mutation/`; reports and sandbox copies are ignored.
The mutation gate runs the complete scoped module, not a git-diff heuristic or a
cached score. Expand `mutate` deliberately with tests; never lower the threshold
or exclude survivors just to make it pass. An 80% score is not 80% correctness.

fast-check prints the seed and shrunk counterexample path on failure. Replay by
passing that `seed` and `path` to the failing assertion's options. The fixed seed
makes CI reproducible; additional exploratory seeds are useful during development.
Properties are bounded samples, not exhaustive proofs.

Snapshots are checked in and never updated by the gate. To intentionally change
serialization, run `npm run test:properties -- --update`, inspect the snapshot
diff, and retain independent round-trip assertions. Cancellation, dirty buffers,
undo/save, and UI actions remain covered by their existing suites, not by these
pure-function properties. Runtime contracts for all host messages, full mutation
coverage, coverage-guided fuzzing, and a complete unsafe-`any` ban remain gaps.

Passing the pipeline supplies evidence for declared behavior. It does not prove
all behavior correct or replace review of contracts, expectations, and changes.

Tool references: [fast-check configuration](https://fast-check.dev/docs/configuration/),
[Stryker Vitest runner](https://stryker-mutator.io/docs/stryker-js/vitest-runner/),
and [Stryker thresholds](https://stryker-mutator.io/docs/stryker-js/configuration/).

## Palette survivor audit

`harness_palette.test.ts` now compares entries whose label, keywords and detail
have different strengths against a competitor with an intermediate score. Each
field is strongest in one case, both input orders are exercised, and an unmatched
query still returns no results. This detects replacing `Math.max` with `Math.min`; the verified mutation run
killed 85 of 90 mutants (94.44%), with no timeouts or uncovered mutants.

Five remaining mutations are equivalent for valid `Rankable` inputs and ordinary
string values; they remain in Stryker's denominator and are not excluded:

| Mutation | Why observable behavior is unchanged |
| --- | --- |
| First `index > 0` becomes `true` | A prefix already returned. For no substring, index is -1 and `haystack[-2]` is undefined; the word-break regex does not match its string coercion `undefined`. |
| First `index > 0` becomes `index >= 0` | The only added case, index 0, already returned through `startsWith`. |
| Second `index > 0` becomes `index >= 0` | Again, index 0 cannot reach this branch. |
| Candidate `value >= 0` becomes `value > 0` | A score is null or strictly positive (empty query 1, prefix 98–100, boundary 80, substring 60, subsequence at least 20). Positive weights preserve positivity; unmatched metadata uses a negative sentinel. Zero never reaches this filter. |
| Group `'selection'` becomes `''` | For valid groups, selection's index changes from 0 to -1; it still precedes canvas (1), node (2), and search (3). The comparator's magnitude changes but its sign and ties do not. |

This is an equivalence argument scoped to the current implementation and typed
inputs, not a permanent exemption. Reassess it if scores, groups or early returns
change. Invalid group values are outside the `Rankable` contract; injecting one
solely to kill an equivalent mutant would not protect a supported behavior.

## Full active-source target (in progress)

The requested target is 100% lines, statements, functions and branches, plus
mutation detection across `src/harness/` and `vscode-extension/src/`. Test code,
type declarations and the frozen legacy app are not product-source coverage;
legacy tests/builds remain mandatory. This target has **not** been achieved.

`npm run test:coverage` instruments original TypeScript with the same Istanbul
instrumenter in Vitest, the Playwright webview, and the real Extension Host. It
collects all three suites, seeds every product file with zero counts, verifies
source fingerprints/counter maps, and writes `coverage/combined/index.html` plus
JSON reports. `npm run verify:coverage` additionally rejects anything below 100%
for all four metrics. Failed suites stop collection; do not treat partial reports
from failed/manual runs as passing evidence. A subsequent regular build removes
coverage instrumentation from the deliverable.

`npm run test:mutation:full-unit` mutates all 19 active TS/TSX source files using
Vitest and a strict 100% threshold. It is an additional diagnostic/gate, not a
replacement for real host/browser QA. The initial inventory has 8,529 mutants.
UI/native-host mutants without unit execution remain visible as uncovered, and
equivalent survivors remain counted. Extending mutation execution to the real
host and browser is still outstanding. `--dryRunOnly` validates setup but does
not measure mutation detection. The original scoped palette gate remains in
`verify:launch` until the full-source target can actually pass.

The completed three-runner measurement on 2026-11-09, before the subsequent
panel-disposal fix, measured 93.44% lines (2394/2562), 91.20% statements
(3038/3331), 91.85% functions (756/823), and 86.63% branches (2262/2611).
All runner suites passed; the strict 100% coverage gate correctly failed.
These are baseline measurements, not a claim that the requested target passes.

The new native regression found a real lifecycle bug: queued refreshes posted
replies after the panel closed. `HarnessPanel` now skips refresh work after
disposal and suppresses late replies. The regression failed before the fix and
passed afterward in the real Extension Host, alongside native Undo/Save checks.

After the disposal fix and additional graph/palette interaction tests,
`npm run verify:launch` passed: 397 unit tests, 84 browser tests, 24 real
Extension Host tests, workbench Generate/Accept/Undo/Save and native creation
prompts, plus frozen legacy and Python round-trip checks. A concurrent Playwright
run initially collided with the shared artifact directory; the successful gate
ran browser suites without a competing Playwright process.

On this busy machine, one scoped mutation run reported 96.67% with three
timeouts, including two equivalent mutants. That is not stronger detection
proof. `npm run test:mutation -- --timeoutMS 60000` then confirmed 85 killed,
five equivalent survivors and zero timeouts (94.44%). Keep timeout counts
visible when interpreting mutation scores.

Current combined measurement after these changes: 93.45% lines (2398/2566),
91.27% statements (3046/3337), 91.98% functions (757/823), and 86.92% branches
(2273/2615). All 397 unit, 84 browser and 24 native tests passed. The first native
coverage run hung after its test host exited; its test editor was stopped and
native collection rerun successfully before aggregation. The strict report
still rejects all four metrics below 100%. Normal builds were restored after
collection so deliverables do not retain coverage instrumentation.

Native project-command coverage adds six tests for create/reopen/cancel,
name validation, missing-project compile, port cancellation/empty sources/occupied
destinations, and a real filesystem obstruction. `npm run verify:launch` passed
with 397 unit, 84 browser and 30 native tests plus workbench QA. The scoped
mutation run in this gate had 85 kills, five survivors and zero timeouts.

Recollecting native coverage against unchanged product sources and the already
successful unit/browser data yields 94.34% lines (2421/2566), 92.02% statements
(3071/3337), 92.34% functions (760/823), and 87.45% branches (2287/2615).
The strict coverage check still fails; the full 100% objective remains open.

The initial full-unit mutation baseline completed: 3,067 killed, 29 timeouts,
814 survived, 4,619 uncovered out of 8,529 (Stryker raw score 36.30%). It used the
source/test snapshot taken before the disposal fix and later coverage additions;
it is diagnostic baseline evidence, not a current-source certification. Timeouts
are not confirmed assertion kills. The large uncovered count motivates real
browser/host mutation execution.

`npm run test:mutation:system` adds that execution route, with a default scope of
all active source and a 100% threshold. It uses one sandbox worker, copies source
and fixtures, links installed dependencies/editor cache, disables Vite server
reuse, and runs `test:harness` (unit, browser, native, workbench). The HTML bridge
passes Stryker's active mutant to browsers before module initialization; normal
pages contain no bridge script. Host code reads Stryker's inherited environment.
Do not run competing browser/native suites alongside this command. Range-limited
smoke checks validate the runner, not full-source mutation detection. Inspect
failure reasons: infrastructure failures and timeouts are not evidence of an
assertion detecting a defect.

A targeted schema mutation audit on `slate_folder.ts` lines 89 and 122–138 and
`flow.ts` lines 35 and 49–53 killed all 123 mutants with zero timeouts, survivors,
or uncovered mutants. Matching location/operator/replacement against the earlier
full-unit report gives 92 previously killed, 27 previously surviving, and four
previously uncovered mutants. New boundary tests reject non-string names/IDs,
filter malformed layout fields independently, and verify format-error messages.
This is 100% of those selected ranges, not 100% of either whole file or app.

The unmutated system baseline exposed a layout race: background refresh could
reload layout concurrently with queued edits. Background refresh now joins the
mutation queue. A native regression pauses an edit at its prompt and verifies
indexing starts only after release; it fails when the previous scheduler is
restored and passes with the fix. Another real-host test obstructs a layout write
with a directory, restores the file, then verifies background refresh and a later
edit recover. Observation is scoped to this project after the edit starts.

Workbench cleanup now has a bounded graceful-close period followed, if necessary,
by explicit termination of only its owned QA child. This happens after assertions
and does not convert assertion failures into passes. Failure to terminate remains
an error. The behavior has 11 focused automated tests.

The system runner's two diagnostic mutations were detected by their intended
suites: changing the Map button's `setView('map')` argument failed browser Map
state/layout assertions, and changing the disposal flag to false failed the native
queued-refresh regression with “Webview is disposed.” Stryker reported two killed
mutants and no timeouts. The native assertion failed before cleanup; its lingering
test editor then required explicit process termination to let the command finish.
This proves those assertions detect the defects, but it is not a full-source score
or proof of unattended native-runner shutdown reliability. Workbench's new bounded
cleanup was added afterward; native-runner shutdown remains an operational gap.

Latest complete launch gate (2026-11-09, `/tmp/slate-system-final-launch.log`):
`npm run verify:launch` exited 0 with 450 unit tests, 84 browser tests, 32 real
Extension Host tests, and successful real workbench generation/accept/undo/save,
native validation/cancel and node/flow persistence. This verifies the refresh
queue fix and bounded workbench shutdown helper. A fresh strict coverage run is
being collected separately; the full 100% goal remains open. Five additional
adapter contract cases were subsequently added (14/14 adapter tests pass), so
those additions still require the final launch gate.

Fresh combined source coverage (2026-11-09, `/tmp/slate-current-coverage.log`):
unit, all 84 browser cases and all 32 native cases passed; the native runner
exited normally. The added adapter file was also rerun with source instrumentation
(14/14 pass) before aggregation. Strict `npm run verify:coverage` exited 1 because
the honest totals are 94.42% lines (2423/2566), 92.15% statements (3077/3339),
92.48% functions (763/825), and 87.80% branches (2296/2615). No exclusions or
threshold changes were made. Python adapter line/function coverage is now 100%,
but its statement/branch coverage is 98.49%/92.09%. Most remaining uncovered lines
are native panel (76), folder IO (27), extension entry/launcher (19), canvas (15),
and port/compile host (6). Coverage is not a proof of full mutation detection.

Final gate after the five adapter cases (2026-11-09,
`/tmp/slate-adapter-final-launch.log`): `npm run verify:launch` exited 0;
455 unit tests, 84 browser tests, 32 Extension Host tests, and real workbench QA
passed. Both native editor runs in this pass exited normally. Normal builds
were restored by the gate after the instrumented coverage collection.

Adapter mutation follow-up (2026-11-09, `/tmp/slate-adapter-mutation.log`):
`npx stryker run /tmp/slate-adapter-mutation.json` tested original-source ranges
65–100 and 332–390 of `python_adapter.ts` using the full-unit configuration,
60-second per-mutant timeout and unchanged 100% threshold. Result: 222 total,
177 Killed, 42 Survived, 3 NoCoverage, zero Timeout (79.73%); exit 1 is expected
because the strict goal is not achieved. Matching source location, mutator and
replacement against the earlier full-unit report identifies 19 additional real
kills. This result includes the multiline and five additional contract cases;
it is a selected-range audit, not a whole-file or whole-app score.

Next adapter cases to investigate from the survivors: multiline parameter lists
with internal blank/whitespace-only lines, closing-parenthesis indentation wider
than the parameter indent, and preserved padding in a one-line parameter list.
Do not classify all 42 survivors as equivalent: several normalization mutations
still need these distinguishing cases. Parser-guaranteed and locked-annotation
branches also need an explicit reachability audit; no coverage suppression has
been added.

## PR #1 review fixes

- Undo/save race: `writeNode()` now returns the document version captured after
  WorkspaceEdit applies and before Save is awaited. Acceptance uses that version.
  The real Extension Host regression holds Save, applies later user text, resumes
  Save and requests Undo; it failed on the old implementation and passes with the
  fix, preserving buffer text/version and disk. Normal Undo, rejected apply and
  failed-save cases remain in the same suite (33 native tests passed focused run).
- Inspector drafts: hide the selected inspector without unmounting it; key it by
  selection so switching nodes still resets details. Browser regressions cover
  code, intent, contract, note title/body/attachment, no implicit writes and
  explicit Save. The code/metadata case failed against the old implementation;
  both cases pass after the fix. Inspected the retained-draft screenshot.
- Windows coverage loader: normalize separators for both source inclusion and
  test exclusion, retaining the original filename for reading/instrumentation.
  Eight build-loader tests cover POSIX/Windows paths, exclusions, ordinary builds
  and read errors. The Windows source case failed before the fix; all eight now
  pass. This verifies Windows-shaped loader inputs, not a Windows OS host run.
- Existing CI failure: the Linux workbench log showed status text intercepting
  Compose after Undo opened a split editor. Header children no longer shrink into
  each other; horizontal overflow remains scrollable. A real 320px browser click
  regression failed before the fix, then 320px and 480px Map/Compose/Library chains
  passed. Inspected the narrow-pane screenshot. No forced clicks or QA assertion
  weakening were used.

Earlier combined coverage percentages describe the pre-review source revision;
a fresh collection is required before attributing those totals to these fixes.

Final review-fix launch gate: `npm run verify:launch` exited 0 on 2026-11-09
(`/tmp/slate-pr1-final-launch.log`): 463 unit tests, 88 browser cases, 33 real
Extension Host tests and real workbench Generate/Accept/Undo/Save plus native
creation/cancellation QA. Static checks, palette mutation gate, frozen legacy
checks/builds and Python round trips passed. `git diff --check` passed.

## Issue #20 cross-platform coverage and mutation expansion (2026-11-11)

Refreshed full-scope three-runner combined coverage (`unit` + `browser` +
`native` via `scripts/coverage-report.mjs`) and Stryker mutation evidence across
`src/harness` and `vscode-extension/src`, fixed cross-platform coverage/mutation
instrumentation bugs, and expanded unit, Playwright browser, and real VS Code
Extension Host regression suites.

### Cross-platform coverage & mutation tooling fixes

- `scripts/coverage-scope.mjs`: `sourcePath` now falls back to
  `decodeURIComponent(new URL(name).pathname)` when `fileURLToPath` rejects
  POSIX `file:///repo/...` URLs on Windows, normalizes path separators, and
  trims trailing slashes on `root`.
- `scripts/source-instrumentation.cjs`: `instrumentSource` resolves POSIX paths
  via `path.posix.resolve(filename)` when `filename.startsWith('/')` so NYC's
  path-key lookup matches the instrumented source key across platforms.
- `scripts/prepare-system-mutation.mjs` and `stryker.full-unit.config.json`:
  uses `'junction'` on Windows and `'dir'` on POSIX when linking tool
  directories into the Stryker sandbox, and runs
  `node scripts/prepare-system-mutation.mjs` as `buildCommand` in
  `stryker.full-unit.config.json` so `vscode-extension/node_modules`
  (`@lezer/python@1.1.19`) is linked inside full-unit mutation sandboxes.
- `src/harness/main.tsx` and `package.json`: registered the `openPalette`
  window `keydown` listener in the capture phase (`true`) with
  `event.stopPropagation()` on `Cmd/Ctrl+K` and `/` so VS Code's outer webview
  host does not enter a `Ctrl+K` chord on Windows/Linux, and added `sync-dist`
  before `test:workbench`.

### Refreshed three-runner combined coverage (`coverage/combined/coverage-summary.json`)

| Metric | Before (2026-11-09) | After (2026-11-11) | Delta |
| --- | --- | --- | --- |
| Lines | 94.42% (`2423 / 2566`) | **99.92% (`2566 / 2568`)** | **+5.50%** (`+143` lines; only `2` unreachable/packaging-only lines remain) |
| Statements | 92.15% (`3077 / 3339`) | **98.71% (`3298 / 3341`)** | **+6.56%** (`+221` statements) |
| Functions | 92.48% (`763 / 825`) | **98.42% (`812 / 825`)** | **+5.94%** (`+49` functions) |
| Branches | 87.80% (`2296 / 2615`) | **94.53% (`2473 / 2616`)** | **+6.73%** (`+177` branches) |

Per-file combined coverage across the 17 executable product files (`types.ts` and
`harness_protocol.ts` are type-only):

| File | Statements | Branches | Functions | Lines | Uncovered lines |
| --- | --- | --- | --- | --- | --- |
| `src/harness/demo.ts` | 99.38% (160/161) | 96.47% (82/85) | 100% (45/45) | 100% (121/121) | none |
| `src/harness/graph.ts` | 98.78% (243/246) | 92.17% (212/230) | 100% (53/53) | 100% (192/192) | none |
| `src/harness/main.tsx` | 97.69% (635/650) | 92.90% (537/578) | 100% (204/204) | 100% (481/481) | none |
| `src/harness/palette.ts` | 100% (52/52) | 100% (45/45) | 100% (18/18) | 100% (31/31) | none |
| `vscode-extension/src/extension.ts` | 100% (86/86) | 100% (40/40) | 100% (18/18) | 100% (76/76) | none |
| `vscode-extension/src/flow.ts` | 100% (263/263) | 100% (261/261) | 100% (53/53) | 100% (201/201) | none |
| `vscode-extension/src/generation.ts` | 100% (152/152) | 100% (129/129) | 100% (28/28) | 100% (126/126) | none |
| `vscode-extension/src/harness_panel.ts` | 97.65% (415/425) | 90.08% (327/363) | 89.26% (108/121) | 99.45% (363/365) | `39, 499` |
| `vscode-extension/src/llama_transport.ts` | 99.13% (114/115) | 88.04% (81/92) | 100% (18/18) | 100% (95/95) | none |
| `vscode-extension/src/port_compile_host.ts` | 97.83% (135/138) | 91.67% (99/108) | 100% (32/32) | 100% (109/109) | none |
| `vscode-extension/src/python_adapter.ts` | 98.58% (277/281) | 92.59% (200/216) | 100% (63/63) | 100% (223/223) | none |
| `vscode-extension/src/search.ts` | 100% (44/44) | 100% (32/32) | 100% (11/11) | 100% (36/36) | none |
| `vscode-extension/src/slate_folder.ts` | 100% (214/214) | 100% (169/169) | 100% (44/44) | 100% (163/163) | none |
| `vscode-extension/src/slate_folder_host.ts` | 97.67% (126/129) | 82.98% (39/47) | 100% (34/34) | 100% (104/104) | none |
| `vscode-extension/src/compile/python.ts` | 98.48% (130/132) | 96.49% (110/114) | 100% (26/26) | 100% (97/97) | none |
| `vscode-extension/src/port/describe.ts` | 100% (95/95) | 100% (53/53) | 100% (28/28) | 100% (70/70) | none |
| `vscode-extension/src/port/python_importer.ts` | 99.37% (157/158) | 96.61% (57/59) | 100% (29/29) | 100% (78/78) | none |

Audit of the 2 remaining uncovered lines in `vscode-extension/src/harness_panel.ts`:
- Line `39`: fallback HTML returned only when `dist/webview/harness.js` is absent
  from the packaged extension directory (`!fs.existsSync(scriptPath)`). In a
  valid build/test environment `sync-dist` always populates `dist/webview/harness.js`.
- Line `499`: `return this.folder.libraryNodes().some(node => node.id === target);`
  inside `targetExists(target)` when `createNode` checks for a conflicting
  existing definition node id (`if (this.targetExists(nodeId))`). Because
  `createNode` validates `nodeId` via `parseNodeId` (which rejects `lib:`
  prefixes) and `libraryNodes()` always have `id: "lib:..."`, `targetExists` is
  only reached with non-`lib:` ids where `this.folder.hasNode(target)` handles
  every project node.

### Refreshed mutation audit (`python_adapter.ts` & `palette.ts`)

- Scoped palette mutation gate (`npx stryker run stryker.config.json`):
  **94.44% (`85 / 90` killed, `5` audited equivalent mutants, `0` timeouts, `0` errors)**.
- Targeted `vscode-extension/src/python_adapter.ts:65-81,332-390` mutation audit
  (`npx stryker run stryker.full-unit.config.json --mutate "vscode-extension/src/python_adapter.ts:65-81,vscode-extension/src/python_adapter.ts:332-390"`):
  improved from **68.24% (`101 / 148` killed, `45` survived, `2` no-coverage)**
  to **86.52% (`122 / 141` killed, `17` survived, `2` no-coverage)** before adding
  the final 4 cases (`\r`-only multiline params, 3-line trailing-indent params,
  nested-function replacement rejection, and non-string `nodeId` replacement),
  which kill 4 more of the 17 survivors (`line 70:66`, `line 74:38`,
  `line 371:24`, and `line 379:33`), leaving only audited equivalent,
  parser-guaranteed, or unindexed-annotation mutants:
  - `declarationIndent` (`lines 65–66`): `from - 1` vs `from + 1` (equivalent
    because `target.from` is the start of `def`/`@decorator`, never `\n`), and
    `.match(/^[ \t]*/)?.[0] ?? ''` optional-chaining/regex/fallback mutants
    (equivalent because `/^[ \t]*/` matches every string at index 0).
  - `normalizeParameters` (`lines 74–76`): `lines.at(-1)?.trim()` optional
    chaining (equivalent after `if (lines.length === 1) return` since `lines`
    always has `>= 1` element) and `line.match(/^[ \t]*/)?.[0]` optional
    chaining / `^` anchor on filtered non-empty lines (equivalent where leading
    whitespace is the only whitespace before parameter identifiers).
  - `replaceUnit` (`lines 375–383`): `unit.annotation?.locked === true` (not
    reachable through `parseDetailed`, which always sets `annotation: null`),
    `'<replacement>'` path label in `parseDetailed` (internal parse diagnostic
    path is not returned when `replaceUnit` throws its fixed `AdapterError`),
    `!candidate.valid && candidate.units.length !== 1` / `parentId !== null`
    (equivalent because `topLevelStatements[0].name !== 'FunctionDefinition'`
    and syntax checks already reject invalid or non-root units), and
    `candidate.units[0].name !== unit.name` / `decorators.length > 0`
    (equivalent because `unit.signature` includes `unit.name` and Lezer wraps
    decorated functions in `DecoratedStatement`, caught at line 380).

### Final launch gate verification

`npm run verify:launch` in `c:\Users\range\Desktop\slate-wt-issue-20`:
- `477` unit tests across `24` Vitest files (`0` failures)
- `94.44%` Stryker palette mutation gate (`>= 85%` threshold)
- `89` Playwright browser tests (`0` failures)
- `41` real VS Code Extension Host integration tests (`0` failures)
- Real VS Code workbench Generate / Accept / Undo / Save + native creation/cancellation QA (`0` failures)
- Frozen legacy tests (`62` passed) and Python/port/compile/flow round trips (`0` failures)
