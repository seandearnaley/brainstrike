# Assistant Subagents (Persona Delegation)

> Extracted from AGENTS.md (2026-07-12). Read before changing persona delegation. Keep updated with the code.

## First-class subagent architecture gate (BST-1716)

The first-class subagent project extends this system in separate tickets.
**The shipped read-only/no-nesting restrictions below remain in force.** The
native capability proof is not permission to remove them before durable child
identity, transcript routing, and nested approvals are implemented.

Executable evidence is
`packages/agent/src/__tests__/mastra-subagent-contract.integration.spec.ts`,
alongside the existing production-mapper proof in
`mastra-subagent-execution.integration.spec.ts`. The new suite scripts only the
model transport through `fixtures/scripted-agent-model.ts`; Agent, tools,
delegation hooks, streams, memory and workflow snapshots are real. It uses the
canonical full-extension PGlite factory. Run it in the uncached integration
lane, not a new verifier registry.

Verified against installed **core 1.64.0 / memory 1.28.2**:

| Concern | Evidence / integration rule |
| --- | --- |
| Programmatic recursion | Root → child → grandchild executes a real leaf tool. Both delegation hooks retain their immediate parent and tool-call identity. |
| Memory | Configure the shared memory service explicitly on **every** Agent. A root-only memory configuration persisted root + child but omitted the grandchild; the paired negative control demonstrates this. Separate delegation thread/resource ids still isolate writes. |
| Concurrent persona reuse | Two invocations of one child yield two distinct child threads and two distinct grandchild threads. Persona id is configuration identity, never invocation identity. |
| Result projection | Raw completion data includes nested tool results, child thread/resource ids and usage. The parent model receives compact answer text; full nested tool results are not injected into its next prompt by default. |
| Nested approval | Grandchild approval/decline reaches the root and resumes the correct leaf using PGlite workflow snapshots. The approved effect runs once; the declined effect never runs. |
| Interactive suspension | A grandchild question suspends at the root and resumes with explicit data. This proves the native seam, not Brainstrike's future child-composer UI. |
| Cancellation | Root abort reaches the leaf loop and prevents its next model step. It is cooperative cancellation, not a claim that an arbitrary tool can be forcibly stopped. |
| Context | Each delegation gets a separate RequestContext map. This is a **shallow** copy, not deep isolation of mutable values; R5 in mastra-boundary.md still governs product context ownership. |
| Hook failure | Select `hookErrorStrategy: 'throw'`. The default continues after a filter/observer failure. Brainstrike's `createDelegationConfig` now explicitly fails the delegation if its lifecycle hook throws; the real-loop regression proves a failed usage sink is not reported as a successful result. |
| Current background API | Use `agent.stream(messages, { untilIdle: true })`; `streamUntilIdle()` is deprecated in the installed declarations. The no-background case completes without a second effect. Full background delivery needs BST-1723. |
| Background durability | The current composite store supplies an **in-memory** background domain when none is registered. A record disappears when the storage wrapper is recreated over the same PGlite DB. Enabling the manager alone is not durable support. |

The initial failed assertions established that a throwing context filter still
ran the child under the default policy, and that a throwing Brainstrike usage
sink still produced a successful delegation. Explicit fail-closed policy makes
both pass. The missing-grandchild-memory and ephemeral-background-store cases
remain explicit negative controls rather than being disguised as supported
product capabilities.

### Implementation decisions for the remaining tickets

- Keep native `Agent` delegation and the existing Brainstrike host services.
  Do not migrate to `AgentController` for this project: its beta Session host
  overlaps our permissions, thread/run ownership and workspace services, and
  its live grants/approvals are not automatically durable. The native tests
  already prove the recursion and suspension primitives we need. See the
  named background-lifetime exception in mastra-boundary.md.
- BST-1718 owns durable root/parent/invocation/child identities, server-owned
  resource access and usage attribution. Do not derive ancestry by parsing
  generated thread-id strings. Persist immutable invocation/config identity;
  follow-ups reuse the child thread but receive their own run identity.
- BST-1719 maps the nested stream into the same Brainstrike StreamChunk and
  transcript contracts as root conversations. Compact parent results are not
  a substitute for full child storage. Never expand parent prompt budgets to
  obtain richer UI data.
- BST-1720 must connect native nested approval/suspension to the production
  host and UI before BST-1721 exposes write/execute/general-worker tools.
- BST-1722 starts with **three descendant levels**, **two runnable children**
  and **eight total invocations per root turn**, with **16 steps per child**
  including its reserved synthesis step. These are proposed product limits
  using existing budgets, not an inferred Mastra programmatic limit. Enforce
  them at the root across every descendant and resume leg. The root's selected
  token budget covers descendant consumption; reject exhaustion visibly. A
  waiting parent must not hold a runnable slot needed by its child.
- Preserve read-only Explorer/Analyst definitions. A separate general worker
  completes deliverables using the root's eligible guarded capabilities and
  explicit task/context transfer. Profile narrowing never expands host
  authority. Child workspace writes need BST-1726 conflict/checkpoint rules.

### Verification boundaries

The native suite is **not desktop E2E coverage**. For production-path tests,
reuse `apps/desktop/e2e/utils/model-provider-shim.ts` with the isolated profile
and real host launch pattern in `mcp-packaged-core.desktop.test.ts`; script the
model endpoint, not the assistant stream. The existing renderer-only
`setupAssistantMock` is suitable for UI states, not execution/persistence proof.
Each runtime/UI ticket must extend these existing seams with its scenario;
BST-1728 runs the assembled matrix. No new mock-only lane can stand in for the
real host route. Renderer reconnect, reconstructed runtime/storage, and an
actual process restart are separate guarantees and must be reported separately.

Sources: [Mastra subagents](https://mastra.ai/docs/subagents),
[human-in-the-loop](https://mastra.ai/docs/agents/human-in-the-loop),
[background tasks](https://mastra.ai/docs/harness/background-tasks), and the
installed public Agent declarations. The file-based builder's documented
three-level discovery bound is not a universal runtime recursion guarantee.

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

  **THE STEP CAP IS DERIVED INTO THE DESCRIPTION, NOT WRITTEN INTO PROSE — do
  not relitigate.** `delegationDescriptionForPersona` (personas.ts) appends
  "Runs at most N steps…" from `persona.maxSteps`. Both places a description
  reaches a model call it: the child `Agent` config in
  `build-persona-subagents.ts` (which Mastra turns into the `agent-<id>` tool)
  and the supervisor's own instructions via `persona-assembly.ts`. That
  description is the only thing the supervisor reads when sizing a delegation;
  it used to say just "use when a question needs surveying many files", with
  the cap revealed only AFTER a failed delegation (the no-answer message) — the
  supervisor was invited to over-scope and then told off for it.

  Deriving beats restating for two reasons. There is no second copy to drift,
  and a substring test guarding one would be leaky by construction ("16"
  contains "1" and "6"). And USER-defined personas are covered for free: their
  description comes from markdown frontmatter, which can never mention a cap,
  so hardcoding the sentence in the built-ins would have left every user
  persona with the original bug.

  Built-ins declare `MAX_USER_PERSONA_MAX_STEPS` (16) rather than a private
  larger number: a budget users cannot themselves declare would make the
  shipped Explorer unreplicable by a user persona and would leave that constant
  describing a limit the app ignores. The previous value of 8 left seven usable
  tool steps once the reserved wrap-up step is subtracted.

  **Personas report PROVENANCE, and never author the deliverable.** Child
  instructions require `path:line` for anything read in code and an explicit
  marker when a fact came from documentation or a comment instead — the two go
  out of sync, and the caller cannot tell them apart afterwards. An `explore`
  child reported `FOREGROUND_GATE_REOPEN_MS=250` as a code constant when it
  exists only in `docs/agents/local-inference.md`, and the supervisor wrote it
  into durable working memory under the heading "Verified architecture survey".
  EVERY built-in is told not to produce the caller's final deliverable: one
  asked to survey the repo "for a developer-onboarding document" spent its
  budget returning a complete HTML page that the supervisor discarded, and the
  Analyst takes the same delegations.
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
  (the `explore` cap AT THE TIME; now 16), made 34 and 30 child tool calls over
  ~8 minutes, returned
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
  - **The child's LAST step is reserved for its summary — via Mastra's own
    `onIterationComplete` hook, not a bolt-on.** `buildChildIterationPolicy`
    (build-persona-subagents.ts) rides the child Agent's `defaultOptions`, so it
    applies when Mastra invokes the delegation internally: `Agent.stream()`
    deep-merges `defaultOptions` with the per-call options the delegation tool
    passes, and that call sets `maxSteps` but never `onIterationComplete`
    (verified against `@mastra/core@1.59.0`). On the step before the cap the
    policy returns `{ continue: false, feedback: CHILD_WRAP_UP_FEEDBACK }`; core
    appends the feedback to the child's own message list and grants exactly one
    more model call before stopping — the behaviour `docs/subagents.md`
    documents as "one final turn for a text response that incorporates the
    feedback".
  - **IN-LOOP is the point.** The summary turn inherits the child's abort
    signal, usage accounting, memory scoping and gathered context for free, and
    is spent from the persona's DECLARED budget rather than added on top of it:
    a `maxSteps: 8` child still costs at most eight model calls. This replaced a
    hand-rolled second `agent.stream()` call with its own abort signal, deadline,
    `activeTools: []`/`toolChoice` juggling, usage plumbing, and a
    `runtime.subAgentsById` field — all of which the framework hook makes
    unnecessary. Do not reintroduce a second stream.
  - Core only injects the feedback when the model intended to continue (it
    checks `stepResult.isContinued`), so a child that already answered is never
    interrupted. The policy additionally no-ops when the cap is unknown or is
    less than two steps — reserving the only turn a one-step child has would
    consume the budget it was given.
  - Paired tests: `subagent-delegation.spec.ts` (hook), the step-capped
    and wrap-up live-loop cases in
    `mastra-subagent-execution.integration.spec.ts` (one child scripted to never
    stop calling tools, reproducing the incident end-to-end; one that answers
    only when it sees the wrap-up feedback in its own prompt, which pins both
    that the feedback reached the child's next model call AND that the reserve
    is spent from the declared budget — the tool-execution count discriminates
    it from a bolt-on extra stream), plus `child-iteration-policy.spec.ts` for
    the policy in isolation,
    `subagent-tool-rows.test.ts` (outcome reader + concurrent-delegation
    scoping), `subagent-execution-card.test.tsx` (card status).
- **Budget guard:** an `agent-*` result's `subAgentToolResults` is PROJECTED to
  compact per-child rows (`toolName`, `toolCallId`, `isError`, small `args`)
  BEFORE any bounding (`projectDelegationResultForTransport`,
  tool-output-limits.ts) — the raw child `result` bodies are dropped: the
  parent model receives only the child's answer text and the card renders only
  the identifying fields. 2026-08-24 field failure: one oversized raw child
  result blew the generic budget, `trimCollectionToBudget` returned undefined
  (a single unfittable item), and the preview fallback dropped the list
  wholesale — a reopened card read "Completed · 0 tool calls" for a child that
  did minutes of work. The `TRIMMABLE_COLLECTION_KEYS` entry remains as the
  structural backstop for the (now tiny) projected list.
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
`subAgentToolResults` (authoritative on reload + at completion) AND LIVE
`subagent.tool.*` run events read THREAD-WIDE, scoped by `parentToolCallId`
(`readLiveSubagentToolRowsFromMessages`); persisted rows supersede live rows by
child `toolCallId`, so a running delegation shows its in-progress tool count
instead of "Running · 0 tool calls". Thread-wide, not message-scoped, is
load-bearing (2026-08-24): hydration weaves a run's events into ONE assistant
group and an approval-resume turn SPLITS into sibling groups, so on reload the
events can land on a different message than the card — a message-scoped read
showed "0 tool calls" for a completed four-minute child. The events are
parent-scoped by construction, so the wider read cannot pick up another
delegation's rows. The same thread-wide rule applies to the no-answer outcome
read (`readSubagentDelegationOutcomeFromMessages`).

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

### Maintaining the native contract proof

Re-run `mastra-subagent-contract.integration.spec.ts` and update the capability
matrix when upgrading `@mastra/core` or `@mastra/memory`. The agent package uses
`*.integration.spec.ts` (its explicit integration include and unit exclude),
so this real-PGlite suite belongs only to the uncached integration task.

The fail-closed strategy covers every delegation hook, including diagnostic
logging. A broken diagnostic sink is surfaced, not silently swallowed. The
start hook validates and clamps typed scalar limits; it does not log or await
after acquiring its counters. Completion releases its slot before reporting
usage or diagnostics.

### Early identity seam (BST-1718, native proof only)

Core 1.64.0 exposes the actual child scope through the public
`parseMemoryRequestContext` helper from `@mastra/core/memory` during the child's
input processor. The native suite verifies two concurrent calls to the same
persona, with and without explicitly configured child Memory. The processor
awaits a real database query before recording each scope, and every forwarded
child event, including the initial `start`, observes its own recorded identity.
The scope agrees with `onDelegationComplete`'s actual child thread/resource;
the nested stream's run id agrees with the child output processor's run id.

Use a host-owned invocation marker set in `onDelegationStart`'s copied
RequestContext to join the child input scope to the parent's tool-call id.
Neither persona name, completion order nor parsing generated ids establishes
this relationship. The child's native resource can differ from the root's
resource, so it is not the user's ownership authority.

An output processor alone is too late for this contract: the first native
`start` bypasses it (the original ordering assertion failed on exactly this
event). `onChunk` also runs after enqueue in the installed implementation.
Bind the thread scope during input preparation and await the host's durable
invocation/run binding at its stream-publication boundary. The paired failure
case proves that an input binding error is visible and prevents child model
and tool execution.

This establishes an initial-call API seam, not durable graph storage or access
control. A durable-snapshot resume may skip input preparation; production
resume authorization must use a persisted mapping and check the exact root,
invocation, child thread and run before publication. Migration, resource
ownership, reconstructed-host identity hydration and usage reconciliation remain
BST-1718 acceptance work. See the current [processor lifecycle reference](https://mastra.ai/reference/processors/processor-interface).

## Child conversation interaction contract (BST-1717)

The planned first-class child UI is specified in
[`docs/design/subagent-threads/README.md`](../design/subagent-threads/README.md),
with a clickable isolated design fixture beside it and behavioral browser
coverage in `apps/web/e2e/subagent-design-prototype.test.ts`. It is a design
contract for BST-1724/1725, not a claim that the current runtime persists full
child threads or enables writable personas.

Reuse the current thread renderer, runtime adapter, activity rows, color tokens,
tabs and TreeTable adapter. A child is selected by durable conversation identity;
persona id and call sign are separate. Mount transcripts only for visible panes.
Closing a tab changes presentation only. Stopping a child stops its owned branch;
root stop covers the tree. Direct steering must acknowledge delivery and notify
the parent without rewriting a completed delegation result. Every inherited
control must have a working child-scoped command and persistence path before it
appears enabled. The linked parity matrix names the existing owners and delivery
responsibilities; BST-1728 verifies actual runtime parity.
