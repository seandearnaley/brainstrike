# Hook events, insertion points and timeouts — evidence

Supports `docs/agents/assistant-runtime.md` § "TOOL-LIFECYCLE HOOKS (Claude-Code-style)".
Read before moving a hook insertion point, changing the hook envelope, or changing a timeout bound. BST-972, BST-1777.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 3864-3959), extracted verbatim.

User-authored shell commands that run at lifecycle events and (for blocking
events) can refuse to proceed. **Desktop-only by construction** — shell hooks
need Node `child_process` + absolute root paths + the assistant server; web
constructs NO hook runner (capability-gated, no `isElectron()` checks).

Seven events, three blocking (`PreToolUse`, `Stop`, `UserPromptSubmit`). A hook
is `{ type:'command', command, matcher?:{tool_name}, timeout?, description? }`.
It receives a JSON payload on **stdin** (secret-redacted), returns optional JSON
on **stdout** (`{decision, reason, additionalContext}`); its **exit code** is
authoritative: `2` = hard block on a blocking event, other non-zero =
warn-and-continue, `0` = ok. Per-hook timeout → **SIGKILL**.

**Insertion points (do not move):**
- `PreToolUse`/`PostToolUse` live in the tool-execute seam. `applyToolHooks`
  (`packages/agent/src/tools/hook-tool-wrap.ts`) is a SIBLING of `applyToolGuards`,
  composed OUTSIDE the guard, BEFORE the permission gate:
  `combinedTools → applyToolGuards → applyToolHooks → plan-mode → permission gate`
  (`runtime-assembly/tool-pipeline.ts`, called from `agent-runtime.ts`). Permission runs downstream of `execute`, so **hooks
  REFINE, never widen**: a PreToolUse hook can BLOCK a permitted tool but can
  never allow a denied/ask tool. A block returns a `HookBlockedToolError`
  (`error.code:'tool_blocked_by_hook'`, recognized by `isGuardedToolError`) so it
  renders as a FAILED tool event. PostToolUse `additionalContext` is capped
  (`HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET` 2000) and carried beside the original
  result in the explicitly discriminated internal hook envelope. The reserved
  JSON shape is NOT sufficient proof of provenance: every consumer also
  requires membership in a private in-memory WeakSet, registered only after a
  successful PostToolUse hook. A native/MCP result that copies the reserved
  field/kind or reflective object properties is ordinary visible domain
  evidence and can never inject model-only context or be stripped from
  UI/persistence. Losing the in-memory provenance through cloning or
  serialization likewise fails closed as visible data. Mastra's target-aware
  display/transcript transforms restore the exact domain result before the live
  UI and persistence boundary; the trusted envelope itself is never a public
  or durable tool result. Because JSON persistence and Mastra's
  transform protocol cannot represent an exact `undefined` result, a tool that
  returns `undefined` while PostToolUse requests context fails visibly instead
  of dropping the guidance or substituting a placeholder. The later
  model-projection seam consumes that reserved envelope: domain projectors
  receive the clean original result, and the provider view gets centrally
  composed context within the final model-output budget. A hook-runner FAULT is
  allow-on-fault (a runner bug must not brick tool calling).
- `UserPromptSubmit`/`Stop` run in `packages/assistant-service/src/stream-init.ts`
  (`initializeAgentStream`). A UserPromptSubmit block short-circuits the turn with
  a visible message + `run.failed` and NEVER invokes the model; additionalContext
  prepends a `system` message. The blocked branch returns an `ok:true` stream but
  carries `terminalStatus:'failed'` (+ `terminalError`) on `AgentStreamSuccess`, so
  ``runAssistantTurn` (packages/assistant-service/src/run-turn.ts, since BST-972 B3)` persists the `thread_runs` row as `failed` — never
  the default `completed`, which would contradict the visible `run.failed`.
  **Stop is NOTIFY-ONLY in v1** (surface the block reason as a `hook.notice`; NO
  auto-continue). Stop is ALSO the only phase that may report a **Task Ledger
  run verdict** (see the Run-verdict protocol below). The terminal Stop hook
  (`withStopHook`) MUST run BEFORE the
  `message-finish` chunk is yielded, not only in its `finally`: the live
  data-stream consumer stops pulling the source the instant the mapper emits
  `finish`, so a `hook.notice`/`hook.blocked` queued AFTER the finish reaches
  neither the live renderer nor persistence. Running Stop at the finish boundary
  lets the observer drain those queued run events (the mapper defers them past an
  open text part and flushes at the boundary); `finally` still fires Stop for
  streams that end without a finish chunk (bare return / throw / abort).
  SessionStart/SessionEnd/Notification are implemented but UNWIRED in v1.

**Timeout invariant (honest ceiling — no summed guarantee).** There is NO
enforced `pre + tool + post` sum ceiling. What IS enforced:
- **Per-hook:** `config.ts` rejects any hook whose `timeout >=
  resolveToolTimeoutMs()`; every hook is SIGKILLed at its own timeout (default
  10_000ms). Chain: `per-hook < BRAINSTRIKE_TOOL_TIMEOUT_MS (60_000)`. This rule
  is UNCHANGED by BST-1777 — `resolveToolTimeoutMs()` is still the flat fallback
  guard budget (see the config list above), and a per-tool declared
  `executionBudget` does not widen the per-hook ceiling.
- **Watchdog-covered in-stream phases** (`PreToolUse`/`PostToolUse`): since
  BST-1777 these run INSIDE the `tool-executing` phase, not against the 120s
  inter-output window — the watchdog's `tool-call` boundary starts that phase
  before `applyToolHooks` ever runs PreToolUse, and it does not settle until
  `tool-result`/`tool-error` after PostToolUse. They are therefore bounded by
  the per-hook SIGKILL + the derived `toolExecutingMs` backstop (default
  635000ms), not by an aggregate cap. These run WHILE an `iterator.next()` is
  pending, so the watchdog timer is armed and covers them.
- **Boundary phases the watchdog CANNOT reach** (`UserPromptSubmit` + `Stop`):
  both gate a user-visible boundary with the watchdog disarmed, so each carries
  its OWN aggregate bound (`resolveToolTimeoutMs()`, 60s), applied at runtime by
  `runHooksForEvent` (`aggregateTimeoutMs`, threaded via the manager's
  `aggregateTimeoutMs` ctx): the in-flight hook is SIGKILLed at the remaining
  budget and the rest are skipped with a loud warning (timeout ==
  warn-and-continue; hooks proceed, never silently stall turn start / finish
  delivery).
  - `UserPromptSubmit` runs BEFORE the model is invoked; it ALSO enforces the
    bound on the config-load end: `loadHooksConfig` disables the phase fail-LOUD
    (a `HookConfigError`) when the combined declared timeout reaches the ceiling.
    Over-budget config never silently truncates.
  - `Stop` runs in FRONT of the `message-finish` yield (the watchdog is applied
    UPSTREAM of the `withStopHook` seam and its timer is disarmed while Stop
    awaits), so an unbounded chain of Stop hooks would delay finish delivery, the
    Stop notices, HTTP stream close, and the `thread_runs` status write. The
    runtime aggregate cap is its only bound — the watchdog does NOT cover it.
    (v1 has no config-load check for the Stop combined timeout; the runtime cap
    is authoritative.)
