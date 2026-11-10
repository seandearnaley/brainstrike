# ADR-0032: Workspace trust: a folder's agent configuration loads only once trusted

- **Status:** Accepted
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
  spelling of one folder shares one answer. A subfolder has its own answer. The
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
  shows a non-blocking prompt for each mounted folder that holds agent
  configuration and has no answer yet. The prompt names what trusting the folder
  would load, counted by the same scans a run uses (`workspace/trust/list`).
  "Trust folder" and "Keep restricted" both record an answer, so the prompt
  doesn't come back. Nothing waits on the prompt: a run sent before an answer
  simply leaves the folder's configuration out. Settings › Workspace trust lists
  every mounted folder and changes the answer. The standalone CLI records it
  with `workspace trust [<dir>] [--yes]`.
- **Hooks and setup scripts keep their own pins.** Project hooks
  (`hooks/trust`) and the worktree setup script stay approved by their exact
  file hash. Their content runs commands, so editing them must ask again. Workspace
  trust gates instructions, which were never pinned to content, in the same way
  the vendors above gate them.
- **A repository's own git filters wait for trust too** (BST-2454, owner
  decision 2026-11-10). A repository's config can name `filter.<driver>`
  clean, smudge and process commands that git runs whenever it reads or
  writes the working tree. Every git command the host runs in a folder that is
  not trusted, or not inside a trusted one, empties the filter commands that
  came from the repository's own config and marks those drivers not required.
  Filters from the person's global or system config, such as Git LFS, still
  run, and a trusted folder's run as git runs them. The overrides go in as
  `GIT_CONFIG_KEY_<n>`, which git takes whole, so no driver name can split
  one. The nearest mounted folder with an answer decides, so a folder kept
  restricted inside a trusted one stays restricted.

## Consequences

- A repository whose filter lives only in its own config, such as git-crypt or
  `git lfs install --local`, shows its stored form in Changes until the folder
  is trusted.
- A cloned repository steers nothing until the person trusts it. Every existing
  folder starts undecided, so its instructions and skills stop loading until it
  is trusted once. The composer prompt says so where the person works.
- The "/" menu and Settings › Skills list only trusted folders' project skills and
  commands. Settings › Subagents and Settings › Workspace instructions still list
  every mounted folder's files (Main reads them). Marking the files that won't
  load is follow-up work (BST-2344).
- An answer recorded by another client, such as the CLI, reaches an open
  desktop's "/" menu and prompt on their next reload, such as when a folder is
  added or the thread is reopened (BST-2344).
- A managed worktree is a different folder, so it asks again (BST-2340).
- Whether an untrusted folder should also cap the access mode at Ask is a
  separate owner decision (BST-2341). This ADR leaves access modes (ADR-0031)
  unchanged.

## Sources

- VS Code, "Workspace Trust" (code.visualstudio.com/docs/editing/workspaces/workspace-trust).
- Claude Code, "Security" and "Settings" (code.claude.com/docs): the trust dialog
  and `hasTrustDialogAccepted`.
- Codex, "Configuration" (developers.openai.com/codex): `projects.<path>.trust_level`.
