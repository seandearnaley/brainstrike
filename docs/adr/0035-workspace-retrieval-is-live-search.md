# ADR-0035: Workspace retrieval is live search; the derived index is removed

- **Status:** Accepted (Sean, 2026-11-01: option (c) of the BST-2428 retrieval
  decision, "delete the index, keep text search on live ripgrep")
- **Date:** 2026-11-01
- **Supersedes:** [ADR-0018](0018-derived-sqlite-indexer.md)
- **Amends:** [ADR-0026](0026-two-lane-agent-search.md) (the index no longer serves
  Explorer search; the retrieval and memory lanes lose their index) and
  [ADR-0029](0029-main-is-a-launcher.md) decision 5 and stage 5 (index activation is
  deleted, not moved)
- **Tickets:** BST-2428 (decision); BST-2434 (Explorer search on live ripgrep),
  BST-2435 (retrieval tools, semantic recall, hosted embeddings), BST-2436 (indexer,
  Main's index code, Search & Indexing settings, sqlite-vec)

## Context

The derived SQLite index (ADR-0018) backed the Explorer's Search tab, an opt-in
semantic mode, three retrieval tools and opt-in semantic recall. ADR-0026 had already
taken it out of the agent's core lane: grep, glob and read go to the disk. What was
left cost about 37k source and 39k test lines, two utility processes, a native add-on
(sqlite-vec) and a lifecycle rulebook that kept growing. Default profiles never saw the
semantic surfaces; the Search tab's Text mode was the one feature most users used, and
it showed an index that lagged the disk.

In 2026, Claude Code, Cursor, Codex CLI, Zed and Cline search with grep, glob and read
and keep no local index. Where semantic search survives, the vendor hosts it next to
grep (Copilot) or makes it opt-in infrastructure (Roo).

## Decision

1. **Workspace retrieval is live search.** The Explorer's Search tab and the agent's
   grep run one engine: the host's streaming ripgrep core in `host-capabilities`
   (`streamLiveGrep`). It applies the same entry policy, agent ignore files,
   credential floor and caps for both; the agent's grep collects its stream, the
   Explorer shows it as it arrives.
2. **The Explorer reaches it through the host.** `workspace/files/search` is gated to
   the desktop's private client like the rest of `workspace/files/*`. It searches every
   live root through its pinned handle. Matches stream as
   `workspace/files/search/batch` notifications on the caller's connection. Cancelling
   the request ends ripgrep, and no batch is sent after it. The answer names every
   cap the search hit: match cap, file cap, a regex with no literal text that hit the
   file cap, the time limit, and folders that could not be read.
3. **ripgrep ships with the app.** `@vscode/ripgrep` is a dependency of the desktop
   app and of the CLI host, and the packaged app unpacks its binary from the asar.
   There is no PATH lookup and no JavaScript walk in place of ripgrep: if ripgrep
   cannot run, the search fails and says so. A regex with no literal text has ripgrep
   list the eligible files, and the JavaScript matcher stays the authority on every
   line.
4. **The derived index is removed.** The index, its utility processes, sqlite-vec,
   Main's index code and the Search & Indexing settings page go. The retrieval tools,
   semantic recall and hosted embeddings go with them. Removal ships in slices; no
   slice adds a new consumer of the index.
5. **Semantic retrieval, if wanted later, sits next to grep.** It would be a hosted
   service or an MCP server offered as a separate tool (ADR-0026 lane 2), not a
   revived local index.

## Consequences

- A search finds what a file holds the moment it is saved, in any open folder,
  indexed or not, and never shows an ignored or credential file.
- On very large repositories, live search stops at its caps and says which one; the
  user narrows the search. If that becomes a real limit, the answer is a lexical
  accelerator that sees saved edits at once, not a semantic index.
- Users who had configured an embedding provider lose semantic search, the three
  retrieval tools and semantic recall.
- Main no longer serves Explorer search: the `index-search:grep` and
  `index-search:embed-query` renderer channels are gone.
- Old grep results recorded with the retired `js-walk` engine no longer parse
  (greenfield, ADR-0020).
