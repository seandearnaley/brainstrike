# Tool-projection supersession overlays — evidence

Supports `docs/agents/assistant-persistence.md` §
"STALE TOOL-PROJECTION REWRITE OVERLAYS". Read this before proposing to change the detection rules, the decoded-character ruler, the malformed-record warn memo, or the replay processor.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Desktop native workspace inspection history is compacted at the transient
provider-request boundary without mutating Mastra-owned message content.

- **Where state lives:**
  `brainstrike_assistant_tool_projection_rewrites` (migration 084 plus the
  migration-087 `kind` extension, sole authors since BST-1651 retired the
  bootstrap mirror — that mirror declared `kind` inline, so a bootstrapped
  database had it at ordinal 5 where a migrated one has it at ordinal 8; no FKs
  because migrations run without Mastra's lazy tables). `tool_call_id` is the
  primary key; `thread_id` owns cleanup; `rewrite_id` groups one committed
  batch for diagnostics; `superseded_by_tool_call_id` is the live-evidence
  guard; `marker_text` is the exact compact replay; `original_chars` records
  the decoded model-projection character count (BST-1195 ruler) used for
  diagnostics. The table is registered in the reset registry and the shared
  thread-delete sidecar cascade.
- **Detection and batching are desktop-local and restart-safe.** After a
  successful `readWorkspaceFile` or `grepSearch`, and after a successful
  `writeWorkspaceFile` or `stringReplaceWorkspaceFile`, desktop scans the
  thread's visible persisted tool invocations and excludes calls already in
  the overlay. Resolved-file identity is canonical `rootId` plus workspace path
  (root-name fallback exists only for legacy persisted results that predate
  `rootId`). Overlapping reads supersede earlier reads; either supported edit
  supersedes all earlier reads of that file; an identical normalized grep
  pattern/scope supersedes the earlier grep. Persisted unchanged-read dedup
  stubs are neither candidates nor superseders. Read markers name a later read
  only when one exists; edit-superseded markers direct the model to re-read, and
  multi-root markers use the same unambiguous root-label rule as the live read
  projector. No in-memory pending queue exists. Reclaimable size is measured in
  DECODED characters (BST-1195's `decodedWorkspaceTextModelOutputChars` ruler —
  code points in the projected model-facing text plus the fixed envelope
  reserve, never `JSON.stringify(...).length`), matching the SAME ruler the
  live `readWorkspaceFile`/`grepSearch` projectors self-fit against, so the
  64 KiB batch threshold below reflects the actual model-facing saving rather
  than an inflated JSON-escaped approximation. It is still an honest character
  approximation, never token-exactness. Predicate matching is cheap; model
  projections are built once, only for a winning pair. One transaction commits
  the whole pending batch only at 65,536 reclaimable decoded characters or
  more; below threshold it writes nothing. Detection/commit is post-success
  optimization bookkeeping: any failure is logged and the already successful
  tool result remains successful. Malformed persisted records warn ONCE per
  process, not once per scan (BST-1248): a module-scope memo keyed by
  `tool_call_id` dedupes the WARN ONLY — every scan still re-parses, because
  `read`/`grepKey` feed supersession detection in both directions and a
  record that fails one consumer's stricter contract must keep acting as the
  superseder of other, valid records (gating the parse silently lost their
  reclamation; review-caught, pinned by the A/X/L geometry test). Before the
  memo, one bad record re-warned on every subsequent tool call in the thread
  (139 duplicates from a single record in the 2026-08 audit). The first
  encounter always warns; distinct records warn independently; past a
  distinct-record ceiling ONE summary warning
  (`tool_projection_rewrite_malformed_history_suppressed`) announces
  suppression instead of an eviction cliff
  (`tool-projection-rewrite-repository.test.ts` pins all of it). Candidate
  size is measured from the PERSISTED model output
  (`providerMetadata.mastra.modelOutput`, the same source recency pruning
  reads), never by re-projecting the raw result (BST-1249): re-projection
  re-applies the DEFAULT domain budget, smaller than the loop-guard/scaled
  budget some runtimes used, so legitimately-large historical reads threw
  RangeError and were mislabeled malformed on every scan — the 2026-08
  audit's three "malformed" records were exactly this. Only legacy rows
  without a persisted model output re-project, under the CEILING scaled
  budget.
- **Replay rewriting is surgical and transient.** The agent-side Mastra input
  processor receives the fully built AI-SDK prompt and replaces only matching
  `tool-result.output` values with text markers. It runs before provider-history
  compatibility and the final contiguous token limiter. An absent desktop
  lookup capability omits the processor; an empty lookup or inert diff returns
  `undefined` and preserves the golden path.
- **Rewind self-heals without undo state.** Before applying X's overlay
  (`superseded_by_tool_call_id = Y`), the processor verifies that Y is still
  present somewhere in the CURRENT prompt. Mastra's five rewind-aware read
  paths have already removed tombstoned messages by this point. If rewind hid
  Y, X replays its original durable content; no stored invocation result was
  ever overwritten, so there is no content-loss or rollback log.
- **A committed batch resets loop guards for the same thread scope.** Desktop
  calls `resetToolCallLoopGuards(readStateScope(runtimeData))` only after a
  transaction inserted overlay rows. This prevents an unchanged-read dedup
  stub from referring to evidence the new batch will collapse. Below-threshold
  scans do not reset the guards.

