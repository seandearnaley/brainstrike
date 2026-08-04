# Diff / Review UX — Competitive Teardown

**Date:** 2026-08-03
**Context:** BST-1110 changeset-discovery spike, Task 7. Informs scoping of the
Changeset Diff Viewer Linear project.
**Spec under comparison:** `docs/superpowers/specs/2026-08-03-changeset-diff-viewer-design.md`
(cited below as §N).

## Method and evidence rules

Three claim classes are used, and they are never mixed silently:

| Marker | Meaning |
| --- | --- |
| *(docs)* | Stated in current first-party product documentation or changelog. URL + date given. |
| *(observed)* | First-party observation of the shipping Codex app by the project owner, 2026-08. Ground truth for this document, but not publicly citable. |
| *(community)* | Reported on a vendor forum / issue tracker, not vendor documentation. Directionally useful, individually unreliable. |
| **unverified** | Could not be confirmed from any source above. Recorded as unknown — **not** as absent. |

Per the house rule, a capability that could not be confirmed is marked
**unverified**, never guessed. Several cells below are unverified because the
vendors document the agent loop far more thoroughly than the review surface.

### Primary sources

| Product | Source | Date |
| --- | --- | --- |
| Cursor | [Meet the new Cursor (3.0)](https://cursor.com/blog/cursor-3) · [changelog/3-0](https://cursor.com/changelog/3-0) | 2026-04-02 |
| Cursor | [Multitask, Worktrees, and Multi-root Workspaces (3.2)](https://cursor.com/changelog/04-24-26) | 2026-04-24 |
| Cursor | [Worktrees docs](https://cursor.com/docs/configuration/worktrees) | fetched 2026-08-03 |
| Cursor | [Reviewing and Testing Code](https://cursor.com/docs/agent/review) | fetched 2026-08-03 |
| Cursor | [Checkpoints](https://cursor.com/docs/agent/chat/checkpoints) | fetched 2026-08-03 |
| Cursor | [Cursor, now on iPad](https://cursor.com/changelog/ipad) | 2026-07-29 |
| Codex | [Code review](https://learn.chatgpt.com/docs/code-review) | fetched 2026-08-03 |
| Codex | [Local environments](https://learn.chatgpt.com/docs/environments/local-environment) | fetched 2026-08-03 |
| Codex | [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees) | fetched 2026-08-03 |
| Codex | [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) | fetched 2026-08-03 |
| Codex | [Changelog](https://learn.chatgpt.com/docs/changelog) — multi-repo review (26.727), multi-folder projects | 2026-07-30, 2026-07-23 |
| Claude Code | [Commands reference](https://code.claude.com/docs/en/commands) — `/diff`, `/code-review`, `/batch` | fetched 2026-08-03 |
| Claude Code | [Checkpointing](https://code.claude.com/docs/en/checkpointing) — `/rewind` | fetched 2026-08-03 |
| Claude Code | [Desktop application](https://code.claude.com/docs/en/desktop) | fetched 2026-08-03 |
| Claude Code | [Worktrees](https://code.claude.com/docs/en/worktrees) | fetched 2026-08-03 |

Community sources are linked inline at the point of use.

---

## Summary matrix

Short verdicts only; the detail sections below carry the quotes and citations.

| # | Capability | Cursor | Codex | Claude Code | BrainStrike planned |
| --- | --- | --- | --- | --- | --- |
| 1 | Diff scopes | Turn review + Source Control; no named scope picker (**unverified**) | **Best in class** — Unstaged / Staged / Commit / Branch / Last turn | `/diff`: git diff ⟷ per-turn; no staged/branch picker (**unverified**) | Superset: 6 git scopes + agent-run + run-range (§3, §5) |
| 2 | Multi-file navigation | PR-style view; per-file bar in editor chrome | Stacked scroll, sticky headers, collapsed unmodified lines | File list → one file at a time (CLI + desktop) | Stacked + sticky headers, explicitly Codex-modelled (§5) |
| 3 | Changed-files presentation | SCM panel + chat change summary | Flat per-repo list + repo selector; workspace file tree with dirty badges | Flat list, no selection model | **Tree** root→repo→worktree→dir, tri-state selection drives rendering + bulk actions (§5) |
| 4 | Multi-root / multi-repo | Multi-root workspaces (3.2); SCM gaps reported | Multi-folder projects w/ **primary folder** owning git; cross-repo review pane | Single project root per session | Native peer repos, no primary-folder asymmetry (§1, §3, §4) |
| 5 | Worktree visibility & mgmt | Full lifecycle: create, promote, apply, delete, cleanup | Full lifecycle: per-thread, branch-here, hand off, restore, cap 15 | Full lifecycle: `--worktree`, auto per session, archive, sweep | **Visibility + provenance only**; no lifecycle ops (§3, §4) |
| 6 | Agent-change attribution | Per-message change summary; checkpoint per request | "Last turn" scope + per-turn edited-files card | `/diff` arrows across **individual Claude turns** | Journal-backed `agent-run` / `run-range`, git-independent (§3, §4) |
| 7 | Conversation revert | Files-only per docs; message coupling **unverified**; no redo | Files-only Undo; no conversation rewind; no redo | Code / conversation / **both**; no redo | Coupled + **one-level redo** + revert previewed as a changeset (§2, §4) |
| 8 | Commit/push from review | Stage, commit, manage PRs from diffs view | Commit, push branch, open PR in-app | PR + CI status bar (auto-fix/auto-merge); no commit UI in diff pane | "Commit or push" button; **no PR creation** (§5) |
| 9 | Partial application | Per-file Keep/Undo + per-block accept/reject *(community)* | **Three levels: all / file / hunk** | Pre-apply accept-reject in Manual mode; post-apply is whole-turn | **None by design** — settled concession (§2) |
| 10 | Live refresh | "changes as they happen" | Reflects git state; live mid-run refresh **unverified** | `/diff` auto-refreshes on external git change (v2.1.198) | Watcher on `.git` + working tree, no polling; agent-run refreshes at `onRunFinished` (§6) |

---

## Row detail

### 1. Diff scopes offered

**Cursor** — Review is anchored on the agent turn: after a task, the review bar
lets you inspect that turn's changes; for everything else, "open the Source
Control tab and run Agent Review to compare against your main branch"
*(docs, [agent/review](https://cursor.com/docs/agent/review))*. The 3.0 diffs
view supports staging *(docs, [blog/cursor-3](https://cursor.com/blog/cursor-3),
2026-04-02)*, which implies a staged/unstaged split, but a **named scope picker
comparable to Codex's is unverified**.

**Codex** — The most complete scope model shipping today. The review pane
defaults to **Unstaged**, with **Staged** (git index), **Commit** (a selected
commit), **Branch** (diff against base branch), and **Last turn** (the most
recent assistant turn) *(docs,
[code-review](https://learn.chatgpt.com/docs/code-review))*. Critically, the
docs state the pane "reflects the state of your Git repository, not just what
Codex edited" — it deliberately includes the user's own edits. The CLI mirrors
this with `/review` presets: base branch, uncommitted changes, a commit, or
custom instructions *(docs, [codex/cli](https://learn.chatgpt.com/docs/codex/cli))*.
Scope dropdown labels observed in the shipping app: Last Turn / Uncommitted /
Unstaged / Staged / Committed / Branch *(observed)*.

**Claude Code** — `/diff` opens "an interactive diff viewer showing uncommitted
changes and per-turn diffs. Use left/right arrows to switch between the current
git diff and individual Claude turns" *(docs,
[commands](https://code.claude.com/docs/en/commands))*. That is two scope
families — uncommitted, and any individual turn — with **no documented
staged / commit / branch-vs-base selector (unverified)**. The desktop diff view
shows the session's changes; a scope selector there is **unverified**.

**BrainStrike planned** — §3 defines `Changeset` as a discriminated union of
`agent-run`, `run-range`, and `git-scope` with
`scope: 'uncommitted' | 'unstaged' | 'staged' | 'branch-vs-base' | 'commit'`;
§5 names the header source picker "Last Turn, Uncommitted, Unstaged, Staged,
Committed, Branch". This is Codex's set plus `run-range`, which none of the three
offers. **Verdict: superset.**

### 2. Multi-file diff navigation

**Cursor** — Finished agent output appears as "diffs in a PR-style view"
*(docs, [blog/cursor-3](https://cursor.com/blog/cursor-3), 2026-04-02)*. In the
editor, the per-file review bar (file counter, Undo File, Keep File) sits at the
top of the editor next to the breadcrumbs
*(community, [forum](https://forum.cursor.com/t/agent-multi-file-review-controls-appear-in-the-editor-tab-breadcrumb-area-i-want-the-bottom-undo-keep-style-back-or-a-setting-to-choose/155718))* —
i.e. navigation is file-at-a-time through editor tabs. **Continuous stacked
scroll with sticky headers: unverified.**

**Codex** — Stacked multi-file diff with sticky per-file headers and expandable
"N unmodified lines" collapses *(observed)*. Docs corroborate the interaction
model: clicking the filename background "expands/collapses the diff", clicking
the filename itself opens the file in your editor, and `Cmd`+click on a line
opens that line *(docs, [code-review](https://learn.chatgpt.com/docs/code-review))*.

**Claude Code** — Explicitly file-by-file. CLI: "up/down to browse files. Press
Enter to open the selected file's diff … press Esc to return to the file list"
*(docs, [commands](https://code.claude.com/docs/en/commands))*. Desktop: "the
diff view lets you review modifications file by file … a file list on the left
and the changes for each file on the right" *(docs,
[desktop](https://code.claude.com/docs/en/desktop))*.

**BrainStrike planned** — §5 diff pane: "Multi-file stacked sections with sticky
per-file headers (Codex-style scroll)". §3 `StructuredFileDiff` is the enabler —
it replaces the unified-diff-string contract with both-sides content plus
structured hunk ranges, explicitly to fix the two documented `DiffView`
limitations (hunk-relative line numbers; single-file-only).
**Verdict: parity with Codex, ahead of Cursor and Claude Code.**

### 3. Changed-files presentation & selection semantics

**Cursor** — The VS Code-derived Source Control panel plus a per-message change
summary in chat; "selecting filenames directly from change summary focuses that
file in the review pane" *(community,
[forum](https://forum.cursor.com/t/only-some-diffs-are-shown-whhen-agent-makes-changes/152099))*.
Tree-vs-list toggle and any checkbox selection model in the new diffs view:
**unverified**.

**Codex** — Flat changed-file list per repository with per-file +/− counts and a
"Show N more files" truncation *(observed)*; a repository selector in the review
pane header switches between repos in a multi-folder project *(docs,
[code-review](https://learn.chatgpt.com/docs/code-review))*. A separate
right-hand workspace file tree carries per-file dirty badges *(observed)* — so
the tree and the changed-file list are two different surfaces. Selection
semantics are expand/collapse, not a selection set that scopes actions.

**Claude Code** — Flat file list in both surfaces (see row 2). No tree, no
multi-select, no selection-scoped bulk action documented.

**BrainStrike planned** — §5: "Changed-files tree — canonical `TreeTable`; files
grouped root → repo → worktree → directory; tri-state via existing
`getCheckboxState` / `onCheckboxChange` seams. Selection drives which diffs
render and scopes bulk actions." Adapters feed identity-stable `TreeNode`s per
the pinned render-stability convention.
**Verdict: differentiator — none of the three ships a hierarchical, selection-driven changed-files tree.**

### 4. Multi-root / multi-repo awareness

**Cursor** — Multi-root workspaces shipped in 3.2: "A single agent session can
now target a reusable workspace made of multiple folders", enabling "cross-repo
changes spanning frontend, backend, and shared libraries, without retargeting
the agent every time it moves between repos" *(docs,
[changelog/04-24-26](https://cursor.com/changelog/04-24-26), 2026-04-24)*. Cloud
agents gained multi-repo environments shortly after *(docs,
[changelog/05-13-26](https://cursor.com/changelog/05-13-26), 2026-05-13)*. The
**review** side lags the agent side: multiple 2026 forum reports describe the
Source Control / changes view failing to enumerate all repos in a multi-root
workspace *(community,
[forum](https://forum.cursor.com/t/unable-to-view-changes-for-multi-root-workspaces/167005),
[forum](https://forum.cursor.com/t/git-source-control-not-detected-in-multi-root-code-workspace/158147))*.

**Codex** — Multi-folder local projects landed 2026-07-23 with an explicit
asymmetry: one designated **primary folder** is the Git root and owns Git
operations, PRs, review, and `AGENTS.md` / skills / `config.toml` discovery;
secondary folders remain readable, writable, and searchable *(docs,
[changelog](https://learn.chatgpt.com/docs/changelog), 2026-07-23;
[local-environment](https://learn.chatgpt.com/docs/environments/local-environment))*.
Review caught up a week later: "See all repositories in a multi-folder project
and the lines changed in each one. Select **Review** to inspect diffs across
those repositories without switching between separate review views"
*(docs, [changelog](https://learn.chatgpt.com/docs/changelog) 26.727, 2026-07-30)* —
still a repository selector over per-repo diffs, under one privileged Git root.

**Claude Code** — A session targets one project folder (and its worktree).
Nothing in the desktop or CLI docs describes a multi-root workspace or a
cross-repo change view; the preview-server docs note that subfolders with their
own servers are not auto-detected from a parent folder, which is the closest the
docs come to acknowledging nested projects *(docs,
[desktop](https://code.claude.com/docs/en/desktop))*.
**Multi-repo review: absent as documented.**

**BrainStrike planned** — §1 states the goal directly: visibility "across the
whole workspace: multiple workspace roots, multiple git repositories, multiple
worktrees". §3 `GitInventory` is "a snapshot of all repositories + worktrees
discovered across `activeRootIds`, plus followed out-of-root worktrees"; §4
`GitInventoryService` walks each root, enumerates worktrees per repo, follows
pointers outside roots, and merges agent-reported workspaces. §5 groups the file
tree root → repo → worktree → directory. Repos are **peers**; there is no
primary-folder privilege.
**Verdict: ahead of all three on the review surface, though Cursor's agent-side multi-root is more mature than BrainStrike's (which does not exist yet).**

### 5. Worktree visibility & management

**Cursor** — Worktrees are first-class in the Agents Window: agents "run
isolated tasks in the background across different branches", and you can "move
any branch into your local foreground with one click" *(docs,
[changelog/04-24-26](https://cursor.com/changelog/04-24-26), 2026-04-24)*.
Lifecycle commands `/worktree`, `/apply-worktree`, `/delete-worktree`;
per-worktree setup via `.cursor/worktrees.json`; automatic cleanup governed by
`cursor.worktreeCleanupIntervalHours` and `cursor.worktreeMaxCount` (default 25);
`/best-of-n` gives each model run its own worktree *(docs,
[worktrees](https://cursor.com/docs/configuration/worktrees))*.

**Codex** — One worktree per thread: "Each chat keeps the same associated
worktree over time." Codex works in a detached HEAD by default; **Create branch
here** converts it to a real branch; **Hand off** moves a chat between the
worktree and Local; **Open** launches your IDE at the worktree; permanent
worktrees are created from a project's three-dot menu; Codex retains the 15 most
recent managed worktrees and offers restore after deletion; the worktree root is
configured under **Settings > Worktrees** *(docs,
[git-worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees))*.
The `<branch> → origin/main` chip in the thread header is the surfaced form of
this model *(observed)*.

**Claude Code** — `claude --worktree <name>` creates `.claude/worktrees/<name>/`
on branch `worktree-<name>`; in the desktop app "every new session gets its own
worktree automatically"; sidebar hover exposes an archive icon, plus
**Auto-archive after PR merge or close**; **Settings → Claude Code** sets
"Worktree location" and a branch prefix; `worktree.baseRef` chooses `fresh`
(remote default branch) or `head`; `--worktree "#1234"` branches from a PR;
subagents opt in with `isolation: worktree`; a periodic sweep removes stale
subagent/background worktrees but skips any holding work, and running agents are
protected by `git worktree lock` *(docs,
[worktrees](https://code.claude.com/docs/en/worktrees),
[desktop](https://code.claude.com/docs/en/desktop))*. Notably, `EnterWorktree`
into a path outside `.claude/worktrees/` always prompts for approval and cannot
be suppressed by a permission rule — a containment posture close in spirit to
the spec's §4 security rule.

**BrainStrike planned** — §3 `WorktreeDescriptor` extends `GitWorktreeSummary`
with `containment: rootId[] | 'outside-roots'` and
`provenance: 'scanned' | 'agent-reported' | 'both'`. §4 follows
`git worktree list` pointers anywhere and merges agent-reported workspaces from
the journal; the security rule makes an out-of-root path accessible **only** if
it is a linked worktree of a repo inside a granted root, and otherwise surfaces
it as **visible-but-locked**. §5 adds a `worktree` `ContextTarget` kind.
**Verdict: richer *model* than all three (containment + provenance are unique), but strictly less *capability* — the spec has no create / promote / hand-off / archive operations. See parity gap 1.**

### 6. Agent-change attribution

**Cursor** — Attribution is per-request: checkpoints are created per request and
each message carries a change summary whose filenames focus the review pane
*(docs, [checkpoints](https://cursor.com/docs/agent/chat/checkpoints);
community, [forum](https://forum.cursor.com/t/only-some-diffs-are-shown-whhen-agent-makes-changes/152099))*.
Whether an arbitrary historical turn's diff can be re-opened as a diff view (as
opposed to restored) is **unverified**.

**Codex** — The **Last turn** scope shows "the assistant's latest changes across
the attached repositories" *(docs,
[code-review](https://learn.chatgpt.com/docs/code-review))*, and each turn
renders an "Edited 12 files +721 −305" card with per-file counts *(observed)*.
Attribution is therefore strong for the *latest* turn and weak historically —
and the pane is git-derived, so it cannot distinguish agent edits from the
user's own within a scope.

**Claude Code** — The strongest historical attribution of the three: `/diff`
uses left/right arrows to switch "between the current git diff and individual
Claude turns" *(docs, [commands](https://code.claude.com/docs/en/commands))*,
i.e. any turn in the session is addressable as its own diff. This is backed by
the checkpoint snapshots (100 most recent per session), not by git. Desktop
surfaces a `+12 -1` diff-stats indicator per change set *(docs,
[desktop](https://code.claude.com/docs/en/desktop))*.

**BrainStrike planned** — §3 makes attribution the *primary* unit rather than a
scope: `{ kind: 'agent-run', runId, threadId }` sourced "from the edit-checkpoint
journal; works without git (agent edited outside any repo)", plus
`{ kind: 'run-range', threadId, fromRunId, toRunId? }` for aggregates. §4
`ChangesetDiffService` "joins journal before-content/hashes with current disk
state — git-independent". §5 adds an "Edited N files → Review" card on assistant
runs that opens the surface pre-filtered to that run.
**Verdict: parity with Claude Code on per-turn addressing, ahead on run-range aggregation and on working outside git entirely.**

### 7. Conversation revert (files-only vs coupled; redo)

**Cursor** — Checkpoints "capture the state of all modified files"; you "click
any checkpoint in the chat timeline to preview your files at that point, then
restore to revert all files to that state", also via a **Restore Checkpoint**
button on previous requests or the **+** button on message hover. They are
"stored locally and separate from Git" *(docs,
[checkpoints](https://cursor.com/docs/agent/chat/checkpoints))*. The docs
describe **file** reversion only; whether messages after the checkpoint are
removed is **unverified** (one forum report describes chat history disappearing
after a restore-and-restart, which is a bug report, not a spec *(community,
[forum](https://forum.cursor.com/t/how-to-recover-chat-history-from-cursor-files/90272))*).
**Redo: unverified / not documented.**

**Codex** — A per-turn **Undo** button exists *(observed)*, and it is files-only:
there is no documented conversation rewind, no redo, and an open discussion
titled "How is there not a /rewind or /revert feature?" plus feature requests to
restore `/undo` and add `/redo` with change-set (not per-file) semantics
*(community, [openai/codex#9618](https://github.com/openai/codex/discussions/9618),
[#16784](https://github.com/openai/codex/issues/16784))*. Reliability is
contested — reported failures include a "Failed to revert changes" toast and
Undo unexpectedly staging changes into git *(community,
[#7306](https://github.com/openai/codex/issues/7306),
[#5082](https://github.com/openai/codex/issues/5082))*.
**Weakest of the three.**

**Claude Code** — The only shipping product with a genuinely coupled model.
`/rewind` (or double-`Esc` on an empty prompt) lists every prompt in the session
and offers **Restore code and conversation**, **Restore conversation**,
**Restore code**, **Summarize from here**, **Summarize up to here**, and **Never
mind**; the code options appear only when the checkpoint has tracked file
changes. Checkpoints are created per user prompt, retained for the 100 most
recent, saved with the conversation so `/rewind` survives a resume, and deleted
with the session after 30 days *(docs,
[checkpointing](https://code.claude.com/docs/en/checkpointing))*. Documented
limits are substantial and directly relevant to the spec: bash-command file
changes are not tracked, subagent edits are not restored, external/concurrent
edits are not captured, and symlinked or hard-linked paths are skipped with a
"Restored the code, but skipped N files" warning. **No redo.**

**BrainStrike planned** — §2 settles "**Soft rewind**: tombstone messages after
checkpoint, one-level redo until next user message finalizes; files revert via
journal range-revert". §4 `ConversationRevertService` orchestrates journal
range-revert (newest-first across runs, per-file hash conflict detection) and
message tombstoning "as one operation with honest partial failure (conflicting
files listed, never silently skipped)"; the journal gains **revert-time
after-capture** so the revert is itself journaled and re-revertible. §1 notes the
preview surface for this is the diff viewer; §5 shows the run-range changeset in
the revert confirmation.
**Verdict: ahead of all three — coupled like Claude Code, plus redo (nobody has it), plus a diff preview of the revert (nobody has it), plus acknowledged conflicts instead of silent skips.**

### 8. Commit / push from the review surface

**Cursor** — From the diffs view: "you can stage, commit, and manage PRs"
*(docs, [blog/cursor-3](https://cursor.com/blog/cursor-3), 2026-04-02)*. Commit
messages can be generated from the staged diff via the sparkle icon in the
commit input *(docs, [help/integrations/git](https://cursor.com/help/integrations/git))*.
From a finished worktree you can "create a commit or PR from that checkout"
*(docs, [worktrees](https://cursor.com/docs/configuration/worktrees))*.

**Codex** — "Commit changes, push a branch, and create a pull request without
leaving the app" *(docs,
[local-environment](https://learn.chatgpt.com/docs/environments/local-environment))*;
the worktree docs repeat commit / push / open-PR-on-GitHub. The observed control
is a single **Commit or push** button on the review surface *(observed)*.

**Claude Code** — Desktop creates PRs (via `gh`) and then shows a CI status bar
with **Auto-fix** and **Auto-merge** toggles and desktop notifications when CI
finishes *(docs, [desktop](https://code.claude.com/docs/en/desktop))*. There is
**no documented commit button inside the diff pane** — committing is done by
asking Claude or via the integrated terminal. So Claude Code is *ahead* on
post-PR monitoring and *behind* on in-pane commit.

**BrainStrike planned** — §5 header carries "turn-level actions (Undo / Revert
to here, **Commit or push**) gated by kind".
**Verdict: parity on commit/push; behind on PR creation (all three) and on CI monitoring (Claude Code). See parity gap 3.**

### 9. Partial application (per-hunk / per-file accept-reject)

**Cursor** — Per-file **Undo File** / **Keep File** controls in the multi-file
review bar, and block-by-block accept/reject navigation through applied changes
*(community,
[forum](https://forum.cursor.com/t/agent-multi-file-review-controls-appear-in-the-editor-tab-breadcrumb-area-i-want-the-bottom-undo-keep-style-back-or-a-setting-to-choose/155718),
[forum](https://forum.cursor.com/t/keyboard-and-ui-navigate-changes/17216))*.
Both are community-sourced; the current official docs page for review does not
specify accept/reject granularity, and the surface has visibly churned across
2.x/3.x releases *(community, several 2026 regression reports)*.

**Codex** — The clearest documented model: control at "three levels: entire diff
(header buttons like **Stage all** or **Revert all**), per-file, or per-hunk",
and separately "stage or revert individual chunks, stage or revert entire files"
*(docs, [code-review](https://learn.chatgpt.com/docs/code-review),
[local-environment](https://learn.chatgpt.com/docs/environments/local-environment))*.
**This is the strongest competitor capability in the entire matrix.**

**Claude Code** — Granularity is *pre*-application, not post: in Manual
permission mode "Claude asks before editing files or running commands. You see a
diff and can accept or reject each change" *(docs,
[desktop](https://code.claude.com/docs/en/desktop))*. Once changes are on disk,
the only rollback granularity is a checkpoint, i.e. whole-turn. There is no
per-hunk staging UI.

**BrainStrike planned** — §2, settled: "Interactivity scope | Review +
turn-level actions (undo/revert, commit/push). **No per-hunk staging in this
project**." See the framing in parity gap 6 — this is a deliberate concession,
not an oversight.

### 10. Live refresh while an agent is working

**Cursor** — "The diff view shows changes as they happen", with a **Stop**
control (`Cmd Shift Backspace`) to intervene mid-run *(docs,
[agent/review](https://cursor.com/docs/agent/review))*. Best-in-class for
mid-turn liveness.

**Codex** — The review pane "reflects the state of your Git repository", which
implies re-derivation on read, but **whether it auto-refreshes during an active
run is unverified** — no changelog or docs statement was found.

**Claude Code** — "As of v2.1.198, the open viewer also refreshes automatically
when the repository's git state changes outside the session, such as a branch
switch or commit in another terminal" *(docs,
[commands](https://code.claude.com/docs/en/commands))*. Desktop's diff-stats
indicator appears as Claude changes files *(docs,
[desktop](https://code.claude.com/docs/en/desktop))*.

**BrainStrike planned** — §6: a main-process watcher on `.git` metadata (HEAD,
index, refs) per discovered repo, plus the existing debounced refresh pipeline
for working-tree content; one event channel; renderer refetches behind a
monotonic generation guard; "**No polling**." Agent-run changesets refresh on the
existing `onRunFinished` lifecycle seam.
**Verdict: parity or better for git-scope changesets (the external-change case Claude Code documents); *behind Cursor* for agent-run changesets, which update at run boundaries rather than as edits land. See parity gap 2.**

---

## Parity gaps

They have it, the spec doesn't. Ordered by recommended action, with a scoping
call on each.

**1. Worktree lifecycle operations — real gap, partial scope addition recommended.**
All three ship create / promote / hand-off / archive (Cursor `/apply-worktree`
and one-click foreground promotion; Codex **Create branch here**, **Hand off**,
**Open**, restore-after-delete; Claude Code auto-per-session worktrees, archive
icon, auto-archive on PR close). §3/§4 give BrainStrike a *richer descriptor*
(containment + provenance) but **zero operations**. Recommendation: add two cheap
actions on the `worktree` `ContextTarget` §5 already introduces — "Open in…" and
"Add as workspace root" (which is also the unlock path for the visible-but-locked
state in §4). Defer create/promote/archive; those are a worktree-management
project, not a diff-viewer project, and building them here would blow W2's scope.

**2. Mid-turn live diff for agent-run changesets — real gap, cheap fix, recommend fixing.**
Cursor shows "changes as they happen"; §6 refreshes agent-run changesets on
`onRunFinished`, so a user watching a long run sees nothing until it ends. The
journal already writes per-edit before/after captures (§4), so the refresh signal
exists — it needs to be emitted on the existing `changes` event channel behind
the same generation guard, not a new pipeline. Recommendation: fold into W3 as an
explicit acceptance criterion; do not let it become a later "polish" ticket,
because retrofitting a second event cadence onto a shipped store is worse than
designing for two.

**3. PR creation and CI monitoring from the review surface — gap, recommend explicit out-of-scope.**
Codex opens PRs in-app; Claude Code opens PRs *and* then polls checks with
Auto-fix / Auto-merge toggles; Cursor manages PRs from the diffs view. §5 stops
at "Commit or push". This is a genuine competitive shortfall, but it pulls in a
GitHub auth/`gh` dependency that has nothing to do with changeset resolution.
Recommendation: state it as deliberately out of scope in the §2 decisions table
so it is not silently missing, and file it as a follow-on project.

**4. Inline review comments on diff lines routed back to the agent — gap, strongest candidate scope addition.**
All three have it: Codex hover-**+** on any line to attach feedback "to guide
Codex toward precise fixes"; Claude Code desktop click-a-line to comment, then
`Cmd+Enter` to submit all comments at once, after which "Claude reads your
comments and makes the requested changes, which appear as a new diff"; Cursor's
iPad review screen covers "comments, checks, and approvals". The spec has **no**
comment affordance anywhere in §5. This is the highest-leverage addition on the
list: the diff pane already owns line-level rendering once `StructuredFileDiff`
lands (§3), and the payload is just `(file, line, text)` handed to the composer.
Recommendation: scope into W4 as a stretch, or file immediately after it.

**5. Review pane reflects repo state, not only agent edits — gap in *communication*, not capability.**
Codex documents plainly that its pane "includes changes made by Codex, changes
you made yourself, and any other uncommitted changes". The spec's `git-scope`
changesets inherit that property while `agent-run` / `run-range` deliberately do
not (§3). That asymmetry is correct, but invisible: a user who reads an
`agent-run` changeset as "everything I've changed" will ship an unreviewed edit.
Recommendation: require the §5 changeset header to state the provenance of the
active scope in words ("agent edits only" vs "all working-tree changes"). Cheap,
and it is exactly the kind of silent-degradation the repo's no-fallbacks rule
targets.

**6. Per-hunk accept/reject — KNOWN CONCESSION, not a gap to fix.**
Codex documents three-level staging (all / file / hunk) and Cursor has per-file
Keep/Undo plus per-block accept/reject. §2 settles the opposite: "Review +
turn-level actions … **No per-hunk staging in this project**." That decision is
recorded as settled and should not be relitigated during W1–W6. The reasons hold
up under this teardown: (a) per-hunk staging requires a git *index-mutation*
seam in the changeset engine, which the `Changeset` union deliberately does not
have — `agent-run` changesets are journal-derived and have no index at all, so
per-hunk staging would only work for half the union and would reintroduce
exactly the "some scopes silently do less" degradation the house rules forbid;
(b) it forces `StructuredFileDiff` to carry mutable per-hunk selection state,
complicating the contract W1 exists to simplify; (c) Claude Code — the closest
comparable in agent model — ships nothing more granular than whole-turn rollback
and does not appear to be losing on it. Revisit only on new evidence that
turn-level revert is too coarse in practice; if so, the cheaper first step is
per-*file* revert within a changeset (the tri-state selection in §5 already
expresses the selection set), not per-hunk staging.

**7. Agent-driven code review of the diff — adjacent, correctly out of scope.**
Cursor (**Review** → **Find Issues**, Bugbot), Codex (`/review` with presets),
and Claude Code (**Review code** button, `/code-review`) all bundle an LLM review
pass into the review surface. BrainStrike already has `/code-review` machinery
elsewhere; the gap is only that it is not *launchable from the diff surface*.
Recommendation: one context action wired to the existing review path, once W4
exists. Not a project-scoping concern.

---

## Differentiators

The spec has it, none of the three does.

**1. Cross-repo changeset as the primary unit (§1, §3 `Changeset`, §5 tree grouping).**
Codex's 2026-07-30 multi-repo review is per-repo diffs behind a repository
selector, under one privileged primary folder that owns all Git operations.
Cursor's multi-root workspace gives one agent session across folders but no
unified change unit, and its own Source Control view is reported to lose repos in
that configuration. Claude Code is single-root. **Nobody makes "what this run
changed, wherever those files live" the addressable object.** That is §1's stated
pivot and it is genuinely unoccupied ground.

**2. Out-of-root worktree provenance with a security posture (§3 `WorktreeDescriptor`, §4 security rule).**
All three create worktrees; none tells you where a worktree came from. §3's
`provenance: 'scanned' | 'agent-reported' | 'both'` and
`containment: rootId[] | 'outside-roots'`, plus §4's rule that an out-of-root
path is reachable **only** via a linked-worktree pointer from a repo inside a
granted root — with everything else shown **visible-but-locked** — has no
competitor analogue. Claude Code's unsuppressable `EnterWorktree` approval prompt
for out-of-`.claude/worktrees` paths is the nearest thing in the market, and it
is a permission gate, not an inventory with provenance.

**3. Journal-backed, git-independent review (§3 `agent-run`, §4 `ChangesetDiffService`).**
Codex's review pane is explicitly derived from git state. Cursor's and Claude
Code's checkpoints are non-git snapshots, but they feed *restore* only — neither
renders a checkpoint as a reviewable diff surface. BrainStrike's `agent-run`
changeset "works without git (agent edited outside any repo)" and resolves by
joining journal before-content/hashes against current disk. **It is the only
design here that can review an agent's edits in a directory that isn't a
repository.**

**4. Coupled revert with one-level redo, and a re-revertible history (§2, §4).**
Claude Code couples code and conversation but offers no redo. Cursor and Codex
are files-only. §4's revert-time after-capture — journaling the revert itself so
it can be reverted — is the mechanism that makes redo honest rather than a UI
affordance layered over a lossy operation. Nobody else has this.

**5. The revert is previewed as a diff before you commit to it (§1, §5).**
Cursor previews *files at a checkpoint*; Claude Code's `/rewind` shows a message
list. Neither shows "here is the diff this restore will apply". §5 opens the
conversation-revert confirmation on the `run-range` changeset — the same viewer,
same components. This falls directly out of differentiator 1 and costs almost
nothing once the run-range kind exists.

**6. Honest partial failure on revert (§4, §7).**
"Conflicting files listed, never silently skipped", with per-file hash conflict
detection and an acknowledgment-requiring conflict list. The market's best
current behaviour is Claude Code's "Restored the code, but skipped N files"
warning for symlinked paths — a notice, not a reconciliation. Codex's Undo, by
contrast, has open reports of failing opaquely and of staging changes as a side
effect. This is a small feature that will read as a large quality signal.

**7. Hierarchical, selection-driven changed-files tree (§5).**
All three ship flat changed-file lists. §5's `TreeTable` grouped
root → repo → worktree → directory, with tri-state checkboxes that both scope
bulk actions and determine which diffs render, is the only presentation in this
teardown that can express a multi-repo changeset without a repository dropdown.

---

## Residual unknowns

Recorded so they are not later mistaken for settled facts:

- Cursor: whether the 3.x diffs view exposes a named scope picker (staged /
  commit / branch) — **unverified**.
- Cursor: whether restoring a checkpoint removes conversation messages after that
  point — **unverified**; docs describe file reversion only.
- Cursor: whether the new diffs view uses continuous stacked scroll — **unverified**.
- Cursor: per-hunk and per-file accept/reject rest on community reports only; the
  surface has churned repeatedly across 2026 releases.
- Codex: whether the review pane auto-refreshes during an active run —
  **unverified**.
- Claude Code: whether the desktop diff pane offers any scope selector beyond the
  session's own changes — **unverified**.

Anyone re-running this teardown should re-check the Cursor items first; that
product's review surface moved three times in 2026 and is the likeliest to have
changed under this document.
