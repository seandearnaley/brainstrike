# Child factory, safety rails and stream→run events — evidence

Supports `docs/agents/assistant-subagents.md` § "SUBAGENTS (PERSONA DELEGATION)".

Read before changing `build-persona-subagents.ts`, `createDelegationConfig`, the `subagent.*` mapper, or the parent watchdog envelope reader.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 383–489 at commit 7c3eb8f38.

---

- **Model pinning (v2):** a persona with `model: provider::modelId` builds its
  child on THAT model via `resolvePinnedModel`
  (`packages/agent/src/mastra/persona-pinned-model.ts`): same-provider pins
  reuse the parent key; cross-provider pins use `personaProviderApiKeys`;
  keyless local-server providers (`ollama`/`lmstudio`) need no key; a `local`
  pin REQUIRES `runtime.localLlmHostClient` (renderer-only inference is
  mandatory — a missing host client must never fall through to in-process
  inference in Electron main); anything else THROWS and the factory SKIPS that
  persona with `subagent_persona_pin_unresolvable` — never a silent
  parent-model fallback. `PERSONA_PIN_KEYLESS_PROVIDERS` is the single shared
  keyless set (agent package export, reused by the desktop key-resolution loop).
- **Child factory:** `packages/agent/src/mastra/build-persona-subagents.ts`.
  Each child's tool map is a permission-gated SUBSET of the parent's ALREADY-
  GUARDED and lifecycle-hooked tool map (timeouts, structured errors and
  PreToolUse/PostToolUse inherit exactly once). Workers are omitted visibly
  unless storage and every durable child-control method exist.
  Permission composition (D3): the candidate map passes through the SAME
  `filterToolsByPermissionWithMetadata` gate as the parent. Read-risk ask tools
  retain native per-tool approval only when storage and the complete durable
  child-control binding are available; otherwise they are omitted. An empty post-gate
  map ⇒ the persona is NOT registered. With the durable host budget capability,
  WORKER children lazily assemble native `agents` from their own narrowed tool
  map, through three descendant levels; read-only children are leaves and never
  receive `agent-*` tools (see the settled ruling above). The shared Mastra
  memory is explicit so grandchildren retain native persistence; native
  delegation still selects a
  fresh child thread. Without durable budgets, recursion is not advertised. The child `Agent` id EQUALS the persona id — Mastra
  sets `DelegationStartContext.primitiveId = agent.id`, and the caps resolve the
  persona by that id. Because the selected tools are the SAME parent-owned
  objects, the outer model-projection wrapper installs the child's resolved
  budget only for the synchronous custom-projector call and restores the prior
  value in `finally`; desktop producers therefore narrow or widen per pinned
  child instead of retaining their construction-time parent budget.
- **Safety rails:** `packages/agent/src/mastra/subagent-delegation.ts`
  (`createDelegationConfig`): per-run `DelegationConfig` closure —
  `MAX_CONCURRENT_DELEGATIONS = 2`, `MAX_DELEGATIONS_PER_RUN = 8`, persona
  `maxSteps` clamp (a model-supplied `maxSteps` can never exceed the cap),
  unknown-persona rejection, and `onDelegationComplete` logs child usage AND
  reports it through `onChildUsage` (BST-953): each leg's
  `DelegationUsageCapture` queue (agent-streaming.ts) drains it into a
  `child-run-usage` StreamChunk that the desktop server persists as a durable
  `run_kind='subagent'` usage row under the PARENT runId (model/provider =
  persona pin ?? parent). The parent FINISH counters still exclude child
  tokens — attribution rides the durable row, and the thread-total meter sums
  by source (see assistant-persistence.md). Passed per-call on
  `streamOptions.delegation` in ALL THREE stream iterators — initial-turn,
  approval-resume, AND suspend-resume (`createToolResumeIteratorFromRuntime`),
  so an askUser pause→answer that then delegates keeps the caps. The closure is
  rebuilt per leg as a backstop; durable host budgets enforce original-turn
  counters across all resume legs. With the budget capability, the shared
  model/tool queue replaces the in-flight delegation cap so waiting ancestors
  cannot starve descendants.
  An in-flight delegation whose parent run is ABORTED mid-stream gets a terminal
  `subagent.failed` (status `cancelled`) event via
  `createDelegationLifecycleTracker` (drained on the generator's abort paths),
  so a cancelled parent never leaves an orphaned `subagent.started`.
  APPROVAL-RESUME legs synthesize a `start` tool-event for EVERY pending call
  of the suspended step — not only the approved one — and `agent-*` siblings
  additionally get their `subagent.started` (registered with the tracker so
  aborts still drain them). Mastra resume legs never replay the step's
  `tool-call` parts, and Mastra emits a step's `tool-result` chunks as one
  batch after the slowest call settles (verified in the 1.59 dist): without the
  sibling starts, a delegation sharing a step with an approved tool ran for
  minutes with no card while the UI pinned the wait on the stale approved-tool
  card (2026-08-24).
- **Stream → run events (D9):** `processMastraStreamPart` (agent-streaming.ts)
  threads `runtime.delegationToolPersonas` (`agent-<key>` → personaId). A parent
  `tool-call`/`tool-result`/`tool-error` for a delegation tool ALSO emits
  `subagent.started`/`.finished`/`.failed` (the generic `tool.*` timeline stays
  intact). A delegation `tool-output` (nested child chunk, §Mastra ToolStream) is
  BYPASSED from the generic path and mapped to `subagent.tool.started`/
  `.completed`/`.failed` — otherwise each nested chunk would flood the UI with a
  bogus successful tool event + `toolCallResult` frame. Six run-event kinds
  (`subagent.*`) live in `run-events.ts`; the read-path `requireRunEventKind`
  throws on unknown kinds, so the contract enum MUST ship before any emitter.
  Metadata carries ids/labels ONLY (`parentToolCallId`, `personaId`,
  `toolCallId`, `toolName`) — never args/results (the sanitizer strips those).
- **The parent's stream watchdog reads THROUGH the envelope (BST-1777 PR
  review).** A foreground child has no watchdog of its own, and the parent's
  `agent-<personaId>` delegation call is deliberately unguarded, so a child's
  guarded tool execution is only visible to `withInactivityTimeout` inside the
  `tool-output` envelope (`payload.output`, the child's own Mastra part).
  `createMastraToolExecutionPartKindReader` (agent-streaming.ts) therefore
  unwraps a `tool-output` whose `toolName` starts with
  `SUBAGENT_DELEGATION_TOOL_PREFIX` and is not itself `providerExecuted` —
  POSITIVE identification, not "not in the guarded set" (round 2, CodeRabbit
  MAJOR): the latter also matches provider-executed tool outputs and
  Mastra-injected memory-tool outputs, whose `output` could then be misread as
  a nested guarded `tool-call`. `executeCommand`/`runSkillScript` emit their
  own `tool-output` parts, never delegation-prefixed, so their `output`
  (arbitrary tool data) is never unwrapped — and the nested part is classified
  under the SAME allow-list, recursing for a grandchild (bounded). Children
  select their tools from the parent's already-guarded map by sanitized id
  (`build-persona-subagents.ts`), so a child tool name is a key of the same
  `toolNameMap`. Without this, a silent child command longer than the parent's
  `streamInactivityMs` stalled the PARENT turn. Paired tests:
  `mastra-tool-execution-part-kind.spec.ts` (delegated-child cases) and
  `mastra-tool-executing-phase.integration.spec.ts` ("a DELEGATED child's
  silent tool outlives the parent's inactivity window"). BACKGROUND delegation
  is out of scope — its child does not stream on the parent's leg.

  Subagent tool calls ALSO feed the SAME per-tool token telemetry table as
  primary tool calls, attributed to the parent run (BST-1196), via a
  telemetry-only `RunTokenDiagnostics.recordSubagentToolOutput` sink that
  deliberately does NOT feed the parent-run prompt-reconciliation aggregate
  `recordModelOutput` also updates; see assistant-persistence.md, `## TOOL-
  CALL TOKEN TELEMETRY`. This closes the BST-1190 follow-up gap.
