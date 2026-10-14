# Settled rulings, with their original wording — evidence

Supports `docs/agents/changeset-diff.md` § "DO-NOT-RELITIGATE RULINGS".
Read before proposing to reopen any of these.

The lines below are the pre-distillation contract text, extracted verbatim.

> **Correction, verified 2026-09-21.** The "Journal-sourced diffs never have
> hunks and never have real totals" ruling no longer describes any shipping
> path. `changeset-journal-view.ts` is deleted and journal CONTENT is never
> read for diffs; the edit-checkpoint table is an attribution-only ledger and
> `before_content` is never populated. Its parenthetical ("applies only to the
> retiring rewind-preview path") is also stale: `rewind-snapshot-engine.ts`
> previews from shadow-git snapshots, not the journal.

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
