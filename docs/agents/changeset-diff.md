# Git changes and managed worktrees

Implementation: `packages/types/src/changeset.ts` and `packages/host-capabilities/src/git-workspace` (changeset, Git-inventory, worktree and snapshot services). Decisions: ADRs 0016, 0017, 0029 and 0036.

## Scope and trust

- Use the existing ChangesetDiffService, Git inventory and WorktreeService.
- Root and repository common-dir identity authorize operations; a path, one-way `.git` pointer or ledger row does not.
  - Resolve real containment and validate outside-root worktrees in both directions.
  - Report unvalidated or prunable entries with a reason instead of hiding them.
- Mounting and adoption are separate operations; mount before binding a thread.
- Setup hooks run only for the explicitly granted checkout and consent.
- Archive captures a restorable snapshot and refuses active or unsafe ownership.
- Never modify the user's primary checkout as a side effect of managing another.
- Native command/process retirement finishes before a repository directory is released or removed; failed joins are kept.

## Diff meaning

- The changeset kind sets the comparison.
  - Unstaged is index versus working tree, not HEAD.
  - A settled turn compares committed start/end snapshots; a live turn compares its start to the current worktree.
- The host log owns run boundaries and tool attribution, not SQL timestamps or an edit journal.
- Validate refs and scoped pathspecs, keep rename pairing and refuse unresolved conflicts.
- Unknown totals are null, not zero. Missing attribution is absent, not false.
- Binary, full-text and hunks-only payloads keep their distinct meanings and explicit truncation reasons.
- Probe size before reading. An incomplete or failed required snapshot fails the whole view, not one file.

## Snapshots and owners

- Keep canonical snapshot ref bindings for opaque thread IDs; refuse mismatched metadata rather than reassigning or pruning another owner's refs.
- Startup retention asks the host for live thread ownership. Unavailable ownership keeps refs; unreadable chains block reclamation.
- Per-edit undo and whole-turn shadow Git are separate restoration paths.
- Changes, git and worktree host methods are refused to every client but the desktop's private one, with strict envelopes.
- The host owns the worktree ledger; Main reads a live worktree through `worktrees/managed-paths`.
- The standalone CLI host composes the same worktree service over its launch roots (list, archive, shell correlation). Creating a worktree and turn snapshots stay desktop-only.
- Changes uses the structured diff engine with explicit invalidation and safe failure surfaces.

## Drawing diffs (ADR-0036)

- Git's patch is the diff. Every display `git diff` pins its output flags so user config cannot change the text; never parse a patch made without them.
- A view entry carries its file's complete patch while the view stays under its patch budget; a binary file, a file past the budget or a hunks-only file has `patch: null` and loads its `StructuredFileDiff` when opened.
- The renderer (`@brainstrike/ui/diff-view`, @pierre/diffs) parses the patch and never diffs it again. Full sides only expand unchanged context.
- Only an approval preview, whose text is not in git yet, is diffed by the renderer.
- Line comments are per-changeset drafts in `changes-store` until added to the active thread's message.
- A worktree status still loading is not a clean checkout. Closing UI never mutates durable run history.
