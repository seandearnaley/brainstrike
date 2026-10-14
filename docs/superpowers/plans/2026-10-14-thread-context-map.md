# Thread Context Map — Implementation Plan

**Date:** 2026-10-14
**Status:** Approved by Sean 2026-10-14 · Epic BST-2013
**Proposal:** https://claude.ai/artifact/E7R32XasWYa4UxYghdz61q (owner: "I like it", 2026-10-14)

## Outcome

- The Files app shows the explorer as its main surface. The tapestry leaves it.
- A new desktop workspace app, **Context**, shows what the active thread's model
  received: per file, per index chunk, colored by how it arrived, with its state
  (in window, collapsed, compacted, dropped, changed since read).
- The composer ring popover attributes tool calls and results (today they fall
  into "Unattributed"). Its "Workspace files" row equals the Context header and
  opens the Context tab.
- Explorer checkboxes are a bulk selection only. **Attach to thread** inserts
  `@file` mentions into the composer, which is the one path by which a user puts
  file content in front of the model.
- The user-set token budget, its sparkline and the tapestry are removed.

## Decisions assumed

The owner confirmed these on 2026-10-14 (including retiring
`updateWorkspaceContextSelection` and the fixed 4,000 retrieval default).
ADR-0021 records them.

1. Context is a workspace tab next to Changes. It is desktop-only, gated by
   omission, because only desktop has a committed run log.
2. Checking a file no longer sends it to the model. Attaching is explicit.
3. The tool-result contract gets small additive fields where the delivered range
   isn't already recorded. That applies only to string-replace edit ranges; see
   "Verified facts".
4. Manual range trimming is dropped. Attach sends whole files (subject to the
   existing `@file` caps). Ranged mentions are out of scope.

## Architecture

```mermaid
flowchart LR
  subgraph Host["brainstrike-host (sole writer)"]
    T[Tool executors] -->|raw result| L[(run log)]
    P[preparedPromptBreakdown] -->|"provider.request.prepared<br/>breakdown.toolCalls[]"| L
    R[rewrites / compaction] -->|tool.projection.rewritten<br/>context.compacted| L
  end
  L -->|log/subscribe rows| S[CommittedAssistantLogStore]
  S --> V[CommittedAssistantLogProjection<br/>(chat view, existing)]
  S --> F[ThreadContextFold<br/>(new, pure)]
  F --> Z[useThreadContextStore<br/>per thread, session-only]
  Z --> C[Context app<br/>app-shell/src/context-map]
  Z --> Pop[Ring popover row]
  I[(derived index)] -->|fileChunks read| C
```

- **One owner of "what was in the prompt".** The host already assembles each
  request (rewrites, compaction, branch, contiguous limiting) and commits
  `provider.request.prepared` with a breakdown measured on the exact prompt
  (`packages/agent/src/provider-request.ts` `preparedPromptBreakdown`). Extend
  that breakdown with one entry per tool call present in the prompt. The renderer
  never re-derives rewrite, compaction or branch rules.
- **One owner of "which lines".** Each tool's committed raw result (the
  `stream.chunk` `tool-result` `output`) already states what was delivered. A
  pure fold maps tool call to spans using shared, browser-safe schemas in
  `assistant-contract`. A malformed result becomes a visible "unmapped" entry,
  never a guess.
- **Derived and ephemeral.** The fold's store is session state rebuilt from the
  log, so it adds no durable state. It joins the session-store factory reset like
  `useContextUsageStore` (`app-shell/src/register-factory-reset-session-stores.ts`).

## Verified facts (2026-10-14, main @ 944c550e3)

| Fact | Where |
| --- | --- |
| `model.step` commits step messages; tool-result parts there carry the model-facing `output` | `agent-host/src/protocol.ts`, `projection-rewrites.ts` (`modelOutput` vs `output`) |
| Raw tool output arrives as a committed `stream.chunk` `tool-result` | `assistant-ui/src/committed-assistant-log-projection.ts` `stream()` |
| `provider.request.prepared.breakdown` is committed; the projection already reads it | `protocol.ts` `HostPromptBreakdownSchema`; projection `contextBreakdown` |
| The breakdown counts only `text` parts, so tool calls and results land in Unattributed | `provider-request.ts`; `assistant-ui/src/context-usage-popover.tsx` `unattributedTokens` |
| A supersession applies only while its superseding call is in the same request | `projection-rewrites.ts` `applyProjectionRewrites` |
| `readWorkspaceFile` returns the delivered `startLine`, `endLine` (`page.lastLine`), `totalLines`, `truncated`, `dedup`, `approxOutputTokens` and `content` | `host-capabilities/src/native-tools/read-workspace-file-tool.ts` |
| Grep matches carry `line`, `before[]`, `after[]`, `chunkId`, `chunkStartLine`, `chunkEndLine`; **the model projection may keep only the first N items** (`omittedByProjection`) | `assistant-contract/src/grep-match.ts`; `workspace-search-model-projections.ts` |
| Semantic retrieval results carry `chunks[]` with chunk id, path, rootId, `startLine`, `endLine`, plus `chunkContentIncludedInContext` | `apps/desktop/src/assistant-server/retrieval-core.ts` |
| String-replace returns path and root but **no line range**; `workspace.edit.recorded` has file identity but no range | `host-capabilities/src/native-tools/file-mutation-tools.ts`; `protocol.ts` |
| `@file` mentions serialize as `:file[label]{name=rootId::path}`; the content is injected at admission as a system message with per-file and per-turn caps; failures are committed as `references.unavailable` | `assistant-ui/src/file-mentions.ts`; `apps/desktop/src/assistant-server/referenced-files-context.ts` |
| The tapestry `PreviewPanel` is the **only writer** of `contextSnapshot`, which becomes run `workspaceContext` | `file-explorer-ui/src/preview/preview-panel.tsx`; `app-shell/.../assistant-ui-panel-wrapper-runtime.ts` `toRuntimeWorkspaceContext` |
| `file_chunks` has `id`, `root_id`, `file_record_id`, `start_line`, `end_line`, `token_count` and `content_hash`, indexed by `(root_id, file_record_id)`; there is no chunk read on `IndexSearchCapability` yet | `indexer/__tests__/fixtures/schema-9-native.json`; `indexing-contract/src/indexer-client.ts` |
| Web has no committed log (own runtime) | `apps/web/src/server/web-assistant-runtime.ts`; only desktop builds `CommittedAssistantLogStore` |
| `IdeLayout.rightPanelContent` is optional; workspace apps are registered by omission | `ui/src/layout/ide-layout.tsx`; `app-shell/src/build-workspace-apps.tsx` |
| One-slot cross-subtree composer handoff exists | `assistant-ui/src/rewind-composer-store.ts` |

## Delivery

Each PR branches from current `main` and merges back; at most three are open at
once. PR 0, PR 1 and PR 2 can run in parallel. PR 3 needs PR 1. PR 4 needs PRs 2
and 3. PR 5's layout and attach work only needs PR 0, but its "This thread" column
needs PR 3. PR 6 goes last.

### PR 0 — ADR-0021: thread context map and explicit attachment (docs)

- Record decisions 1–4 and the architecture above. It supersedes the parts of
  the BST-1990 checked-files contract (#3585) that make checked files reach the
  model. The outside-thread read grant is kept, but moved to Attach (PR 5).
- Validation: docs review and link check only.

### PR 1 — Attribute tool calls in the prompt breakdown

Scope:
- `packages/agent/src/provider-request.ts` `preparedPromptBreakdown`: walk
  assistant `tool-call` parts (input) and `tool` `tool-result` parts (output) in
  `params.prompt`, and emit `toolCalls: { toolCallId, toolName, tokens,
  projection: 'full' | 'marker' }[]` plus `toolCallsTokens`. Use the same chars/4
  heuristic as the other categories. Set `projection: 'marker'` where the result
  is a committed rewrite marker. The host knows this when it applies rewrites, so
  pass the rewritten ids in rather than sniffing text.
- `agent-host/src/protocol.ts` `HostPromptBreakdownSchema`: add both fields as
  **optional**. Rows already on disk must still parse; absent means "not
  measured", never 0.
- `assistant-contract/src/context-breakdown.ts`: add the type and validation.
- `assistant-ui/src/context-usage-popover.tsx`: add a "Tool calls and results"
  category with top-tool sub-rows, which shrinks Unattributed. The "Workspace
  files" sub-row and link come in PR 4.

Tests:
- Unit: breakdown over prompts with tool calls, markers and attachments.
- Schema: old rows without the fields still parse.
- Popover attribution math.
- Host integration: a run with a superseded read commits `projection: 'marker'`
  on the next request.

Measure:
- Row size on a 200-tool-call fixture. Rows of 12 KB or more spool to blobs.
- If p95 per-request rows exceed about 8 KB, switch to a per-run delta (the
  run's first request carries the full list, later requests add or remove).
  Decide on that evidence, not up front.

Validation:
- `pnpm check --full`, because a committed event schema changes.
- Live: run the desktop app on a disposable profile with the model-provider
  shim. The popover shows the new row and Unattributed drops.

### PR 2 — Chunk reads and edit ranges

- **`fileChunks` read.** Add `fileChunks({ rootId, paths })` →
  `{ path, generation, chunks: { id, startLine, endLine, tokenCount, contentHash }[] | 'not-indexed' }[]`.
  Follow the `nativeCoverage` pattern through
  `packages/sqlite-query/src/{protocol,host-core,client}.ts`, then
  `apps/desktop/src/native-coverage-reader.ts`,
  `apps/desktop/src/ipc-domains/index-search.contract.ts` (argument validation),
  `apps/desktop/src/ipc-index-search.ts`, and finally the `IndexSearchCapability`
  interface. The query is read-only, and the indexer stays the sole writer.
- **Edit range.** Add `editedLines: { startLine, endLine }` to the string-replace
  result (the tool knows the match position). Writes count as whole-file edits.
  Include the range in the model projection only if it helps the model;
  otherwise keep it in the raw result only.
- Tests: query host-core tests; IPC argument contract tests; mutation tool tests
  for the range (single-line, multi-line, CRLF, a match at EOF).
- Validation: `pnpm check:routine`.

### PR 3 — ThreadContextFold and store

- **Shared provenance schemas.** Add `assistant-contract/src/context-provenance.ts`:
  zod schemas for the delivery-relevant subset of each tool's raw result (read,
  grep, readWorkspaceContext, queryEmbeddingSpace/hybridSearch, string-replace,
  write). Producers type-check against them, so a shape change fails at compile
  time.
- **Grep kept-count rule.** Move the "items kept by the projection" computation
  into a browser-safe pure function. The grep projection and the fold both call
  it, and a parity test pins them together. The fold must never count matches
  the model didn't get.
- **Fold.** `assistant-ui/src/thread-context-fold.ts` is a pure, incremental fold
  by `seq` over the rows `CommittedAssistantLogStore` already receives. It
  produces:
  - spans per tool call (kind: read, grep, semantic, edit, pinned), using the
    delivered lines only. Cursor pages produce additional spans. A `dedup` read
    produces a "repeat, no new content" span. Semantic hits with
    `chunkContentIncludedInContext: false` produce reference-only spans with no
    content.
  - pinned spans from `run.started` prompt `:file` directives, minus committed
    `references.unavailable` failures. Reuse the mention parser; move it to a
    browser-safe module if it isn't one already.
  - per turn on the displayed branch: the last `provider.request.prepared`
    breakdown gives which calls are in the window, their tokens, and
    `projection`. Use the branch resolution the conversation projection already
    uses. Do not add a second one.
  - span state: in window or collapsed comes from the breakdown entry. Not
    present plus a `context.compacted` covering its run means compacted. Not
    present otherwise means dropped. A breakdown without `toolCalls` means
    unknown.
  - delivered tokens per call from its first full appearance. Spread a call's
    tokens across its spans by line count, and label the result as apportioned.
- **Store.** `assistant-ui/src/thread-context-store.ts` (zustand, keyed by
  thread) is written from `CommittedAssistantLogStore.read()` beside
  `recordUsage` and `recordBreakdown`. Register it in the session factory reset.
- **Tests.** Use committed-row fixtures (recorded from a real host run) for
  these cases:
  - cursor pages
  - a truncated read
  - a dedup read
  - grep projection trim (parity)
  - semantic hits with and without content
  - an edit with a range
  - supersession, giving collapsed
  - compaction, giving compacted
  - a branch switch, giving dropped
  - an old row without attribution, giving unknown
  - a malformed raw output, giving a visible unmapped entry and a logged error

  Add a performance test that folds a 5k-row thread within budget.
- Validation: `pnpm check:routine`.

### PR 4 — Context workspace app (desktop)

- **UI.** Build it in `packages/app-shell/src/context-map/`, following the
  `changes/` precedent:
  - header meter: the same total as the ring, plus a "Workspace files" figure
    from the fold, with a 90% compaction tick
  - turn scrubber with compaction markers
  - In window / Everything seen toggle
  - file rows with chunk strips, built from `fileChunks`; an unindexed file gets
    a line-scaled strip labeled "not indexed"
  - lens: lanes per kind and a list of the delivering tool calls, which doubles
    as the accessible table view
  - signals: changed since read, edited without reading, re-read cost,
    compaction
  - export: copy or download a Markdown bundle of in-window spans
- **Registration.** `build-workspace-apps.tsx` gets an optional
  `contextPageContent`, passed only by desktop. The tab follows the active
  thread.
- **Changed since read.** Use the shared content owner and watcher channel.
  Compare a read's delivered `content` with the current lines in its range; a
  grep `lineText` with the current line; a semantic chunk's `content_hash` with
  `fileChunks`. Recompute lazily for visible rows. A failed check shows as
  unknown, not as "unchanged".
- **Ring link.** The popover's "Workspace files" sub-row opens the Context tab.
  Both read the store, so they show the same number.
- **Tests.**
  - Component tests: rows, states, scrubber, lens and empty states.
  - Desktop E2E with the model-provider shim. A thread reads two pages, greps,
    edits and re-reads. Open Context and assert the rows, the states, and that
    the header files figure equals the popover row. Force compaction with a low
    input limit and assert hatching.
- **Validation.**
  - `pnpm check:routine` plus the new E2E.
  - Demonstrate the flow by hand on a disposable profile.

### PR 5 — Files app: explorer first, Attach, bulk export

- **Layout.** In `ContextExplorerSurface` (`app-shell/src/root-layout-content.tsx`),
  `ExplorerSearchTabs` becomes the page content and the right panel goes,
  because the prop is optional. Desktop and web both change. Re-check the
  layout store's persisted sizes. The project is greenfield, so add no
  migration.
- **"This thread" column.** Add a row metadata source (via the explorer's
  file-row metadata source registry) that reads the thread context store. It
  shows kind chips, "changed since read" and "edited, not read". On desktop
  only, also add a "Touched in this thread" filter preset.
- **Attach to thread.** Add a bulk action that sends `:file[...]{name=rootId::path}`
  directives through a new one-slot `composer-mention-request-store`, modeled on
  `rewind-composer-store`. This version appends to the draft instead of
  replacing it, and it is registered in reset. The drain bridge lives next to
  the rewind bridge.
- **Outside-thread folders.** Preserve the BST-1990 semantics: a mentioned file
  in a live workspace folder outside the thread is attached for that run only.
  Today the read grant (`attachedRootIds`) is computed from checked files
  (`apps/desktop/src/agent-host-platform/desktop-run-admission.ts`). Compute it
  from the run's mention directives instead. `referenced-files-context.ts` then
  reads exactly those (rootId, path) pairs under the same live-root recheck.
  Port the "not in this thread / Add to this thread" notice to the attach flow.
- **Copy/Download contents.** Make these bulk actions using the existing context
  generation (`file-explorer/src/context-generation.ts`). This replaces the
  tapestry export on web and desktop. The project-tree option moves into this
  dialog.
- **Tests.**
  - Explorer component tests.
  - Rewrite E2E K11 (`apps/desktop/e2e/host-thread-checked-files.desktop.test.ts`)
    to cover the attach flow: mentions appear in the composer; the provider
    receives the outside-thread content, marked; Add to this thread works.
  - Web E2E for the layout and the export.
- **Validation.** `pnpm check --full`, because this changes admission and the
  read grant.

### PR 6 — Retire the tapestry, the checked-files context path and the budget

- **Checked files.** Stop sending them as context: delete `contextSnapshot`,
  `toRuntimeWorkspaceContext` and the `workspaceContext` runtime field,
  including `includeProjectTree`, which moved to export. Also delete
  desktop-checked-files admission and the selection paths in
  `readWorkspaceContext` and `listWorkspaceContext`. Keep the roots and
  index-hint inventory in `listWorkspaceContext`.
- **Agent tools.** Retire `updateWorkspaceTapestrySelections` and
  `updateWorkspaceContextSelection` (owner to confirm the second), along with
  `app-shell/src/assistant-selection-write-back.ts`, the instruction text in
  `default-instructions.ts`, and the admitted-tool-descriptor fixture.
- **Tapestry.** Delete `file-explorer-ui/src/tapestry/*`, `preview/*`, range sync
  and the curation store's ranges. In Search, a chunk checkbox becomes
  "Attach"; the range derivation goes from `workspace-search/src/bridge`.
- **Budget.** Remove the explorer budget chain: store field, persistence,
  `DEFAULT_TOKEN_BUDGET`, `token-budget-control.tsx`, the sparkline and the
  snapshot field. Also remove `runtime-data.ts` `workspaceContext.tokenBudget`,
  `platform-client-configuration.ts`, `desktop-host-shared-tools.ts`, the web
  runtime schema, and the budget metric in
  `workspace-context-model-projection.ts`. Other budgets stay: tool-output
  limits, the retrieval tool's own `tokenBudget` input, the context packer,
  chunking, and the settings tool summary. Retrieval's default becomes its fixed
  4,000 (`retrieval-core.ts`); confirm that value.
- **Docs.** Rewrite `docs/agents/explorer-search-tapestry.md` as explorer,
  search and context map. Update the AGENTS references and the package
  READMEs.
- **Validation.**
  - `pnpm check --full`.
  - Remove obsolete tests only when the behavior they cover is deleted. Name
    each removed suite in the PR.
  - Hands-on run on desktop and web.

## Risks and checks

- **Grep and semantic projections may drop items.** The parity function is the
  guard; add it before any count ships.
- **Attribution row growth.** Measure in PR 1 and switch to deltas only if the
  numbers call for it.
- **Branch fidelity.** The fold must follow the branch the conversation shows.
  Test it with a regenerate fixture.
- **Mentions for outside-thread files.** This reverses a two-day-old contract
  (#3585). Keep its typed refusals and markings, and rerun its host tests
  against the new grant source.
- **Unknown is a state.** Old rows, unindexed files, failed staleness checks and
  child runs show as unknown or not mapped. None of them may be zero-filled.
- **Subagents.** Child runs have their own logs. Show them as their own lanes
  in a follow-up, not in this series.
- **Shell reads.** `cat`/`sed` through `executeCommand` stay as "other tool
  output, not mapped to lines".

## Out of scope

- Ranged `@file` mentions.
- Drop from window (a user-initiated rewrite would add a second writer).
- Comparing threads.
- Handing off a thread from its context.
- The web Context tab, which needs a committed log on web.

## Tracker

Epic BST-2013. PR 1 is BST-2014, PR 2 BST-2015, PR 3 BST-2016, PR 4 BST-2017,
PR 5 BST-2018 and PR 6 BST-2019. PR 0 (this plan and ADR-0021) rides on the
epic.
