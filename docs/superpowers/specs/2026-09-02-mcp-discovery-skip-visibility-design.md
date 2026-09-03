# MCP discovery skips must be visible (design)

Date: 2026-09-02
Status: approved, ready for implementation planning
Area: `packages/agent` (MCP tool loader, runtime, streaming), `packages/assistant-contract`,
`packages/assistant-ui`

## Problem

`packages/agent/src/mastra/mcp-tool-loader.ts` degrades per-run MCP tool discovery silently,
violating the AGENTS.md rule that broken capabilities "throw or surface visibly — never coerce,
never degrade quietly."

Three concrete paths:

1. `fetchMcpToolsetsWithTimeout` races `mcpClient.listToolsetsWithErrors()` against
   `DEFAULT_MCP_TIMEOUT_MS = 5000`. On rejection or timeout it logs and returns `undefined`;
   `collectCombinedTools` then returns only the local tools. The run proceeds with **zero** MCP
   tools.
2. `logMcpToolsetErrors` does the same for a single server's `listTools` failure. That server's
   tools are absent from the run.
3. `pickMcpDiscoveryLogMethod` demotes exactly the two likeliest reasons — a `reason` containing
   `"Connection closed"` or `"mcp_tool_discovery_timeout"` — to `logger.debug`. At `LOG_LEVEL=info`
   there is no record at all.

### Observable consequence

Confirmed 2026-09-02 while diagnosing BST-1602. When an MCP tool is missing from the run's tool
map, `search_tools` returns "0 results" and the model's subsequent call to that tool fails fast
with a `"Tool execution failed."` tool result. Under an `ask` MCP permission policy the tool never
reaches the approval gate. The user sees a normal-looking assistant answer with a failed tool card
and no indication that their MCP server was skipped for that request.

There are currently no tests and no docs pinning any of this behaviour.

## What this change does NOT do

- **It does not change the 5s timeout.** A 5s ceiling on cold stdio server startup is a plausible
  root cause of BST-1602, but changing it is a separate behavioural change with its own blast
  radius. This change makes the skip observable first. Related and also unchanged: `mcpTimeoutMs`
  is threaded end to end (`MastraAgentRuntimeOptions` → `composeRuntimeToolMap` →
  `collectCombinedTools.timeoutOverrideMs`), but the only two call sites that pass it are an e2e
  helper and a spec, both passing `undefined`. So 5s is always the effective production value.
  Recorded as a follow-up, not fixed here.
- **It does not hard-fail the run.** One flaky MCP server would then break every chat turn,
  including turns that never needed that server.
- **It does not tell the model.** Injecting the skipped-server fact into the prompt is a
  model-behaviour and prompt-cost change; out of scope.

## Design

### 1. Separate detection from presentation

The root cause of the silence is that `mcp-tool-loader.ts` both detects the skip and decides how
loudly to report it, via a substring heuristic (`pickMcpDiscoveryLogMethod`) buried in a loader.

The change splits those responsibilities:

- **`mcp-tool-loader.ts` reports facts.** `collectCombinedTools` returns the tool map plus
  structured, content-free discovery diagnostics. `pickMcpDiscoveryLogMethod` is **deleted**. Every
  skip logs at `warn`; no reason string is sniffed.
- **`MastraAgentRuntime` carries the diagnostics forward**, alongside the existing
  `tokenDiagnostics` and `toolDiscovery` fields, which are already content-free metadata computed
  while building the tool map and consumed later.
- **The streaming layer decides presentation** and mints the run-event chunk, next to the existing
  `run.started` / `run.stalled` mint sites.

### 2. A durable, always-visible run event

`ASSISTANT_RUN_EVENT_KINDS` gains one kind: **`mcp.tools.unavailable`**, status **`'failed'`**.

- Not `'info'`: `info` is what the `worktree.*` breadcrumbs use for operations that *succeeded*. A
  configured capability failing to load is a failure.
- Never `'running'`, so it needs no `EXPLICIT_TERMINAL_KINDS` entry and cannot leave a row
  spinning. It is a standalone breadcrumb with no `.started` counterpart, so it also needs no
  `PAIRINGS` table entry in the pairing contract.

**It must also be added to `isAlwaysVisibleRunEvent`** in
`packages/assistant-ui/src/assistant-run-event-derivation.ts`. This is the load-bearing half of the
change. Run-event rows are hidden unless the user has background activity / Developer detail
enabled; only that allowlist survives at default detail. A new kind *without* the allowlist entry
would reproduce the original bug with extra steps.

The allowlist's own documented test is "does something else already card this?" Ordinary tool
failures are excluded because their `ToolFallback` card already reports them. A skipped MCP server
has no card — the tool never entered the map — and the `"Tool execution failed."` card the user does
see belongs to the model's doomed follow-up call and reports the wrong cause. The new kind carries
no `toolCallId`, so like `run.failed` and `run.cancelled` it needs no exemption from the
card-suppression rule.

### 3. One row per actual failure

| Failure | Row |
| --- | --- |
| Client-wide: `listToolsetsWithErrors()` rejected, or lost the timeout race | **One** row, `scope: 'client'`, metadata `serverNames: [...]` |
| Per-server: that server's `listTools` failed (`McpToolsetsWithErrors.errors`) | One row **per server**, `scope: 'server'`, metadata `serverName` |

Emitting one row per configured server for a client-wide timeout would invent N failures where one
race was lost. One lost race is one fact.

Metadata: `scope`, `serverName` / `serverNames`, `reason`, `timeoutMs`. The `reason` string is
truncated to 200 characters before it enters metadata — `AssistantRunEventMetadata` sanitization is
key-based, not value-based, and an HTTP transport error can carry a URL.

`AssistantRunTimeline` needs no change. It renders `label`/`detail`/`status` and derives only a
lifecycle colour from the kind prefix via `classifyRunEvent` in `tool-visual-classification.ts`,
which falls through to `'lifecycle'` for any kind that is not `memory.*` or `tool.*`. An `mcp.*`
kind takes that fallthrough.

### 4. Fresh turns only

On a resume leg Mastra emits no `start` part, but the runtime *is* rebuilt, so discovery re-runs.
Without a guard the rows would be re-emitted on every approval resume. Precedent exists for exactly
this hazard: `withoutDuplicateRunStarted` exists because a continuation attempt re-emits `start`.

The rows are emitted **only on a fresh turn**. A resume leg stays quiet: the row describes the
turn's tool surface, which the user has already seen.

## Testing

RED first, per the repo's TDD rule.

1. `collectCombinedTools` returns client-scope diagnostics on a discovery timeout, server-scope
   diagnostics on a per-server `listTools` error, and empty diagnostics when discovery is healthy.
2. **Both previously demoted reasons log at `warn`** — a reason containing `"Connection closed"`,
   and a `mcp_tool_discovery_timeout`. This is the direct regression guard on the deleted
   `pickMcpDiscoveryLogMethod`, and the test that pins the reported bug.
3. Streaming: a runtime carrying diagnostics yields the `mcp.tools.unavailable` chunk(s) on a fresh
   turn, with one row for a client-wide failure and one per server for per-server failures; a
   resume leg yields none.
4. `packages/assistant-contract` run-events test: the kind is declared.
5. `packages/assistant-ui`: `isAlwaysVisibleRunEvent` returns true for the kind, and the pairing
   contract stays green (no `.started` kind added, no terminal pairing required).

## Docs

- `docs/agents/assistant-providers.md` gains an "MCP discovery skip reporting" subsection, per the
  routing table entry that sends MCP-discovery changes there.
- `docs/agents/assistant-persistence.md` documents additive run-event kinds in per-kind sections
  (see "WORKTREE LIFECYCLE KINDS (BST-1390)"). It gains a matching short section for
  `mcp.tools.unavailable`, recording that it declares no terminal and that the contract entry is the
  first thing to add — a kind missing from `ASSISTANT_RUN_EVENT_KINDS` is rejected by
  `readAssistantRunEvent` and the row disappears.

## Follow-ups (not in this change)

- The 5s `DEFAULT_MCP_TIMEOUT_MS` ceiling, and the fact that no production caller supplies
  `mcpTimeoutMs`. Revisit once the run-event rows show how often the race is actually lost.
- Whether the model should be told about a reduced tool surface, so the assistant can explain
  itself rather than answering around a failed tool card.
