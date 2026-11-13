# Slate unit and behavior test matrix

Run all unit tests with `npm test`; the full launch gate is `npm run verify:launch`.
Matrix cases use named `it.each` rows so each failing input is reported separately.
This inventory describes behavioral coverage, not a claim of 100% line/branch
coverage. Existing focused tests remain in the gate alongside these matrices.

| Public functions / surface | Matrix cases | Test files (under `test/`) |
| --- | --- | --- |
| `parseConfig` | Version, object/name/language validation, compile/library configuration | `slate_format.matrix.test.ts`, `slate_folder.test.ts` |
| `parseNode`, `serializeNode`, `SlateFormatError` | Schema fields, mixed/scalar lists, invalid JSON, defaults, metadata/unknown-field round trips | Both format suites |
| `emptyLayout`, `parseLayout`, `serializeLayout` | Empty inputs, independent defaults, malformed entries, all layout sections, placement-only `serializeLayout` (legacy `refs` parsed for migration and omitted on save), omission of empty sections | `slate_format.matrix.test.ts` |
| `codeLines`, `codeText`, `nodeIdForPath`, `pathForNodeId` | LF/CRLF/CR, trailing blanks, preserved indentation, nested/Windows paths, wrong prefix/extension | `slate_format.matrix.test.ts` |
| `indexNode`, `checkNodeCode`, `nodeFromSignature` | Function/class/async/decorated code, module state, wrong name, multiple definitions, imports/assignments, malformed signatures | Both format suites |
| `parseFlow`, `serializeFlow`, `emptyFlow`, `FlowFormatError` | Schema, duplicate/invalid instance IDs, typed ports, wire shape, literal normalization, unknown fields | `flow.matrix.test.ts`, `flow.test.ts` |
| `flowIdForPath`, `pathForFlowId`, `parseEndpoint`, `uniqueName` | Path separators, root/instance/named ports, sanitization and collisions | `flow.matrix.test.ts` |
| `unitSignature`, `flowSignature`, `inputPorts`, `outputPorts` | Positional/keyword/variadic/default arguments, class constructors, zero/one/multiple outputs | Both flow suites |
| `connect`, `disconnect`, `removeInstances`, `extractFlow`, `migrateRootOccurrences` | Input replacement, exact endpoint removal, absent/all selections, unrelated wires, immutability, boundaries/shared fan-out, root occurrence migration (`layout.refs`, pruned wire endpoints, implied root definition instances rewritten without breaking wires, idempotent re-migration across saved positions) | Both flow suites |
| `renameFlowPort`, `deleteFlowPort`, `repairCallerWiresOnPortRename`, `repairCallerWiresOnPortDelete`, `removeNodeReferences` | Input/output port rename and deletion, updating internal wires and caller instance wires across flows, fallback to indexed ports, removing node occurrences and unmeshing wires across multiple flows | Both flow suites |
| `parseModule`, `PythonAdapter.parseModule` | Syntax errors, decorated/async/nested definitions, durable identity, UTF-16 ranges | `python_adapter.test.ts`, `python_pipeline.matrix.test.ts` |
| `splitImport`, `identifierNames`, `topLevelBindings` | Plain/dotted/aliased/relative/star imports, comments/strings, chained/annotated assignments, conditional definitions, local scope exclusion | `python_pipeline.matrix.test.ts` |
| `PythonAdapter.replaceUnit`, `AdapterError` | Input types, stale hashes, missing IDs, changed names/signatures/decorators, invalid replacements, extra statements, method indentation/surrounding source | Both Python suites |
| `PythonAdapter.dispose` | Called after replacement; currently a no-op | `python_pipeline.matrix.test.ts` |
| `portPythonProject`, `formatPortReport` | Empty/import-only/state/class/reserved/invalid modules, packages, relative/absolute dependencies, reports, duplicates/globals/aliases, conditional definitions, prelude/epilogue splitting | `python_pipeline.matrix.test.ts`, `port_compile.test.ts` |
| `projectModuleName`, `libraryImport`, `nodeSignature`, `flowToNode`, `compilePython` | Naming, libraries, invalid/absent signatures, empty projects/flows, unsupported languages, port-to-compile; codegen, imports/cycles, fan-out/defaults/multiple outputs | `python_pipeline.matrix.test.ts`, `flow.test.ts`, `port_compile.test.ts` |
| `buildGenerationPacket`, `PacketError` | Lock/intent/type/identity restrictions, missing/ambiguous targets and source/context, exact/oversized/impossible budgets | `generation.matrix.test.ts`, `generation.test.ts`, `slate_folder.test.ts` |
| `buildForgePacket`, `parseForgeCandidate`, `validateForgeCandidate`, `FORGE_INPUT_BUDGET_TOKENS` | Micro-packet budget (<=600 tokens), structured cases & retry feedback formatting, neighbor signature/intent trimming, oversized target refusal, candidate dual section/fence/test boundary parsing, JPL-60 <=60 lines enforcement, parameter name/type and return type signature match checks, invalid Python rejection, proposal input staleness binding | `generation.matrix.test.ts`, `persistence.test.ts` |
| `stripModelEnvelope` | Bare/Python fences, whitespace, unsupported fences and surrounding prose | `generation.matrix.test.ts` |
| `describeOrder`, `buildDescribePacket`, `parseDescribeReply` | Empty/missing/self/cyclic/diamond dependencies, module state, classes, reply schema/duplicates/length limits, context truncation | `generation.matrix.test.ts`, `describe.test.ts` |
| `describeNodes` | Already described/cancelled/oversized work, failed persistence, retry/resume, timeout, dependency order/incremental context | Both describe/generation suites |
| `streamLlamaCompletion`, `LlamaTransportError` | Endpoint/request contract, byte-split UTF-8/SSE, CRLF, metadata/nonstring data, HTTP/empty/malformed/truncated responses; real local HTTP, unreachable server, timeout/cancellation | `llama_transport.matrix.test.ts`, `llama_transport.test.ts` |
| `searchUnits` | Every score tier, case/whitespace, empty/no hits, limits, missing source, provenance | `harness.matrix.test.ts`, `harness_search.test.ts` |
| `scoreMatch`, `rankPalette` | Prefix/boundary/substring/subsequence, separators, no match, ties, immutability, always-on rows | `harness.matrix.test.ts`, `harness_palette.test.ts` |
| `typeColor`, `typesMismatch`, `nodeIdOf`, `callables`, `buildGraph` | Empty/map/compose/missing flow scopes, type normalization (including quoted annotations and recursive generic container arguments), compatibility/mismatch warnings on wires, on-demand context filtering (`contextFilter`), flow filtering, immutability, unique IDs; classes, context/data wires, stale/invalid state, `main.json` root call instances and legacy `refs`/placeholders, positions/flow ports | `harness.matrix.test.ts`, `harness_graph.test.ts` |
| `normalizeNodeCode`, `diffNodeCode`, `buildNodeHealthReport` | Comment/docstring/whitespace/parameter alpha-renaming normalization (preserving string literal contents verbatim), line-by-line LCS diff, unreferenced candidates (excluding refs/flows/placeholders/`uses`/free-variable calls while ignoring strings/comments/params/locals/attributes/kwargs/imports, flagging prompt-only `contextOnlyBy`), exact duplicates, heuristic near duplicates, explicit dynamic/module-import caveats and non-safety warning | `harness_health.test.ts` |
| `SlateMcpServer`, `validateStubBody`, `MCP_TOOLS` | JSON-RPC 2.0 protocol handshake/ping/list/call, `slate_find` (query, signature, scope filtering), `slate_focus` (in-process bridge, live HTTP bridge, headless fallback), `slate_place_notes` (create, update, attachedTo, positions, batch), `slate_define_stub` (strictly refusing arbitrary body implementations, atomic stubs with contracts/cases, oversized node splitting via `splitFrom`), `slate_wire_flow` (deterministic wiring, instance additions/removals, no self-loops), stdio stream transport | `mcp_server.test.ts`; unreadable/invalid `layout.json`, flow and node files are never overwritten (only a missing file is created), position-only `slate_wire_flow` updates preserve existing instance `node`/value fields, and `print(...)` smuggled in `NotImplementedError(...)` is refused. Bundled `out/mcp/slate_mcp_server.js` starts standalone without `node_modules` (Extension Host `mcp.test.ts`). |
| `checkJpl60`, `checkNodeCode`, `indexNode` JPL-60 guardrails | JPL-60 line boundaries (59, 60, 61 lines), mandatory parameter & return type annotations, contract documentation readiness, `enforceJpl60` error throwing, host diagnostics | `slate_folder.test.ts`, `verify_contracts.test.ts` |
| `validateNodeSchema`, `validateFlowSchema`, `validateNodeAst`, `checkProjectParity`, `checkProjectDrift`, `verifyAll` | Formal JSON Schema validation (`contracts/*.schema.json`), Lezer AST strict typing enforcement, JPL-60 line count, 100% parity verification (rogue function detection), compilation drift verification against committed disk output | `verify_contracts.test.ts` |
| `runNodeVerification`, `runRevisionLoop`, `formatCasesAsPython`, `generateVerificationFiles`, `isVerificationStale`, `resolvePythonPath` | Pydantic runtime parameter/return contract validation wrapper (`@validate_call(validate_return=True)`), pytest test function synthesis from structured cases (both object and assertion forms), mutmut mutation test runner, unsupported platform/WSL fallback diagnostics, cancellation via AbortSignal, timeout handling, untrusted workspace rejection, code hash staleness detection, bounded revision loop (max 3 revisions) with truncated traceback micro-packet feedback | `verification_runner.matrix.test.ts`, `persistence.test.ts` |
| `runFlow`, `killProcessTree`, `parseTraceLog`, `makeValueKey`, `parseValueKey`, `flowTarget`, `SLATE_TRACE_PY`, `SLATE_RUN_PY` | Real child execution, timeout, output byte limit, abort cancellation, untrusted workspace rejection, invalid/missing compile errors rejection, per-use value isolation (`invocationPath/instanceId/portId`), failure downstream `not_executed` cascade, trace format separation from user stdout | `flow_runner.matrix.test.ts`, `persistence.test.ts` |
| `inferValueType`, `parseValueLiteral`, `compileValueToPython`, viewers, values | Type inference across primitives/JSON/expressions, literal parsing/normalization with syntax error detection, Python codegen for numbers/booleans/strings/lists/dicts/expressions, viewer instance parsing/serialization/roundtrip, untraced no-op vs traced input observation, live runner viewer capture and downstream failure skipping | `values_viewers.matrix.test.ts`, `persistence.test.ts` |
| `deepValueEqual`, `matchFlowOutputs`, `runFlowCase`, `runFlowGuardrails`, `runNodeGuardrails`, `cases` | Deep equality with type/repr tolerance, output matching across single/multiple/named ports, flow test case execution, expected exception matching, flow guardrail summaries, multi-flow affected dependency tracking, guardrail rejection of breaking hand edits and proposals, flow/node case roundtrip serialization (S-602) | `cases_guardrails.matrix.test.ts`, `persistence.test.ts` |
| `buildUsageIndex`, `isSharedDefinition` | Derived usage index across instances in flows and `main.json`, compiler-resolved code dependencies in `doc.uses`, prompt-only context dependencies in `annotation.dependencies` (strictly isolated without inflating total uses), legacy `layout.refs` deduplication, self-reference exclusion, multi-flow call sites | `usage_index.matrix.test.ts`, `persistence.test.ts` |
| `checkLlamaHealth`, `LlamaHealthResult`, `verifyCandidate`, `createStub`, `setLlamaConfig`, `runRevisionLoop` | Local LLM health check via `/v1/models` and `/health`, timeout/unreachable handling, dynamic endpoint/model configuration via MCP and host, candidate review editing, scratch-overlay isolated guardrail verification, bounded revision loop (up to 3 attempts) with failure feedback, and typed stub creation on root canvas and wire drops | `verified_candidates.matrix.test.ts`, `persistence.test.ts`, `mcp_server.test.ts` |
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
| Live mode & Side-Effect Consent (S-603) | `live_mode.matrix.test.ts`: consent requirement, untrusted workspace rejection, semantic vs layout edit triggers, debounced re-execution, abort controller concurrency, no purity caching, broken graph failure. `persistence.test.ts`: real Extension Host live mode activation with consent, rerun on setValue, layout exclusion, disable. | OS desktop and Python execution environment required |
| Occurrence-aware micro packets (S-700) | `occurrence_packets.matrix.test.ts`: flow wire neighbor extraction, cross-flow neighbor isolation, micro-context discipline (signatures + intent + contract summary without body code), explicit fullContextIds body inclusion, structured TestCase prompt formatting, refusal of oversized targets exceeding 600 tokens without truncation, neighbor signature trimming on budget limits. `persistence.test.ts`: real Extension Host packetPreview with occurrence, isolated neighbor preview, generation dispatch with occurrence. | Requires active VS Code extension host for persistence/protocol checks |

See [VERIFICATION.md](VERIFICATION.md) for commands, seed replay and exact scope.

Palette survivor follow-up: `harness_palette.test.ts` covers competing entries
with multiple matching fields, independently making label/keywords/detail the
strongest match, reversed input order, and no-match queries. Stryker verifies
that selecting the weakest field is rejected. Five equivalent mutations remain
counted; the branch/score/group-order reasoning is in `VERIFICATION.md`.

## Full-source coverage work

| Surface | Added evidence | Remaining gaps |
| --- | --- | --- |
| `instrumentSource`, `sourcePath`, `isActiveSource`, `activeSources`, `sourceFingerprint`, `requireCompleteCoverage`, `mergeRunnerCoverage`, `generateCoverage` | `coverage_tools.test.ts`: TS/JSX instrumentation, invalid syntax, source inventory (including trailing-slash roots, Windows/POSIX `file:` URLs and fallback decoding), missing/stale/malformed input, complementary branches, unexecuted-file denominator and strict 100% rejection | Full report depends on all three runner suites passing |
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

## PR #1 review regressions

| Surface | Automated evidence | Boundary |
| --- | --- | --- |
| `SlateFolderHost.writeNode`, `HarnessPanel.acceptFolderProposal` / `undoAccepted` | Native `persistence.test.ts` holds Save, applies a later real WorkspaceEdit, resumes Save, and verifies Slate Undo rejects without changing buffer version/text or disk. Existing acceptance, normal Undo, rejected edit and failed-save tests remain | Capture the applied document version before awaiting Save |
| `Inspector` visibility | Browser `interaction_chains.playwright.ts` checks code/intent/contract and note title/body/attachment survive hide/reopen with no implicit writes; explicit Save dispatches retained drafts | Changing selection still replaces details; only hiding the same selection preserves its local state |
| Extension coverage build plugin | `extension_build.test.ts` runs the build script with esbuild's loader boundary: POSIX/Windows source paths instrument, test/dependency paths skip, normal builds remain uninstrumented, read errors propagate | Windows path syntax is exercised on the current OS; this is not a full Windows Extension Host run |
| Cross-platform coverage & sandbox paths (`sourcePath`, `instrumentSource`, `prepareSystemSandbox`) | `coverage_tools.test.ts`, `mutation_bridge.test.ts`: POSIX `file:///repo/...`, Windows `file:///C:/repo/...`, trailing-slash `rootDir`, and `fileURLToPath` rejection fallback URL normalization; Windows junctions for Stryker sandboxes and `--optional-vscode-test` unit-mutation setup without `.vscode-test` | Full 3-runner coverage verified on Windows |
| `searchUnits`, `indexNode`, `streamLlamaCompletion` edge paths | `harness_search.test.ts`, `slate_folder.test.ts`, `llama_transport.matrix.test.ts`: multiline annotation query spanning `intent`+`contract`, invalid Python code in `indexNode`, non-standard node relative path, empty-body HTTP 500 error, non-`Error` fetch rejection | `search.ts` and `slate_folder.ts` at 100% across all four coverage metrics |
| `parseModule`, `normalizeParameters`, `topLevelBindings`, `PythonAdapter.replaceUnit` | `python_adapter.test.ts`: single-line padded parameter lists, multiline parameter lists with internal blank/whitespace-only lines and wider closing-paren indentation, nested class declarations, `/` after `*args`, `from ... import *` bindings, and `\r`-only method replacement triggering post-edit syntax rejection | `python_adapter.ts` at 100% line/function coverage; surviving mutants audited in `VERIFICATION.md` |
| `portPythonProject`, `compilePython`, `flowToNode` | `port_compile.test.ts`: decorated classes, blank-line-separated prelude statements, trailing module comments, `..` relative imports, shadowed prelude binding warnings, root module folder collision, invalid/star imports, unconfigured library/uncompiled node uses, 0-output and 2-output (`tuple[int, str]`) flow calls, and positional-only argument wiring after an unwired optional positional-only parameter | `compile/python.ts` and `port/python_importer.ts` at 100% line/statement/function coverage |
| `extension.activate/deactivate`, `SlateLauncherView`, `portPythonFolder`, `compileSlateFolder`, `SlateFolderHost`, `HarnessPanel` | Real Host `project.test.ts` & `persistence.test.ts`: no-workspace guards, `openHarness` empty-workspace choices/panel creation/reveal, launcher CSP HTML and message routing, dialog-based port with nested/hidden/skipped/generated/broken files, compile error/warning/stale-deletion paths, missing-config and directory-library indexing, library-target `addInstance`, concurrent generate/describe guards and cancellation, stale `lastGood` fallback, and persisted root-canvas wire/deletion assertions | Active codebase reaches 99.96% line coverage (2569/2570) across `unit` + `browser` + `native` |
