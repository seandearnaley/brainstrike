# Explorer Surfaces: Workspace Search, Markdown Viewer, Tapestry, Live Refresh

> Read before changing the Explorer|Search panel, the file-tab markdown
> preview, the per-file range model, the workspace walk, or the tree
> live-refresh pipeline. Rules here are true now; the record behind each is in
> `explorer-search-tapestry/<topic>.md`.

## WORKSPACE SEARCH

`packages/workspace-search`, composed by
`packages/app-shell/src/use-workspace-search-controller.ts` +
`explorer-search-tabs.tsx`.

- Run both modes from the renderer through the platform repositories, with no
  assistant-server dependency. Text mode is `createGrepSearchService` over the
  platform `chunkRepository` — one path everywhere, no web fallback.
- Scope every query to `rootIdentity.workspaceDbRootIds`; empty rootIds returns
  no results, never an unscoped scan and never legacy NULL-root rows.
- Badge a file row with its root whenever the workspace mounts multiple roots
  (`workspaceRootCount`), not only when the result set spans more than one.
- Increment the store's monotonic `generation` on `beginSearch`, on every
  mode/collection/toggle change, and on `clearResults`; `resolveResults` and
  `failSearch` no-op unless it still matches.
- Keep native execution identity stable across readiness-only observations.
  Desktop status refreshes still update semantic availability, but only a change
  to the capability, root binding, store, authorized roots/collections, full
  embedding configuration, or full query plan replaces the executor and cancels
  an active query. Compare the complete status projection with only root and
  collection readiness removed; never retain stale readiness to stabilize it.
- Keep the chunk the single visible selection unit: the chunk row carries the
  only child checkbox, match rows are navigation-only leaves, and every row
  reserves the expand-toggle column so checkboxes align per level.
- Open with a target — match rows pass `{ line }`, chunk rows also pass
  `selection`, `initialSelection` wins over `initialLine` and restored scroll,
  and the store target is consumed exactly once.
- Treat the selected-chunk SET as the source of truth and Tapestry ranges as a
  one-way derived output. Chunk checkboxes are binary, the file checkbox is the
  only tri-state, and Search preserves every non-`origin:'search'` range
  verbatim. An emptied set deletes the key: empty ≡ absent ≡ whole file.
- Gate the SUBMIT, never rewrite the mode, and read NULL joined stats as unknown
  and optimistically available. Why: the semantic executor's FTS arm is scoped
  only by `embedding_set_id`, so an ungated run silently returns lexical-only
  results.
- Keep the store session-only, registered through
  `registerFactoryResetSessionStore`; the active tab persists in
  `context-explorer-layout-store`.

Ranges are output-only, so merging is safe and the subtraction-bleed
defect cannot return; the mode never auto-reverts. Evidence:
`explorer-search-tapestry/workspace-search-panel.md`,
`explorer-search-tapestry/2026-10-04-native-search-execution-identity.md`.
Guard: `search-mode-gating.test.tsx`, `workspace-search-panel.test.tsx`,
`search-results-tree.test.tsx`, `use-search-selection-bridge.test.tsx`,
`apps/desktop/src/__tests__/renderer/components/native-search-provider.test.tsx`,
`packages/app-shell/src/__tests__/use-workspace-search-controller.test.tsx`.

---

## COLLECTION DETAILS DEBUG DRAWER

The Database panel owns the collapsed-by-default Collection details drawer
(`packages/db-explorer/src/components/collection-debug-drawer`).

- Feed the Files pager only from the panel's `recordPagination` plus
  `onRecordPageChange`; never read the store independently beside panel data.
- Build the retrieval preview on `useSemanticSearchExecutor` and the active
  collection repositories, one-shot on explicit submit, surfacing unavailable
  executors and failures visibly. A SQL-only or mock-only proof is not a proof.
- Keep the drawer unmounted while collapsed.

Settled: the Electron proofs measure click-to-settled latency against an
explicit ceiling, separate from the Playwright locator timeout. Evidence:
`explorer-search-tapestry/collection-debug-drawer.md`.
Guard: `collection-debug-drawer.test.tsx`,
`apps/desktop/e2e/embedding-worker-renderer.memory.desktop.test.ts`.

---

## MARKDOWN VIEWER (FILE TABS)

Every file tab renders a slim `FileTabHeader`. Markdown files
(.md/.markdown/.mdown/.mkd — not .mdx, which stays source-only) also get a
Source/Preview toggle, defaulting to preview.

- Render source through `CodeSurface`, preview through `MarkdownSurface`
  (`packages/ui/src/markdown-surface/`). Keep raw HTML inert — no rehype-raw.
  Frontmatter is pre-extracted; invalid YAML renders visibly.
- Persist the mode per compositeKey in `editor-view-state-store`; a one-shot
  view target forces source transiently without writing the store.
- Inject capabilities through `MarkdownPreviewCapabilitiesProvider`; never
  branch on `isElectron()`. Desktop external links use the allowlisted
  main-process `openExternal`, and desktop images the `brainstrike-asset://`
  handler that realpath-validates containment in mounted DB roots.
- Resolve images through a local-only resolver, so a remote http(s) source is
  rejected before any request and renders a visible placeholder. Why: untrusted
  file content must not trigger network requests, independent of CSP.
- Surface every failure (placeholder, toast, or error block);
  `MarkdownPreviewErrorBoundary` offers "Open in source".
- Classify binary content from the worker's discriminated `inaccessible` status
  carrying `BINARY_CONTENT_MESSAGE` (`@brainstrike/types`), never from message
  text. `FileTabBody` exact-matches the sentinel and renders `BinaryFilePreview`,
  whose buttons project the shared context-action registry under the same
  capability gating as the right-click menu.

Evidence: `explorer-search-tapestry/markdown-viewer-surfaces.md`.
Guard: `file-tab-body-binary.test.tsx`.

---

## PER-FILE EXPLORER PANE (FILE TABS)

Every file tab hosts a navigation-only tree pane: its own `FileTreeProvider` per
tab root, pane-local expansions in `file-tab-pane-store`, durable per thread
through the workspace snapshot `editors[*].pane`.

- Render a compositeKey with NO store entry as OPEN and record a manual close as
  an explicit `open: false`; every action that materializes an absent key starts
  from the OPEN template. Truthiness checks on `pane?.open` are a bug class.
- Dock the pane as the SECOND panel of the file-tab split, mirroring the main
  explorer; clamp `widthPct` on both write and hydrate.
- Keep reveal one-shot LOCAL state — `(revealNonce, revealPath)` keyed per
  activation, never persisted.
- Preserve explicit live pane edits across boot hydration: suppress saves during
  the initial read, diff the live workspace against the boot baseline, merge
  pane fields only for tabs the loaded snapshot admits, then persist through the
  existing wholesale replacement boundary. Ordering and rejection contract:
  `docs/agents/assistant-persistence.md`.

Old snapshots without pane entries adopt auto-open retroactively; there
is no migration. Evidence: `explorer-search-tapestry/file-tab-pane.md`.
Guard: `file-tab-pane-store.test.ts`, `file-tab-body-pane.test.tsx`,
`apps/web/e2e/file-tab-pane.test.ts`.

---

## TAPESTRY

The per-file range model spans Explorer, Search, Tapestry, and every context
consumer (report generator, `listWorkspaceContext`, token meters).

- Keep Tapestry the ONLY context preview surface: `PreviewPanelSummary` plus
  `TapestryView`, no tab strip, no Table View, no `activeTab` preference.
  `previewPanelPreferences.v1` keeps its key and serialized `footerMode` name;
  retired fields are ignored on read and pruned on write.
- Treat deferred rows as a snapshot, not current membership: look selected keys
  up in the memoized row/token indexes rather than filtering all deferred rows,
  and feed the grouping/pagination pipeline a paired `{ rows, selection }`
  snapshot. Do not rebuild the token index on current-selection changes.
- Apply the per-file rule unconditionally, no global toggle: files are
  membership, ranges are refinement, no ranges = whole file. Selecting a file
  seeds nothing; `syncTapestryRanges` only clamps existing ranges, and only once
  `contentStatus` is `ready` — a pre-content `totalLines` is an untrusted
  placeholder. The first drag or Search chunk check creates explicit ranges.
- "Clear manual clips" removes every visible file's user-owned ranges including
  `userModified`, and preserves the latest `origin:'search'` ranges.
- Let Search own `origin:'search'` one-way: hand-edit machinery never writes or
  reads it, and `userModified` ranges survive every search mutation untouched.
- Project Tapestry right-click actions through the shared `ActionContextMenu`
  with immutable `tapestry-document` / `tapestry-range` targets and explicit
  `ActionOutcome` failures; never hand-roll Radix menus here. Only one pinned
  precision selector may own the gallery at a time.
- Accept only the platform-neutral `FileSystemAdapter` and `DirectoryHandle` in
  `context-generation.ts`; async exports throw on malformed filters and
  traversal failures, while the synchronous preview (`project-tree-text.ts`)
  converts only known pattern-validation failures into a typed visible result.
- Key files: `packages/file-explorer-ui/src/utils/tapestry-range-sync.ts`,
  `packages/file-explorer-ui/src/preview/preview-panel.tsx` (fixed preview order
  and constant page size), `packages/file-explorer/src/context-generation.ts`,
  and `apps/desktop/src/assistant-server/workspace-context-tools.ts`
  (`listWorkspaceContext`'s `detail: true` gate for per-file ranges).

The Table View and its stores are gone, and the four default-user
behaviour changes that came with the per-file rule are spec-approved — do not
"fix" them back. Evidence: `explorer-search-tapestry/tapestry-range-model.md`.
Guard: `preview-panel.test.tsx`, `preview-panel-deferred-selection.test.tsx`.

---

## CANONICAL CHUNK SOURCE BOUNDARY

- Preserve the existing chunker/parser's chunkIndex, source offsets and line spans;
  do not run another parser or replace AST/text chunks with a line-count policy.
- Validate supplied source spans through the pure chunking-worker
  `source-range-validation` subpath, which reuses the canonical matcher's exact
  and whitespace/CRLF-normalized rules within the claimed span. Do not relocate
  a bad span. Offsets count JavaScript UTF-16 code units, start inclusive/end
  exclusive; lines are 1-based inclusive.
- Keep content hashes bound to the exact canonical chunk text. Reject malformed
  chunks visibly rather than substituting a different segmentation.

Evidence: `indexer/2026-10-03-canonical-provided-chunks.md`.
Guard: `packages/chunking-worker/src/__tests__/source-range-validation.test.ts`,
`packages/indexer/__tests__/provided-chunks.integration.test.ts`.

---

## WORKSPACE INDEX TRAVERSAL

### Desktop reads are mounted-root capabilities

- Authorize every Electron Explorer and Workspace Index read through the single
  main-process `WorkspaceRootRegistry`. Renderer handles are stamped
  projections, not authority: a handle read carries its durable `rootId`, and a
  legacy absolute-path read is accepted only when a mounted root contains it
  (longest wins). There is no raw-adapter fallback.
- Let each mounted real root own one lazy native `SecureRoot` whose constructor
  is the sole resolver: it derives `canonicalPath` from the handle it opened,
  checks target realpaths for containment only, passes the original lexical
  relative path to the native operation, and opens each descendant component
  relative to the pinned handle with no-follow semantics. Enumerations take
  their own fresh descriptor, and `close()` drains rather than blocks.
- Select synthetic roots only through the registration-time
  `isSyntheticFileSystemPath` seam (production default
  `isMockFileSystemIpcPath`); never consult ambient `VITEST` for a
  trust-boundary choice. Freeze the decision by normalized presentation path,
  bind it to the opened root's canonical identity, fail closed on a conflicting
  alias, and let one classification select the secure-root, canonical-root and
  read-path resolvers together.
- Keep symlink/reparse entries as explicit file-shaped Explorer rows; native
  reads never follow them, and file bytes are bounded before crossing into JS.
- Share descriptor/listing projection through the Node-only
  `@brainstrike/file-system/workspace-root-nodes` entry; desktop callers re-export
  it. Root IDs and paths supplied to that pure projection grant no read authority.
  Preserve dirs-first collation, file metadata and the visible truncation marker.
- Bound listings by inspected entries and append a trailing `'truncated'`
  pseudo-node rather than throwing or dropping the partial result. The Explorer
  renders it as a visible, non-selectable, non-expandable tail row, and
  `isPseudoFileNodeType` keeps it out of the tri-state rollup.
- Load visible directories lazily, and put recursive Workspace Index exclusions
  in `createBackgroundIndexingEntryPolicy`
  (`packages/utils/src/background-indexing-policy.ts`), never in a filter
  applied after the adapter has read the entries. Balanced prunes Python
  `.venv`, `venv` and `__pycache__` and deliberately keeps bare `env`; Full root
  traverses them and says so in Settings.
- Restart the provider sync with a fresh service run when the policy changes,
  aborting the previous one. Progress callbacks are run-owned, so a cancelled
  run cannot overwrite the replacement's status; log cancellation as expected
  and keep non-abort import failures error-logged and visible.
- Surface truncation in scans, never skip it silently: `walkDirectoryParallel`
  reports through `onDirectoryTruncated`, a walk WITHOUT that handler fails with
  `DirectoryListingTruncatedError`, both scan modes install the handler, and the
  visible summary carries the deduped count. Treat `expectedFileCount` as a
  floor.
- Keep traversal owned once by `@brainstrike/file-system/directory-tree`, with
  legacy UI modules re-exporting it. Its only adapter requirement is
  `readDirectory`; cancellation and strict read-error rejection join all admitted
  directory reads before the public walk settles. Preserve path/handle identity,
  entry policy, sorting, snapshots and explicit truncation behavior.
- Share scan/path/removal/content policy through `@brainstrike/file-system/workspace-scan*` and `workspace-source-content`; browser wrappers reuse these implementations. Utility source orchestration borrows the same pinned main mount, never reopens it from projected paths; explicit read caps reach the native bounded read.
- Load root and nested ignore files through the scan's authorized file capability before entry admission, using the canonical ignore matcher and the static exclusion floor. Keep rules scan-local, promote ignore-file changes to full-root reconciliation, and carry that effective scope to removal consumers. A truncated directory has unknown rules: retain its notice and cached rows, but admit no source beneath it; present unreadable rules reject the scan.
- Preserve explicit source read intent when an ignore edit promotes a watcher batch to full reconciliation. A later same-batch file recreation under unknown truncated rules retires its earlier removal without admitting the source; explicit final removals and complete excluded replacements remain authoritative.
- Keep unresolved workspace discovery separate from registered PG file identity.
  Secure original-source read/hash precedes bounded main preparation using the
  existing identity/mutation policy. Await real PG source commit and full trusted
  native binding acknowledgement, validate the exact returned identity/hash,
  then parse/publish and complete PG metadata. Never allocate source IDs from
  hashes or write placeholder source. Use one scan-local root/path uniqueness
  guard across registered, removed and unresolved forms before read/preparation;
  nullable retained roots/paths do not form a workspace identity.
  Cancellation joins preparation; root/path
  metadata grants no read authority. Retained collection roots/paths stay nullable.
- Retain, never delete, on partial knowledge: absence from a truncated listing
  is not evidence of deletion. Missing-file reconciliation skips cached rows
  under any truncated directory, scoped removal neither prefix-wipes nor
  exact-invalidates beneath a truncated prefix, and the idle coverage audit
  returns `truncated-root` — warning plus visible `waiting`, never
  `markAuditVerified`, never a recovery sync.
- Keep workspace include/exclude filters for visible-tree filtering and
  selection only; do not mutate custom filters to implement indexing exclusions.
- Keep `flattenFileNodes` iterative and order-preserving (explicit LIFO stack,
  children pushed in reverse); never recursion or array spreading.
- Let `IFileNode.handle` accept both raw browser capabilities and the canonical
  `FileHandle`/`DirectoryHandle` descriptors, normalized once through
  `@brainstrike/file-system/file-node-handles`: preserve `_internal`, platform,
  canonical I/O path and durable root identity, and inherit a parent root only
  when the child is unstamped. Never disguise a descriptor as a browser
  capability with double casts.
- Bound chunking re-dispatch per service session: a hash-unchanged
  managed-cache row with no `chunks_processed_at` gets a small fixed attempt
  cap, tracked in memory by collection id, durable root/path, file-record id and
  content hash, and reset by a completed stamp, new record or changed content.
  Spend an attempt only at importer handoff, after access, worker startup and
  import QoS succeed. On exhaustion, count the row as scanned-but-unchanged,
  drop only that row, log one terminal diagnostic per exhausted revision, and
  put Workspace Index in its visible `error` state with paths and recovery
  instruction. Never unbounded, never a quiet skip.
- Reconcile the service against the complete mounted-root identity set each
  provider loop, retaining the durable adapter root ID through DB routing and
  terminal-scope reconciliation (including the `rootIdByPath` fallback for a
  legacy handle with no stamped `rootId`). Never project down to path plus a
  nullable DB id.

Truncation is reported, never thrown; the re-dispatch budget is
deliberately non-persistent, so a renderer restart grants a fresh one. Evidence:
`explorer-search-tapestry/secure-root-capabilities.md`,
`explorer-search-tapestry/traversal-policy-and-truncation.md`.
Shared traversal retirement evidence:
`explorer-search-tapestry/2026-10-03-shared-directory-retirement.md`.
Node projection extraction evidence:
`explorer-search-tapestry/2026-10-03-shared-workspace-root-projection.md`.
Discovery preparation evidence:
`explorer-search-tapestry/2026-10-03-discovered-source-preparation.md`.
Borrowed source evidence: `indexer/2026-10-03-borrowed-workspace-source.md`.
Ignore discovery evidence: `explorer-search-tapestry/workspace-index-ignore-discovery.md`.
Guard: `workspace-root-registry{,.integration}.test.ts`,
`packages/secure-fs-native/test/secure-root.test.cjs`,
`parallel-directory-walker.test.ts`, `workspace-collection-sync-service.test.ts`,
`workspace-collection-sync-scan.test.ts`,
`workspace-collection-sync-provider.test.tsx`, `file-node-handles.test.ts`.
Guard: `workspace-root-read-bound.test.ts`, `packages/canonical-ingestion/__tests__/workspace-source.test.ts`, `packages/canonical-ingestion/__tests__/workspace-source-child.integration.test.ts`.
Guard: `packages/file-system/src/__tests__/workspace-scan-ignore.test.ts`.

### Token indexing has TWO trigger sources

Per-file TOKEN counting is separate from the Workspace Index above and is driven
by `useBackgroundTokenIndexerIntegration`.

- Keep exactly two trigger sources — selection (adaptive debounce, the user is
  waiting) and visible/expanded rows (`visibleFiles`) — routed through the same
  `triggerIndexing` → `planTokenIndexingDispatch` path so the binary/size
  exclusions and the in-flight de-duplication are shared. Do not add a third.
- Make the visible trigger cached-first: warm each folder through
  `preloadFolder`, drop keys the hot cache already answers, and memoize a warm
  only once `isPersisted` is true. Why: the worker goes operational before
  PGlite does, so remembering that no-op warm strands every later visible file
  on a full re-count. Reset the parent-owned memo on root change, tree clear and
  `clearIndexedCache`.
- Cap and throttle it — the visible set is every file under an expanded
  directory, not the viewport. Re-arm for the remainder only when the previous
  pass consumed something, so an unconsumable set cannot spin; nothing is
  dropped, only deferred. The visible debounce floor is a strong bias toward
  selection-first, NOT an ordering guarantee. Constants and their arithmetic
  (including the yield count tests must derive) live in
  `packages/file-explorer-ui/src/constants/indexer-constants.ts`.
- Read per-row metadata through `FileRowMetadataStore`, a per-composite-key
  external store: an uncounted file reads `pending`, a permanently retired file
  reads `excluded` with the `exclusionReason` the type requires exactly then.
  Keep that reason set in sync with `planTokenIndexingDispatch` — a new
  permanent retirement without its reason strands those rows on `pending` and
  pins every ancestor rollup to `partial`.
- Mark a directory rollup `complete` only when the subtree is fully enumerated
  AND every descendant's metadata has landed; otherwise emit an explicit
  `partial` reason — `recomputing` only for deferred work actually queued,
  `incomplete-subtree` for unloaded/capped/failed enumeration,
  `pending-metadata` for counts that have not landed. A count landing for one
  key must not re-render any other row.
- Keep `getDirectorySubtree` TOTAL: anything unenumerable answers
  `isComplete: false` with `incompleteReason: 'not-enumerated'`, so a cell can
  never throw mid-render. Call `invalidateAll()` whenever the tree SHAPE changes
  (expand, collapse, filter, refresh, root switch).
- Keep the two invalidation paths split. Pass `useFileRowMetadataStore`'s
  `onTokenResolved` into the indexer integration so each resolved count re-reads
  only its own key plus cached ancestor rollups, and reserve the full
  `invalidateAll` pass for keyless bulk writes, which surface as a
  `cacheVersion` bump and are coalesced behind a trailing debounce with a
  starvation bound. Operational transitions and `FILE_EXPLORER_REFRESH_EVENT`
  reconcile immediately. No third channel, no polling.
- Distinguish capability from readiness when sorting by metadata: a missing
  `FileRowMetadataProvider` warns and resets to loader order, while a mounted
  provider with an empty root id skips that render's sort, emits a one-shot
  diagnostic, and preserves the persisted preference. Production and the 10k-row
  performance test both use `createFileTreeSortMetadataReader`; never copy its
  closure into a test.

Evidence: `explorer-search-tapestry/token-indexing-triggers.md`.
Guard: `file-row-metadata-store.test.ts`,
`file-row-metadata-render-stability.test.tsx`,
`use-file-row-metadata-store.test.tsx`,
`use-background-token-indexer-integration-visible-files.test.tsx`.

---

## WORKSPACE WALK: IGNORE FILES ARE THE PRIMARY SIGNAL, THE POLICY IS THE FLOOR

`walkWorkspaceRoot` (`apps/desktop/src/assistant-server/workspace-file-walk.ts`)
honours the ignore-file chain when the caller passes `respectGitignore`, with
`createBackgroundIndexingEntryPolicy('balanced')` beneath it as a floor. Use ONE
precedence order, lowest first, implemented by `createWorkspaceIgnoreMatcher`
(`packages/utils/src/workspace-ignore-matcher.ts`); do not add a source without
placing it here.

| # | Source | Bypassed by `includeIgnored`? |
| --- | --- | --- |
| 1 | global excludes (`core.excludesFile`) | yes |
| 2 | `.git/info/exclude` | yes |
| 3 | parent `.gitignore` chain (root inside a larger repo) | yes |
| 4 | `.gitignore` (root, then nested — deeper wins) | yes |
| 5 | `.ignore` ("hide from search, keep in git") | yes |
| 6 | `.rgignore` | yes |
| 7 | `.llmignore` (portable agent ignore file) | **NO — HARD** |
| 8 | `.brainstrikeignore` (ours; wins over the portable one) | **NO — HARD** |

- Resolve layer GROUPS globally and nesting within a group: outermost scope
  first inside each group (deeper wins, ripgrep's model), with every bypassable
  scope resolved before any hard one. Why: a scope-major fold makes the agent
  layers bypassable by a nested `.gitignore` negation.
- Compile sources sharing a base into ONE matcher and give a source based
  elsewhere its own scope with a `pathPrefix`; prefix rather than rewrite
  patterns. Evaluate every reachable directory component plus the leaf through
  those scoped parsers, take the dependency's direct rule-manager verdict rather
  than public `test()` (which returns an ignored parent's cached result for
  descendants), and memoize those verdicts per immutable compiled matcher.
- Resolve `.git/info/exclude` through `git rev-parse --git-path`. Why: in a
  linked worktree or submodule `.git` is a FILE, so the naive path vanishes.
- Read `core.excludesFile` with `cwd` at the workspace root, memoised per root.
  Why: without `cwd`, `git config --get` merges the local config of whatever
  directory Electron main was launched from.
- Ask the matcher FIRST and ALWAYS; `includeIgnored` short-circuits only the
  static policy floor beneath it, never layers 7-8.
- Keep the agent layers outside `respectGitignore` too: that flag controls which
  BYPASSABLE layers are COLLECTED, while the matcher is always constructed and
  the agent files always read. `walkWorkspaceRoot` is exported, so a caller
  omitting the flag must not inherit a walk with no hard boundary.
- Evaluate the verdict on the file that gets READ, not the path requested:
  `resolveWorkspaceAbsolutePath` returns the realpath'd target and the
  normalized request as separate fields, every read path checks both, and the
  walk checks a symlink's canonical target before recording it.
- Inherit the agent layers from parent directories up to the enclosing
  repository root, in the walk AND in `createAgentIgnoreGuard`, through the
  shared `apps/desktop/src/assistant-server/repository-root.ts`. Repo-root
  discovery is unconditional; the `git config` subprocesses stay gated on
  `respectGitignore`.
- Keep NO process-wide guard cache; batch callers share one guard per operation,
  bounding staleness to a single tool call. Why: tightening is what the user is
  doing, so a rule written after the first query must take effect.
- Fail CLOSED on an unreadable agent ignore file, in the WALK as well as the
  guard. Only absence is quiet — `isAbsentErrorCode` and the guard's `isAbsent`
  accept ENOENT, ENOTDIR and EISDIR; every other code throws.
- Concatenate layers in precedence order into ONE `ignore` instance per group
  and let the parser decide; never fold verdicts across layers by hand.
- Test DIRECTORIES with a trailing slash — `dist/` does not match the bare path
  `dist` — so the matcher exposes `ignoresDirectory`, `ignoresFile` and
  `ignoresHard` as separate methods.
- Scope nested `.gitignore` files to their own subtree, pushed on entry and
  popped on exit, outermost-first so a deeper file can re-include; reuse the
  directory listing the walk already has for the presence check.
- Keep the catalog `ignore` package as the implementation and pin its behaviour
  in `workspace-ignore-matcher.test.ts`. Why: gitignore reimplementations
  disagree on edge cases, so assert rather than assume.
- Keep LIVE GREP out of the gitignore chain: root-wide rg uses `--no-ignore --hidden`;
  the balanced policy and hard agent layers trim every engine identically.
  For exact `filePaths`, resolve only those files (including the excluded-path probe),
  without a root candidate scan; report `js-files` and retain truthful cap flags.

Gitignore leads because a hand-maintained denylist falls behind
silently; the static floor stays because a non-repo root has no `.gitignore`;
layers 7-8 are a hard boundary and directories are tested with a trailing
slash. See ADR-0016. Evidence:
`explorer-search-tapestry/ignore-chain-precedence.md`, `explorer-search-tapestry/scoped-live-grep.md`.
Guard: `packages/utils/src/__tests__/workspace-ignore-matcher.test.ts`, `live-grep-scoped.integration.test.ts`.

### A ZERO-MATCH GLOB STEERS TO `includeIgnored` — BUT ONLY WHEN THAT WOULD HELP

A bare `{count: 0}` is indistinguishable from "those files do not exist", the
silent failure this walk exists to remove, so the walk reports what it excluded
(`onExcluded`) and the tool emits a `hint` naming `includeIgnored`. Three rules,
each load-bearing, each with a test:

- Partial-match a pruned DIRECTORY (reported instead of its contents, so it is
  only a prefix) and full-match a FILE; `onExcluded` carries `isDirectory` for
  this. Partial for both fires the steer whenever any file was excluded.
- Never steer for the HARD agent layers (`matcher.ignoresHard`) or `.git`: the
  advice is a dead end, and reporting the path would disclose that something
  exists where the user asked for nothing to be visible.
- Never steer when the caller already passed `includeIgnored`, or when
  `scanLimited` — whose honest answer is "the walk did not finish".

The pre-existing "nothing matches" case still asserts `hint` is
undefined, which is the evidence that the steer is precise rather than firing on
every empty result. Evidence:
`explorer-search-tapestry/zero-match-glob-steer.md`.

### THE HARD BOUNDARY BINDS ON EVERY READ PATH

`createAgentIgnoreGuard`
(`apps/desktop/src/assistant-server/agent-ignore-guard.ts`) makes the hard
layers queryable by arbitrary path, because ripgrep returns a flat path list
with no directory context and cannot use the walk's push/pop matcher.

| Read path | Enforced at |
| --- | --- |
| `globWorkspace` / walk | `walkWorkspaceRoot` matcher (layers 1-8) |
| live grep — ripgrep engine | `dropAgentIgnored`, where both engines converge |
| live grep — JS-walk engine | same call site, so parity cannot drift |
| excluded-path steering probe | its bounded eligible slice, before any read |
| `readWorkspaceFile` (paged) | inside the stable-path lock |
| `readWorkspaceTextFile` (LSP inspect, rename reindex, workspace-context, `@file`) | the shared reader, so consumers inherit it |

- Filter all grep engines at ONE call site. Why: enforcing inside each
  collector makes the boundary's strength depend on whether `rg` is installed.
- THROW on a refused read and name the ignore files; never return empty content,
  which teaches the model the file is empty and it reports that as fact.
- Keep the guard hard-layers-only: applying layers 1-6 there would silently make
  `includeIgnored` useless on every path that consults it.
- File MUTATION tools deliberately do not consult the guard yet, so an agent can
  still write to an agent-ignored path.

`.llmignore` is enforced JS-side for both grep engines even though
`.gitignore` deliberately is not, because there is no second implementation to
diverge from. See ADR-0016. Evidence:
`explorer-search-tapestry/agent-ignore-read-paths.md`.

## EXPLORER TREE LIVE REFRESH

One pipeline keeps the visible tree, forest roots, and the background indexer in
sync with on-disk changes. Do not add a second event channel or a polling
fallback.

- Gate watch sources on capability, never on a platform check: a missing
  capability means "visibly unwatched". Desktop runs a MAIN-process recursive
  watcher over `fs:watch`/`fs:unwatch` plus one-way `fs:watch-event` pushes; web
  uses `FileSystemObserver` and warns with a no-op disposer when it is absent.
- Keep **@parcel/watcher the only engine on every platform**, with an explicit
  per-OS backend in `packages/file-system/src/adapters/parcel-backend.ts`. An
  unsupported platform or binding throws a typed error; it never falls back.
- Run one native subscription per `(owner, resolved root)`. Duplicate
  registrations get distinct logical watchIds sharing it; a stale disposer
  removes only its own ID.
- Silence only NESTED excluded trees: check the background-indexing excluded
  prefixes ROOT-RELATIVELY via `isExcludedBackgroundIndexingPath`, so a root
  opened inside an excluded tree still watches normally. The consequence — a
  nested worktree subtree stays VISIBLE but is not live-refreshed — is
  deliberate; do not "fix" that staleness back into a watch.
- Keep the MAIN-owned Explorer `fs:watch` closure the sole caller of
  `reportDefaultFilteredChanges: true`; it is never renderer or wire input. It
  retains `.git`, `node_modules`, `.pnpm-store`, `.next` and `.turbo` natively,
  so a force-tracked file inside one needs its own bounded Git-aware watcher,
  not polling or a broader subscription.
- Deliver only the bounded reportable defaults to the JS classifier, matched
  relative to the WATCHED root. Retain a bounded number of deduped boundaries
  per batch, flag excess as `filteredChangeBoundariesOverflow`, refresh only
  registrations intersecting retained boundaries, and let overflow fail open
  within that durable root only.
- Treat Explorer `excludeFilters` as display projection, not watcher input, and
  keep `.git` natively ignored here. The per-subscription `ignorePatterns`
  override (`docs/agents/platform-contracts.md`) is for main-owned callers
  outside this pipeline and is mutually exclusive with coarse reporting,
  including an explicit `[]`.
- Push typed watcher health (`starting|healthy|degraded|failed|stopped`) on
  one-way `fs:watch-health` scoped to the owning WebContents, with no root path
  on the wire. `fs:watch-retry` is MANUAL-only, throttled and single-flight per
  watchId; terminal failures are rejected by the retry API and render no action.
- Own watchers by the requesting `WebContents` (push to owner only, non-owner
  unwatch rejected). Keep the post-resolution lookup, cap check and insert one
  synchronous section so concurrent starts cannot race past
  `MAX_FS_WATCHERS_PER_OWNER`; `MAX_FS_WATCH_REGISTRATIONS_PER_OWNER` bounds
  retained logical watchIds.
- Attach the owner reaper BEFORE any async setup, covering `destroyed`,
  `render-process-gone` and `did-navigate`, and remove all three listeners when
  any one fires. Why: `did-navigate` leaves the WebContents alive, so otherwise
  they pile up across reloads.
- On the RENDERER side funnel every `watchDirectory` through ONE shared
  `onWatchEvent` subscription fanning out by `watchId`, and install the shared
  health subscription BEFORE invoking `fs:watch`, replaying retained transitions
  once the response maps the id to its root.
- Shape events in `use-file-system-context.ts`: debounce watcher dispatches
  (trailing window plus max-wait) into ONE `FILE_EXPLORER_REFRESH_EVENT` with
  `source:'watcher'`, `scope:'incremental'` and per-root `FileSystemChange[]`.
  Boundary overflow never changes `scope` to `full`.
- Carry watcher HEALTH out-of-band on `FileSystemWatchSignal`
  (`packages/types/src/file-system.ts`), the optional third argument to
  `watchDirectory`, with two conditions:
  - `overflow` — events may have been MISSED. Drop that root's pending
    incremental changes and dispatch a one-shot `scope:'full'` /
    `source:'watcher'` event naming only that root, deduped per root within the
    debounce window.
  - `errored` — the watch is dead. Disconnect, warn-log and signal; the context
    handler error-logs and raises a destructive toast. The root stays connected
    but UNWATCHED with NO auto-restart; manual Refresh is the recovery path.

  Warn-log both conditions in the adapter even with no signal handler attached.
- Drive recovery from a BULK MAIN-PROCESS MUTATION explicitly, since `errored`
  means the watcher cannot report the burst that killed it. Reuse the existing
  refresh pipeline — one `scope:'full'` event naming every connected root — then
  retry ONLY roots whose health is `failed`, never `degraded`. Dispatch the
  refresh BEFORE the retries and do not await it
  (`packages/app-shell/src/changes/use-rewind-explorer-recovery.ts`). Any future
  main-process bulk mutation outside the write tools needs the same treatment.
- Consumers are exactly three, and no more.
  1. The background indexer does path-scoped DB re-index (mtime+hash skip).
  2. `use-file-tree-refresh-events.ts`, mounted by EVERY `FileTreeProvider`:
     incremental re-enumerates only LOADED parent directories of added/removed
     changes; root-level membership goes through `refreshTree`, AWAITED before
     per-directory refreshes; `modified` never touches the tree; roots match
     durable-id-first, path only when the provider has no RootId; watcher/full
     is NOT gated by `skipManualFullEvents`.
  3. `use-workspace-open-file-refresh.ts`, mounted once by
     `WorkspaceTabsProvider`: durable `folderId === rootId` wins, path matching
     is legacy-only, same relative paths in different roots never cross-refresh,
     manual/full's `roots:[]` is an all-open-tabs broadcast, and malformed
     persisted keys are warn-logged by count without echoing root or path.
- Own the content loader's generation/active-read authority ONCE in
  `FileExplorerProvider` and share it with every `useSharedFileContentLoading`.
  Why: those hooks commit into the same store and cache, so hook-local authority
  is invalid. Construct the LRU once per Zustand store, never at module scope.
- Partition refresh keys before the first await — ready keys in one batch,
  dependent keys grouped by their preceding promise, each group filtering
  superseded generations — so one slow read cannot blank or starve unrelated
  tabs. Submit every group through the ONE provider-owned scheduler
  (`shell/file-explorer-provider.tsx`), bounded by
  `MAX_CONCURRENT_FILE_CONTENT_BATCHES`. That is a concurrency bound, not a
  liveness timeout.
- Take the scheduling class from the CALLER'S logical intent, never the physical
  key count after dedupe: tab open and explicit Retry pass `interactive`;
  preview/report loads and canonical refresh reloads pass `background` (the
  scheduler's `bulk` priority). `MAX_INTERACTIVE_BATCHES_BEFORE_BULK` keeps bulk
  work from starving, active work is never preempted, and promoting a queued key
  extracts only that key into an interactive tail ticket — the file is read once.
- Do not invent an elapsed-time cutoff for a hung content read.
  `FileContentWorker` takes an optional `AbortSignal`, but the shared loader
  passes no controller: a safe bound needs an explicit cancellation owner and an
  adapter cancellation contract first.
- Keep the provider-owned error map a live projection, not an error history: a
  key is retained only while its read is active or an explicit consumer owns it.
  Settle every physical group before the public request rejects; a later success
  cannot erase an earlier sibling's failure. `WorkspaceBody` renders
  `FileContentErrorScreen` (an accessible terminal `alert`) for the active tab's
  key instead of an indefinite spinner, showing the path plus a bounded safe
  category, never a raw internal message; its Retry clears only that key.
- Gate absolute handleless reads ONLY through
  `readFileByAbsolutePath(absolutePath, rootPath, rootId)`; on desktop it uses
  the distinct `fs:readFileByAbsolutePath` channel carrying all three, and main
  exact-maps RootId before authorizing the claimed path against that SAME live
  mount. `rootFolderId` is selection/cache identity and is NEVER durable read
  authority. Reject relative paths with empty, control, `.` or `..` segments,
  and accept an absolute path only when the selected root contains it.
- Canonicalize a worker `status:'inaccessible'` result through
  `buildInaccessibleContent` while preserving the exact `BINARY_CONTENT_MESSAGE`
  sentinel, so binary files still route to `BinaryFilePreview`.
- Skip an identical re-enumeration in the worker: `BFSEngine.setTree` reports
  whether it replaced anything and skips the path-index and expansion rebuild,
  and `file-tree.worker.ts` then skips the `tree initialized` log and the
  `treeSnapshot` post. **Node count is never the test.** Identity is the init
  folder id plus an order-sensitive deep compare of EVERY `WorkerFileNode` field
  (`TREE_IDENTITY_FIELDS` is a TOTAL record, so a new field fails the build),
  and the skip also requires `expandedPaths` to equal
  `collectExpandedPaths(tree)`. Anything short of that certainty replaces.
- Dispatch the manual full event only on SUCCESS: `handleRefresh` awaits
  `refreshFileExplorer()` on the OUTER provider, which sets
  `skipManualFullEvents` so it ignores the event it caused while every nested
  forest RootSection provider reacts.
- Let selection follow authoritative directory replacement. The file-explorer
  store stays the selection source of truth; filtered rows and the virtualized
  tree never rewrite it. Reconcile complete snapshots through the durable root
  id, removing selected files absent from a refreshed directory and descendants
  beneath a removed child directory. A snapshot containing a
  `loadMore`/`truncated` pseudo-row is non-authoritative and cannot disprove
  selection. Query-backed selection stays in query mode. Ordinary expand,
  restoration and expand-all enumeration never trigger reconciliation.
- Bound that work: refresh authoritative directories parent-depth-first through
  a work-conserving pool of same-depth reads, publish the batch in one store
  update bound to the root identity that started it, and run direct refreshes
  and refresh events through one lossless queue per provider. Incremental events
  are FIFO mutation boundaries that always break full-request coalescing.
  Discard a stale snapshot set entirely if the provider's root-scoped
  effective-projection revision changes before publication.
- Carry the provider effect's lifecycle epoch on every queued job, so retirement
  stops new I/O and an in-flight job discards its snapshots after the next
  await; a retired direct caller receives `{status:'cancelled'}`. Decode
  selection keys through the canonical strict codec — missing separators and
  empty components throw rather than becoming ghost selections — and salvage
  persisted keys through the validator before a strict merge. Selection is
  files-only: a directory hit at a selected path is a stale retype and removes
  that selection.
- Keep the Explorer toolbar's container-query geometry in
  `shell/file-explorer-toolbar.tsx` and `shell/explorer-columns-context.ts`,
  which carry the measured track arithmetic: every toolbar action has exactly
  ONE home at every width, and no new breakpoint is introduced. The Columns
  popover appears at the same width below which the grid suppresses its metadata
  columns (`METADATA_COLUMNS_MIN_WIDTH`) — tied on purpose, so the grid never
  shows a column the user has no way to hide.
- Never width-gate the cancel affordance. The scanning indicator's Cancel (X) is
  the ONLY way to abort a running expand-all sweep, so `treeActionsControl`
  renders OUTSIDE the container-query wrapper. Only ONE cancel node may exist in
  the DOM — a second narrow-width copy trips Playwright strict mode even while
  `display:none` — so adapt by collapsing the indicator, never by duplicating
  the button; the compact-actions menu yields its slot for the operation
  (`resolveCompactToolbarActionsState` → `yielded-to-cancel`).

These surfaces are read-only with no in-app dirty buffer, so a conflict
state here would be false architecture; the duplicate-provider double init is a
separate defect the identity skip does not address. Evidence:
`explorer-search-tapestry/watcher-pipeline.md`,
`explorer-search-tapestry/refresh-consumers-and-content-loader.md`,
`explorer-search-tapestry/tree-identity-skip.md`,
`explorer-search-tapestry/selection-reconciliation.md`,
`explorer-search-tapestry/toolbar-geometry.md` (which also carries this
section's full paired-test list).
Guard: `bfs-engine.test.ts`, `file-tree.worker.test.ts`,
`use-file-tree-refresh-events.test.tsx`, `use-file-system-context.test.ts`,
`web-adapter.test.ts`, `file-system-watch-ipc.test.ts`, `adapters.test.ts`,
`use-rewind-explorer-recovery.test.tsx`, `workspace-tabs-refresh.test.tsx`,
`use-shared-file-content-reload.test.tsx`,
`file-content-direct-read-path.test.ts`,
`file-selection-reconciliation.test.ts`, `file-explorer-toolbar.test.tsx`,
`apps/desktop/e2e/file-explorer-selection.desktop.test.ts`.
