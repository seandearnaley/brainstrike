# Changeset Diff: Engine, Trust, IPC, and Renderer Surfaces

> Read before touching git-scope/snapshot diff resolution, the `changes` or
> `worktrees` IPC domains, the git inventory (trust/containment), or the Changes
> surface / git panel Changes+History tabs. Rules here are true now; the record
> behind each is in `changeset-diff/<topic>.md`.

## TYPES (`packages/types/src/changeset.ts`)

- Read that file's doc comments first; they are the domain contract.
- Per-file and view totals are `number | null`: `null` means "cannot report",
  `0` means "computed exactly zero". Exclude a binary file's `null` from a sum
  with `?? 0`; never coerce the entry's own field. Every kind resolved through
  `ChangesetDiffService` computes real totals today.
- `toolAttributed` is ABSENT when no attribution join ran (every `git-scope`
  changeset; the live mid-turn view). Absent means "no badge", never `false`.
- `StructuredFileDiffContent` has three variants — `binary`, `full`,
  `hunks-only` — and `hunks-only` carries a four-value `reason`. A `full`
  payload with empty `hunks` is consistent: `full` promises both sides' text,
  not computed hunk ranges.

Settled: `null` and computed `0` stay different facts. Evidence:
`changeset-diff/types-and-totals.md`.

## SERVICES

### Diff engine — `apps/desktop/src/assistant-server/git-structured-diff.ts` (+ `git-structured-diff-refs.ts`)

- `createStructuredDiffOps` imports no Electron; every git failure resolves to
  `{ ok: false, error }` and nothing throws across the IPC boundary.
- Address paths with the CWD-relative `:./<path>` magic pathspec plus
  `--relative`. The file's PATH SPACE doc comment holds the per-mode table.
- `unstaged`'s old side is the INDEX (`:0:./<path>`), never HEAD, so the
  per-file diff matches the index-vs-worktree listing it came from.
- Size-PROBE each side (`cat-file -s`) before reading it.
- Classify `hunks-only` through `resolveOverCapReason`/`classifyOverCapReason`,
  and check binary FIRST by null byte on an actually-read side.
- A `maxBuffer` overflow on a blob READ is a hard failure; on the DIFF
  invocation it degrades to `hunks-only`.
- Scope rename-finding numstat to `-- .`, never `-- <path>`. Why: pathspec
  limiting precedes rename pairing. Feed the matched `oldPath` to the old-side
  blob spec and the unified-diff pathspecs.
- Validate refs (`validateCommitId`/`validateBaseRef`). `commit` mode resolves a
  root commit to the empty-tree object id and a merge commit to its FIRST parent.

Settled: `unstaged` is index-vs-worktree. Evidence:
`changeset-diff/diff-engine-modes.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/git-service-structured-diff.test.ts`.

### Changeset resolution — `changeset-git-scope.ts` / `changeset-snapshot-view.ts`, dispatched by `changeset-diff-service.ts`

- Dispatch purely on `changeset.kind`, and give every failure a stable
  machine-readable prefix; `changeset-diff-service.ts`'s top doc comment is the
  authoritative list.
- A TURN IS NOT A RUN: anchor turn identity on the triggering user message
  (`resolveTurnAnchorMessageId`), because approval/suspend resumes mint run rows
  that appear on no snapshot row. Snapshot `turn-start` on a turn's first leg
  and `turn-end` when its last leg reaches a non-resumable terminal, BEFORE the
  terminal `thread_runs` write.
- Resolve a settled turn as turn-start ↔ turn-end oid per root, the live Last
  Turn as turn-start oid ↔ the live work-tree. The live hot path does ZERO
  database reads (`snapshot-turn-registry.ts`).
- Fail the WHOLE view with `changeset-snapshot-capture-failed:` on any
  `FAILED_SNAPSHOT_CAPTURE_OID` sentinel in a resolved pair; never "diff what we
  can". Pre-engine turns are `changeset-snapshot-missing:`.
- Join the edit-checkpoint journal for `toolAttributed` ATTRIBUTION only: it is
  an attribution-only ledger, `before_content` is never populated, and journal
  content is never read for diffs. `revertible` is `true` for every
  snapshot-resolved entry; renames appear as `added` + `deleted` pairs.
- Restore content from snapshots — `changeset-snapshot-view.ts`,
  `rewind-snapshot-engine.ts`, and `checkpoint-snapshot-undo.ts`, which restores
  to TURN START (as the UI copy says), gated on disk sha256 vs the newest
  record's after-state with `force` overriding.
  `assistant-checkpoint:availability` renders an unavailable entry visibly
  disabled with a reason, never a click-time surprise.
- `untracked` is reachable only through the `uncommitted` scope, re-probed per
  path by `isPathUntrackedInScope`. `T` maps to `modified`, `C` to `added`, and
  an unresolved conflict (`U`) is a hard `unmerged-path:` error.
- Keep thread IDs opaque: safe short IDs keep `refs/snapshots/<threadId>`,
  others use `refs/snapshot-identities/v1/<sha256-of-exact-threadId>`, with the
  exact ID in the snapshot commit JSON. Verify the canonical ref binding and the
  existing head owner before appending or pruning a lineage, and refuse on
  malformed or mismatched metadata rather than deleting, reassigning or hiding
  one. Inventory both namespaces in one Git call.
- Run retention from the STARTUP SWEEP (`snapshot-startup-gc.ts`), never
  turn-end: purge dead-thread rows and refs, prune ref-only residue, keep the
  newest `DEFAULT_SNAPSHOT_TURN_RING` brackets per thread, then reclaim objects.
  A missing `mastra_threads` table with surviving rows refuses to classify,
  visibly.

Settled: the BST-1164 journal fold is gone for good; gc stays off the run hot
path. Evidence: `changeset-diff/snapshot-engine-swap.md`.

### Git inventory — `git-inventory-service.ts` / `-discovery.ts` / `-watcher.ts`

- `buildInventorySnapshot` walks for `.git` entries without spawning git,
  dedupes by RESOLVED COMMON DIR before any spawn, then spawns
  `git worktree list --porcelain -z` hook-free per unique repo. It never throws:
  every failure is a visible `errors` entry. `createGitInventoryService` caches
  for `GIT_INVENTORY_SNAPSHOT_TTL_MS` with dirty-flag invalidation and in-flight
  build coalescing.
- The service produces only `provenance: 'scanned'`; the merge happens in
  `worktree-service.ts`'s `list()` via `worktree-adopt.ts` — a scanned worktree
  with a ledger row is `'both'`, a live ledger row missing on disk is
  `'agent-reported'` with `trust: 'unvalidated'`. Nothing downstream may assume
  `'scanned'` is the only value.

Evidence: `changeset-diff/inventory-discovery.md`.

## TRUST RULE + BIDIRECTIONAL VALIDATION

- A worktree INSIDE a workspace root is unconditionally `'validated'` and the
  bidirectional check is not called. That means "inside a user-granted root",
  not "ownership verified".
- Only an `'outside-roots'` worktree gets `resolveWorktreeTrust`: its own `.git`
  is read back and must resolve to the SAME `group.commonDir` as the granting
  repo. A one-way pointer is never sufficient; failure yields `'unvalidated'`
  with a non-null `trustReason`.
- Report an unvalidated entry anyway, and treat a merely-prunable worktree as a
  trust state rather than an inventory error.
- Compute containment and trust on the REALPATH'd path, never the raw
  `summary.path`. Why: an in-root symlink whose real target is outside every
  root must not be auto-validated.
- Fabricated-admin fixtures publish a complete `worktrees` directory by atomic
  rename, including Git's `locked` marker, into a repository asserted to have no
  existing admin directory. Why: a partial entry or an empty parent is exposed
  to Git's own pruning and maintenance. Locking does not grant trust.

Settled: in-root means granted, not verified. Evidence:
`changeset-diff/trust-model.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/git-inventory.integration.test.ts`.

## THE `changes` IPC DOMAIN

- `apps/desktop/src/ipc-domains/changes.contract.ts` is the source of truth for
  seven visible-UI-only invokes (`resolveView`, `fileDiff`, `inventory`, four
  rewind operations) plus the `changes:invalidated` push; registration, preload
  and desktop typing derive from it, and `BridgeMatches` pins the result to
  app-shell's `ChangesBridge`.
- Invokes keep the raw `GitResult` envelope. Contract parsers reject
  structurally malformed IPC before handler entry; `changes-ipc-handlers.ts`
  keeps semantic validation before anything typed reaches `ChangesetDiffService`
  and rejects unknown kinds and extra keys explicitly.
- Resolve renderer capability through `resolveChangesBridge()`: `null` on web,
  `null` plus a logged error for a malformed bridge. No `isElectron()` anywhere.
- `commit`/`range` modes stay on the SEPARATE `git` domain
  (`window.git.structuredFileDiff`), the sole historical-diff path.

Evidence: `changeset-diff/changes-ipc-domain.md`.
Guard: `packages/app-shell/src/changes/__tests__/changes-bridge.test.ts`.

## THE `worktrees` IPC DOMAIN

- `worktrees.contract.ts` defines the twelve-method visible-UI-only domain; all
  twelve are implemented against real `WorktreeService` methods. Structural
  parser failures reject malformed IPC before handler entry; absolute-path and
  service semantics stay in `worktrees-ipc-handlers.ts` and keep raw `GitResult`
  failures, and `worktrees-bridge.ts` rejects an incomplete bridge wholesale.
- `adopt` records an existing on-disk worktree the live inventory already
  reports, refusing an unvalidated, prunable, locked, primary, unreachable or
  already-managed target — never a caller-supplied path outside that inventory.
- `checkoutStatus` is a lazy per-checkout `git status` read kept OUTSIDE the
  mutation mutex, so a read never queues behind a create. Managed-directory
  settings persist through `worktree-settings.ts`, with `null` recomputed as the
  home-relative default on every read.

Evidence: `changeset-diff/worktrees-ipc-domain.md`.

### WORKTREE MAP + ADOPTION

- `WorktreeListEntry` carries `primary`, `repoCommonDir` and `createdAt` so one
  `worktrees.list()` drives both the Mode chip's picker and the Map. A primary
  row is `usable: false` with a stated reason, and PR data joins on
  `repoCommonDir`, not `repositoryRoot`.
- Refuse adoption outside every granted root AND outside the managed directory.
  Why: `resolveUsability` treats "has a ledger row" as authorization, so an
  unreachable row would read `usable: true` while every operation failed.
  `base_ref` is the worktree's HEAD at adoption time.
- Project the collection through `selectWorktreeCollection` — local search,
  filters, primary-first sorting within a repository, a `WORKTREE_PAGE_SIZE`
  bound, page reset on toolbar changes and clamping when results shrink — as
  ephemeral React view preferences, never a new store or DB/IPC query. Keep
  repository sections one vertical scrollport of full-width checkout articles,
  responsive by container width, with accessible names complete where a label
  truncates.
- Unknown/loading status and the primary checkout's Local-only usability are not
  attention signals; status errors, dirty/behind checkouts, failed PR checks and
  unusable non-primary checkouts are. Render "checking…" until a card's status
  resolves, never a clean glyph.
- Mounting is SEPARATE from adoption: adopting writes only the ledger row. A
  live row under the managed directory OR inside a granted root mounts without a
  picker (`isAuthorizedWorktreeMountPath`, backed by the shared
  `isReachableCheckout` predicate so the two rules cannot drift); an
  outside-roots row stays refused. Mount before binding a thread.
- Refresh the Map on LEDGER mutations (`onAdopt`, `onArchive`) only; mount paths
  must NOT call `refresh()`. Why: `addRootDirectoryByPath` resolving does not
  mean the `roots` row exists, so a refresh there races the write and re-reads
  `rootId: null`. `useWorktreeMap` keys its load effect on
  `useOptionalRootIdentity` instead — poll-free, covering any surface's mounts.
- "Open in Terminal" ships on the Map card, the Folder chip's root rows and the
  Mode chip's worktree menu, through the app's OWN Terminal workspace app;
  `worktrees` gains no `openInTerminal` member and no external emulator runs.
  `terminal:create`'s optional `cwd` is realpath'd and separator-anchored
  containment-checked inside the already-validated root (`resolveContainedCwd`).
- Pass BOTH `{ cwd, rootId }` from every surface, and key
  `useTerminalSession`'s freshness gate on that PAIR. Why: `rootId` is the first
  root CONTAINING a checkout, not its own mount, so pinning on it alone opens
  the wrong repository for a nested worktree.
- `terminal-target-store` holds a session-lived standing pin; `TerminalPanel`
  derives `target ?? focused root` during render — never an effect mirror — and
  offers an explicit "Follow focused folder" release.
- Render the terminal item exactly when `entry.rootId !== null` and `Add as
  root` exactly when it is `null`, so the menu always names the next step and
  never shows a disabled action. Web has no `window.terminal`, so the item does
  not exist there. Run-scoped `git worktree lock` stays unsupported.

Settled: mount callbacks never refresh; adopt/archive always do. Evidence:
`changeset-diff/worktree-map-adoption.md`, `changeset-diff/open-in-terminal.md`.
Guard: `packages/app-shell/src/worktree-map/__tests__/worktree-map-model.test.ts`,
`worktree-map-surface.test.tsx`, `use-worktree-map.test.ts`,
`apps/desktop/e2e/worktree-map.desktop.test.ts`.

### SETUP HOOKS / PER-WORKTREE SETUP — granted roots only

- Run repository code only while creating a worktree FROM a repository the user
  opened as a workspace root: `createUnserialized` resolves
  `resolveRepositoryContext(params.rootId)` first and is the sole caller of
  `runSetupSafely`. Inventory-discovered repositories have no path to setup.
- `setupCommand` is tri-state — argv, `null` (falls back to
  `.brainstrike/worktree-setup.sh` when present), `'disabled'`. Explicit argv
  and `'disabled'` bypass repository-script consent because neither executes the
  fallback.
- Disclose repository root, absolute script path and Git common directory
  through `createContext` before the first repository-script execution and block
  the create sheet until the user allows or skips. Persist both decisions in
  `worktree-setup-consent.v1` keyed by Git common directory, cleared on factory
  reset, with main pinning the renderer-supplied identity to its freshly
  resolved common directory before forwarding. Missing, mismatched or denied
  consent fails closed to a visible `skipped` outcome while creation continues.
- `.worktreeinclude` copies gitignored files by root-relative glob, one per
  non-comment line: reject absolute and `..`-escaping patterns before filesystem
  access, `realpath`-check both source matches and write-side target parents,
  copy with `dereference: false`, and skip-and-report an escaping, missing or
  over-budget match individually in `WorktreeSetupOutcome.skippedCopies`.
- `BRAINSTRIKE_PORT` is derived deterministically from the worktree path and is
  NOT probed free — a default, never an allocation.
- Spawn argv-based, never a shell command string, with stdout and stderr
  consumed to completion under bounded retention (overflow marks the outcome
  truncated without killing the process). Settle a timed-out POSIX command only
  once the dedicated process group disappears, bounded by the existing
  post-escalation deadline.
- Keep timeout, spawn, signal and non-zero-exit failures visible but
  non-blocking: the worktree stays usable and the bounded outcome is persisted
  on the ledger row.

Evidence: `changeset-diff/worktree-setup-hooks.md`.

### MANAGED WORKTREE ARCHIVE SNAPSHOTS (BST-1390) — not shadow git

- Archiving captures the full tracked+untracked (non-ignored) state as a commit
  at `refs/brainstrike/worktree-archive/<worktreeId>` in the worktree's OWN
  repository, through a private `GIT_INDEX_FILE` pipeline — not
  `SnapshotService`, which is keyed per root AND per thread while a managed
  worktree outlives its thread. Living in the common dir is what lets the
  snapshot survive `git worktree remove`. Capture on EVERY archive, clean or
  not, and BEFORE acting on the safety verdict.
- Restore picks one explicit add path before `git restore --source=<ref>`:
  `--detach` for a detached row, `-b <branch>` for a missing branch, or a plain
  checkout when an existing branch's tip still equals `<ref>^`. A branch that
  moved since archive is REFUSED with its current and expected tips.
- `archive` refuses a dirty or unpushed worktree unless `force`; the one blocker
  `force` never overrides is an active run in that worktree.
- Ignored files stay outside the snapshot, so `inspectArchive` discloses their
  count, the exact total of top-level paths and a bounded sorted display list.
- Bind the opaque confirmation token to the complete top-level ignored-path set
  plus the worktree's id and canonical path, so it cannot be transferred to
  another worktree with the same ignored names. With a non-zero count `archive`
  requires the current non-empty `confirmIgnoredEntries` token and `force` does
  not bypass it; the Mode chip's field is required (nullable, never optional)
  and pending confirmation binds both selected thread and worktree, so either
  changing clears it. With the managed path already missing, `inspectArchive`
  returns an empty preview with a null token and `archive` skips the gate.
- Re-read porcelain status as `archive`'s FINAL Git operation and reject a
  missing or stale token before removal. The token is a stale-confirmation
  guard, not human approval: churn beneath an already-disclosed top-level
  directory does not invalidate it.

Settled: no run-scoped `git worktree lock` — a lock is globally visible and would
disable every managed worktree in the Changes surface. Nested Git repositories
need separate restorability handling (BST-1625). Evidence:
`changeset-diff/archive-snapshots.md`.

## REFRESH SEAMS

- Open ONE filesystem subscription per repository COMMON DIR through a private
  `ElectronFileSystemAdapter` in `main.ts`, never the shared `fs:watch` IPC
  pipeline. Why: that pipeline dedupes on `(ownerId, resolvedPath)` without the
  ignore-pattern set in the key, so an unrelated registration could silently
  share this module's `ignorePatterns: []`.
- Filter with `isInterestingGitMetadataPath`, debounce with a TRUE trailing
  timer re-armed on every interesting event and capped so sustained churn still
  fires, then mark the snapshot dirty and broadcast one
  `ChangesInvalidationEvent` per invalidation via
  `GitInventoryServiceDeps.onInvalidate`. The service stays Electron-free;
  `main.ts` owns the window send and the monotonic `generation` counter.
- Hold ONE refcounted live-refresh owner in `use-changes-live-refresh.ts`: one
  `bridge.onInvalidated` subscription plus one listener on the canonical
  `FILE_EXPLORER_REFRESH_EVENT`. No new IPC channel, no polling.
- Map an explorer event only to registrations in the named durable root whose
  worktree intersects a reported changed path, FAILING OPEN where root and
  worktree have no lexical containment either way, and never guess unregistered
  or snapshot changesets into the result.
- Keep `reportDefaultFilteredChanges: true` an opt-in of the concrete MAIN-owned
  Explorer subscription, never renderer or wire input, rejecting every explicit
  `ignorePatterns` override (including `[]`) so git inventory's own
  `ignorePatterns: []` subscription stays marker-free. The dependency and cache
  trees stay natively suppressed, and this pipeline neither polls nor claims
  freshness for the unsupported force-tracked case.
- Report a withheld default-filtered change as a root-relative boundary, capped
  per batch with an explicit `filteredChangeBoundariesOverflow` that fails open
  to every registration in that root; it is not record loss and cannot trigger a
  full scan.
- Keep the identity vocabularies split — `metadataNonceByRepositoryRoot` (wire
  keys) and `workingTreeNonceByRepositoryRoot` (renderer registration keys),
  combined by `selectGitScopeRefreshNonce`. Why: a local alias event must not
  mark a string metadata-known and mask a later canonical wire event.
- Coalesce both sources for one repository string into one trailing window with
  a max-wait bound, publishing every source's increments in a single state
  update; `anyInvalidationNonce` still advances immediately for every accepted
  metadata event, and factory reset clears every timer.
- Re-resolve a `git-scope` changeset only on its OWN repository's nonce, so
  `useGitInventory` refetches only on accepted git-metadata events; snapshot
  changesets never read these nonces. Keep a deferred instance unloaded until
  its load gate is crossed, suppress refetches while inactive, and read fresh on
  reactivation.
- Call `changes.inventory({ maxAgeMs: 0 })` once after the boot reconcile
  registers a root and once after each mid-session `registerRoot`. Why: builds
  run only on `getSnapshot()` while `loadRoots()` reads the DB, so a row landing
  after app-ready would never be discovered and the Branch chip would go stale.
- `maxAgeMs: 0` GUARANTEES a build that STARTED AFTER the call, shared by every
  forced caller arriving before that follow-up starts, and rejects with
  `GitInventoryStoppedError` if the service stopped meanwhile. The value crosses
  IPC validated — absent, or an integer >= 0. The seam stays best-effort: null
  bridge on web, and a rejected call or `ok: false` result logs a warning.
- Do NOT assume opening the Changes surface during or after an agent turn
  auto-refreshes it: `assistant-ui-panel-wrapper.tsx` calls `refresh` on a
  hardcoded-`null` changeset, which `use-changeset.ts` makes inert, and the
  surface's own hook instance has no run-finished listener.

Settled: lossless cross-source coalescing costs latency — roughly 2s to the diff
view under sustained churn, with inventory briefly leading. Evidence:
`changeset-diff/live-refresh-seams.md`.
Guard: `packages/app-shell/src/changes/__tests__/use-changes-live-refresh.test.ts`,
`changes-live-refresh-store.test.ts`, `use-changeset.test.ts`,
`use-git-inventory.test.ts`,
`packages/app-shell/src/__tests__/use-roots-reconciliation.test.tsx`,
`apps/desktop/src/__tests__/assistant-server/git-inventory-service-lifecycle.test.ts`,
`scripts/__tests__/git-inventory-main-wiring-contract.test.mjs`.

## RENDERER SURFACES

### Changes surface (`packages/app-shell/src/changes/`)

- A lazy-mounted workspace-panel tab, capability-gated on `window.changes` with
  no `isElectron()`. `ChangesSurface` composes `ChangesetHeader`,
  `ChangedFilesTree` (canonical `TreeTable`) and `ChangesetDiffPane`.
- Resolve a `git-scope` changeset against the workspace root CONTAINING its
  worktree, per `WorktreeDescriptor.containment` — not the surface's focused
  root. Why: the picker offers scopes across every mounted root, and the
  main-process containment check otherwise fails with
  `outside-roots-unsupported:`. Yield `null` when no containing root is found;
  `useChangeset` then stays inert rather than guessing.
- An EMPTY `selectedFileKeys` means "render every file in the changeset", not
  "render nothing"; callers state which they mean through `hasExplicitSelection`.
- Key files with `changedFileKey` on NUL-joined `(rootId, worktreePath, path)`.
  Why: `path` alone collapses across two worktrees of one repo, and
  `worktreePath` is `null` for every snapshot-sourced entry.
- `ChangesetFileDiffCard` is the shared prop-driven diff leaf with its own
  `IntersectionObserver` gating and generation-guarded staleness: `binary` to a
  dedicated card, `full`/`hunks-only` to `DiffView`'s `structured` source
  (`null` counts render as `"—"`, never `"0"`), any error to the real message
  plus a per-card Retry. A single-card host passes BOTH `className` and
  `bodyClassName`; `bodyClassName='h-full'` alone resolves to `auto` against the
  auto-height card root and defeats `DiffView`'s internal scroller.

Evidence: `changeset-diff/changes-surface-selection.md`.
Guard: `packages/app-shell/src/changes/__tests__/changes-store.test.ts`,
`changeset-file-diff-card.test.tsx`.

### Git panel (`packages/app-shell/src/git-panel/`) — converged in W6

- Both tabs resolve diffs through the structured engine and render
  `ChangesetFileDiffCard`.
- The panel's staged/unstaged/untracked list, per-row stage/unstage buttons and
  tri-state stage-all stay PANEL-OWNED, driven off `window.git`'s
  `GitStatus.files`. The panel never imports `changes-store.ts` and never mounts
  `ChangesetDiffPane`.
- Re-pin the changeset to the selected row's own bucket on every selection
  change — staged → `staged`, unstaged → `unstaged`, untracked → `uncommitted`.
  Why: a `git-scope` changeset carries exactly one `GitScope`.
- Mount the History diff card with `key={commitId:path}` so a slow response for
  a prior selection lands on an unmounted component and is dropped.
  `CommitFilesSidebar` keeps `bridge.commitFiles` and its own generation guard.
- `changes-navigation-store` owns the Canvas surface's DOMAIN navigation facts
  (`openCanvasPanel()`, `canvasRefreshNonce` / `requestCanvasRefresh()`, bumped
  on a completed `brainstrike.manageCanvas` edit-activity event) and resets with
  its factory-reset registration. WHICH workspace tab is showing lives in
  `useWorkspaceTabSelectionStore`, whose session-only `mountedAppIds` is the
  keep-mounted contract. Gate capability PER-APP: an unregistered app has no tab
  and no launcher card, and web passes no `canvasPanelContent` — omit, not stub.
- The worktree dropdown publishes a `git-scope` changeset via `openChangeset`
  AND switches the shell route back to `explorer` via
  `usePanelLayoutStore.setActiveTab`. Two stores, two "tab" concepts; both
  writes are required.
- Gate trust in priority order, each disabled state stating its own reason:
  unavailable → inventory error → loading → not found → `unvalidated` →
  `outside-roots` → locked. `unvalidated` precedes `outside-roots` because it
  only ever occurs for an outside-roots worktree and carries the narrower
  reason; `available` is first because a bridge-less build reports
  `inventory: null` with `error: null`, which would read as a permanent
  "Loading…".

Settled: staging composition stays panel-owned — checkbox semantics collide and
`changes-store.ts` is a cross-surface singleton. Evidence:
`changeset-diff/git-panel-convergence.md`.
Guard: `packages/app-shell/src/__tests__/git-panel.test.tsx`,
`git-workbench-header.test.tsx`.

### `DiffView`'s `strings` source

- `packages/ui/src/diff-view/` exports the legacy `{ kind: 'strings', original,
  modified }` source alongside `{ kind: 'structured', diff }`.
- `packages/assistant-ui/src/approval-preview.tsx` is its only remaining
  production consumer. Keep `strings` while it exists, and do not add a new
  `strings` call site to a surface that has a real `StructuredFileDiff`.

## CAPS (summary)

| Cap | Constant | Where |
| --- | --- | --- |
| Per-side full-content inline cap | `STRUCTURED_DIFF_CONTENT_CAP_BYTES` | `git-structured-diff.ts` |
| Bounded output ceiling / hard `execFile` buffer | `GIT_MAX_OUTPUT_BYTES` / `GIT_MAX_BUFFER_BYTES` | `git-service.ts`, shared |
| Inventory walk depth / concurrency | `DEFAULT_WALK_MAX_DEPTH` / `DEFAULT_WALK_MAX_CONCURRENCY` | `git-inventory-discovery.ts` |
| Inventory snapshot cache TTL | `GIT_INVENTORY_SNAPSHOT_TTL_MS` | `git-inventory-service.ts` |
| Watcher debounce / max-batch | `GIT_INVENTORY_WATCH_BATCH_MS` / `GIT_INVENTORY_WATCH_MAX_BATCH_MS` | `git-inventory-watcher.ts` |
| Snapshot turn retention ring | `DEFAULT_SNAPSHOT_TURN_RING` | `snapshot-startup-gc.ts` |
| `.worktreeinclude` copy ceiling | `WORKTREE_INCLUDE_MAX_TOTAL_BYTES` | `worktree-setup.ts` |
| Repository refresh batch / max wait | `REPOSITORY_REFRESH_BATCH_MS` / `REPOSITORY_REFRESH_MAX_WAIT_MS` | `changes-live-refresh-store.ts` |

- Read each value from its constant; this table names where, not what. The
  per-side content cap holds nominal parity with the journal's
  `MAX_WRITE_WORKSPACE_FILE_BYTES` — not byte-identical; the two move together.
- No repository or worktree COUNT cap exists anywhere in the inventory pipeline;
  the only bounds are the walk's depth and concurrency.

## DO-NOT-RELITIGATE RULINGS

- View totals stay `number | null`, never a `0` sentinel.
- `unstaged` per-file diff stays index-vs-worktree.
- The git panel's staging list stays panel-owned, never composed onto
  `ChangedFilesTree`.
- A worktree inside a workspace root stays unconditionally `'validated'`, and an
  unvalidated or prunable one is always reported — any change that filters
  `GitInventory.repositories[].worktrees` before display preserves this.

Evidence: `changeset-diff/settled-rulings.md`.

## CORRECTIONS TO EARLIER PLANNING DOCS (verify before trusting)

`docs/superpowers/specs/2026-08-03-changeset-diff-viewer-design.md` is a
pre-implementation design doc; verify any claim against code first. Divergences
that still hold: `StructuredFileDiffContent` is a 3-variant union whose
`hunks-only` carries a 4-value `reason` (PR #2252's body describes a different
shape); no `ConversationRevertService`, conversation-revert module or
soft-rewind/tombstone implementation exists, so `revertible` is a computed field
rather than a revert operation. All three `WorktreeProvenance` values ARE
produced today (see SERVICES) — the older "never produced" note is superseded.

Evidence: `changeset-diff/planning-doc-corrections.md`.

### Delegated child checkpoint baselines

- Capture a child-scoped turn-start row in the existing workspace snapshot
  ledger at delegated admission, before native execution; its run ID starts null
  and the existing timestamp brackets associate subsequent child host legs.
- Resume does not replace the baseline. Runs without a baseline stay visibly
  unavailable, and capture failures retain the ordinary sentinel.
- Child tool checkpoints carry the child's durable run/thread/resource identity,
  so the shared Revert control resolves that child's snapshot and disk conflict
  gate. Perform no automatic Git merge or commit in the user checkout, and
  neither narrow nor broaden full rewind's preview/acknowledgment semantics.

Evidence: `changeset-diff/delegated-child-baselines.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/delegated-workspace-snapshot.integration.test.ts`.
