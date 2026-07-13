# Assistant Subagents (Persona Delegation)

> Extracted from AGENTS.md (2026-07-12). Read before changing persona delegation. Keep updated with the code.

## SUBAGENTS (PERSONA DELEGATION)

The supervisor assistant can delegate to built-in, read-only child personas
using **Mastra's native supervisor pattern**: child `Agent`s passed via the
parent's `agents: {...}` config become `agent-<key>` delegation tools
automatically. We do NOT build a bespoke `subagent` tool — we ride Mastra's
delegation machinery (hooks, memory isolation, nested-chunk forwarding,
`subAgentToolResults`) and layer brainstrike's rules on top.

- **Personas as data:** `packages/assistant-contract/src/personas.ts`
  (`BUILT_IN_PERSONAS` = `explore`, `analyze`) plus USER-DEFINED personas (v2,
  below). A persona names an explicit list of ORIGINAL read-only native tool
  ids; `assertReadOnlyPersona` throws at module init if any resolves to a
  non-`read` risk (unknown id ≠ read — no silent fallback). `id` is `string`
  (`AssistantBuiltInPersonaId` narrows the built-ins); optional `source:
  'built-in' | 'user'` (absent = built-in).
- **User-defined personas (v2):** markdown files with frontmatter
  (`description` required; optional `name`, `tools`, `model:
  provider::modelId`, `maxSteps` ≤ 16; body = child instructions), scanned
  FLAT (no recursion — the id becomes the `agent-<id>` tool name, and provider
  tool-name charsets forbid `:` namespacing) from (1) `<root>/.brainstrike/agents/`
  per mounted root, (2) `~/.brainstrike/agents/`, first-id-wins with warn-once;
  a built-in id collision is an INVALID file, not an override. Parse/validate:
  `packages/assistant-contract/src/user-personas.ts` (`buildUserPersona` —
  fail-closed; omitted `tools` = `DEFAULT_USER_PERSONA_TOOL_IDS`, the curated
  read-only exploration set WITHOUT webSearch/askUser/submitPlan/manageTaskList;
  the suspending/interactive trio is ALSO rejected when explicitly allowlisted —
  child maps bypass the parent's suspend-storage fail-safe, so a no-storage run
  could otherwise expose an unresumable child suspend tool; bare tool names get
  the `brainstrike.` prefix; out-of-range `maxSteps` is an ERROR, never a
  clamp; ids are capped at 58 chars so `agent-<id>` fits the 64-char provider
  tool-name limit). Scan: `apps/desktop/src/assistant-server/user-personas-loader.ts`
  (bounded: 64K chars/file, `MAX_USER_PERSONAS` 50; INVALID files become
  visible `entries` with their error, consumed by Settings → Subagents via the
  `assistantPersonas:list` IPC / `window.assistantPersonas` bridge —
  capability-gated, absent on web). The read-only invariant applies to user
  personas EXACTLY as to built-ins.
- **Per-request resolution:** `apps/desktop/src/assistant-server/request-personas.ts`
  (`resolveRequestPersonas`) merges built-ins + scanned user personas, applies
  the renderer's `subagentPersonasRequest` availability preference
  (presence-means-non-default wire field from the `subagent-personas.v1`
  preferences store — master `delegationEnabled` + per-persona disables; it can
  only REDUCE the persona set), and resolves API keys for cross-provider model
  pins via the secrets bridge onto `runtime.personaProviderApiKeys`
  (server-set; a client-supplied value is STRIPPED, same posture as
  `permissionPolicy`). A scan failure degrades to built-ins with a warn — a
  broken agents dir must not take down chat. Settings UI:
  `packages/preferences/src/settings/system/subagent-personas-settings-section.tsx`;
  the store is factory-reset-registered in `factory-reset-helpers.ts`.
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
  GUARDED tool map (so per-tool timeout + `GuardedToolError` inherit for free).
  Permission composition (D3): the candidate map passes through the SAME
  `filterToolsByPermissionWithMetadata` gate as the parent, then EVERY `'ask'`
  tool is OMITTED (fail-safe — no nested approval UX in v1). An empty post-gate
  map ⇒ the persona is NOT registered. Children have **no `agents`** (no nesting)
  and **no `memory`** (Mastra injects the parent's memory and scopes writes to a
  fresh delegation thread). The child `Agent` id EQUALS the persona id — Mastra
  sets `DelegationStartContext.primitiveId = agent.id`, and the caps resolve the
  persona by that id.
- **Safety rails:** `packages/agent/src/mastra/subagent-delegation.ts`
  (`createDelegationConfig`): per-run `DelegationConfig` closure —
  `MAX_CONCURRENT_DELEGATIONS = 2`, `MAX_DELEGATIONS_PER_RUN = 8`, persona
  `maxSteps` clamp (a model-supplied `maxSteps` can never exceed the cap),
  unknown-persona rejection, and `onDelegationComplete` logs child usage (the
  parent meter does NOT aggregate child tokens in v1). Passed per-call on
  `streamOptions.delegation` in ALL THREE stream iterators — initial-turn,
  approval-resume, AND suspend-resume (`createToolResumeIteratorFromRuntime`),
  so an askUser pause→answer that then delegates keeps the caps. The closure is
  rebuilt per leg, so the per-run cap is effectively per-leg (v1 tradeoff).
  An in-flight delegation whose parent run is ABORTED mid-stream gets a terminal
  `subagent.failed` (status `cancelled`) event via
  `createDelegationLifecycleTracker` (drained on the generator's abort paths),
  so a cancelled parent never leaves an orphaned `subagent.started`.
- **Stream → run events (D9):** `processMastraStreamPart` (agent-runtime.ts)
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
- **Budget guard:** `subAgentToolResults` is a `TRIMMABLE_COLLECTION_KEYS` entry
  (tool-output-limits.ts) so an oversized delegation result trims structurally
  (truncated + hint) instead of a hard size error.
- **Desktop wiring:** `apps/desktop/src/assistant-server.ts` sets
  `runtime.personas = BUILT_IN_PERSONAS` unconditionally on the shared runtime
  (covers initial + both resume paths). Personas are skipped agent-side for
  `provider === 'local'` (D10 — the 2B on-device model's prompt budget) and in
  plan mode (delegation is out of scope for planning). Web is unaffected: the
  in-renderer `LocalRuntimeChat` never reaches `streamMastraAgent`.
- **Delegation-thread residue (accepted for v1):** children write to fresh
  Mastra threads under `<resourceId>-<personaId>` resource ids — invisible to the
  user's thread list (queried by the user's own resourceId). Cleanup of orphaned
  delegation threads is a follow-up (factory reset already purges the DB).
- **Live-loop proof:** `packages/agent/src/__tests__/mastra-subagent-execution.integration.spec.ts`
  (real supervisor Agent + real child Agent + real child tool `execute`; one
  scripted model serves both levels, discriminated by `options.tools`) —
  delegation runs, child tool executes, `subagent.*` events fire in order sharing
  `parentToolCallId`, no-personas + plan-mode + local-provider skips pinned.
  Unit: `build-persona-subagents.spec.ts`, `subagent-delegation.spec.ts`,
  `persona-pinned-model.spec.ts`, contract `user-personas.test.ts`, desktop
  `user-personas-loader.test.ts` + `request-personas.test.ts` +
  `ipc-user-personas-handlers.test.ts`, preferences
  `subagent-personas-store.test.ts` + `subagent-personas-settings-section.test.tsx`,
  ui `subagent-tool-cards.test.tsx`.

The SubagentCard renders per-child-tool rows from BOTH the tool part's persisted
`subAgentToolResults` (authoritative on reload + at completion) AND, while the
delegation is still running, LIVE `subagent.tool.*` run events from the current
message (keyed by `parentToolCallId`); persisted rows supersede live rows by
child `toolCallId`, so a running delegation shows its in-progress tool count
instead of "Running · 0 tool calls".

The SubagentCard routes by tool-name PREFIX for user personas:
assistant-ui's `by_name` map is exact-match, so only built-ins pre-register;
`ToolFallbackWithSubagents` (todo-progress.tsx) forwards any `agent-*` part to
the card, and `personaLabelForToolName` falls back to the persona id for
non-built-in delegation tools (never blank, never a raw tool card).

Shipped in v2: user-defined personas, persona model pinning, and the
preferences availability toggle (all above). Follow-ups (out of scope):
nested approval UX + a `subagent` policy row (D13), child input-budgeting
(`messageFilter`), per-persona label/description IPC enrichment of the
SubagentCard, and hot-reload of persona files mid-session (personas re-scan
per request, so edits apply on the next turn).

When changing this flow, update this section and the paired tests.

---


