# Renderer stream-insulation boundary — evidence

Supports `docs/agents/assistant-runtime.md` § "Renderer stream-insulation boundary".
Read before touching `insulateAssistantStreamPipeline`, the cancellation firewall, or the deferred message-finish flag. BST-704; upstream assistant-ui/assistant-ui#5045.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 2070-2107), extracted verbatim.

assistant-stream 0.3.37's
decoder/tool pipeline hand-rolls nested stream controllers (merge streams,
tool-call sub-streams) whose settlement paths (`setResponse`, detached
part-finish continuations) enqueue with NO cancellation guard — if downstream
cancellation or an upstream abort error propagates into that pipeline
mid-settlement, the late enqueue rejects as an unhandled renderer TypeError
("Cannot enqueue a chunk into a readable stream that is closed"; upstream root
fix is unreleased assistant-ui/assistant-ui#5045, and `patchedDependencies` are
banned — see ci-quality.md). `insulateAssistantStreamPipeline`
(`packages/assistant-ui/src/stream-insulation.ts`) therefore makes
those states STRUCTURALLY unreachable instead of racing them: the pipeline
reads a guarded byte source that translates an expected transport abort (the
run's AbortSignal fired) into a clean EOF, and the consumer reads through a
cancellation firewall — cancelling the run never cancels the pipeline; the
byte source is cancelled and the pipeline drains to its natural close in the
background, so every in-flight settlement lands in an open stream. Because an
insulated abort now ends in clean EOF, `run()` re-throws the authoritative
abort reason after the loop (an aborted run must never fabricate a successful
finish). Completion wins only after the buffered terminal `complete` message
has already been yielded: because that marker is deferred until decoder EOF, a
superseding abort in the yield-to-iterator-EOF gap must not rewrite the finished
run as cancelled. That decision reads the flush-time flag surfaced by
`deferMessageFinishUntilFlush`, NEVER the accumulated message's status:
`AssistantMessageAccumulator.flush()` fabricates a terminal status for any
stream that ends while still running, so message status is terminal on EVERY
drained EOF and cannot distinguish "run finished" from "stream was cut" (using
it marks every aborted run complete — proven by the abort-reason unit test,
whose expected rejection then never fires). The usage/context-breakdown taps
are abort-gated so a draining stream cannot report late usage. Real faults stay loud: pre-cancellation
pipeline/transport errors propagate to the consumer, post-cancellation
non-abort drain failures log with diagnostic context. Do NOT re-route the
decoded pipeline around this boundary or pass raw `response.body` into the
decoder directly. Proof: `stream-insulation.test.ts` (contract + deterministic
incident-class settlement) and
`data-stream-runtime-cancellation.browser.test.ts` (real-Chromium
abort/supersede interleaving sweeps; the incident environment is the Electron
renderer). Remove the boundary only after consuming an assistant-stream
release containing #5045 AND re-proving the browser sweeps green without it.
