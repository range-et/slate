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
| Inspector | Intent and contract save separately against selected target | Q inspector metadata/code/lock; H JSON edits |
| Inline intent | Enter commits, Escape cancels; unchanged text avoids write | B Enter commit; Q Escape; C unchanged, blur and Shift+Enter |
| Code | Initial Save disabled; editing enables Save with code and base source hash | Q inspector code; H valid/invalid edits; U adapter/node validation |
| Module state | Prelude/epilogue inspector edits arbitrary module statements | U module-state checks; C module-state editor/hash |
| Lock | Lock/Unlock changes generation protection | Q Lock; C Unlock; P rejects acceptance when target was locked after generation; U packet rejection |
| Context | Drag context handles creates typed dependency; edge menu removes; picker adds; palette removes | B context editing chain; U graph and packet |
| Context | Chip removes dependency; keyboard picker selection; self/duplicate/non-durable candidates excluded | B picker; C chip removal, keyboard add/dismiss and self/existing/non-durable exclusions |
| Data wires | Port drag creates root/flow endpoint action; one incoming wire replaces previous | B data wire; H root/flow wiring; U connect matrix |
| Data wires | Edge Remove wire disconnects; reject self/mixed context-data/invalid direction/group-plus to group-plus | H disconnect; U validation; C data-wire removal and self/mixed/reverse/group-plus negative gestures |
| Group ports | Wire to `+ new` automatically creates typed, uniquely named group input/output | H persisted ports and compile; U flow ports; C group-plus dispatch (there is no native naming prompt for this action) |
| Values | Escape restores literal; blur saves changed value scoped to root or flow | Q literal cancel/blur (root); C flow literal Enter commits once; P root/flow values persisted and reindexed after reopen; U codegen |
| References | Find references highlights definition and refs and reports usage; Delete reference targets ref only | B refs; Q context menu deletion; H delete persistence |
| References | Broken reference shows warning and omits navigation/generation actions | U graph; C broken reference controls |
| Placeholders | Unresolved placeholder omits conversion; Create node action; Delete placeholder | B unresolved/create; Q context menu; H conversion |
| Placeholders | Unique matching name enables Convert to reference; ambiguity prevents conversion | U graph + H conversion; C resolved/ambiguous placeholder snapshots |
| Flows | Delete flow dispatches id; Delete instance/value dispatches item IDs | Q delete flow/value/ref; C Remove from flow; H removal; P delete-confirm cancellation preserves file/layout, confirmation removes both |
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
- Selecting a node delays its inspector by 400 ms so a direct double-click can reach a node that the inspector would otherwise cover. Selection highlight remains immediate; navigation cancels the pending inspector. Single-click details incur this small delay.
- Cancelling the second new-node intent prompt now aborts creation instead of creating a node with empty intent.
- Proposal acceptance checks the current lock and refuses to claim success if VS Code cannot save the node.
- Undo accepted edit checks the accepted document version, so it cannot undo a subsequent human edit instead. Normal native Undo restores the buffer; Save persists that restored content.
