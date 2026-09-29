# MCP discovery skip reporting — evidence

Supports `docs/agents/assistant-providers.md` § "MCP discovery skip reporting". The deleted log-level heuristic, the two skip scopes, and why the rows are yielded inside the turn generator.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 4961-5033); append rather than
rewrite.

---

`collectCombinedTools` returns `{ mcpDiscoverySkips, tools }`. A skip is DATA;
the loader never decides how loudly it is reported. That coupling was the bug:
`pickMcpDiscoveryLogMethod` sniffed the failure reason and demoted exactly the
two likeliest failures — a message containing `"Connection closed"` and
`mcp_tool_discovery_timeout` — to `logger.debug`, so at `LOG_LEVEL=info` a run
that lost EVERY MCP tool left no record at all. The heuristic is deleted. Every
skip logs at `warn`, unconditionally, and the reason string is never inspected.

Two scopes, one row per ACTUAL failure:

- `scope: 'client'` — `listToolsetsWithErrors()` rejected or lost the timeout
  race, so every configured server contributed nothing. ONE skip, naming every
  server in `serverNames`. Fanning it out per server would report N failures
  where one race was lost.
- `scope: 'server'` — that one server's `listTools` failed (its entry in
  `McpToolsetsWithErrors.errors`). One skip per failing server.

`boundMcpDiscoveryReason` does TWO jobs before the reason becomes run-event
metadata, in this order. It REDACTS URL userinfo and query strings, then BOUNDS
the total length to `MAX_MCP_DISCOVERY_REASON_CHARS` (200, ellipsis included),
slicing by code point so a surrogate pair is never split. Truncation is not
redaction: `sanitizeAssistantRunEventMetadata` redacts by KEY, not by value, and
`fetch failed: 401 for https://host/mcp?api_key=…` is comfortably under the
bound. Before BST-1602 the reason reached at most a `debug` log line; it is now
persisted AND rendered in an always-visible row, so the redaction is what makes
that safe.

`McpDiscoverySkip` is a DISCRIMINATED UNION, not one shape with two optional
name fields: the optional form let a `scope: 'server'` skip with no `serverName`
type-check and render `"undefined skipped for this request"` into a durable row.

Per-server errors are filtered to the run's own `namedServers`. A row claiming a
server "was skipped for this request" must be true of THIS request, and
`listToolsetsWithErrors()` is client-wide.

The skips ride `MastraAgentRuntime.mcpDiscoverySkips` — REQUIRED, never
optional, so an empty array means "discovery was healthy" and stays
distinguishable from "nobody looked". `makeMcpDiscoverySkipChunks` mints one
`mcp.tools.unavailable` run event per skip, and `runTurnAttempts` yields them
from its REQUIRED `preludeChunks` parameter. Only the initial-turn seam
(`createStreamIteratorFromRuntime`) passes a non-empty value, so the rows are
fresh-turn only; the approval- and suspend-resume legs pass `[]` explicitly,
because a resume rebuilds the runtime and re-runs discovery and would otherwise
duplicate the rows on every approval.

**The rows must be yielded INSIDE `runTurnAttempts`, never by a wrapper around
it.** That generator's `finally` calls `runtime.dispose()`, and a generator's
`finally` only runs once its body has STARTED. A wrapper that yielded the rows
first could be cancelled before delegating — the "user hits stop immediately"
case, on a run that already had a degraded MCP surface — leaving the turn
generator unstarted while `firstAttempt` is already a live provider stream, so
the runtime, MCP client and abort listeners all leaked. Wrapper-side cleanup
cannot fix this: `.return()` on an unstarted generator does not run its body
either. Regression test: 'still disposes the runtime when the consumer stops ON
the skip row' in `mastra-streaming.spec.ts`.
The rows precede `run.started` because discovery genuinely happens first, during
runtime construction, and the thread-run row is created by
`repository.createThreadRun` rather than by `run.started`. The durable/timeline
half of the contract is in `docs/agents/assistant-persistence.md`.

Why the run still answers rather than throwing: one flaky MCP server would
otherwise break every chat turn, including turns that never needed that server.
The reduced tool surface is reported, not hidden — which is what the
no-silent-fallbacks rule requires ("throw OR surface visibly").

NOT changed by BST-1602, and still open: `DEFAULT_MCP_TIMEOUT_MS` is 5000, and
although `mcpTimeoutMs` is threaded end to end
(`MastraAgentRuntimeOptions` -> `composeRuntimeToolMap` ->
`collectCombinedTools.timeoutOverrideMs`), NO production caller supplies it —
the only two call sites are an e2e helper and a spec, both passing `undefined`.
So 5s is always the effective production ceiling, including on cold stdio server
startup. Revisit once the run-event rows show how often the race is actually
lost.
