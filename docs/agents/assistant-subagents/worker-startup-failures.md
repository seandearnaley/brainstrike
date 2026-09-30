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

## 2026-09-29 startup evidence (BST-1891)

The captured `call_1wyLLuS8VDcACifkMr8s5YH2` failed with no recorded child
admission or model step. Its unclassified cause was already discarded; no cause
can be recovered or established from its duration. This change improves future
evidence, not the unknown original failure.

The leg records entry into the public delegation-start hook. The existing binding
records successful preparation, entry into its public input processor, and child
admission only after the host persistence callback resolves. These bounded enum
facts are keyed by exact parent native run/tool-call identity, held in memory for
that owner, and never used as execution or authorization authority. No new
database, execution owner, vendor patch or runtime fallback is added.

The failure classifier retains a literal allowlist of native framework identifiers
and observed integer HTTP statuses from 100 through 599 over at most five Error
causes. Unknown identifiers and freeform messages, stack traces, provider payloads,
prompts and credentials remain excluded. Host persistence failures are summarized
before rethrowing because the native stream wrapper can discard their cause.
The catch compares the error's bounded cause identities with the already-owned
invocation abort signal. A fault observed independently of that signal cannot be
erased by a later selected Stop; a real Stop during persistence stays cancelled.

The native Worker regression uses public Agent and Memory configuration with a
real full-engine PGlite vector adapter: the child's embedding provider throws,
or the host persistence callback rejects. Both leave child admission and child
model calls at zero, while the parent handles the failure. Their diagnostics
retain distinct prepared/input-started boundaries and `AGENT_STREAM_FAILED`
through the production logger, diagnostic conversion and NDJSON exporter. The
public native wrapper discards the embedding identifier and 401 status; neither
is inferred. The actual embedding invocation establishes the fixture's injected
cause only. The persistence callback's observed 503 survives because the binding
summarizes it before native wrapping. The pack formatter's paired regression
retains that bounded shape in both diagnostics and main-log sections; it composes independently
deserialized records, as the real host export does. This is native-runtime and
export-format coverage, not desktop UI E2E or a live external provider test.

Generic failures reach supervisor memory through Mastra's documented `feedback`
hook as well as `resultText`; native thrown execution ignores `resultText`.
Partial-child wording requires an observed admitted child. The native persistence
failure regression checks the actual next parent model prompt for the explicit
absence-of-admission message. Existing fixed embedding remedies remain unchanged.

Guards: `packages/agent/src/__tests__/delegation-startup-evidence.integration.spec.ts`,
`packages/agent/src/mastra/__tests__/delegation-failure-diagnostic.spec.ts`,
`packages/agent/src/mastra/__tests__/subagent-stop-causality.spec.ts`, and
`packages/app-shell/src/__tests__/thread-debug-pack.test.ts`.
