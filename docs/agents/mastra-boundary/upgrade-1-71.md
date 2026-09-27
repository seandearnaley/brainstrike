# Mastra 1.71 lifecycle repair and upstream draft

Supports `docs/agents/mastra-boundary.md` § "First-class subagents: host lifetime decision".

The dependency pair is core 1.71.0 and memory 1.32.1 (stable registry tags checked
2026-09-26). The patch is explicit in `pnpm-workspace.yaml` and the lockfile.
Compiled ESM and CJS copies carry the same changes; application code never calls
the patch's internal tracking method. No patch changes permissions or model policy.

| Repair | Demonstrated cause and public regression | Removal condition |
| --- | --- | --- |
| Background execution and cleanup joins | Native dispatch/resume starts workflow deletion without returning its promise. Cancellation can acknowledge before executor finally/deletion settles. `background-cleanup.integration.spec.ts` and `mastra-background-contract.integration.spec.ts` hold effects/deletion, reject deletion, and exercise deadline and pubsub-flush errors. The manager tracks its actual executor and workflow promises, joins them on cancel/shutdown, and propagates cleanup failures. | Upstream cancel/shutdown pass every join/error/sibling test without this hunk. |
| One background output route | One public `ToolStream.custom` write arrives through both task output and the dispatching turn, including persistence into the parent transcript. `delegation-lifecycle.integration.spec.ts` proves native task ownership and preserves two intentionally identical child parts. Background execution publishes through `onProgress` only. | Stock native output reaches the child task/transcript once and never the parent transcript. |
| Child default abort composition | Native delegation replaces the child's default abort signal with its parent signal. The foreground cancellation contract fails without composing the two; the same-parent sibling remains runnable with composition. | Stock native foreground cancellation and sibling isolation pass. |
| Shared stateless SemanticRecall hasher | The real 32-turn memory lifecycle creates 160 WASM hashers; memoization reduces it to one while indexing and retrieval still pass. Failed initialization rejects and is not retained permanently. | Stock public lifecycle meets the one-instance bound with unchanged recall. |

Upstream report drafts should use these library-level entry points: native
`Agent({ agents, backgroundTasks })`, `Mastra({ storage, backgroundTasks })`,
`stream`, manager `stream/resume/cancel/shutdown`, and a public storage adapter.
Model responses are scripted; actual execution, persistence and effects are not
mocked. The deletion-error reproducer injects failure at the adapter's database
boundary and requires both caller-visible failure and no orphan rejection.
There is no need to publish application data or credentials.

Superseded hunks: native 1.71 already supports `suspendedToolRunId`; Brainstrike's
adapter now forwards it. Both experimental `untilIdle` policy repairs were
removed after the user selected the host parent coordinator. The previous custom
child owner and storage-deletion tracker were deleted, leaving native execution
and cleanup ownership in one place.

The saved OpenAI tool-search shape changed legitimately in 1.71: call `itemId`
and `resultItemId` coexist. Its persistence integration test now asserts both
identities and still verifies exactly one distinct reference for each on the
real OpenAI request wire after hydration. No production compatibility processor
was weakened or new vendor patch added for that representation change.

These are local upstream-ready findings, not submitted upstream issues or proof
of vendor endorsement. No issue or PR was posted to Mastra during this work.

Expanded issue/PR drafts and the existing-report search are recorded in
`upstream-1-71-drafts.md`; no report was submitted.
