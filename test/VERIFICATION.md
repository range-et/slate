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
