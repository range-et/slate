# Slate unit and behavior test matrix

Run all unit tests with `npm test`; the full launch gate is `npm run verify:launch`.
Matrix cases use named `it.each` rows so each failing input is reported separately.
This inventory describes behavioral coverage, not a claim of 100% line/branch
coverage. Existing focused tests remain in the gate alongside these matrices.

| Public functions / surface | Matrix cases | Test files (under `test/`) |
| --- | --- | --- |
| `parseConfig` | Version, object/name/language validation, compile/library configuration | `slate_format.matrix.test.ts`, `slate_folder.test.ts` |
| `parseNode`, `serializeNode`, `SlateFormatError` | Schema fields, mixed/scalar lists, invalid JSON, defaults, metadata/unknown-field round trips | Both format suites |
| `emptyLayout`, `parseLayout`, `serializeLayout` | Empty inputs, independent defaults, malformed entries, all layout sections, omission of empty sections | `slate_format.matrix.test.ts` |
| `codeLines`, `codeText`, `nodeIdForPath`, `pathForNodeId` | LF/CRLF/CR, trailing blanks, preserved indentation, nested/Windows paths, wrong prefix/extension | `slate_format.matrix.test.ts` |
| `indexNode`, `checkNodeCode`, `nodeFromSignature` | Function/class/async/decorated code, module state, wrong name, multiple definitions, imports/assignments, malformed signatures | Both format suites |
| `parseFlow`, `serializeFlow`, `emptyFlow`, `FlowFormatError` | Schema, duplicate/invalid instance IDs, typed ports, wire shape, literal normalization, unknown fields | `flow.matrix.test.ts`, `flow.test.ts` |
| `flowIdForPath`, `pathForFlowId`, `parseEndpoint`, `uniqueName` | Path separators, root/instance/named ports, sanitization and collisions | `flow.matrix.test.ts` |
| `unitSignature`, `flowSignature`, `inputPorts`, `outputPorts` | Positional/keyword/variadic/default arguments, class constructors, zero/one/multiple outputs | Both flow suites |
| `connect`, `disconnect`, `removeInstances`, `extractFlow` | Input replacement, exact endpoint removal, absent/all selections, unrelated wires, immutability, boundaries/shared fan-out | Both flow suites |
| `parseModule`, `PythonAdapter.parseModule` | Syntax errors, decorated/async/nested definitions, durable identity, UTF-16 ranges | `python_adapter.test.ts`, `python_pipeline.matrix.test.ts` |
| `splitImport`, `identifierNames`, `topLevelBindings` | Plain/dotted/aliased/relative/star imports, comments/strings, chained/annotated assignments, conditional definitions, local scope exclusion | `python_pipeline.matrix.test.ts` |
| `PythonAdapter.replaceUnit`, `AdapterError` | Input types, stale hashes, missing IDs, changed names/signatures/decorators, invalid replacements, extra statements, method indentation/surrounding source | Both Python suites |
| `PythonAdapter.dispose` | Called after replacement; currently a no-op | `python_pipeline.matrix.test.ts` |
| `portPythonProject`, `formatPortReport` | Empty/import-only/state/class/reserved/invalid modules, packages, relative/absolute dependencies, reports, duplicates/globals/aliases, conditional definitions, prelude/epilogue splitting | `python_pipeline.matrix.test.ts`, `port_compile.test.ts` |
| `projectModuleName`, `libraryImport`, `nodeSignature`, `flowToNode`, `compilePython` | Naming, libraries, invalid/absent signatures, empty projects/flows, unsupported languages, port-to-compile; codegen, imports/cycles, fan-out/defaults/multiple outputs | `python_pipeline.matrix.test.ts`, `flow.test.ts`, `port_compile.test.ts` |
| `buildGenerationPacket`, `PacketError` | Lock/intent/type/identity restrictions, missing/ambiguous targets and source/context, exact/oversized/impossible budgets | `generation.matrix.test.ts`, `generation.test.ts`, `slate_folder.test.ts` |
| `stripModelEnvelope` | Bare/Python fences, whitespace, unsupported fences and surrounding prose | `generation.matrix.test.ts` |
| `describeOrder`, `buildDescribePacket`, `parseDescribeReply` | Empty/missing/self/cyclic/diamond dependencies, module state, classes, reply schema/duplicates/length limits, context truncation | `generation.matrix.test.ts`, `describe.test.ts` |
| `describeNodes` | Already described/cancelled/oversized work, failed persistence, retry/resume, timeout, dependency order/incremental context | Both describe/generation suites |
| `streamLlamaCompletion`, `LlamaTransportError` | Endpoint/request contract, byte-split UTF-8/SSE, CRLF, metadata/nonstring data, HTTP/empty/malformed/truncated responses; real local HTTP, unreachable server, timeout/cancellation | `llama_transport.matrix.test.ts`, `llama_transport.test.ts` |
| `searchUnits` | Every score tier, case/whitespace, empty/no hits, limits, missing source, provenance | `harness.matrix.test.ts`, `harness_search.test.ts` |
| `scoreMatch`, `rankPalette` | Prefix/boundary/substring/subsequence, separators, no match, ties, immutability, always-on rows | `harness.matrix.test.ts`, `harness_palette.test.ts` |
| `typeColor`, `nodeIdOf`, `callables`, `buildGraph` | Empty/map/compose/missing flow scopes, type normalization, flow filtering, immutability, unique IDs; classes, context/data wires, stale/invalid state, refs/placeholders, positions/flow ports | `harness.matrix.test.ts`, `harness_graph.test.ts` |
| Fake model server | Request recording/deterministic streaming | `fake_llama_server.test.ts` |

## Host and UI boundaries

`extension.activate/deactivate`, `HarnessPanel`, `SlateFolderHost`,
`portPythonFolder`, `compileSlateFolder`, and `slateOutput` depend on VS Code.
Their behavior is exercised through commands, dirty-buffer edits, proposals,
undo and port/compile in `vscode-extension/src/test/suite/extension.test.ts`, plus
the workbench smoke test. React callbacks and host message interactions are
tracked in [UX_QA_MATRIX.md](UX_QA_MATRIX.md). These are integration/QA tests,
not unit coverage of every internal host method.

`vscode-extension/src/test/suite/persistence.test.ts` additionally exercises real
proposal acceptance, disk persistence, native undo followed by Save, stale target
and context (saved/dirty), missing/locked targets, unknown/reused proposal IDs,
intervening human edits, refused edits/saves, library indexing after reopen,
root/flow values and layout scopes, and cancelled/confirmed native prompt paths.
`test-workbench.js` now also verifies actual Generate/Accept/Undo/Save clicks and
native creation dialogs against saved files in an isolated project copy.

The frozen legacy notebook has its own suite (`npm run legacy:test`) and Python
round-trip execution checks inside `verify:baseline`. Python output is also
executed against example behavior in that gate; parser acceptance alone does not
prove generated programs behave correctly.

When adding a function or changing behavior, update its row and tests, including
affected interaction chains. Constants and TypeScript-only interfaces are covered
by their consumers; no meaningless existence assertions are required.

## Layered verification additions

| Surface | Automated evidence | Remaining gaps |
| --- | --- | --- |
| Node runtime contracts and persistence format | `invariants.property.test.ts`: valid metadata/code round trips, extension metadata, mixed/scalar list rejection; reviewed serialized JSON snapshot | Not all boundary fields generated; existing schema matrices remain required |
| `codeLines`, `codeText` | Generated text normalization idempotence, no embedded CR/LF, no trailing blank lines | Bounded random strings |
| `rankPalette`, `scoreMatch` | Generated conservation, identity, immutability, always-last, stable reranking, score bounds; Stryker mutates palette with 80% minimum | No mutation gate yet on other modules |
| Static correctness gates | `verification.test.ts` probes lint rejection/acceptance; strict webview + extension `tsc` | Existing `any` and unchecked casts not prohibited |

See [VERIFICATION.md](VERIFICATION.md) for commands, seed replay and exact scope.

Palette survivor follow-up: `harness_palette.test.ts` covers competing entries
with multiple matching fields, independently making label/keywords/detail the
strongest match, reversed input order, and no-match queries. Stryker verifies
that selecting the weakest field is rejected. Five equivalent mutations remain
counted; the branch/score/group-order reasoning is in `VERIFICATION.md`.

## Full-source coverage work

| Surface | Added evidence | Remaining gaps |
| --- | --- | --- |
| `instrumentSource`, `sourcePath`, `isActiveSource`, `activeSources`, `sourceFingerprint`, `requireCompleteCoverage`, `mergeRunnerCoverage`, `generateCoverage` | `coverage_tools.test.ts`: TS/JSX instrumentation, invalid syntax, source inventory, missing/stale/malformed input, complementary branches, unexecuted-file denominator and strict 100% rejection | Full report depends on all three runner suites passing |
| `parseFlow`, `serializeFlow` | `flow.matrix.test.ts`: omitted/null/typed port annotations, wire preservation and unexpected wire fields | See generated branch report |
| `compilePython` | `flow.test.ts`: duplicate drivers rejected; unaffected node module still emitted | See generated branch/mutation reports |
| `portPythonProject` | `port_compile.test.ts`: star and unresolved imports retained with explicit warnings | See generated branch/mutation reports |
| `buildGraph` | `harness_graph.test.ts`: explicit context-edge deduplication, attached note, missing endpoint omission | See generated branch report |
| `searchUnits` | `harness_search.test.ts`: score ties resolved by name/path/ID, limit after sorting, fallback snippets, immutability | See generated branch report |
| `buildDescribePacket` | `generation.matrix.test.ts`: dependencies with renamed/missing definitions and async signature fallback | See generated branch report |
| `withTestProfile` | `native_profile.test.ts`: unique temporary VS Code profiles, deterministic startup settings, cleanup on success/failure and concurrent isolation | OS desktop must remain unlocked for native input |
| `HarnessPanel.refreshNow`, `postMessage`, `dispose` | Real Host `persistence.test.ts`: pause filesystem refresh, queue a second refresh, close panel, release both; commands settle, no disk mutation, no surviving snapshot. Regression failed before disposal guard | Other asynchronous operations still require their existing cancellation tests |
| `buildGraph` malformed flows | `harness_graph.test.ts`: unreadable flow remains visible, missing value defaults empty, dangling source/target wires omitted, unreadable child canvas empty | Defensive fallbacks and remaining branches remain visible in the report |
| `createNewSlateProject`, `portProject`, `compileProject` command handlers | Real Host `project.test.ts`: project-name validation/cancel, persisted empty project and reopen without overwrite, missing-project compile, port chooser cancel, empty source/occupied destination, filesystem failure | No-workspace activation and launcher gestures remain uncovered here |
| `mutationBridgePlugin` | `mutation_bridge.test.ts`: real Stryker instrumentation executes original vs selected arithmetic mutation without Node globals, preserves namespace, rejects malformed IDs, normal/dry-run pages unchanged | Full browser/native mutation score still pending |
| `prepareSystemSandbox` | `mutation_bridge.test.ts`: tool/cache links, idempotent setup, reject original repository, missing tools, conflicting directories retained | System runner additionally requires a successful real dry run |
| `parseConfig`, `parseLayout`, `parseNode`, `parseFlow` schema guards | `slate_format.matrix.test.ts`, `flow.matrix.test.ts`: non-string names/IDs (including coercible arrays), field-by-field invalid notes/refs/placeholders, attachment/signature boundaries, specific format-error diagnostics | Targeted mutation audit remains strict; equivalent guards are not excluded |
| `HarnessPanel.scheduleRefresh` serialization | Real Host `persistence.test.ts`: pause a canvas edit at a native prompt, request background refresh, assert indexing waits; real filesystem write failure followed by background refresh and successful retry | Queue-order regression fails on old build and passes on fixed build; final 455-unit/84-browser/32-host launch gate passed |
| `parseModule` multiline signature normalization | `python_adapter.test.ts`: first parameter on opening line, common/unequal indentation, tab indentation, empty multiline list, CRLF, and closing-parenthesis placement; exact signatures and structured names | Remaining mutation survivors still require audit |
| `closeTestApplication` QA cleanup | `native_shutdown.test.ts`: normal/already-finished exit, bounded graceful shutdown, owned-child termination, no-exit and thrown/emitted failures, timer/listener cleanup, invalid grace | Only QA process cleanup; application assertions still run unchanged |
| `parseModule`, `PythonAdapter.replaceUnit` contract details | `python_adapter.test.ts`: exact positional/default/variadic parameter records; class, nested-function and duplicate-ID rejection; padded replacement normalization, exact edit range, before/after hashes and reparsed result | Targeted mutation audit includes these paths; equivalent and defensive survivors remain counted |
