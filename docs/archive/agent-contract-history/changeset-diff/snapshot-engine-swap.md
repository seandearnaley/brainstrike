# The W7 snapshot engine swap and the journal fold — evidence

Supports `docs/agents/changeset-diff.md` § "Changeset resolution — `changeset-git-scope.ts` / `changeset-snapshot-view.ts`, dispatched by `changeset-diff-service.ts`".
Read before changing turn anchoring, snapshot ref identity, retention/GC, or proposing to restore journal-content diffs.

The lines below are the pre-distillation contract text, extracted verbatim.

`ChangesetDiffService` (`{ fileDiff, resolveView }`) dispatches purely on
`changeset.kind`: `git-scope` → `changeset-git-scope.ts`; `agent-run` /
`run-range` → `changeset-snapshot-view.ts` (the W7 shadow-git snapshot
engine, BST-1164 T2; the old journal fold `changeset-journal-view.ts` was
DELETED in T4 along with its `journal-content-expired:` /
`journal-path-collision:` prefixes). Every failure carries a stable
machine-readable prefix (`snapshot-engine-unavailable:`,
`changeset-snapshot-missing:`, `changeset-snapshot-capture-failed:`,
`outside-roots-unsupported:`, `base-ref-unresolved:`, `head-unborn:`,
`commit-id-unresolved:`, `unmerged-path:`, `run-anchor-missing:`) so the UI
can branch on it — see
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

**Native conversation identity and Git refs:** root directory identifiers keep
strict path validation. A thread ID is opaque native identity and is never
truncated or renamed in the snapshot ledger. Existing safe short IDs keep
`refs/snapshots/<threadId>` (excluding Git-invalid trailing dots); other IDs use
`refs/snapshot-identities/v1/<sha256-of-exact-threadId>`. Snapshot commit JSON
already stores the exact thread ID. That commit-subject field is required on every
encoded-lineage write; delegated capture uses the same snapshot writer. Inventory
decodes that metadata and verifies the canonical ref binding, so startup GC still receives actual thread identities.
Appending or pruning an encoded lineage also verifies its existing head owner;
malformed or mismatched metadata refuses the operation rather than deleting,
reassigning or hiding a lineage. A corrupt ref makes that root's ref reconciliation
fail visibly; it does not prevent valid lineages from being captured or individually
pruned, and other roots still reconcile. No unidentified ref is silently skipped or
automatically deleted. Both namespaces are inventoried in one Git call.
No new persistence store or migration is needed. The real recursive 154-character
native ID, legacy compatibility, corruption refusal, sibling-preserving restore
and ref pruning are covered by the snapshot service and delegated admission tests.

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
