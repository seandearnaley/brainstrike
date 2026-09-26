# Worker startup failures — evidence

Supports `docs/agents/assistant-subagents.md` § "SUBAGENTS (PERSONA DELEGATION)".

## 2026-09-26 investigation

A captured approval-resume leg dispatched two Workers. Both failed in under a
second, before a delegated conversation or invocation was committed. The native
memory store had allocated two empty child threads. The root agent subsequently
performed writes; the user stopped the root after those writes. The earlier
approval-owner rejection in the same historical thread was a separate incident.

Mastra resolves memory input processors before the configured child binding.
With semantic recall enabled, that resolution calls `getEmbeddingDimension`,
which probes the configured embedder and shares its promise within the Memory
instance. A failed probe therefore leaves empty native threads without an
admitted child or a child model step. A real PGlite/host integration reproduces
this shape by injecting a synthetic embedding-probe failure at the child memory
processor boundary after approval resume; it does not reproduce an actual remote
provider failure. Healthy
embedding with semantic recall and observational vector retrieval enabled admits
both Workers. This establishes a failure mechanism, not the original provider
exception: the captured error discarded its cause, so the incident's exact
credential or provider response cannot be established retroactively.

The desktop creates a fresh Memory for each host run. Recovery therefore uses a
new run after correcting the embedding provider configuration; it does not retry
writes inside the failed run or silently disable memory. A separate Electron
case verifies same-turn Worker writes after reloading a pending canvas approval.

## Failure evidence and supervisor feedback

Mastra's delegation completion hook receives a wrapped error before the final
generic agent-tool failure. The embedding-probe identifier survives this path,
but the underlying provider status can be discarded. Previously the hook logged `success:false`
at info level, which the warn-and-above debug-pack log window intentionally omits.
The hook now emits fixed classifications and call identity through the existing
logging and durable diagnostic pipeline. A bounded cause walk recognizes the
embedding dimension-probe error and nested 401/403 responses; it never copies
freeform error text, stacks, provider request data, prompts, or credentials.
Unknown exceptions remain explicitly unclassified.

On Mastra's thrown path, `resultText` is ignored, but the documented completion
hook's `feedback` is saved to supervisor memory before rethrowing. Recognized
embedding-probe failures use fixed feedback directing the user to check the
embedding provider configuration and retry in a new run. Access-specific wording
requires a surviving 401/403 status; a missing status is not inferred. This is not an approval
retry and never substitutes a different execution owner.

Mastra may publish both tool-error and tool-result terminal parts for one failed
delegation. The mapper already deduplicated the generic tool timeline; it now
uses the same first-terminal rule for the paired subagent timeline. The regression
fails with duplicate child terminals before the fix and passes with one afterward.

A review of the cancellation boundary found that a delegated `tool-output` is
routed to `subagent.tool.*`, not to the generic pending-success queue. On child
run cancellation, the active delegation tool receives `tool.failed` with
`cancelled` status; a late result cannot add `tool.completed`. The focused
`delegation-cancellation-lifecycle.spec.ts` guard exercises this ordering. A
separate Stop race was real: an unrelated provider `AbortError` could be
classified as selected parent Stop after both signals aborted, hiding its
failure. The hook now requires the exact propagated Stop reason in the child's
bounded cause chain. `subagent-stop-causality.spec.ts` was red under the prior
condition and green after narrowing it.

Guards: `delegation-failure-diagnostic.spec.ts`, `mastra-tool-lifecycle.spec.ts`,
`worker-after-root-approval.integration.test.ts`, and
`workers-after-canvas-approval.desktop.test.ts`.
