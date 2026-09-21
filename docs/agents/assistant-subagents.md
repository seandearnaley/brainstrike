# Assistant Subagents (Persona Delegation)

Child conversation panels bind the shared thread debug export to the selected
child ID, never an inherited root binding. The export includes only that child's
authorized subtree; usage and full artifacts preserve their original root
attribution and execution identities. The root export includes all authorized
descendants. See `platform-contracts.md` for the export/retention contract and
`thread-debug-snapshot.integration.test.ts` for ancestry and attribution proofs.

> Extracted from AGENTS.md (2026-07-12). Read before changing persona delegation. Keep updated with the code.

## First-class subagent architecture gate (BST-1716)

Provider call warnings from inherited and pinned persona model instances share
the parent run's bounded warning sink (BST-1745). Runtime assembly wraps every
owned model instance, including a hosted pin under a descriptor-configured
parent. Warnings carry their configured provider/model in visible text and
metadata; repeats deduplicate per model, so a pinned model does not suppress
the same warning from a different supervisor model. Warning capture neither changes model input nor grants tools. The real
Mastra runtime/stream regression is
`provider-warning-run-events.integration.spec.ts`; descriptor models themselves
remain outside capture until BST-1740.

The first-class subagent project extends this system in separate tickets.
**Explorer/Analyst remain read-only and READ-ONLY children cannot delegate:
only a `mode: worker` child receives `agent-*` tools.** SETTLED 2026-09-14 (do
not relitigate): with recursion open to every persona, an Explorer delegated to
more Explorers three levels deep, ignored "do not delegate further", consumed
all eight invocations of the turn and the root's own three specialists were
rejected (thread-f6be9761). Paired test: `persona-recursion-gate.spec.ts`
("with durable budgets only a worker child may delegate"). A persona without an
explicit `mode` is read-only by contract (`personaMode`), so it is a leaf too.

**Every child pause surfaces in the leg that raised it, and the leg reads to
native close.** SETTLED 2026-09-14: a parallel delegation step pauses several
children in one native stream; the root loop no longer stops at the first
pause (`docs/agents/assistant-runtime.md`, "Native suspension completion").
Notices publish together behind the completion join; a resumed leg whose
siblings stay suspended ends as a `tool-calls` pause. Scenario proof for the
prompt that failed four times in production ("spin up 4 specialist
subagents"): `specialist-fanout.integration.spec.ts` — four Explorer children
under `read: ask`, every pause live (`rediscovered === 0`), one pause per
child, no child delegates, the root reports. The harness admits delegations
through a budget port because the desktop host does. LANDMINE: without that
port the native in-flight backstop (`MAX_CONCURRENT_DELEGATIONS`) rejects the
third parallel child, because Mastra fires no completion hook for a SUSPENDED
child and the counter never releases within the leg.

BST-1720 landed durable child decisions; BST-1721 enables explicit workers only
with that complete host capability. Recursion remains gated by BST-1722.

Executable evidence is
`packages/agent/src/__tests__/mastra-subagent-contract.integration.spec.ts`,
alongside the existing production-mapper proof in
`mastra-subagent-execution.integration.spec.ts`. The new suite scripts only the
model transport through `test-fixtures/scripted-agent-model.ts`; Agent, tools,
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
| Background durability | The composite store registers the native background domain in PGlite. Tasks survive storage reconstruction; runtime scopes constrain all reads and writes to the root owner. Pending approval recovery is also exercised across an actual desktop host restart. |

The initial failed assertions established that a throwing context filter still
ran the child under the default policy, and that a throwing Brainstrike usage
sink still produced a successful delegation. Explicit fail-closed policy makes
both pass. The missing-grandchild-memory and ephemeral-background-store cases
remain explicit negative controls rather than being disguised as supported
product capabilities.

## Capable workers and context transfer (BST-1721)

Workers require hosted catalog discovery; pins to the embedded `local` provider
are visibly omitted before model resolution, preserving the root local runtime's
no-skills boundary. Ollama and LM Studio use their existing hosted adapters.
The worker input budget derives from its resolved context window with the shared
output reservation and safety margin. Catalog names remain deferred rather than
being enumerated in worker system instructions. Whole-result delegation hints
use each registered child's actual permission-gated artifact-reader capability,
including wildcard workers; a denied reader never produces a hint.

The root stores only its host-projected system text in native RequestContext
snapshot data before inference. Both approval and question resume restore that
original data, so newly started children inherit it too; callbacks, RuntimeData,
tool results and execution capabilities are never serialized. Non-text metadata
is excluded from system authority exactly as in the root message converter.
Legacy snapshots without this context reject new children visibly. Storage-backed
resumes install the processor even when the caller omits the optional memory
address. The native snapshot also retains the original root thread id, so child
discovery can restore loaded tools while still excluding parent history. The original root system text occupies native snapshot storage even
when no child starts; only actual child admission applies the child byte budget.

Trusted context size is validated only when a child starts. Invalid or
oversized trusted context rejects that delegation before child inference; native
Mastra returns the tool error to the supervisor so it can respond. Disabled
delegation does not validate unused child context. Permission `allow`/YOLO permits
worker effects without a new prompt; `ask` requires the exact durable child decision.

Workers reuse permission filtering, output-artifact settlement, model projections,
canonical catalog search/loading, skill injection, provider history compatibility,
token limiting and error processors. Each child discovery catalog contains only
its post-permission native/MCP subset; search/load cannot widen that catalog.
Approval resume recalls discovery results from the actual native child thread and
resource via public `parseMemoryRequestContext`, then uses Mastra's context-store
parser before the paused tool executes. Parent history is never borrowed. Skill
metadata injection requires the corresponding permitted skill controls.
Explorer/Analyst keep their curated tool surface and provenance/reporting role.
Read-only specialists use native Memory with the same storage, retrieval options
and embedding configuration, but working memory disabled. Sharing the root
Memory instance also injected `updateWorkingMemory` and its mandatory per-response
system instruction, bypassing the specialist's curated tools; the BST-1771 Grok
capture spent its steps updating that scratchpad instead of inspecting files.
Worker-mode children retain their configured working memory. This does not turn
off child transcript persistence or change native thread ownership. Do not set
`defaultOptions.memory` merely to override this option: Mastra then treats the
child as owning its memory address and omits native child thread/resource injection.
Paired native tests: `delegated-system-context.integration.spec.ts` checks root
memory remains enabled while a read-only child reads evidence and reports without
memory-write tools/instructions; `worker-delegation.integration.spec.ts` retains
working memory and verifies delegated task content on initial and resumed workers.

Model/key pins retain existing fail-closed resolution. Local renderer inference
and surface capability rules are unchanged; no HTTP/runtime owner is added.

The initial `streamMastraAgent` entry captures host-supplied system messages,
not the generated supervisor prompt. `delegated-system-context.ts` adds those
text messages to the child's native MessageList under an owned tag before
suspension. Native snapshots retain the original workspace context across a
fresh approval runtime; resume does not reread changed AGENTS files. System
context over 64 KiB fails closed. Model-authored `params.instructions` is cleared
from the instruction override and appended to the delegated user task instead.
`messageFilter` selects at most 16 ordinary messages under a 64 KiB UTF-8
serialization budget. Read-only specialists receive parent conversation messages
as explicitly labeled reference text, preserving the source role/content inside
that reference, rather than inheriting the parent's assistant actions as their
own conversation. Native image/file parts remain structured model inputs; each
rewritten reference has an invocation-scoped identity without parent persistence
ownership. References are constructed lazily during selection and their complete
serialized size, including the label, counts toward the unchanged budget.
The native delegated task follows those references. This
boundary also applies on approval resume: the BST-1771 Grok replay otherwise
mistook parent coordination for its own work and waited for other specialists
instead of returning its briefing. Workers retain original message objects and
roles for their execution context. Both paths retain chronology;
trusted system entries, if supplied by the framework, are retained or rejected
when oversized. Pruning is logged. Hook failures propagate. Parent completion
uses the compact native child result for Worker, Explorer and Analyst, matching
Mastra 1.64's default. Raw nested tool results remain available to stream
projection and durable child persistence; this only controls the parent model prompt.

Paired evidence: persona/parser and child-factory specs; native
`worker-delegation.integration.spec.ts` inspects initial and resumed model roles,
exactly-once guarded hooks/effect, denial and parent result; native
`worker-discovery.integration.spec.ts` uses a real HTTP MCP server to prove
eligible-only loading and fresh-runtime approval execution; actual Electron
`delegated-worker-write.desktop.test.ts` reloads the pending decision and checks
a disposable file, parent continuation and history navigation without execution.
These prove the worker layer, not recursion/background/worktree coordination.

## Implementation decisions for the remaining tickets

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
  and **eight total invocations per root turn**, with **`maxChildSteps` per
  child (user setting, default 32, ceiling 64)** including its reserved
  synthesis step. `DELEGATION_LIMITS` is the TREE source (depth 3, invocations
  8, two runnable, 131,072 output tokens per original turn); the per-child
  allocations — `maxChildOutputTokens` (default 32,768), `maxStepOutputTokens`
  (default 8,192) and the precharged `synthesisOutputTokens` (default 2,048) —
  are `RuntimeSubagentSettings` (`subagent-settings.ts`), copied into the
  turn's budget row at first admission.
  These output allocations are separate from each model's input context window.
  The host atomically admits invocations and reserves model steps before work,
  across descendants and resume legs. Unknown usage remains charged; reported
  overages are persisted before rejecting tool execution. A waiting native
  delegation holds no model/tool permit.
- Preserve read-only Explorer/Analyst definitions. A separate general worker
  completes deliverables using the root's eligible guarded capabilities and
  explicit task/context transfer. Profile narrowing never expands host
  authority. Child workspace writes need BST-1726 conflict/checkpoint rules.

### Verification boundaries

The native suite is **not desktop E2E coverage**. For production-path tests,
reuse `apps/desktop/e2e/utils/model-provider-shim.ts` with the isolated profile
and real host launch pattern in `mcp-packaged-core.desktop.test.ts`; script the
model endpoint, not the assistant stream. The shim accepts either one fixed script
or a per-request selector receiving parsed messages, advertised function-tool
names, and the request ordinal. Route parent and child scripts from those
request inputs; each selected script still derives its tool/final turn from
that request's own history. The existing renderer-only
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

The supervisor assistant can delegate to read-only specialists and a capable Worker
using **Mastra's native supervisor pattern**: child `Agent`s passed via the
parent's `agents: {...}` config become `agent-<key>` delegation tools
automatically. We do NOT build a bespoke `subagent` tool — we ride Mastra's
delegation machinery (hooks, memory isolation, nested-chunk forwarding,
`subAgentToolResults`) and layer brainstrike's rules on top.

- **Personas as data:** `packages/assistant-contract/src/personas.ts`
  (`BUILT_IN_PERSONAS` = `explore`, `analyze`, `worker`) plus USER-DEFINED personas.
  Absent `mode` preserves read-only behavior; `assertReadOnlyPersona` rejects
  non-read/unknown native tools. Explicit `mode: worker` accepts original native
  and MCP ids; a sole `*` inherits the eligible host catalog. Mixed wildcards
  and parent-owned `manageTaskList` are rejected. `assertPersonaToolScope`
  validates the declared mode before runtime permission filtering. `id` is `string`
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
  provider::modelId`, `mode: read-only|worker`, `maxSteps` ≤ 16; body = child instructions), scanned
  FLAT (no recursive directory scan — the id becomes the `agent-<id>` tool name, and provider
  tool-name charsets forbid `:` namespacing) from (1) `<root>/.brainstrike/agents/`
  per mounted root, (2) `~/.brainstrike/agents/`, first-id-wins with warn-once;
  a built-in id collision is an INVALID file, not an override. Parse/validate:
  `packages/assistant-contract/src/user-personas.ts` (`buildUserPersona` —
  fail-closed; omitted mode retains legacy behavior and omitted `tools` =
  `DEFAULT_USER_PERSONA_TOOL_IDS`, the curated
  read-only exploration set WITHOUT webSearch/askUser/submitPlan/manageTaskList;
  explicit askUser/submitPlan declarations are allowed only with the complete
  durable child-control capability at runtime; manageTaskList remains rejected
  because its state belongs to the parent; bare tool names get
  the `brainstrike.` prefix; out-of-range `maxSteps` is an ERROR, never a
  clamp; ids are capped at 58 chars so `agent-<id>` fits the 64-char provider
  tool-name limit). Scan: `apps/desktop/src/assistant-server/user-personas-loader.ts`
  (bounded: 64K chars/file, `MAX_USER_PERSONAS` 50; INVALID files become
  visible `entries` with their error, consumed by Settings → Subagents via the
  `assistantPersonas:list` IPC / `window.assistantPersonas` bridge —
  capability-gated, absent on web). Explicit worker mode defaults omitted tools
  to `*`; known short native ids normalize through the native registry and
  opaque MCP ids retain their exact spelling. Legacy personas stay read-only.

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
- **Settings states what the host enforces (BST-1727):** every loadable list
  item (`AssistantPersonaListItem`, status `'ok'`) carries `personaScope`
  of the SAME definition the child is built from — `allowedToolIds`
  (`['*']` = the host catalog permitted by its mode), declared `maxSteps`, and the
  effective `mode` (no explicit mode ⇒ `'read-only'`) — populated by
  `apps/desktop/src/ipc-user-personas-handlers.ts` for built-ins and user
  personas alike, and by the panel's own built-in fallback on web. The panel
  renders each persona's scope line in plain terms ("Read-only" / "Worker
  mode" — the mode only PERMITS edit/run tools to be declared, the declared
  list decides — "Up to N steps", with "(1 reserved for its summary)" only
  when N ≥ 2 because `buildChildIterationPolicy` reserves nothing for a
  one-step child, then the tool count with the first ids or "every tool the
  host permits, including edit and run tools" for a worker `*`; a read-only
  wildcard represented by the bridge says "every read-only tool the host
  permits"). Persona files still reject read-only and mixed wildcards; a
  description-only file keeps its curated read-only defaults. `personaScope`
  copies the declared tool ids so list consumers do not share the source
  definition's array. N is `effectiveChildStepBudget` — the one helper `delegationDescriptionForPersona`
  also uses, so the number a user reads is the number the model is told and
  the host applies. The tree-wide block ("Limits on every turn") reads
  `DELEGATION_LIMITS` directly. Paired tests:
  `subagent-personas-delegation-limits.test.tsx` mocks the constant and the
  helper with distinct values no build uses (the helper returns 3 while the
  cap is 7), so a panel that repeats the arithmetic or types the numbers
  fails; `ipc-user-personas-handlers.test.ts` pins the scope
  fields on built-in and user items; `personas.test.ts` pins the helper
  against the model-facing description. An older bridge that omits the fields
  renders no scope line rather than a guess.
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
  unwraps a `tool-output` whose `toolName` is NOT in the guarded set — a
  delegation tool never is, while `executeCommand`/`runSkillScript` emit their
  own `tool-output` parts whose `output` is arbitrary tool data and must never
  be read as a boundary — and classifies the nested part under the SAME
  allow-list, recursing for a grandchild (bounded). Children select their tools
  from the parent's already-guarded map by sanitized id
  (`build-persona-subagents.ts`), so a child tool name is a key of the same
  `toolNameMap`. Without this, a silent child command longer than the parent's
  `streamInactivityMs` stalled the PARENT turn. Paired tests:
  `mastra-tool-execution-part-kind.spec.ts` (delegated-child cases) and
  `mastra-subagent-execution.integration.spec.ts` ("outlives the PARENT's
  inactivity window"). BACKGROUND delegation is out of scope — its child does
  not stream on the parent's leg.

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
  - `SUBAGENT_REJECTED_OUTCOME` (BST-1751) is the sibling marker for a
    delegation REFUSED before its child ran: an unknown persona, the in-memory
    concurrency or per-turn backstop, or the host's durable tree budget answered
    at delegation start. Mastra still returns a SUCCESSFUL tool call carrying
    `[Delegation Rejected] …`, so `onDelegationStart` records the refusal in the
    same outcome capture and the mapper emits `subagent.failed`/`failed` with
    `outcome = 'rejected'` (card: `Rejected`, amber). A BACKGROUND refusal
    still completes its task row, yet wakes no parent and is no ledger entry
    (REJECTED ADMISSION IS NO INVOCATION). Paired specs:
    `subagent-delegation.spec.ts` ("asks the durable budget at start"),
    `delegation-rejection.integration.spec.ts`.
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

The thread-wide projection is maintained by ONE `SubagentInvocationIndexProvider`
per mounted thread. Cards subscribe by `parentToolCallId`; a child event changes
only that invocation's immutable snapshot. The index walks the O(message count)
outer list on a thread-store notification, but it never revisits retained parts:
new message parts are folded from the previous length, an unrelated text update
reads zero run-event parts, and a message settlement revises its unresolved rows
to `interrupted` without a part scan. Message ids are required by assistant-ui's
public `MessageState` contract. The provider subscribes through the public root
client, then rereads once after subscription to close the render/effect gap;
render and snapshot reads never mutate or notify. Removal/reorder/id replacement
or part shrink rebuilds the authoritative projection. A settled message is
immutable during a normal run, so a new parts array for the same settled id is
the public runtime boundary for hydration, import, reset, or branch replacement
and also rebuilds the projection. Metadata identity is deliberately ignored:
ordinary metadata publication must not rescan retained content.

The incremental cursor relies on an installed producer invariant, not array
identity: `assistant-stream` 0.3.41's `appendData` creates a finished part stream,
`handlePartStart` constructs a new data object, and `appendPart` installs a new
parts array. Later delta handlers can replace text/reasoning/tool indexes, but
there is no data-part delta handler. An already emitted run-event data payload
therefore cannot mutate at the same index. When a running message publishes a
new parts array, the index makes a cheap identity pass over the retained prefix;
it folds no retained payloads, but rebuilds if any retained part changed. The
only permitted same-length difference is the known mutable final
text/reasoning/tool-call part. Tests in
`subagent-invocation-index-model.test.ts` pin 1k/5k/10k retained-part work counts,
same-array and immutable-array append, sibling-message resume, settlement, authoritative same-id
replacement with stable metadata, shrink/reorder/outcome rebuilds, metadata-only
updates, snapshot isolation and listener cleanup.
`subagent-invocation-index.test.tsx` mounts the provider against the real public
assistant-ui local runtime and covers append, settlement, same-id replacement,
runtime switch, StrictMode, and unmount with zero React warnings. A controlled
stream proves started/completed data parts publish before the run settles;
disabling the subscription makes this regression fail. The public API rationale
follows the current
assistant-ui state selector, external projection, store state, and rendering-list
guidance: `docs/api-reference/hooks/state`, `docs/guides/state-outside-the-thread`,
`tap/docs/store/state`, and `tap/docs/store/rendering-lists`.

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

Use `createDelegatedConversationBinding` to join the child input scope to the
parent's tool-call id. It keys a host-owned WeakMap by the child RequestContext
object supplied to `onDelegationStart`; no product entries are added to that map.
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

The initial-call seam is paired with durable graph storage and host access
checks below. A durable-snapshot resume may skip input preparation; production
resume authorization uses the persisted invocation and checks the exact root,
turn, persona and native run before publication. See the current [processor lifecycle reference](https://mastra.ai/reference/processors/processor-interface).

The first storage layer adds the host-only delegated conversation graph in
`@brainstrike/db`, with exact native scope checks across the full ancestor chain,
immutable child configuration/workspace binding, and explicit legacy absence.
Desktop production delegation now uses this graph together with invocation/run
identity, branch cleanup, publication/resume checks and usage reconciliation. See `assistant-persistence.md` and `database.md`.

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

### Shared conversation surface (BST-1724)

`AssistantConversationPanel` accepts a host-owned public `AssistantRuntime`, a
stable `threadKey`, and an accessible conversation label. It uses the same
`ChatThreadUI` as the main local/data-stream panels, including message/activity,
reasoning, rich tool/result extension points, errors, action bar, composer and
virtualized viewport. Do not introduce a second child message renderer.

The panel does not create, start or cancel an execution. The host owns runtime
creation, graph-authorized hydration and command routing. The existing-runtime
surface disables the root session queue dispatcher and its queue/steer controls
through `FollowUpQueueOwnershipContext`; a queued item cannot start work merely
because an inspection panel mounts or observes a run end. Child coordination
controls require their own host capability in BST-1723. Only mount visible
conversation panes. The runtime and all command callbacks must refer to the
selected durable conversation; disabled capabilities must be explicit. Mounting
this component alone does not implement child steering, tab navigation or
independent restored reading positions. Changing `threadKey` remounts the
panel subtree, resetting its draft, scroll and disclosure state. A switching
host must restore that view state or retain the owning runtime/draft separately;
those remain host integration work.

Runtime, detail/metadata providers, plan-mode state and error boundaries are
scoped inside each panel. Composer inputs use React `useId`, so simultaneous
panes have distinct accessible input identities. Host-provided tool-result
renderers remain available and receive the selected `threadKey` as their owner.
The existing global saved detail preference remains the default; this surface
alone does not add a new per-child preference store.

Child decisions and their queued-state indicators use the persisted root conversation ID
for the follow-up queue, matching the root panel's `threadKey`. The published
assistant-ui runtime thread ID is only a runtime registration identity; it may
differ from the persisted ID. `delegated-conversation-root.test.ts` keeps those
IDs distinct when proving live-delivery fallback and queued dispatch.

A child inspection panel never appends an approval or typed resume into its
external child runtime. Appending while that runtime reports running invokes
the runtime's cancellation path and cannot reach the owning root's live
decision transport. The app-shell supplies an explicit decision route to the
panel instead. That route validates and augments the durable child identity,
then asks the registered root owner to deliver the decision live or enqueue it
under the root thread key. The root alone decides live-versus-queue admission;
cards and the category grant strip read that same persisted root queue key
for their queued/locked state, even when the runtime registration ID differs.
Ranking also includes root-submitted user decisions so bulk grants cannot
resubmit an already dispatched approval. A rejected route stays visible, unlocks the control and
must not report delivery. Neither routed decisions nor category grants cancel
the root or selected child runtime. Once a routed decision is appended, its
pending/completed/retryable outcome also comes from that owning root thread;
the child transcript does not contain the resulting run. The provider shares
one owner-thread subscription across these readers. Outcome identities include
the owner-versus-child source and decision index so repeated incomplete runs
unlock the next retry without reviving an earlier optimistic lock.
`child-decision-owner-outcomes.test.tsx` covers both direct and delegated
approval/resume identities. The real workspace route rejects malformed input
as a promise so every control can observe failure and release its lock.

Paired runtime/DOM tests: `assistant-conversation-panel.test.tsx` proves isolated
snapshots/running state/drafts, child-only send/stop/approval routing, chronology,
reasoning disclosure, host result ownership and zero-part errors. Its browser
suite exercises the complete component with 600 messages, bounded mounting,
actual 390/900px browser viewports (800px high), both theme classes, keyboard
jump-to-latest and real Chromium reduced-motion emulation. Composer and jump
controls must fit inside the browser viewport and receive center-point hit tests;
a sized wrapper alone does not prove narrow-screen reachability. This suite compiles Tailwind using the shared theme
and package source directives, and asserts the actual grid layout is present.
Application navigation and native child binding remain app-shell/E2E work.

### Durable binding before publication and resume preparation (BST-1718)

The native contract fixture now awaits a real delegated graph write in the child
input processor and reloads that binding through a new repository before every
forwarded child event, including `start`. Public `Memory.getThreadById` confirms
that the native thread already exists at this seam, with both explicit and
inherited child memory. This proves the storage prerequisite, not production
host wiring or invocation/run attribution.

The recreated-agent grandchild approval and decline cases also prove that the
child input processor is not invoked on snapshot resume. A production resume
must authorize persisted ancestry and invocation identity at the host boundary
before forwarding any resumed child event; rerunning the input processor cannot
be assumed. See the current [processor interface timing](https://mastra.ai/reference/processors/processor-interface).

### Host binding adapter (BST-1718)

The direct `MastraAgentRuntimeOptions.conversationBinding` capability is threaded
through persona construction and the native delegation policy. The policy first
checks persona availability and budgets, then snapshots its configuration and
clamped maxSteps. Each child input processor awaits the capability's persistence
callback before model/tool execution. Missing parent registration or a rejected
write fails the child visibly. The callback receives observed native parent run,
thread/resource, parent tool-call, persona and actual child thread/resource ids;
it does not receive a fabricated child run id before native streaming exposes it.

The adapter stores ephemeral correlation in a WeakMap, not RequestContext entries
or RuntimeData. Its configuration snapshot is cloned before child execution.
The real production stream fixture proves callback-before-tool ordering and zero
child tool executions on persistence rejection. Removing the persona processor
wiring makes both regression cases fail. Existing read-only/no-recursion gating
is preserved. Desktop run-scoped memory now installs this capability through
`getDesktopMastraMemory` and the shared service runtime options. The host derives
owner, root and turn from its persisted server run; child resource ids remain
native execution scopes. Resume reauthorizes the original invocation against the
current leg's owner/root/turn. Names and colors are allocated once in the graph.
Thread deletion expands the complete native branch through the same authorized
graph (single, bulk and native Memory paths); revoked ancestry rejects the whole
delete, and overlapping bulk roots produce one deletion per native thread.

### Native run publication boundary (BST-1718)

A host may additionally supply `conversationBinding.bindRun`. The shared
`streamAttemptChunks` path awaits it before mapping the first native child
`tool-output` event in each attempt, including approval and suspension resume
legs. It receives the observed native parent run/tool call, child run and persona;
the host must resolve and authorize the durable invocation before returning.
The guard caches only successful bindings for that attempt and rejects a changed
child run under the same parent call. A recreated resume therefore authorizes
again, even though Mastra skips child `processInput` and may omit a new start.
No database lookup is performed for every text/reasoning delta.

Desktop now activates this boundary; child transcript/UI routing remains
BST-1719/BST-1724. The parent delegation-tool start can still render before native child
progress exists. A rejected publication binding propagates through the existing
stream error/abort path; cooperative abort is not proof that every asynchronous
native memory write has settled. The failure-path publication test uses Mastra's
public InMemoryStore; database durability remains separately proven with real
PGlite. Do not close a live host database merely because iteration rejected.
Paired production-stream tests cover awaited binding, single binding per attempt
and visible rejection without child progress; real recreated native approval
and decline tests prove the guard sees the same persisted native run identity.

The repository's `bindInvocationRun` includes the observed persona in its atomic
SQL predicate, both on first publication and reauthorization. A separate host
read cannot substitute for that mutation-time check. Missing/changed native identities remain fatal to
publication, rather than being skipped and potentially forwarded as authorized.
A real native child-tool failure retains its native chunk identity and is covered
by the production-stream guard test. With no `bindRun` capability, the guard is
absent and the stream loop adds no authorization promise/microtask per chunk.

### Durable delegated usage (BST-1718)

Bound completion reports carry the public Mastra parent run/tool call and child
thread/resource ids. The existing desktop child-usage writer resolves these to
the authorized, published invocation and its original host leg. Migration 128
adds a nullable invocation join to the existing usage table; historical rows are
left unattributed. Duplicate reports and cumulative resumed totals update one
row with monotonic token maxima, never additive replay. Model/provider cannot
change on that row. The public output-step processor reports actual model usage
before tools can pause or be cancelled. Installed Mastra supplies prior completed
`steps` separately from current `usage`; their sum is the cumulative invocation
total, including across approval resumes. Missing counts do not fabricate rows.
Metering uses a `transient: true` custom data part, so it cannot replace the native
assistant message or alter its tool output, text, or parent outcome. The public
native data-part path forwards these frames without delegation wrapper metadata;
the projection requires one already published active child thread and derives
its observed parent identity before the durable writer rechecks resource ownership.
The real desktop runtime tests preserve 1/1 tokens on pause/Stop and 2/2 after an
approved second model response, with artifact hydration and completed parent
outcomes verified through the same native boundary.

The completion hook can run ahead of a slow stream consumer. Bound reports stay
queued until the matching parent result/error or finish, after native child
publication has authorized its run. In-stream progress reports can drain only
after that same published child identity is validated. Completion and progress
reports coalesce by invocation and never replay unchanged cumulative totals.
Empty queues return before decoding a part.
Final draining still requires the durable binding at the writer; missing/changed identity or a failed write propagates
before the transient usage refresh. The writer uses the existing run-critical
foreground scheduler and its narrowly diagnosed saturated-host recovery. An
exhausted write fails visibly with a coded log; it never silently drops billing.
Identity errors carry a reason identifying the failed boundary without guessing
which SQL ownership predicate failed. Unbound callers retain their existing
usage contract. Local unbilled calls do not create billing rows.

The scripted model fixture is exported through the existing agent test-fixture
subpath convention (`@brainstrike/agent/test-fixtures/scripted-agent-model`), so
cross-package tests never import private source paths.
`delegated-runtime.integration.test.ts` drives desktop memory, the real Mastra
loop and the existing usage writer with only model transport/DB handle injection
scripted. It forces a fast child ahead of the consumer and reconstructs a PGlite
engine to verify durable identity/usage. This is host integration evidence, not
packaged Electron E2E or a process-restart guarantee. The separate graph/host,
branch deletion, contract and stream-ordering tests cover rejection and replay.

Lifecycle stays in the existing `brainstrike_assistant_run_events` journal.
Native delegation start/finish/failure events now carry `parentRuntimeRunId`
alongside `parentToolCallId`, so the host run/root ownership plus this key joins
the exact invocation, including repeated tool-call names in different runs.
Legacy events lacking the key are not fabricated into child lifecycle history.
The desktop production-loop test verifies this durable terminal correlation.
Neither root nor child conversations currently expose an archive action.
Child navigation inherits root filter/folder visibility (BST-1725); closing a
child tab remains reversible and does not delete or stop its work. There is
no automatic invocation retention sweep. Host-run retention must preserve
resumable invocations or explicitly remove the complete branch. Dedicated child
transcript statuses, approval presentation and lifecycle controls remain in
BST-1719/1720/1723 as specified by their contracts.

Deleting a delegated conversation detaches its usage row's delegation keys while
retaining the surviving root's spent tokens and cost. Numeric usage history was
already excluded from native thread-delete sidecars and also survives root
conversation deletion; factory reset remains its explicit cleanup path. Resource
re-keying is not a supported mutation of this immutable graph: an owner/scope
mismatch must remain denied. A future ownership migration must update native
and graph identity atomically with its own recovery proof, never bypass this
authorization check to delete a partially re-keyed branch.

### Child stream error parity (BST-1719)

The nested tool-result reader shares the root mapper's display transformation
and canonical guarded-error classification. A guarded child throw may arrive as
a native `tool-result` without `isError`; it must produce `subagent.tool.failed`,
never `subagent.tool.completed`. The real production supervisor-loop regression
asserts both the rejected tool execution and its failed progress presentation.
Full child transcript routing and hydration remain the rest of BST-1719.

### Scoped child stream projection (BST-1719 delivery layer)

With the durable publication capability present, each native invocation has an
independent lifecycle/tool-name state and uses `processMastraStreamPart`, the
same mapper as the root. `delegated-conversation-chunk` retains observed native
parent-run/tool-call/child-run identity and the native message/part identifiers.
Authorization precedes projection at every encountered depth. The parent keeps
its compact delegation lifecycle; child text does not become parent text.

The data-stream mapper emits `brainstrike.delegated-conversation` data carrying
frames from an independent instance of the existing `DataStreamMapper`. The
normal assistant-stream decoder can consume those frames. A child finish never
finishes the parent, and replay uses the existing session's encoded event buffer
without remapping or minting duplicate child events. Child frames obey the same
parent text/input-stream deferral rules as other auxiliary data. No native
transcript result or parent model projection is replaced by this transport.

SETTLED 2026-09-15, CONSUMED CHILD ENVELOPES (do not relitigate): the renderer
tap (`createDelegatedConversationTap`) consumes every out-of-band `data` entry
named `brainstrike.delegated-conversation` or `brainstrike.child-continuation`
once it has routed it to its child receiver; the parent accumulator never sees
it. Other entries in the same list are forwarded. A `part-start` data part owns
a parent part index and is still forwarded. Forwarding made assistant-stream's
accumulator and assistant-ui's local runtime copy every child frame into the
parent's `metadata.unstable_data` and publish a new parent message per frame,
re-rendering every parent part. In one GLM fan-out the root held 8,146
envelopes and 860 parts, React's development build retained 14.1 million
performance measures, and the renderer grew to 15 GB. Paired:
`delegated-conversation-receiver.test.ts` ("consumes routed child envelopes so
the parent message neither retains nor re-emits them").

SETTLED 2026-09-15, GROUPED PARTS RENDER ISOLATION (pnpm patch, do not
relitigate without an upstream release that fixes it): a fan-out root message
carries hundreds of run-event data parts (755–1,083 observed), and
`MessagePrimitive.GroupedParts` in @assistant-ui/core 0.3.17 (unchanged in
0.3.19 and on upstream main) handed every leaf a new render closure on every
render, defeating `MessagePartChildren`'s cache. Every root token then
re-rendered every part subtree (~1,000 parts at ~60 commits/s in run 17) and
the dev renderer crashed at 17 GB. `patches/@assistant-ui__core@0.3.17.patch`
builds one leaf closure per `children` identity. Paired:
`grouped-parts-render-isolation.test.tsx` ("does not re-invoke unchanged leaf
parts when another part streams" — 80 extra leaf renders before the patch, 0
after; "renders leaves with the new render function when the caller replaces
it" — fails when the memo ignores `children`). The upstream report is drafted,
not filed; delete the patch when a release carries the fix.

The decoder belongs to the native invocation, not to each observed native
message id. A resumed turn may move from its persisted message id to a new
native step id; the envelope preserves that observation while the same decoder
continues through its single terminal. Such a change must not create a second
unfinished decoder or discard an active tool part.

Production-loop tests cover concurrent same-persona children with distinct
native threads/runs/messages, including intentionally reused child tool IDs and
text → reasoning → tool → text ordering. The desktop observer persists child
lifecycle events in ordinary child run/event records, with a separate opaque
host run id per native invocation and host resume leg. One atomic repository
mutation revalidates ancestry, native run/persona and both original/current host
turns before creating the header/event. The child model comes from its stored
persona pin or the original inherited model; unrelated root settings and user
message ids are not copied. A malformed pin rejects rather than changing model.

The existing history adapter attaches these events to their observed native
message ids, so several resume legs can share one assistant group without
losing later events. A real desktop Mastra/PGlite test decodes the saved child
text/tools/events through this adapter before and after engine reconstruction.
A native root-cancellation test proves one child cancellation/finish and retains
partial content; removing settlement fails that test. A child terminal or pause
settles only its own projection. If the parent ends while a child is still open,
the child is cancelled on user abort or visibly failed for an interrupted stream.

Active child calls receive an error tool result plus a paired failed/cancelled
tool run event before synthetic termination, so the normal decoder cannot leave
them running. Already completed calls are not terminated twice. Execution-time
measurements use `(native thread id, tool-call id)` inside the request's recorder;
the guarded executor's public agent context and the host's authorized invocation
binding supply the two matching scopes. Parent steering is not inherited.

Recreated native grandchild approval and decline tests now run resumed output
through the production mapper. The first resumed parent wrapper lacks its own
message id; the authorized invocation's persisted native message id supplies
that missing scope. Both child and grandchild finish once with valid identities.
This proves the mapping seam, not the later production approval UI/routing ticket.

This layer does not close BST-1719. Nested pause/resume production proofs,
oversized artifact reload recovery and
complete receiver routing remain acceptance work. Child UI and controls remain
BST-1720/1723/1724/1725; read-only/no-nesting restrictions stay in force.

### Cancelled child transcript durability (BST-1719)

Native delegation uses `lastMessages: false`. On core 1.64 this also suppresses
the automatic MessageHistory output processor; the delegation's normal save
occurs after consuming the child stream. Root Stop can return before that save.
The desktop regression first lost all child assistant content, then exposed a
late native save overwriting an early cancellation snapshot.

The child processor captures the public `MessageList`, memory scope and current
native `messageId` at `processInputStep`. The existing root abort finalizer joins
these child turns. Each captures its unsaved native messages on the owning
attempt's abort signal, awaits Mastra's public `afterToolCall` hook around the
native delegation tool, then uses the same
abort snapshot policy and awaited `Memory.saveMessages` as the root. It retains
partial text, removes unfinished tool calls and appends the abort marker without
inventing a child message id. Normal completion/pause does not write an abort
snapshot. Per-invocation completion is correlated by native parent run/tool call
and the existing isolated RequestContext identity, never persona name. The
per-attempt tool hook uses the same owning signal and observed native tool-call
id. It runs after success, execution errors and suspension, including failures
before the child input processor attaches. `onDelegationComplete` alone is not
a sufficient join: core 1.64 skips it on suspension and when resolving child
instructions outside its execution try/catch. Real native tests pin both paths.
The hook releases the abort listener and removes normally settled invocations;
abort finalization releases the remaining entries even when a save fails.
A later attempt can reuse a settled native identity, while an overlapping
invocation with the same native identity fails explicitly.

This capability is constructed only when the runtime has an explicit root
memory scope and a memory instance. Supplying only the library memory instance
still permits ordinary delegation. The root tool hook is installed only for
legs with active delegation; a memory-backed run without personas does not gain
child persistence hooks. Missing native child identities remain errors once the
scoped capability is active.

A production-loop regression stalls the memory-backed child model, allows the
real watchdog to fire, and requires the child's actual provider signal to be
aborted before a successful parent continuation. The test does not resolve the
child stream or the completion promise itself. The common timeout callback and
attempt-consumer finalizer both abort the owning attempt before the child joins.

All three attempt legs require the owning abort signal at stream-option and
delegation configuration boundaries. Child saves are joined before replacing a
watchdog attempt and before runtime disposal; a successfully recovered parent
still uses its normal root transcript policy. Child output processors combine
with native channel/memory processors in core 1.64; configuring this processor
does not replace the memory defaults.

The real desktop test covers Stop during a tool with and without partial text,
equivalent history on the still-open and reconstructed engines, exact lifecycle
event retention and absence of the unfinished tool call. It does not claim a
packaged process restart or cancellation during snapshot-resumed tool execution;
those remain in the nested resume and assembled E2E acceptance.

The delayed-consumer case waits for the tool to enter execution, then aborts the
owner. The authoritative root signal now prevents the old automatic native late
save. To retain the adversarial persistence proof, the test injects a late result
through the real `Memory.saveMessages` API using the observed native message id,
and reads that exact row back before resuming terminal consumption. The frozen
snapshot must replace that row and retain the visible partial text and cancelled
events after engine reconstruction. This is fault injection at the native writer
boundary, not a claim that a cancelled native run normally produces a late save.

Historically this case failed when snapshot capture and normal-finish
classification relied on the child's propagated signal, which can lag the owner.
The owner signal supplied by `buildStreamOptions` still governs both decisions;
the child cannot turn an already-cancelled owner turn into a normal finish.
`runTurnAttempts` joins child persistence in its generator finalizer after consumption;
no sleeps, retries or timeout changes establish the verifier's ordering.

### Child tool input transport parity (BST-1719)

A native multi-step child retains its observed message id in the saved Mastra
assistant row. The desktop production-loop test
`delegated-stream-parity.integration.test.ts` compares text, provider reasoning,
tool name/id/input/result and final text after the normal transport decoder and
a reconstructed native memory engine. This is content parity for the tested
normal turn, not a claim of complete receiver or resumed-message parity.

The shared encoder must transmit complete tool input through `c` argument
deltas before the `9` completion frame whenever `b` already started the call.
The catalog-pinned assistant-stream 0.3.41 decoder ignores `9.args` for an existing call;
`b` immediately followed by `9` therefore displayed `{}` even though native
storage retained the real input. The common completion helper emits complete
input when no argument deltas have flowed, or the missing suffix of a compatible
partial prefix, then closes the input. Empty containers and native tool-error
args take the same path. An incompatible authoritative input closes once and
fails the session visibly with preceding text retained; it is never concatenated
as a second JSON object or retried by terminal error handling.
This also covers root calls, late complete input and approval notices without
duplicating streamed JSON or changing native persistence.

### Child lifecycle ordering on reload (BST-1719)

Oversized child outputs pass through the parent's central artifact-settlement
policy after child permission selection and before projection at the child's own
model budget. Migration 129 distinguishes native execution threads within the
root-owned artifact scope, so sibling calls may reuse tool-call IDs without
colliding. The native fixture executes both siblings, consumes their actual
model-visible continuation actions to reconstruct all bytes, then reconstructs
the database engine and recovers the same content from hydrated child envelopes.
The public child-stream decoder receives those same artifact envelopes, while
the parent response remains a compact summary.
This preserves root-scoped reader authority and the existing reset/expiry path.
Missing native child identity or a permission-eligible reader is a visible error.
User personas without an explicit tool list include the read-only artifact reader
by default; an explicit list remains authoritative and never gains tools implicitly.
Native request context is parsed through the public memory parser across ESM/CJS
builds; malformed memory still fails. Root artifacts retain the host-bound thread
identity rather than accepting a tool-supplied execution scope.

The normal native desktop parity fixture also compares lifecycle data in its
exact live position, including the tool-start event after its tool part. A
scoped start uses its existing native message/tool-call identity as that
hydration anchor; timestamps alone reorder activity when several parts share
a millisecond. Multiple matching tool boundaries remain distinct, and removed
unfinished calls keep their failure journal without fabricated tool parts.
Legacy timeline placement is unchanged. This is full content/event ordering for
the tested normal turn, not a claim about every resume leg or the still-pending
child receiver.

Hydration deduplicates tool calls within one assistant group, preserving progressive
snapshots without removing a same-id tool in a later turn or regenerated sibling.
The native message assignment precedes tool anchoring; a trailing tool releases
its lifecycle queue through the normal final flush. The paired hydration regression
covers reused native tool ids across turns and their separate inline results.

Scoped tool completion/failure also cannot precede its persisted tool part when
the loaded journal has no start event. The tool boundary is only a lower bound
for terminals: their timestamps still preserve text streamed while the tool was
running. Paired hydration tests cover terminal-only journals and mixed legacy
events without changing content order or fabricating missing parts.

### Renderer receiver and native transcript ownership (BST-1719)

The optional panel/runtime `onDelegatedConversation` callback receives full,
ephemeral child snapshots through the ordinary decoder and accumulator, keyed
by native invocation across observed message changes. Full replay replaces
snapshots; native memory remains the sole transcript writer. Missing terminals
and unseeded/mismatched replay openings fail visibly. Child error isolation,
recursive descendants, cancellation and upstream-fault settlement are covered
at the public runtime adapter; the desktop native fixture now tests that adapter
against the reconstructed persisted transcript. See the renderer receiver
contract in `assistant-runtime.md` for lifecycle and remaining acceptance scope.
Child tabs/rendering and durable graph association remain BST-1724 work.

Receiver completion uses the same `deferMessageFinishUntilFlush` transform as the
parent. Both final part streams and descendant receivers settle before a complete
snapshot is published. Producer failures/cancellations still emit their required
`d` finish frame; an error frame alone is a truncated stream, not a valid child
terminal. Cleanup preserves the primary transport/envelope/abort failure and logs
secondary settlement failures once. Consumer presence selects receiver installation
at run start; an installed receiver reads the latest committed callback on each
update, including callback replacement during an active run.

The receiver also retains its first observed failure if decoding or descendant
settlement subsequently fails; the competing observer/decoder regression pins
this through the public runtime adapter.

### Native child response boundaries across resume (BST-1719)

Persona children install `createResponseBoundaryProcessor` through Mastra's
public `processOutputStep` hook. A response step without tool calls marks its
last native assistant row using `MessageList.markResponseMessageBoundary`.
Tool steps stay open for their results and ordinary continuation. The processor
neither mints message IDs nor removes repeated text or tool content.

At core 1.64.0, `Agent.#executeOnFinish` re-adds the response rows to the same
message list. After approval resume rotates the native assistant ID, re-adding
an earlier row can otherwise merge its text into the new continuation row.
The boundary prevents that merge before native persistence runs. This uses the
public processor/message-list API; no vendor patch or second content writer.
Core seals the pre-approval row when it rotates the response ID; the processor
seals the new continuation row before finish re-adds the earlier rows. A boundary
miss is an explicit integrity error, never permission to persist known-ambiguous
history. The processor leaves the existing content intact when reporting it.

The desktop native verifier runs parent → child → grandchild approval and
decline after rebuilding Mastra and the database engine. It compares text
across live stream legs with folded history, retains reasoning/tool ordering
and non-empty arguments, checks exactly-once approved execution and zero declined
execution, then reconstructs the database again. Repeated legitimate text in
the continuation remains present. The fixture uses the production projection,
host observer and public child decoder; it does not claim that the pending
BST-1720 approval UI or unrestricted recursive persona factory is enabled.
The fixture installs the real processor on native Agents directly. The persona
factory suite separately verifies production installation, and the direct
MessageList tests cover terminal replay, open tool steps, empty responses and
boundary conflicts.

Reference: [Mastra processors](https://mastra.ai/docs/agents/processors), plus
installed core 1.64.0 public `MessageList` declarations and native finish path.

The same native test pins declined tool hydration: the `output-denied` row
produces the shared live decline envelope with its original arguments and
reason, without reporting success or failure. Approval grants and execution
routing remain native; this change only preserves the already-made decision.
An already persisted valid decline result remains authoritative, including its
reason; native denials without a result use the shared decline constructor.

### Exact delegated decision identity (BST-1720 foundation)

A delegated pause carries its observed root-to-leaf native invocation path and
the leaf tool-call ID. The root run/call remains Mastra's transport target; it
is not the decision identity. Core 1.64 reuses that root alias when a child
pauses on another tool, so notices, notification dedupe and rediscovered
message identities key the leaf run/call. Parent and child views send the same
canonical root action plus the immutable leaf guard. The 32-edge wire ceiling
bounds parsing only; it does not enable recursion or define an execution budget.

The desktop host reauthorizes every edge against the owning root, original
turn, native child run, persona and parent thread. Native freshness uses public
`Agent.listAgents` and `Agent.listSuspendedRuns` under those observed scopes.
Never derive resource/thread IDs from native ID strings. A missing or ambiguous
pending leaf rejects before execution. Snapshot validation is repeated after
acquiring durable root admission, because another resume can finish between the
initial read and admission. Migration 131 retains a unique leaf decision record
and permits only one claimed decision per root. Runtime disposal settles only
its own claims; another recreated host cannot release them. Startup reaping
marks abandoned claims interrupted and retains their identity, without replay.
An interrupted leaf is TERMINAL and has NO recovery path, by design: only a
`claimed` row can be consumed or released, the card renders as settled
(`DECIDED_DECISION_STATES`, `undecided-pause-notices.ts`), and its background
task stays suspended because the reaper repairs `pending`/`running` tasks only
— nothing replays an effect that may already have happened. A session grant
therefore SKIPS such a sibling rather than failing the grant over it
(BST-1749 follow-up): the loud failure it used to raise recovered nothing and
refused the user's own card on every retry that still carried the grant.
The record describes admission, not whether a tool effect succeeded. If the
post-admission snapshot recheck fails before native resume is invoked, the host
rolls back only that binding's matching unexecuted claim and propagates the
failure; so does any later failure before the approval leg invokes native
resume — locating the parked task or answering the parked siblings its
grant covers (`beforeDelegatedToolActionResume` around
`claimGrantedBackgroundResumes`, which releases through the owner that took
the claim: the continuation host for a child continuation decision, the
delegated ledger otherwise). Left to disposal, `finishToolActions` consumed
the never-executed claim and refused the still-parked card for good
(BST-1749 review; desktop row "an approval leg whose granted sibling is
refused releases the user's claim", `delegated-tool-actions.spec.ts`).
Subsequent native failures or cancellation do not release the leaf:
the effect may already have occurred. Disposal attempts all cleanup owners in
order and preserves multiple failures in an `AggregateError`; it never logs
and swallows a failed decision settlement. Construction failures on every
initial/approve/decline/resume leg retain both the original failure and any
disposal aggregate as the typed error's cause, and explicitly report incomplete
cleanup to the caller while preserving an original typed error's code and
context. This is the runtime-wide construction error contract in
`assistant-runtime.md`, not a delegation-only exception.

The native process-restart verifier runs three separate Node processes against
one on-disk PGlite database, using the real Mastra parent/child/grandchild agents,
Brainstrike memory store, delegation binding, host admission and startup reaper.
Only the model transport is scripted. A suspended grandchild can be approved
once or declined without executing its effect after the originating process
has exited. A third process rejects the same durable decision even without
consulting an already-consumed native snapshot. If the second process exits
after admission without invoking or settling the tool, startup retains the
claim as interrupted and refuses replay. The fixture records distinct process
IDs and a durable effect count, not just reconstructed JavaScript objects.

This is native Node/Mastra restart proof, separate from Electron renderer reload
and packaged desktop UI coverage. It does not enable write-capable personas or
claim sibling, cancellation, or packaged interactive recovery UI parity.
The same fixture now runs the production askUser and submitPlan tools with
the production sanitizer. A fresh process answers a grandchild question or
approves/rejects its plan, verifies the exact result in the leaf model prompt
and the final parent answer, and rejects the consumed decision on another
restart. No second suspend is accepted as successful completion.
The paired `delegated-process-restart.integration.test.ts` is discovered by the
existing desktop integration lane; no bespoke CI lane or production test route.
Its separate Node processes resolve public package exports rather than Vitest
source aliases. Desktop `test:integration` and `test:coverage` therefore declare
exact `@brainstrike/agent#build` and `@brainstrike/assistant-data#build` dependencies
for the agent fixtures and startup reaper, including their DB/contract closure.
Direct Vitest invocation needs those builds first; the CI Turbo invocation
schedules them automatically from a clean checkout.

The native `beforeToolCall` hook captures the original parent model invocation
through Mastra's public `MessageList` adapter, before delegation starts. The
short-lived capture uses native execution thread/call identity, and the host
stores that input on the immutable invocation. The hook's `input` already has
Mastra-injected scope defaults, so it is not substituted for the model's input.
`onDelegationStart.messages` does not include the current call in core 1.64.
Approval resume displays the original parent call while preserving the leaf
tool as the approved operation. Missing original input refuses both approval
and decline visibly,
never a fabricated delegation call or leaf arguments under a parent ID.

Keyless rediscovery walks the same authorized graph and uses inert Agents with
the original persona IDs to list native child snapshots. It loads no tools or
provider credentials and does not resume workflows. The native reconstructed
parent/child/grandchild fixture checks identity, original parent input, leaf
arguments, approve-once/decline-never behavior and transcript parity. Host,
contract, projection, notice, notification and hydration tests cover their own
boundaries; negative controls remove root uniqueness and advance the native
leaf during admission. These proofs do not yet constitute packaged process
restart or complete child interaction UX.

Persona read-only, ask-tool and interactive-tool restrictions remain until the
remaining BST-1720 production entry, question/plan, interrupted-state UI and
end-to-end acceptance is green. This foundation does not enable mutation tools
or unrestricted recursive workers.

### Durable delegated decision recovery display (BST-1720)

The suspended-runs endpoint annotates each rediscovered native leaf with its
exact durable admission state, scoped by owner, root, root transport call and
leaf run/call. `claimed`, `consumed` and `interrupted` mean the same decision
cannot be resubmitted; none asserts that its tool effect succeeded. A later
leaf behind the same parent alias remains independently actionable. Discovery
only reads admission records and never creates a pause from them.

The existing approval, question and plan cards retain their original content
and show the admission status with controls locked. Unknown present states
fail wire validation and render an unavailable status if encountered directly
in a card. Only a pause without a durable decision is actionable; claimed,
consumed, interrupted and cancelled pauses never mark sidebar attention, and
staleness without admission state remains advisory. Status refresh
uses the existing thread reload; no polling or auto-resume is introduced.
The server's durable admission check remains authoritative if a claim races
this read. Missing/ambiguous native snapshots still use the visible discovery
error path; this slice does not reconstruct missing snapshots.

Paired proof: the delegated-decision-discovery endpoint tests, real PGlite
cases in delegated-conversation-host.integration.test.ts, shared notice and
contract tests, and assistant-approval-reload-linearity.desktop.test.ts.
The Electron test exercises renderer reload and real history hydration with a
scripted discovery response; the database test independently verifies admission
state and ownership. Neither claims packaged process-restart UI parity.

The decision-state SQL joins the complete deduplicated root-run/root-call/leaf-run/leaf-call
tuples, so retained historical decisions for the same child are not fetched or
validated. The lookup uses only returned pauses (including the existing
newest-ten suspend cap). Ordinary pauses require no extra decision-database
read. A failed query or invalid saved state remains a visible discovery error;
it must never become an empty annotation map that re-enables a consumed leaf.
Explicitly undefined/inherited decision-state fields are invalid, not absent.
Interrupted claims cannot safely offer retry: follow-up/cancellation controls
remain part of BST-1723, and never erase the original admission record.

### Forwarded interactive pause presentation

A native parent suspension names its delegation tool (`agent-child`), while
its decision belongs to the leaf. The authorized recursive stream projection
retains the observed leaf pause and restores its tool name, payload/arguments
and resume schema before the shared mapper classifies approval or typed resume
support. Root and intermediate transport run/call coordinates remain unchanged;
the exact leaf guard still owns decision identity. A changed pause kind throws.
Unbound or unrelated parts keep their ordinary mapper behavior, and genuinely
unregistered leaf tools still emit the visible unsupported-resume event.

The production stream-loop regression pairs this contract with the actual
three-process verifier. Removing the loop's preparation call fails the unit
cases rather than letting a correctly implemented helper mask missing wiring.
This does not enable interactive tools in read-only persona profiles or complete
the child-panel controls, sibling admission, or cancellation acceptance gates.

The prepared pause is deliberately a narrow input to the common pause mapper:
only decision payload/schema and transport coordinates are forwarded. Native
row IDs and provenance are read from the original part by the projection;
this prepared value is never written back to native memory or used as a stream
replacement. The observed registered leaf tool ID is retained separately from
its display name so sanitizer collisions cannot remap an already resolved ID.
A pause-kind mismatch fails visibly because substituting approval for a question
would expose the wrong decision action. It must not return an actionable wrapper
as a fallback. Pending aliases live only for this stream attempt; resume creates
a new projection, and a subsequent observed leaf replaces the prior alias. They
are not a cross-resume cache.

### Child history boundary for a live stream leg

A child decoder contains one host stream leg, not a complete conversation.
Native resume can update a previous row's tool result and append continuation
text in another row. Its latest observed message id therefore cannot be used
to remove or replace a single history row. Identical text before and after a
pause is legitimate content, not evidence of a duplicate.

The desktop binding captures an immutable history baseline after the exact
leaf decision is claimed and its native snapshot validated, before invoking
native resume. Every ancestor on that admitted path uses the ordinary history
readers in `@brainstrike/db`, including rewind tombstones, message parent topology and the existing
80-message/run hydration window. All reads must succeed before any baseline
is published. A different leaf cannot borrow the claim; releasing an
unexecuted claim clears its snapshots so a later admission reads fresh state.
For a newly created invocation, only already persisted input rows belong to
the baseline; the current assistant output belongs to the decoder.

The first delegated envelope carries this baseline with authoritative child
thread and host-leg ids. Abnormal termination also carries it if no earlier
renderable chunk did. Subsequent envelopes cannot introduce or replace the
boundary. Replay recreates the decoder and replays the same boundary. These
snapshots are ephemeral stream data; native Mastra memory remains the writer.

`delegated-resume-parity.integration.test.ts` proves real approve/decline and
identical-text native continuations deliver pre-effect history through the
production decoder. The host integration test proves exact admission and
release/recapture, and projection/receiver tests pin termination and ordering.
The baseline is the transport prerequisite for BST-1724's shared live view;
it does not by itself enable child controls or remove persona capability gates.

The readers and native row conversion live in the Node-compatible DB package,
not the renderer-facing `assistant-data` entry. Electron main externalizes
workspace imports as CJS requires; a browser-only export can type-check and
still prevent application launch. The main-process external-require verifier
and real Electron launch smoke are part of this boundary's validation.
Both renderer and desktop consume the same readers. The desktop database handle
is released only after migration; the renderer repository's initialize step is
an assertion, not lazy DDL. Run-event timestamps and metadata are normalized by
the common row mapper before serialization.

Concurrent binds share a single in-flight initial history read. Mastra 1.64
creates a new child thread per delegation (even an input thread id gets a UUID
suffix); the initial baseline therefore contains input, not an earlier child
turn. The native test asserts this input and non-empty normalized run events
on resume. A consumed decision retains its baseline until that host leg ends;
finish runs at runtime disposal, so later continuation uses a new binding.
Capture or validation failure stops admission and releases the unexecuted claim;
it must never omit history and proceed as if the child view were complete.

The DB unit and browser test projects must resolve the history reader's
`assistant-contract/run-events` subpath before their root package alias. A
root alias targeting `src/index.ts` cannot also resolve a subpath; the static
workspace-source verifier and the DB entrypoint/worker tests guard this edge.
The native parity assertion pairs the pre-effect marker exclusion with the
approved leaf result, so the exclusion cannot pass after the fixture marker
disappears. Terminal projection tests use a nonempty second producer to prove
that abnormal termination is published only once.

### Host-owned child view binding

The shared child view combines the baseline with its live leg through the
public assistant-ui external-store runtime and converter. The vendor content
concatenator updates a repeated tool-call id in place and preserves identical
text on either side of a resume. It replaces only the active history head;
saved branch nodes retain their parent edges. Native row ids do not determine
the lifetime of this live leg.

The app-shell child store publishes complete snapshots, scoped to an exact
native invocation and authoritative child thread. Current-leg replay replaces
the prior snapshot; callbacks from a superseded leg cannot overwrite an admitted
continuation. View unsubscription does not clear the host's output. The shared
panel subscribes to that store, so closing/reopening a view neither invokes a
model nor loses output produced while the view was closed.

A child decision is accepted only if its validated native ancestry includes
that view's invocation. A current host snapshot supplies its validated live identity;
a restored view resolves identity against the durable invocation graph. Both
paths still require native host authorization. Its action metadata and run configuration go through
the owning root runtime, without the child's message parent/source ids. The
root owns its own append topology and the native host still authenticates the
full decision path. Ordinary follow-up prompts are not decision messages;
steering and cancellation remain explicit coordination capabilities.
`AssistantUiPanel.onRuntimeReady` registers the actual owning runtime and its
returned cleanup runs when that runtime is disposed. Opening a child view must
never construct another inference runtime.

The workspace owns the ephemeral root registry, keyed by owner resource and
root thread together. Snapshot reads are pure: committed external-store
subscriptions acquire a lease for each mounted owner or child view. Releasing
the final lease evicts the root and clears its converted transcripts; saved,
unvisited tabs recover through native history when mounted. A stale cleanup
cannot evict a replacement. Registration captures the actual thread handle and
its runtime identity, and decision append rejects a handle that has retargeted.
 The actual panel wrapper publishes delegated snapshots
and registers its actual runtime into that root; standalone panels without a
workspace do not advertise child navigation. Runtime cleanup is identity-aware:
disposing an old runtime cannot unregister a replacement. An unavailable owner
rejects a decision before append, while previously captured child output stays
available for inspection. Removing the production stream callback in the manual negative-control run
makes the wrapper behavioral test lose its observed child output. The committed
test exercises the restored production callback.

Child workspace tab addresses encode owner, root and child identifiers and use
the existing workspace selection store's singleton/open/close/hydrate behavior.
An address is not authority: the durable graph still authorizes history reads.
Ordinary app ids remain untouched; malformed reserved child addresses must
surface as errors rather than silently disappear during restoration.

The shared child panel accepts ordinary persisted history for a view reopened
without a live host envelope. Its caller must authorize the child against the
durable graph before supplying that history. A live host snapshot replaces the
saved projection with its own baseline and continuation; opening either view
never invokes `onNew`. The panel's regression test uses the real ordinary-history
converter and proves both no execution on opening and the saved-to-live handoff.
An explicit search hit can extend a child baseline backwards through bounded native history pages. The shared view merges older durable context while retaining the host's current head and live controls; it never imports another inference runtime or writes transcript rows. The saved-workspace coordinator opens the owning root before the singleton child tab, and the shared transcript resolves native snapshot IDs to their rendered assistant group. `delegated-child-reload.integration.test.tsx` exercises a grandchild hit older than the initial 80 rows, close/reopen, ancestry, unchanged parent draft, and no execution.
The subagent card's optional Open conversation action is separate from its
collapse toggle. Navigation binds the exact parent tool-call id to its host
baseline thread id; contradictory addresses surface as card-local alerts, with
no navigation action, rather than throwing from the streaming selector. The action is absent
until the workspace supplies a navigation capability.
Pending invocation lookup failures stay visible beside the Open conversation
action. The action clears that error and performs one fresh lookup when the user
explicitly retries; the shared UI never polls or silently retries a host binding.

`DelegatedWorkspaceTabsProvider` registers saved child tab addresses before the
ordinary workspace provider reconciles selection. It resolves native graph
ownership and persisted callsign/color before mounting a transcript. Unselected
restored tabs load metadata only; the existing WorkspaceBody controls transcript
mounting and closing. Invalid reserved addresses remain visible error tabs.
Both the main wrapper and child panel provide the same navigation action. The
workspace integration test opens the real shared child panel, closes it, and
reopens output published by the owning host while it was closed; removing the
navigation context is its negative control. Restored decision routing and
sidebar ancestry are not implemented by this registry boundary.

The shared transcript data-renderer registrations live together in
`assistant-data-renderer-registration.tsx`; the panel still mounts that component
for both root and child views. This keeps the panel within its existing source
budget without weakening the guard or changing approval, suspension, timeline,
or hidden metadata rendering. Workspace metadata is retained only for open tabs:
closing and reopening forces graph authorization before prior metadata/history
can be exposed. Child loading views subscribe to their owning host so a live
snapshot can become visible while an ordinary history read is still pending.
Metadata reads skip already authorized entries for the current database; app
arrays retain their identity until their inputs change. A malformed invocation
binding takes precedence over a simultaneous discovery request failure.
The root-layout test pins the owning provider around the actual assistant slot.
The reload integration test uses the native history reader and its ordinary
hydration window as the arriving live baseline and retains earlier transcript
text after the handoff. The Electron smoke test also asserts root edit/reload
controls are present before checking their absence from the read-only child.

Panel runtime composition keeps endpoint resolution/cancellation in
`use-assistant-endpoint-api.ts` and stable attachment/history adapter construction
in `use-assistant-thread-runtime-adapters.ts`. Attachment identity is keyed on
capability presence, so disabling a model's vision support does not discard
already staged attachments. Optional callback props that explicitly accept
undefined pass directly; plan-mode configuration is assembled before transport
selection. These boundaries preserve the existing runtime/transport tests and
remove the reviewed panel/runtime complexity findings without rule suppression.

A child reopened after renderer restart has no live snapshot identity. Its
explicit persisted-decision resolver binds the selected child's thread id to a
native invocation in the decision path and validates owner, root, parent run,
parent call, child run and persona. Same-persona siblings are never interchangeable.
The owning runtime must exist before lookup and remain the same after it; a
runtime disposed during lookup cannot receive the decision. The final native
host admission remains authoritative.

Child pause rediscovery queries the owning root's thread/resource, then projects
only paths whose durable invocation belongs to the selected child. Root-only
and sibling pauses are omitted from that child's view. Missing/conflicting path
bindings surface an explicit discovery error; known transcript content and valid
recovered decisions remain visible. Capability gating reuses the same durable
assistant backend capability as root history. Native restart and full rendered
control parity still require the end-to-end delivery checks.

The workspace's component exports and hooks are separate modules so Fast Refresh
preserves component state: root registry access is in
`use-delegated-conversation-root.ts`; its `useDelegatedPanelBinding` hook supplies
stable capability-shaped callbacks without conditional registration logic in the
main wrapper. Metadata loading is in
`use-delegated-workspace-apps.tsx`; child view and navigation components have their
own files. Metadata cache removal responds directly to the existing selection
store's close/hydrate notification, not a synchronous setState during an effect.
The ordinary root history adapter has its own hook, and the actual wrapper
stream-binding regression has its own discovered test file. Shrink-only wrapper
budgets must ratchet downward after extraction; ESLint warning baselines must
not increase to accommodate these boundaries.

`delegated-child-reload.integration.test.tsx` exercises the actual ChildView and
shared controls against a migrated PGlite database with native-format history,
a persisted graph/invocation, and a registered owning-root append boundary. It
verifies root-scoped discovery, actual approval/question clicks, native target
preservation, and omission of child topology. It also proves live output can
arrive during recovery and that recovery failure leaves saved history visible.
The discovery HTTP response and final root append are test boundaries; native
Mastra execution/restart remains covered separately by the desktop fresh-process
harness. Do not describe these as one full browser-to-native end-to-end test.
Approval and suspension binding lookups run concurrently as independent reads.

The shared assistant action bar reads the public runtime `capabilities.reload`
before rendering regeneration. A child without an `onReload` adapter must not
advertise this action; enabling the composer or a generic `onNew` decision
dispatcher does not authorize regeneration. Copy remains available. The shared
panel tests exercise both supported and unsupported runtimes, and the Electron
workspace restoration verifier checks the actual child control surface.

### Waiting-turn cancellation and native child control (BST-1720)

`POST /assistant/cancel` records cancellation against the owning resource/root/turn
before aborting registered legs. A completed host leg is eligible only while
public native suspended-run discovery still finds one of that turn's root
invocations. Native snapshots remain Mastra-owned; no opaque snapshot is edited
or used as application state. A cancelled original turn rejects a newly created
resume leg in the atomic durable admission statement. Both native attempt legs
check the owner signal again after awaited admission, before invoking resume.
Both server and renderer terminal writers preserve an existing cancelled status.
Repeated cancellation still aborts registered same-turn legs. Acknowledgement
waits for their teardown, then finalizes cancellation even when the normal
terminal write preceded unregister. Completed earlier legs retain their status
unless they are the specifically requested waiting leg.

Discovery preserves real admission states first. A native pending decision with
no admission record in a cancelled turn receives the explicit non-actionable
`cancelled` display state; it does not create a fabricated admission. Shared
cards explain that the turn was cancelled and lock the original decision.
Cancellation is cooperative for work already executing, never rollback.

Proof: native sibling decisions, real HTTP waiting cancellation/reconstructed
host rejection, and admission-cancellation attempt regressions. The provider-shim
Electron scenario uses the actual host, permission engine, workspace and shared
child panel; it does not replace the assistant endpoint. Full question/plan,
process restart and worker acceptance remain distinct gates.

### Child interactive production entry

Custom personas can explicitly declare askUser and submitPlan. Their maps reuse
the parent runtime's canonical resolveSuspendToolsForRun gate, with the complete
durable child-decision capability as the availability condition. This gate is
independent of permission-ask flags: a read-allow self-suspending tool still
requires storage, exact routing, admission and settlement. Default built-in
toolsets, read-only enforcement and parent-owned task lists remain unchanged.

The real Electron interactive verifier uses an isolated workspace persona and
scripted external model transport; questions and plan approve/reject actions
flow through the actual child workspace, reload, native tool resume, child
model result and parent continuation. Existing native grandchild/process-restart
proofs remain separate and are not repeated to prove renderer interaction.

A child plan approval never exits the root's plan mode, including when its
forwarded notice is acted on in the parent panel. The delegated decision keeps
its exact leaf envelope; only a root plan may invoke the root plan-mode exit
callback. Child inspection already shadows that callback with its own context.

## Recursive work admission and cancellation (BST-1722)

The root host owns invocation and output counters in migration 132. Host run,
resource, original turn and complete ancestry are validated inside the admission
transaction. Duplicate native admission does not consume another invocation;
deleting a child never refunds the root's spent allocation. Step reservations
survive database reload. A turn created before budget admission existed cannot
start fresh child inference or admit another sibling: the visible error asks for a new parent turn.
Existing invocation rows without their original budget must never seed fresh counters.

**Admission is answered at delegation START, and a refusal never kills the
root.** SETTLED 2026-09-14 (BST-1751). The durable checks (depth, invocations,
output summary reservation) used to run only inside `persist`, i.e. after Mastra
had started the child; a refusal there threw through the projection's
`authorize` and failed the root with the generic identity message while every
sibling was cancelled (thread-f6be9761). Now `DelegatedBudgetPort.admitInvocation`
(`delegated-tree-admission.ts`, `admitDelegatedInvocation`) evaluates the same
rules before any native child exists — it RESERVES nothing, but it does open
the root and the original turn's budget row idempotently and take the budget
row lock, so a turn whose first delegation is refused keeps an empty budget row
— and `createDelegationConfig` consults it in `onDelegationStart`: a refusal
returns `proceed: false` with the host's reason, which Mastra hands the model as
`[Delegation Rejected] …`. Only the deliberate budget refusals become that
answer; a database or schema fault propagates. A host identity refusal at start
(root not running, stopped ancestor, parent outside this root) is ALSO turned
into a rejection by the hook — nothing has run, so it costs one delegation,
never the root — while the host has already logged its reason; any other
failure propagates. The reservation at persist time remains the authority (the
same checks, now mutating), so a true sibling race can still refuse there — and
that refusal is non-fatal too: it runs inside the child's input processing,
before the child streams a single part, so the parent has nothing to bind and
Mastra turns it into that delegation's tool error (`subagent.failed`, no
`rejected` marker) while the root continues (scenario case "late reservation
at persist"). Two more rules make
any refusal survivable: Mastra streams a refused delegation's text through the
PARENT's writer under the parent's run id, so `resolveChildDelegation`
(`delegated-stream-projection.ts`) treats same-run-id nested output as not a
child stream and binds nothing; and every `DelegatedConversationIdentityError`
that escapes the desktop host is logged at error level with its bounded
`reason` (`delegated_conversation_identity_rejected`, method, host run) before
it propagates, so a debug pack names the refusing rule. The debug pack behind
the ticket showed 8 invocation rows for 8 counted invocations; the three
"missing" rows were admitted-but-never-bound (no child run id), not a counter
mismatch. Paired tests: `delegated-tree-limits.integration.test.ts` ("answers
admission at delegation start", "refuses a fourth descendant level"),
`delegated-conversation-host.integration.test.ts` ("logs the identity reason"),
`delegation-rejection.integration.spec.ts`.

The runtime shares a FIFO queue of two active model/tool operations across all
descendants. Model permits end before native tool/delegation execution; native
delegation waits do not acquire a permit. Up to eight child streams may be
admitted, while only two model/tool operations are runnable. The in-flight
backstop is disabled only when both the durable budget and shared queue exist.
Ordinary and deferred discovered tools
retain their native descriptors, projections, approval flags and guarded execution.
Synthesis forces toolChoice none and no active tools, and rejects a provider tool
call before execution even if the provider ignores that request.

**Child budgets are USER SETTINGS; a cut synthesis is a truncated completion.**
SETTLED 2026-09-15 (budgets plan, Workstream C; GLM pack 03-31-15Z; do not
relitigate). The four per-child allocations live in `RuntimeSubagentSettings`
(`assistant-contract/subagent-settings.ts`; defaults 32 steps / 2,048
synthesis / 32,768 child / 8,192 step; ranges in `SUBAGENT_SETTINGS_LIMITS`),
persisted by `assistant-subagent-preferences.v1`, edited in Settings → Models
→ Subagents (`subagent-settings-section.tsx`), sent on EVERY request as
`runtimeData.subagentSettings` (`buildAssistantRequestData`) and copied into
the turn's `brainstrike_delegation_budgets` row at first admission.
`parseRuntimeSubagentSettings` is the ONLY intake: absent → defaults, anything
else malformed → throws (the desktop host in `mastra-memory.ts` and the agent
runtime in `agent-runtime.ts` both call it). `DELEGATION_LIMITS` has no child
keys — a consumer reading a constant instead of the request's settings is a
compile error — and the admitted-configuration `maxSteps` ceiling is
`SUBAGENT_SETTINGS_LIMITS.maxChildSteps.max`. Read-only built-ins declare 32
steps; the effective budget is `effectiveChildStepBudget(persona, settings)`
and `delegationDescriptionForPersona` tells the model that number.

The host's synthesis reservation (`DelegatedStepReservation` with
`synthesis: true`) names its `cap` (`steps` / `child-output` / `tree-output`)
and the numbers behind it (`used` of `limit`, in that cap's unit). The budget
processor (`delegated-work-budget.ts`) sees Mastra's `finishReason` on
`processOutputStep`; on a synthesis step it records `{ cap, limit, used,
reservedOutputTokens, outputTokens, truncated: finishReason === 'length' }` in
the per-runtime `DelegatedSynthesisOutcomes` registry (keyed by native child
thread id) and streams the transient `data-brainstrike-delegated-synthesis`
part. Three readers, none of which can see the reservation:
`makeTerminalRunEvent` maps a `length` finish on a child whose synthesis was
TRUNCATED to `run.finished` / `outcome: 'truncated'` (a mid-run `length`, a
sibling's record, an untruncated synthesis and the root all still fail);
`onDelegationComplete` reads the REGISTRY (never the projected stream: the hook
runs before the parent consumer maps the child's parts), and
`resolveTruncatedAnswer` appends the `[Truncated summary]` note to `resultText`
— which Mastra applies on the foreground and background delegation paths alike
— and records the outcome, so the parent mapper emits `subagent.finished` with
`outcome: 'truncated'`; the projection turns the part into the persisted
`delegation.budget.exhausted` run event on the child conversation
(assistant-persistence.md, DELEGATION BUDGET EXHAUSTED KIND). Empty text stays
`no-answer` even when a synthesis was truncated. The delegation card reads
`outcome: 'truncated'` as "<persona> finished with a truncated summary" (amber
check, "Completed (truncated summary)"); the child tab header shows `steps N/M ·
used/limit tokens` from the durable child budget row
(`readDelegatedConversationInsights().budget`, refreshed at leg / pause /
terminal boundaries, not per token). Paired tests: `subagent-settings.test.ts`,
`personas.test.ts`, `delegated-persona-snapshots.spec.ts` (admitted ceiling),
`delegated-budget-settings.integration.test.ts`,
`subagent-settings-runtime.spec.ts`, `delegated-work-budget.integration.spec.ts`
("records a truncated synthesis outcome"), `delegated-synthesis-outcome.spec.ts`
(mutations: any recorded synthesis read as truncated; truncation resolved
before the empty-text check; the lifecycle outcome dropped),
`delegated-stream-projection.spec.ts` ("projects a synthesis part"),
`background-worker-policy.integration.spec.ts` ("a child whose synthesis is cut
returns a truncated summary the root can use"; mutation: no truncated terminal
branch), `assistant-ui-panel-wrapper-runtime.test.ts` ("carries the subagent
budget settings"), `delegated-conversation-insights.integration.test.ts`
("reads the child budget"), `delegated-conversation-toolbar.test.tsx`,
`subagent-settings-section.test.tsx`, and the truncated rows in
`subagent-tool-rows.test.ts` and `subagent-execution-card.test.tsx`.

A provider may cap visible text while billing reasoning in addition (BST-1771:
Grok 4.6/OpenRouter reported 1,999 total tokens for a 1,024-token request, including
975 reasoning tokens). Settlement still charges ALL reported tokens and throws
`DelegatedOutputReservationExceededError` only AFTER the transaction commits.
Only a reserved synthesis ending with `length` and no tool calls may retain its
already-produced partial findings after that specific error. It remains visibly
truncated, discloses actual versus reserved tokens to the parent, and cannot
reserve another child step. Working-step overages, tool calls, uncut summaries,
duplicate settlements and persistence failures still reject. This does not claim
an enforceable combined-token cap for that provider or omit reasoning cost.
Paired checks: `delegated-work-budget.integration.spec.ts`,
`background-worker-policy.integration.spec.ts`, `delegated-synthesis-outcome.spec.ts`
and desktop `delegated-budget-settings.integration.test.ts`.

Every child stream creates its own budget processor. A native same-persona sibling
barrier proves two models run concurrently with distinct child reservations and
exactly one settlement per matching reservation. Mastra 1.64 can omit the
processor abortSignal during unwind and does not call user onFinish on abort.
Therefore admission uses the invocation signal supplied by the conversation
binding (which already includes host-leg cancellation), composed with the
processor signal when present, and releases a held permit on abort. Admission
also includes the native executor deadline captured by the delegation hook;
otherwise a timed-out child can enter an unwinding model step and strand a work
permit while a sibling holds the other slot. The desktop deadline regression
starts a replacement after Alpha times out, proves its usage persists while
Beta remains running, and then completes Beta. The selected-Stop controller
remains separate, so a deadline stays failed/timed_out rather than cancelled.
Without a bound invocation it uses the host-leg signal. A native cancelled task alone does
not prove this release: the desktop regression "releases a stopped model permit
while Beta streams and Gamma completes" holds both model permits, stops Alpha,
and proves queued Gamma completes while Beta remains running. Using only the
host-leg signal strands Alpha's permit when native unwind omits its signal. The existing
native completion join still owns draining; no timeout or detached executor is
introduced. Cancellation is the existing subagent.failed event with cancelled
status, not a new event kind. The native recursive-worker integration checks
three-level Stop both during provider construction and after visible leaf text,
with no post-Stop reservation and no workspace effect.

Grandchild navigation before completion resolves the exact persisted invocation
from its subagent event's parent runtime/run-tool identity, within the selected
child's authorized root and parent thread. The card reads its owning message,
never a call-ID-only scan across turns; providers may reuse call IDs. Conflicting
addresses produce a local navigation error without unmounting the conversation.
The shared runtime DOM proof opens both same-ID calls to their respective runs.
Host child-event attribution must
not overwrite a nested subagent event's own parentToolCallId or personaId.
Nested events retain that identity and carry their owning conversation edge in
`delegatedConversationIdentity`; ordinary child run/tool events retain the
existing ownership metadata. Real PGlite and Electron tests cover publication,
nested card navigation, leaf approval reload, one workspace effect and parent
result propagation.

Native completion success=false is captured by parent native run and tool-call
identity, separately from no-answer. Mastra's projected delegation result can
omit finishReason even after a provider failure; the mapper must use that
authoritative hook outcome rather than label the tool-result completed. Child
mapper states share the outcome capture while retaining independent lifecycle
state. Failure produces a compact explicit parent explanation and a failed
subagent event; other ancestors may still complete after handling it.

Delegation cards resolve durable names and colors through the owning workspace repository, validating the actual parent rather than persona identity. Task text comes from the delegation tool input. Missing or contradictory authorized identity remains a visible local error; generic role labels before an address arrives are not fabricated child names.

A child-open request made before the workspace repository is available fails visibly and clears its session intent. Boot hydration still restores the saved root, but cannot replay that rejected child-open request; the user may explicitly open the child after storage is ready. The shared coordinator test covers this boundary.

### Background worker execution and pending controls (BST-1723)

Desktop run-scoped memory supplies `backgroundTaskScope` through assistant-service
to the native agent runtime. Persona delegation defaults to nonblocking native
background execution when that capability exists; the native `_background`
argument retains foreground selection. Recursive descendants retain their native
foreground execution inside the background child and use the same durable limits.
A parent can emit useful text while a child works or waits for a decision. Live
child content and exact approval controls use the existing rich conversation view.
`projectBackgroundStream` (`background-stream.ts`) folds the native task events
into the host stream: a `background-task-output` carries either a child envelope
(`tool-output`, `data-user-message`, the delegated usage part) or a RAW `data-*`
chunk — Mastra's `ToolStream.custom()` writes data parts without the envelope in
the foreground too — and both are forwarded unchanged; only a non-data,
non-envelope chunk is a contract break. SETTLED 2026-09-13: a background
Explorer child's `data-om-buffering-start` hit the old allowlist, failed the root
run and cancelled all four children. Paired test: `background-stream.spec.ts`.
A forwarded `data-*` part keeps the CHILD's `runId`; consumers must attribute it
by that id, never by its position in the host stream (the projection no longer
tells child-origin data parts from the parent's). The delegated usage part is
itself `data-*` and was always allowlisted, so its accounting is unchanged.
SETTLED 2026-09-15, ONE DELIVERY PER BACKGROUND CALL (do not relitigate):
while the turn that dispatched a background call is still open, Mastra's
background executor delivered every child output and pause TWICE. Its
`outputWriter` published the chunk as the task's output (`task.output` →
`background-task-output`) and then wrote it through the dispatching step's own
writer (a raw `tool-output` envelope on that turn); its `suspend` calls the
step's `suspend` (a parent-level `tool-call-approval` / `tool-call-suspended`
for the delegation call, on that turn) before parking the task (`@mastra/core`
1.64, the background branch of the tool-call step in `agent-DsRUDsS_.js`;
unchanged in 1.67.0, whose own `streamUntilIdle` merges both channels too).
Live GLM run 19 (2026-09-15, a slow root first turn with parallel reads)
projected both: every child view carried each frame twice, and the root thread
showed eight cards for four decisions — four synthesized when the tasks parked,
four native copies published when the leg ended at the root's canvas pause
(`withRootPauseNotices` dedupes only within one publish). The TASK is the
delivery: its copy exists for the call's whole life, the turn's only until that
turn closes, and every leg with a background manager is idle-loop wrapped
(`driveBackgroundWork`, the resume stream), so the task channel is always read.
OUTPUTS are single at the source: a child's raw `data-*` part
(observational-memory markers, the delegated usage part, the synthesis
breadcrumb) reaches the executor through the subagent tool's `writer.custom()`
with no call identity, so no host filter can tell its turn copy from the root's
own data parts, and that turn copy also ran the ROOT's data-part pipeline,
which stored a non-transient child part in the root's own message.
`patches/@mastra__core@1.64.0.patch` therefore makes the executor's
`outputWriter` publish to the task only, and `projectBackgroundStream` throws on
a background call's `tool-output` on its dispatching turn (the patch no longer
applies). The task output is now the only copy, so the background manager's
`progressThrottleMs` must stay unset: a throttled chunk would be lost. PAUSES:
`projectBackgroundStream` drops a turn's `tool-call-approval` /
`tool-call-suspended` for a call known as background (`background-task-started`
/ `-running`), logging `background_turn_copy_dropped` once per call. It throws
if a turn copy was forwarded BEFORE the turn acknowledged that call's dispatch
(Mastra enqueues the acknowledgement first; a violation would silently project
the task's copy again). A resume leg's host executor (`registerResumedExecutor`)
writes only to its own stream and publishes no task output, so resumed children
are untouched. Paired: `mastra-background-contract.integration.spec.ts`
("delivers a background child's raw data part once while the dispatching parent
turn is still open"; RED unpatched: the part arrived as task AND turn, and one
copy was stored in the parent thread), `background-stream.spec.ts` ("one
delivery per background call": removing the output contract break, exempting
pauses from the drop, or dropping the order guard each fails only its own rows)
and `background-worker-policy.integration.spec.ts` ("reaches each view ONCE
while the dispatching root turn is still open", fixture `slowRootTurn`; RED
before the drop: four root cards for two decisions and every child frame twice).
A root that answers instantly closes its turn before any child output exists,
which is why the fixture never delivered this shape.
The model may also request `_background.maxRetries` (Mastra's own system prompt
advertises it, its resolver honours the model's value ahead of the host default,
and no host knob removes the advertisement). SETTLED 2026-09-14 (BST-1749): the
HOST owns the retry policy — none, ever — so `PgliteBackgroundTasksStore.createTask()`
pins a scoped task's model-requested retries to 0 and logs
`background_task_retries_pinned`; the delegation dispatches. This is host
authority over an execution knob, not a fallback: rejecting the value failed all
four specialists of the "spin up 4 subagents" prompt on every turn the model
followed Mastra's guidance, and the model then reissued them as FOREGROUND
delegations (thread-af25a110, 2026-09-14). `updateTask` still rejects a non-zero
retry count — no host path may re-arm retries on an existing task. The root's
delegation instruction also states that subagents run as background workers and
that `_background` is host-owned (`buildDelegationInstruction`,
`backgroundDelegation`). Pinned by `pglite-background-store.integration.spec.ts`
(create pins, update rejects) and `background-worker-stream.integration.spec.ts`
("dispatches a delegation whose _background carries the retries knob").
A background child's SUSPENSION closes the parent stream for that iteration with
no finish part. SETTLED 2026-09-14: the leg that observes it ends as a PAUSE.
The initial leg's root output reports `suspended`; the resume leg
(`createBackgroundResumeStream`) exposes the same synchronous `status` and
reports `suspended` when the resumed task parks on a NEW decision, so
`readNativeStreamStatus` ends the leg with a `tool-calls` finish and the withheld
child notice publishes. Reading that close as a missing finish produced
"Assistant stream ended without a normal stop signal" on every second approval
of a background child (thread-8d471973). Paired:
`background-worker-policy.integration.spec.ts` ("pauses again on its resumed
leg").
SETTLED 2026-09-14 (do not relitigate): the parent model is NEVER woken by a
child's suspension. Mastra's own `untilIdle` loop counts
`background-task-suspended` as a terminal and runs a parent continuation whose
ephemeral directive reads "Do not attempt to resume them; let the user know they
are waiting for explicit resume input" — the root parroted that line for every
suspended specialist and refused to compile its report (thread-1dab3290), and no
system-prompt wording beats a later user-role directive. The host therefore does
not pass `untilIdle`; every parent inference (initial, approval, resume, native
wake and the child-resume continuation) passes `_skipBgTaskWait` and is wrapped
by `withBackgroundIdleLoop` (`background-idle-loop.ts`), which mirrors Mastra's
loop except that only a returned, failed or cancelled task queues a wakeup
(`describeBackgroundWakeup` in `background-ledger.ts` is the host's directive
— see WAKEUP LEDGER below). A suspension is a
host-surfaced approval prompt, exactly as Claude Code surfaces a subagent's
permission prompt in the main session; the model is not the messenger. Silence
from running work past `backgroundIdleMs` (default: the longest a task may run)
closes the stream unfinished and the projection reports it. Paired:
`background-worker-policy.integration.spec.ts` ("wakes no parent turn"; mutating
the wakeup guard to include suspensions fails it) and the idle-expiry case in
`background-worker-stream.integration.spec.ts`.
SETTLED 2026-09-15, WAKEUP LEDGER (do not relitigate): a parent wakeup is
the whole LEDGER of this turn's background invocations, not one line per
event. The GLM root (thread-debug pack 2026-09-15T03-31-15Z) received
"Background invocation X has returned" four times over four continuations,
mis-counted, and ended "waiting on the remaining subagents" after all four
had finished. The ledger is read from the DURABLE task rows
(`manager.listTasks` in the thread scope, filtered to the GENERATION's native
runs — `background-ledger.ts`, `createBackgroundLedgerSource`; AMENDED
2026-09-15 by owner ruling, BST-1749/PR #3198 review item 5, from "the parent
run ids the leg observed on its lifecycle events", which gave every leg of one
turn its own ledger identity and made a resume leg count only the run it
resumed. The scope is now the runs the host mapped to this generation
(migration 140, `readBackgroundGeneration`) UNION the runs the leg observed
itself, which covers a run whose first task has only just been dispatched),
never from the loop's `running`/`settled`
sets alone, and lists every invocation as returned (persona, the first 120
chars of its prompt, "use its saved outcome"), failed (with the recorded
reason; a timeout reads "timed out"), cancelled, or still running. When
nothing is still running it says so in one sentence — "All N background
invocations have finished. Nothing is still running. Continue with the task
using the saved outcomes." — and only then. A SUSPENDED task is "still
running" to the ledger: the pause is the host's card, the model is never
its messenger (the 2026-09-14 ruling above stands). The idle loop
(`runContinuation`), the resume stream's parent wakeup and the parked-root
deferral all read the same source. The same ledger reaches the USER as the
`delegation.ledger` run event (assistant-persistence.md, DELEGATION LEDGER
KIND): one live row in the root thread — "3 of 4 specialists returned · 1
running" — published on every task lifecycle change, joined before the leg
closes so the final row is never lost (`settle` waits on
`publisher.inFlight`; the parked-parent close is where that join is
load-bearing, since no continuation keeps the leg open), persisted like
every run event. Because the wakeup QUOTES each child's prompt, a scripted
harness must tell the root's wakeup apart by its header ("Background
invocations of this turn") before it uses prompt text to pick a child.
ACTIVE PARENT STEPS (BST-1771, 2026-09-17): the idle loop queues terminal
wakeups while a parent turn is streaming. A UI ledger reaching zero running
therefore did not mean that an active parent model saw that update. Root stream
options now refresh the same generation-scoped ledger and compact saved terminal
outcomes before each input step, including inside a continuation. One owned
native `context` message is replaced before the input token limiter; it remains
user-role tool data, is not drained into durable user/response history, and does
not start another inference. Child-runtime legs do not install this processor.
Suspended tasks remain running and refused delegations remain excluded. The
generation port was already mandatory for background wakeups; missing bindings
now fail before inference. Durable read failures propagate rather than letting
the root publish from a known-stale completion ledger (no silent degradation).
A provider-boundary observer records only terminal notices retained verbatim
after input processing. The idle loop drops their queued wakeups only after the
active native turn succeeds, avoiding a second report-producing inference.
Failed, aborted, unknown-status or parked turns retain pending delivery; an
altered/trimmed notice is conservatively unacknowledged. Transcript
reconciliation is unchanged.
Paired: `active-parent-background-results.integration.spec.ts`
holds the original parent or a later native continuation open, completes the
last child, and checks the next model request and absence of a persisted context
message; `active-background-results-processor.spec.ts` pins replacement, scope,
terminal states, suspension, authority and read failure. The idle-loop test
`keeps a presented outcome queued when the parent request fails` pins the
acknowledgement/response-failure boundary.
An approval for work parked before migration 140 can lack the durable native
run mapping required to name this generation. Approval preparation validates
that mapping before recording any policy-granted sibling answers or starting a
native resume. The typed refusal releases a delegated user's claim, leaves all
parked work unchanged, and tells the user to Stop or cancel the pending work,
then start a new request through both live-decision and cold approval transports.
A root-own pause validates before recording late-result wakeups or invoking its
native resume. A new user request safely mints its own generation; the host
never guesses an old generation or automatically replays unknown effects.
Paired: `background-ledger.spec.ts` (mutations: the closing sentence while
something runs; omitting it when nothing runs), `background-idle-loop.spec.ts`
("carrying the durable ledger", "publishes a delegation.ledger row …",
"a parked parent leg publishes the final ledger row before it closes" —
mutation: dropping the join from `settle`), and the harness row "the wakeup
carries the whole ledger: a root that trusts it reports the final outcome
exactly once nothing is still running" (`fanout.rootReadsLedger`; the
scripted root answers from the LAST user message, never its own count).
SETTLED 2026-09-15, REJECTED ADMISSION IS NO INVOCATION (do not relitigate): a
delegation refused at start (BST-1751: unknown persona, a per-leg backstop, or
the host's durable budget) is never returned background work. Mastra 1.64 runs
`onDelegationStart` INSIDE the background task it has already created
(`createBackgroundTask` → `enqueue` → `storage.createTask`, then the task's
executor calls the tool), so a refusal still writes a task row that completes
normally with `[Delegation Rejected] …` as its result. The idle loop used to
queue that terminal as a parent wakeup and the ledger counted the row
`returned`: `delegated-worker-write.desktop.test.ts`, its scripted parent broken
to delegate on every turn, reached "1160 total: 1160 returned" and 2337 parent
model calls in ~90 s. Nothing in the host bounded it — a refused task completes
at once, so idle expiry never applies. Now the leg's `DelegationOutcomeCapture`
(the authority the mapper already reads for `outcome = 'rejected'`) reaches
`withBackgroundIdleLoop` and `createBackgroundLedgerSource` as
`rejectedDelegations`; `driveBackgroundWork` and `createBackgroundResumeStream`
pass their leg's capture, and the key is required on both the ledger source and
the loop so neither can forget it. The refused terminal wakes nothing, and the
row is no ledger entry (no child ran; admission reserved nothing). The model
still reads the refusal as that call's saved result and the user still sees the
`Rejected` card, so a refusal that lands while nothing else runs closes the leg
without a parent turn. The loop's bound is explicit: once more distinct
background tasks wake the parent in one leg than one original root turn may
admit invocations (`DELEGATION_LIMITS.maxInvocations`, the host's tree limit
for that turn, resumes and descendants included), the leg FAILS with
"Background work woke the parent for N invocations; one turn admits at most
<maxInvocations>, so the leg stops instead of waking the parent again" and logs
`background_parent_wakeup_limit_exceeded` (the tripping invocation and every
woken task id) — never a silent close. The bound counts background tasks, which
equal delegations only because persona delegations are the sole
background-eligible tools: `buildBackgroundAgentOptions` (`agent-runtime.ts`)
lists persona ids alone and no tool sets its own `backgroundConfig`. A new
background-capable tool must revisit this bound. A task wakes a leg at most
once, so the bound trips only when more work woke the parent than the turn's
admission allows. The capture is leg-scoped and in memory (Mastra writes no
durable rejection marker on the row), so the LEDGER also asks the host's
invocation graph — the durable record. A refusal persists no invocation (start
admission reserves nothing and `persist` never runs), so a `completed` row whose
dispatch address `resolveParkedInvocation` answers `undefined` for ("that
address delegated nothing") was refused, whichever leg dispatched it. That
closes the case the capture cannot see: a resume leg reads the rows of the run
it resumes, and a refusal dispatched in the same parent step as a parked sibling
used to read `returned` there — two admitted siblings and one refusal gave "3
total: 2 returned, 0 failed, 0 cancelled, 1 still running" once one sibling
resumed, so the resumed parent was told a specialist returned when none ran.
`createBackgroundLedgerSource` takes `resolveInvocation` as a required key
beside `rejectedDelegations`; `driveBackgroundWork` and `createResumeLedger` pass
the binding's member. Only a `completed` row asks: a child still starting has
not persisted its invocation yet, and a refusal always completes. That ordering
is guaranteed, not assumed — the child's `inputProcessor` AWAITS `persist`
before the child streams a part, and Mastra writes a task's `completed` status
together with its executor result — so a completed row's answer is settled and
the leg remembers it, with overlapping reads (the loop publishes a row per
lifecycle event) sharing one pending answer. A host that CANNOT answer fails
the read: no row is published (`background_ledger_read_failed`) and the wakeup
fails loudly, because answering "not refused" would count a refusal as returned
— the defect the graph exists to answer. That failure is not remembered, so the
next read asks again. The same persona-only
eligibility makes every row a delegation the graph can answer for; a new
background-capable tool must revisit this too. Without a host the key is
undefined and the capture answers alone: no other leg can read those rows,
because every delegated decision needs `resolveToolAction`. Reading `undefined`
as "refused" makes DURABILITY part of the binding contract, stated on
`resolveParkedInvocation`: an invocation, once persisted, must stay resolvable
from its dispatch address for the life of the parent thread. No code prunes
`brainstrike_delegated_invocations` today; a host that added pruning would not
answer late — the ledger would quietly stop counting a child that ran, the
mirror of the defect above and a silent one. Never sniff the
`[Delegation Rejected]` result text — a child can echo it. Paired:
`background-rejected-delegation.integration.spec.ts` (nine task rows, eight
wakeups, 18 root prompts, "8 of 8 specialists returned"; RED: 20 rows and 20
wakeups until the script stopped; and "a resume leg leaves a sibling refused in
the same parent run out of its ledger": "2 total: 1 returned, 0 failed, 0
cancelled, 1 still running" and "1 of 2 specialists returned · 1 running"),
`background-idle-loop.spec.ts` ("a delegation rejected at start wakes no parent
turn and is no ledger entry", "fails the leg loudly once more invocations wake
the parent than one turn may admit"), `background-ledger.spec.ts` ("leaves out a
delegation rejected at start", "leaves out a completed delegation the host holds
no invocation for, whichever leg dispatched it" — mutations: ignoring the host's
answer; asking about a row that has not completed — plus "asks the host once per
completed row", "asks once even when two reads overlap", "fails the read when the
host cannot answer, and asks again on the next read" and "reads the leg capture
before the host"), and the desktop host's "resolves a parked invocation from its
dispatch address without a leaf identity" (an address that delegated nothing
answers `undefined`). A scripted harness root that must delegate on every turn
uses `fanout.rootRedelegates`.
SETTLED 2026-09-14 (do not relitigate): EVERY parked leaf decision has a card in
the ROOT thread. A foreground child's pause suspends the parent run on the
delegation call, so Mastra's parent-level pause becomes that card once
`decorate()` addresses it to the leaf. A BACKGROUND child's pause parks a task
and suspends nothing in the parent run (the parent-level copy Mastra writes on a
still-open dispatching turn is dropped, ONE DELIVERY PER BACKGROUND CALL above),
so the root stream carries only the child envelope and the root thread showed NO
card while four specialists sat parked (thread-b629776b):
`withRootPauseNotices` (`root-pause-notices.ts`) runs at
every publish of the withheld notices and synthesizes, for each child-scoped
notice whose leaf identity has no root-level notice, a root card addressed to
the ROOT edge (`path[0]`, the transport target every resume already uses) with
the leaf tool, args and risk metadata, preceded by the durable
`tool.approval.requested` row for the delegation call; a foreground pause
already carries the root notice and gets no duplicate. Paired:
`root-pause-notices.spec.ts` and the root-notice assertions in
`background-worker-policy.integration.spec.ts` (RED before the seam: zero root
notices for a background child; "reaches each view ONCE" pins exactly one root
card per decision while the dispatching turn is still open). The card names the child (persona label + the
delegation prompt), and a
session grant answers every parked BACKGROUND sibling in the same approval leg
(`claimGrantedBackgroundResumes` → `createBackgroundResumeStream` with N
resumes and ONE parent wakeup; `tool-approval-answered` locks the sibling
cards; siblings are recorded as policy answers, never as a second ledger claim).
Full contract in `assistant-runtime.md` (PERMISSION ENGINE, "PARKED
SIBLINGS"). MULTI-APPROVAL MATRIX (2026-09-14), every row proven through the
REAL desktop host, ledger and background store in
`apps/desktop/.../delegated-sibling-grant.integration.test.ts` unless noted:
- N children parked → N root cards, no tool ran before a decision.
- "Allow reads this session" on one card → every sibling parked on a read tool
  answered by policy in the same leg (`consumed`, no second claim), one parent
  wakeup, `Parent: ALL-FLAGS`.
- One-shot Approve → only that card; the next one-shot completes the turn.
- Decline one, grant on the other → the declined tool never runs; the grant
  finds nothing else parked.
- "Always allow <tool>" → siblings parked on THAT tool answered; a sibling
  parked on a different ask tool stays parked until its own decision.
- Reload → rediscovered root cards carry the same identity; a grant from a
  rediscovered card answers the sibling.
- WORKER writes (`mode: 'worker'`, `edit: ask`): both children park on the
  edit with `riskCategory: 'edit'` root cards; "Allow edits this session" on
  one answers the sibling; declining one never runs its write; a READ grant on
  the other answers no write (categories never cross).
- Mixed kinds (agent `background-worker-policy.integration.spec.ts`): a read
  grant never answers a sibling parked on a QUESTION.
- Harness landmine: a scripted model must tell root from child by the LAST
  user message ("find flag N" vs the task / a wakeup). Tool presence fails
  (workers hold a delegation tool and fanned out again, nesting threads) and
  a whole-prompt marker fails (the child receives the root's delegated
  context).
- LIVE decision rows (desktop `delegated-sibling-grant.integration.test.ts`):
  a decision delivered while a sibling still works resumes the parked child
  INSIDE the running leg (one leg, `reason: 'user'` answer chunk, ledger row
  consumed, turn completes); a live "Allow reads this session" answers the
  parked sibling AND a child that parks afterwards under the remembered grant
  (`reason: 'session-grant'`); a decision after the leg settled is
  `'no-live-run'` and changes nothing. Agent-level
  (`background-worker-policy.integration.spec.ts`): a live one-shot approve
  resumes the child in the same leg and its NEXT gated read parks that same
  task again with a fresh root card (the loop forgets a resumed task's earlier
  terminal — a mutation that keeps it dedupes the second pause away).
- Decisions during a run (assistant-ui, `decision-dispatch.ts`): while the
  thread runs, the decision is delivered INTO the run through the host's live
  transport (`LiveDecisionProvider`, desktop `POST /assistant/decide`); when
  no leg is live for it (404: settled, or not a parked background child) or
  the host has no transport (web) it queues, dispatched one per run end; a
  queued decision the host meanwhile answered is dropped at dispatch with a
  log line (`dequeueDispatchable`), never sent stale. The card locks for the
  round trip; a host refusal (409) unlocks it with a warning.
- Presentation (assistant-ui, settled 2026-09-15): N parked children of one
  category → ONE full root card and N−1 rows behind it; a grant collapses
  every answered card into a row ("Allowed by session grant") and promotes
  the next pending card of another category; a grandchild's card indents
  under its ancestor with the ancestor's rail. Contract and tests in
  `assistant-runtime.md` (PERMISSION ENGINE, SWARM-AWARE PRESENTATION).
- Child views (assistant-ui + app-shell, settled 2026-09-15): a child tab
  renders its own copy of a leaf approval, but the host answers it on the
  ROOT leg only, so the child reads its owning root's answers by identity
  and shows the same answered row ("Allowed by session grant" / "Approved");
  a genuinely pending child card stays actionable. Contract and tests in
  `assistant-runtime.md` (PERMISSION ENGINE, CHILD VIEWS READ THE ROOT'S
  ANSWERS).
SETTLED 2026-09-14 (canonical, after reading Claude Code v2.1.186+, Codex and
Cursor behaviour): a BACKGROUND child's pause publishes LIVE — its scoped
notice and the synthesized root card leave the leg the moment its TASK is
durably parked: the child's pause chunk streams before the task's storage row
is suspended, so the notice is parked (`withholdPauseNotices` → `parked`) and
released by the native `background-task-suspended` part
(`releaseParkedNotices`; `projectBackgroundStream` now forwards that part). A
decision delivered in the window before the row is suspended would find
nothing to resume ("stale or ambiguous") — the card must not exist before
its decision can be applied. Only a FOREGROUND pause (the parent run itself
suspended) is withheld to the completion join. thread-4f14436f held three
cards for 77 s until the slowest sibling returned. Paired:
`withhold-pause-notices.spec.ts` ("for background children") and the desktop
row "a parked child's root card publishes while a sibling is still working".
The child store also coalesces streaming notifications to one per 16 ms window
(`delegated-conversation-store.ts`): per-frame notification re-converted every
mounted child view per frame and stalled the renderer once a few tabs were
open.
SETTLED 2026-09-14, LIVE DECISIONS (do not relitigate): a decision reaches the
RUNNING leg, as Claude Code answers a subagent's permission prompt inside the
live session. Seam: `live-decision-channel.ts` (one channel per runtime,
`runtime.liveDecisions`; the background phase driving the stream — the idle
loop or the resume stream's terminal wait — owns it and hands out
RESERVATIONS that keep the phase from settling until the reserved tasks are
resumed or released — COUNTED per reservation, because two deliveries can name
the same suspended row (one as a user's own answer, one as a granted sibling of
another's) and each must be able to give its own hold back: when only the first
holder could, a failed decision releasing after another had resumed that row
dropped a RUNNING task from the wait and the leg ended with its terminal
missing from the map the pause branch reads); `live-decisions.ts` `armLiveDecisions` (every leg arms
it: validates against the live native snapshot exactly as a click would,
validates the parked siblings the request's FRESH snapshot allows via
`allowedBySnapshot` the same way, records the answer and theirs with the host
as consumed in ONE all-or-none write (`recordToolActionAnswers`: a refused
answer records nothing, so the user's pause stays answerable; a sibling whose
leaf a durable decision already answered is SKIPPED by discovery rather than
refusing the leg; BST-1749 and PR #3209 reviews) — never the root's single
active claim, the leg may hold that already — publishes the
`tool-approval-answered` chunks on the leg's own stream, resumes in-process
through `manager.resume`, and REMEMBERS a lasting grant so every ask tool's
live flag lets each later call the grant allows run without parking (SESSION
GRANT STOPS ASKING, below)); desktop `delegated-execution-controls.ts`
(`registerDesktopDelegatedDecision` keyed by the steerable host run id,
`deliverDesktopDelegatedDecision` → `'no-live-run'` on
`LiveDecisionUnavailableError`) and `decide-endpoint.ts` (400 shape / 404 no
live run / 409 host refusal with reason / 500 resume failure; the renderer's
policy request is resolved into the TRUSTED snapshot exactly as a stream
request's). Two in-process facts a fresh resume leg never met: the delegation
config's per-leg caps count a RESUMED address once (`admitted` set — the
resume of a parked child was refused as a third concurrent subagent), and the
delegated projection REOPENS a child that finished on a pause when its
continuation re-enters (`parked`; a completed child's late parts stay
dropped). The parent still wakes only on returned/failed/cancelled work; the
idle loop keeps closing when nothing runs, so a decision on an all-parked turn
takes the ordinary new-leg path (404 → queue/append).
SETTLED 2026-09-15, SESSION GRANT STOPS ASKING (do not relitigate): after a
live "Allow <category> this session" the next gated call of EVERY child in
the leg simply runs — no suspension, no card, no resume. The remembered
grant used to answer each later pause after the fact (park → card →
auto-answer → resume): 70 cards and 70 resumes for reads the user had
allowed (GLM run, thread-debug pack 2026-09-15T03-31-15Z). Mechanism: the
permission gate no longer clones an ask tool with a STATIC
`requireApproval: true` (Mastra copies that boolean once per stream call,
`agent-DsRUDsS_.js:34955` → `utils-C9npriyv.js:682-709`, so nothing could
lift it mid-stream). `applyLiveApprovalGate` (`approval-gate.ts`) clones each
kept ask tool with the PUBLIC FUNCTION form of the per-tool flag
(`dist/tools/types.d.ts:551`); `CoreToolBuilder.build()` turns it into
`requireApproval: true` + `needsApprovalFn` (`utils-C9npriyv.js:684-686`) and
Mastra evaluates `needsApprovalFn` on EVERY tool call
(`agent-DsRUDsS_.js:26437-26444`, overriding both the run-wide gate and the
boolean). The function forwards to the runtime's single decision point,
`createApprovalGate` — the agent's OWN ask set (the root's in
`resolveGatedToolMap`, each child's re-gated set in `buildPersonaSubAgents`,
grandchildren re-gate the raw child map) AND `runtime.liveDecisions.remembered`,
read per call — so a mid-stream child is lifted on its very next call. NO
run-wide `requireToolApproval` predicate is ever synthesized: any truthy
run-wide gate forces Mastra to run every step with concurrency 1
(`agent-DsRUDsS_.js:24054`, `toolCallConcurrency` ignored), which would have
serialized foreground fan-out and the root's parallel reads under the default
posture (proven by the fanout harness: HEAD parks four foreground children in
leg 0, a run-wide predicate parks one). The converted boolean is `true`,
exactly the old static clone, so per-step concurrency classification is
unchanged. `live-decisions.ts` remembers the grant once the host has recorded
the user's decision and BEFORE the in-process resume (`remember` strictly
precedes every `manager.resume` the decision issues), so the resumed child's
next call already sees it; `suspended` still answers a pause the flag did not
lift. Persisted "Always allow" policies work through the same flag (the
rebuilt leg's snapshot resolves the tool to allow → not in the ask set → no
clone). Paired: `approval-gate.spec.ts` (mutation: ignoring `remembered`
fails "lifts the gate for every tool a remembered session grant allows"; a
clone captured at clone time fails "the clone reads the gate on EVERY call"),
`build-persona-subagents-approval-gate.spec.ts` ("child approval gate": the
converted child tool carries `requireApproval: true` + `needsApprovalFn`,
lifted by `channel.remember`, and `defaultOptions.requireToolApproval` is
undefined), `root-live-approval-gate.integration.spec.ts` (the ROOT's executed
map: every `runtime.askTools` id carries the function form — eager ids as
converted `requireApproval: true` + `needsApprovalFn`, deferred ids as loaded
through `toolSearchProcessor` — and an ask-gated Anthropic web search stays the
Tavily clone; mutations: dropping the root `applyLiveApprovalGate` call,
settlement not copying descriptors, or the web-search swap ignoring `askTools`
fail it), `background-worker-policy.integration.spec.ts` ("after a live
session grant the sibling's NEXT gated read runs without a pause": exactly one
root card for the leg, `effect` called for every read — mutation:
`needsApprovalFn` → `() => true` fails it; "a live session grant is remembered
BEFORE the parked child is resumed": call order `['remember',
'resume:remembered']` — mutation: remembering after the resume records
`['resume:forgotten', 'remember']`), and the desktop rows "a live 'Allow
reads this session' answers the parked sibling, and a child that reads
afterwards never parks" and "a live session grant during an approval leg: one
claimed decision, zero further policy rows" (mutation: a gate that never lifts
adds `delegate-1` to both rows' cards). Verifier: `e2e-subagents.mjs` verdict
`cardsAfterGrant` must be 0.
SETTLED 2026-09-14, PAUSE TERMINAL (proven by the live-app verifier, do not
relitigate): a background child's pause FINISH (`message-finish`,
`tool-calls`) is the child view's TERMINAL frame — the renderer's
`delegated-conversation-receiver` closes the child on it and throws
"Delegated conversation emitted frames after its terminal" on any later
frame, which tears the whole root stream down; the host then records the run
finished and every child dies with `delegation-root-not-running`
(thread-834924c1: pause at :16, live resume at :23, resumed frames at :26,
client abort at :26.4). A parked child is not finished, so the pause finish
is never published with the card: `releaseParkedNotices` HOLDS it in the
leg's held notices (published at the leg's end for a child still parked) and
`dropHeldPauseFinish` discards it when the native `background-task-resumed`
part arrives (`projectBackgroundStream` now forwards suspended AND resumed
parts). Paired: desktop row "a live-resumed child's frames never follow a
terminal" (mutation: publishing the finish with the card fails it) and
`withhold-pause-notices.spec.ts`.
SETTLED 2026-09-15, REPEATED SUSPENSIONS (live-app verifier run 5): one
suspension of a background task reaches the host loop more than once (the
manager's lifecycle event, the parent turn's own copy, a replay around the
resume), while a task resumed in-process legitimately suspends AGAIN later.
Treating the repeat as a new pause emptied the idle loop's running set while
the child still worked; the loop closed, `projectBackgroundStream` failed the
leg ("Background stream ended with unfinished child work"), the run row read
`failed` and the renderer never received that child's terminal ("Parent
stream ended before a delegated conversation terminal", root message
"Failed"). `createSuspensionLedger` keys every suspension by Mastra's
`suspendedAt` stamp: a repeat of the stamp already handled for that task is
the same pause and is dropped; a new stamp is a new pause. Applied in the
idle loop and the resume stream's terminal wait. Paired:
`background-idle-loop.spec.ts` (mutation: no dedupe closes the loop early).
SETTLED 2026-09-15, PARKED PARENT (live-app verifier run 6, do not
relitigate): a parent turn that ends on the PARENT's own pause (native status
`suspended`) parks the run on the user and NO wakeup ever runs a continuation
on it. The root paused on its canvas write with one child's wakeup still
queued; the host loop ran that wakeup as a fresh `agent.stream` on top of the
parked run, the root proposed the write AGAIN, and the thread carried two
canvas cards — the first orphaned for good (its run superseded), and the
verifier's two clicks 130 ms apart cancelled one leg (assistant-ui `append`
cancels an in-flight run before `isRunning` flips). `withBackgroundIdleLoop`
reads each piped turn's status: parked + children running keeps the leg open
until they return (their frames stay in this leg, their results are saved by
Mastra's native `onResult`); parked + nothing running closes the leg as the
pause it is, dropping queued wakeups with an info log
(`background_parked_parent_wakeups_deferred`). Paired:
`background-idle-loop.spec.ts` (mutation: continuing on a parked turn runs
`agent.stream`) and the policy harness row "the root's own pause ends the
leg once its children return" (`fanout.rootGate`; before the fix it recorded
`['root-write', 'root-write']`).
SETTLED 2026-09-15, LATE RESULTS AFTER A ROOT PAUSE (live-app verifier run
7, do not relitigate): the root pre-created its canvas 25 s in, before any
specialist returned; after every specialist had returned it approved that
write and reported from its OWN inspection while telling the user it was
"still waiting on the four analyses". Mastra's `approveToolCall`/
`resumeStream` restore the message list snapshotted at the pause, in which
every child still running at that moment is a dispatch acknowledgement; the
restored list also replaces any `context` the resume is given, so no message
reaches the resumed model. Three host rules close it. (1) The late results
are exactly the finished tasks THIS run dispatched (`task.runId`) whose
`completedAt` is not before the run's `AgentRun.suspendedAt`
(`listLateBackgroundResults`). (2) A ROOT-level approval/typed resume
overlays them onto the acknowledgement tool results at the provider
boundary on every request of the resumed run
(`late-background-results-processor.ts`, first in the leg's per-call
processors so the stale-history filter and the limiter judge the real
results). This overlay uses the same text-only projection stored beside the raw
durable child result. The PGlite message commit boundary also overlays terminal
task rows on every native save, and task-only completion/repair reads current
parent snapshots inside its transaction, so neither resumed nor callback saves
can restore stale acknowledgements or erase newer parent content. The leg still
restores late outcomes once it settles (`restoreLateBackgroundResults`, in the leg's
`settleNativeStream`). (3) A child card answered on a NEW leg while the root
is parked resumes the child only: the resume stream's `parentWakeups` finds
a suspended run in scope and ends the leg as a pause
(`background_parent_parked_wakeup_deferred`) — a fresh parent inference
would propose the root's pending call again. Paired:
`background-late-results.integration.spec.ts` (both rows: the resumed root
reports `PARENT_FINAL_OUTCOME` from the overlay and memory holds the result
afterwards; the child-card leg runs no parent prompt) and
`late-background-results-processor.spec.ts`. Residual: a run that pauses
AGAIN after consuming late results is resumed from a newer stamp, so those
results are not overlaid a second time (they are in memory for every fresh
inference); the model has already read them by then.
SETTLED 2026-09-15, CHILD PROVIDER COMPAT (live-app verifier run 6): a
live-resumed Explorer's response was persisted twice under two message ids
1 ms apart (Mastra's sealed-boundary re-key) and its next request 400ed
"Duplicate item found with id rs_…" — a failed specialist, "· 1 failed" on the
root — because `OpenAIDuplicateItemCompat` reached only the root's per-call
processors (`buildToolLoopOptions`) and a worker's loop options, never a
read-only child. `buildChildProcessors` now carries it for non-worker
personas, resolved against the child's OWN provider like its error
processors. Paired: `build-persona-subagents.spec.ts` ("exactly once; other
providers get none").
RESUMED EXECUTORS (BST-1749 review of #3197): a resume leg OWNS its live
decision seam (`channel.own`) before it registers anything, and registers every
executor it resumes (`prepareResumedExecutor`, through
`createResumedExecutors.register`, awaited) BEFORE it asks Mastra to resume any
task. Ownership cannot wait on registration: `getToolsForExecution`
is async while the leg's first run event streams at once, so a leg that
registered first answered a live session grant with `'no-live-run'` (desktop
`delegated-sibling-grant.integration.test.ts`, "a live session grant during an
approval leg"; unit pin: "owns the live decision seam before it registers").
Mastra looks the executor up only when its workflow runs the task, so a resume
issued first raced that lookup ("No executor registered"). A registration
failure fails the leg before any task is resumed,
and every context the leg registered but Mastra never accepted — a registration
or resume that failed part-way through the leg's tasks, or an abort before its
resumes — is deregistered when the leg ends (Mastra 1.64 throws from `resume`
only before it publishes `task.resume`, so a refusal dispatched nothing). A
refusal drops ONLY a context the leg still owns. Because the leg owns the seam
across its whole registration window, a live decision can resume a task this
leg has not reached yet (nothing rejects that —
`findGrantedBackgroundApprovals` selects on `status: 'suspended'` alone).
Registration is therefore SINGLE-FLIGHT per task: every caller shares the one
live registration, so the
context Mastra runs is never replaced, the task is never resumed twice while it
runs, and it is never deregistered — not by a refusal already in flight, and
not when the leg releases its executors. Its terminal retires both the
registration and the acceptance (acceptance is per resume), so a child that
parks again is registered and resumed afresh with its own join. Retirement is
by GENERATION, not by forgetting the registration: one whose tools are still
resolving cannot be retired by dropping the map entry, because the next caller
then registers afresh and the retired registration still commits when it lands
— registering a second context over the one Mastra is about to look up and
replacing the executor whose join that caller already pushed. Every terminal
raises the task's generation, and a registration that lands on a generation no
longer the task's commits nothing. Removing that
context would strand the running task on the "No executor registered" failure
this contract exists to prevent. A terminal settles the task's ONE live
registration; a later one is settled by its own terminal. A register or resume
still in flight when
the leg releases its executors is skipped by that release and drops ONLY a
context the leg still owns: a resume Mastra accepted keeps it, a refusal drops
its own only when no concurrent resume is still in flight, and a registration
that lands after the release is refused as not live without ever touching the
shared manager (resolving the tools is async, so the registration itself is a
thunk the leg calls once the tools have resolved AND it still may — the drain
is re-checked both before the cache lookup and after that await, and the
registration's own generation is re-checked after that await too; the `accepted`
check runs after the registration and only decides whether the task joins the
drain set). The full state table —
registered, in flight, accepted, drained against every event, with the pin for
each cell — is the module doc of `createResumedExecutors` in
`background-resume.ts`; keep it in step with that code.
The leg's pause branch joins each resumed execution (`Promise.all(settled)`),
and a join exists only for a task Mastra accepted. A join settles when its
executor settles, or when Mastra publishes a terminal that ends the task.
Completed, failed and timed-out are published only AFTER the execution settled
(`classify-outcome` runs once `run-attempt` awaited it, with no race, so a
timeout whose tool never honours the abort publishes no terminal at all); only
a CANCEL is published while the execution is still in flight, and Mastra then
joins that execution under its 5s grace, as this leg's `manager.shutdown()`
does. Because the leg can therefore close while a tool still runs, output that
tool writes afterwards is dropped with `background_resume_output_after_close`,
never thrown back into its execution. A SUSPENSION never settles a join: only
a running
executor parks, so the executor that parked is still joined after its host
join. Before, a refused resume, a cancel before the executor ran and a cancel
while it ran each hung the leg forever. Paired: `background-resume.spec.ts`
("executor registration"; its harness is
`__tests__/fixtures/background-resume-harness.ts`).
KNOWN LIMITS: the root's OWN foreground pause (e.g. a canvas write) while
children still run is not live-deliverable — it queues behind the leg (404);
a queued decision whose pause was cancelled by a root Stop dispatches and
fails visibly (`run.failed`), it is not silently discarded; foreground (web)
siblings that have not paused when the parent suspends surface only on
reload; from the moment the resume stream's terminal wait ends (its last
terminal is in, or a Stop ended it) until the parent wakeup starts, a decision
is `'no-live-run'` and queues. That holds even while the leg still joins its
final ledger row, because `createTerminalWait` closes before it resolves and
`reserve` refuses a closed wait. Before, a decision reserved during that ledger
read joined the ended wait and failed the leg ("Background resume ended before
every terminal task state."). Paired:
`background-resume-terminal-wait.spec.ts`.

OPEN (foreground children only, i.e. web): a sibling that has not
yet paused when the parent run suspends on the first child's approval is not
surfaced live — Mastra closes the parent stream at that suspension; its pause
appears on reload through rediscovery. Seen in the desktop scenario before the
background scope was wired; not exercised by the desktop product path. The foreground pin in `specialist-fanout.integration.spec.ts`
("does not answer pauses already parked") describes foreground children only.
Discovery supplies the same root scope and resolves the authorized native leaf;
missing scope/address is not permission to resume an arbitrary wrapper.

`delegated-worker-write.desktop.test.ts` covers approve-once, decline-without-write,
recursive leaf approval, renderer reload and a distinct native host restart.
`background-worker-stream.integration.spec.ts` covers questions followed by a new
plan pause, failed outcomes, lost parent-result delivery and root Stop with a
queued effect. Native background follow-up/human composer and selective subtree
controls remain separate acceptance within BST-1723.

Scripted transport fixtures identify root/child calls from their tool surfaces,
not the last user message: root context can end with a ledger refresh. Tests of
new native continuations use `recordWakeup`, not the ledger header, which is also
present inside active runs. Hold children until the initial acknowledgement when
the acceptance specifically requires an idle-loop continuation. The desktop
deadline fixture has one child model call: the old last-user classifier wrongly
counted the root's terminal-ledger response as a second child call. Persisted
usage, terminal status and reload assertions remain independent of that classifier.

### Swarm diagnostics evidence (2026-09-15)

Every model-facing wakeup, deferral and late overlay is durable evidence for the
thread debug pack, recorded through the binding's `recordWakeup` (rows in
`brainstrike_delegated_wakeups`). `withBackgroundIdleLoop` records `idle-loop`
BEFORE the continuation streams, with the exact `describeBackgroundWakeup(ledger)`
directive the parent receives and, as invocations, the terminal events that woke
it. A parked parent leg records `deferred` and refuses to close while that record
is pending, so a rejected record fails the leg instead of vanishing.
`createBackgroundResumeStream` records `resume-leg` before `agent.stream`, and
`deferred` for a parked root. Both `withLateBackgroundResults` call sites record
`late-overlay` (`recordLateOverlayWakeup`) before approving or resuming.

Prompt manifests (`brainstrike_assistant_prompt_manifests`): a fresh root turn
records its system messages and registered tool names once (resume legs replay
the snapshotted prompt and record none; deferred tool-search tools are not
listed). The delegation-start hook records `child-first-step` with the prompt the
child receives and the instructions and kept tool names from the DISPATCHING
agent's `childPromptFacts`; a delegation dispatched by any other agent logs
`subagent_prompt_manifest_unrecorded` and records nothing, so nested worker
delegations have no first-step row yet. A child resumed within the same leg
records nothing; a parked child resumed on a NEW leg records a second row for the
same dispatch address, and the pack's `childFirstSteps` takes the earliest. A
host-prepared follow-up records `continuation` only after the running child
accepts it; waking an idle child records no continuation manifest.

Live decisions (`brainstrike_delegated_live_decisions`): the decide endpoint
records `no-live-run`, `refused` (with the host reason) and `failed` BEFORE it
answers; the running leg records `delivered` with the answered sibling task ids
and the request's policy snapshot; a remembered grant records
`remembered-answered` or `remembered-failed` after its attempt, from the parked
leaf captured once it is found. Exactly one row per outcome.

These rows are evidence, never inputs to the loop. The loop awaits each record,
and the host binding logs a failed or run-missing write with a code and resolves,
so a database failure never fails a leg (the pack's host log window captures the
code). Storage contract: docs/agents/assistant-persistence.md ("SWARM DIAGNOSTICS
TABLES"). Paired: `background-idle-loop.spec.ts` (record before stream, deferral
join), `background-late-results.integration.spec.ts` and
`background-worker-policy.integration.spec.ts` (resume-leg, deferral and overlay
rows), `late-background-results-processor.spec.ts`,
`subagent-delegation.spec.ts`, `build-persona-subagents-compat.spec.ts`,
`prompt-manifest-root-leg.spec.ts`, `live-decisions.spec.ts`,
`decide-endpoint.test.ts`, `live-decision-log.test.ts`,
`delegated-sibling-grant.integration.test.ts`,
`delegated-cancellation.integration.test.ts` and
`delegated-conversation-host.integration.test.ts`.

### Background child deadlines (BST-1771)

A background executor that resolves after its native task signal aborted must
reject before native outcome classification. Mastra 1.64 otherwise marks the
empty delegation result completed. The existing delegation tool hooks capture
the executor signal by native parent run/tool-call identity and check it after
execution; the host-owned resumed executor applies the same check. No timer,
retry, native task-state override or dependency patch is introduced.

Child projection reads that execution signal separately from explicit selected
cancellation authority. An expired execution produces one failed child terminal
with the native abort reason; selected Stop remains cancelled. Signal ownership
survives queued output and is replaced on the next admitted execution of the
invocation. Rejected duplicate preparation preserves the active deadline signal.
Host resume capture also stages the signal by parent thread/tool call so native
preparation retains that execution's deadline.
`delegated-deadlines.integration.test.ts` pins native timed_out, durable failed,
exact terminal events and a concurrent sibling continuing to completion; the
approval-resume case also checks persisted usage and reload. This does not
resolve the separate usage-binding-conflict whose rejected tuple is missing.

### Downstream usage failure and cancelled child projections (BST-1771)

A rejected bound usage write closes the upstream iterator: its cleanup joins
native background cancellation, but its catch and remaining streamed terminal
parts cannot reach the event observer. The root failure writer therefore atomically
records the failed root and reconciles still-running child headers whose exact
native invocation is already cancelled. It appends one cancellation event per
settled header, retaining the observed native identity. Foreground descendants
of that cancelled invocation are included through their bound native ancestry.
A descendant with its own non-cancelled native task is excluded; ancestry alone
does not override that task, including when it is parked for approval.

This is a projection of settled native cancellation, never a native state override
or permission to accept rejected usage. The ownership graph, original root turn,
native task owner/run/tool-call tuple and child event identity must agree.
Suspended or running native siblings, other turns/roots, changed owners and
already-terminal headers remain unchanged. Repeating root failure does not append
another child terminal. A terminal-event write failure rolls back the root and
child status transition together. No rejected usage refresh or replacement row
is emitted; the original persistence error remains visible.

Paired checks: `delegated-usage-failure.integration.test.ts` exercises two real
native children and the production persistence pipeline; `delegated-stream-failure.integration.test.ts`
pins scope isolation, descendants, idempotency and atomic rollback. The injected
wrong-resource rejection proves failure containment, not the missing original
usage tuple's cause.

### Selected child cancellation (BST-1723)

The child projection captures the invocation's existing abort signal at native
admission (BST-1770). Selected Stop therefore classifies that child's subsequent
unwind as cancellation, even when native execution reports an admission error
while unwinding. Retain the controller for the runtime-owned binding lifetime, beyond native
tool-hook completion; queued stream parts still belong to that invocation. Native approval resume may re-enter preparation after the prior hook completes;
reuse that invocation's non-aborted controller while rejecting concurrent preparation
and attempts to restart a stopped invocation. Never infer
sibling cancellation from the root's state or suppress a persistence rejection.
The real desktop runtime regression asserts Alpha native/durable cancellation,
exactly one cancellation event, Beta still running, and Beta's later completion.

`POST /assistant/cancel-child` resolves an owned child and explicitly selects either
that child or its subtree. It first revokes admission on the existing invocation
rows, then joins registered native execution owners and stored background cleanup.
Only after those joins does it settle still-running ordinary child run projections
and append their `run.cancelled` event. Earlier completed legs and siblings retain
their status. A failed join returns an explicit incomplete cancellation response;
revoked admission remains durable and does not imply successful teardown.
Stop selects a conversation, including its admitted invocation legs across turns;
it does not select just the currently displayed message. Child host-run IDs include
the host leg and complete native invocation identity, so distinct invocations never
share a terminal projection. Native task selection includes terminal tasks: completed
status can precede workflow deletion, which Stop must still join. Stored cleanup
preserves completed/failed outcomes while removing their workflow snapshots.
Controls register before the runtime can be returned for streaming and remain
registered through shutdown. The host snapshots those live capabilities, checks their
root ownership in one bounded query, and joins them after durable admission revocation.
A subsequently constructed runtime cannot admit a revoked invocation.

The same barrier rejects subsequent child steps, repeated invocation admission,
and pending decision claims after host reconstruction. Closing a tab never invokes
it. Shared conversation controls expose Stop for live execution and reloaded pending
decisions, await the host acknowledgement, and reload actual child history.

The shared workspace navigation provider resolves native invocation addresses for
both root and child cards. Background acknowledgements do not contain a child
address, so persisted event identity remains necessary after reload. Resolution
checks owner, root and the selected parent; it never scans other turns by call ID.
Production proof: `delegated-worker-write.desktop.test.ts` stops a reloaded pending
child, preserves the absent write, sends another parent message, reloads, reopens
the original child, and checks cancelled persistence without another model call.

Construction must unwind cancellation registration and all runtime cleanup owners
when a later Apps admission registration throws; preserve both construction and
cleanup errors. Shared Stop eligibility reuses the approval/suspend notice's exact
identity and resume outcome: separate successful decision messages retire historical
pause controls, failed decisions remain actionable, and sibling decisions do not
retire the selected child's pause.

Active human follow-ups use the observed child identity and its existing persona
agent signal owner. The shared child composer sends through the authenticated
host, which rechecks owner, root, active host and cancellation admission. Native
user signals are durable chronological child turns; they do not become parent
input or launch a second runtime. See the active-input receipt and interruption
contract in assistant-persistence.md. Production coverage spans native foreground
and background delivery and the shared Electron child-composer path.

### Persona Settings host checks (BST-1727)

Settings → Subagents refreshes the ordinary validated workspace/global persona
scan and shows host preflight facts from the existing model catalog, typed
credential reader and MCP tool registry. Missing/unreadable required credentials,
catalogued non-language models, providers without LLM capability, and the built-in
local model's unsupported Worker discovery are blockers. The local-worker rule
is shared with actual agent admission. An unlisted model pin
or missing/disabled MCP tool is actionable attention, not a claim that a custom
model is invalid or that the entire persona is unavailable. Native capabilities,
selected parent model, durable child controls and permission policy remain
per-request checks; a passing preflight never promises effective access.

Declared scope remains visible beside these facts. Refresh rereads profile edits
and host facts with one scan in flight, without executing a model or changing
running children. A failed scan/check shows a visible error and Retry, retaining
any previous list as such;
it does not silently substitute built-ins for a successful user-profile scan.
No credentials enter the IPC response and no new state is persisted. Existing
subagent-personas factory-reset registration remains authoritative.

### Managed idle-child input (BST-1723)

A user follow-up to an idle child starts a fresh managed root host leg and wakes
that exact stored child with Mastra's public `createMessageSignal` / `sendSignal`
API. The renderer supplies only the selected child, stable input ID and structured
text/image payload;
the host authorizes the actual resource/root/ancestry and claims a separate
continuation receipt. It never changes the original invocation or manufactures
parent tool-call coordinates. The receipt is claimed before native wake and binds
the accepted native run before the first continuation envelope acknowledges input.
A repeated admitted input ID never starts work again, including after an uncertain
acknowledgement or restart. Different text or image content under that ID is a conflict.

A pending decision owns its selected child, not the root's execution slot. Multiple
idle children can therefore retain independent approvals/questions, including
same-persona siblings with identical leaf tool-call IDs. Only one receipt may be
claimed/running under a root, and only one active receipt may own each child.
Both fresh input and decision consumption also reject another running/cancelling
managed root leg, including ordinary parent input. Stopping one paused child
preserves its sibling's exact pending receipt across host restart; neither restart
nor a repeated input/decision may execute an effect again.
`idle-grandchild-restart.integration.test.ts` proves depth-two continuation and
sibling Stop isolation through three distinct processes, real native storage,
parent outcome delivery, and unchanged original invocation identities.

The selected child retains its admitted persona and step cap. Direct child legs
must preserve the child's default budget and worker processors: root per-call
`inputProcessors` replace those defaults in Mastra. The existing-child scope
processor checks the exact authorized native memory identity; original delegation
birth and aborted-delegation processors apply only to new descendants. The shared
direct-turn runner owns the existing child's cancellation and aborted persistence.
Actual depth is added to recursive availability checks, so waking a grandchild
cannot reset its depth allowance. Every model step still charges the real child
identity against the managed turn's durable budget.
Fresh child input runs the ordinary workspace/reference/skill context injectors
against that input, without copying client-supplied system-role request messages.
Only host-injected system context crosses to the child, exactly once in the native
model prompt. The selected
child's default context processor also retains that context in native RequestContext,
so a descendant first created after a resumed decision receives the same authority.

Live frames use the shared conversation mapper with `brainstrike.child-continuation`
metadata, not fake parent invocation keys. The host assigns the new child assistant
message ID before native execution and supplies it to Mastra's public ID generator;
live projection and reloaded native messages therefore share identity. Parent and
child assistant IDs remain distinct. Exact approval/question decisions carry the
continuation ID; descendants additionally retain their observed delegation path.
A child pause keeps the managed turn open, and each resumed host leg reuses the
receipt's original turn anchor rather than allocating another budget.
The first direct envelope in each host leg carries its history baseline exactly
once. Reload discovers pending decisions with an inert native agent at the admitted
persona and exact stored child thread/run, then authorizes any descendant path;
it does not require the current persona registry or execute a model to inspect it.

Suspended-run discovery validates every root and child timestamp before
staleness and capping, even when no continuation receipt exists. Invalid values
fail the complete response visibly. Merged pauses remain oldest-first and keep
the newest ten.

Multiple approval or question calls emitted in one model step remain individually
addressable. The installed Mastra scheduler forces concurrency one when a called
tool requires approval or has a suspend schema; child agents use the native
`strategy: 'called'` option. Reload therefore discovers one pending call, then
the next after the exact first decision resumes. The native continuation test
covers two approvals (each effect once) and two questions from the same model
step. A multi-call suspended snapshot remains an explicit unsupported/ambiguous
shape; do not remove its guard based only on parallel model emission.

Completed child output reaches the managed root model through a public native
notification signal and the normal root stream/persistence path. The notification
contains the final completed leg's text; earlier paused-leg text remains in the
child's durable transcript and is not concatenated into that result. This is an
actual model response, not a synthetic assistant message or another transcript
writer. Approval/question pauses and cancellation do not wake that root model.
Binding failure aborts and joins native stream consumption before runtime disposal;
all terminal paths settle the receipt and preserve cleanup failures. If initial
history capture fails after admission commits, the host settles that receipt as
failed before returning the error; the same input id cannot replay, while a new
explicit input can be admitted. A settlement failure preserves both causes in an
AggregateError. Decision disposal consumes only claims still owned by that host;
validation before claim or an explicitly released unexecuted claim cannot replace
the original error with a spurious lost-claim failure. Failed receipts
retain the visible provider or thrown stream error. Completed model responses
persist provider usage before a tool can suspend, as described below; terminal
chunks project that same current-leg usage.
Recognized human continuation signals use one decoder in both projection paths;
malformed signals fail visibly instead of disappearing from child history. Restart does
not automatically replay either the child input or the parent notification.

`child-continuation.integration.spec.ts` exercises real Mastra/PGlite wake, saved
child history, exact approve/decline/question/plan controls, cancellation, failed
binding settlement, durable child step charging, depth limits and root notification
consumption. Host/repository tests cover the separate authorization, duplicate,
turn-link, replay/reset and atomic claim boundaries; UI production-path evidence
is required alongside these native tests before delivery is complete.

### Admitted persona configuration on decision resume (BST-1727)

An admitted child's stored `configuration` contains its persona instructions,
model pin, mode, effective tool IDs and the invocation's clamped step budget.
The host returns this immutable configuration only after authorizing the entire
decision ancestry. Both public approval and question/plan resume entry points
restore those profiles before constructing discovery or execution Agents.
Restoration is indexed by depth, so two admitted generations of the same persona
ID cannot overwrite one another. Registry edits, disable preferences and removal
apply to fresh root turns; a resumed native leg retains its admitted target
profile through completion and does not rewrite an already-admitted decision.
The resumed root leg may invoke that restored profile again; a new root turn
uses current registry availability.
Current host tool availability, permission rules and model credentials still gate
execution. Missing/invalid snapshots or an unavailable admitted profile fail
visibly before native resume; another persona or model is never substituted.
The browser-safe `AdmittedChildConfigurationError` carries only a fixed reason and
safe remediation. The shared HTTP initializer returns status 409 with that message;
profile text and underlying errors stay private. Missing/legacy shapes request a
fresh delegation, while a persona/path identity mismatch is a distinct integrity
failure. Unknown fields, invalid model providers and empty tool catalogs reject.
The schema exhaustively includes the persona contract's keys, modes and sources.

Wildcard worker profiles are expanded to their effective admitted tool IDs when
building the admission map. A later catalog addition cannot broaden that child's
resume. This captures the full eligible catalog before discovery hides unloaded tools;
`load_tool` can restore an admitted tool from child history after resume.
Older records retaining an unexpanded `*` fail with an explicit request
to start a new delegation; their original catalog cannot be inferred from today's
registry. Cross-provider pins reacquire credentials through the trusted host reader,
including when the live persona file has been deleted; credentials are not stored
in child configuration. `assistant-service/stream-init.ts` is the sole production
caller of the two public resume functions and injects that reader for both.
Restoration without an authenticated root runtime rejects before reading
secrets. Native Mastra snapshots retain the original delegated
task and workspace/system context. This boundary does not change native workflow
snapshot formats or create another execution owner.

Production tests: `delegated-persona-snapshot.integration.spec.ts` disposes the
original owner, discovers the stored approval/question after registry edits or
removal, resumes through the public entry point, and checks one effect plus child
and parent output. It also rejects when the admitted tools are no longer available at all.
`recursive-worker.integration.spec.ts` removes the live Worker before depth-2/3
resume and asserts that real admission receives expanded tool IDs, with no `*`.
`agent-stream-init-and-memory.integration.test.ts` proves fixed remediation reaches
the real HTTP response while unrelated initializer failures remain redacted.
`delegated-conversation-host.integration.test.ts` verifies stored configuration is
read only through the authorized root/turn path. Idle-child wake uses the managed
continuation boundary above.

The stored step budget must be a valid admitted value under this build's host
ceiling. Current admission cannot write a value above that ceiling. A future host
limit reduction must coordinate native snapshots and durable root/child counters;
clamping only this parser would not prove the running workflow uses the new limit.
Read-only `resolveToolAction` runs before profile reconstruction and again before
native decision admission. The second authorization intentionally rechecks current
ownership rather than caching authority across model/tool construction.

### Settings inventory and reset release proof (BST-1727/BST-1728)

`delegated-factory-reset.desktop.test.ts` toggles Settings' master delegation
switch and observes the next real native Mastra request at the external model
provider boundary. Enabled requests advertise `agent-worker`; disabled requests
advertise no `agent-*` tools while retaining ordinary tool discovery. After
Settings factory reset and process restart, the default switch and an actual
subsequent worker-capable inventory return. The existing provider shim supplies
model text only; the app's assistant endpoint, request preference propagation,
persona resolution and tool catalog construction run unmodified. This case does
not execute a delegated workspace effect; the worker fixtures own that proof.

### Selected child scope and captured usage

The selected child's details surface reads its authorized durable configuration,
actual child run model/provider and tree depth. It uses the same admitted-profile
parser as native resume; an invalid legacy profile remains an explicit error,
never a different persona. The displayed tool list is the admitted maximum, still
subject to current host permissions. A missing captured effort value is displayed
as not recorded; it is not inferred from the parent's current selector. Continuation
receipts with an execution snapshot display their actual model, generation effort,
output limit, plan state and permission policy. The latest authorized receipt is
read separately from the original admitted maximum.

Direct captured usage and inclusive child-plus-descendant usage reuse the main
conversation's cumulative usage component and pricing resolver. Inclusive totals
already include the selected child and must not be added to direct totals. A
missing usage record is not zero spend; unknown model pricing remains unavailable.
The reader follows exact invocation and continuation attribution because ordinary
child usage rows are stored under the root thread. The assembled desktop
acceptance uses that same root/resource/parent-run/tool-call attribution when
checking each survivor's usage, and opens the child conversation to verify its
answer when the root activity is collapsed. It does not sum the root's
entire bill into each child. Only retained conversation attribution is shown;
ordinary root totals still retain numeric history after child deletion. Current
work may not yet have reported its final usage.

### Next idle child run controls (BST-1727)

The child reuses the main composer's model picker, generation/effort controls,
plan control and tool menu. Its draft is local to the exact child panel. Before
an explicit override, the selected model comes from the admitted persona pin or
its owning root's live per-thread selector; provider settings and plan mode come
from that same root store, not another thread or global settings alone. Desktop
children use the same shared provider-discovery resource as the parent even when
the parent panel is not mounted.

Historical Retry/Edit reads admission ancestry and restart capture in bounded
80-message pages. An empty branch prefix reads no message page. Its baseline
excludes events whose canonical native-message owner (or, when absent, turn
owner) is outside the branch. Retry also excludes turn-owned events for the
replaced answer, even though its user prompt remains in the prefix. Legacy
ownerless events retain chronological
assignment; an empty prefix has no events to project. The native branch
history verifier observes transaction-handle queries as well as outer capture
queries, and exercises missing targets and cycles directly.

Idle input and historical branch actions wait for a valid admitted persona.
A malformed latest execution receipt displays a concise, explicit error while
retaining the original admitted persona and tool/step limits; raw schema issue
JSON is not user-facing copy, and unreadable execution settings are not inferred.

Changes apply only to a new idle-child input. Active input carries no next-run
configuration. The shared composer captures the complete next-run request once;
an unconfirmed retry keeps that exact receipt and settings despite later control
changes. Changing text/images still requires explicit discard. Browser receipts
exclude credentials and local endpoint configuration. The host resolves credentials
through the existing admitted-persona provider path.

Every new native child also records the actual generation options installed on
its Agent through the existing trusted admission binding before native input is
persisted. No new context registry or renderer-provided authority is introduced.
Original decision resume restores execution snapshots alongside admitted persona
profiles at each exact ancestry depth. A different pinned descendant model uses
its own defaults instead of inheriting options intended for another model. The
current root's permissions apply to that child's tool construction through
`intersectChildPermissionCeilings` (`packages/assistant-contract/src/child-permission-ceiling.ts`):
the admitted snapshot contributes ONLY its denies, so a root grant made after
admission (a session grant, a per-tool "Always allow", yolo) lifts an admitted
`ask` on the very next resume leg, while a later root reduction still applies and
the admitted tool catalog stays frozen. SETTLED 2026-09-12 (do not relitigate):
the earlier symmetric "stricter wins" rule froze every admitted `ask`, so the
grant buttons on a child's approval notice could never end the prompting — one
Explorer tree paused 87 times on `readWorkspaceDirectory` and exhausted its
step budget without reading a file. Paired spec:
`child-run-configuration.spec.ts` ("child permission ceiling honors root grants
made after admission"). Because that grant removes the approved tool's `ask`
flag before the child resumes, the approval-resume leg builds children with
sequential tool calls (`approvalResumeLeg` → `resolveChildToolCallConcurrency`,
see `assistant-runtime.md` "Parallel tool calls"); otherwise Mastra's parallel
foreach resume re-raises approval for the allowed siblings of the approved call
(2026-09-13 `globWorkspace` pause + "multiple pending calls" 502).
Older rows without an execution snapshot remain explicitly unrecorded.

Migration 137 persists an execution configuration on each continuation receipt.
Admission validates the current host model and image capability, combines root
permissions under the deny-only ceiling above, prevents disabling root plan mode,
and permits only reductions of the original admitted tool catalog. Resume reads
the receipt's exact profile and generation settings and applies the current root
permissions (grants and reductions) under that same ceiling. A pending
decision is not affected by future draft edits, reload or different parent effort.
Child settings never replace the parent outcome leg's settings. Null legacy
execution configurations retain the explicit original-profile compatibility path;
migration rollback refuses to discard non-null execution snapshots.

Verification: real PGlite upgrade/replay/reconstruction and receipt identity tests;
actual first-delegation and continuation admission/decision resume with child high/777 while
the parent uses low/42; public composer retry retains the original configuration;
shared Electron child image/idle/reload/approval path observes selected xhigh on
the real provider wire before and after pending-decision reload.

### Structured child composer input

The shared composer uses the same image adapter, file mentions and workspace slash
commands as the root. Image-only drafts are valid in both active and idle children;
Send and Enter share the same content-presence and delivery gates. The selected
child's captured running model determines active vision availability. An idle child
uses its admitted persona model pin, or its owning root's current per-thread model
selection when unpinned. A previous run's model never overrides the next selection.
Known unsupported models reject images visibly; unknown provider capabilities use
the canonical root policy and surface actual provider errors.

Only the authenticated host resolves file/skill references. Caller-supplied system
context is rejected. Native message signals retain structured file parts and bounded
host context; live frames and reloaded messages use the ordinary shared renderer.
The latest native user signal replaces only its input-context tag; absent or empty
context clears the older tag without altering admitted persona or workspace authority.
A stable receipt binds the entire normalized payload, including image bytes, through
acknowledgement loss and restart. Migration136 stores that payload on the existing
reset-owned continuation receipt; legacy text-only receipts remain readable. Downgrade
permits only payloads losslessly represented by the retained input text; image or
conflicting-content payloads refuse downgrade.
Acknowledgement clears only the sent attachment cohort and unchanged text, preserving
newly staged input. An unconfirmed changed payload requires explicit discard rather
than silently reusing its receipt or replaying the input.

The shared effort control offers an OpenRouter ladder only from the selected
model's declared or matching live metadata; it never borrows direct OpenAI
defaults while routed-model metadata is pending. This keeps first-child admission
and the visible root controls on the same capability contract.

Continuation token accounting uses Mastra's public `processOutputStep`, which
reports the completed model response before tool execution can pause. A paused
native stream has no `step-finish` and its terminal usage is zero; a resumed
terminal includes earlier paused model responses. Neither is a per-host-leg
charge. The admitted child's processor persists cumulative provider-reported
counts within the current managed host leg, and the continuation projection emits
those same counts. A fresh decision leg starts a fresh meter; native cumulative
finish values cannot duplicate earlier spend. Stopping an already paused child
therefore retains its reported model usage. Missing provider counts do not create
a fabricated usage row. The three-process sibling fixture checks 1/1 on each
paused child and 1/1 on the surviving child's resumed leg, both live and durable.

### Settings inventory and reset release proof (BST-1727/BST-1728)

`delegated-factory-reset.desktop.test.ts` toggles Settings' master delegation
switch and observes the next real native Mastra request at the external model
provider boundary. Enabled requests advertise `agent-worker`; disabled requests
advertise no `agent-*` tools while retaining ordinary tool discovery. After
Settings factory reset and process restart, the default switch and an actual
subsequent worker-capable inventory return. The existing provider shim supplies
model text only; the app's assistant endpoint, request preference propagation,
persona resolution and tool catalog construction run unmodified. This case does
not execute a delegated workspace effect; the worker fixtures own that proof.

### Native child workspace reads and checkpoint undo (BST-1726)

The native tool execution thread, not the parent tool-factory closure, owns
read-before-write timestamps and paged-read cursors. Per-file locks remain the
existing serialization boundary. The authorized delegated invocation resolves
the checkpoint's resource and host-leg run with the same `delegatedHostRunId`
function used by event persistence.

Desktop memory wiring supplies pre-execution snapshot capture to host admission.
The shared child view reuses `EditCheckpointProvider`/`useEditCheckpoints` with
the child's thread ID; terminal store events refresh the ledger. Browser views
without the checkpoint bridge do not query or expose native checkpoint controls.
The Electron worker test proves child restore after reopen, durable reverted
state after reload, preservation of an independent user file, and no new model
request. This does not complete all workspace coordination acceptance.

Delegated native file mutations carry the selected execution's abort signal to
the per-path mutation boundary. A child stopped while waiting for a shared file
lock cannot mutate after the lock becomes available; completed child edits stay
inspectable and a sibling retains its own execution signal. The four real queued
write/replace/delete/rename cases live in the workspace staleness integration suite.
