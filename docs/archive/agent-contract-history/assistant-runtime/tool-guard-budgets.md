# Per-call tool guard budgets and cancellation — evidence

Supports `docs/agents/assistant-runtime.md` § "ASSISTANT RESILIENCE (CRITICAL)".
Read before changing `resolveToolGuardBudget`, `TOOL_GUARD_MARGIN_MS`, the guard deadline seam, or a native tool's declared `executionBudget`. BST-1777 (per-call budgets) and BST-1594 (the guard cancels what it gave up on).

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 124-191), extracted verbatim.

   `defineNativeTool()` definition (`packages/assistant-contract/src/native-tools/define.ts`,
   validated at definition time: both positive integers, `defaultMs <= maxMs`).
   `packages/agent/src/tools/resolve-tool-guard-budget.ts`
   (`resolveToolGuardBudget`, the SINGLE place this arithmetic lives) resolves
   one call's `{ grantedMs, guardMs }` pair — `grantedMs` is
   `min(input.timeoutMs ?? budget.defaultMs, budget.maxMs)` and `guardMs` adds
   `TOOL_GUARD_MARGIN_MS`
   (5000ms) — the margin is sized for the slowest self-teardown
   (`executeCommand`'s SIGTERM→SIGKILL grace plus pipe close) and exists so the
   TOOL's own deadline wins the race: a tool that enforces `timeoutMs` itself
   (see below) answers with a richer result — `timedOut: true` plus the
   captured output tail — than the guard's generic `tool_timeout` ever can, and
   letting the guard fire first would throw that result away. A tool that
   declares no budget keeps the flat `BRAINSTRIKE_TOOL_TIMEOUT_MS` default (see
   the config list below). Only LOCAL tools can be granted a declared budget —
   `tool-pipeline.ts`'s `budgetFor` matches on the SANITIZED local tool id, not
   on name equality, because an MCP server chooses its own tool names and a
   third-party tool that happened to be named like a native one must not
   inherit its 600s budget. Every MCP tool therefore keeps the flat default
   until BST-1779 extends declared budgets to MCP. The model-facing timeout
   message (`formatToolTimeoutMessage`) states the GRANTED budget — never the
   guard window, so the margin stays invisible and `executeCommand`'s
   documented 120000ms default reads as "its 120s execution budget" rather
   than 125s — and offers the larger-timeout remedy ONLY when `grantedMs <
   declaredMaxMs` (`Pass a larger timeoutMs (up to <maxMs> ms)…`). A call
   already at the declared max is told so instead ("That is the largest budget
   this tool allows, so split the work into smaller steps"), because advising
   a `timeoutMs` the tool cannot grant is advice the model acts on. An
   undeclared tool keeps the no-remedy text with its real budget. Units: seconds
   in prose, and the one parameter VALUE is labelled `ms` explicitly.

   **`resolveGuardedToolSignal` is mandatory for any tool that owns a process
   or a network request (`packages/agent/src/tools/tool-guard-deadline.ts`).**
   The guard resolving `tool_timeout` only stops the WAIT — it does not stop
   the work — so any tool that can keep running after the guard gives up must
   fold the guard's deadline signal into its own via `resolveGuardedToolSignal`
   (execution signal and guard deadline combined with `AbortSignal.any`,
   returned BY IDENTITY when there is no deadline, since
   `retainRawMcpCallToolResult` keys on that identity). Before BST-1777 only the
   MCP runtime client read this deadline; a native command kept running after
   the model was told it failed, and the model's retry then raced the orphan.
   `apps/desktop/src/assistant-server/native-tool-executors-execution.ts` and
   `packages/agent/src/tools/run-python-tool.ts` now observe it too.
   `manageCommandSession` (long-lived interactive command sessions) DELIBERATELY
   does not — a session spans many guarded calls and must outlive any one of
   them.
   **The guard also CANCELS the work it gave up on (BST-1594).** Winning the
   race only stops the wait, so the guard publishes a deadline `AbortSignal`
   through `packages/agent/src/tools/tool-guard-deadline.ts` and aborts it
   BEFORE resolving the `tool_timeout`. The seam is keyed by TOOL-CALL ID via
   the single `readToolCallId` reader, not by execution-context identity:
   Mastra reconstructs the context object between the guarded `execute` and the
   tool's own callback (verified at @mastra/core 1.55), so a context-identity
   WeakMap would silently read empty. Registration returns a release the guard
   runs in its `finally`. The MCP runtime client folds the deadline into its
   `tools/call` signal (never replacing `context.abortSignal`, whose identity
   carries the `retainRawMcpCallToolResult` marker), so the SDK sends
   `notifications/cancelled` instead of leaving a progress-deferred request
   dangling. A call with no tool-call id publishes nothing and keeps the
   pre-guard behaviour — the caller's signal and the SDK request bounds still
   apply. The id is PROVIDER data, so two live executions can collide on it; the
   later registration wins and the collision is LOGGED (`error`, not thrown —
   a provider-chosen id must not take a working tool call down) so a
   mis-routed cancellation is diagnosable rather than invisible. Verifier over a
   real spawned stdio child:
   `packages/agent/src/__tests__/mcp-tool-guard-cancellation.integration.spec.ts`
   with `packages/agent/test-fixtures/mcp-stdio-progress-cancellation-server.mjs`.

