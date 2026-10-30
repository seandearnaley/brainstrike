# Assistant runtime

Use this contract when changing run execution, stream recovery, approvals, hooks,
plan mode or tracing. Desktop and CLI share the Electron-free agent host; each root or child
run uses the host-owned AI SDK loop. Mastra supplies memory, not a second loop,
permission engine or transcript writer. See [ADR-0012](../adr/0012-ai-sdk-loop-mastra-memory-library.md)
and [ADR-0017](../adr/0017-cli-first-agent-host.md).

## Execution and recovery

- Compose instructions from explicit inputs and the injected host clock. Tool
  descriptions and schemas must describe the admitted executable capability.
- The stream watchdog never judges a running tool. The AI SDK's
  `onToolExecutionStart`/`onToolExecutionEnd` bracket each execution, and while
  any runs the watchdog has no window, as the SDK's own `chunkMs` never runs
  during tool execution. Each tool is bounded by its own guard, and a delegated
  child by its own run's watchdog and `maxChildRuntimeMs`. Otherwise it
  distinguishes first provider output, reasoning activity and provider
  silence; SDK scaffolding does not count as provider output, and reasoning
  alone is not an answer.
- An expired tool guard cancels the work belonging to that tool call. A provider
  timeout aborts the provider attempt.
- An MCP tool's guard is an inactivity budget (BST-1779). Each progress
  notification restarts its window (the resilience `toolTimeoutMs`, 60 s), up
  to the transport's own total (`DEFAULT_MCP_MAX_TOTAL_TIMEOUT_MS`, 600 s). A
  silent server ends at the window and a chatty one at the total. The timeout
  text says which, and the call is cancelled on the wire either way. The guard
  alone ends a silent call: such a request (`callerGuardsInactivity`) keeps the
  total as its SDK idle timeout, because the SDK re-arms its own 60 s timer on
  progress before the guard does and would otherwise end the call first, as an
  unexplained failure. A server's own `toolTimeoutMs` (1 s to 10 min) replaces
  the window for its tools, for servers that work long in silence; it also
  bounds that server's unguarded requests. The ceiling is the transport's
  default total. An MCP Tasks settlement wait fits in three quarters
  of what the call's guard has left once the task is tracked
  (`readToolGuardRemainingMs`). Native tools keep their flat guard.
- Failed or abnormal finishes produce failed durable outcomes. Recoverable
  attempts are recorded before retry, stay on the committed branch, and never
  repeat a step that streamed tool input or a call. Context-overflow recovery
  requires a committed compaction that actually shortens the request.
- Pre-request compaction measures the request the provider will receive. With
  Memory, that is the request Memory builds (its selected and recalled turns,
  rewritten tool outputs and system context), not the branch, and only the
  earlier turns that request holds can be compacted. Memory then reassembles the
  request from the log without re-running its step preparation. When the
  summarizer fails, the deterministic fallback's `context.compacted` records the
  typed failure code and the reference its cause is logged under.

Owners: [execution](../../packages/agent-host/src/core-run-execution.ts),
[watchdog](../../packages/agent-host/src/run-stream-watchdog.ts),
[ADR-0009](../adr/0009-host-run-loop-invariants.md).

## Consent and suspension

Core commits interaction requests and validated responses before effects run.
Responses name the exact thread, run, interaction and admitted tool identity;
stale or duplicate responses refuse. Questions, plans and network consent retain
canonical typed payloads, rather than UI-authored substitute arguments.

Per-tool and category denies beat grants. Session grants remain category-scoped;
children follow the root's live grants and reductions within their admitted
catalog. A grant commits before the resumed call sees it. Top-level decisions
survive restart, but uncertain started effects are interrupted and never
replayed. Child recovery follows [the delegation contract](assistant-subagents.md).
See [ADR-0010](../adr/0010-approvals-and-delegation.md) and
[continuations](../../packages/agent-host/src/run-continuation.ts).

The composer's access mode is the saved policy's `access` (ADR-0031). Full
access is the gate's `yolo`. In Auto, a call the policy asks about is reviewed
first by the chat provider's quick model ([auto-review](../../packages/agent-host/src/auto-review.ts)),
which sees user messages and tool calls but never tool results. Its approval
runs the call as the SDK's automatic approval; a flag or any review failure
asks the user, and the card shows the reviewer's reason.

Browser origins (BST-1178): the first `browserNavigate` call to each origin
(scheme, host, port) raises a `network` consent that names it, whatever the
policy or access mode. Allow once runs that call. Always allow and Don't allow are
saved by the host in its StateStore (`permissions/browser-origins`, wiped by
factory reset) before the answer commits, and answer every later call; Core
settles a denied call unrun, with a reason the model reads. Settings →
Permissions lists and removes them. Consent sees the requested URL only: a
page can still redirect or load elsewhere, through the egress proxy
([ADR-0025](../adr/0025-agent-browsing-egress-proxy.md)). A `localhost`,
`127.0.0.1` or `[::1]` dev server is answered on the same card, and the proxy
admits only that navigation's exact host and port.

## Hooks and plan mode

Project hooks require trust in the current file content; skipped or invalid
configuration remains visible. A pre-tool hook may further restrict an allowed
or approval-gated call, never override a deny. Hook context is bounded and does
not replace the raw tool result. Plan mode admits its read/propose tool set and
no delegation; unavailable plan-mode capabilities refuse explicitly.

Owner: [host hooks](../../packages/host-capabilities/src/hooks/host-run-hooks.ts).

## LSP source policy and freshness

Desktop LSP queries and post-edit diagnostics share a server per root. Each
operation opens its supplied document, reloads the TypeScript project and closes
the document in `finally`; operations serialize per root so temporary buffers
cannot shadow other queries' disk inputs. TypeScript remains the analysis owner.

Semantic output can reveal transitive source literals. Before and after analysis,
check the server's project source list against canonical root containment,
credential exclusions and current agent-ignore rules. Only the pinned compiler's
standard library declarations are trusted outside the root. An excluded or
unverifiable source withholds the whole semantic result with `reason: read-policy`,
even if the requested symbol is in an allowed file; an edit still applies.
Definition previews use the same bounded reader as direct workspace reads.
Owner: [document session](../../apps/desktop/src/assistant-server/lsp-document-session.ts).

## Tracing

The host traces its AI SDK calls as OpenTelemetry GenAI spans through the
vendor's `@ai-sdk/otel` integration: `invoke_agent` per call, `chat` per model
request, `execute_tool` per tool. Tracing is off unless the standard
`OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is set;
spans then export over OTLP/HTTP JSON as `service.name=brainstrike-agent-host`.
A set but unusable endpoint, protocol or content setting fails host startup.

- Each call names itself in `gen_ai.agent.name` (`brainstrike.host-run`,
  `brainstrike.thread-title`, `brainstrike.context-compaction`) and carries
  `ai.settings.context.runId` and `ai.settings.context.threadId`. A new
  host-owned `streamText`/`generateText` call spreads `hostTelemetry(...)`.
- Prompts, responses and tool payloads are excluded unless
  `BRAINSTRIKE_OTEL_RECORD_CONTENT=1`. Error messages are still recorded.
- Memory observer and reflector calls run inside Mastra and are not traced.

To view a run locally, start Jaeger and launch desktop with the endpoint set:

```sh
docker run --rm -p 16686:16686 -p 4318:4318 cr.jaegertracing.io/jaegertracing/jaeger:2.22.0
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm --filter @brainstrike/desktop dev
```

Open <http://localhost:16686> and pick `brainstrike-agent-host`. The CLI host
reads the same variables. Owner: [host tracing](../../packages/agent-host/src/telemetry/otel.ts).

## Clients and retirement

Conversation panels display an existing public runtime. Opening, closing or
switching a panel neither starts inference nor owns cancellation. Interaction
cards remain actionable through their host IDs, including after replay.

A desktop frame has one host connection. When its host is lost, it reconnects
once on its own, then waits for the user's Reconnect; views rebind from the
replacement's committed log. A send the lost host never answered is settled from
that log (interrupted, or returned to the composer as not sent), never resent.

A retiring host first announces `host/closing` on every connection, socket and
private alike (as HTTP/2's GOAWAY). That announcement, or an explicit
`host.closing` refusal, retires admission on that client connection for both
host RPC and catalog commands. Earlier replies still join; later commands return
the refusal without sending into the retiring transport. Once every request it
read is answered, the host sends `host/drained` as its last frame (as TLS's
close_notify). A request the transport's close leaves unanswered after that frame
was never read, so it is refused as `host.closing`, not lost. Without it (a crash,
even mid-retirement), an unanswered request may have run and stays
`host.connection-lost`. Other failures do not imply this terminal state.

Retirement keeps reads open while dispatched work joins, so new requests can
still receive closing refusals, and answers every request it read. A socket then
pauses reads and joins complete-frame decoding and response writes before
destroying the transport. An empty dispatch queue alone does not prove that the
reader has finished its received frames.

Stop, deletion and host close fence admission and join provider, tool and memory
work before releasing storage or Root. A terminal outcome does not prove physical
retirement; failed joins remain visible and retain ownership. Live/replay details
belong to [persistence](assistant-persistence.md).
