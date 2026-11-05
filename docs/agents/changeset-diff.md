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
  - Unstaged is index versus working tree, not HEAD, plus untracked files.
  - A settled turn compares committed start/end snapshots; a live turn compares its start to the current worktree.
  - Both views pair a moved file with its old path (`--find-renames`). Restore plans keep `--no-renames`, because a revert writes and deletes paths.
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
- A view entry carries its file's complete patch while the view stays under its patch budget; a binary file, a file past the budget or a cut patch has `patch: null` and loads its `StructuredFileDiff` when opened. A file's own diff carries git's whole patch, cut after its last whole hunk only at the runner's capture ceiling.
- A conflicted path refuses the scope that holds it (`changeset.unmerged-path`); git writes its patch as a combined diff, which nothing draws.
- The renderer (`@brainstrike/ui/diff-view`, @pierre/diffs) parses the patch and never diffs it again. Full sides only expand unchanged context.
- Only an approval preview, whose text is not in git yet, is diffed by the renderer. Its text comes from `interaction/preview`: the host runs the call's own tool resolution and matcher without writing, and returns the file's text before and after.
- A finished turn that edited files shows its agent-run view under its reply, each file folded to its header; it loads as the turn nears view, and Review opens it in Changes.
- Line comments are per-changeset drafts in `changes-store` until added to the active thread's message.
- A worktree status still loading is not a clean checkout. Closing UI never mutates durable run history.

## Stage, unstage and revert (ADR-0036)

- Each entry's `actions` is the host's only statement of what applies to that file. Unstaged stages and reverts, Staged unstages, a settled turn reverts whole files, and every other scope applies nothing. A nested repository offers nothing, and a submodule never reverts.
- An entry's `revision` is the identity of what the view drew: its status, counts, patch and git's blob ids. A working-tree file no patch names the content of (an untracked binary, or one past the view's limits) adds its stat, as git's index does. `changes/apply` lists the scope again first; a file whose revision differs, or a hunk the file's patch no longer holds, is `changeset.stale`.
- Hunks are taken only as `actionHunks` splits the patch, and only from a modified file. A type change, a submodule, or text that did not decode exactly (U+FFFD) takes none, so the host never writes back bytes it could not read.
- Hunks are `git apply` of git's own header (mode lines dropped) and the chosen hunks, with whitespace handling pinned and `--directory` for a folder inside the repository. Each chosen hunk's start is moved by the hunks skipped before it, as `git add -p` does, so git never lands on a repeated copy of the text. Never `--reject`, `--recount`, `--unidiff-zero` or `-C0`; a patch that no longer applies changes nothing (`changeset.apply-conflict`).
- Files are path-level git with pathspecs on stdin. Revert removes only paths the listing names untracked or intent-to-add.
- Every view and write needs the worktree git reports to lie inside the root, so a repository's `core.worktree` cannot point git outside it. Every listing and read pins `core.fsmonitor=false`, so a repository's fsmonitor command never runs.
- The diff shows each file's actions on its header and on each hunk it can take, and the toolbar applies an action to every file that offers it. Reverting a file or every file asks first; a hunk reverts at once. Each action, taken or refused, redraws the view before the next one.
- A target names one root's files: the call's `rootId`, as for a file diff. The renderer sends one request per root a turn's files lie in.

## Reverting a turn's files (Sean, 2026-11-05)

- A settled agent-run view offers Revert on each file the live folder still holds exactly as the turn left it, and only the whole file (`wholeFile`); a single hunk reverts from Unstaged. A live turn, a range, a thread with a run in progress (`thread/list` `latestRun`) and a folder no longer mounted where the turn found it offer nothing.
- "As the turn left it" is the snapshot engine's rule, read only for the turn's paths: each path's mode and blob, hashed with `update-index --add` into a private shadow index, against the turn's own diff, and a path the turn deleted must still be absent. A path that is now a directory, lies under a file, or lies past a symlinked directory is never unchanged.
- `changes/apply` asks whether the thread is idle and checks the same rule under the root's snapshot lock, then restores every file from the turn-start tree with `checkout-index` (deleting what the turn added). A thread with a run in progress is `changeset.run-active`, and a file that moved on is `changeset.stale`; either writes nothing. A run's turn-start snapshot takes the same lock, so a run that starts meanwhile starts from the reverted files.
- A moved file reverts both its paths: the old one comes back and the new one goes. It is offered only while both are as the turn left them.
- No commit or ref is written: the turn-end snapshot already holds what the revert replaced.
