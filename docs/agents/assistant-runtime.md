# Assistant runtime

Use this contract when changing run execution, stream recovery, approvals, hooks,
plan mode or tracing. Desktop and CLI share the Electron-free agent host; each root or child
run uses the host-owned AI SDK loop. Mastra supplies memory, not a second loop,
permission engine or transcript writer. See [ADR-0012](../adr/0012-ai-sdk-loop-mastra-memory-library.md)
and [ADR-0017](../adr/0017-cli-first-agent-host.md).

## Execution and recovery

- Compose instructions from explicit inputs and the injected host clock. Tool
  descriptions and schemas must describe the admitted executable capability.
- Distinguish first provider output, reasoning activity, provider silence and
  host tool execution. SDK scaffolding does not count as provider output;
  reasoning alone is not an answer. Each child has its own watchdog.
- An expired tool guard cancels the work belonging to that tool call. A provider
  timeout must abort the provider; a timeout while a host tool runs is terminal
  rather than an opportunity to execute that tool again.
- Failed or abnormal finishes produce failed durable outcomes. Recoverable
  attempts are recorded before retry, stay on the committed branch, and never
  repeat a step that streamed tool input or a call. Context-overflow recovery
  requires a committed compaction that actually shortens the request.

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

## Hooks and plan mode

Project hooks require trust in the current file content; skipped or invalid
configuration remains visible. A pre-tool hook may further restrict an allowed
or approval-gated call, never override a deny. Hook context is bounded and does
not replace the raw tool result. Plan mode admits its read/propose tool set and
no delegation; unavailable plan-mode capabilities refuse explicitly.

Owner: [host hooks](../../packages/host-capabilities/src/hooks/host-run-hooks.ts).

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

Stop, deletion and host close fence admission and join provider, tool and memory
work before releasing storage or Root. A terminal outcome does not prove physical
retirement; failed joins remain visible and retain ownership. Live/replay details
belong to [persistence](assistant-persistence.md).
