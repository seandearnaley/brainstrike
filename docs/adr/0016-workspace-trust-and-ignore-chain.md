# ADR-0016: Workspace inputs: trusted by default, filtered by one ignore chain

- **Status:** Accepted
- **Date:** 2026-10-02
- **Ticket:** BST-1914

## Context

The agent reads instructions from the user's workspace: each root's
AGENTS.md/AGENT.md/CLAUDE.md, Agent Skills and user slash commands. It also walks the
workspace for search and indexing, through an ignore chain built in BST-1427,
BST-1431, BST-1432 and BST-1434. The reset's indexing work starts by honouring
`.gitignore` and excluding copied trees: 96% of file records in the 673K-chunk
development database were copies under `.claude/worktrees`.

## Decision

- **Trust.** Workspace instructions and Agent Skills are on by default, with no
  per-root or per-skill trust gate. This is an accepted risk: referenced-file
  injection is already ungated, skill content is instructions only, reads are
  SecureRoot-contained and bounded, and the permission engine's `edit` and `execute`
  ask defaults keep injected text from driving mutations.
- **Slash commands.** User slash commands never get shell expansion; `!`-command text
  stays inert.
- **Ignore chain.** One precedence order: the gitignore sources lead, because a
  hand-maintained denylist falls behind silently. The static policy floor stays,
  because a non-repo root has no `.gitignore`. Layers 7-8 (`.llmignore`, then
  `.brainstrikeignore`) are a hard boundary that `includeIgnored` cannot bypass.
  Directories are tested with a trailing slash.
- `.llmignore` is enforced in JavaScript for both grep engines, though `.gitignore`
  deliberately is not, because there is no second implementation to diverge from.

## Consequences

- Workspace instructions and skills stay deferred on web, which lacks a workspace-tool
  bridge (ADR-0008).
- File mutation tools do not yet consult the agent-ignore guard, so an agent can still
  write to an agent-ignored path (BST-1433).
- Adding an ignore source means placing it in the one precedence table in
  `docs/agents/explorer-search-tapestry.md`.

## Sources

Contract markers this ADR replaces (line numbers at `43daec7fb`):

- `docs/agents/workspace-context.md:96` (workspace instructions default-on), `:343`
  (Agent Skills default-on), `:226` (no shell expansion).
- `docs/agents/explorer-search-tapestry.md:386-389` (ignore-chain precedence),
  `:439` (`.llmignore` enforced for both grep engines).
