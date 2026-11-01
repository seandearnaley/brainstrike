# ADR-0021: Thread context map and explicit attachment

- **Status:** Accepted by Sean
- **Date:** 2026-10-14
- **Ticket:** BST-2013 (BST-2014 to BST-2019)

## Context

- The Files app was built for manual context curation: check files, trim ranges in the tapestry,
  watch a user-set token budget, then copy, download or send the result.
- Agents now gather their own context with reads, grep and semantic search, so that loop rarely
  runs, yet the tapestry still took the Files app's main pane.
- Two token numbers didn't connect:
  - the tapestry counted what you selected; the composer ring counted what the model was sent;
  - the ring's breakdown counted only text parts, so every tool call and result landed in
    "Unattributed".
- The tapestry's `PreviewPanel` was the only writer of the workspace-context snapshot that
  decided which checked files reached the model.

## Decision

- **"In the window" belongs to the host.**
  - It already builds each request (rewrites, compaction, branch selection, contiguous limiting)
    and commits `provider.request.prepared`.
  - That breakdown records each tool call in the request: its tokens, measured on the exact
    prompt, and whether the result went out as a rewrite marker.
  - Clients read this record and never re-derive rewrite, compaction or branch rules.
- **"Which lines" belongs to each tool's committed raw result.**
  - A pure client fold maps tool calls to line spans using shared, browser-safe schemas in
    `assistant-contract`.
  - A projection that drops items (e.g. a grep page trimmed to the character budget) shares one
    kept-items rule with the fold, so nothing the model didn't receive is counted.
  - A shape the fold can't read becomes a visible unmapped entry.
- **Context is a workspace tab.**
  - It sits next to Changes, follows the active thread, and shows that thread's spans per file
    and per index chunk.
  - Desktop-only, gated by omission. (Web had no committed run log; the web app has since been
    removed.)
  - State is session-only and rebuilt from the log.
  - Chunk boundaries come from a read-only indexer query; the indexer stays the sole writer.
- **The explorer is the Files app's main surface.** Checkboxes are a bulk selection only; a
  checked file no longer reaches the model.
- **Attaching is explicit.**
  - "Attach to thread" appends `@file` mentions to the composer, so the user sees what goes to the
    model and the admission reader applies its caps and reports failures.
  - The BST-1990 outside-thread grant moves from checked files to the run's mentions: a file in a
    live workspace folder outside the thread is attached for that run only, with the same
    markings and typed refusals.
- **Retired:** the tapestry, manual range trimming, the user-set explorer token budget, the
  workspace-context snapshot path, and the agent tools that wrote the user's selection or
  tapestry ranges.

## Consequences

- The tool-result contract gains one additive field: the edited line range on string-replace
  results. Reads, grep and semantic search already record their delivered ranges and chunk ids.
- The breakdown's new fields are optional. A request without them shows "not measured", never
  zero. Unknown, unindexed and unmapped are display states, not zero-filled values.
- Shell output (`cat`, `sed`) counts as other tool output and isn't mapped to lines.
- Child runs keep their own logs. Each direct child is a lane of the parent's Context tab, folded
  from its own log (BST-2021), not merged into the parent's map.
- Retrieval loses the explorer budget as its default and uses its fixed 4,000-token default.
- Supersedes the parts of the BST-1990 checked-files contract (#3585) that make checked files
  reach the model. Its folder-scope, approval-target and draft-restoration behaviour is unchanged.
