# Changeset Diff: Engine, Trust, IPC, and Renderer Surfaces

> Created for BST-1116/BST-1111-1114 (Changeset Diff Viewer + W6 git-panel
> convergence). Read before touching git-scope/snapshot diff resolution, the
> `changes` IPC domain, the git inventory (trust/containment), or the Changes
> surface / git panel Changes+History tabs. Keep this doc and its paired
> tests updated with the code. Design doc (pre-implementation; verify
> against code before trusting a specific claim from it):
> `docs/superpowers/specs/2026-08-03-changeset-diff-viewer-design.md`.

## TYPES (`packages/types/src/changeset.ts`)

The domain contract. Its own doc comments are unusually rich and are the
first source of truth — read them before this section.

- **`Changeset`** — discriminated union: `agent-run` (`runId`/`threadId`,
  shadow-git snapshot engine), `run-range` (`fromRunId`/`toRunId?`/`threadId`,
  aggregate across runs), `git-scope` (`repositoryRoot`/`worktreePath`/
  `scope: GitScope`).
- **`GitScope`** — `branch-vs-base` (`baseRef?`), `commit` (`commitId`),
  `staged`, `uncommitted`, `unstaged`. Each carries only the fields it
  needs.
- **`ChangedFileEntry`** — `additions`/`deletions: number | null` (null =
  binary, never coerced to `0`), `revertible: boolean`, `rootId: string |
  null`, `worktreePath: string | null` (null for every snapshot-sourced
  entry — see Selection semantics under RENDERER SURFACES below).
- **`ChangesetView.totalAdditions`/`totalDeletions: number | null`** — `null`
  means the source cannot report totals at all. Since the W7 snapshot engine
  swap (BST-1164 T2), EVERY changeset kind resolved through
  `ChangesetDiffService` computes REAL totals: `git-scope` from `git diff
  --numstat`, and `agent-run`/`run-range` from the shadow-git snapshot
  diffs' numstat. Binary files' `null` per-file counts are excluded from
  the sum (`?? 0`), not coerced — "every file binary" is a real computed
  `0`. `null` remains in the type for sources that genuinely cannot report
  totals; since T4 deleted the journal fold (`changeset-journal-view.ts`)
  no shipping producer emits `null` totals. `null` (unknown) and `0`
  (computed exactly zero) are deliberately different facts
  (make-invalid-states-unrepresentable).
- **`ChangedFileEntry.toolAttributed?: boolean`** (W7 T2, ADDITIVE) —
  view-level attribution metadata: `true` when the edit-checkpoint
  attribution ledger records an assistant-tool edit touching the path within
  the changeset's range, `false` when the snapshot engine captured a change
  with no tool record (e.g. a shell side effect), ABSENT when no attribution
  join ran (every `git-scope` changeset; the LIVE mid-turn view, which does
  no DB reads). Absent means "no badge", never `false`.
- **`StructuredFileDiffContent`** — three variants, not four (the shipped
  shape; an early PR body described a 4-reason union — see CORRECTIONS
  below): `binary`, `full` (`oldContent`/`newContent: string | null`),
  `hunks-only` (`hunkText`, `hunkTextTruncated`, `reason:
  'diff-overflow' | 'over-cap-both' | 'over-cap-new' | 'over-cap-old'`).
  A `full` payload with empty `hunks` is not a contradiction — `full` only
  promises both sides' complete text, never that hunk ranges were computed
  (binary and `untracked` whole-file adds have empty `hunks` for that
  reason; the journal-sourced no-hunks case died with the journal fold in
  T4 — snapshot diffs are real git diffs and carry hunks).
- **`WorktreeDescriptor`** — `containment: readonly string[] | 'outside-roots'`,
  `provenance: 'agent-reported' | 'both' | 'scanned'`, `trust:
  'unvalidated' | 'validated'`, `trustReason: string | null`. See TRUST RULE
  below — the type's own doc comment states the rule precisely and is worth
  re-reading in place.
- **`StructuredFileDiffParams`** — the per-file diff request: `mode: 'commit'
  | 'range' | 'staged' | 'untracked' | 'unstaged' | 'working'`, each with its
  own doc comment recording why that mode compares what it compares (the
  `unstaged` mode's comment records the BST-1113 review finding — see
  DIFF ENGINE below).

## SERVICES

### Diff engine — `apps/desktop/src/assistant-server/git-structured-diff.ts` (+ `git-structured-diff-refs.ts`)

`createStructuredDiffOps({ cwd, invoke, invokeHookFree })` returns
`structuredFileDiff(params: StructuredFileDiffParams) =>
Promise<GitResult<StructuredFileDiff>>`. No Electron imports; every git
failure resolves to `{ ok: false, error }`, never a throw across the IPC
boundary.

Per-mode git plumbing (all via the CWD-relative `:./<path>` magic pathspec
and `--relative`, not the repo-root-relative default — see the file's own
PATH SPACE doc comment for the empirically-verified reasons):

| mode | old side | new side | numstat target |
| --- | --- | --- | --- |
| `working` | `HEAD:./<path>` | live worktree file | `['HEAD']` |
| `staged` | `HEAD:./<path>` | index, `:0:./<path>` | `['--cached']` |
| `unstaged` | index, `:0:./<path>` | live worktree file | `[]` |
| `untracked` | none | live worktree file (off disk, no git invocation on the happy path) | n/a |
| `commit` | `resolveCommitOldRef` (`<commitId>^`, or the empty-tree object id for a root commit) | `commitId` | two-ref numstat |
| `range` | caller-resolved `baseRef` | literal `'HEAD'` | two-ref numstat |

`unstaged`'s old side is the **index**, not HEAD — added because the
`unstaged` git-scope's own file LISTING (`changeset-git-scope.ts`'s
`listRefComparisonChanges(invoke, [])`) is index-vs-worktree; before this
mode existed, `unstaged` mapped its per-file diff to `working`
(HEAD-vs-worktree), so a file with both staged and unstaged edits reported
contradictory numbers between the list and the rendered diff (BST-1113
review finding). Guarded by
`apps/desktop/src/__tests__/assistant-server/git-service-structured-diff.test.ts`
`'reads the OLD side from the INDEX (:0:./<path>), never HEAD — the
review-fixed bug'`.

**Caps.** `STRUCTURED_DIFF_CONTENT_CAP_BYTES = 2 * 1024 * 1024` (2MB,
per-side full-content cap, nominal parity with the edit-checkpoint
journal's `MAX_WRITE_WORKSPACE_FILE_BYTES = 2_000_000` — NOT byte-identical
today, the two should move together if either is revisited). A side is
size-PROBED (`cat-file -s`) before any read, so an over-cap side's bytes
are never actually read. The shared `boundOutput` ceiling
(`GIT_MAX_OUTPUT_BYTES = 1_000_000`, `git-service.ts`) truncates any
oversized diff/status output at a clean boundary with a visible marker;
`GIT_MAX_BUFFER_BYTES = GIT_MAX_OUTPUT_BYTES * 4` is the hard `execFile`
capture ceiling — a `maxBuffer` overflow on an actual blob READ is a hard
failure, never a truncated success (distinct from an overflow on the DIFF
invocation, which degrades to `hunks-only`).

The four `hunks-only` reasons are decided by two pure functions in
`git-structured-diff.ts`:

```ts
function classifyOverCapReason(oldOverCap, newOverCap) {
  if (oldOverCap && newOverCap) return 'over-cap-both';
  return oldOverCap ? 'over-cap-old' : 'over-cap-new';
}
function resolveOverCapReason(oldOverCap, newOverCap) {
  if (oldOverCap || newOverCap) return classifyOverCapReason(oldOverCap, newOverCap);
  return 'diff-overflow';
}
```

`'diff-overflow'` fires when the unified-diff invocation itself hit
`maxBuffer` while NEITHER side individually exceeded the per-file cap
(many small scattered edits across two large-but-under-cap files);
`'over-cap-*'` fires per which side(s) exceeded the cap. Binary detection
is a null-byte check on an actually-read side (`Buffer.includes(0)`),
checked FIRST and winning whenever either side was read and found
binary — an over-cap side (never read) can never block a confirmed-binary
call from the other side. Guarded by
`git-service-structured-diff.test.ts`'s `describe`s `'structuredFileDiff —
cap boundary'`, `'... a maxBuffer overflow on the diff invocation forces
hunks-only'`, and `'... binary detection via stdoutBuffer null byte'`.

**Rename parity.** `commit`/`range`/`staged`'s numstat runs
`--find-renames` scoped `-- .` (the WHOLE opened root), never `-- <path>` —
gitdiffcore(7)'s pathspec limiting happens BEFORE rename pairing, so a
pathspec naming only the new path could never pair with its old name. The
matching numstat entry's `oldPath` then feeds both the old-side blob spec
and the unified-diff pathspecs. Proven end-to-end for `staged` mode by
`'routes the old-side read through oldPath, not the current path'`
(`git-service-structured-diff.test.ts`); `commit`/`range` share the
identical mechanism via `structuredRefDiff` with no separate rename
codepath to diverge (confirmed by reading `structuredRefDiff`, not
assumed).

`git-structured-diff-refs.ts` adds ref-injection-safety validation
(`validateCommitId`/`validateBaseRef` — non-empty, no whitespace, no `:`,
no leading `-`; `commitId` additionally the full 40–64 hex object-id shape)
and the root-commit empty-tree fallback (`resolveCommitOldRef`, via `git
rev-list --parents`). For a MERGE commit, `commit` mode's `^` is the FIRST
parent (first-parent diff, matching `git-history.ts`'s `commitDiff`
precedent).

### Changeset resolution — `changeset-git-scope.ts` / `changeset-snapshot-view.ts`, dispatched by `changeset-diff-service.ts`

`ChangesetDiffService` (`{ fileDiff, resolveView }`) dispatches purely on
`changeset.kind`: `git-scope` → `changeset-git-scope.ts`; `agent-run` /
`run-range` → `changeset-snapshot-view.ts` (the W7 shadow-git snapshot
engine, BST-1164 T2; the old journal fold `changeset-journal-view.ts` was
DELETED in T4 along with its `journal-content-expired:` /
`journal-path-collision:` prefixes). Every failure carries a stable
machine-readable prefix (`snapshot-engine-unavailable:`,
`changeset-snapshot-missing:`, `changeset-snapshot-capture-failed:`,
`outside-roots-unsupported:`, `base-ref-unresolved:`, `head-unborn:`,
`commit-id-unresolved:`, `unmerged-path:`, `runs-unavailable:`,
`run-anchor-missing:`) so the UI can branch on it — see
`changeset-diff-service.ts`'s top doc comment for the authoritative list.

**`changeset-snapshot-view.ts`** resolves `agent-run`/`run-range` as REF-PAIR
resolvers over the snapshot engine (see `docs/superpowers/plans/`
`2026-08-05-w7-shadow-git-snapshots.md`):

- A TURN IS NOT A RUN. Turn identity is anchored on the TRIGGERING USER
  MESSAGE (`resolveTurnAnchorMessageId` in `snapshot-turn-boundaries.ts`);
  approval/suspend resumes mint additional run rows that appear on no
  snapshot row. `snapshot-turn-boundaries.ts` (consumed by
  `assistant-server.ts` on the run-persistence seam) takes per-root
  `turn-start` snapshots on a turn's FIRST leg and `turn-end` snapshots when
  the turn's LAST leg reaches a terminal that is not a resumable pause —
  BEFORE the terminal `thread_runs` status write (global constraint 5), so
  a settled run always has its turn-end rows.
- SETTLED turns resolve `turn-start oid ↔ turn-end oid` per root from the
  ledger's turn brackets (`snapshot-turn-ledger.ts`); the LIVE Last Turn
  resolves `turn-start oid ↔ the live work-tree`. The live hot path does
  ZERO database reads: the in-memory `snapshot-turn-registry.ts` caches the
  per-root turn-start oids keyed by thread + turn generation (the BST-1169
  starvation rule). A historical mid-turn resume run id falls back to the
  run row's own timestamps (cold path only).
- FAILED captures are durable sentinel ledger rows
  (`FAILED_SNAPSHOT_CAPTURE_OID`, git's all-zero null oid — see
  `snapshot-repository.ts`); any sentinel in a resolved pair fails the WHOLE
  view with `changeset-snapshot-capture-failed:` — never "diff what we can"
  (global constraint 4). Pre-engine turns (no rows) are
  `changeset-snapshot-missing:`.
- The edit-checkpoint journal is joined for per-file ATTRIBUTION metadata
  only (`toolAttributed`), spanning the whole turn via
  `listRunRangeCheckpoints(firstLeg → lastLeg)`; journal CONTENT is never
  read for diffs.
- `revertible` is `true` for every snapshot-resolved entry (the engine can
  restore any captured file; per-chain journal bookkeeping died with the
  fold). Renames appear as `added` + `deleted` pairs (`diffRefs` runs
  `--no-renames`).

**`changeset-git-scope.ts`** maps each `GitScope` kind to a listing command
and a `StructuredFileDiffParams.mode`:

| `GitScope.kind` | listing | per-file `mode` |
| --- | --- | --- |
| `staged` | `git diff --cached --numstat` (+ empty-tree fallback on unborn HEAD) | `staged` |
| `unstaged` | `git diff --numstat` (no ref args) | `unstaged` |
| `uncommitted` | `git diff HEAD --numstat` (empty-tree fallback on unborn HEAD) + `listUntrackedChanges` (`git status --porcelain=v2 --untracked-files=all`) | `working` or `untracked`, re-probed **per path** via `isPathUntrackedInScope` |
| `commit` | two-ref numstat (`<id>^`/empty-tree vs `<id>`) | `commit` |
| `branch-vs-base` | two-ref numstat (resolved `baseRef` vs merge-base) | `range` |

`untracked` is reachable **only** through the `uncommitted` scope — no
other branch of `resolveGitScopeStructuredFileDiffParams` ever returns
`mode: 'untracked'`, because `unstaged`/`staged` numstat has no untracked
listing flag at all (structural guarantee, not merely tested). A
typechange (`T`, e.g. symlink↔file) maps to `'modified'`; `C` maps to
`'added'`; an unresolved merge conflict (`U`) is a hard `unmerged-path:`
error, never surfaced as `'deleted'`.

`totalAdditions`/`totalDeletions` are real, non-null sums
(`total += record.additions ?? 0`) — a binary file's `null` per-file count
is excluded via `?? 0`, never coerced on the entry itself, which is what
produces a real `0` total when every file is binary.

**The journal fold is GONE (BST-1164 T4).** `changeset-journal-view.ts`
and the whole journal-content diff path were deleted with the engine swap:
the edit-checkpoint table (`brainstrike_assistant_edit_checkpoints`) is an
ATTRIBUTION-ONLY ledger now — op, paths, before/after sha256 hashes, sizes,
timestamps, `reverted_at` — and its `before_content` column is never
populated (schema column kept; no destructive migration in v1). Everything
that used to read journal content restores from snapshots instead:

- Changesets: `changeset-snapshot-view.ts` (above).
- Conversation Rewind: `rewind-snapshot-engine.ts` (T3).
- Per-file / per-turn checkpoint undo (`assistant-checkpoint:*` IPC, the
  tool-card Revert button + turn footer): `checkpoint-snapshot-undo.ts`
  (T4) — restores each journaled path to its state at the TURN-START
  snapshot (a DELIBERATE semantic change from "just before this edit";
  the UI copy says "restore to turn start"). Conflict gate: current disk
  sha256 vs the newest journal record's after-state, `force` overrides.
  `assistant-checkpoint:availability` serves per-entry snapshot
  availability so pre-engine / failed-capture entries render visibly
  disabled with a reason — never a click-time surprise, never silent
  removal.

**Snapshot retention / GC** (`snapshot-startup-gc.ts`, run from main.ts's
startup fire-and-forget block after `sweepOrphans`): dead-thread rows +
refs purge (`mastra_threads` is the liveness source; a missing threads
table with surviving rows REFUSES to classify, visibly), ref-only-residue
pruning per shadow repo (`listSnapshotThreadIds`), and the retention ring —
keep the newest 50 turn brackets per thread (`DEFAULT_SNAPSHOT_TURN_RING`),
delete older ledger rows, then reclaim objects via a git shallow cut at the
oldest surviving per-thread chain boundary + `git gc --prune=now`
(`SnapshotService.pruneHistory`). Ring trigger is the STARTUP SWEEP, not
turn-end — gc work stays off the run hot path by ruling.

**No `ConversationRevertService` exists on this branch.** The design spec
scopes a soft-rewind/tombstone revert service (W5) and mentions "rewind" as
a service; searching `apps/` and `packages/` finds no
`ConversationRevertService`, no conversation-revert module, and no
soft-rewind/tombstone implementation anywhere. `revertible` above is the
only piece of that design that ships today — a computed field, not a
revert operation.

### Git inventory — `git-inventory-service.ts` / `-discovery.ts` / `-watcher.ts`

`buildInventorySnapshot(deps, signal)`: resolve workspace roots → walk each
for `.git` entries (`walkForGitEntries`, discovery module, bounded
`maxDepth 6` / `maxConcurrency 32`, never spawns git) → dedupe by
**resolved common dir** (`resolveCommonDir`, before any spawn) → for each
unique repo, spawn `git worktree list --porcelain -z` hook-free
(`invokeGitHookFree`) and classify every worktree's containment + trust.
`createGitInventoryService` wraps this in a `GIT_INVENTORY_SNAPSHOT_TTL_MS
= 5000` cache with dirty-flag invalidation and in-flight build coalescing.
Never throws — every failure mode is a visible `errors` entry.

`provenance` is typed as `'agent-reported' | 'both' | 'scanned'`. Until W3
(BST-1390) only `'scanned'` was ever produced. `GitInventoryService` itself
still produces only `'scanned'` — the MERGE happens one level up, in
`worktree-service.ts`'s `list()`, which joins the inventory with the
`brainstrike_worktrees` ledger: a scanned worktree with a ledger row becomes
`'both'`, and a LIVE ledger row that is not on disk is reported as
`'agent-reported'` with `trust: 'unvalidated'`, `trustReason: 'missing on
disk'` — present, never dropped. Nothing downstream of the inventory may
assume `'scanned'` is the only value it can see.

## TRUST RULE + BIDIRECTIONAL VALIDATION

Decision site, `buildRepository` in `git-inventory-service.ts`:

```ts
const containment = computeContainment(canonicalPath, resolvedRoots);
const { trust, trustReason } =
  containment === 'outside-roots'
    ? await resolveWorktreeTrust(fs, canonicalPath, group.commonDir)
    : { trust: 'validated', trustReason: null };
```

A worktree **inside** a workspace root is unconditionally `'validated'` —
the bidirectional check is never even called. This means "inside a
user-granted root", NOT "ownership verified": a fabricated
`.git/worktrees/<name>/gitdir` pointing at a path inside a root (e.g.
another repo's own worktree in the same workspace) reads `'validated'`
without ever being cross-checked. Only a worktree whose containment is
`'outside-roots'` gets the genuine bidirectional check
(`resolveWorktreeTrust`): its own `.git` is read back
(`resolveGitEntryAtWorktree`, discovery module) and must resolve to the
SAME `group.commonDir` as the granting repo — a one-way pointer is never
sufficient. Failure (unreadable, or resolves elsewhere) → `'unvalidated'`
with a non-null `trustReason`; success → `'validated'` with `trustReason:
null`. An unvalidated entry is **still reported**, never dropped — every
branch still pushes the descriptor.

Containment/trust are computed on the **realpath'd** worktree path
(`canonicalPath`), never the raw git-reported `summary.path` — this closes
a symlink-defeats-containment attack (a committed in-root symlink whose
real target is outside every root must not be misclassified as in-root and
auto-validated).

Guarding tests, `apps/desktop/src/__tests__/assistant-server/git-inventory.integration.test.ts`:
- in-root always validated — `'reports a linked worktree INSIDE the active
  roots with containment set'` (asserts `trust: 'validated'` for a real
  in-root worktree, bidirectional check never exercised).
- outside-roots, genuine → validated — `'reports a REAL linked worktree
  OUTSIDE every root as outside-roots but still validated'`.
- outside-roots, fabricated/unreadable target → unvalidated, no content
  leak — `'fabricated-gitdir attack: a hand-written worktree admin entry
  pointing outside every root is present but UNVALIDATED, with no content
  access beyond its own .git'`.
- outside-roots, fabricated pointer at a real DIFFERENT repo (common-dir
  mismatch) → unvalidated — `'fabricated-gitdir attack pointing at a
  DIFFERENT real repository: resolves but the common dir mismatches —
  unvalidated'`.
- symlink defeats containment — `'symlink-defeats-containment attack: a
  committed in-root symlink to an outside target is NOT auto-validated'`.
- prunable (deleted, not GC'd) worktree is a trust state, not an inventory
  error — `'treats a merely-prunable ... linked worktree as trust state,
  not an inventory error'` (asserts `snapshot.errors` is `[]`).

## THE `changes` IPC DOMAIN

Main-process registration: `apps/desktop/src/ipc-changes.ts` registers
three channels (`apps/desktop/src/platform/desktop-ipc-channels.ts`:
`changes.resolveView` → `'changes:resolveView'`, `changes.fileDiff` →
`'changes:fileDiff'`, `changes.inventory` → `'changes:inventory'`) against
handlers in `apps/desktop/src/changes-ipc-handlers.ts`. Handlers accept
`unknown` renderer-supplied arguments and structurally validate
(`validateChangeset`/`validatePath`/`validateGitScope`) before anything
typed reaches `ChangesetDiffService` — unknown `Changeset.kind`s and
unsupported/extra keys are rejected explicitly, mirroring
`git-structured-diff.ts`'s own params validation.

Preload exposes `window.changes` (`fileDiff`, `inventory`, `resolveView`)
gated by `shouldExposeBridge('changes')`. Renderer capability resolution:
`packages/app-shell/src/changes/changes-bridge.ts`'s `resolveChangesBridge()`
— returns `null` on web (no bridge), and `null` **plus a logged error** for
a present-but-malformed bridge (missing any of `REQUIRED_METHODS`). No
`isElectron()` check anywhere. Guarded by `changes-bridge.test.ts`'s
`it.each` over every `ChangesBridge` key.

The `commit`/`range` `StructuredFileDiffParams` modes are exposed on the
**separate** `git` IPC domain (`window.git.structuredFileDiff`), not
`window.changes` — the History tab's commit-diff pane calls straight
through `window.git` (the same bridge it already uses for
`history`/`commitFiles`) rather than adding a second bridge dependency
(see RENDERER SURFACES below). The legacy `commitDiff` op was REMOVED
end-to-end in BST-1161 (bridge, preload, IPC channel, handler,
`git-history.ts` op) once its last renderer call site was gone —
`structuredFileDiff`'s `commit` mode is the sole historical-diff path.

## THE `worktrees` IPC DOMAIN

`apps/desktop/src/ipc-worktrees.ts` registers the twelve-method `worktrees`
domain against the narrowing boundary in `worktrees-ipc-handlers.ts`; preload
exposes the same exact method set as `window.worktrees`, and
`packages/app-shell/src/worktrees/worktrees-bridge.ts` rejects a
present-but-incomplete bridge wholesale. All twelve methods — `adopt`,
`archive`, `checkoutStatus`, `create`, `createBranchHere`, `createContext`,
`getSettings`, `inspectArchive`, `list`, `listManagedPaths`, `restore`,
`setSettings` — are
implemented and the lifecycle mutations call real `WorktreeService` methods.
`adopt` and `checkoutStatus` (BST-1392, W5) are the two most recent additions:
`adopt` records an existing on-disk worktree the live inventory already
reports into the ledger (refusing an unvalidated, prunable, locked, primary,
unreachable, or already-managed/archived target — never a caller-supplied
path outside that inventory); `checkoutStatus` is a lazy, per-checkout
`git status` read (ahead/behind/clean/upstream) kept OUTSIDE the mutation
mutex, since it is a read and must not queue behind a create. Managed-directory
settings persist through `assistant-server/worktree-settings.ts`, with `null`
recomputed as the home-relative default on every read. The exact bridge set,
IPC narrowing, preload parity, and settings persistence are pinned by the
corresponding `worktrees-*` and preload-runtime contract tests.

### WORKTREE MAP + ADOPTION (BST-1392)

`WorktreeListEntry` carries `primary`, `repoCommonDir` and `createdAt` so one
`worktrees.list()` can drive both the Mode chip's picker and the Worktree Map.
`primary` is `descriptor.path === repository.identity.repositoryRoot`; a primary
row is deliberately `usable: false` with a stated reason, because a thread that
operates in the user's own clone is in LOCAL mode by definition and binding
`checkoutMode: 'worktree'` to it would produce a checkout hand-off could not
leave. `repoCommonDir` — not `repositoryRoot` — is the key `brainstrike_forge_prs`
joins on, so the Map's PR pill and the thread list's PR pill cannot disagree.

`worktrees.adopt` records an EXISTING on-disk worktree in the ledger. It refuses
a path that is outside every granted root AND outside the managed directory:
`resolveUsability` treats "has a ledger row" as authorization, so an
unreachable adopted row would read `usable: true` while every operation on it
failed. It also refuses the repository's own primary checkout, mirroring the
picker's primary gate. `base_ref` is the worktree's HEAD at adoption time —
"unpushed" for an adopted worktree means "committed here since BrainStrike
started managing it". The Mode chip's picker never calls it — every unmanaged
row is `usable: false`, so its select button is always disabled, which makes
adopting through the picker structurally unreachable. The Worktree Map card's
`Adopt` action is the only UI caller; the agent tool is the only other one.

`worktrees.checkoutStatus` is a LAZY, per-checkout `git status --porcelain=v2
--branch -z` parsed by the production `parsePorcelainV2Z`. It is deliberately
not folded into `list()`, which backs the picker and refreshes on every
invalidation; N status subprocesses behind an orientation surface is the cost
this seam exists to avoid. Until a card's status resolves it renders
"checking…", never a clean glyph.

**Collection navigation (BST-1635).** The Map projects its canonical repository
models through `selectWorktreeCollection`: tokenized case-insensitive local
search, All/Running/Needs attention/External filters, primary-first name or
recent-activity sorting within each repository, and a global 25-checkout page
bound. Search/filter/sort changes return to the first page; a smaller result
clamps both the visible and source page so recovering async results cannot jump back.
Page changes remount the results scrollport, including automatic clamping; toolbar
changes also reset checkout scrolling. These are ephemeral React view preferences, never a
new persistent store or another DB/IPC query. Unknown/loading status is not an
attention signal; the primary checkout's Local-only usability is not a fault.
Status errors, dirty/behind checkouts, failed PR checks and unusable non-primary
checkouts are attention signals. Repository and status loading/refresh ownership
stay in `useWorktreeMap`. The paired collection cases live in
`worktree-map-model.test.ts` and `worktree-map-surface.test.tsx`.

**Responsive rows (BST-1636).** Repository sections use one vertical scrollport
and full-width checkout articles, with one, two, or four columns based on the
Worktrees container width (600px / 760px). Checkout identity/path, Git status,
thread activity and actions keep a stable order. The action group uses 32px
controls and stays inside the row at narrow widths; the primary label may
truncate while its accessible name and title remain complete. The indexing toggle exposes its existing exact-root preference via
an accessible name and `aria-pressed`. Missing-on-disk rows do not claim a
pending Git read. A resolved clean status is explicit, and the selected linked
thread is labeled and accented. Disabled-target guidance stays visible in a neutral tone; the canonical unmanaged-checkout message directs users to the shipped Worktrees → Adopt action. All mutation and capability guards are unchanged.
Paired behavior coverage remains in `worktree-map-surface.test.tsx`; the real
large-collection/geometry regression is in
`apps/desktop/e2e/worktree-map.desktop.test.ts`. The opt-in
`scripts/probe-worktree-map.mjs` checks row fit instead of horizontal scrolling.

**"Open in Terminal" — SHIPPED in W6 (BST-1457); the deferral and its tripwire
are gone.** Spec §10 lists the action on a Worktree Map card, §4.1 on the Folder
chip's root rows and §4.3 on the Mode chip's worktree menu; all three exist. The
seam is the app's OWN Terminal workspace app, not the OS terminal emulator and
not `window.worktrees`: `worktrees` gains no `openInTerminal` member (spec §6.1
placed it there, but the action mutates nothing and needs no main-side worktree
state — recorded as W6 ruling T1), and an external emulator was rejected because
it would hand a shell to a path the app never containment-checked, with no
honest cross-platform story (T2).

Two pieces make it work. `terminal:create` accepts an optional `cwd` that is
realpath'd and SEPARATOR-ANCHORED containment-checked inside the already-
validated root (`resolveContainedCwd` in `apps/desktop/src/workspace-root-cwd.ts`);
omitted, behavior is byte-for-byte what it was. The parameter is not a
convenience: `WorktreeListEntry.rootId` is the first root CONTAINING a checkout,
not its own mount (`rootIdIsExactMount` is that flag), so a worktree nested at
`.claude/worktrees/<name>` under an open repo resolves to the PARENT's root id —
pinning the shell to `rootId` alone would silently open it in the wrong
repository. Every surface therefore passes BOTH `{ cwd: <checkout path>,
rootId: <containing root> }`. On the renderer side a session-lived
`terminal-target-store` (`packages/app-shell/src/stores/`) holds a STANDING pin;
`openTerminalAt` sets it, switches the shell route to `explorer` and opens the
Terminal app tab (it owns both halves, unlike `changes-navigation-store`, because
all three callers need the identical pair). `TerminalPanel` derives
`target ?? focused root` during render — never an effect mirror — and renders an
explicit "Follow focused folder" release so a pin is reversible rather than a
trap. `useTerminalSession`'s outcome-freshness gate keys on the (rootId, cwd)
PAIR: the lifecycle effect re-runs on a pin change without bumping `sessionId`,
so a rootId-only gate would leak the previous checkout's `exited` overlay onto
the freshly-starting one.

On a Map card the item renders exactly when `entry.rootId !== null`, and
`Add as root` renders exactly when it is `null` — complementary, so the menu
always names the next step and never shows a disabled action. Web has no
`window.terminal`, so `isTerminalBridgeAvailable()` is false and no surface
supplies the handler: the item does not exist there in any form. The W5
absence-assertion tripwire in `worktree-map-surface.test.tsx` was DELETED in
the same PR that added the action, as its own comment instructed; the sibling
assertion in `mode-chip.test.tsx` survives, repurposed from a deferral
tripwire into an ordinary handler-presence contract.

The A5 run-scoped `git worktree lock` deferral above still stands on its own —
it remains a capability the spec named that no seam yet supports.

Mounting is a SEPARATE step from adoption and does not happen automatically:
adopting a worktree only inserts the `brainstrike_worktrees` ledger row, it
does not add a `roots` row. The picker-less mount grant matches adoption's own
reachability rule (BST-1392 follow-up): a live ledger row that is under the
managed directory OR inside a granted root (per a forced-fresh inventory)
mounts without a picker (`isAuthorizedWorktreeMountPath`; the shared
`isReachableCheckout` predicate in `worktree-adopt.ts` backs it and
`assertReachable` both, so the two rules cannot drift) — before the widening, an
adopted in-root checkout outside the managed directory (the
`.claude/worktrees/<name>` shape) adopted fine and then refused to mount. An
outside-roots row stays refused. The Map's `onNewThread` mounts the checkout via
`addRootDirectoryByPath` before binding a thread, mirroring the ordering
`use-worktree-mode.ts`'s `mountWorktree`/`onSelectExisting` already use for the
Mode chip's create/pick flows (found live during the W5 CDT pass: without this
ordering, the bind's `resolveRootIdAfterReconciliation` retry — 20 × 250ms,
already generous — always exhausted, because nothing else ever creates the
`roots` row for a freshly-adopted worktree). The Map never re-reads on its own,
so every mutation that changes what a card resolves needs a matching re-read —
but the two mutation classes get DIFFERENT mechanisms (settled in PR #2671
review; the W5 CDT pass filed the staleness, #2671 closed it):

- **Ledger mutations** (`onAdopt`, `onArchive`) call `refresh()` on the Map's
  own card list on success — their IPC resolves only after the ledger write, so
  the refresh observes a completed write. A refusal never refreshes.
- **Mount paths** (`onNewThread`'s mount-before-bind, `onAddAsRoot`) must NOT
  call `refresh()`: `addRootDirectoryByPath` resolving does not mean the
  `roots` row (which `rootId` and therefore `indexing` resolve from) exists —
  the row is written later by the fire-and-forget mid-session registration
  (`performRootRegistration`), whose completion emits no `changes:invalidated`,
  so a caller-side refresh races the write and re-reads `rootId: null`.
  Instead `useWorktreeMap` keys its load effect on the `useOptionalRootIdentity`
  context value, which `RootIdentityProvider` re-memoizes exactly when a new
  adapter→DB mapping publishes (i.e. after `reconcileRoots` wrote the row) —
  deterministic, poll-free, and it covers mounts started from ANY surface
  (Mode chip included), not just the Map's own actions.

Both halves are pinned: the surface test pins that mount callbacks never call
`refresh()` (and that adopt/archive do), and the `use-worktree-map` test pins
the identity-driven re-read plus its cheapness (no extra per-card `git status`).

### SETUP HOOKS / PER-WORKTREE SETUP — granted roots only

Repository code runs only while creating a worktree FROM a repository the user
explicitly opened as a workspace root. `createUnserialized` starts with
`resolveRepositoryContext(params.rootId)`, which resolves that durable
`roots.id` through `deps.resolveRootCwd(rootId)` before setup is reachable.
After creation it is the sole caller of `runSetupSafely` → `deps.runSetup` →
`runWorktreeSetup`. Repositories surfaced only through inventory/list discovery
have no path to setup execution. This is the Conductor / Claude Code convention:
`setupCommand` is tri-state: an argv array runs that explicit command, `null`
falls back to `.brainstrike/worktree-setup.sh` when present, and `'disabled'`
does not run or probe any setup command. Explicit argv and `'disabled'` bypass
repository-script consent because neither executes the repository fallback.

Before the first repository-script execution, `createContext` reports the
repository root, absolute script path, and repository identity (the Git common
directory). The create sheet blocks until the user allows or skips that script
and warns that it runs local shell code with `BRAINSTRIKE_WORKSPACE_*` variables
and that `.worktreeinclude` can copy gitignored files. Both decisions persist in
the renderer's `worktree-setup-consent.v1` store, keyed by Git common directory,
so later creates and app restarts do not prompt again. Factory reset clears the
store. Create IPC carries the renderer decision plus repository identity; main
pins that identity to its freshly resolved common directory before forwarding
the decision. Missing or mismatched consent fails closed to a visible `skipped`
setup outcome while worktree creation continues. A denial behaves the same way
and never executes the script.

`.worktreeinclude` copies gitignored source files into the new worktree, one
root-relative glob pattern per non-comment line. Absolute and `..`-escaping
patterns are rejected before filesystem access. Every resolved match is also
`realpath`-checked against the source root, and each existing/write-side target
parent is `realpath`-checked against the worktree root before copying with
`dereference: false`; symlinks therefore cannot smuggle bytes from outside the
repository or redirect a write outside the destination. An escaping,
disappeared, or over-budget match is skipped individually and reported by
pattern, path, and reason in `WorktreeSetupOutcome.skippedCopies` and the
persisted bounded setup output. Per-entry and aggregate copies share the
512 MiB `WORKTREE_INCLUDE_MAX_TOTAL_BYTES` ceiling.

The command receives the Conductor-style environment from
`worktreeSetupEnvironment`: `BRAINSTRIKE_ROOT_PATH`,
`BRAINSTRIKE_WORKSPACE_NAME`, `BRAINSTRIKE_WORKSPACE_PATH`, and
`BRAINSTRIKE_PORT`. The port is
`3000 + (sha256(worktreePath).readUInt32BE(0) % 2000)`: deterministic for one
worktree path and unlikely to collide, but NOT probed or verified free. It is a
default the setup command may honor, never a free-port allocation.

Execution is argv-based, not a shell command string. The repository script is
spawned as `/bin/sh <absolute-script-path>`; configured argv is spawned
directly. Neither path nor argv is interpolated into a command line. Stdout and
stderr are consumed to completion while their retained bytes are bounded;
overflow marks the outcome truncated and is discarded without killing the
process. A timed-out POSIX command cannot settle merely because the process
leader and inherited output pipes closed: settlement waits for the dedicated
process group to disappear, while the existing post-escalation deadline keeps
the outcome bounded. Timeout, spawn, signal, and non-zero-exit failures remain
visible but non-blocking: the worktree is usable, and the bounded
`WorktreeSetupOutcome` is returned and its status/output persisted on the ledger
row rather than dropped.

### MANAGED WORKTREE ARCHIVE SNAPSHOTS (BST-1390) — not shadow git

Archiving a managed worktree captures its full tracked+untracked (non-ignored)
state as a commit at `refs/brainstrike/worktree-archive/<worktreeId>` **in the
worktree's own repository**, via a private `GIT_INDEX_FILE` → `add -A` →
`write-tree` → `commit-tree` → `update-ref` (the same technique
`snapshot-git.ts` uses). It deliberately does NOT go through `SnapshotService`:
that engine is keyed per ROOT *and* per THREAD (`snapshotRefForThread`) with a
closed `SnapshotKind` union that throws on an unknown kind, and a managed
worktree outlives its thread. Living in the common dir is what lets the
snapshot survive `git worktree remove`. Restore then chooses one explicit add
path before `git restore --source=<ref>` replays the snapshot: a detached row
uses `git worktree add --detach -- <path> <ref>^`; a missing branch is recreated
with `git worktree add -b <branch> -- <path> <ref>^`; and an existing branch
whose tip still equals `<ref>^` is checked out directly with
`git worktree add -- <path> <branch>`. If an existing branch has moved since
archive, restore refuses with an error naming its current and expected tips —
it never silently rebases or overwrites the branch.

The snapshot is captured on EVERY archive, clean or not, and BEFORE the safety
verdict is acted on. `archive` refuses a dirty or unpushed worktree unless
`force`; the one blocker `force` never overrides is an active run in that
worktree (`brainstrike_assistant_thread_runs.status = 'running'` for the owning
thread). Ignored files remain outside the snapshot. `inspectArchive` therefore
returns their count, the exact total number of top-level paths, and a bounded
sorted display list. `ignoredEntryCount` counts matching porcelain entries, so a
wholly ignored directory counts as one entry regardless of its descendants.
Directory-shaped display entries retain a trailing slash to disclose that
shape, and a truncated list states the exact number of additional top-level
paths. The opaque confirmation token is bound to the complete top-level
ignored-path set
and the managed worktree's id and canonical path, so it cannot be transferred to
a different worktree with the same ignored names. When that count is non-zero,
`archive` requires the caller to echo the current non-empty
`confirmIgnoredEntries` token; `force` does not bypass this deletion gate. Both
the Mode chip and Worktree Map require an explicit destructive confirmation when
the count is non-zero. The Mode chip's confirmation field is required (nullable,
never optional), and pending confirmation state binds both the selected thread
and worktree. Either selection changing clears it, so returning to the old
selection cannot resurrect a stale destructive action. When the managed
worktree path is already missing, `inspectArchive` returns an empty preview with
a null token and `archive` skips the ignored-entry gate because there is no
on-disk target left to delete. Immediately after snapshot capture and all
branch/remote safety reads, `archive` re-reads porcelain
status as its final Git operation and rejects a missing or stale token before
removal. This closes mutations during snapshot capture and the post-capture
safety checks; no filesystem lock exists, so a mutation after that final status
read remains an unavoidable local race. The token is a stale-confirmation guard:
it proves the caller saw the current top-level ignored-path set for this
worktree, not that a human approved it. Churn beneath an already disclosed
top-level directory intentionally does not invalidate the token. The entry count
is not in the token preimage, so it can drift from the eventual matching-entry
count when nested churn occurs, including under-reporting it while the token
stays valid; a newly created nested secret is deleted under that prior
directory-level
confirmation and is not named separately. Nested Git repositories need separate
restorability handling tracked by BST-1625. W3 deliberately does NOT take a
`git worktree lock` for the duration of a run: a lock is globally visible and
`git-workbench-header.tsx` disables any
locked worktree, so it would disable every managed worktree in the Changes
surface. Run-scoped locking is a W5 follow-up.

## REFRESH SEAMS

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

## RENDERER SURFACES

### Changes surface (`packages/app-shell/src/changes/`)

Lazy-mounted workspace-panel tab (capability-gated: absent unless
`window.changes` is present, no `isElectron()`). `ChangesSurface`
(`ui/changes-surface.tsx`) composes `ChangesetHeader` (source picker),
`ChangedFilesTree` (canonical `TreeTable`, root → repo → worktree →
file), and `ChangesetDiffPane` (stacked `ChangesetFileDiffCard`s).

**Resolution root for a `git-scope` changeset is the workspace root
CONTAINING its worktree**, per the inventory's `WorktreeDescriptor.containment`
— NOT the surface's single focused root:

```ts
function resolveGitScopeResolutionRootId(changeset, inventory) {
  // find the repository/worktree matching changeset.repositoryRoot/worktreePath
  return worktree.containment === 'outside-roots' ? null : (worktree.containment[0] ?? null);
}
```

In a multi-root workspace the source picker offers scopes for worktrees
under every mounted root, but the main-process containment check
(`resolveContainedWorktreeCwd`) deterministically fails
(`outside-roots-unsupported:`) unless resolution uses a root that actually
contains the worktree (BST-1114 PR #2274 review finding). `null` when the
worktree can't be found or has no containing root — `useChangeset` stays
inert (no fetch) rather than guessing.

**Selection semantics** (`changes-store.ts`, module-level Zustand
singleton shared between the Changes surface and the git panel's Changes
tab — see below): an **empty** `selectedFileKeys` means "no explicit
selection — render every file in the changeset", not "render nothing"; a
changeset with genuinely no files is a different fact reported by
`ChangesetView.files`. `hasExplicitSelection` exists so callers state
which of the two they mean rather than re-deriving `.size > 0`.
`changedFileKey` is keyed on `(rootId, worktreePath, path)`, NUL-joined:

```ts
export function changedFileKey(entry: ChangedFileEntry): string {
  return `${entry.rootId ?? ''}\u0000${entry.worktreePath ?? ''}\u0000${entry.path}`;
}
```

`path` alone collapses across two worktrees of the same repo;
`worktreePath` is `null` for every snapshot-sourced entry, so `rootId`
distinguishes those (two roots can share a relative path). Guarded by
`changes-store.test.ts`'s `'renders every file when nothing is explicitly
selected'` (asserts `selectRenderedFiles` returns the SAME array
reference on an empty selection) and its `changedFileKey` composite-key
cases.

`ChangesetFileDiffCard` (`ui/changeset-file-diff-card.tsx`) is the shared,
prop-driven diff-rendering leaf (own lazy `IntersectionObserver`-gated
load, own generation-guarded staleness protection). Its content branches:
`binary` → a dedicated explanatory card; `full`/`hunks-only` → the shared
`DiffView` via the `{ kind: 'structured', diff }` source (`null`
additions/deletions render as `"—"`, never `"0"`); any error → the real
message plus a per-card Retry. The former `journal-content-expired:`
explanatory card was REMOVED in T4 (snapshot-backed changesets never evict
content, so the state is unreachable) — its absence is pinned by
`changeset-file-diff-card.test.tsx`.
It has two additive optional props: `bodyClassName` (default `'h-[420px]
min-h-0'`, the sizing tuned for the surface's vertically-stacked multi-file
pane) and `className` on the card ROOT (default `undefined`, i.e. the
surface's original markup). A single-card host needs BOTH — the git panel
passes `className='flex min-h-0 flex-1 flex-col'` +
`bodyClassName='min-h-0 flex-1'`. `bodyClassName='h-full'` alone does
nothing: the card root is an auto-height block, so a percentage height
resolves to `auto` against it and the diff sizes to its own content
(measured, not assumed) instead of filling the pane — which also defeats
`DiffView`'s internal scroller, whose CodeMirror theme pins `.cm-editor`
to `height: 100%`.

### Git panel (`packages/app-shell/src/git-panel/`) — converged in W6

Two tabs: Changes (`git-changes-view.tsx`) and History
(`git-history-view.tsx`); both now resolve diffs through the structured
engine and render `ChangesetFileDiffCard`. `git-diff-surface.tsx` and
`packages/ui/src/diff-view/parse-unified-diff.ts` are **deleted** — `git
grep parseUnifiedDiff` finds zero code references, only historical mentions
in doc comments and planning docs.

**Staging composition is a settled, do-not-relitigate ruling** (recorded
verbatim in `git-changes-view.tsx`'s top doc comment): the panel's left
staged/unstaged/untracked list, its per-row stage/unstage buttons, and the
tri-state stage-all control stay **panel-owned**, still driven straight
off `window.git`'s `GitStatus.files` — the panel does NOT compose onto the
shared `ChangedFilesTree`. Two reasons: (1) `ChangedFilesTree`'s checkboxes
mean "which files' diffs to render", a different semantic from this
panel's tri-state, which means "which INDEX a stage/unstage action
targets"; (2) `changes-store.ts` is the module-level singleton described
above, shared with the Changes surface tab which can be mounted
simultaneously — writing the panel's selection into `selectedFileKeys`
would silently clobber the Changes surface's own selection and vice versa.
The panel therefore never imports `changes-store.ts` and never mounts
`ChangesetDiffPane` (which reads that store internally); it mounts
`ChangesetFileDiffCard` directly instead — a fully prop-driven leaf with
no store coupling.

**Per-row scope pinning**: a `git-scope` changeset carries exactly one
`GitScope`, so the panel re-pins the changeset to the selected row's own
bucket on every selection change — staged → `{ kind: 'staged' }`, unstaged
→ `{ kind: 'unstaged' }`, untracked → `{ kind: 'uncommitted' }`
(untracked's only route, per the engine mapping above).

**History tab**: `CommitFilesSidebar` (commit-files listing) is
unchanged — still `bridge.commitFiles`, its own request-generation
staleness guard. The diff pane calls `useGitPanel.loadCommitFileDiff`,
which calls `bridge.structuredFileDiff(rootId, { commitId, mode: 'commit',
path })` — routed through `window.git`, not `window.changes`, since
`commit` mode is already exposed there (see IPC DOMAIN above).
`ChangesetFileDiffCard` is mounted with `key={`${commitId}:${path}`}`:
selecting a different commit or file remounts a fresh card instance with
its own generation counter, so a slow response for a prior selection lands
on an unmounted component and is dropped by React rather than clobbering
the current card. `use-git-panel.ts`'s `loadDiff` (the old
`parseUnifiedDiff`-backed Changes-tab loader) is removed as dead; no
`loadCommitDiff` export exists either — only `loadCommitFileDiff` /
`loadCommitFiles`. Guarded by `git-panel.test.tsx`'s `'never lets a late
historical diff replace the current commit diff'`.

**Canvas navigation in the changes-navigation store (BST-1173, reshaped by
BST-1258).** `changes-navigation-store` owns the Canvas surface's DOMAIN
navigation facts: `openCanvasPanel()` is the external entry point (same
unconditional-write reasoning as `openChangeset`), and `canvasRefreshNonce` /
`requestCanvasRefresh()` is the Canvas panel's re-resolve trigger — the same
re-resolve-not-push design as `liveRefreshNonce`, bumped by
`use-wrapper-rewind-wiring`'s `handleRunEditActivity` when a completed
edit-activity event's tool name denormalizes to `brainstrike.manageCanvas`
(canvas mutations are edit-risk, so they already ride that stream; the canvas
bump is unthrottled and then falls through to the guarded Changes refresh).
All of these reset with the store's existing factory-reset registration.

WHICH workspace tab is showing moved OUT of this store (BST-1258 unified
workspace tab panel): Changes and Canvas are closable singleton workspace
APP tabs registered by `root-layout-content`'s `ExplorerAppSurface` and owned
by `useWorkspaceTabSelectionStore` (`@brainstrike/file-explorer-ui`), whose
`openApp('changes' | 'canvas')` both `openChangeset`/`openCanvasPanel` call.
The sticky keep-mounted contract (the sandboxed canvas iframe must not reload
on tab switches) is now that store's session-only `mountedAppIds`. The
capability gate is unchanged in spirit and PER-APP: any subset of
{Changes, Canvas} may register; an unregistered app has no tab and no
launcher card. Web passes NO `canvasPanelContent` — nothing can write
`brainstrike_canvas_versions` there (desktop-only tool, no sync) and a
permanently-empty tab would violate the omit-don't-stub convention.

**Worktree dropdown** (`git-workbench-header.tsx`): each entry publishes a
`git-scope` changeset (`scope: { kind: 'uncommitted' }`) via
`useChangesNavigationStore.openChangeset` — which itself opens/activates the
Changes workspace app tab via `useWorkspaceTabSelectionStore.openApp` — and
then switches the SHELL route back to `explorer` via
`usePanelLayoutStore.setActiveTab`, because the Changes surface is a
workspace app tab on that route, not a route of its own. Two distinct
stores, two distinct "tab" concepts; both writes are required. Trust gating, priority-ordered, each disabled state stating its
own reason (never a silent disable):

```ts
if (!available) return { navigable: false, disabledReason: 'Repository inventory is unavailable in this build.' };
if (inventoryError) return { navigable: false, disabledReason: `Repository inventory unavailable: ${inventoryError}` };
if (!inventory) return { navigable: false, disabledReason: 'Loading repository inventory…' };
if (!descriptor) return { navigable: false, disabledReason: 'Not found in the workspace inventory yet.' };
if (descriptor.trust === 'unvalidated') return { navigable: false, disabledReason: descriptor.trustReason ?? '...' };
if (descriptor.containment === 'outside-roots') return { navigable: false, disabledReason: "isn't inside any workspace root…" };
if (worktree.lockedReason !== null) return { navigable: false, disabledReason: `Locked: ${worktree.lockedReason}` };
return { navigable: true, disabledReason: null };
```

The `unvalidated` check precedes the `outside-roots` check deliberately:
`trust: 'unvalidated'` only ever occurs for an outside-roots worktree (see
TRUST RULE above), so it is the strictly narrower case and carries the
more specific, bidirectional-check-derived reason. The `available` check is
first because a bridge-less build reports `inventory: null` with `error:
null`, which would otherwise read as a permanent "Loading…" that never
resolves. Guarded by `git-workbench-header.test.tsx`'s seven gating tests,
one per branch.

### `DiffView`'s `strings` source

`packages/ui/src/diff-view/` still exports the legacy `{ kind: 'strings',
original, modified }` source alongside `{ kind: 'structured', diff }`.
`assistant-tool-approval-notice.tsx` (tool-approval preview, which has
direct old/new text and no `StructuredFileDiff` to build) is its only
remaining production consumer — both git-panel tabs retired their own
`strings` call sites in W6. Do not delete `strings` while that consumer
exists; do not add a new `strings` call site to a surface that has a real
`StructuredFileDiff` available.

## CAPS (summary)

| Cap | Value | Where |
| --- | --- | --- |
| Per-side full-content inline cap | 2 MB (`STRUCTURED_DIFF_CONTENT_CAP_BYTES`) | `git-structured-diff.ts` |
| Bounded/truncated output soft ceiling | 1 MB (`GIT_MAX_OUTPUT_BYTES`) | `git-service.ts`, shared |
| Hard `execFile` buffer (maxBuffer) | 4 MB (`GIT_MAX_BUFFER_BYTES`) | `git-service.ts`, shared |
| Inventory walk depth | 6 (`DEFAULT_WALK_MAX_DEPTH`) | `git-inventory-discovery.ts` |
| Inventory walk concurrency | 32 (`DEFAULT_WALK_MAX_CONCURRENCY`) | `git-inventory-discovery.ts` |
| Inventory snapshot cache TTL | 5000ms (`GIT_INVENTORY_SNAPSHOT_TTL_MS`) | `git-inventory-service.ts` |
| Inventory watcher debounce / max-batch | 300ms / 2000ms | `git-inventory-watcher.ts` |

No repository or worktree COUNT cap exists anywhere in the inventory
pipeline.

## DO-NOT-RELITIGATE RULINGS

- **`ChangesetView.totalAdditions`/`totalDeletions` is `number | null`, never
  a `0` sentinel.** Rejected shape (already relitigated once per the PR
  history) — `null` and computed-`0` are different facts.
- **`unstaged` per-file diff is index-vs-worktree, not HEAD-vs-worktree.**
  The old `working`-mode mapping visibly contradicted its own listing;
  fixed as `mode: 'unstaged'` and documented as settled in
  `StructuredFileDiffParams`'s own doc comment.
- **The git panel's staged/unstaged/untracked list stays panel-owned, never
  composed onto `ChangedFilesTree`.** See STAGING COMPOSITION above —
  two independent, load-bearing reasons (checkbox semantic collision,
  cross-surface store clobbering), recorded in `git-changes-view.tsx`.
- **A worktree inside a workspace root is unconditionally `'validated'`.**
  This is "inside a granted root", not "ownership verified" — do not
  "fix" this to run the bidirectional check for in-root worktrees; that
  check exists specifically for the outside-roots case where containment
  itself isn't already a trust signal.
- **An unvalidated/prunable worktree is always reported, never dropped.**
  Any change that filters `GitInventory.repositories[].worktrees` before
  display must preserve this.
- **Journal-sourced diffs never have hunks and never have real totals.**
  Structural facts (the journal has no git ref and no line counts), not
  incidental gaps to "improve" without a design change. (Since W7 T2 this
  applies only to the retiring rewind-preview path — snapshot-resolved
  `agent-run`/`run-range` views have real totals, and their `full` diffs
  carry real hunk ranges from `git diff`.)

## CORRECTIONS TO EARLIER PLANNING DOCS (verify before trusting)

- **`StructuredFileDiffContent` is a 3-variant union** (`binary` | `full` |
  `hunks-only`), where `hunks-only` carries a 4-value `reason`. PR #2252's
  body describes "a 4-reason content union (`hunks`, `binary`, `too-large`,
  `error`)" — that is not what shipped; read `packages/types/src/changeset.ts`
  directly rather than that PR body.
- **No `ConversationRevertService`/soft-rewind exists.** The design spec's
  W5 scope is unimplemented on this branch; only the `revertible` field
  (computed by `foldJournalRecords`/`isEntryRevertible`) ships.
- **`WorktreeProvenance`'s `'agent-reported'`/`'both'` values are never
  produced.** Only `'scanned'` — see SERVICES above.
- ~~**No live push-to-renderer refresh exists**~~ — CLOSED by BST-1161:
  `changes:invalidated` + the renderer generation guard now exist. See
  REFRESH SEAMS above for exactly what refreshes on it.
