# Desktop reset order, MCP admission, and the explicitly cleared relations — evidence

Supports `docs/agents/platform-contracts.md` § "FACTORY RESET CONTRACT".
Read before reordering the reset steps, changing MCP admission across reset, or adding a Brainstrike-owned assistant relation. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
Desktop reset order:
1. Quiesce background runtimes. MCP fences complete config operations, installs empty host authority, and purges projections without closing the reusable singleton.
2. Clear UI state.
3. Purge DB tables (job_queue, embedding_sets, etc.).
4. Reload renderer.
Do not skip reload.

MCP config admission stays closed across all four steps. Main initiates the
visible-renderer replacement and waits for the replacement React tree's
existing renderer-ready ping; `did-finish-load` alone is not completion. Only
then does the reset coordinator restore the permanent config watcher and reopen
empty authority. If any purge step fails, main restores the captured pre-reset
MCP authority, config projection, selected-path grant, and tool projection
while admission is still closed, installs the watcher, and only then reopens.
If renderer replacement fails after a successful purge, admission remains
closed and the reset failure is visible.

The MCP config-operation queue is non-reentrant. Tracked handlers call only
their `*ForLifecycle` helpers, watcher callbacks stay generation-guarded outside
the queue, and the user-paced native file picker never holds the reset barrier.
Unwatch remains an idempotent teardown operation after admission closes. The
`mcp:content:*` read channels (BST-1585) follow `mcp:status:get`: they reject
while admission is closed and wait on the lifecycle barrier, but never enter the
queue — the content port's own authority watch retires them on replacement.

Every reset runtime is attempted even when another fails. Their original
rejections remain ordered in one `AggregateError`, while the visible message
names every failed runtime; never replace those causes with a names-only error.

The Explorer's file-content LRU, active read machinery, and per-composite-key
terminal error projection are volatile but
still require renderer reset wiring because the web reset path may not reload.
`FileExplorerProvider` registers one session-store resetter that invalidates
all content generations, queued batches, and projected errors, clears the current store's raw
`fileContents` plus its store-owned LRU, clears selections, and advances the
provider content-lifecycle key so hook-local loading refs/state remount empty.
An already-running obsolete read may settle afterward, but its invalidated
generation cannot commit into the reset store. Provider/store identity changes
use the same keyed lifecycle and invalidate the retired authority during the
commit phase.

Database-owned assistant persistence added outside Mastra's tables must also
be cleared explicitly. This includes `brainstrike_assistant_message_parents`,
the assistant-ui carousel/branch topology companion store (migration 055), and
`brainstrike_assistant_tool_output_artifacts`, the complete-result store
(migration 068). The artifact relation is independently retained and has no
Mastra FK, so both direct-PGlite reset and desktop `db:clearAll` must delete it
explicitly; only a pre-068 missing relation is tolerated. It also includes
`brainstrike_assistant_thread_groups` and
`brainstrike_assistant_thread_placements`, the durable thread grouping and
manual-order presentation state (migration 054). Every table-enumerating reset
deletes placements before groups, then deletes both before Mastra threads.
It also includes `brainstrike_assistant_run_errors` (migration 076), the
FK-less terminal provider-forensics store: clear it before the lazy parent
run/thread relations in desktop `db:clearAll`, renderer direct clear, and
renderer factory-reset purge so error text and allowlisted response metadata
cannot survive a fresh start.
It also includes `brainstrike_canvas_versions` (migration 082), the FK-less
version ledger for thread-owned Canvas documents. All three table-enumerating
reset paths clear it explicitly; thread deletion separately derives its Canvas
stage from `THREAD_DELETE_SIDECAR_TABLES`.
It also includes `brainstrike_tool_call_telemetry` (migration 083), the FK-less,
counts/sizes/ids/booleans-only model-facing tool-cost ledger. All three
table-enumerating reset paths clear it explicitly, and thread deletion derives
its cleanup stage from `THREAD_DELETE_SIDECAR_TABLES`.
It also includes `brainstrike_token_estimate_calibration` (migration 086), the
FK-less numbers/ids/model/provider-only prompt-token reconciliation ledger. All
three table-enumerating reset paths clear it explicitly, and thread deletion
derives its cleanup stage from `THREAD_DELETE_SIDECAR_TABLES`.
It also includes `brainstrike_assistant_tool_projection_rewrites` (migration
084), the FK-less stale-tool-history replay overlay. All three table-enumerating
reset paths clear it explicitly, and thread deletion derives its cleanup stage
from `THREAD_DELETE_SIDECAR_TABLES`.
It also includes `brainstrike_assistant_compaction_ranges` (migration 088), the
FK-less exact-message conversation-compaction overlay. All three
table-enumerating reset paths clear it explicitly, and thread deletion derives
its cleanup stage from `THREAD_DELETE_SIDECAR_TABLES`.
It also includes `brainstrike_forge_prs` (migration 110, BST-1391), the
main-process-written pull-request cache keyed on `(repo_common_dir, branch)`.
It is deliberately NOT a thread sidecar (a PR outlives the thread that opened
it, and two threads on one branch share its status), so it has no FK and no
`THREAD_DELETE_SIDECAR_TABLES` entry. All three table-enumerating reset paths
clear it explicitly (`db-ipc.ts`'s `db:clearAll`, `clearViaPGlite`, and
`purgeTablesTx`), because it names remote repositories and branch topology — a
"true fresh start" must not carry that forward. It rebuilds from `gh` on the
next observation. A row may itself represent an OBSERVED ABSENCE (every
PR-specific column NULL, enforced by the migration's own CHECK constraint) —
that is still cleared the same way as a PR row; there is no separate
delete-vs-clear distinction for the two row shapes.

BST-1391's two new notification-preference toggles (`prOpened`, `prChecks` on
`notification-preferences.v1`) need no new reset wiring — they're additional
keys inside the SAME persisted store
`resetNotificationPreferencesStoreToDefaults` already resets from
`clearBrowserStorage` (FACTORY RESET CONTRACT), covered by construction since
`defaultEvents()` sets every key in `NOTIFICATION_EVENT_KINDS`.

`background-indexing-preferences-store` (`background-indexing-preferences.v1`,
owning the per-root `worktreeRootIndexingOptInById` opt-in map PR #2655 /
BST-1453 added) was persisted and purged from storage, but its LIVE in-memory
copy was never in `clearPersistentUiState`'s re-default list — a reset without
a reload (the web path) left a stale opt-in in memory, so the BST-1392 Worktree
Map could render "Indexing enabled" for a root the user just wiped. Fixed by
BST-1392 Layer 2 Step 0: `resetBackgroundIndexingPreferencesStoreToDefaults()`
(mirrors `resetHookTrustStoreToDefaults` / `resetWorkspaceInstructionsPreferencesStoreToDefaults`
— clears persisted storage, then resets the live store via its own `reset()`
action) is now called from `clearPersistentUiState`, covered by
`packages/app-state/src/__tests__/factory-reset-background-indexing-preferences.test.ts`.

`assistant-subagent-preferences-store` (`assistant-subagent-preferences.v1`,
the per-child subagent budgets edited in Settings → Models → Subagents and sent
as `runtimeData.subagentSettings`) is wired the same way from the start: its
persisted slice is purged with the rest of browser storage, and its LIVE store
is re-defaulted by `resetAssistantSubagentPreferencesStoreToDefaults()` (clears
persisted storage, then sets the defaults), called through
`resetLiveStoreSafely` inside `clearBrowserStorage()` — the step
`clearPersistentUiState` runs via `collectPersistentUiStateResetFailures`.
Covered by
`packages/app-state/src/__tests__/factory-reset-assistant-subagent-preferences.test.ts`
(drives `clearPersistentUiState` and asserts the defaults are back in memory).
