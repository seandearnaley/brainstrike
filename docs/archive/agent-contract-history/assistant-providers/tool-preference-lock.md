# Tool-preference file lock — evidence

Supports `docs/agents/assistant-providers.md` § "Both writers take one lock". The two queues that genuinely interleave and the lost update they produce unserialised.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 5167-5183); append rather than
rewrite.

---

`withToolPreferencesFileLock` serialises every read-modify-write of the file.
The two writers are on DIFFERENT queues and genuinely interleave: the toggle
runs under `trackConfigOperation` (serialised on `mcpConfigOperationTail`),
while the config-watch path reaches the projection through `trackConfigChange`
→ `registerConfigChange`, which only records into `mcpLifecycleBarrier` and does
not serialise execution. `latestAuthorityEpoch` narrows the window but cannot
close it — that check runs once at operation entry, before the I/O.

Unserialised, the lost update is: toggle reads → the projection prunes and
rewrites → the toggle writes its now-stale merged map and resurrects everything
the prune just removed. Any new writer of this file MUST take the same lock.

Paired tests: `apps/desktop/src/__tests__/main/ipc-mcp-preferences.test.ts`
(merge preservation, both refusal kinds, reset-over-corrupt, fault clearing,
no-mutation-on-refusal, version stamping, and the watcher-vs-toggle
serialisation) and `packages/agent/src/__tests__/tool-persistence.integration.spec.ts`
for the `ToolPreferencesLoadResult` discrimination itself.
