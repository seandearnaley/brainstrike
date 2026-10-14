# Managed worktree archive snapshots — evidence

Supports `docs/agents/changeset-diff.md` § "MANAGED WORKTREE ARCHIVE SNAPSHOTS (BST-1390) — not shadow git".
Read before changing archive capture, the restore add paths, or the ignored-entry confirmation token.

The lines below are the pre-distillation contract text, extracted verbatim.

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
