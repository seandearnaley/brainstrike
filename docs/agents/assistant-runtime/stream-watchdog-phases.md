# Stream inactivity watchdog phases — evidence

Supports `docs/agents/assistant-runtime.md` § "ASSISTANT RESILIENCE (CRITICAL)".
Read before changing `withInactivityTimeout`, the phase classifier, the `tool-executing` allow-list, resume-leg seeding, the tool-call-input window, or the empty-model-response guard. BST-1408, BST-1409, BST-839, BST-1777.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 192-408), extracted verbatim.

3. **Stream inactivity watchdog (LIVE)** —
   `packages/agent/src/stream/with-inactivity-timeout.ts` (`withInactivityTimeout`,
   `StreamStalledError`). `streamAttemptChunks` wraps the raw Mastra iterator.
   The window is PHASE-AWARE across FOUR phases (BST-1408, extended for
   reasoning, extended again for tool execution by BST-1777):
   `BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS` governs the wait for the
   provider to produce its first OUTPUT **in each step**,
   `BRAINSTRIKE_STREAM_REASONING_GAP_MS` every gap while it is emitting
   REASONING, `BRAINSTRIKE_STREAM_INACTIVITY_MS` every gap once it is
   demonstrably ANSWERING, and the derived `toolExecutingMs` while at least one
   tool call is EXECUTING — see the config list below for why they must not be
   re-merged, why the phase boundary is provider output rather than "the first
   part", and why a reasoning delta is not an answer. Since
   BST-1409 a stall ends the ATTEMPT, not the turn; see ATTEMPTS VS TURNS below.
   Only an unrecoverable stall emits a visible assistant message, a terminal
   `run.failed` event, and an error finish so the renderer does not remain
   in-flight forever.

   **The `tool-executing` phase (BST-1777).** A running tool's own silence is
   not the PROVIDER's — the provider already answered with a `tool-call` — so
   measuring it against the tight `streaming` window is what forced the guard
   itself to stay a flat 60s under every tool's own declared budget. The phase
   is tracked by REFERENCE COUNT (`toolCallId`) so parallel calls hold it open
   until the last one settles, and it OVERRIDES whichever provider phase is
   current: the classifier `createMastraToolExecutionPartKindReader` returns (`agent-streaming.ts`) classifies
   `tool-call` as `started`, and `tool-result` / `tool-error` /
   `tool-output-denied` / `tool-call-approval` / `tool-call-suspended` as
   `settled`. Approval and suspension SETTLE deliberately — the call is
   waiting on a HUMAN, not executing, and a human approval wait must never
   inherit the wide tool-executing backstop. `tool-output-denied` is the
   declined outcome and also settles. Scaffolding (`start`, `step-start`)
   CLEARS the in-flight set: a fresh step's tools are over, so a lost
   `settled` part can only ever tighten the next window, never hold the wide
   one open — except before this leg has seen ANY real provider output yet
   (see the resume-leg seeding paragraph below), which only delays when the
   clear can fire and never widens a later step's window. `providerPhase` is
   kept as separate state from the reported `phase` specifically so a
   `reasoning-end` marker arriving mid-tool cannot "preserve" `tool-executing`
   into the provider state machine.

   **Only a GUARDED call may enter the phase — an ALLOW-list, not a
   deny-list (BST-1777 final review, I2-C).** The wide window is only safe to
   enter because a per-call guard always fires first, so
   `hasExecutionGuardBehindToolCall`
   (`agent-streaming.ts`) checks a tool name against `runtime.toolNameMap`'s
   KEYS — exactly the set that went through `applyToolGuards` in
   `tool-pipeline.ts`, since that map is populated before the guard runs and
   nothing is added to it afterwards for a tool that skipped the guard.
   Membership is the allow-list; anything not in it defaults to `false` and
   stays on the tight window, per the file's closed-list rule (unknown ->
   tighten) — no growing enumeration required as new unguarded kinds appear.
   Three kinds are deliberately never in the set:
   provider-executed tools (native web search, injected AFTER
   `sanitizeTools`/`applyToolGuards`, marked `payload.providerExecuted ===
   true` — kept as an explicit check because that entry REPLACES a sanitized
   local name that IS still a key), subagent delegation tools
   (`agent-<personaId>`, registered directly on `new Agent({ agents:
   subAgents })`, never run through `combinedTools`/`sanitizeTools`), and
   Mastra-injected memory tools (`updateWorkingMemory`, `setWorkingMemory`,
   `recall` — see `internal-approval-exempt-tools.ts` — merged into the run's
   tool map by Mastra itself, after this pipeline runs). All three keep
   riding the ordinary provider-silence windows — recoverable, honestly
   diagnosed — instead of silently inheriting a terminal, mislabeled 635s
   wedge. `settled` parts are unaffected regardless of tool name (already a
   no-op for an id that was never added).

   **A DELEGATED child's calls are classified through the envelope (BST-1777
   PR review).** Mastra carries a foreground child's parts on the PARENT
   stream inside the delegation's `tool-output` envelope
   (`payload.output` = the child's own part; see `resolveChildDelegation` in
   `delegated-stream-projection.ts`), the child has no watchdog of its own,
   and the parent's `agent-<personaId>` call is deliberately unguarded — so
   classifying only the outer part left a child's guarded execution measured
   against the parent's `streaming` window. Harmless while the guard was a
   flat 60s; a regression once a child command may legitimately run to its own
   600s budget. The classifier therefore UNWRAPS a `tool-output` whose
   `toolName` starts with `SUBAGENT_DELEGATION_TOOL_PREFIX` and is not itself
   `providerExecuted` — POSITIVE identification, not "not in the guarded set"
   (round 2, CodeRabbit MAJOR): the latter is deny-shaped and also matches
   provider-executed tool outputs and Mastra-injected memory-tool outputs
   (`updateWorkingMemory`, `recall`, …), whose `output` could then be misread
   as a nested guarded `tool-call`. `executeCommand`/`runSkillScript`'s own
   `tool-output` parts are never delegation-prefixed, so their `output`
   (arbitrary tool data) is never unwrapped. The same allow-list applies to
   the nested part, recursing for a grandchild (also `agent-<personaId>`)
   under a fixed unwrap bound. Two deliberate consequences: a child/parent
   tool-call-id collision makes a nested `settled` release the parent's entry
   early, which tightens into a RECOVERABLE phase, not a consequence-free one
   — the still-running parent call drops back onto the provider windows,
   where a stall is classified `streaming`, and a `streaming` stall IS
   recoverable, so `runTurnAttempts` can re-send the step while the parent
   tool may still be alive (the second-execution hazard `isRecoverableStall`
   refuses `tool-executing` for). Collision probability across parent and
   child runs is negligible with provider-generated ids, so the keying is
   unchanged, but the envelope already carries the child `runId` that
   `resolveChildDelegation` reads, so a `runId:toolCallId` key is available if
   it ever needs to be; and a child's nested `step-start` does NOT reach the
   scaffolding clear (the outer `tool-output` counts as provider output), so a
   lost nested `settled` is cleared at the PARENT's next `step-start` — the
   same bound every other in-flight id has. BACKGROUND delegation is out of
   scope.

   **A resumed, approval-approved call is SEEDED into the phase (BST-1777
   final review, I1).** Mastra never replays a suspended step's `tool-call`
   part on the resume leg — only the human's answer resumes it — so the call
   that starts executing there has no `started` boundary for
   the classifier to observe. Left unseeded, that execution
   is measured against `firstOutputMs` (the provider's own silence budget)
   instead of `toolExecutingMs`, misclassifying the phase and its recovery
   semantics. `collectResumedGuardedToolCallIds` (`agent-streaming.ts`) passes
   `resumedApprovalToolCall` plus its siblings — filtered through the same
   `hasExecutionGuardBehindToolCall` predicate, so an unguarded resumed call is
   never seeded either — as `withInactivityTimeout`'s `initialToolCallIds`,
   which both seeds `toolCallsInFlight` and sets the very FIRST wait's phase to
   `tool-executing` before any part of the leg is even read. Because a resume
   leg can open with framework scaffolding (`start`/`step-start`) BEFORE the
   resumed call's own `tool-result`, the ordinary scaffolding-clear is gated on
   `hasSeenProviderOutput` (`with-inactivity-timeout.ts`) — a seeded id survives
   any leading scaffolding and is cleared only once this leg has actually
   produced real provider output, which still leaves the closed-list guarantee
   intact (a lost `settled` can only tighten a LATER step's window).
   **Pinned chunk boundary — do not relitigate.** Verified against the
   compiled `@mastra/core` 1.64.0 loop: Mastra's `tool-execution-start` /
   `tool-execution-end` chunks look like the obvious boundary but are emitted
   only `from: "NETWORK"` (agent networks) and never reach this stream; the
   agent loop's real boundary is `tool-call` -> `tool-result` | `tool-error`.
   A `tool-executing` stall is TERMINAL, not retried: `isRecoverableStall`
   (`turn-attempts.ts`) refuses recovery with `tool-still-executing`, since a
   continuation would re-send the step and risk launching a SECOND execution of
   a tool whose first call might still be alive.
   **What the backstop actually guarantees (PR review, honest wording).** Every
   GUARD window is below `toolExecutingMs` by construction, so a guard that
   answers is never pre-empted. Tool-lifecycle HOOKS are not covered: they
   compose OUTSIDE the guard (`tool-pipeline.ts`), the phase opens at the
   `tool-call` part before `PreToolUse` runs, and `hooks/config.ts`
   deliberately caps each hook individually with NO aggregate pre+tool+post
   ceiling — so the silence is `preHooks + guardWindow + postHooks` while
   `TOOL_EXECUTING_BACKSTOP_MARGIN_MS` is only 30s of slack. A long enough hook
   chain can therefore reach the backstop with a perfectly working guard. The
   visible message (`resolveStalledVisibleMessage`, `stream-termination.ts`)
   asserts only what is known: "A tool call was still running after `<ms>`ms,
   including its lifecycle hooks. The turn was ended rather than retried,
   because re-running the step could start a second execution of a command
   that may still be alive. If no PreToolUse/PostToolUse hook is slow, please
   report it with a debug bundle." No aggregate hook cap and no new env knob
   were added — do not add one without a measured case.
   An EMPTY MODEL RESPONSE rides the same attempt rails: a terminal `finish`
   whose reason would complete the run, on a turn the model contributed
   NOTHING to (no text/reasoning delta carrying a non-whitespace character —
   whitespace-only output renders an equally empty bubble — and no
   tool-lifecycle part, across every attempt; the deltas themselves still
   stream, since formatting whitespace between real tokens is meaningful —
   `ToolLifecycleState.sawModelContribution`, carried
   like the billing flags; resume legs initialize it true because the resumed
   tool call is model output), throws `EmptyModelResponseError` from the
   mapper's `finish` case instead of completing. Field case 2026-08-23:
   OpenRouter's `stealth/ox-alpha` route degraded into HTTP 200 streams with
   one instant zero-usage step and a clean `stop` finish; mapping that to
   `run.finished` painted an empty assistant bubble marked "success". An
   ABNORMAL finish reason is deliberately NOT re-classified — it already fails
   the run with its own truth (gate: `COMPLETED_FINISH_REASONS`, shared with
   `makeTerminalRunEvent` so the two cannot drift).
   The adjacent `withToolCallInputTimeout` wrapper applies its OWN, much wider
   `BRAINSTRIKE_TOOL_CALL_INPUT_MS` window as an absolute deadline from the
   first streamed tool-input marker to its matching input end/complete call.
   `tool-call-delta` proves transport activity and continues to render
   progress, but it never extends that deadline: a provider cannot keep a run
   alive indefinitely by dribbling incomplete JSON arguments. The two windows
   are DELIBERATELY decoupled and must not be re-merged (BST-839): the
   inactivity window asks "is the transport still delivering parts?", this one
   asks "will this call ever become executable?". Reusing the 120s inactivity
   window as the input budget false-positived on legitimate large argument
   payloads — a model writing tens of KB of file content streams argument
   deltas continuously for minutes on a slow upstream route (observed on
   OpenRouter → GLM, which took >120s to stream one file-write input while the
   transport was demonstrably healthy). The wrapper ignores non-tool stream parts before
   probing tool-call IDs, so ordinary text and reasoning deltas do not allocate
   identifier candidate arrays. Expiry uses the distinct
   `tool_call_input_streaming_timeout` terminal code and aborts before an
   incomplete call can execute. A complete call leaves this layer and remains
   governed by the ordinary per-tool execution guard.
   Every initial, approval-resume, and suspended-tool-resume stream owns an
   internal AbortController linked to the caller's signal. The watchdog rejects
   with `StreamStalledError` first, then aborts that exact controller so provider
   work cannot outlive the terminal stream without misclassifying the timeout as
   a user cancellation. Stream teardown also aborts the controller before
   disposal, preventing late provider progress/results from reaching a closed
   consumer. For the built-in local provider this signal crosses
   `LlmHostChatModel → LocalLlmHostClient → LlmHostManager`, removes the exact
   pending request, and sends the hidden renderer's cancel command.
   When watchdog expiry or caller Stop aborts a memory-backed turn, Mastra
   (>= 1.62) itself persists the cancelled run's transcript through its
   `MessageHistory` output processor — completed tool work and any partial
   text, partial tool calls filtered — without awaiting that write. The stream
   adapter's abort seam (`mastra/aborted-turn-persistence.ts`) then persists
   the user input, every assistant message with its partial text RETAINED, and
   only COMPLETED tool invocations from Mastra's live `MessageList`, appends
   `[Assistant turn aborted before completion.]` as the last text part, and
   awaits the save before runtime disposal. Incomplete tool calls are the one
   thing excluded, so Stop cannot resurrect execution on the next turn; the
   awaited save is also the join that keeps Mastra's floating write from racing
   storage close (contract and measurements in
   `docs/agents/assistant-persistence.md`). The same finalizer covers approval
   and suspended-tool resume streams, while Mastra read-only memory remains
   write-free. Ordinary completion still uses Mastra's finish writer only;
   teardown never performs a second normal write.

   Delegated children (BST-1719) capture their native MessageList on the abort
   signal, independent of consumer speed. Mastra's public `afterToolCall` hook
   joins the native child writer before the same abort snapshot is saved.
   `runTurnAttempts` awaits child finalizers before replacing a stalled attempt
   and before runtime disposal, even when the parent later finishes normally. Native `lastMessages: false`
   disables the child's automatic MessageHistory output processor, so the
   root-only join is insufficient. No incomplete child tool call is restored
   by a late native save. See `assistant-subagents.md` for the real desktop
   cancellation/reconstruction proof and the remaining nested-resume boundary.

