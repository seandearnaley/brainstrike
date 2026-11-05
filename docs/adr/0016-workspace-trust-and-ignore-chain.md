# ADR-0016: Workspace inputs: trusted by default, filtered by one ignore chain

- **Status:** Accepted; the **Trust** bullet is superseded by [ADR-0032](0032-workspace-trust.md)
  - 2026-11-01 (BST-2436, [ADR-0035](0035-workspace-retrieval-is-live-search.md)): the workspace index is deleted, so the
    ignore chain no longer feeds index scans, indexed grep or semantic search. It binds the
    walks, live grep and readers that remain.
- **Date:** 2026-10-02
- **Ticket:** BST-1914

## Context

- The agent reads instructions from the user's workspace: each root's AGENTS.md/AGENT.md/CLAUDE.md,
  Agent Skills and user slash commands.
- It also walks the workspace for search and indexing, through an ignore chain built in BST-1427,
  BST-1431, BST-1432 and BST-1434.
- The reset's indexing work starts by honouring `.gitignore` and excluding copied trees: 96% of
  file records in the 673K-chunk development database were copies under `.claude/worktrees`.

## Decision

- **Trust.** *(Superseded by ADR-0032: a folder's instructions, skills, slash commands and
  personas load only once the person trusts the folder.)*
  - Workspace instructions and Agent Skills are on by default, with no per-root or per-skill trust
    gate.
  - Accepted risk: referenced-file injection is already ungated, skill content is instructions
    only, reads are SecureRoot-contained and bounded, and the permission engine's `edit` and
    `execute` ask defaults keep injected text from driving mutations.
- **Slash commands.** User slash commands never get shell expansion; `!`-command text stays inert.
- **Ignore chain.** One precedence order.
  - The gitignore sources lead, because a hand-maintained denylist falls behind silently.
  - The static policy floor stays, because a non-repo root has no `.gitignore`.
  - Layers 7-8 (`.llmignore`, then `.brainstrikeignore`) are a hard boundary that
    `includeIgnored` cannot bypass.
  - Directories are tested with a trailing slash.
  - `.llmignore` is enforced in JavaScript for both grep engines; `.gitignore` deliberately is not,
    because there is no second implementation to diverge from.

## Consequences

- Workspace instructions and skills were deferred on web, which lacked a workspace-tool bridge
  ([ADR-0008](0008-capability-based-feature-gating.md)). The web app has since been removed.
- File mutation tools refuse agent-ignored and credential paths with the read paths' refusal
  (BST-1433):
  - write, edit and delete refuse the target;
  - rename refuses either end, so a protected file can be neither clobbered nor moved somewhere
    readable.
- Adding an ignore source means placing it in the one precedence order, documented in the module
  note of `packages/utils/src/workspace-ignore-matcher.ts`
  ([explorer contract](../agents/explorer-search-context-map.md) § "Ignore and traversal policy").

## Sources

Contract markers this ADR replaces (line numbers at `43daec7fb`):

- `docs/agents/workspace-context.md:96` (workspace instructions default-on), `:343` (Agent Skills
  default-on), `:226` (no shell expansion).
- `docs/agents/explorer-search-context-map.md:386-389` (ignore-chain precedence), `:439`
  (`.llmignore` enforced for both grep engines).

## Amendment (2026-10-16): a credential floor beneath the ignore chain

- **Why:** live grep deliberately does not consult `.gitignore` (BST-1429), so a gitignored
  `.env.local` was searchable. In an OpenRouter smoke run a grep matched the comment above an API
  key, and one line of context carried the key into a tool result and on to the provider on
  every later step.
- **Owner decision:** credential files are a floor beneath every layer, enforced in the shared
  matcher (`isWorkspaceSecretFile`, `packages/utils`).
  - Patterns: `.env` and `.env.*` (not `.env.example`, `.env.sample` or `.env.template`),
    `*.pem`, `*.key`, `id_rsa*`. Matched without case; ripgrep's floor file spells each letter
    in both cases.
  - Not a ninth layer, because layers can be negated: no `!` pattern and no `includeIgnored`
    lifts it. It reads as hard, so no "retry with includeIgnored" advice is offered.
- **Where it binds:** wherever the matcher does — walks, both grep engines, direct reads (which
  refuse it by name as a credential file) and workspace index scans. Agent reads that bypass the
  walk check it too:
  - skill listings and reads;
  - line previews of language-server targets, and a hover whose symbol resolves into a credential
    file;
  - indexed grep and semantic search, which drop any credential chunk stored from before the
    floor.
- Shell commands remain governed by the execute permission.
