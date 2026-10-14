# ADR-0021: Thread context map and explicit attachment

- **Status:** Accepted by Sean
- **Date:** 2026-10-14
- **Ticket:** BST-2013 (BST-2014 to BST-2019)

## Context

The Files app was built for manual context curation. You checked files,
trimmed ranges in the tapestry, watched a user-set token budget, and then
copied, downloaded or sent the result. Agents now gather their own context with
reads, grep and semantic search, so that loop rarely runs. Yet the tapestry
still takes the Files app's main pane.

That leaves two token numbers that don't connect. The tapestry counts what you
selected; the composer ring counts what the model was sent. The ring's breakdown
counts only text parts, so every tool call and tool result lands in
"Unattributed". Meanwhile the tapestry's `PreviewPanel` is the only writer of
the workspace-context snapshot that decides which checked files reach the model.

## Decision

- **"In the window" belongs to the host.** It already builds each request,
  applying rewrites, compaction, branch selection and contiguous limiting, and
  commits `provider.request.prepared`. That committed breakdown records each
  tool call present in the request: its tokens, measured on the exact prompt,
  and whether the result went out as a rewrite marker. Clients read this record.
  They never re-derive rewrite, compaction or branch rules.
- **"Which lines" belongs to each tool's committed raw result.** A pure client
  fold maps tool calls to line spans using shared, browser-safe schemas in
  `assistant-contract`. A projection that drops items (for example, a grep page
  trimmed to the character budget) shares one kept-items rule with the fold, so
  nothing the model didn't receive is counted. A shape the fold can't read
  becomes a visible unmapped entry.
- **Context is a workspace tab.** It sits next to Changes, follows the active
  thread, and shows that thread's spans per file and per index chunk. It is
  desktop-only, gated by omission, because web has no committed run log. Its
  state is session-only and rebuilt from the log. Chunk boundaries come from a
  read-only indexer query; the indexer stays the sole writer.
- **The explorer is the Files app's main surface.** Checkboxes are a bulk
  selection only. A checked file no longer reaches the model.
- **Attaching is explicit.** "Attach to thread" appends `@file` mentions to the
  composer. That way the user sees what goes to the model, and the existing
  admission reader applies its caps and reports failures. The BST-1990
  outside-thread grant moves from checked files to the run's mentions: a file
  in a live workspace folder outside the thread is attached for that run only,
  with the same markings and typed refusals.
- **Retired.** The tapestry, manual range trimming, the user-set explorer token
  budget, the workspace-context snapshot path, and the agent tools that wrote
  the user's selection or tapestry ranges.

## Consequences

- The tool-result contract gains one additive field: the edited line range on
  string-replace results. Reads, grep and semantic search already record their
  delivered ranges and chunk ids.
- The breakdown's new fields are optional. A request without them is shown as
  "not measured", never as zero. Unknown, unindexed and unmapped are display
  states, not zero-filled values.
- Shell output (`cat`, `sed`) is counted as other tool output and isn't mapped
  to lines. Child runs keep their own logs and are not yet shown in the
  parent's map.
- Retrieval loses the explorer budget as its default and uses its fixed
  4,000-token default.
- This supersedes the parts of the BST-1990 checked-files contract (#3585) that
  make checked files reach the model. Its folder-scope, approval-target and
  draft-restoration behavior is unchanged.
