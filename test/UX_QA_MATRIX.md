# Slate UX / QA interaction matrix

This inventory covers the active Slate canvas and VS Code extension, inspected against `src/harness/main.tsx`, `harness_protocol.ts`, the host handlers, and the current test suites. It excludes the frozen legacy notebook. It is a maintained checklist of exposed controls, state transitions, and meaningful interaction chains—not a claim to cover every permutation of user actions.

## Gates and evidence

- **B**: `test/e2e/harness.playwright.ts`, existing browser interaction chains.
- **Q**: `test/e2e/qa_matrix.playwright.ts`, browser QA matrices and state transitions.
- **C**: `test/e2e/interaction_chains.playwright.ts`, alternate gestures, state transitions, scoped drags, invalid wires, and asynchronous races.
- **H**: `vscode-extension/src/test/suite/extension.test.ts`, real Extension Host persistence, validation, and native undo.
- **P**: `vscode-extension/src/test/suite/persistence.test.ts`, isolated native-host proposal, file persistence, stale/locked/failed write, undo, library, layout and prompt-boundary tests.
- **W**: `vscode-extension/scripts/test-workbench.js`, real VS Code webview Generate/Accept/Undo/Save, native prompt validation/cancel and node/flow creation against an isolated project copy.
- **U**: `test/*.test.ts`, pure data transformations, validation, graph, compiler, generation, transport, and search.
- **Gap** means the exact gesture/state is not yet automated. Related lower-level assertions are identified separately and do not erase the gap.

Run browser QA with `npm run test:webview`. A launch gate must also run `npm test`, `npm run test:electron`, and `npm run test:workbench`; browser message assertions alone do not establish that an edit persisted, compiled, or was undoable. `npm run test:qa` runs browser + Extension Host + workbench QA; `npm run verify:launch` runs the baseline/unit gate followed by QA. Packaging invokes this launch gate, and CI requires its aggregate result. `AGENTS.md` makes this mandatory for code changes. Playwright retains failure screenshots and traces in `test-results/`.

Browser tests use a recording host. They assert real DOM interaction, enabled/disabled states, correctly scoped messages, revision/source identity, and rendered host feedback. H/P exercise actual host operations, WorkspaceEdits and persisted files. W clicks the bundled webview and real native input boxes in VS Code and checks resulting disk contents; its generation chain uses a deterministic local HTTP server, with no injected webview responses.

## Controls and gestures

| Area | Interaction and expected behavior | Automated evidence / remaining gap |
|---|---|---|
| Startup | Host receives `ready`; snapshot renders definitions, state, diagnostics, refs, placeholders, flows, values, notes | B/Q startup; H indexing; W bundle rendering |
| JPL-60 & Contracts | Warning badge on node card for >60 lines or missing annotations; inspector displays diagnostics and split/refactor prompt | B inspector diagnostics; Q inspector JPL-60 warning / split action |
| Node Verification & Quality Badges | Live verification badge on node cards (untested, running, passed, failed, mutant_survived, stale); inspector displays Verification & JPL-60 Quality section with passed/total tests, mutant count, collapsible failure traceback / mutant diff, "Verify Node" trigger and "Try up to 3 revisions" bounded retry loop with micro-packet feedback | Q surfaces live verification badges on canvas nodes and verification inspector controls; P per-node Pydantic + pytest + mutmut verification runner, badges, staleness, cancellation, and bounded retry loop; U verification_runner.matrix.test.ts |
| Selection | Node click selects and opens inspector; selected unit requests packet preview | B context workbench; Q inspector / generation |
| Selection | Shift multi-select followed by grouping preserves the selected instance IDs and flow scope | B refs/flows/grouping |
| Selection | Clear selection removes selected styling and inspector | Q palette keyboard/reference navigation |
| Navigation | Double-click definition or Enter on selection opens its source; inspector/menu/palette Open actions reveal the durable ID | B search reveal; Q inspector Open; C source reveal via double-click, Enter, menu, and palette |
| Navigation | Ref Go to definition returns to Compose and selects target | Q palette keyboard/reference navigation |
| Navigation | Flow Open via palette; root breadcrumb returns to root | B refs/flows/grouping |
| Navigation | Open flow via inspector/menu, double-click or Tab; nested breadcrumbs and parent action | C flow navigation matrix (inspector/menu/double-click/Tab) and nested breadcrumbs |
| Navigation | Deleted/renamed open flow returns to parent | C nested flow deletion returns to surviving parent |
| Canvas | Trackpad-style wheel pans without zooming | B board context menus/panning |
| Canvas | Drag nodes posts positions, revision and root/map/flow scope; multi-drag retains all selected positions | H/P root/map/flow layout persistence across reopen; C scoped drag and multi-drag |
| Canvas | Fit via board menu/palette and React Flow controls; plus/minus zoom; drag pan; pinch zoom | C zoom controls, drag pan, menu/command/control fit and Chromium pinch gesture; physical device behavior remains manual |
| MCP Camera Sync | Live canvas camera pan/zoom (`slate_focus`) dispatches to active webview via `HarnessPanel` or local bridge, smoothly centering target node, note, or bounding region in XYFlow viewport with target selection | B camera focus message handling and node selection; M `vscode-extension/src/test/suite/mcp.test.ts` real panel camera dispatch and region bounding; U `test/mcp_server.test.ts` |
| View | Compose/Map toggles state; Map shows folders and hides refs, ports, wires; adding is blocked with explanatory status | B Map; Q library/Map chain; U graph |
| Library | Filter by text, show/hide, click a callable to select it, drag callable onto canvas | Q filter/visibility; B library drag; C library find, missing match and off-canvas status |
| Library | Add library posts `addLibrary` | Q dispatch; P real config persistence, deduplication, indexing after reopen and cancelled chooser; chooser selection is stubbed at the VS Code API boundary |
| Palette | Ctrl/Cmd+K and `/` open; text filtering; Enter executes; closes after action | B selection commands; Q command matrix |
| Palette | Arrow keys update active option; Escape dismisses | Q palette keyboard/reference navigation |
| Palette | Plain keys and `/`/Enter inside text editors do not execute canvas commands | B plain keys; Q inline cancel/field shortcut isolation |
| Palette | Backdrop dismisses; empty results show message; pointer hover changes active option | C palette hover/backdrop and empty add dialog |
| Status | Command success/failure text is shown; describe progress shown | Q command feedback / describe chain; generic `ok:false` styling is not distinct |
| Add | Tab on empty selection opens add dialog; wire drop opens filtered add dialog; select target auto-wires using correct port | B refs/flows/grouping |
| Add | Shift+A / double-click blank canvas / board-menu Add are equivalent entry points | Q palette Add; C Shift+A, blank double-click and board-menu Add |
| Add | Value adds a Python literal; valid free-text name adds placeholder; open flow excludes itself | U callable/codegen; C add literal/placeholder and current-flow exclusion |
| Creation | New node, placeholder, flow dispatch with revision and canvas coordinates | Q command matrix; H creation/round-trip |
| Creation | Native signature/name prompts validate and cancel without writes | P validators/cancel for node, placeholder and flow, including second intent prompt; W actual invalid signature Enter/Escape, intent cancellation, valid node and invalid/valid flow prompts with disk assertions |
| Inspector | Docked right-hand layout (`280px–640px`, clamped so `.harness-canvas` keeps `>= 260px` width) keeps `.harness-canvas` unobstructed; drag/keyboard separator resizes inspector and canvas while preserving the 400 ms click debounce for double-click draft retention | B docked/resizable inspector + 800px viewport clamp; C draft preservation on double-click hide |
| Inspector | Intent and contract save separately against selected target | Q inspector metadata/code/lock; H JSON edits |
| Inline intent | Enter commits, Escape cancels; unchanged text avoids write | B Enter commit; Q Escape; C unchanged, blur and Shift+Enter |
| Code | Initial Save disabled; editing enables Save with code and base source hash | Q inspector code; H valid/invalid edits; U adapter/node validation |
| Module state | Prelude/epilogue inspector edits arbitrary module statements | U module-state checks; C module-state editor/hash |
| Lock | Lock/Unlock changes generation protection | Q Lock; C Unlock; P rejects acceptance when target was locked after generation; U packet rejection |
| Context | Shown on demand for selected/connecting node or via `Toggle context links` / palette so ordinary wires read as dataflow; drag context handles creates typed dependency; edge menu removes; picker adds; palette removes | B on-demand context links + context editing chain; U graph (`contextFilter`) and packet |
| Context | Chip removes dependency; keyboard picker selection; self/duplicate/non-durable candidates excluded | B picker; C chip removal, keyboard add/dismiss and self/existing/non-durable exclusions |
| Data wires | Port drag creates root/flow endpoint action (wiring a root definition card instantiates a dedicated call instance in `flows/main.json`; disconnecting preserves unwired root call instances); one incoming wire replaces previous; mismatched port types warn on wire, status bar, and wire menu without blocking connection | B data wire + type-mismatch warning; H root/flow wiring and non-pruning on disconnect; U connect/migration & `typesMismatch` matrix |
| Data wires | Edge Remove wire disconnects; reject self/mixed context-data/invalid direction/group-plus to group-plus | H disconnect; U validation; C data-wire removal and self/mixed/reverse/group-plus negative gestures |
| Health report | Topbar `Health` button and palette `Node health report` open read-only report with modal focus trap and canvas-shortcut suppression, coverage caveats ("never safe to delete automatically"), unreferenced candidates, exact/near duplicates, LCS diff viewer, and `Go to` node navigation | B health report dialog, focus trap, shortcut guard, caveats, diff and navigation; H `uses`/`imports` indexing; U `harness_health.test.ts` |
| Group ports | Wire to `+ new` automatically creates typed, uniquely named group input/output | H persisted ports and compile; U flow ports; C group-plus dispatch (there is no native naming prompt for this action) |
| Values | Escape restores literal; blur saves changed value scoped to root or flow | Q literal cancel/blur (root); C flow literal Enter commits once; P root/flow values persisted and reindexed after reopen; U codegen |
| References | Root call instances live in `flows/main.json` (`layout.json` keeps placement only); legacy `layout.refs` and implied root instances migrate cleanly (preserving `layout.refs` on `main.json` write failure, deferring disk writes while `main.json`/`layout.json` buffers are dirty, and compiling against dirty or absent `layout.json`); Find references highlights definition and call instances without double-counting; Delete reference removes from `main.json` and `layout.positions` | B refs; Q context menu deletion; C `main.json` root instance rendering and reference counting; H/P migration, failure recovery, dirty-buffer deferral, compile, and delete persistence |
| References | Broken reference shows warning and omits navigation/generation actions | U graph; C broken reference controls |
| Used-by-N and Shared Definitions | Node cards display "N uses" badge when total uses > 0; Inspector displays "Shared definition: Editing affects N uses across the project" warning with "Fork definition" when totalUses > 1; Inspector lists navigable call sites ("Usages (N)") that navigate between flows and root when clicked; "Fork definition" clones node to fresh file and selects it | Q surfaces Used-by-N badge, shared-definition banner with Fork, and navigable call sites in Inspector (S-502); P derived usage index across instances and dependencies, and forkDefinition action (S-502); U usage_index.matrix.test.ts |
| Placeholders | Unresolved placeholder omits conversion; Create node action; Delete placeholder | B unresolved/create; Q context menu; H conversion |
| Placeholders | Unique matching name enables Convert to reference; ambiguity prevents conversion | U graph + H conversion; C resolved/ambiguous placeholder snapshots |
| Flows | Delete flow dispatches id; Delete instance/value dispatches item IDs | Q delete flow/value/ref; C Remove from flow; H removal; P delete-confirm cancellation preserves file/layout, confirmation removes both |
| Ergonomics | Delete / Backspace key prompts confirmation distinguishing "Remove call instance" (prunes from flow/main while leaving node JSON) vs "Delete node file" (deletes node JSON on disk and unplugs all wires/instances across flows); Delete context menu and palette entries | C Delete/Backspace prompt, context menu, and negative cancellation; P persistence of file deletion, instance removal, and wire unmeshing across flows |
| Ergonomics | Copy (Cmd/Ctrl+C) stores selection to clipboard; Paste linked (Cmd/Ctrl+V) creates explicit instances referencing existing definition without creating files; Paste duplicate (Cmd/Ctrl+Shift+V) forks node into new node file with fresh name and places it; Make unique button in Inspector forks an instance into an independent node file | C copy/paste linked and duplicate, make unique inspector button and palette commands; P persistence of linked instances, duplicated node files, and independent forked definitions |
| Ergonomics | Flow input/output port renaming and deletion via context menu on `__input` and `__output` nodes; renames and deletes propagate to internal wires and repair caller wires in parent flows without breakage | C port context menus for rename/delete; P flow port rename and deletion persistence with caller wire repair in main.json |
| Grouping | Ctrl/Cmd+G extracts selection; crossing wires become ports; compiler preserves execution | B grouping; H extraction; U extraction/codegen |
| Grouping | Empty or non-groupable selection shows explanation rather than dispatch | C empty grouping guard and note/placeholder selections |
| Notes | Create unattached or attached note; right-click opens note editor | B note menu/create; H persistence |
| Notes | Edit title/body, attach/detach, save and delete with note ID/revision; no source edit message | Q note lifecycle; H proves node files unchanged |
| Notes | Delete from context menu and palette attached-note entry | C note context deletion and attached-note palette/menu entries |
| Search | Query from palette returns provenance/snippet; result selects and reveals durable ID without editor focus | B guided search; U search scoring |
| Search | Empty result, stale-index notice, close, then new search | Q search retry chain |
| Search | Delayed earlier query arriving after newer query; dismissed reply; target deleted during search | C latest-search/dismissed/deleted-target chains |
| Generation | No packet / packet error disables Generate; exact target/context preview and budgets | B packet workbench; Q generation error state; U packet contracts |
| Generation | Start → progress → Cancel → failure status → retry | Q generation chain; U real transport cancellation/timeouts |
| Generation | Proposal shows code/checks → Accept → accepted state → Undo → Save | Q UI state; P actual HTTP generation, saved candidate, unchanged context, refresh, native undo buffer, save/reopen; W real buttons through the entire chain and disk assertions |
| Generation | Source changes mark proposal stale and disable Accept | Q stale UI; U hashes; P rejects changed target/context in saved files and dirty buffers, deleted target, unknown/reused IDs; preserves intervening metadata |
| Generation | Undo accepted edit must not undo a later human edit | P subsequent human edit remains intact and command reports that native Undo must be used to review later edits |
| Generation | Failed edit/save must not report acceptance | P refused WorkspaceEdit preserves disk; refused Save reports failure and keeps unsaved buffer available for recovery |
| Generation | Selection changes during stream; unrelated stale/progress/failure IDs must not affect active proposal | C generation selection/unrelated-message chain |
| Describe | Start → progress → Stop → stopped state → restart | Q describe chain; H real fake-server pass; U resume/retry/budget/cancellation |
| Compile | Command dispatch → host result; exported Python reflects nodes/flows/imports | Q command matrix; H port/compile; U pipeline and baseline pytest |
| Refresh/save | Palette dispatches index refresh and save-all; host emits result | Q command matrix; H indexing dirty buffers |
| Native extension | Open project/editor, port Python folder, describe imported nodes, compile to disk | H port/describe/compile; W open project smoke |

## Required interaction chains when extending a feature

For each added behavior, name the trigger, starting state, action sequence, resulting DOM state, expected host operation, and persisted effect. Test the relevant chain at both the pure-function and UI/host boundaries. Prefer a small set of meaningful sequences over enumerating all permutations:

1. Create/import → select → edit metadata/code → save → refresh/reload → verify persisted result → compile.
2. Add instance/value/reference → connect → replace incoming connection → disconnect/delete → verify no dangling edges → compile.
3. Select multiple items → extract flow → open child → edit/connect → return to parent → verify crossings and output behavior.
4. Open picker/palette → filter → keyboard/pointer select → dismiss → reopen; verify text inputs retain their shortcuts and typing.
5. Generate preview → start → stream → accept → undo, plus cancel/retry, invalid response, missing context, locked target, stale source and stale proposal.
6. Describe → cancel midway → resume; retain existing human intent and report skipped/malformed/oversized nodes.
7. Create note → attach → edit → detach → delete; prove source files remain untouched.
8. Search → select → source reveal; repeat after revision change and no-match result.
9. Root Compose → Map → flow → nested flow → parent/root; preserve the correct edit/layout scope.
10. Every write path: valid operation, invalid input, unchanged input, missing/deleted target, stale revision/hash, cancellation, and persistence failure where applicable.

All previously listed functional gaps now have the automated evidence shown above. This does not claim coverage of every action permutation or every platform. The OS file chooser itself (as distinct from the selected-file/cancel host behavior), physical touch/trackpad hardware, screen-reader behavior, broad visual clipping across devices, and real-model quality remain manual compatibility checks. Those are not silently counted as automated passes. Browser tests must not replace host persistence tests with message-only assertions.

## Regression fixes found by the interaction chains

- Enter on a value editor previously saved twice (once directly and once on blur); it now commits once through blur.
- Late results from an older or dismissed search no longer replace the latest search UI.
- An unrelated generation failure or proposal no longer terminates another active generation.
- Selecting a node opens the docked inspector (with a 400 ms single-click debounce so double-clicking a node hides the inspector while preserving unsaved drafts) without covering `.harness-canvas`, and resizing clamps the inspector so at least 260px of canvas width remains.
- Cancelling the second new-node intent prompt now aborts creation instead of creating a node with empty intent.
- Proposal acceptance checks the current lock and refuses to claim success if VS Code cannot save the node.
- Undo accepted edit checks the accepted document version, so it cannot undo a subsequent human edit instead. Normal native Undo restores the buffer; Save persists that restored content.

## Additional verification layers

Palette ranking now also has generated conservation/immutability checks and an
80% mutation gate (`test/invariants.property.test.ts`, `stryker.config.json`).
Persisted node JSON has a reviewed snapshot and generated schema round trips.
These are pure-function evidence only: they do not expand browser gesture,
cancellation, native save/undo or dirty-buffer coverage. B/Q/C/H/P/W remain
required by `verify:launch`; existing UX gaps above remain open.

Palette ranking follow-up: pure tests now verify that weak matches in additional
fields cannot demote an entry below an intermediate competitor, with each field
acting as the strongest match. This strengthens the ranking behind the palette
and context picker; it does not claim new keyboard/pointer or host coverage.

Full-source measurement now has an opt-in coverage fixture for B/Q/C and native
collection for H/P, merged with unit execution using the same source counters.
The combined report does not count browser dispatch as native persistence.
`verify:coverage` targets 100% lines/statements/functions/branches; it is not yet
passing. W remains required by the ordinary launch gate. Full-source mutation
execution currently uses unit tests only, so native/UI mutation detection is
still a gap even where browser/host line coverage exists.

Additional automated chains: `interaction_chains.playwright.ts` covers context-menu
generation, board creation/refresh dispatch, and double-click editing with Escape
cancellation. `offline.playwright.ts` covers demo search feedback and empty-canvas
add/dismiss without a host. These browser assertions prove UI behavior, not native
persistence. Real Host `persistence.test.ts` now closes the canvas during an
in-flight refresh with another refresh queued, verifies both commands settle,
and checks unchanged disk data and cleared panel state. This regression failed
with “Webview is disposed” before the lifecycle fix.

Palette entry coverage additionally exercises creation, library, compile and Save
commands with exactly one typed dispatch and palette dismissal; Map → Compose →
flow → parent navigation verifies resulting controls and canvas nodes in
`interaction_chains.playwright.ts`. Host persistence remains covered separately.

`vscode-extension/src/test/suite/project.test.ts` exercises registered commands
in the real Extension Host: New Project → create files → open canvas → close →
reopen existing project without overwriting; invalid names/cancel; missing-project
Compile; Port cancellation, no Python sources and occupied destination; and
filesystem failure before creation. Prompts are simulated at their VS Code API
boundary; this is not an additional claim of native dialog gesture coverage.
The suite refuses to touch an unexpected pre-existing fixture-root project.

System mutation infrastructure is being validated separately from code coverage.
The Vite bridge initializes the selected Stryker mutant before browser modules
execute; Node/Extension Host uses Stryker's inherited environment variable.
`stryker.system.config.json` runs unit → browser → native → workbench in a copied
sandbox with one worker and no reused Vite server. A successful dry run proves
setup only; selected-mutant smoke checks must demonstrate real assertion failures
before claiming this route detects UI or host defects. No whole-app mutation
score is yet established by this runner.

The system mutation baseline exposed a lost-layout race before any mutant ran.
Background indexing now joins the edit queue rather than reloading layout during
an in-progress canvas write. Native regressions cover prompt-held edit → ready
refresh → commit, and failed layout write → restore filesystem → background
refresh → successful edit. The ordering regression failed on the old build and
both regressions passed on the fixed build. Focused development runs filter only
generated test output; `verify:launch` recompiles the unfiltered checked-in suite.

Workbench QA now bounds shutdown of its own Electron child after assertions.
It first requests normal close, then logs and force-closes only that owned child
if shutdown stalls. Failure to terminate is still an error; failed assertions
remain failures. Unit tests cover normal exit, timeout, termination errors and
cleanup. This does not substitute for any browser/native/workbench assertion.

Python replacement validation now also checks ambiguous duplicate declarations and
unsupported class/nested-function targets at the adapter boundary. Exact edit
ranges, hashes and padding normalization have unit coverage; persistence and
Undo/Save claims continue to come from the real host/workbench suites.

## PR #1 review follow-up

- Pending proposal Save → later real buffer edit → Save completion → Slate Undo:
  native `persistence.test.ts` asserts refusal and preservation of buffer and disk.
  Normal accepted-edit Undo/Save and failed-save recovery remain covered.
- Selected node → edit code/intent/contract drafts → source double-click → hidden
  inspector → single-click reopen → explicit Save: browser tests preserve drafts,
  source reveal, disabled/visibility boundaries and emitted save contents.
- Selected note → edit title/body/attachment → double-click hide → reopen → Save:
  browser tests prove no implicit note write and retention of every draft field.
- Narrow 320/480px panes → Map → Compose → Library: browser regression checks
  header hit targets and resulting pressed state. This targets the Linux CI
  workbench failure where status text intercepted the Compose button.

Linux CI prompt follow-up: workbench creation QA now waits for a complete native
invalid-signature → validation error → valid-signature → cleared error cycle
before Enter, and `src/harness/main.tsx` stops propagation of `Cmd/Ctrl+K` and `/`
in the capture phase so VS Code's webview host does not forward `Ctrl+K` into
workbench chord mode (`Ctrl+K Enter` → `workbench.action.keepEditor`) and swallow
subsequent native prompt `Enter` presses. Browser regression in
`interaction_chains.playwright.ts` verifies pre-registered bubble listeners do not
receive `Ctrl+K` or canvas `/`. Both cancel-at-intent and successful creation
retain their original assertions; dialog visibility alone is no longer treated as
readiness.

## Issue #20 UI and Extension Host coverage expansion

- Browser `qa_matrix.playwright.ts` now also covers the status-bar `⌘K Commands`
  button, command-palette `Add context`, unit-scoped palette actions (`Generate`,
  `Lock`, `Find references`, `Delete selected`), library show/hide and `Add library
  file…` inside an open flow, picking a library instance inside a flow, `Go to
  definition` on a read-only library instance, context-menu `Find references` on
  both unit and flow nodes, `Open flow` from a flow reference, double-click on
  inline intent (stopping propagation without revealing source), double-click on a
  search result, empty `ContextPicker` and `Add node…` `Enter` guards, and
  inspector diagnostic badges on both unit and module-state nodes.
- Real Extension Host `project.test.ts` now also covers `slate.newProject` and
  `slate.portProject` when no workspace folder is open, `slate.openHarness` when no
  project exists (cancel, `New Project`, `Port Python Project…`) and when opening or
  revealing an existing `HarnessPanel`, `SlateLauncherView` HTML/CSP rendering and
  button message routing (`open`, `new`, `port`, `compile`), `deactivate`/`activate`
  lifecycle, dialog-driven `portPythonFolder` over nested/hidden/skipped/generated
  and syntax-error files with existing `slate.json`/`layout.json`, `compileSlateFolder`
  error stops (malformed node/flow JSON and invalid `compile.outDir`) and warning +
  nested stale generated-file deletion, and `SlateFolderHost` missing-config errors,
  directory/missing/invalid library entries, and `librarySignatures`.
- Real Extension Host `persistence.test.ts` now also covers host `search` (fresh and
  stale revisions), `packetPreview` (valid and missing targets), `reveal` and
  `revealUnit` missing-unit rejection, `createNode` confirmation, duplicate-node
  rejection and refused `WorkspaceEdit`, unchanged `writeNode` early return,
  `placeholderToRef` (missing, unmatched, matched) and `placeholderToNode`
  (cancelled and confirmed), root-canvas `addInstance` (including `lib:...` targets
  and persisted `connectFrom`/`connectTo` wire endpoints in `main.json`) and
  `deleteItems` (verifying removal of the ref, its position in `layout.json`, and
  its attached wires in `main.json`), root `extractFlow` with mixed unit/note
  selection, flow self-containment and self-wire guards, self-context rejection,
  concurrent `generate` and `describeNodes` guards and `cancelGeneration`/`cancelDescribe`,
  `describeNodes` write-failure reporting, stale `lastGood` graph retention when a
  node buffer becomes invalid, malformed `layout.json` error reporting, and S-512
  local llama.cpp component forge dual body and pytest unit check generation,
  JPL-60 60-line candidate rejection, signature mismatch rejection, generation
  cancellation, and boundInputs proposal staleness verification.
