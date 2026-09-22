# Recency-window tool-projection pruning — evidence

Supports `docs/agents/assistant-persistence.md` §
"RECENCY-WINDOW TOOL-PROJECTION PRUNING". Read this before proposing to change the prune kind, the window and reclaim thresholds, or the eligibility allowlist.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Layer 2 reuses Layer 1's transient overlay and never mutates Mastra message
content.

- **State and replay kind:** migration 087 adds CHECK-constrained
  `kind IN ('supersession', 'prune')`, makes
  `superseded_by_tool_call_id` nullable, and ties the two with a second CHECK:
  supersession requires a non-null superseder; prune requires NULL. Existing
  rows backfill to `supersession`. The processor keeps Layer 1's
  current-prompt superseder-presence gate only for supersession rows. A prune
  row applies whenever its own call remains in the already-tombstone-filtered
  prompt; rewinding unrelated later messages does not make age-selected
  evidence fresh again. Migration 087's `down` deletes every `kind = 'prune'`
  row before restoring the migration-084 `NOT NULL` on
  `superseded_by_tool_call_id` — those rows are a rebuildable transient
  overlay, so dropping them on rollback is correct, and without the delete
  `SET NOT NULL` fails outright once any prune row exists.
- **Deterministic selection:** desktop measures each persisted
  `providerMetadata.mastra.modelOutput` projection with
  `decodedPersistedModelOutputChars` — `decodedTextModelOutputChars` for
  `type: 'text'`/`type: 'content'` shapes, and the same ruler applied to the
  `toJsonSafe`-serialized value for `type: 'json'` shapes (the artifact
  reader's `buildModelPage()` and artifact settlement's
  `createArtifactOutputs()` both persist `json`, and artifact spill is
  precisely the large-output path pruning targets — treating it as malformed
  would silently disable pruning on exactly the threads with the most to
  reclaim). Only a genuinely unknown shape throws. An invocation persisted
  before `providerMetadata.mastra.modelOutput` existed (`modelOutput ===
  undefined`) is skipped from the size walk entirely, matching how
  `projection-safe-tool-call-filter.ts`/`projection-aware-token-limiter.ts`
  already treat absence as normal — never a pass-aborting throw.
  `TOOL_PROJECTION_PRUNE_PROTECT_WINDOW_TOKENS` (40,000) protects whole
  invocations overlapping the newest window, derived as 160,000 decoded chars
  through `APPROX_CHARS_PER_TOKEN = 4`. `TOOL_PROJECTION_PRUNE_MIN_RECLAIM_TOKENS`
  (20,000) gates the sum of decoded full-result-minus-marker savings, likewise
  derived as 80,000 chars. Below the floor the pass writes nothing. Repeated
  Mastra snapshot copies of one `toolCallId` keep their latest projection and
  count once. Eligibility is an explicit ALLOWLIST of read-only, cheap-to-
  re-run native tools (`grepSearch`, `readWorkspaceFile`, `globWorkspace`,
  `hybridSearch`, `queryEmbeddingSpace`, `querySelf`, `queryDiagnostics`,
  `listWorkspaceContext`, `readWorkspaceDirectory`, `findWorkspaceSymbol`,
  `lspInspect`, `webSearch`, `webExtract`, `readToolOutputArtifact`,
  `skill_search`, `inspectCommandSessions`) — never a denylist — so every new
  or future native tool is exempt by default. Mutating/interactive tools
  (`writeWorkspaceFile`, `executeCommand`, `runPython`, `runSkillScript`,
  `askUser`, `manageCanvas`, `manageTaskList`, …) are ineligible: re-running
  one is either not idempotent (a mutation repeats) or not what the marker
  implies (`askUser`/`submitPlan` suspend for a NEW answer), and their
  projections are tiny, so the reclaim is near zero against a real downside.
  `skill` and `skill_read` stay unconditionally exempt (their output IS the
  working skill body a later turn may still need); `skill_search` differs —
  its output is a disposable search-result list, so it is allowlisted like
  `grepSearch`. This allowlist is deliberately narrower than and NOT derived
  from `tool-risk.ts`'s `'read'` risk bucket, which several exempt tools
  (`askUser`, `submitPlan`, `manageTaskList`, `manageCanvas`) also resolve to
  for the unrelated reason that they don't mutate workspace/fs state.
- **Current turn is an explicit persisted boundary:** the scan uses the latest
  visible persisted user message, matching the runtime's last-real-user turn
  anchor. Assistant rows after that anchor are current-turn rows, and every
  tool-call id they carry or reference is ineligible even if an earlier
  snapshot repeats it. With no visible user anchor, every assistant row is
  conservatively current. Current-turn results still participate in the
  newest-window size walk, but can never become candidates.
- **Markers are generic and visible:** one line names the canonical native tool
  id, a 12-hex SHA-256 digest of `stableNormalizedArgsKey(args)`, and directs
  the model to re-run the tool. Raw invocation args/results stay byte-identical
  in `mastra_messages`.
- **Trigger and commit:** the scan runs after successful executions at Layer
  1's existing four decoration points (`grepSearch`, `readWorkspaceFile`,
  `stringReplaceWorkspaceFile`, `writeWorkspaceFile`). This keeps one
  deterministic post-success path and fixed-count SQL reads; it adds no job,
  queue, LLM call, or per-invocation query. One transaction inserts the batch
  with `ON CONFLICT (tool_call_id) DO NOTHING`, so replay scans cannot
  double-prune. Only an actually inserted prune batch resets
  `resetToolCallLoopGuards(readStateScope(runtimeData))`, preventing dedup stubs
  from pointing at newly collapsed evidence, and emits the structured
  `tool_projection_prune_batch_committed` log with row and reclaimed-char
  totals.

