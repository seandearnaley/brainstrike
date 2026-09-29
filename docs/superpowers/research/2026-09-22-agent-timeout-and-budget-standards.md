# Agent timeout and budget standards — long-horizon coding agents and subagents

Date: 2026-09-22
Status: Research (primary sources only); informs the subagent-lifetime redesign
Pinned sources: `mastra-ai/mastra@4a40fc7f` (core `1.69.0-alpha.2`; `1.68.0` on npm today),
`openai/codex@888e02db`, `vercel/ai@18c3d22e` (v7 docs) + `release-v6.0@da2e17bb`,
`openai/openai-agents-python@32edd3c3`, `openai/openai-agents-js@a0b1c6fd`,
`langchain-ai/langgraph@1211af45`, `anthropics/anthropic-sdk-typescript@1926adb4`.
Claude Code, Codex, Temporal, Anthropic, OpenRouter, and Node docs were read as of the date above.

**Question.** Brainstrike subagents die at a fixed 300000 ms wall-clock deadline
(`Task timed out after 300000ms`, raised by Mastra's background task manager) even while
they are still working. The owner wants subagents that can run for hours or days, the way a
modern coding agent does. What do the reference agent runtimes and durable-execution
systems actually ship, as defaults and as idioms, for four kinds of limit:
**(a)** wall-clock deadline, **(b)** inactivity/idle/heartbeat timeout, **(c)** step/turn/recursion
cap, **(d)** token/cost budget? Where do they agree, and where do they differ?

## Summary table

"Unbounded?" means the product documents or implements a way to express "no limit".
`retry` and `wait` mark knobs that are not one of (a)–(d) but matter to the design.

| Product | Knob | Kind | Default | User-configurable? | Unbounded? | Source |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | Subagent wall-clock deadline | a | None documented | — | — | [sub-agents](https://code.claude.com/docs/en/sub-agents), [env-vars](https://code.claude.com/docs/en/env-vars) |
| Claude Code | `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` | b | 600000; resets on each stream event | env | Not documented | [env-vars](https://code.claude.com/docs/en/env-vars), [SDK TS](https://code.claude.com/docs/en/agent-sdk/typescript#handle-slow-or-stalled-api-responses) |
| Claude Code | Subagent `maxTurns` frontmatter | c | Unset; on hit returns partial output, resumable | frontmatter | Yes (omit) | [sub-agents](https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields) |
| Claude Code | `--max-turns` / `CLAUDE_CODE_MAX_TURNS` | c | "No limit by default" (print mode) | flag/env | Yes | [cli-reference](https://code.claude.com/docs/en/cli-reference#cli-flags), [env-vars](https://code.claude.com/docs/en/env-vars) |
| Claude Code | `--max-budget-usd` | d | Unset; includes subagent spend | flag | Yes | [cli-reference](https://code.claude.com/docs/en/cli-reference#cli-flags) |
| Claude Code | `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | d (per request) | Model-dependent; 32000 for unknown IDs | env | No (clamped to model cap) | [env-vars](https://code.claude.com/docs/en/env-vars) |
| Claude Code | `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` | a (per command) | 120000 / 600000; on timeout the command **moves to background**, not killed | env | No | [tools-reference](https://code.claude.com/docs/en/tools-reference#background-commands) |
| Claude Code | `API_TIMEOUT_MS` | a (per request) | 600000; max 2147483647 | env | No | [env-vars](https://code.claude.com/docs/en/env-vars) |
| Claude Code | Stream watchdogs (`CLAUDE_STREAM_IDLE_TIMEOUT_MS`) | b | Event-level 300 s; byte-level 180 s (direct API) | env (min 300000) | Event watchdog can be disabled | [network-config](https://code.claude.com/docs/en/network-config#streaming-idle-watchdogs) |
| Claude Code | `MCP_TIMEOUT` | a (startup) | 30000 | env | No | [env-vars](https://code.claude.com/docs/en/env-vars) |
| Claude Code | `MCP_TOOL_TIMEOUT` | a (per tool call) | 100000000 (~28 h) | env / per-server `timeout` | Effectively | [env-vars](https://code.claude.com/docs/en/env-vars) |
| Claude Code | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` | b | 300000 network / 1800000 stdio; progress notifications reset it | env | Yes (`0`) | [env-vars](https://code.claude.com/docs/en/env-vars) |
| Claude Code | `CLAUDE_CODE_MAX_RETRIES` / `CLAUDE_CODE_RETRY_WATCHDOG` | retry | 10 (cap 15); watchdog: 300, 429/529 indefinite | env | Yes (watchdog) | [env-vars](https://code.claude.com/docs/en/env-vars) |
| Claude Agent SDK | `maxTurns` / `max_turns` | c | `undefined` / `None` | option | Yes | [SDK TS](https://code.claude.com/docs/en/agent-sdk/typescript), [SDK Py](https://code.claude.com/docs/en/agent-sdk/python) |
| Claude Agent SDK | `maxBudgetUsd` / `max_budget_usd` | d | `undefined` / `None` | option | Yes | [SDK TS](https://code.claude.com/docs/en/agent-sdk/typescript), [SDK Py](https://code.claude.com/docs/en/agent-sdk/python) |
| Codex CLI | `model_providers.<id>.stream_idle_timeout_ms` | b | 300000 | config | Not documented | [config-reference](https://developers.openai.com/codex/config-reference), [lib.rs#L63](https://github.com/openai/codex/blob/888e02db34bc6fe226e2131448413c051491f5b8/codex-rs/model-provider-info/src/lib.rs#L63-L65) |
| Codex CLI | `request_max_retries` / `stream_max_retries` | retry | 4 / 5 (max 100 each) | config | No | same as above |
| Codex CLI | `exec_command` one-shot `timeout_ms` | a (per command) | 10000; model sets per call | model | No | [exec.rs#L63](https://github.com/openai/codex/blob/888e02db34bc6fe226e2131448413c051491f5b8/codex-rs/core/src/exec.rs#L63) |
| Codex CLI | `exec_command` interactive (PTY) | — | **No completion deadline**; yields after 10 s (max 30 s) with a session id | model | Yes | [exec_command.rs#L313](https://github.com/openai/codex/blob/888e02db34bc6fe226e2131448413c051491f5b8/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L312-L320), [unified_exec/mod.rs#L77](https://github.com/openai/codex/blob/888e02db34bc6fe226e2131448413c051491f5b8/codex-rs/core/src/unified_exec/mod.rs#L73-L78) |
| Codex CLI | `background_terminal_max_timeout` | wait | 300000 (poll window, not process lifetime) | config | No | [config-reference](https://developers.openai.com/codex/config-reference) |
| Codex CLI | `mcp_servers.<id>.startup_timeout_sec` / `tool_timeout_sec` | a | 10 s / 60 s | config | Not documented | [config-reference](https://developers.openai.com/codex/config-reference) |
| Codex CLI | `wait_agent` `timeout_ms` (multi-agent v2) | wait | 30000 default, 10000 min, 3600000 max; child keeps running | model per call | No | [config/mod.rs#L255](https://github.com/openai/codex/blob/888e02db34bc6fe226e2131448413c051491f5b8/codex-rs/core/src/config/mod.rs#L255-L257), [wait.rs](https://github.com/openai/codex/blob/888e02db34bc6fe226e2131448413c051491f5b8/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs) |
| Codex CLI | Agent turn cap / subagent wall-clock | a, c | None in config reference | — | — | [config-reference](https://developers.openai.com/codex/config-reference) |
| OpenAI Agents SDK (Py, JS) | `max_turns` / `maxTurns` | c | **10** | option | Yes (`None` / `null`) | [run_config.py#L45](https://github.com/openai/openai-agents-python/blob/32edd3c3ecde37a7fb6bf4b082f35f1d8f7f086b/src/agents/run_config.py#L45), [constants.ts#L2](https://github.com/openai/openai-agents-js/blob/a0b1c6fd8e15703d3fb37c3de6f90f08400c6700/packages/agents-core/src/runner/constants.ts#L2) |
| OpenAI Agents SDK (Py) | Function tool `timeout_seconds` | a (per tool) | `None`; timeout returns a model-visible error | option | Yes | [tool.py#L514](https://github.com/openai/openai-agents-python/blob/32edd3c3ecde37a7fb6bf4b082f35f1d8f7f086b/src/agents/tool.py#L513-L525) |
| Mastra | `BackgroundTaskManagerConfig.defaultTimeoutMs` | a | **300000** | manager / agent / tool / LLM `_background.timeoutMs` | **No** | [types.ts#L181](https://github.com/mastra-ai/mastra/blob/4a40fc7ffd286649d4fcd0535e362897a906308f/packages/core/src/background-tasks/types.ts#L181-L182), [manager.ts#L97](https://github.com/mastra-ai/mastra/blob/4a40fc7ffd286649d4fcd0535e362897a906308f/packages/core/src/background-tasks/manager.ts#L97) |
| Mastra | Background `waitTimeoutMs` | wait | `undefined` = wait indefinitely | manager / agent / tool | Yes | [types.ts#L198](https://github.com/mastra-ai/mastra/blob/4a40fc7ffd286649d4fcd0535e362897a906308f/packages/core/src/background-tasks/types.ts#L198-L204) |
| Mastra | `modelSettings.timeout.{totalMs,stepMs,firstChunkMs}` | a / a / first-byte | Unset = no limit | call / per-model | Yes (omit); set values must be positive finite | [model-settings.ts](https://github.com/mastra-ai/mastra/blob/4a40fc7ffd286649d4fcd0535e362897a906308f/packages/core/src/llm/model/model-settings.ts#L4-L60) |
| Mastra | `maxSteps` / `stopWhen` | c | `stepCountIs(5)` when neither set | option | Via custom `stopWhen` | [model.loop.ts#L151](https://github.com/mastra-ai/mastra/blob/4a40fc7ffd286649d4fcd0535e362897a906308f/packages/core/src/llm/model/model.loop.ts#L151-L161) |
| Vercel AI SDK v6 | `timeout.{totalMs,stepMs,chunkMs}` | a / a / b | Unset | option | Yes | [settings v6](https://github.com/vercel/ai/blob/release-v6.0/content/docs/03-ai-sdk-core/25-settings.mdx#timeout) |
| Vercel AI SDK v7 | `timeout.{totalMs,stepMs,firstChunkMs,chunkMs,toolMs,tools}` | a / a / b / b / a | Unset | option | Yes | [settings](https://ai-sdk.dev/docs/ai-sdk-core/settings) |
| Vercel AI SDK | `generateText`/`streamText` `stopWhen` | c | `stepCountIs(1)` (v6) / `isStepCount(1)` (v7) | option | Via custom condition | [generate-text ref](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text), [generate-text.ts#L248](https://github.com/vercel/ai/blob/18c3d22ed0fd3d895d665069ef3bd9f185dbd3bd/packages/ai/src/generate-text/generate-text.ts#L248) |
| Vercel AI SDK | `ToolLoopAgent` `stopWhen` | c | 20 steps (v6 and v7) | option | v7: `isLoopFinished()` | [tool-loop-agent ref](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) |
| Temporal | Schedule-To-Close | a (whole activity, all retries) | ∞ | yes | Yes | [activity failures](https://docs.temporal.io/encyclopedia/detecting-activity-failures) |
| Temporal | Start-To-Close | a (per attempt) | Same as Schedule-To-Close; one of the two required | yes | — | same |
| Temporal | Heartbeat Timeout | b | Unset = `0s` = disabled; capped at Start-To-Close | yes | Yes | same |
| Temporal | Workflow Execution Timeout | a | ∞; setting it is generally not recommended | yes | Yes | [workflow failures](https://docs.temporal.io/encyclopedia/detecting-workflow-failures) |
| LangGraph (Py) | `recursion_limit` | c (super-steps) | **10007** in source; docs say 1000 | config / `LANGGRAPH_DEFAULT_RECURSION_LIMIT` | No (must be ≥ 1) | [_config.py#L32](https://github.com/langchain-ai/langgraph/blob/1211af45b18cab9c0a7efe366ba12f51ad2a9996/libs/langgraph/langgraph/_internal/_config.py#L32), [graph-api](https://docs.langchain.com/oss/python/langgraph/graph-api#recursion-limit) |
| Anthropic TS SDK | Client `timeout` | a (until response headers) | 600000 | option | — | [client.ts#L1659](https://github.com/anthropics/anthropic-sdk-typescript/blob/1926adb4d292090975e6b5d19ebafe2274d2469e/src/client.ts#L1659), [client.ts#L1358](https://github.com/anthropics/anthropic-sdk-typescript/blob/1926adb4d292090975e6b5d19ebafe2274d2469e/src/client.ts#L1358-L1368) |
| Anthropic API | SSE `ping` events | liveness | "any number" per stream; interval undocumented | — | — | [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming#ping-events) |
| OpenRouter | `: OPENROUTER PROCESSING` SSE comments | liveness | Sent "occasionally" | — | — | [streaming](https://openrouter.ai/docs/api-reference/streaming) |
| Node.js | `setTimeout` delay | — | Max 2147483647 ms (~24.8 d); larger → 1 ms | — | **No** (`Infinity` fires at 1 ms) | [timers](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args), [process warnings](https://nodejs.org/api/process.html#nodejs-warning-names) |

## Per-product notes

### 1. Claude Code (CLI)

- No subagent wall-clock deadline is documented on the sub-agents or env-vars pages. The only subagent
  timer documented is the **stall** timeout: it resets on each streaming progress event and, on a stall,
  aborts the subagent and reports it to the parent
  ([env-vars](https://code.claude.com/docs/en/env-vars)). For background subagents it also marks the
  task failed and attaches any partial result
  ([SDK TS](https://code.claude.com/docs/en/agent-sdk/typescript#handle-slow-or-stalled-api-responses)).
- Subagents are bounded by count and shape, not time: `maxTurns` returns output marked partial that
  Claude can resume ([sub-agents](https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields)).
  Concurrency defaults to 20 and nesting depth to 3. The per-session total cap (200) was **removed** in
  v2.1.224, and the doc says there is no limit on total subagents per session
  ([env-vars](https://code.claude.com/docs/en/env-vars), [sub-agents](https://code.claude.com/docs/en/sub-agents)).
- Wall-clock caps keep being removed. `CLAUDE_SUBAGENT_BG_SHELL_MAX_MS` (a 60-minute cap on a
  subagent's background shell) was removed in v2.1.260. A Bash command that hits its timeout is moved
  to the background rather than killed ([env-vars](https://code.claude.com/docs/en/env-vars),
  [tools-reference](https://code.claude.com/docs/en/tools-reference#background-commands)).
- MCP tool calls use the heartbeat pattern: a ~28 h outer bound plus an idle window that progress
  notifications reset (5 min network, 30 min stdio, `0` disables). Long MCP calls auto-background
  after 120000 ms (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`) ([env-vars](https://code.claude.com/docs/en/env-vars)).
- Network liveness uses three watchdogs: first-byte, event-level (300 s), and byte-level (180 s direct,
  and keep-alive pings count). `CLAUDE_STREAM_IDLE_TIMEOUT_MS` can't go below 300000
  ([network-config](https://code.claude.com/docs/en/network-config#streaming-idle-watchdogs)).
  `API_TIMEOUT_MS` is capped at 2147483647 because larger values "overflow the underlying timer"
  ([env-vars](https://code.claude.com/docs/en/env-vars)).

### 2. Claude Agent SDK

- `maxTurns` defaults to `undefined` (TS) and `max_turns` to `None` (Py), counted as "tool-use round trips".
  `maxBudgetUsd` / `max_budget_usd` are also unset by default. Hitting them ends the run with
  `error_max_turns` / `error_max_budget_usd`
  ([SDK TS](https://code.claude.com/docs/en/agent-sdk/typescript), [SDK Py](https://code.claude.com/docs/en/agent-sdk/python)).
- The SDK has no timeout options of its own. It passes env vars to the CLI subprocess: `API_TIMEOUT_MS`,
  `CLAUDE_CODE_MAX_RETRIES`, and `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` (defaults to the stream idle
  timeout plus 5 min) ([SDK TS](https://code.claude.com/docs/en/agent-sdk/typescript#handle-slow-or-stalled-api-responses)).
- The SDK says hosts should treat `ping` stream events as liveness rather than timing a session out on silence (same page).

### 3. OpenAI Codex CLI

- Model-stream liveness: `stream_idle_timeout_ms` = 300000, `request_max_retries` = 4, `stream_max_retries` = 5
  ([config-reference](https://developers.openai.com/codex/config-reference);
  [lib.rs](https://github.com/openai/codex/blob/888e02db34bc6fe226e2131448413c051491f5b8/codex-rs/model-provider-info/src/lib.rs#L63-L72)).
- Shell: one-shot `exec_command` defaults to a 10000 ms deadline set by the model. The default
  interactive PTY mode has **no** completion deadline. It returns output after `yield_time_ms` along
  with a session id, and the process keeps running
  ([exec_command.rs](https://github.com/openai/codex/blob/888e02db34bc6fe226e2131448413c051491f5b8/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L312-L320)).
- Subagents: `wait_agent` bounds only the **parent's wait**. The default is 30 s and the maximum 1 h.
  On timeout it returns "Wait timed out." and nothing cancels the child
  ([wait.rs#L147](https://github.com/openai/codex/blob/888e02db34bc6fe226e2131448413c051491f5b8/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs#L140-L205)).
  Defaults are 6 concurrent threads and V1 depth 1
  ([config/mod.rs#L253](https://github.com/openai/codex/blob/888e02db34bc6fe226e2131448413c051491f5b8/codex-rs/core/src/config/mod.rs#L253-L263)).
- `agents.job_max_runtime_seconds` is now a no-op kept for compatibility
  ([config_toml.rs#L725](https://github.com/openai/codex/blob/888e02db34bc6fe226e2131448413c051491f5b8/codex-rs/config/src/config_toml.rs#L725-L727)).
  It belonged to the CSV agent-jobs feature, which was removed in
  [#34413](https://github.com/openai/codex/commit/687f05cb94). It is not evidence of a policy change.
- MCP: `startup_timeout_sec` is 10 s and `tool_timeout_sec` is 60 s per tool call. The config reference documents no agent turn cap
  ([config-reference](https://developers.openai.com/codex/config-reference)).

### 4. OpenAI Agents SDK (Python + JS)

- `DEFAULT_MAX_TURNS = 10` in both SDKs. A turn is "one AI invocation (including any tool calls)".
  Python accepts `None` and JS accepts `null` to disable it
  ([run.py#L301](https://github.com/openai/openai-agents-python/blob/32edd3c3ecde37a7fb6bf4b082f35f1d8f7f086b/src/agents/run.py#L301-L303),
  [running-agents.mdx#L65](https://github.com/openai/openai-agents-js/blob/a0b1c6fd8e15703d3fb37c3de6f90f08400c6700/docs/src/content/docs/guides/running-agents.mdx#L65)).
- Hitting the cap raises `MaxTurnsExceeded` / `MaxTurnsExceededError`, unless an `error_handlers` /
  `errorHandlers.maxTurns` handler turns it into a final output
  ([Py guide](https://openai.github.io/openai-agents-python/running_agents/), [JS guide](https://openai.github.io/openai-agents-js/guides/running-agents/)).
- Python per-tool `timeout_seconds` is off by default. When set, its default behavior returns a
  model-visible error, so the run continues
  ([tool.py#L513](https://github.com/openai/openai-agents-python/blob/32edd3c3ecde37a7fb6bf4b082f35f1d8f7f086b/src/agents/tool.py#L513-L525)).

### 5. Mastra

- `defaultTimeoutMs` defaults to `300_000`. The resolution order is LLM `_background.timeoutMs`, then agent,
  then tool, then manager, then 300000
  ([resolve-config.ts#L78](https://github.com/mastra-ai/mastra/blob/4a40fc7ffd286649d4fcd0535e362897a906308f/packages/core/src/background-tasks/resolve-config.ts#L78-L90);
  [docs](https://mastra.ai/docs/harness/background-tasks)). The docs example for subagent dispatch uses 900000.
- The limit is a **pure wall-clock** timer. One `setTimeout(abort, task.timeoutMs)` is armed per execute attempt
  ([workflow.ts#L127](https://github.com/mastra-ai/mastra/blob/4a40fc7ffd286649d4fcd0535e362897a906308f/packages/core/src/background-tasks/workflow.ts#L127-L129))
  and cleared in `finally`
  ([#L243](https://github.com/mastra-ai/mastra/blob/4a40fc7ffd286649d4fcd0535e362897a906308f/packages/core/src/background-tasks/workflow.ts#L243)).
  Progress output (`onProgress`) does not reset it.
  A suspend is captured and applied after the executor returns
  ([#L131](https://github.com/mastra-ai/mastra/blob/4a40fc7ffd286649d4fcd0535e362897a906308f/packages/core/src/background-tasks/workflow.ts#L131-L140)).
  From source reading, the timer does not run during suspension, and a resumed attempt re-arms the full `timeoutMs`.
- No unbounded sentinel exists: `manager.ts` and `resolve-config.ts` contain no `0`, `null`, or `Infinity`
  handling or validation. Given Node semantics (§11), `0` or `Infinity` would abort after about 1 ms, not
  disable the timer. The CHANGELOG from 1.64.0 through 1.69.0-alpha.2 adds **no** inactivity, heartbeat, or
  "no timeout" option for background tasks. Timeout entries in that range cover `firstChunkMs` (1.66.0),
  `shutdown({ drainTimeout })` (1.67.0), and stricter validation of model timeouts (1.68.0)
  ([CHANGELOG](https://github.com/mastra-ai/mastra/blob/4a40fc7ffd286649d4fcd0535e362897a906308f/packages/core/CHANGELOG.md)).
  Brainstrike's installed `@mastra/core@1.64.0` (patched) has the same timer shape in `dist/workflow-*.js`.
- `waitTimeoutMs` is a separate knob. It sets how long the agent loop waits for a task, and when unset
  the loop waits indefinitely ([types.ts#L198](https://github.com/mastra-ai/mastra/blob/4a40fc7ffd286649d4fcd0535e362897a906308f/packages/core/src/background-tasks/types.ts#L198-L204)).
- `modelSettings.timeout` applies no limit unless set. Its fields are all wall-clock: `totalMs` is a hard
  deadline with no model fallback, `stepMs` covers one model call, and `firstChunkMs` covers time to first
  content. There is no inter-chunk idle knob, unlike AI SDK `chunkMs`
  ([model-settings.ts](https://github.com/mastra-ai/mastra/blob/4a40fc7ffd286649d4fcd0535e362897a906308f/packages/core/src/llm/model/model-settings.ts#L4-L60),
  [stream ref](https://mastra.ai/reference/streaming/agents/stream)). The step cap defaults to 5
  ([model.loop.ts#L160](https://github.com/mastra-ai/mastra/blob/4a40fc7ffd286649d4fcd0535e362897a906308f/packages/core/src/llm/model/model.loop.ts#L151-L161)).

### 6. Vercel AI SDK

- `timeout` is optional, with no default. It accepts a number or an object and composes with
  `abortSignal`; whichever fires first aborts. In v6 the object takes `totalMs`, `stepMs`, and `chunkMs`,
  where `chunkMs` means "no new chunk" for that long
  ([v6 settings](https://github.com/vercel/ai/blob/release-v6.0/content/docs/03-ai-sdk-core/25-settings.mdx#timeout)).
- v7 adds `firstChunkMs`, `toolMs`, and per-tool `tools` overrides. It also narrows `chunkMs` to
  content-bearing chunks, so metadata no longer resets it. A tool timeout returns a tool-error the model
  can react to ([settings](https://ai-sdk.dev/docs/ai-sdk-core/settings)).
- The step cap defaults to 1 for `generateText`/`streamText` and 20 for `ToolLoopAgent`. v7 renamed
  `stepCountIs` to `isStepCount` and added `isLoopFinished()` for unbounded loops, with a runaway warning
  ([tool-loop-agent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)).

### 7. Temporal (durable-execution reference)

- Schedule-To-Close and Schedule-To-Start default to ∞. Start-To-Close defaults to the Schedule-To-Close value, and
  one of the two is required. Temporal "strongly recommend[s]" Start-To-Close because the server cannot detect a
  crashed worker on its own ([activity failures](https://docs.temporal.io/encyclopedia/detecting-activity-failures)).
- For long-running activities the docs recommend a "relatively short Heartbeat Timeout and a frequent
  Heartbeat". A heartbeat can carry a progress payload that a retry resumes from. Cancellation is **delivered via heartbeats**, so an activity that
  never heartbeats can't be cancelled. An unset Heartbeat Timeout (`0s`) disables it (same page).
- The worker throttles heartbeats to the smaller of 0.8 × heartbeat timeout and 30 s, with a 60 s cap (same page).
- Workflow Execution Timeout defaults to ∞, and the docs "generally do not recommend setting" workflow timeouts
  ([workflow failures](https://docs.temporal.io/encyclopedia/detecting-workflow-failures)).

### 8. LangGraph

- `recursion_limit` caps **super-steps** per run and raises `GraphRecursionError`
  ([graph-api](https://docs.langchain.com/oss/python/langgraph/graph-api#recursion-limit)). Values below 1 are rejected.
- The source default is `10007`, overridable with `LANGGRAPH_DEFAULT_RECURSION_LIMIT`. It moved from 25 to 10000 in
  [#6676](https://github.com/langchain-ai/langgraph/commit/a5827c5c6193669d3063897e1845a45cfb90d732)
  (Jan 2026), whose message calls 25 "pretty unreasonable". A later commit changed it to 10007 to avoid a sentinel collision
  ([2fb367e9](https://github.com/langchain-ai/langgraph/commit/2fb367e90c9b49d37f2ae17a73a169270ea85ac8)).
  **The docs page says 1000 (since 1.0.6)**, which disagrees with the code.

### 9. Anthropic API / SDK

- The docs recommend streaming or Batches for long requests, "especially those over 10 minutes". Idle networks may drop connections,
  and the SDKs set TCP keep-alive ([errors#long-requests](https://platform.claude.com/docs/en/api/errors#long-requests)).
- The TS SDK sets `DEFAULT_TIMEOUT = 600000` and refuses non-streaming requests expected to exceed 10 minutes.
  The timer is armed around the underlying `fetch` only, so for a stream it bounds time-to-headers, not body duration
  ([client.ts#L1358](https://github.com/anthropics/anthropic-sdk-typescript/blob/1926adb4d292090975e6b5d19ebafe2274d2469e/src/client.ts#L1358-L1368),
  [#L1507](https://github.com/anthropics/anthropic-sdk-typescript/blob/1926adb4d292090975e6b5d19ebafe2274d2469e/src/client.ts#L1507-L1516)).
- SSE streams "may also include any number of `ping` events", and the docs specify no interval
  ([streaming#ping-events](https://platform.claude.com/docs/en/build-with-claude/streaming#ping-events)).

### 10. OpenRouter

- OpenRouter sends SSE comments `: OPENROUTER PROCESSING` "occasionally" to prevent connection timeouts. Clients must skip lines
  that start with `:` ([streaming](https://openrouter.ai/docs/api-reference/streaming)).
- Aborting the connection cancels a stream and, for supported providers, stops billing (same page). The error docs list
  408 and a 504 `timeout` code without numeric limits
  ([errors](https://openrouter.ai/docs/api_reference/errors-and-debugging)).

### 11. Node.js timers

- If `delay` is larger than `2147483647`, less than 1, or `NaN`, Node sets it to 1
  ([timers](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args)). An oversized value emits
  `TimeoutOverflowWarning` ([process](https://nodejs.org/api/process.html#nodejs-warning-names)).
  Verified locally on Node v24.16.0: `setTimeout(fn, Infinity)` warns and fires after 1 ms.
- So "unbounded" has to be modeled as the **absence** of a timer (`undefined`) or as a re-armed
  inactivity timer, never as `setTimeout(Infinity)`. Any wall-clock value above about 24.8 days needs chunked re-arming.

## Synthesis: the canonical pattern

Where the field converges:

1. **Agent loops have no wall-clock deadline by default.** Claude Code subagents, Agent SDK, OpenAI Agents
   SDK, AI SDK `timeout`, Mastra `modelSettings.timeout`, Temporal workflows, and Temporal Schedule-To-Close
   all default to no deadline. Temporal says outright not to set one on long-running workflows. Mastra's background
   `defaultTimeoutMs = 300000` is the **outlier**: a wall-clock default on work that includes whole subagent runs.
2. **Liveness comes from inactivity or heartbeat timers that reset on progress.** Examples: the Claude Code subagent
   stall timeout (10 min, reset per stream event), the MCP idle timeout (reset by progress notifications), stream
   watchdogs (reset by pings), the Codex `stream_idle_timeout_ms`, AI SDK `chunkMs`, and Temporal Heartbeat Timeout.
   Keep-alive pings and comments (Anthropic `ping`, `: OPENROUTER PROCESSING`) exist so these timers stay quiet
   during silent thinking.
3. **A parent's wait is not the child's lifetime.** Codex `wait_agent` times out the wait and leaves the child
   running. Mastra `waitTimeoutMs` works the same way (unset = forever). Claude Code moves timed-out Bash into the background
   and does not kill it. A timeout should demote work to the background, not destroy it.
4. **Per-tool and per-request timeouts are separate from the agent-loop lifetime.** Bash, MCP, HTTP, and exec have short
   bounded timeouts. AI SDK v7 and OpenAI Agents return a tool timeout to the model as an error. None of these kill the loop.
5. **Cancellation is explicit and user-driven.** Examples: `/tasks` stop, `TaskStop`, `interrupt()`, `abortSignal`, and
   Temporal cancellation via heartbeat. Budgets that end runs are opt-in: `--max-budget-usd`, `maxBudgetUsd`, and `maxTurns`.
6. **Hitting a turn cap produces a resumable partial, not a failure.** Claude Code marks the output partial and
   allows a resume. OpenAI Agents has `errorHandlers.maxTurns`.
7. **Recent releases remove caps.** LangGraph went from 25 to about 10k, and Claude Code removed its 200-subagent session cap and
   its 60-min subagent background-shell cap.

Where products **disagree**:

- **Step-cap defaults** range widely: 1 (AI SDK `generateText`), 5 (Mastra loop), 10 (OpenAI Agents),
  20 (AI SDK `ToolLoopAgent`), about 10k (LangGraph), and unbounded (Claude Code, Agent SDK).
- **Temporal still wants an outer bound per attempt.** It strongly recommends Start-To-Close, set longer than the maximum
  run time, because the server can't otherwise see a dead worker. With heartbeats that bound can be generous.
  Claude Code instead relies on in-process stall detection and sets no outer bound.
- **What counts as progress differs.** Claude Code resets the stall timer on stream events. AI SDK v7 `chunkMs` counts
  content chunks only. Byte-level watchdogs count pings. Mastra background tasks count nothing.
- **Disabling works differently.** It is `0` in Claude Code MCP idle and Temporal heartbeat, `None`/`null` in
  OpenAI Agents, omission in AI SDK and Mastra model settings, and impossible for Mastra background tasks.

## Unverified / could not confirm

- Whether `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` accepts `0` to disable (not stated in the docs).
- Whether Claude Code has any undocumented subagent or session wall-clock limit. None is documented; absence is inferred from docs, not source.
- Codex: any subagent **inactivity** watchdog, and whether `stream_idle_timeout_ms` accepts `0` to disable.
- Anthropic API: the `ping` interval, and any server-side maximum request or stream duration.
- OpenRouter: any numeric request or stream timeout, and the interval of the processing comments.
- LangGraph: why the docs (1000) and the source (10007) disagree. The commit message says 1000 while the code says 10000.
- Mastra: a runtime test of timer behavior across suspend/resume. It is inferred from the source comment at
  `workflow.ts#L131-L140` and from `finally` clearing the timer, not observed.
- Mastra `1.68.0` publish time (2026-09-22T10:58Z) is from the npm registry JSON; npmjs.com returned 403 to a direct fetch.
