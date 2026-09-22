# Attempts vs turns and stall recovery — evidence

Supports `docs/agents/assistant-runtime.md` § "ATTEMPTS VS TURNS".
Read before changing `runTurnAttempts`, the recovery refusals, per-attempt vs per-turn state, or continuation construction. BST-1409, BST-1415, BST-1667.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 1175-1279), extracted verbatim.

### ATTEMPTS VS TURNS (BST-1409)

A turn may span several provider ATTEMPTS. `runTurnAttempts` (`turn-attempts.ts`,
moved out of `agent-streaming.ts` by BST-1649) owns the turn; `streamAttemptChunks`
(still in `agent-streaming.ts`) owns one attempt and now PROPAGATES a
watchdog error instead of deciding the turn's fate. `runtime.dispose()` moved to
the turn's `finally` and has exactly one owner across all three legs — the
runtime is reusable, since `dispose()` only shuts down mastra + the MCP client.

- **A stall ends the attempt.** The turn continues with a fresh
  `agent.stream` carrying the original request plus everything the stalled
  attempt produced, read from Mastra's in-memory `messageList` on the stream
  result. Bounded by `BRAINSTRIKE_STREAM_STALL_ATTEMPTS` (default 2).
- **Why the message list, not memory.** On core 1.59 an aborted stream
  persisted NOTHING to `mastra_messages` — measured, not assumed (BST-1415):
  not the completed tool calls, not even the user's message. Mastra >= 1.62
  (BST-1667) changed that: its `MessageHistory` output processor persists the
  aborted attempt's transcript, partial tool calls filtered, without awaiting
  it — so the continuation is no longer the turn's only writer. The message
  list stays the recovery source because it is complete and synchronous, and
  re-sending the original request in a continuation stays non-duplicative
  because Mastra's `saveMessages` upserts by message id; the recovered-stall
  proof asserts exactly one user row and no abort marker.
- **`readProducedMessages()` returns `undefined` vs `[]` and the difference is
  SAFETY-CRITICAL.** `[]` means the attempt genuinely produced nothing (a stall
  before the first step), so continuing from the request alone re-runs nothing.
  `undefined` means we could not tell, and continuing would re-send the request
  as if the turn never started — every completed tool would execute a second
  time. A turn that cannot prove what it produced does NOT resume.
  An empty list is additionally CORROBORATED against what the attempt was
  observed to do: `terminalToolCallStates` gains an entry per completed tool
  call, so `produced.length === 0` while tools demonstrably ran is a
  contradiction and refuses recovery too. That trust would otherwise rest
  entirely on the reader, and being wrong reaches the re-execution outcome
  through the branch treated as safe.
- **Five refusals, all terminal:** user cancel (a decision, not a transport
  fault), budget exhausted, unreadable produced messages, produced messages that
  contradict completed tools, and `ToolCallInputStreamingTimeoutError` (a
  generation fault — re-sending the same prompt has no reason to change it).
  Recovery covers `StreamStalledError` only.
- **Recovery is never silent.** Each stall emits `run.stalled` and each
  continuation `run.resumed`, both carrying attempt/budget and the stall's full
  BST-1408 breadcrumb (phase, parts-seen, `lastPartType`). A RECOVERED stall is
  followed by no `run.failed`, so its `run.stalled` is the only durable record
  of it and must carry the whole breadcrumb, not a subset. A refused stall's
  `run.stalled` names the refusal.
- **Per-attempt state, EXCEPT billing.** `ToolLifecycleState` is built per
  attempt (`createTurnAttemptLifecycleState`), and the split is not uniform:
  latency and in-flight lifecycle (`streamStartedAtMs`, `firstTextLatencyMs`,
  the delegation tracker, the tool-call maps) are per attempt, because carrying
  them would mis-time latency and re-settle tools the replaced attempt already
  settled. BILLING is per TURN — a recovered turn really did spend the stalled
  attempt's tokens, and the `message-finish` is what the run ledger and spend
  analytics persist. `stepBilledCostUsd` / `stepCount` / the billed-cost flags
  carry directly; TOKENS ride separate `carried*` fields because Mastra's finish
  usage is cumulative over ONE stream and `stepped*` keeps its per-stream
  meaning for the steered finish. Context sizes never accumulate: they describe
  the latest step's prompt, and inflating them would claim a context window that
  never existed.
- **A replaced attempt SETTLES what it started.** The turn drains both
  `makeCancelledDelegationRunEventChunks` AND
  `makePendingToolOutputRunEventChunks` before discarding the attempt — the same
  pair the terminal path drains. Without the second, a tool whose only terminal
  observation was a `tool-output` part loses its `tool.completed` row and its
  duration outright, because the continuation treats that tool result as INPUT
  and never re-emits it.
- **One turn reports one `run.started`.** A continuation is a fresh
  `agent.stream`, so Mastra re-emits `start` and the mapper would produce a
  second `run.started`; `withoutDuplicateRunStarted` drops it, and `run.resumed`
  is what marks the new attempt. Left in, the timeline shows two "Assistant run
  started" rows for one turn and every started/finished aggregation
  double-counts recovered runs.
- **A continuation that cannot be CONSTRUCTED terminates like everything else.**
  `handleStreamFailure` already disposes the runtime and rethrows, so the turn
  must not dispose again (`dispose()` has no idempotency guard, and a throw from
  a second `mcpClient.disconnect()` would replace the original error). The turn
  yields the same visible-text + `run.failed` + error-finish triple instead of
  throwing mid-stream, which would have been the one ending whose cause is
  invisible in the durable timeline.
- **Only the INITIAL leg recovers.** Approval- and suspend-resume consume a
  one-shot approval/snapshot that cannot be re-issued, so they run through the
  same turn runner with `maxAttempts: 1` and keep the pre-BST-1409 behavior.
- **Construction failures still REJECT the returned promise.** The first attempt
  is built eagerly, before the generator is returned: a run rejected before any
  stream part must surface as a transport rejection the renderer renders as an
  error block (see the renderer safety net above), never as a mid-stream throw.
  Pinned by the `stream_failure`/`empty_stream` cases in `mastra-streaming.spec.ts`.
- **Construction errors retain cleanup failures.** Initial, approve, decline,
  and suspend-resume construction failures attempt runtime disposal once. If
  disposal also fails, the returned typed error carries both failures in an
  `AggregateError` cause and explicitly reports incomplete cleanup. An original
  `MastraAgentError` retains its code and context; successful cleanup rethrows
  that original error unchanged. Disposal attempts every cleanup owner and
  propagates one failure directly or multiple failures together. Delegated
  decision settlement follows the same runtime-wide contract (see
  `assistant-subagents.md`). Paired construction tests in
  `mastra-streaming.spec.ts` use the production Brainstrike runtime assembly
  with mocked Mastra constructors. They cover all
  four entry points, typed errors, and single or multiple cleanup failures.
- Paired tests: `mastra-stall-recovery.integration.spec.ts` (recovery, budget
  exhaustion, opt-out, user-cancel, continuation prompt contents, orphan drain
  across a recovery). Every recovery case asserts the TOOL-EXECUTION COUNT: a
  continuation that lost the completed steps would still answer plausibly, it
  would just re-run every tool first, so only the count proves the carry-forward.

