# Git changes and managed worktrees

## Scope and trust

Use the existing ChangesetDiffService, Git inventory and WorktreeService. Root
and repository common-dir identity authorize operations; a path, one-way `.git`
pointer or ledger row is insufficient. Resolve real containment and validate
outside-root worktrees bidirectionally. Report unvalidated/prunable entries with
a reason instead of hiding them. Mounting and adoption are separate operations;
mount before binding a thread.

Setup hooks run only for the explicitly granted checkout and consent. Archive
captures a restorable snapshot and refuses active or unsafe ownership. Never
modify the user's primary checkout as a side effect of creating/managing another.
Physical native command/process retirement must finish before releasing or
removing its repository directory; preserve failed joins.

## Diff meaning

The changeset kind determines the comparison. Unstaged means index versus working
tree, not HEAD. Settled turns compare committed start/end snapshots; a live turn
compares its start to current worktree. The host log owns run boundaries and tool
attribution, not old SQL timestamps or an edit journal. Validate refs and scoped
pathspecs, preserve rename pairing and refuse unresolved conflicts.

Unknown totals are null, not computed zero. Missing attribution is absent, not
false. Binary, full-text and hunks-only payloads retain their distinct meanings
and explicit truncation reasons. Probe size before reading; an incomplete or
failed required snapshot fails the whole view, not just one file.

## Snapshot and UI owners

Keep canonical snapshot ref bindings for opaque thread IDs; refuse mismatched
metadata rather than reassigning or pruning another owner. Startup retention asks
the host for live thread ownership. Unavailable ownership preserves refs and
unreadable chains prevent reclamation. Per-edit undo and whole-turn shadow Git are
separate restoration paths.

Changes/worktree IPC uses declared visible-UI capabilities and strict envelopes;
web omits them. Reuse the same structured diff engine in Changes and Git History,
with explicit invalidation and safe failure surfaces. A worktree status still
loading is not a clean checkout; closing UI does not mutate durable run history.

Implementation: `packages/types/src/changeset.ts` and desktop changeset,
Git-inventory, worktree and snapshot services. Decisions: ADRs 0016 and 0017.
