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

  **Scan invariants (BST-936) — do not regress these.** The full rules and
  rationale, shared with the lens loader, are in
  `docs/agents/workspace-context.md` § `.brainstrike/` SCAN CONVENTIONS;
  persona-specific facts:
  - The id is RESERVED before the file is read, through
    `resolveUserPersonaId` (filename derivation **+** the built-in-collision
    check — the SAME gate `buildUserPersona` uses). Reserving pre-parse is
    what stops a BROKEN `<root>/.brainstrike/agents/x.md` from silently
    handing its name to `~/.brainstrike/agents/x.md`, which would swap in
    entirely different child instructions under the id the project author
    controls. Reserving through only `deriveUserPersonaId` would be wrong:
    a built-in-owned name can never load in any tier, so it must NOT
    reserve, and every same-named file gets the accurate
    `collides with a built-in persona` error instead of a bogus "shadowed".
  - `MAX_USER_PERSONAS` counts scan ENTRIES (valid + invalid), so a
    directory of malformed files consumes the bound instead of extending
    the scan across roots — and because that can starve a later tier, an
    exhausted cap is REPORTED per directory in `incompleteDirs`
    (`reason: 'cap-reached'`), never only logged.
  - The directory-listing bound is `MAX_USER_PERSONAS * 2 + 1`, decoupled
    from the cap because `listDir`'s `maxEntries` counts every entry
    (READMEs, subdirs); a truncated listing lands in `incompleteDirs`
    (`reason: 'listing-truncated'`).
  - A duplicate id yields a `status: 'shadowed'` ENTRY carrying
    `shadowedBy: { absPath, sourceRootId? }` — the shape
    `packages/agent/src/skills/skill-scan.ts` already uses — so the panel
    names the file that WON. Shadowed is NOT an error state: it renders
    muted (precedence, not an authoring mistake), and `incompleteDirs`
    renders amber, with destructive red reserved for "you must fix a file".

  Paired tests: `apps/desktop/src/__tests__/assistant-server/user-personas-loader.test.ts`,
  `apps/desktop/src/__tests__/ipc-domains/ipc-user-personas-handlers.test.ts`,
  `packages/settings-ui/src/__tests__/subagent-personas-settings-section.test.tsx`.
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
  `packages/settings-ui/src/settings/system/subagent-personas-settings-section.tsx`;
  the store is factory-reset-registered in `packages/app-state/src/factory-reset.ts`.
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
  rebuilt per leg, so the per-run cap is effectively per-leg (v1 tradeoff).
  An in-flight delegation whose parent run is ABORTED mid-stream gets a terminal
  `subagent.failed` (status `cancelled`) event via
  `createDelegationLifecycleTracker` (drained on the generator's abort paths),
  so a cancelled parent never leaves an orphaned `subagent.started`.
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

  Subagent tool calls ALSO feed the SAME per-tool token telemetry table as
  primary tool calls, attributed to the parent run (BST-1196), via a
  telemetry-only `RunTokenDiagnostics.recordSubagentToolOutput` sink that
  deliberately does NOT feed the parent-run prompt-reconciliation aggregate
  `recordModelOutput` also updates; see assistant-persistence.md, `## TOOL-
  CALL TOKEN TELEMETRY`. This closes the BST-1190 follow-up gap.
- **A child that never answered is NOT a success (BST-1410).** Mastra computes a
  delegation result as `{ text: await streamResult.text, subAgentToolResults, usage }`.
  When `maxSteps` cuts the child off ON a tool-calls step, `text` is `''` and
  `onDelegationComplete` still reports `success: true` — which reaches the
  supervisor as a successful-but-empty delegation. Observed in production
  (run-7eb0e370, 2026-08-22): both delegations used exactly 8 step clusters
  (the `explore` cap), made 34 and 30 child tool calls over ~8 minutes, returned
  empty text, and the supervisor correctly judged them useless and abandoned
  delegation for the rest of an 18-minute turn.
  - `createDelegationConfig` now replaces an empty/whitespace `result.text` with
    an explicit reason through Mastra's `resultText` override — the seam core
    1.59 documents for exactly this case. The reason states only what is
    OBSERVABLE (no answer written, N tool calls made) and names the step cap as
    CONTEXT for re-scoping; the hook never receives a `finishReason`, so
    asserting "it hit the cap" would be a guess.
  - Child usage is reported BEFORE that branch returns: a child that burned
    minutes and then failed to answer is exactly the case whose cost must still
    be attributed.
  - `createDelegationOutcomeCapture` (same construction site and lifetime as
    `DelegationUsageCapture`, on all three stream legs) records the parent
    toolCallId, and the mapper emits `subagent.failed`/`failed` with
    `metadata.outcome = SUBAGENT_NO_ANSWER_OUTCOME` instead of
    `subagent.finished`/`completed`. A capture is required rather than reading
    the `tool-result` part, because by then `resultText` has ALREADY replaced
    the empty text — emptiness is no longer observable there.
  - The renderer reads that bounded `outcome` marker (never the human label,
    which a hard child `tool-error` shares) via `readSubagentDelegationOutcome`,
    scoped by `parentToolCallId` because two delegations run concurrently. The
    SubagentCard then shows `No answer` in amber instead of `Completed` in
    green: the delegation ran and its child rows stay browsable, so this is not
    a destructive-red state. `SUBAGENT_NO_ANSWER_OUTCOME` lives in
    `assistant-contract/personas.ts` because it is the wire between the
    agent-side emitter and the card.
  - **Forced synthesis turn.** Before giving up, a child that gathered SOMETHING
    (`subAgentToolResults` non-empty) gets ONE more turn with its tools
    withheld, so four minutes of exploration produces an answer instead of
    orphaned tool results. Two guards, deliberately BOTH: `toolChoice: 'none'`
    withholds the tool DEFINITIONS, and `activeTools: []` makes a call
    unresolvable in the loop for a model that emits one anyway — the
    step-capped live-loop spec caught exactly that (a third tool execution on
    the synthesis turn), so compliance is not assumed. `maxSteps: 1` bounds it,
    and the request ends on an explicit USER message
    (`CHILD_SYNTHESIS_PROMPT`) rather than the child's trailing assistant turn,
    because a prompt ending in an assistant message is prefill — the condition
    `PrefillErrorHandler` exists to recover from, not to manufacture.
  - The synthesizer uses `child.stream(...)` and DRAINS `fullStream` before
    awaiting `text`, matching what Mastra's own delegation tool does for v2
    models. `child.generate(...)` dispatches to the model's `doGenerate`, which
    this codebase's model paths (including the local host) do not implement —
    the first attempt silently produced nothing for exactly that reason.
  - **Cancellable and BOUNDED.** Mastra AWAITS `onDelegationComplete` before the
    delegation tool result exists, so an unbounded synthesis stream would stall
    the delegation, which stalls the parent's tool loop — and no watchdog covers
    this path, because it is not part of the parent stream. The turn therefore
    rides the parent leg's abort signal (a user Stop must not leave a child
    burning a provider request nobody will read) AND its own deadline
    (`streamInactivityMs`: a best-effort recovery that cannot finish inside the
    time a healthy stream may go quiet has already cost more than the answer is
    worth).
  - **The synthesis turn's usage is attributed**, as a SECOND `onChildUsage`
    report for the same persona — `createDelegationUsageCapture` pushes one
    chunk per call, so two chunks for one delegation is the intended shape. It
    is a whole extra child model call that replays everything the child gathered
    on the input side; discarding its usage would under-report exactly the child
    this hook already insists on billing.
  - **A FAILED delegation is not an unanswered one.** The hook fires for both,
    and a child that threw plausibly arrives with empty text — giving it the
    step-cap narrative would be a confident, wrong diagnosis of a provider
    error, and would run a synthesis turn on an agent that just failed. Gated on
    `context.success`; Mastra surfaces the failure through its own tool-error
    path, which the mapper already maps to `subagent.failed`.
  - **Unknown tool activity is reported as unknown**, never as "made no tool
    calls". Absence of `subAgentToolResults` is LEGITIMATE — core's v1/legacy
    delegation path returns `{ text }` alone — so it is a reportable unknown
    rather than a shape drift to throw on. Synthesis is skipped only when the
    count is KNOWN to be zero; an unknown count means the child may well have
    gathered plenty.
  - A synthesis failure logs `subagent_delegation_synthesis_failed` and falls
    through to the explicit no-answer reason. That is not a silent fallback: the
    parent still learns truthfully that nothing was analysed, and a synthesis
    error must never take down the parent run.
  - Reaching the child outside Mastra's own delegation call needs the child
    `Agent`, so the runtime exposes `subAgentsById`. That is its only consumer
    today.
  - Paired tests: `subagent-delegation.spec.ts` (hook), the step-capped
    and synthesis live-loop cases in
    `mastra-subagent-execution.integration.spec.ts` (one child scripted to never
    stop calling tools, reproducing the incident end-to-end; one that answers
    once its tools are withheld, proving the synthesis turn is real AND
    asserting the child's own tool RESULTS reached the synthesis prompt — a fake
    that answers regardless of its prompt would otherwise stay green while
    production handed the parent an invented summary),
    `subagent-tool-rows.test.ts` (outcome reader + concurrent-delegation
    scoping), `subagent-execution-card.test.tsx` (card status).
- **Budget guard:** `subAgentToolResults` is a `TRIMMABLE_COLLECTION_KEYS` entry
  (tool-output-limits.ts) so an oversized delegation result trims structurally
  (truncated + hint) instead of a hard size error.
- **Durable artifact analysis:** built-in personas include the read-only
  `brainstrike.readToolOutputArtifact` capability when the run registers it.
  Oversized-result settlement advertises whole-result delegation only after
  persona assembly has registered at least one artifact-reader-capable
  `agent-*` tool; permission/model-pin skips cannot produce a false hint.
- **Desktop wiring:** `packages/assistant-service/src/stream-init.ts` (desktop capabilities composed in `apps/desktop/src/assistant-server.ts`) sets
  `runtime.personas` to the per-request RESOLVED set (built-ins + user personas,
  availability applied — `resolvePersonaRuntimeFields`) on the shared runtime
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

Because every `subagent.*` row is HIDDEN from the main run timeline (it belongs
to the card), the timeline's `.started` → terminal pairing never had to be right
for them — and it was not: `getMatchingCompletedKind` rewrote the suffix, so
`subagent.started` paired with `subagent.completed`, a kind neither declared in
`ASSISTANT_RUN_EVENT_KINDS` nor emitted by anything, while
`getMatchingFailedKind` returned null for both `subagent.started` and
`subagent.tool.started` despite their `.failed` terminals existing. Both helpers
now resolve candidate terminals AGAINST the declared kinds, so a pairing can
never name a kind nothing emits. Both live in
`packages/assistant-ui/src/assistant-run-event-derivation.ts` (the pure-logic
module #2477 split out of the component file). No user-visible change — the rows stay hidden either way — but the
"run-event terminal pairing contract" cases in `assistant-run-timeline.test.tsx`
pin every declared `.started` kind to its declared terminal so emitters and
pairing cannot drift apart again.

Enabling that pairing forced two rules the timeline previously never needed,
both pinned by tests in the same file:

- **Scope by the delegation's own id.** `MAX_CONCURRENT_DELEGATIONS` is 2, so
  two `subagent.started` rows are open at once, and subagent LIFECYCLE events
  carry `parentToolCallId` with NO `toolCallId` of their own. The timeline's
  scoping used to be `tool.started`-only (`toolCallId`); it is now keyed per
  kind (`scopeMetadataKey`) — `parentToolCallId` for `subagent.started`, the
  child `toolCallId` for `subagent.tool.started`. Unscoped, the first
  `subagent.finished` in a run closes EVERY open delegation row and reports one
  delegation's outcome on another's.
- **Take the terminal's own status, not a status derived from its kind.**
  `makeCancelledDelegationRunEventChunks` emits `subagent.failed` carrying
  status `cancelled`; a kind-derived `failed` would report an aborted run's
  delegations as hard failures. Both resolvers now read the matched terminal's
  status, which is identical for every other pairing (`tool.completed` is
  `completed`, `run.step.finished` is `completed`, and so on).

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
