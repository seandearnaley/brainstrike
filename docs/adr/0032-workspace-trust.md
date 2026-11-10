# ADR-0032: Workspace trust: a folder's agent configuration loads only once trusted

- **Status:** Accepted
  - 2026-11-10 (BST-2340, [ADR-0034](0034-worktrees-are-thread-checkouts.md) decision 6): a managed
    worktree shares its repository's answer.
  - 2026-11-10 (BST-2340): project hook approval is recorded for the repository and the file's
    hash, so a managed worktree shares it too.
  - 2026-11-10 (BST-2340): the composer asks with a chip, only about the thread's own folders and
    once per answer.
  - 2026-11-10 (owner decisions, below): trusted locations, folders the app makes, and no
    access-mode cap for an untrusted folder (BST-2341).
- **Date:** 2026-10-30
- **Ticket:** BST-2337 (BST-2338, BST-2339)
- **Supersedes:** the **Trust** bullet of [ADR-0016](0016-workspace-trust-and-ignore-chain.md)

## Context

- ADR-0016 loaded each mounted root's AGENTS.md/AGENT.md/CLAUDE.md and Agent Skills by default,
  with no per-root gate, as an accepted risk. Project slash commands and subagent personas loaded
  the same way.
- So a freshly cloned repository steered the assistant the moment its folder was opened: its
  instructions joined the system prompt, its skills joined the catalog and the "/" menu, and its
  personas became delegation tools.

The tools that load a repository's own agent configuration all ask first, in the same shape (read
on 2026-10-30):

- **VS Code Workspace Trust** opens an unfamiliar folder in Restricted Mode and
  asks once per folder. A folder you don't trust still opens for browsing and
  editing; only workspace settings, tasks, debugging and untrusted extensions
  are held back. Trust is kept per folder and is never something the folder can
  grant itself.
- **Claude Code** shows a trust dialog the first time it runs in a folder and
  records the answer for the project (`hasTrustDialogAccepted`). Until then the
  folder's `CLAUDE.md`, settings and hooks do not run.
- **Codex** keeps a `trust_level` per project. An untrusted project's
  `.codex/` configuration is skipped.

None asks again when files change. Each keys the answer to the folder's
location, and none lets a folder approve itself.

## Decision

- **One answer per folder.** The agent host's StateStore settings record
  `workspace.trust/<canonical path>` as `trusted` or `restricted`. No record means
  `undecided`. The path is the folder's canonical path (`canonicalRoot`, the
  identity data roots use), so a symlink, a trailing slash or another case
  spelling of one folder shares one answer. A subfolder has its own answer. A
  managed worktree shares its repository's answer: the answer is kept for the
  repository's primary checkout, and reading or recording it through the
  worktree's path reaches that one record. A folder answered before the ledger
  listed it as a worktree keeps a record of its own, which would answer again
  if it stopped being one, so an answer recorded through a managed worktree
  removes that folder's own record. The
  host is the only writer (`workspace/trust`), for every client origin, as
  `hooks/trust` is, so the desktop and the CLI record answers the same way.
  Factory reset clears answers with every other setting.
- **Only `trusted` loads agent configuration.** The roots a run passes to its
  workspace instructions, project skills (prompt catalog and skill tools),
  project slash commands and subagent personas are the trusted ones. An
  undecided or restricted folder still mounts, and the assistant still reads,
  searches and edits it under the access mode and permission policy. Home
  directory tiers (`~/.brainstrike`, `~/.claude`) are the person's own and load
  as before.
- **Ask once, restricted rather than refused.** The composer of a root thread
  shows a chip in its workspace bar while one of the thread's own folders holds
  agent configuration and has no answer yet. The chip counts what is held, by
  the same scans a run uses (`workspace/trust/list`), and opens to the question:
  what trusting the folder would load, with "Trust folder" and "Keep
  restricted". Both record an answer, so the chip doesn't come back. Nothing
  waits on it: a run sent before an answer simply leaves the folder's
  configuration out. Settings › Workspace trust lists every answer behind the
  mounted folders and changes it. The standalone CLI records it with
  `workspace trust [<dir>] [--yes]`.
  - A thread's own folders are the ones its runs read configuration from: its
    operating folder and secondaries, or every open folder while it has none. A
    folder open for another thread is not asked about.
  - There is one question per answer. A managed worktree and its repository
    share one, so they are asked about once, under the repository's name, and
    Settings shows the worktree under its repository's row.
- **Hooks and setup scripts keep their own pins.** Project hooks
  (`hooks/trust`) and the worktree setup script stay approved by their exact
  file hash. Their content runs commands, so editing them must ask again. Workspace
  trust gates instructions, which were never pinned to content, in the same way
  the vendors above gate them.
  - A hook approval is recorded for the folder that answers for the root (the
    same folder as for workspace trust, so a managed worktree shares its
    repository's) and for the file's hash: `hooks.approved/<canonical path>`
    holds the hash of the one version the person last reviewed there.
  - A root's hooks run when its file's bytes are that version. So a new
    worktree holding the reviewed bytes does not ask, and an edited file asks
    wherever it is.
  - Approving another version replaces the earlier one for the repository, as
    it always did for a root. A checkout still holding the earlier bytes is
    then reported as changed until it catches up, and going back to an earlier
    version needs a new review.
  - Revoking removes the repository's approval, from any checkout. A folder
    approved before the ledger listed it as a worktree keeps a record of its
    own, which would answer again if it stopped being one. So an approval
    given in a managed worktree removes that folder's own record, and a revoke
    removes the own record of every worktree the ledger lists for the
    repository.
- **A repository's own git filters wait for trust too** (BST-2454, owner
  decision 2026-11-10). A repository's config can name `filter.<driver>`
  clean, smudge and process commands that git runs whenever it reads or
  writes the working tree. Every git command the host runs in a folder that is
  not trusted, or not inside a trusted one, empties the filter commands that
  came from the repository's own config and marks those drivers not required.
  Filters from the person's global or system config, such as Git LFS, still
  run, and a trusted folder's run as git runs them. The overrides go in as
  `GIT_CONFIG_KEY_<n>`, which git takes whole, so no driver name can split
  one. Git also runs `git status` inside each checked-out submodule and each
  repository cloned inside this one, so their own filter commands are emptied
  the same way. The nearest mounted folder with an answer decides, so a folder
  kept restricted inside a trusted one stays restricted.

## Consequences

- A repository whose filter lives only in its own config, such as git-crypt or
  `git lfs install --local`, shows its stored form in Changes until the folder
  is trusted.
- A cloned repository steers nothing until the person trusts it. Every existing
  folder starts undecided, so its instructions and skills stop loading until it
  is trusted once. The composer's chip says so where the person works.
- The "/" menu and Settings › Skills list only trusted folders' project skills and
  commands. Settings › Subagents and Settings › Workspace instructions still list
  every mounted folder's files (Main reads them). Marking the files that won't
  load is follow-up work (BST-2344).
- An answer recorded by another client, such as the CLI, reaches an open
  desktop's "/" menu and chip on their next reload, such as when a folder is
  added or the thread is reopened (BST-2344).
- A managed worktree of a trusted repository is trusted, and one of a restricted
  repository is restricted, so a new worktree does not ask again (BST-2340).
  - A folder is a managed worktree only while two records agree: the host's
    worktree ledger lists it, and git's two links still join it to that
    repository (the folder's `.git` names an admin directory under the
    repository's common dir, which names the folder's `.git` back). A folder
    cannot write the repository's link and a repository cannot write the
    folder's, so neither can claim the other.
  - Otherwise the folder has its own answer: an archived worktree, a folder the
    ledger lists but git no longer links, and another repository put where a
    worktree was.
  - The answer is kept for the folder that holds the repository's `.git`. A
    repository whose git directory lives elsewhere (a bare repository, a
    submodule, `--separate-git-dir`) keeps one answer for its worktrees, apart
    from its primary checkout's.
  - `workspace/trust/list` names the folder that answers for each mounted
    folder (`answeredBy`), read with the answer it shows, so the composer and
    Settings group a mounted worktree under its repository and give the answer
    for the repository.
- Hook approvals recorded before 2026-11-10 were kept per root id
  (`hooks.trust/<rootId>`) and are no longer read, so each repository's hooks
  are reviewed once more.
- Approving an edited hooks file in one worktree makes it the repository's
  version, so the hooks of checkouts still on the earlier bytes stop running,
  with the "changed" notice, until those checkouts hold the new bytes.
- An untrusted folder does not cap the access mode (owner decision 2026-11-10,
  BST-2341). This ADR leaves access modes (ADR-0031) unchanged.

## Owner decisions, 2026-11-10

Sean's answers to the trust questions the "Where Threads Live" brief left open.
They supersede the text above where they differ.

- **Trusted locations, opt-in.** The first trust ask offers to also trust
  everything in the folder's parent. A folder with no answer of its own is
  trusted when it lies inside a trusted location. An explicit answer, including
  restricted, still wins. Accepted cost: a hostile repository cloned into a
  trusted location by hand is trusted. Not built yet.
- **Folders the app makes are trusted with no question**: a project created in
  the app or a scratch folder, which has no repository answer to inherit. Never
  a folder that already existed. A managed worktree is not one of these: it
  still shares its repository's answer, whether trusted, restricted or
  undecided. Not built yet.
- **An untrusted folder does not cap the access mode** (BST-2341). A run keeps
  the access mode the composer shows, and the sandbox and permission policy
  still apply. The options not taken were capping at Ask, and capping at Ask
  while refusing Full.

## Sources

- VS Code, "Workspace Trust" (code.visualstudio.com/docs/editing/workspaces/workspace-trust).
- Claude Code, "Security" and "Settings" (code.claude.com/docs): the trust dialog
  and `hasTrustDialogAccepted`.
- Codex, "Configuration" (developers.openai.com/codex): `projects.<path>.trust_level`.
