# MCP Tasks tool path — evidence

Supports `docs/agents/assistant-runtime.md` § "TOOL-PATH WIRING (BST-1566)".
Read before changing `mcp-task-tool-result.ts`, the task-tracking capability port, settlement timeouts, or the task model projection.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 1059-1125), extracted verbatim.

### TOOL-PATH WIRING (BST-1566)

The agent runtime's MCP tool path is production-wired for a created task
(`packages/agent/src/mastra/mcp-task-tool-result.ts`, consumed by
`executeMcpTool` in `mcp-runtime-client.ts`):

- **Capability, not environment.** `MastraAgentRuntimeOptions.mcpTaskTracking?:
  McpTaskTrackingCapability` (the port in `packages/agent/src/mcp/task-tracking.ts`)
  is threaded exactly like `toolOutputArtifactStore`: runtime option →
  `composeRuntimeToolMap` → `createMcpRuntimeClient({ mcpTaskTracking,
  toolTimeoutMs })`, and it survives `toAiSdkStyleStream`'s `optionsOverride`
  Pick. Only a trusted host composes it; web and host-less runs leave it absent
  and every MCP call stays synchronous.
- **Detection covers both wire shapes.** A `tools/call` answer is a created task
  when it is the bare `resultType: 'task'` result OR the client extension
  registry's neutral envelope `{ [REGISTERED_EXTENSION_RESULT_KEY]: task,
  content: [], resultType: 'complete' }` (`readRegisteredExtensionResult` is the
  inverse of `rewriteIncomingMessage`; never re-implement the unwrap). Both are
  parsed with `parseMcpCreateTaskResult` — a malformed task throws, it is never
  coerced into an ordinary result. Detection runs before the raw-result
  retention and `isError` branches: a task has no content to retain.
- **NO SILENT FALLBACK.** A task result on a runtime without `mcpTaskTracking`
  throws `MCP tool "<server>.<tool>" returned a task but this host has no task
  tracking capability`. The task is never dropped, never returned as raw state.
- **Identity.** `track()` receives `configuredServerId = server.name`, which IS
  the host authority snapshot's `configuredServerId` (mapped verbatim in
  `createMcpRuntimeClient`) and therefore matches `McpTaskHandle.serverId` on
  the desktop host; `toolName` is the unprefixed MCP tool name.
- **App-originated calls return the wire task.** When the Apps admission
  executor marked the call for raw retention (`shouldRetainRawMcpCallToolResult`),
  the tool still hands the task to `track()` so the host owns it, then returns
  the canonical `CreateTaskResult` unchanged WITHOUT awaiting settlement: the
  MCP App client expects that result and its frame bridge aborts inbound
  requests after 10 s, far under the settlement wait. This branch runs before
  the ordinary settlement branch; a tracking-less host still throws.
- **Bounded settlement.** After `track()` the tool awaits
  `awaitSettlement(handle, { timeoutMs, signal })` with
  `timeoutMs = min(45_000, floor(0.75 × toolTimeoutMs))`
  (`MCP_TASK_SETTLEMENT_WAIT_MS`, `resolveMcpTaskSettlementTimeoutMs`). The
  guard's ceiling (`BRAINSTRIKE_TOOL_TIMEOUT_MS`, default 60s) is not observable
  from inside `execute`, so the wait is capped under the ceiling that
  `applyToolGuards` enforces; the remaining quarter covers the `tools/call`
  round trip and `track()` so the guard can never report a timed-out tool for a
  task that is tracked and healthy. A ceiling too small to hold any wait throws
  at runtime construction. Timeout is not an error: the capability resolves
  `{ settled: false, reason: 'timeout', task }` and the tool returns the live
  presentation the status card keeps updating.
- **Persisted marker vs model projection.** The tool's RAW domain result (what
  persists on the tool invocation, and what the live display/transcript
  transforms pass through unchanged) is
  `createMcpTaskToolInvocationResult(presentation)` from
  `@brainstrike/assistant-contract` (`{ kind: 'mcp-task', task }`). The
  MODEL-visible output goes through the existing `toModelOutput` seam:
  tracking-capable runtimes give every MCP tool `projectMcpTaskToolModelOutput`,
  which returns `{ type: 'json', value: projectMcpTaskForContext(task) }` for the
  marker and `undefined` for every other result (the pipeline then applies its
  generic projection, so non-task MCP results are unchanged). The projection
  never carries the control handle or raw task state and is bounded by
  `MCP_TASK_CONTEXT_MAX_BYTES` (2,048), tightened to the run's
  `domainModelResultCharBudget` via `getActiveToolResultBudget()` so the
  smallest scaled budget cannot trip the domain-projection RangeError.

Tests: `packages/agent/src/__tests__/mcp-task-tool-result.spec.ts` (detection
both shapes, malformed rejection, timeout resolution, absent-capability throw,
settled/timeout flows, projection bound at the smallest budget) and the "MCP
task results" block in `mcp-runtime-client.spec.ts` (end-to-end through the
runtime tool, `track` identity, persisted marker, model projection).
