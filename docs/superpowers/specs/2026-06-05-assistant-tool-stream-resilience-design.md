# Assistant Tool & Stream Resilience — Design

- **Date:** 2026-06-05
- **Branch:** `harden/assistant-tool-stream-resilience`
- **Workstream:** #1 of 5 in the assistant-hardening decomposition (Resilience / "rock solid")
- **Status:** Approved approach; pending spec review

## Problem

The assistant's tool → stream chain has **no timeouts and no watchdog** anywhere. If an
internal tool, an MCP tool, or an embedding query hangs, the entire thread freezes with no
error and no recovery. Observed mechanism (confirmed in code):

1. A tool's `execute()` awaits something that never settles (e.g. `generateQueryEmbedding`,
   a slow/hung MCP server, a wedged GPU/network call). `execute` has no timeout.
2. Mastra's tool loop never emits the next part, so `for await (const part of
   readableStreamIterator(stream, signal))` in `streamChunksFromMastra`
   ([agent-runtime.ts:1060](../../../packages/agent/src/mastra/agent-runtime.ts)) blocks
   forever.
3. `AssistantDataStreamSession.consumeSource()` never resolves
   ([data-stream.ts:148](../../../packages/agent/src/stream/data-stream.ts)), so
   `startProcessing()`'s `finally → finalizeStream()` never runs. The stream never closes.
4. The renderer sits on a spinner. A page refresh "fixes" it only because it discards the
   dead in-memory stream.

A secondary failure: today's tool error helper `handleToolError()` is typed `: never` and
**always rethrows** ([types.ts:34](../../../packages/agent/src/tools/types.ts)). Whether a
thrown tool error degrades gracefully into a `tool-error` part or aborts the run depends on
Mastra's tool-loop policy, which we do not pin. MCP tools have no equivalent guard at all.

## Goals

- A hung or erroring tool — **internal or MCP** — never freezes the thread. The model
  receives a structured error result and the run continues.
- A stalled stream (provider/network/Mastra-internal, i.e. anything the per-tool guard
  can't catch) **always** terminates with a real error + finish, so the renderer spinner
  always resolves.
- A renderer-side exception in the assistant panel produces a recoverable terminal state,
  not a "dead until refresh" tree.
- Failures are observable in the run timeline (a `tool.failed` / run failure event with a
  reason), not silent.
- Behavior is covered by red→green automated tests (unit + integration + one desktop
  Playwright smoke).

## Non-Goals (explicitly deferred to later workstreams)

- Background-indexer ↔ embedding-query coordination (workstream #2).
- Tool-call UI redesign: vertical density, badges, spinner-state correctness, per-tool
  tinting, args/results display (workstream #3). This PR adds the *minimum* renderer change
  for resilience only.
- Reasoning persistence & tool-effectiveness/prompting (workstream #4).
- Message-toolbar polish (workstream #5).

## Design

Three small, independently-testable units. Timeout ordering is intentional:
`tool-execute timeout (~60s) < stream-inactivity timeout (~120s)` so a single hung tool is
caught by the guard (run continues) before the watchdog ever fires; the watchdog only
catches stalls the guard structurally cannot.

### Unit 1 — `guardToolExecution` (per-tool guard)

- **New module:** `packages/agent/src/tools/guard-tool-execution.ts`
- **Applied at the choke point:** every native + MCP tool flows through the `combined`
  object returned by `collectCombinedTools()`
  ([mcp-tool-loader.ts:78](../../../packages/agent/src/mastra/mcp-tool-loader.ts)). Route
  each executable tool through the guard there, reusing the existing clone-and-replace-
  `execute` pattern already used by `wrapMcpToolOutputs`
  ([mcp-tool-loader.ts:89](../../../packages/agent/src/mastra/mcp-tool-loader.ts)).
- **Behavior:** wrap `execute` so it races the original against `BRAINSTRIKE_TOOL_TIMEOUT_MS`.
  On timeout **or** any thrown error, return a **structured result** (approved decision):

  ```ts
  type GuardedToolError = {
    ok: false;
    error: { code: 'tool_timeout' | 'tool_failed'; message: string; toolName: string };
  };
  ```

  This is deterministic: the model always receives a tool result and the loop continues,
  independent of Mastra's internal error policy. The message is sanitized (reuse the
  safe-error filtering intent of `handleToolError`); raw errors are logged, not surfaced.
- **Observability:** emit/record a `tool.failed` run event (reason `timeout` | `error`) so
  the timeline reflects it.
- **Interaction with existing `handleToolError`:** tools may keep throwing internally; the
  guard is the outer net that converts throws to structured results. `handleToolError` stays
  as-is (no behavior change to individual tools in this PR).

### Unit 2 — Stream inactivity watchdog

- **New module:** `packages/agent/src/stream/with-inactivity-timeout.ts` — an async-iterator
  wrapper `withInactivityTimeout(source, ms)` that races each `.next()` against an inactivity
  timer (reset on every yielded item). On timeout it **throws** a typed `StreamStalledError`.
- **Applied** around the raw Mastra read inside `streamChunksFromMastra`: wrap
  `readableStreamIterator(stream, runtimeData?.signal)`
  ([agent-runtime.ts:1060](../../../packages/agent/src/mastra/agent-runtime.ts)). Inactivity
  is measured on **raw Mastra parts** (not output chunks) so a legitimately long tool call
  that still emits `tool-call`/`step` parts is not falsely flagged.
- **Why throwing is correct here:** a throw out of the `for await` propagates to
  `consumeSource()` → `startProcessing()`'s existing `catch` → `mapper.handleError()` →
  `finally → finalizeStream()` (real `error` + `finish` chunks). This **reuses the proven
  error-closing path** instead of adding new finalize logic, and triggers the existing
  `finally` in `streamChunksFromMastra` that calls `runtime.dispose()`
  ([agent-runtime.ts:1090](../../../packages/agent/src/mastra/agent-runtime.ts)), so the
  underlying Mastra run/reader is cancelled and disposed.
- **User-cancel vs stall (the current ambiguity):** `StreamStalledError` is a distinct typed
  error → it produces a visible `error` chunk. A user stop continues to flow through the
  existing `aborted`/`signal.aborted` path and stays silent. The two are no longer
  conflated.
- **Config:** `BRAINSTRIKE_STREAM_INACTIVITY_MS` (default 120000).

### Unit 3 — Renderer safety net

- **Error boundary** around the assistant panel (wrap `AssistantUiPanel` /
  `assistant-ui-panel-wrapper.tsx`) so a render-time exception shows a recoverable
  fallback + "retry/reset thread" affordance instead of a blank/dead tree.
- **Terminal-error surfacing:** confirm both runtime adapters
  (`data-stream-runtime.ts`, `local-runtime-adapter.ts`) translate a stream `error` chunk
  into a terminal assistant message **and** re-enable the composer (clear "running" state).
  If they already do, add a regression test; if not, fix.
- This is the minimum renderer change to make Units 1+2 actually visible to the user;
  broader UI work stays in workstream #3.

## Configuration (strict parsing — no silent fallbacks)

Per the project "no silent fallbacks" rule, both values are parsed strictly: a present-but-
malformed value (non-integer, out of range) **throws at startup** rather than coercing. An
absent value uses the documented default.

| Env var | Default | Meaning |
|---|---|---|
| `BRAINSTRIKE_TOOL_TIMEOUT_MS` | `60000` | Max wall-clock per tool `execute` before structured timeout result |
| `BRAINSTRIKE_STREAM_INACTIVITY_MS` | `120000` | Max silence between raw Mastra stream parts before `StreamStalledError` |

Mirror the existing strict pattern used for `mcpTimeoutMs` / `VITE_EMBED_*`.

## Testing (red → green)

1. **Unit — guard timeout (RED first):** a tool whose `execute` never resolves ⇒ assert the
   guarded `execute` resolves to `{ ok:false, error:{ code:'tool_timeout', ... } }` within
   the configured timeout. Fails today (hangs).
2. **Unit — guard throw:** a tool whose `execute` throws ⇒ assert structured
   `tool_failed` result, raw message not leaked, error logged.
3. **Unit — `withInactivityTimeout`:** a source that yields then goes silent ⇒ throws
   `StreamStalledError` after `ms`; a source that keeps yielding never throws; an early-
   completing source passes through unchanged.
4. **Integration — session closes on stall:** build an `AssistantDataStreamSession` over a
   source that stalls ⇒ assert it emits an `error` chunk + `finish` and `isClosed()` becomes
   `true` (today it never closes).
5. **Integration — user-cancel stays silent:** cancelling the response stream does **not**
   emit a `StreamStalledError` chunk.
6. **Desktop Playwright smoke:** with a tool stubbed to fail, the thread renders a terminal
   error message and the composer re-enables (no refresh needed). Register the new test file
   in `scripts/test-lanes.mjs` if applicable.

CI parity gate (AGENTS.md): clean build, lint, type-check, and unit/integration tests must
all pass together in one run before the PR is opened.

## Risks & mitigations

- **Mastra ignores a returned structured error and still treats the call as unresolved.**
  Mitigated by the watchdog backstop and by test #1/#4 proving end-to-end closure.
- **False-positive stalls during legitimate long model thinking.** Mitigated by measuring
  inactivity on raw parts (reasoning/text deltas reset the timer) and a generous default;
  configurable.
- **Disposal/cancel races when the watchdog fires mid-tool.** The throw path uses the
  existing `finally`/`reader.cancel()`/`runtime.dispose()` machinery; covered by integration
  tests.

## Files (anticipated)

- New: `packages/agent/src/tools/guard-tool-execution.ts` (+ test)
- New: `packages/agent/src/stream/with-inactivity-timeout.ts` (+ test)
- Edit: `packages/agent/src/mastra/mcp-tool-loader.ts` (route `combined` through guard)
- Edit: `packages/agent/src/mastra/agent-runtime.ts` (wrap iterator with watchdog)
- New/Edit: a small strict env-parsing helper for the two timeouts, colocated with the
  agent/stream config (exact module chosen in the plan; mirrors the existing `mcpTimeoutMs`
  parsing)
- Edit: `packages/ui/src/assistant-ui-panel/*` (+ wrapper) for error boundary + terminal-
  error surfacing
- Edit: `data-stream.ts` integration test scaffolding as needed
- Possibly: `scripts/test-lanes.mjs` (register new db/package tests if required)
