# Data-part deferral and tool-call args ordering — evidence

Supports `docs/agents/assistant-runtime.md` § "ATTEMPTS VS TURNS".
Read before changing `DataStreamMapper` deferral, the args-window close rules, or reasoning about the assistant-stream decoder. BST-962. NOTE: the version archaeology below is written against assistant-stream 0.3.34/0.3.35/0.3.37; the catalog pin is now 0.3.41 (`pnpm-workspace.yaml`), so treat the "pinned 0.3.37" wording as historical.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 1459-1549), extracted verbatim.

Stream part continuity: run-event data parts ('aui-data') CLOSE the active
text/reasoning append in assistant-stream's accumulator, slicing visible text
into fragments. `DataStreamMapper` therefore defers run events that arrive
while a text/reasoning part is streaming and flushes them at the next boundary
(tool start, approval, finish, error, stream end) — never drop them, never
emit them mid-part (proof: data-stream-text-continuity.spec.ts).

Open tool-call args streams have a related ordering contract (BST-962), whose
decoder-side justification CHANGED at assistant-stream 0.3.35 — read this whole
paragraph before reasoning about the mapper's deferral machinery.

Through 0.3.34 the `DataStreamDecoder` closed the ACTIVE call's argsText
controller on every frame in a `TOOL_CALL_ARGS_CLOSING_CHUNKS` set
(`b`/`9`/`0`/`g`/`h`/`3`/`e`/`d`/`aui-text-delta`/`aui-reasoning-delta`/
`aui-data`), so ANY such frame between a call's `b` and its `9` made the next
`c` args delta append to a closed controller — an unhandled "Cannot enqueue a
chunk into a readable stream that is closed" TypeError that errored the whole
renderer pipeline (the visible chat died with the enqueue error) while the
agent-side run completed invisibly.

**0.3.35 removed that set entirely** — `TOOL_CALL_ARGS_CLOSING_CHUNKS` does not
exist anywhere in the pinned 0.3.37 dist. At 0.3.37 an argsText closes ONLY on
an explicit frame: the complete `9`; a `c` delta carrying `isFinal: true`; the
call's `a` result (which marks it closed); and the stream-wide
`closeOpenToolCallArgs()` that `3`/`e`/`d` and decoder flush run. A `0`/`g`/`h`/
`aui-data`/`aui-text-delta`/`aui-reasoning-delta` frame between a call's `b` and
its `9` now closes nothing. Two further consequences, both verified against the
0.3.37 decoder source rather than inferred:

- The crash class is GONE as described. A `c` delta for an already-closed args
  stream is now dropped behind a one-shot `console.warn` ("Dropped tool-call
  args delta for closed args stream"), not an unhandled TypeError. What STILL
  throws in strict mode (the default) is a duplicate `b` tool-call id, and a
  `c`/`a` naming an id the decoder never saw.
- Interleaved args across PARALLEL calls (`b`-A, `b`-B, `c`-A) is no longer
  decoder-lethal: distinct ids get distinct controllers and `c`-A still resolves
  to A's open controller. The previous "already lethal at the `b`" note applied
  to the pre-0.3.35 decoder and is retained below only as history.

The mapper's obligations are UNCHANGED by this bump — deliberately. It still
(a) defers aui-data parts (run events, shell output, context breakdown,
child-run usage) while `openArgsCallId` is set, flushing after that call's `9`;
(b) closes an open args stream — emitting its `9` with the accumulated args —
before text/reasoning deltas, error/finish frames, and approval/suspend notices
(pauses produce no later boundary, so the notice cannot be deferred);
(c) prefers DEFERRAL over premature flushing everywhere; (d) closes the window
EAGERLY (`b` immediately followed by its `9`) when a tool start already carries
the complete input — the non-streaming provider path (`tool-call` part, no
`input_stream_*` events) — so the window never spans tool EXECUTION, which would
buffer live shell output and run events until the result; a late
`input_stream_end` after any forced close is dropped by the `argsEmitted` guard.

Which of those still carry a LIVE justification at 0.3.37, so a future reader
does not delete them as dead weight:

- (b) is still load-bearing for `3`/`e`/`d`: `closeOpenToolCallArgs()` closes the
  argsText WITHOUT any `9`, so a call whose args were never completed settles
  with partial args. Emitting the `9` first is what preserves them.
- (d) is still load-bearing for LATENCY, independent of any decoder behavior: an
  args window spanning execution buffers live shell output and run events until
  the result.
- (a) and (c) keep an independent justification from the paragraph above — an
  `aui-data` part CLOSES the active text/reasoning append in the ACCUMULATOR,
  which 0.3.35 did not touch — but their args-specific half is now strictly more
  conservative than the pinned decoder requires.

That conservatism is intentional and is why this bump needed no mapper change:
the emitted wire stays valid against both the pre-0.3.35 and post-0.3.35
decoders. Whether the args-specific half of (a)/(c) should be relaxed now that
the crash class is gone is a real question, but NOT one to settle inside a
dependency bump — it needs its own ticket and its own evidence.

The incident producer was an OM-observer run event landing mid
`updateWorkingMemory` args (debug bundle 2026-07-28T15-43-22Z). Proof: the
BST-962 describe block in data-stream-text-continuity.spec.ts, including the
`expectDecoderSafeArgsStream` invariant sweep — which asserts the mapper's
stricter ordering, and whose docblock records that it now outruns what the
decoder needs. The renderer's
data-stream runtime also defers assistant-stream's decoded `message-finish` until
decoder flush: assistant-stream 0.3.37 emits that marker before its trailing
`part-finish`, and exposing completion early lets an immediate next turn abort a
still-draining text controller. Aborted runs propagate the authoritative abort
reason without surfacing cancellation teardown as a new assistant error; server
subscriptions detach without double-closing their stream controller. Desktop
assistant execution is owned by the main-process data-stream session, not by one
renderer HTTP response. A response close detaches only that subscription; the
source continues to terminal state and remains replayable for the session
retention window. User Stop is the distinct authoritative cancel path: the
renderer posts the validated run id to `POST /assistant/cancel`, which aborts
the registered execution controller. Do not infer user intent from navigation,
renderer reload, or a dropped socket.
