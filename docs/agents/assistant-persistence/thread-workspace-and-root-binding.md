# Thread workspace snapshots and operating-root binding — evidence

Supports `docs/agents/assistant-persistence.md` §
"ASSISTANT THREAD PERSISTENCE & RELOAD HYDRATION". Read this before proposing to change the boot-baseline merge, the editor key filter, or the operating-root metadata triple.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Per-thread workspace snapshots (`brainstrike_assistant_thread_workspaces`) are
loaded into renderer-owned live stores by
`useThreadWorkspaceCoordinator`; those stores remain the working authority.
Initial boot is an ordering boundary because the active thread can restore
before PGlite is ready. While that first snapshot read is pending, store
notifications must not persist the unhydrated singleton state over the saved
row. The coordinator captures a boot baseline instead, then merges only fields
that changed in the live stores after that baseline into the loaded snapshot
before applying and immediately persisting it. This delta covers apps and
selection, file tabs, editor mode/scroll/pane state, Explorer expansion/scroll,
and root views. If the initial read rejects after a live edit, the coordinator
persists the current live snapshot immediately instead of waiting for another
notification. Editor deltas are admitted only for tabs in the loaded snapshot;
a changed tab set is preserved atomically with its live editor map. That key
filter is required so stale pane/editor state from another thread cannot leak
through a boot or `A -> null -> B` transition. Ordinary thread switches never
reuse this boot merge: they synchronously flush the outgoing live snapshot,
then hydrate the incoming snapshot under an intent guard. The deterministic
ordering regressions live in
`packages/app-shell/src/thread-workspace/__tests__/use-thread-workspace-coordinator.test.tsx`.

Desktop assistant threads also persist their operating-root capability in the
existing `mastra_threads.metadata` JSON (no schema migration):
`operatingRootId` is the durable DB `roots.id`; `operatingRootDisplayName` and
`operatingRootPath` are display-only. The first data-stream request writes the
binding before creating the run. Before that write, app-shell resolves the
mounted adapter root's absolute path to exactly one live `roots` row; adapter
root ids are never persisted as execution authority because reconnects may
change them. Later requests/resumes reuse the durable id instead of reading the
current global Main/Focused root. The app-shell metadata sanitizer and write
boundary reject partial bindings and any present-but-invalid operating-root
field: id and display name are required together, while path is optional.
Checkout transitions use the same post-persistence projection in the loaded
thread store as the repository row: setting a mode removes `checkoutBranch`,
and setting Local additionally removes `checkoutLocalRootId`,
`checkoutWorktreeId`, and `checkoutWorktreePath` before the patch is merged.
The store changes only after the repository write succeeds.
Bulk metadata updates reject every `checkout*` key: checkout transitions require
the single-thread writer's atomic deletion projection and must never raw-merge a
partial checkout record across threads.
Malformed persisted ids never sanitize to "unbound" and cannot silently rebind
the thread. Server-side native tools validate only the id against the live root
inventory; the stored path is never an authority or fallback.


