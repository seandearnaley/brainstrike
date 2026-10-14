# Watcher, invalidation, and refresh batching — evidence

Supports `docs/agents/changeset-diff.md` § "REFRESH SEAMS".
Read before changing the git-metadata watcher, the `changes:invalidated` channel, boundary reporting, nonce vocabularies, or the refresh batch windows.

The lines below are the pre-distillation contract text, extracted verbatim.

**Git-metadata watcher** (`git-inventory-watcher.ts`): one filesystem
subscription per repository **common dir** (covers every linked worktree's
git metadata), opened via a **private** `ElectronFileSystemAdapter`
instance in `main.ts` — deliberately never the shared `fs:watch` IPC
pipeline (`ipc-domains/file-system-watch-ipc.ts`), because that pipeline
dedupes native subscriptions on `(ownerId, resolvedPath)` only, without
the ignore-pattern set in the key; routing this module's `ignorePatterns:
[]` (needed since `.git` is globally ignored by default) through the
shared pipeline could let an unrelated registration for the same path
silently share this filter set. Interesting-path filtering
(`isInterestingGitMetadataPath`) matches `HEAD`/`ORIG_HEAD`/`index`/
`packed-refs`/`refs/**` and `worktrees/<name>/...` lifecycle paths, never
`objects/**` or `*.lock`. A TRUE trailing debounce
(`GIT_INVENTORY_WATCH_BATCH_MS = 300`) re-arms on every interesting event,
capped by `GIT_INVENTORY_WATCH_MAX_BATCH_MS = 2000` so sustained churn
(long rebase/gc) still forces a fire. An interesting event marks the
service snapshot dirty; the next `getSnapshot()` call rebuilds. No
max-worktree/max-repository count cap exists anywhere in the inventory
pipeline — the only bounds are the discovery walk's depth (6) and
concurrency (32).

**Push-to-renderer invalidation channel (`changes:invalidated`, BST-1161 —
spec §6 completion).** Each git-metadata watcher invalidation now ALSO
broadcasts one `ChangesInvalidationEvent` (`{ generation, gitCommonDir,
repositoryRoot }`, `packages/types/src/changeset.ts`) to every live window,
via `GitInventoryServiceDeps.onInvalidate` (the service resolves
`repositoryRoot` from its cached snapshot's identity map and stays
Electron-free; main.ts owns the `BrowserWindow.getAllWindows()` send and
the monotonic `generation` counter — wiring pinned by
`scripts/__tests__/git-inventory-main-wiring-contract.test.mjs`). Renderer
side: `use-changes-live-refresh.ts` holds ONE refcounted live-refresh owner:
one `bridge.onInvalidated` subscription plus one listener on the canonical
renderer `FILE_EXPLORER_REFRESH_EVENT` (BST-1180 — no new IPC/channel and no
polling). Every mounted `git-scope` `useChangeset` registers its
`{ rootId, repositoryRoot, worktreePath }`. An incremental explorer event
maps only registrations in the named durable root whose worktree intersects a
reported changed path (descendant content OR an ancestor that can replace the
worktree). `rootId` is authoritative over path presentation: watcher paths are
re-rooted to the user-facing handle while inventory worktrees can be realpath'd,
so if the named root and registered worktree have no lexical containment in
either direction, the mapper FAILS OPEN to that registration rather than
silently missing it. Comparable paths still filter nested sibling repositories
precisely. Renderer normalization preserves Windows drive roots (`C:\\` →
`C:/`). A root-scoped full event maps every registration in that root, and the
canonical manual-full empty-roots broadcast maps all mounted registrations. A
`Set` dedupes multiple worktrees/scopes of one repository. Unregistered /
snapshot changesets are never guessed into the result.

The watcher source preserves a bounded subset of default-filtered activity
(BST-1180 review) only for the concrete MAIN-owned Explorer `fs:watch`
subscription, which explicitly sets `reportDefaultFilteredChanges:true`; the
option is not renderer/wire input. Generic Parcel/Electron watchers remain
default-false and retain every `DEFAULT_IGNORE_PATTERNS` entry natively, so
Notes Vault keeps its prior callback/load behavior. The Explorer opt-in keeps
`.git`, `node_modules`, `.pnpm-store`, `.next`, `.turbo`, plus hard
`.claude/worktrees` and `.brainstrike/worktrees` native-suppressed. Recursively broadening those
high-cardinality dependency/cache trees can exhaust native watcher resources;
lossless support for a force-tracked file inside one requires a separate,
bounded Git-aware tracked-path watcher architecture. This pipeline does not
poll or silently claim freshness for that unsupported case.

For the reportable `dist`, `build`, and `.DS_Store` defaults, the JS guard
matches only segments in the event path RELATIVE to the watched root (an
ancestor named `build`/`node_modules` never filters the whole root), withholds
the detailed record from Explorer/indexing, and emits the first matched
root-relative boundary. Each 150ms producer batch dedupes at most 64 distinct
boundaries; the 300ms/1s renderer aggregate reapplies the same cap. More
boundaries set explicit `filteredChangeBoundariesOverflow:true` rather than
growing memory or silently dropping evidence. Changes maps retained boundaries
only to intersecting mounted Git registrations in the named durable root;
explicit boundary overflow fails open to every registration in that root. A
detailed path and boundary affecting the same repo still enqueue one repository
refresh, and the existing trailing/max-wait store coalesces nearby metadata
evidence without discarding mutation counts. Boundary metadata is not watcher
record loss and cannot trigger a tree/index full scan. Per-batch work remains
one Git view refresh per affected repository, not one refresh per raw file.
Custom Explorer exclude filters are display-only and therefore keep their
normal detailed path. The hard/native exclusions intentionally produce neither
signal.
The opt-in rejects every explicit `ignorePatterns` override (including `[]`),
so git inventory's existing `ignorePatterns: []` subscription stays marker-free
and no ambiguous configuration silently changes ownership.

Path work is bounded before scanning a watcher batch: registration paths are
normalized once at registration, event root paths once per root, and detailed
change/boundary paths lazily once then cached for equivalent consumers.
Registrations with the
same normalized `(rootId, worktreePath, repositoryRoot)` are grouped, so the
Changes surface and Git panel do not rescan thousands of changes twice. Once a
repository root is affected, later worktree groups for that same raw key are
skipped. Equivalent raw repository strings are still all published so selector
keys never lose evidence.

Both sources feed `changes-live-refresh-store.ts` (wire-generation guard drops
stale/duplicate bridge deliveries; the store is registered in factory reset).
`useChangeset` re-resolves a `git-scope` changeset only on ITS OWN repository's
nonce (`selectGitScopeRefreshNonce`; a git-metadata event the service could not
map still counts for every repo, conservatively). A working-tree event bumps
ONLY mapped repository-view nonces — never `anyInvalidationNonce` — so
`useGitInventory` continues to refetch only on accepted git-metadata events. A
deferred instance remains unloaded until its existing explicit load gate has
been crossed, and an inactive instance suppresses those effect-driven refetches
even after an earlier load; reactivation performs a fresh inventory read.

Repository view evidence admitted by the canonical pipeline (including the
default-filter marker above) is LOSSLESS and split by identity vocabulary:
`metadataNonceByRepositoryRoot` contains only wire keys, while
`workingTreeNonceByRepositoryRoot` contains renderer registration keys;
`selectGitScopeRefreshNonce` combines them. A local `/presentation/repo` event
therefore cannot mark that string metadata-known and mask a later canonical
`/real/repo` wire event — the existing unknown-key conservative guard remains
intact. Alias strings may cause an extra refresh; without an operation id that
is the only defensible choice, and evidence is never suppressed on time alone.
When a wire string first becomes metadata-known, its stored baseline is
`anyInvalidationNonce - unmappedInvalidationNonce`: the known selector adds the
unmapped count back, preserving the prior unknown value until the queued mapped
evidence publishes exactly once.

For the same repository string, both sources enter ONE 300ms trailing batch
(`REPOSITORY_REFRESH_BATCH_MS`). Every signal increments its source count, but
the store publishes them in one state update after the latest signal, so
file → git → file produces one final
notification carrying all three increments rather than discarding either file
event. `anyInvalidationNonce` still advances immediately for every accepted
metadata event, independently refreshing inventory. A 1000ms max wait
(`REPOSITORY_REFRESH_MAX_WAIT_MS`) flushes continuous churn instead of allowing
trailing re-arms to starve the view. The pending map deletes on flush and
factory reset clears every timer, so temporal batch state is bounded. Snapshot
changesets (`agent-run`/`run-range`) never read these nonces.

This batching deliberately delays the repository VIEW nonce by 300ms after the
latest signal (up to the 1s starvation bound), while a metadata event advances
the inventory nonce immediately. With the Explorer producer's own 300ms/1s
window, an external commit can take roughly 2s in the sustained-churn case to
reach the diff view, and inventory may briefly lead it. That ordering is the
cost of losslessly coalescing cross-source evidence, not a guarantee that both
surfaces publish atomically.

Paired renderer tests:
`packages/app-shell/src/changes/__tests__/use-changes-live-refresh.test.ts`,
`changes-live-refresh-store.test.ts`, `use-changeset.test.ts`, and
`use-git-inventory.test.ts`.

**Discovery refresh on root registration (BST-1397).** The inventory only arms
per-repository watchers INSIDE a build, and builds only run on `getSnapshot()`
(the eager app-ready call plus renderer `changes:inventory` IPC calls), while
`loadRoots()` reads the DB `roots` table — so a root whose row lands after
app-ready would otherwise never be discovered. The renderer's roots
reconciliation (`packages/app-shell/src/roots/use-roots-reconciliation.ts`)
therefore calls `changes.inventory({ maxAgeMs: 0 })` once after the boot
reconcile registers at least one root, and once after each mid-session
`registerRoot`, so roots added after app-ready get their git-metadata watcher
without a Changes surface ever being opened (this is what keeps the composer
workspace bar's Branch chip live — see `docs/agents/workspace-context.md`).
It is not only "Add Folder" and Recents that hit this path: mounting a
BrainStrike-managed worktree through the composer bar's Mode chip
(BST-1390 — "New worktree…" / "Use existing worktree…") also mounts by
calling `addRootDirectoryByPath`, which runs the exact same mid-session
`registerRoot`, so a freshly-created or freshly-selected worktree root's OWN
Branch chip is live immediately rather than needing a reload. The Mode chip's
worktree LIST itself is unrelated to any of this — it reads the
`window.worktrees` bridge, not `window.git` inventory (see the Mode chip
entry in `docs/agents/workspace-context.md`) — so only that root's Branch
chip, not the picker's contents, depends on this refresh.

`maxAgeMs: 0` is load-bearing, not decoration. A plain `inventory()` would be
served the 5s TTL cache, or coalesced onto an in-flight build whose
`loadRoots()` had already run — either way a snapshot that predates the row
just written, and a nudge that arms nothing. Forced means the service
GUARANTEES a build that STARTED AFTER the call: with a build in flight it
awaits that build and then runs exactly ONE more, and every forced call
arriving before that follow-up starts shares it (one extra build for the
batch, never one per caller). A forced follow-up whose service was stopped
while it waited rejects with the typed `GitInventoryStoppedError` rather than
building against a closing DB. The value crosses the IPC boundary validated —
absent, or an integer >= 0; anything else is a visible `ok: false`, never
coerced.

Still best-effort, not authoritative: `resolveChangesBridge()` is null on web
(a real no-op), and BOTH a rejected call and an `ok: false` `GitResult` log a
warning rather than being dropped. The Changes surface's own `inventory()`
remains the authoritative consumer, and this seam adds no polling. Paired
tests: `packages/app-shell/src/__tests__/use-roots-reconciliation.test.tsx`
("git inventory discovery refresh"),
`apps/desktop/src/__tests__/assistant-server/git-inventory-service-lifecycle.test.ts`
("forced refresh guarantees a build that started after the call"), and the
`maxAgeMs` options-bag block in
`apps/desktop/src/__tests__/ipc-domains/changes-ipc-handlers.test.ts`.

The "agent-run changesets refresh on `onRunFinished`" acceptance criterion, by
contrast, is STILL not wired to the real UI today:
`assistant-ui-panel-wrapper.tsx` does call `useChangeset(mainRootId,
null).refresh` from `handleRunFinished`/`handleRunFailed`, but its own
comment states the changeset is "hardcoded null" pending a real selection
UI — the hook's inertness on a `null` changeset (see `use-changeset.ts`'s
doc comment) makes that call a no-op by construction. The Changes
surface's own `useChangeset` instance (holding the real active changeset,
in `changes-surface.tsx`) is a **separate hook instance** with no listener
on run-finished/run-failed at all. Do not assume opening the Changes
surface during or after an agent turn auto-refreshes what it shows.
