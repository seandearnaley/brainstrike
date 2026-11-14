# Assistant runtime

Covers run execution, stream recovery, approvals, hooks, plan mode and tracing. Desktop and CLI share the Electron-free agent host; each root or child run uses the host-owned AI SDK loop. Core assembles each request from the committed log and the host's compaction is the only thing that replaces history; Mastra supplies narrow utilities, not a second loop, permission engine, transcript writer or memory. See [ADR-0012](../adr/0012-ai-sdk-loop-mastra-memory-library.md), [ADR-0017](../adr/0017-cli-first-agent-host.md) and [ADR-0039](../adr/0039-host-is-the-only-compactor.md).

## Execution and recovery

Owners: [execution](../../packages/agent-host/src/core-run-execution.ts), [watchdog](../../packages/agent-host/src/run-stream-watchdog.ts), [ADR-0009](../adr/0009-host-run-loop-invariants.md).

- Compose instructions from explicit inputs and the injected host clock. Tool descriptions and schemas describe the admitted executable capability.
- The stream watchdog never judges a running tool.
  - AI SDK `onToolExecutionStart`/`onToolExecutionEnd` bracket each execution; while any runs the watchdog has no window.
  - Each tool is bounded by its own guard; a delegated child by its own run's watchdog and `maxChildRuntimeMs`.
  - Otherwise it tells first provider output, reasoning activity and provider silence apart. SDK scaffolding is not provider output; reasoning alone is not an answer.
  - `streamText`'s own `timeout` is not used: `firstChunkMs` starts after the response headers, `chunkMs` is one window for reasoning and answer gaps, and `stepMs` includes tool execution.
- An expired tool guard cancels that call's work. A provider timeout aborts the provider attempt.
- Native tools have a flat guard. An MCP tool's guard is an inactivity budget:
  - each progress notification restarts the window (resilience `toolTimeoutMs`, 60 s), up to the transport total (`DEFAULT_MCP_MAX_TOTAL_TIMEOUT_MS`, 600 s)
  - a silent server ends at the window, a chatty one at the total; the timeout text says which, and the call is cancelled on the wire either way
  - the guard alone ends a silent call: guarded requests (`callerGuardsInactivity`) use the total as the SDK idle timeout, because the SDK re-arms its own 60 s timer first and would otherwise end the call as an unexplained failure
  - a server's own `toolTimeoutMs` (1 s to 10 min) replaces the window for its tools and bounds its unguarded requests; the ceiling is the transport total
  - an MCP Tasks settlement wait fits in three quarters of the guard's remaining time once the task is tracked (`readToolGuardRemainingMs`)
- Failed or abnormal finishes produce failed durable outcomes.
  - Recoverable attempts are recorded before retry, stay on the committed branch and never repeat a step that streamed tool input or a call.
  - Context-overflow recovery needs a committed compaction that actually shortens the request.
- Pre-request compaction measures the request the provider will receive, before every step of a run (BST-2531).
  - Each step's request is built from the committed branch (`prepareRunContext`), so a compaction committed at any step, or before an approval pause, holds for every later step and leg.
  - It triggers at 90% of the run's input budget or its compaction cap (200,000 tokens by default), whichever is less, and reclaims toward 7/9 of that trigger. `deriveContextCompactionThreshold` in `assistant-contract` is the one derivation; the admission carries the cap beside `inputTokenLimit`.
  - A person sets the cap in the composer's Output & Limits ("Compact at", at least 64,000, no upper bound). It rides the desktop intent as `agentLoop.compactionTokenCap` only when set, so a recovered run keeps its captured cap; the standalone intent carries none.
  - The production admission turns an unset cap into the default (`resolveContextCompactionTokenCap`), the same call Settings and the context meter use.
  - The trigger is the context meter's one denominator: the composer derives it from the run's budget and cap, the ring is full when the thread compacts, and warning (75%) and critical (90%) read against it. The Context tab's bar shows the same figure.
  - Past the trigger it summarizes only when what it can drop (kept steps are not droppable) reaches the target or holds at least one protect window (20,000 estimated tokens), `compactionReclaims`. Otherwise the request goes as it is; overflow recovery and the request trim stay the last resort.
  - The size is what the provider last reported: the branch's latest `model.step` input tokens, else its latest `provider.request.prepared` `accounting.totalTokens`, plus the chars/4 estimate of what the branch committed after that request. A committed compaction voids every earlier report of its thread.
  - With nothing reported, it is the chars/4 estimate of the request's messages plus the run's instructions and tool definitions. Turns and steps are always sized by the estimate when choosing which to drop.
  - So what a compaction must reclaim, the request's excess over the target, is scaled to the estimate's tokens by the request's estimate, its note included, over its measured size (BST-2541); a size nothing reported is already the estimate. A provider may count a request as more tokens than chars/4 (Anthropic about 1.5 times read-heavy text); unscaled, the run went on past the trigger until what it could drop matched the provider's count.
  - Every turn on the branch that no compaction covers is sent; there is no history window.
- What one compaction replaces (`compaction-segments.ts`):
  - Earlier turns whole, except the current turn, the one before it, the newest turns up to 20,000 estimated tokens and any turn that called a skill or plan tool.
  - The current run's older steps, as `through: { runId, stepNumber }`: its steps up to that one leave the request and its user message stays. The newest steps up to 20,000 estimated tokens stay word for word, and the cut falls only where every tool call has its result.
  - A step ends where the next begins (`HostRunState.stepEnds`), so it holds the approval results and notices committed after it; a run's newest step has not ended and is never replaced.
  - Among the replaced steps, one that loaded a skill or holds an `askUser` or `submitPlan` result stays word for word, by the same predicate that protects a whole turn. It does not stop the cut: the steps around it are still replaced. The event records it in `through.kept`, so what a compaction replaced stays one committed fact.
  - A row without `through` covers whole turns only. `compactedRunIds` is empty when its summary covers only steps.
  - A compaction belongs to the run that made it and the runs that follow it. A sibling branch never reads it, even for turns they share: it keeps those in full until a run of its own compacts them.
  - The overlay, the note, the request's provenance (`hostProviderHistory`), the fallback drop, the host's lists, the card's step count and the context fold all read `through` and its `kept` steps. Tool discovery reads the whole committed branch, so a tool loaded in a replaced step stays loaded.
- What a compaction tells the model (BST-2527): a branch carries one current summary.
  - The summary call is the run's own next request (BST-2532, `compaction-summary-call.ts`): built by the step's own builder (`hostStepRequest`) with the run's instructions, tool definitions and tool choice, the branch's context as that request carries it, through the run's provider request boundary, then one host message asking for the summary. It shares the prefix the run's last request cached, which a request cut at the compaction could not read: a cache entry is written only at a request's breakpoint and read from at most 20 blocks before another's.
  - The tools go without their executors: an answer that calls a tool is a failed summary (`compaction.summary-tool-call`) and never runs. The call commits no `provider.request.prepared`; its usage, cache reads included, is the compaction's `usage`.
  - The model writes `Goal`, `Constraints`, `Decisions`, `Errors and fixes`, `State` and `Next` (`hasCompactionSummarySchema`, which also reads bold headers) over the whole context it read: its note first, so the current summary is merged into one.
  - The host writes three lists from the log for everything the summary covers (`compaction-ledger.ts`), derived again at each compaction. A kept step is still in the request, so they leave it out:
    - `Files edited`: each path the covered calls edited (`workspace.edit.recorded`) and its count of edits.
    - `Tools loaded`: what the run's own discovery reads as loaded in the covered messages.
    - `Earlier requests`: each wholly covered turn's prompt, the person's own words only, cut at 1,000 characters with `[truncated]`, the newest kept within 4,000. A step-level compaction adds none: the run's user message is still sent.
  - The event lists every turn it covers and the newest step cut, with every step of that run any compaction kept (`through`); no event is rewritten. Cuts are the union of the branch's compactions; the note reads one: the branch's newest, which merged the summaries before it.
  - The note leads the request's history as the host's notice (a user message marked as the host's and fenced as `<brainstrike_notice>`), never the system text, so a compaction leaves the run's instructions, its project memory section and its tool definitions cached. A request the boundary trims keeps the note as it keeps the system text: the host names it (`leadingNote`), the trim keeps it and the newest messages that fit, and it is never counted as left out.
  - A deterministic fallback (failed summary, overflow recovery, request trim) carries the host's lists, keeps the current summary as it was and adds its drop line.
- Each request passes the provider request boundary (`run-provider-request.ts`), which filters, measures and limits the prompt against the run's provenance (`run-history.ts`) and commits a `provider.request.prepared` receipt.
  - When it still has to drop the oldest messages to fit, the same commit carries a deterministic `context.compacted` with reason `request-trim` naming the turns and steps it left out, so the thread shows a card. With the every-step check this should not happen in ordinary use.
  - The SDK's retries of a step send the same request; its trim is named once, by the first attempt that trims, so one compaction commits beside every attempt's receipt.
- When the summarizer fails, the deterministic fallback's `context.compacted` records the typed failure code and its cause's log reference, and drops only the oldest turns and steps that reach the target.
- Context-overflow recovery measures the same way and drops toward the same target, at least one turn or step.

## Consent and suspension

See [ADR-0010](../adr/0010-approvals-and-delegation.md) and [continuations](../../packages/agent-host/src/run-continuation.ts).

- Core commits interaction requests and validated responses before effects run.
  - Responses name the exact thread, run, interaction and admitted tool identity; stale or duplicate responses refuse.
  - Questions, plans and network consent keep canonical typed payloads, not UI-authored substitute arguments.
- Per-tool and category denies beat grants.
  - Session grants stay category-scoped. Children follow the root's live grants and reductions within their admitted catalog.
  - A grant commits before the resumed call sees it.
- Top-level decisions survive restart; uncertain started effects are interrupted, never replayed. Child recovery follows [the delegation contract](assistant-subagents.md).
- The composer's access mode is the saved policy's `access` (ADR-0031). Full access is the gate's `yolo`.
- In Auto, a call the policy asks about is first reviewed by the chat provider's quick model ([auto-review](../../packages/agent-host/src/auto-review.ts)).
  - The reviewer sees the person's requests and the assistant's tool calls, never tool results.
  - Requests come from the committed branch, not message roles: a delegation's task or delivered child results are not the person's words.
  - Its approval runs the call as the SDK's automatic approval. A flag or any review failure asks the user, and the card shows the reviewer's reason.
- Browser origins: the first `browserNavigate` call to each origin (scheme, host, port) raises a `network` consent naming it, whatever the policy or access mode.
  - Allow once runs that call. Always allow and Don't allow are saved by the host in its StateStore (`permissions/browser-origins`, wiped by factory reset) before the answer commits, and answer every later call.
  - Core settles a denied call unrun, with a reason the model reads. Settings → Permissions lists and removes saved answers.
  - Consent sees the requested URL only; a page can still redirect or load elsewhere, through the egress proxy ([ADR-0025](../adr/0025-agent-browsing-egress-proxy.md)).
  - A `localhost`, `127.0.0.1` or `[::1]` dev server is answered on the same card, and the proxy admits only that navigation's exact host and port.

## Hooks and plan mode

Owner: [host hooks](../../packages/host-capabilities/src/hooks/host-run-hooks.ts).

- Project hooks need trust in the current file content, recorded for the root's repository (ADR-0032); skipped or invalid configuration stays visible.
- A pre-tool hook may further restrict an allowed or approval-gated call, never override a deny.
- Hook context is bounded and never replaces the raw tool result.
- Plan mode admits its read/propose tool set and no delegation; unavailable plan-mode capabilities refuse explicitly.

## LSP source policy and freshness

Owner: [document session](../../packages/host-capabilities/src/native-tools/lsp-document-session.ts).

- Agent-host LSP queries and post-edit diagnostics (desktop and standalone) share a server per root.
  - Each operation opens its supplied document, reloads the TypeScript project and closes the document in `finally`.
  - Operations serialize per root so temporary buffers can't shadow other queries' disk inputs. TypeScript stays the analysis owner.
- Semantic output can reveal transitive source literals, so before and after analysis check the server's project source list against canonical root containment, credential exclusions and current agent-ignore rules.
  - Only the pinned compiler's standard library declarations are trusted outside the root.
  - An excluded or unverifiable source withholds the whole semantic result with `reason: read-policy`, even if the requested symbol is in an allowed file; an edit still applies.
- Definition previews use the same bounded reader as direct workspace reads.

## Command sessions and terminals

Owner: [command sessions](../../packages/host-capabilities/src/command-sessions/index.ts).

- Desktop and standalone hosts compose `inspectCommandSessions` and `manageCommandSession` over one process-lifetime session manager.
- A session starts only in its run's admitted roots, and the host's close ends every session with its language servers and shell commands.
- The desktop's Terminal panel ptys sit beside that manager and serve only the desktop's private client.
- `node-pty` is a host-capabilities dependency. Its N-API binary loads unchanged in Node and Electron, so the CLI and the desktop bundle resolve the same build.

## Tracing

Owner: [host tracing](../../packages/agent-host/src/telemetry/otel.ts).

- The host traces its AI SDK calls as OpenTelemetry GenAI spans through the vendor's `@ai-sdk/otel` integration: `invoke_agent` per call, `chat` per model request, `execute_tool` per tool.
- Tracing is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is set; spans then export over OTLP/HTTP JSON as `service.name=brainstrike-agent-host`.
  - A set but unusable endpoint, protocol or content setting fails host startup.
  - Desktop and the CLI host read the same variables; any local OTLP/HTTP collector (e.g. Jaeger on port 4318) works.
- Each call names itself in `gen_ai.agent.name` (`brainstrike.host-run`, `brainstrike.thread-title`, `brainstrike.context-compaction`) and carries `ai.settings.context.runId` and `ai.settings.context.threadId`. A new host-owned `streamText`/`generateText` call spreads `hostTelemetry(...)`.
- Prompts, responses and tool payloads are excluded unless `BRAINSTRIKE_OTEL_RECORD_CONTENT=1`. Error messages are still recorded.

## Clients and retirement

- Conversation panels display an existing public runtime. Opening, closing or switching a panel neither starts inference nor owns cancellation.
- Interaction cards stay actionable through their host IDs, including after replay.
- A desktop frame has one host connection.
  - When its host is lost it reconnects once on its own, then waits for the user's Reconnect; views rebind from the replacement's committed log.
  - A send the lost host never answered is settled from that log (interrupted, or returned to the composer as not sent), never resent.
- A retiring host first announces `host/closing` on every connection, socket and private alike (like HTTP/2's GOAWAY).
  - That announcement, or an explicit `host.closing` refusal, retires admission on that client connection for both host RPC and catalog commands.
  - Earlier replies still join; later commands return the refusal without sending into the retiring transport.
  - Once every request it read is answered, the host sends `host/drained` as its last frame (like TLS's close_notify). A request the transport's close leaves unanswered after that frame was never read, so it is refused as `host.closing`, not lost.
  - Without `host/drained` (a crash, even mid-retirement), an unanswered request may have run and stays `host.connection-lost`. Other failures don't imply this terminal state.
- Retirement keeps reads open while dispatched work joins, so new requests still get closing refusals, and it answers every request it read.
  - A socket then pauses reads and joins complete-frame decoding and response writes before destroying the transport.
  - An empty dispatch queue alone doesn't prove the reader has finished its received frames.
- Stop, deletion and host close fence admission and join provider and tool work and the run's admission before releasing storage or Root.
  - Stop commits its intent in the host's one admission queue and joins the stopped work outside it, so a tree slow to die holds only its own Stop's reply and that thread's next run, never another thread's command.
  - A terminal outcome doesn't prove physical retirement; failed joins stay visible and keep ownership.
- Live/replay details: [persistence](assistant-persistence.md).
