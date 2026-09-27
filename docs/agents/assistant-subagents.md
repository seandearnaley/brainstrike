# Assistant Subagents (Persona Delegation)

> Read before changing persona delegation. Rules here are true now; the record
> behind each is in `assistant-subagents/<topic>.md`.

A child conversation panel binds the shared thread debug export to the selected
child ID, never an inherited root binding: a child export covers only that
child's authorized subtree, the root export all authorized descendants. Usage and
full artifacts keep their original root attribution and execution identities.
Export/retention contract: `platform-contracts.md`.
Guard: `packages/db/__tests__/thread-debug-snapshot.integration.test.ts`.

## First-class subagent architecture gate

- Only a `mode: worker` child receives `agent-*` tools. Explorer, Analyst and any
  persona without an explicit `mode` are read-only leaves.
- Every child pause surfaces in the leg that raised it and the leg reads to
  native close; notices publish together behind the completion join, and a
  resumed leg whose siblings stay suspended ends as a `tool-calls` pause
  (`assistant-runtime.md`, "Native suspension completion").
- A delegation harness admits delegations through a budget port, as the desktop
  host does: without one the in-flight backstop rejects the third parallel child,
  because Mastra fires no completion hook for a SUSPENDED child.
- Provider call warnings from inherited and pinned persona models share the
  parent run's bounded warning sink, carry their configured provider/model, and
  deduplicate per model. Capture neither changes model input nor grants tools.
- Keep the capability matrix in `assistant-subagents/native-contract-matrix.md`
  true when upgrading `@mastra/core` or `@mastra/memory`. Its rules that bind
  production code: configure the shared memory service explicitly on EVERY Agent
  (a root-only configuration omits the grandchild); select
  `hookErrorStrategy: 'throw'`; a delegation's RequestContext is a shallow copy.
- Production never passes `untilIdle` — `withBackgroundIdleLoop` replaces it. The
  native suite exercises it only as a capability probe.

Settled 2026-09-14 (do not relitigate): read-only children cannot delegate, and a
parallel delegation step no longer stops the root loop at the first pause.
Evidence: `assistant-subagents/native-contract-matrix.md`.
Guard: `packages/agent/src/mastra/__tests__/persona-recursion-gate.spec.ts`,
`packages/agent/src/__tests__/specialist-fanout.integration.spec.ts`,
`packages/agent/src/__tests__/mastra-subagent-contract.integration.spec.ts`.

## Capable workers and context transfer

- Workers require hosted catalog discovery; a pin to the embedded `local`
  provider is visibly omitted before model resolution. Derive the worker input
  budget from its resolved context window with the shared output reservation.
- Store only host-projected system text in the native RequestContext snapshot
  before inference and restore it on resume; exclude parent-generated system
  instructions from conversation history. Never serialize runtime capabilities; a
  legacy snapshot without that context rejects new children visibly.
- Validate trusted context size only when a child starts: invalid or oversized
  context rejects that delegation before child inference and Mastra returns the
  tool error to the supervisor. System context over 64 KiB fails closed, and
  `messageFilter` keeps at most 16 ordinary messages under a 64 KiB UTF-8 budget
  counting each reference's complete serialized size. Pruning is logged.
- Read-only specialists receive parent messages as explicitly labelled reference
  text preserving the source role and content; workers retain the original
  message objects and roles. Both paths retain chronology, initial and resumed.
- Read-only specialists use native Memory with the same storage, retrieval and
  embedding configuration, working memory DISABLED; workers keep theirs. Do not
  set `defaultOptions.memory` to override this — Mastra then treats the child as
  owning its memory address and omits child thread/resource injection.
- Clear model-authored `params.instructions` from the instruction override and
  append it to the delegated user task instead.
- A whole-result delegation hint uses each registered child's actual
  permission-gated artifact-reader capability; a denied reader produces none.

Evidence: `assistant-subagents/worker-context-transfer.md`.
Guard: `packages/agent/src/__tests__/delegated-system-context.integration.spec.ts`,
`packages/agent/src/__tests__/worker-delegation.integration.spec.ts`,
`packages/agent/src/__tests__/worker-discovery.integration.spec.ts`.

## Implementation decisions for the remaining tickets

- Keep native `Agent` delegation with the existing host services. Do not migrate
  to `AgentController`: its beta Session host overlaps our permissions,
  thread/run ownership and workspace services, and its live grants are not
  automatically durable. Named exception: `mastra-boundary.md`.
- Derive ancestry from persisted identity, never by parsing generated thread-id
  strings. Invocation and config identity are immutable; a follow-up reuses the
  child thread with its own run identity.
- Map the nested stream into the same StreamChunk and transcript contracts as
  root conversations. A compact parent result never substitutes for full child
  storage, and parent prompt budgets are never widened for richer UI data.
- Tree limits (depth, invocations, runnable work, tree output tokens) and the
  per-child allocations are all `RuntimeSubagentSettings`; no limits constant
  exists, and none is a model's input window. `maxDepth` stays within the parent
  watchdog's eight envelope unwraps (see "Child budgets are USER SETTINGS").
- The host atomically admits invocations and reserves model steps before work,
  across descendants and resume legs. Unknown usage is still charged, reported
  overages persist before tool execution is rejected, and a waiting native
  delegation holds no model/tool permit.
- Preserve the read-only Explorer/Analyst definitions. Profile narrowing never
  expands host authority.

Evidence: `assistant-subagents/ticket-decisions-and-verification.md`.

### Verification boundaries

- The native suite is not desktop E2E coverage. For a production-path test reuse
  `apps/desktop/e2e/utils/model-provider-shim.ts` with the isolated profile and
  real host launch pattern of `mcp-packaged-core.desktop.test.ts`; script the
  model endpoint, never the assistant stream, and route parent and child scripts
  from the shim's per-request selector inputs.
- `setupAssistantMock` proves UI states, not execution or persistence, and no new
  mock-only lane stands in for the real host route.
- Report renderer reconnect, reconstructed runtime/storage and an actual process
  restart as separate guarantees.

Evidence: `assistant-subagents/ticket-decisions-and-verification.md`.

## SUBAGENTS (PERSONA DELEGATION)

Child `Agent`s passed in the parent's `agents: {...}` config become `agent-<key>`
delegation tools through Mastra's native supervisor pattern. Do not build a
bespoke `subagent` tool.

- **Personas as data:** `packages/assistant-contract/src/personas.ts`
  (`BUILT_IN_PERSONAS`) plus user-defined personas. `assertReadOnlyPersona`
  rejects non-read and unknown native tools; `mode: worker` accepts original
  native and MCP ids and a sole `*` inherits the eligible host catalog; mixed
  wildcards and parent-owned `manageTaskList` are rejected.
  `assertPersonaToolScope` validates the declared mode before permission
  filtering.
- **The step cap is DERIVED into the description, not written into prose — do not
  relitigate.** `delegationDescriptionForPersona` appends it from
  `effectiveChildStepBudget`, and both places a description reaches a model call
  it. Built-ins declare the host ceiling (`MAX_USER_PERSONA_MAX_STEPS`), so the
  user's `maxChildSteps` setting governs and a persona can only lower it.
- **Read-only personas report PROVENANCE; Workers may author a delegated
  deliverable.** Supervisor guidance reflects each admitted mode. Read-only
  child instructions cite `path:line` and mark documentation/comment claims.
- **User-defined personas:** markdown with frontmatter, parsed fail-closed by
  `user-personas.ts`, scanned FLAT by
  `apps/desktop/src/assistant-server/user-personas-loader.ts` from
  `<root>/.brainstrike/agents/` per mounted root then `~/.brainstrike/agents/`,
  first-id-wins with warn-once. A built-in id collision is an INVALID file, never
  an override. Omitted `tools` means the curated read-only set without
  webSearch/askUser/submitPlan/manageTaskList; explicit askUser/submitPlan need
  the complete durable child-control capability at runtime, and `manageTaskList`
  stays rejected because its state belongs to the parent. Out-of-range `maxSteps`
  is an ERROR, never a clamp; ids are capped so `agent-<id>` fits the 64-char
  provider tool-name limit.
- **Scan invariants (BST-936) — do not regress.** Shared rules:
  `workspace-context.md` § `.brainstrike/` SCAN CONVENTIONS. Persona-specific:
  reserve the id BEFORE reading the file through `resolveUserPersonaId`, so a
  broken project file cannot hand its name to a home-directory file; count
  ENTRIES (valid + invalid) against `MAX_USER_PERSONAS` and REPORT an exhausted
  cap per directory in `incompleteDirs`; keep the listing bound decoupled from
  that cap; a duplicate id is a `status: 'shadowed'` ENTRY naming the file that
  won, rendered muted — precedence, not an authoring mistake.
- **Per-request resolution:** `resolveRequestPersonas` merges built-ins with
  scanned personas, applies the renderer's availability preference (it can only
  REDUCE the set) and resolves cross-provider keys onto
  `runtime.personaProviderApiKeys` — server-set, a client value is STRIPPED. A
  scan failure degrades to built-ins with a warn: a broken agents dir must not
  take down chat. The preferences store is factory-reset-registered.
- **Settings states what the host enforces (BST-1727):** every loadable item
  carries `personaScope` of the SAME definition the child is built from, the
  panel reads the user's settings for the tree-wide block, and it shows
  `effectiveChildStepBudget` rather than repeating the arithmetic. A bridge
  omitting the fields renders no scope line rather than a guess.
- **Model pinning:** same-provider pins reuse the parent key; cross-provider
  pins use `personaProviderApiKeys`; `PERSONA_PIN_KEYLESS_PROVIDERS` need none.
  A local pin requires `runtime.localLlmHostClient`. `resolvePinnedModel` skips
  unresolvable pins with `subagent_persona_pin_unresolvable`, never a fallback.
- **Child factory:** `build-persona-subagents.ts` selects a subset of the parent's
  guarded, lifecycle-hooked tools through `filterToolsByPermissionWithMetadata`.
  Read-risk ask tools retain approval only with storage and the complete durable
  binding. Omit empty tool maps and visibly omit workers missing any child-control
  method. Child Agent ids equal persona ids. Shared tool objects receive the
  child's projection budget only synchronously; restore it in `finally`.
- **Safety rails:** `createDelegationConfig` (`subagent-delegation.ts`) builds a
  per-run closure — caps from `subagentSettings`, the persona `maxSteps` clamp,
  unknown-persona rejection, and `onChildUsage` reporting into durable
  `run_kind='subagent'` rows under the parent runId. FINISH counters exclude child tokens; attribution
  rides that row (`assistant-persistence.md`). Pass it on
  `streamOptions.delegation` in ALL THREE stream iterators — initial turn,
  approval resume, suspend resume. With durable budgets the shared model/tool
  queue replaces the in-flight cap.
- Failure hooks log fixed cause categories and call identity, not freeform errors;
  known embedding failures give feedback. Selected Stop requires the same reason
  in both owner signals and child error cause chain; `AbortError` alone is insufficient.
  Evidence: `assistant-subagents/worker-startup-failures.md`.
- An in-flight delegation whose parent run aborts mid-stream gets a terminal
  `subagent.failed` (status `cancelled`), so a cancelled parent leaves no
  orphaned `subagent.started`. An approval-resume leg synthesizes a `start`
  tool-event for EVERY pending call of the suspended step, and `agent-*` siblings
  additionally get a tracked `subagent.started`.
- **Stream → run events:** `processMastraStreamPart` emits `subagent.started`/
  `.finished`/`.failed` alongside the generic `tool.*` timeline and maps a
  delegation `tool-output` to `subagent.tool.*` instead of the generic path.
  The first terminal wins for both timelines; duplicate parts cannot emit
  another subagent terminal. Guard: `mastra-tool-lifecycle.spec.ts`.
  `requireRunEventKind` throws on an unknown kind, so the contract enum ships
  before any emitter. Metadata carries ids and labels only, never args or
  results.
- **A foreground child has no watchdog of its own**: the parent's watchdog reads its
  calls THROUGH the delegation envelope; a BACKGROUND child has its own watchdog
  (both in `assistant-runtime.md` § Stream inactivity watchdog).
- Subagent tool calls feed the same per-tool token telemetry table as primary
  calls, attributed to the parent run, through a telemetry-only sink that does
  NOT feed the prompt-reconciliation aggregate (`assistant-persistence.md`,
  `## TOOL-CALL TOKEN TELEMETRY`).
- **A child that never answered is NOT a success.** `createDelegationConfig`
  replaces empty `result.text` through Mastra's `resultText` override with a
  reason stating only what is OBSERVABLE (no answer written, N tool calls) and
  naming the step cap as context; report child usage BEFORE that branch returns.
  `createDelegationOutcomeCapture` records the parent toolCallId so the mapper
  emits `subagent.failed` with `outcome = SUBAGENT_NO_ANSWER_OUTCOME` — a capture
  is required because `resultText` has already replaced the empty text by the
  time the `tool-result` part exists.
- `SUBAGENT_REJECTED_OUTCOME` marks a delegation refused before its child ran:
  Mastra still returns a successful tool call carrying `[Delegation Rejected] …`,
  so `onDelegationStart` records the refusal in the same capture. A background
  refusal completes its task row, wakes no parent and is no ledger entry.
- The renderer reads the bounded `outcome` marker scoped by `parentToolCallId`,
  never the human label, and the card shows `No answer` / `Rejected` in amber,
  not destructive red: the delegation ran and its child rows stay browsable.
- **The child's LAST step is reserved for its summary, via Mastra's own
  `onIterationComplete` hook.** `buildChildIterationPolicy` rides the child
  Agent's `defaultOptions` so it applies when Mastra invokes the delegation
  internally. IN-LOOP is the point: the summary turn inherits the child's abort
  signal, usage accounting, memory scoping and context, and is spent from the
  DECLARED budget. Do not reintroduce a second `agent.stream()`. The policy
  no-ops when the cap is unknown or below two steps.
- **Budget guard:** project an `agent-*` result's `subAgentToolResults` to
  compact per-child rows BEFORE any bounding, dropping raw child result bodies;
  the `TRIMMABLE_COLLECTION_KEYS` entry stays as the structural backstop.
- Built-in personas include `brainstrike.readToolOutputArtifact` when the run
  registers it, and oversized-result settlement advertises whole-result
  delegation only after persona assembly registered an artifact-reader-capable
  `agent-*` tool.
- **Desktop wiring:** `assistant-service/stream-init.ts` sets `runtime.personas`
  to the per-request resolved set on the shared runtime, covering the initial and
  both resume paths. Personas are skipped for `provider === 'local'` and in plan
  mode; web is unaffected.
- Children write to fresh Mastra threads under `<resourceId>-<personaId>`
  resource ids, invisible to the user's thread list; orphan cleanup is a
  follow-up and factory reset purges the DB.
- The SubagentCard renders per-child-tool rows from BOTH persisted
  `subAgentToolResults` and LIVE `subagent.tool.*` run events read THREAD-WIDE,
  scoped by `parentToolCallId`, persisted superseding live by child `toolCallId`.
  Thread-wide is load-bearing: hydration weaves a run's events into one assistant
  group and an approval-resume turn splits into sibling groups, so events can
  land on a different message than the card. Same rule for the outcome read.
- One `SubagentInvocationIndexProvider` per mounted thread maintains that
  projection; cards subscribe by `parentToolCallId`. It folds new parts from the
  previous length and never revisits retained parts; removal, reorder, id
  replacement, part shrink, or a new parts array for a settled id rebuilds it,
  while metadata identity is deliberately ignored. Subscribe through the public
  root client and reread once after subscription; render and snapshot reads never
  mutate or notify.
- Run-event terminal pairing resolves candidate terminals AGAINST the declared
  kinds, so a pairing can never name a kind nothing emits. Scope per kind
  (`parentToolCallId` for `subagent.started`, the child `toolCallId` for
  `subagent.tool.started`) and take the matched terminal's OWN status.
- The card routes by tool-name PREFIX for user personas:
  `ToolFallbackWithSubagents` forwards any `agent-*` part and
  `personaLabelForToolName` falls back to the persona id — never blank, never a
  raw tool card.
- Personas re-scan per request, so persona-file edits apply on the next turn.

Settled: the step cap is derived, not restated; `subagent.*` rows stay hidden
from the main run timeline; child tool rows are read thread-wide. Evidence:
`assistant-subagents/persona-definitions-and-scan.md`,
`assistant-subagents/child-factory-and-safety-rails.md`,
`assistant-subagents/delegation-outcomes-and-budget-guard.md`,
`assistant-subagents/subagent-card-and-invocation-index.md`.
Guard: `packages/assistant-contract/src/__tests__/personas.test.ts`,
`packages/assistant-contract/src/__tests__/user-personas.test.ts`,
`apps/desktop/src/__tests__/assistant-server/user-personas-loader.test.ts`,
`packages/settings-ui/src/__tests__/subagent-personas-delegation-limits.test.tsx`,
`packages/agent/src/mastra/__tests__/build-persona-subagents.spec.ts`,
`packages/agent/src/mastra/__tests__/subagent-delegation.spec.ts`,
`packages/agent/src/mastra/__tests__/child-iteration-policy.spec.ts`,
`packages/agent/src/mastra/__tests__/mastra-tool-execution-part-kind.spec.ts`,
`packages/agent/src/__tests__/mastra-subagent-execution.integration.spec.ts`,
`packages/assistant-ui/src/__tests__/subagent-invocation-index-model.test.ts`,
`packages/assistant-ui/src/__tests__/assistant-run-timeline.test.tsx`.

---

### Maintaining the native contract proof

- Re-run `mastra-subagent-contract.integration.spec.ts` and update
  `assistant-subagents/native-contract-matrix.md` when upgrading `@mastra/core`
  or `@mastra/memory`; the `*.integration.spec.ts` suffix keeps this real-PGlite
  suite in the uncached integration task.
- The fail-closed strategy covers every delegation hook, diagnostic logging
  included. The start hook clamps typed scalar limits and neither logs nor awaits
  after acquiring its counters; completion releases its slot before reporting.

### Early identity seam

- Bind child scope during INPUT preparation using `onDelegationStart`'s
  RequestContext as a host-owned WeakMap key, never persona/order/parsed ids.
  Capture `beforeToolCall.input` with native context IDs; recheck persona/prompt
  on admission. Prompt history is not the executing call.
- An output processor is too late — the first native `start` bypasses it and
  `onChunk` runs after enqueue. An input binding error is visible and prevents
  child model and tool execution.
- The child's native resource can differ from the root's, so it is not the user's
  ownership authority.
- A durable-snapshot resume may skip input preparation; production resume
  authorizes the persisted invocation against the exact root, turn, persona and
  native run before publication.
- The host-only delegated conversation graph lives in `@brainstrike/db` with
  exact native scope checks across the full ancestor chain, immutable child
  configuration/workspace binding and explicit legacy absence (see
  `assistant-persistence.md`, `database.md`).

Evidence: `assistant-subagents/early-identity-seam.md`.

## Child conversation interaction contract

- [`docs/design/subagent-threads/README.md`](../design/subagent-threads/README.md)
  specifies child UI design, not current runtime behaviour.
- Reuse the current thread renderer, runtime adapter, activity rows, color
  tokens, tabs and TreeTable adapter. Select a child by durable conversation
  identity; persona id and call sign are separate.
- Activate transcript subscriptions only in visible panes; hidden Activities retain
  drafts/receipts. Closing a tab changes presentation only; stopping a child stops
  its owned branch and root stop covers the tree.
- Direct steering acknowledges delivery and notifies the parent without rewriting
  a completed delegation result.
- Enable inherited controls only with a child-scoped command and persistence path.

Evidence: `assistant-subagents/child-ui-and-shared-surface.md`.
Guard: `apps/web/e2e/subagent-design-prototype.test.ts`,
`packages/app-shell/src/__tests__/delegated-workspace-app-activity.test.tsx`.

### Shared conversation surface

- `AssistantConversationPanel` takes a host-owned public `AssistantRuntime`, a
  stable `threadKey` and an accessible label, and renders the same `ChatThreadUI`
  as the main panels. Do not introduce a second child message renderer.
- The panel creates, starts and cancels nothing: the host owns runtime creation,
  graph-authorized hydration and command routing. The existing-runtime surface
  disables the root session queue dispatcher through
  `FollowUpQueueOwnershipContext`, so a queued item cannot start work merely
  because an inspection panel mounts.
- Changing `threadKey` remounts the subtree and resets draft, scroll and
  disclosure state; a switching host restores that view state itself. Composer
  inputs use React `useId` so simultaneous panes have distinct identities.
- Child decisions and their queued-state indicators use the persisted ROOT
  conversation ID for the follow-up queue; the published assistant-ui runtime
  thread ID is only a registration identity and may differ.
- A child panel never appends an approval or typed resume into its external child
  runtime — appending while that runtime reports running invokes its cancellation
  path. The app-shell supplies an explicit decision route that validates and
  augments the durable child identity, then asks the registered root owner to
  deliver live or enqueue under the root thread key. The root alone decides
  live-versus-queue admission, and a rejected route stays visible, unlocks the
  control and must not report delivery.
- Outcome identities include the owner-versus-child source and decision index so
  repeated incomplete runs unlock the next retry without reviving an earlier
  optimistic lock; ranking includes root-submitted user decisions so bulk grants
  cannot resubmit a dispatched approval.

Evidence: `assistant-subagents/child-ui-and-shared-surface.md`.
Guard: `packages/assistant-ui/src/__tests__/assistant-conversation-panel.test.tsx`,
`packages/assistant-ui/src/__tests__/child-decision-owner-outcomes.test.tsx`.

### Durable binding before publication and resume preparation

- Await a real delegated graph write in the child input processor and reload that
  binding before every forwarded child event, including `start`.
- The child input processor is NOT invoked on snapshot resume: a production
  resume authorizes persisted ancestry and invocation identity at the host
  boundary before forwarding any resumed child event.

Evidence: `assistant-subagents/durable-binding-and-usage.md`.

### Host binding adapter

- `MastraAgentRuntimeOptions.conversationBinding` threads through persona
  construction and the native delegation policy, which checks persona
  availability and budgets first, then snapshots its configuration and clamped
  maxSteps.
- Each child input processor awaits the persistence callback before model or tool
  execution; missing parent registration or a rejected write fails the child
  visibly. The callback receives OBSERVED native ids, never a fabricated child
  run id.
- Store ephemeral correlation in a WeakMap, never RequestContext entries or
  RuntimeData, and clone the configuration snapshot before child execution.
- The host derives owner, root and turn from its persisted server run while child
  resource ids stay native execution scopes; resume reauthorizes the original
  invocation against the current leg's owner/root/turn. Names are allocated once;
  colors change only through an explicit authorized, idle-tree refresh.
- Thread deletion expands the complete native branch through the same authorized
  graph; revoked ancestry rejects the whole delete, and overlapping bulk roots
  produce one deletion per native thread.

Evidence: `assistant-subagents/durable-binding-and-usage.md`.

### Native run publication boundary

- `streamAttemptChunks` awaits `conversationBinding.bindRun` before mapping the
  first native child `tool-output` of each attempt, resume legs included; the
  host resolves and authorizes the durable invocation before returning.
- Cache only successful bindings for that attempt and reject a changed child run
  under the same parent call, so a recreated resume authorizes again. Perform no
  database lookup per text or reasoning delta.
- `bindInvocationRun` includes the observed persona in its atomic SQL predicate
  on first publication and reauthorization; a separate host read is no
  substitute, and missing or changed native identities stay fatal to publication.
- A rejected binding propagates through the existing stream error/abort path.
  Cooperative abort is not proof that every asynchronous native memory write has
  settled, and a live host database is never closed because iteration rejected.
- Without `bindRun` the guard is absent and the stream loop adds no authorization
  promise or microtask per chunk.

Evidence: `assistant-subagents/durable-binding-and-usage.md`.

### Durable delegated usage

- Bound completion reports carry the public Mastra parent run/tool call and child
  thread/resource ids; the desktop child-usage writer resolves them to the
  authorized, published invocation and its original host leg.
- Migration 128's nullable invocation join leaves historical rows unattributed.
  Duplicate reports and cumulative resumed totals update ONE row with monotonic
  token maxima, never additive replay; model and provider cannot change on it,
  missing counts fabricate no rows, and local unbilled calls create none.
- Sum Mastra's prior completed `steps` with the current `usage` for the
  cumulative invocation total, approval resumes included.
- Meter through a `transient: true` custom data part so it cannot replace the
  native assistant message or alter its tool output, text or parent outcome.
- Queue bound reports until the matching parent result/error or finish, after
  native child publication has authorized its run; in-stream progress drains only
  after that identity is validated, and reports coalesce by invocation without
  replaying unchanged totals.
- The writer uses the run-critical foreground scheduler; an exhausted write fails
  visibly with a coded log and never silently drops billing, and identity errors
  name the failed boundary without guessing which SQL predicate failed.
- Lifecycle stays in `brainstrike_assistant_run_events`; delegation events carry
  `parentRuntimeRunId` alongside `parentToolCallId` so repeated tool-call names
  in different runs still join the exact invocation. Legacy events lacking the
  key are not fabricated into child history.
- Host-run retention preserves resumable invocations or explicitly removes the
  complete branch; there is no automatic sweep. Deleting a delegated conversation
  detaches its usage row's delegation keys while retaining the surviving root's
  spent tokens and cost, and resource re-keying is not a supported mutation of
  this immutable graph.
- Export the scripted model fixture through
  `@brainstrike/agent/test-fixtures/scripted-agent-model`; cross-package tests
  never import private source paths.

Evidence: `assistant-subagents/durable-binding-and-usage.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/delegated-runtime.integration.test.ts`,
`apps/desktop/src/__tests__/assistant-server/delegated-conversation-host.integration.test.ts`.

### Child stream error parity

- The nested tool-result reader shares the root mapper's display transformation
  and canonical guarded-error classification. A guarded child throw may arrive as
  a native `tool-result` WITHOUT `isError`; it must produce
  `subagent.tool.failed`, never `subagent.tool.completed`.

Evidence: `assistant-subagents/child-stream-projection.md`.

### Scoped child stream projection

- Durable native invocations use independent lifecycle/tool-name state and the
  root's mapper. Authorization precedes projection at every depth; child text
  and finish stay separate from the parent's compact delegation lifecycle.
- Independent `DataStreamMapper`s emit `brainstrike.delegated-conversation`;
  replay reuses encoded session events without remapping or duplicate events.
- Runless shell/MCP progress requires the exact native parent/delegation/persona
  and active child tool call; queued output for a known completed child is ignored
  without reopening it. Ordinary parts still require native IDs.
- Validated native pauses seed child starts after answered notices, before output,
  using authorized ancestry and saved message IDs, including granted siblings.
- **Consumed child envelopes.** `createDelegatedConversationTap` consumes routed
  `brainstrike.delegated-conversation`/`brainstrike.child-continuation` data before
  parent accumulation. Other data, including parent-indexed `part-start`, forwards.
- **Grouped parts render isolation.** `patches/@assistant-ui__core@0.3.17.patch`
  builds one leaf closure per `children` identity so a streaming part does not
  re-render every sibling leaf. Delete it when an upstream release carries the
  fix.
- The decoder belongs to the native INVOCATION, not to each observed message id:
  a resumed turn may move to a new native step id while the same decoder
  continues through its single terminal, with no second unfinished decoder and no
  discarded active tool part.
- The desktop observer persists child lifecycle events in ordinary child
  run/event records with a separate opaque host run id per native invocation and
  host resume leg. One atomic repository mutation revalidates ancestry, native
  run/persona and both original and current host turns before creating the
  header/event. The child model comes from its stored persona pin or the original
  inherited model; a malformed pin rejects rather than changing model.
- The history adapter attaches these events to their observed native message ids,
  so several resume legs share one assistant group. A child terminal or pause
  settles only its own projection, and if the parent ends while a child is open
  the child is cancelled on user abort or visibly failed for an interrupted
  stream.
- Active child calls receive an error tool result plus a paired failed/cancelled
  run event before synthetic termination; completed calls are not terminated
  twice. Execution-time measurements key on `(native thread id, tool-call id)`,
  and parent steering is not inherited.

Settled 2026-09-15 (do not relitigate): consumed child envelopes and the
grouped-parts patch — forwarding them grew one renderer to 15 GB. Evidence:
`assistant-subagents/child-stream-projection.md`.
Guard: `packages/assistant-ui/src/__tests__/delegated-conversation-receiver.test.ts`,
`packages/assistant-ui/src/__tests__/grouped-parts-render-isolation.test.tsx`.

### Cancelled child transcript durability

- Native delegation uses `lastMessages: false`, which also suppresses the
  automatic MessageHistory output processor, and the delegation's normal save
  happens after the child stream is consumed — root Stop can return before it.
- The child processor captures the public `MessageList`, memory scope and current
  native `messageId` at `processInputStep`. The root abort finalizer joins these
  child turns: each captures unsaved native messages on the OWNING attempt's
  abort signal, awaits Mastra's public `afterToolCall` hook around the delegation
  tool, then uses the same abort snapshot policy and awaited
  `Memory.saveMessages` as the root — retaining partial text, removing unfinished
  tool calls, appending the abort marker, never inventing a child message id.
- The owner signal from `buildStreamOptions` governs both snapshot capture and
  normal-finish classification; the child's propagated signal can lag and cannot
  turn an already-cancelled owner turn into a normal finish.
- `onDelegationComplete` alone is not a sufficient join — core 1.64 skips it on
  suspension and when resolving child instructions outside its execution
  try/catch. Use the per-attempt tool hook with the same owning signal and
  observed native tool-call id; it runs after success, execution errors and
  suspension.
- Construct this capability only with an explicit root memory scope and a memory
  instance, and install the root tool hook only for legs with active delegation;
  missing native child identities are errors once it is active.
- All three attempt legs require the owning abort signal at stream-option and
  delegation configuration boundaries, and child saves join before a watchdog
  attempt is replaced and before runtime disposal. Establish ordering through
  `runTurnAttempts`' generator finalizer — never sleeps, retries or timeout
  changes.

Evidence: `assistant-subagents/child-transcript-durability.md`.

### Child tool input transport parity

- The shared encoder transmits complete tool input through `c` argument deltas
  BEFORE the `9` completion frame whenever `b` already started the call: the
  pinned assistant-stream decoder ignores `9.args` for an existing call, so `b`
  immediately followed by `9` displays `{}`.
- The completion helper emits complete input when no deltas have flowed, or the
  missing suffix of a compatible partial prefix, then closes the input; empty
  containers and native tool-error args take the same path. An incompatible
  authoritative input closes once and fails the session visibly with preceding
  text retained — never a second JSON object, never retried by terminal error
  handling.

Evidence: `assistant-subagents/child-transcript-durability.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/delegated-stream-parity.integration.test.ts`.

### Child lifecycle ordering on reload

- Oversized child outputs pass through the parent's central artifact-settlement
  policy after child permission selection and before projection at the child's
  own model budget. Migration 129 distinguishes native execution threads within
  the root-owned artifact scope, so sibling calls may reuse tool-call IDs.
- Root artifacts retain the host-bound thread identity rather than accepting a
  tool-supplied execution scope; missing native child identity or a missing
  permission-eligible reader is a visible error.
- User personas without an explicit tool list include the read-only artifact
  reader by default; an explicit list stays authoritative and never gains tools
  implicitly.
- A scoped lifecycle start anchors on its existing native message/tool-call
  identity, not timestamps alone. Multiple matching tool boundaries stay
  distinct, and removed unfinished calls keep their failure journal without
  fabricated tool parts.
- Hydration deduplicates tool calls WITHIN one assistant group, preserving
  progressive snapshots without removing a same-id tool in a later turn or a
  regenerated sibling; native message assignment precedes tool anchoring.
- A scoped completion or failure cannot precede its persisted tool part when the
  journal has no start event. The tool boundary is only a lower bound for
  terminals: their timestamps still preserve text streamed while the tool ran.

Evidence: `assistant-subagents/child-transcript-durability.md`.

### Renderer receiver and native transcript ownership

- The optional `onDelegatedConversation` callback receives full, EPHEMERAL child
  snapshots through the ordinary decoder and accumulator, keyed by native
  invocation across observed message changes. Full replay replaces snapshots,
  native memory remains the sole transcript writer, and missing terminals or
  unseeded/mismatched replay openings fail visibly.
- Receiver completion uses the same `deferMessageFinishUntilFlush` transform as
  the parent; both final part streams and descendant receivers settle before a
  complete snapshot publishes. Producer failures and cancellations still emit
  their required `d` finish frame — an error frame alone is a truncated stream,
  not a valid child terminal.
- Consumer presence selects receiver installation at run start; an installed
  receiver reads the latest committed callback on each update, replacement during
  an active run included, and retains its FIRST observed failure.
- Lifecycle and remaining acceptance scope: `assistant-runtime.md`.

Evidence: `assistant-subagents/child-transcript-durability.md`.

### Native child response boundaries across resume

- Persona children install `createResponseBoundaryProcessor` through Mastra's
  public `processOutputStep` hook: a response step without tool calls marks its
  last native assistant row with `MessageList.markResponseMessageBoundary`, while
  tool steps stay open for their results and ordinary continuation.
- The processor mints no message IDs, removes no repeated text or tool content,
  and leaves existing content intact when reporting it. A boundary miss is an
  explicit integrity error, never permission to persist ambiguous history.
- Why: at core 1.64.0 `Agent.#executeOnFinish` re-adds response rows to the same
  message list, so after approval resume rotates the native assistant ID an
  earlier row's text could merge into the new continuation row. Use the public
  processor/message-list API — no vendor patch, no second content writer.
- A declined call hydrates from its persisted `output-denied` row into the shared
  live decline envelope with its original arguments and reason, reporting neither
  success nor failure. An already persisted valid decline result stays
  authoritative; native denials without a result use the shared constructor.

Evidence: `assistant-subagents/child-transcript-durability.md`.

### Exact delegated decision identity

- A delegated pause carries its observed root-to-leaf native invocation path and
  the LEAF tool-call ID. The root run/call is Mastra's transport target, not the
  decision identity — core 1.64 reuses that root alias when a child pauses on
  another tool — so notices, notification dedupe and rediscovered message
  identities key the leaf run/call, and parent and child views send the same
  canonical root action plus the immutable leaf guard.
- The host reauthorizes every edge against the owning root, original turn, native
  child run, persona and parent thread, using public `Agent.listAgents` /
  `Agent.listSuspendedRuns` under those observed scopes. Never derive
  resource/thread IDs from native ID strings; a missing or ambiguous pending leaf
  rejects before execution.
- Repeat snapshot validation AFTER acquiring durable root admission: another
  resume can finish between the initial read and admission.
- Migration 131 retains a unique leaf decision record and permits one claimed
  decision per root. Runtime disposal settles only its own claims; startup
  reaping marks abandoned claims interrupted and retains their identity, without
  replay.
- An interrupted leaf is TERMINAL with NO recovery path: only a `claimed` row can
  be consumed or released, the card renders as settled, and its background task
  stays suspended. A session grant SKIPS such a sibling rather than failing the
  grant over it.
- The record describes ADMISSION, not whether an effect succeeded. If a
  post-admission recheck — or any later failure before the approval leg invokes
  native resume — fails, roll back only that binding's matching UNEXECUTED claim
  and propagate, releasing through the owner that took the claim. Subsequent
  native failures or cancellation do NOT release the leaf: the effect may already
  have occurred.
- Disposal attempts all cleanup owners in order and preserves multiple failures
  in an `AggregateError`, never logging and swallowing a failed settlement.
  Construction failures on every leg retain both the original failure and any
  disposal aggregate as the typed error's cause — the runtime-wide construction
  error contract in `assistant-runtime.md`.
- The parent's original model invocation is captured by the native
  `beforeToolCall` hook through the public `MessageList` adapter before
  delegation starts and stored on the immutable invocation
  (`onDelegationStart.messages` omits the current call in core 1.64). Missing
  original input refuses both approval and decline visibly.
- Keyless rediscovery walks the same authorized graph with INERT Agents at the
  original persona IDs: no tools, no provider credentials, no workflow resume.
- `delegated-process-restart.integration.test.ts` runs three Node processes
  against one on-disk PGlite database in the existing desktop integration lane —
  no bespoke CI lane. Its processes resolve public package exports, so desktop
  `test:integration` and `test:coverage` declare exact
  `@brainstrike/agent#build` and `@brainstrike/assistant-data#build`
  dependencies; direct Vitest invocation needs those builds first.

Settled: an interrupted claim is terminal, and admission never asserts that an
effect succeeded. Evidence: `assistant-subagents/delegated-decision-identity.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/delegated-process-restart.integration.test.ts`,
`packages/agent/src/mastra/__tests__/delegated-tool-actions.spec.ts`.

### Durable delegated decision recovery display

- The suspended-runs endpoint annotates each rediscovered native leaf with its
  durable admission state, scoped by owner, root, root transport call and leaf
  run/call. `claimed`, `consumed` and `interrupted` all mean the decision cannot
  be resubmitted and none asserts the effect succeeded; a later leaf behind the
  same parent alias stays independently actionable. Discovery only READS
  admission records and never creates a pause from them.
- Existing approval, question and plan cards keep their original content and show
  the admission status with controls locked. Unknown present states fail wire
  validation, and explicitly undefined or inherited fields are invalid, not
  absent.
- Only a pause without a durable decision is actionable; claimed, consumed,
  interrupted and cancelled pauses never mark sidebar attention, and staleness
  without admission state stays advisory. Status refresh uses the existing thread
  reload — no polling, no auto-resume.
- The decision-state SQL joins the deduplicated root-run/root-call/leaf-run/
  leaf-call tuples over the returned pauses only, so ordinary pauses need no
  extra decision-database read. A failed query or invalid saved state is a
  visible discovery error and must never become an empty annotation map that
  re-enables a consumed leaf.
- Interrupted claims offer no retry, and follow-up or cancellation controls never
  erase the original admission record.

Evidence: `assistant-subagents/delegated-decision-identity.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/delegated-conversation-host.integration.test.ts`,
`apps/desktop/e2e/assistant-approval-reload-linearity.desktop.test.ts`.

### Forwarded interactive pause presentation

- A native parent suspension names its delegation tool while the decision belongs
  to the leaf. The authorized recursive projection retains the observed leaf
  pause and restores its tool name, payload/arguments and resume schema before
  the shared mapper classifies approval or typed-resume support; transport
  coordinates stay unchanged and the leaf guard owns decision identity.
- The prepared pause forwards ONLY decision payload/schema and transport
  coordinates. Native row IDs and provenance come from the original part, and the
  prepared value is never written back to native memory or used as a stream
  replacement.
- Retain the observed registered leaf tool ID separately from its display name so
  sanitizer collisions cannot remap a resolved ID. A changed pause kind throws —
  substituting approval for a question would expose the wrong action — and must
  not return an actionable wrapper as a fallback.
- Unbound or unrelated parts keep ordinary mapper behaviour, and genuinely
  unregistered leaf tools still emit the visible unsupported-resume event.
- Pending aliases live only for the current stream attempt; resume creates a new
  projection. They are not a cross-resume cache.

Evidence: `assistant-subagents/delegated-decision-identity.md`.

### Child history boundary for a live stream leg

- A child decoder contains ONE host stream leg, not a complete conversation. Its
  latest observed message id cannot remove or replace a history row: native
  resume can update a previous row's tool result and append continuation text in
  another row, and identical text before and after a pause is legitimate content.
- The desktop binding captures an immutable history baseline AFTER the exact leaf
  decision is claimed and its native snapshot validated, and BEFORE invoking
  native resume. Every ancestor on the admitted path uses the ordinary
  `@brainstrike/db` history readers, including rewind tombstones, message parent
  topology and the existing hydration window; all reads must succeed before any
  baseline publishes.
- A different leaf cannot borrow the claim, and releasing an unexecuted claim
  clears its snapshots. For a newly created invocation only already persisted
  input rows belong to the baseline — the current assistant output belongs to the
  decoder.
- The FIRST delegated envelope carries the baseline with authoritative child
  thread and host-leg ids (abnormal termination carries it if no earlier
  renderable chunk did). Later envelopes cannot introduce or replace it, replay
  recreates the decoder and replays the same boundary, and these snapshots are
  ephemeral stream data: native Mastra memory remains the writer.
- Capture or validation failure stops admission and releases the unexecuted
  claim; it must never omit history and proceed as if the view were complete.
- The readers and native row conversion live in the Node-compatible DB package,
  not the renderer-facing `assistant-data` entry: Electron main externalizes
  workspace imports as CJS requires, so a browser-only export can type-check and
  still prevent launch. The DB unit and browser test projects must resolve the
  reader's `assistant-contract/run-events` subpath BEFORE the root package alias.
- Concurrent binds share a single in-flight initial history read. Mastra 1.64
  creates a new child thread per delegation, so the initial baseline contains
  input, not an earlier child turn, and a consumed decision retains its baseline
  until that host leg ends.

Evidence: `assistant-subagents/child-view-binding.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/delegated-resume-parity.integration.test.ts`.

### Host-owned child view binding

- The shared child view combines the baseline with its live leg through the
  public assistant-ui external-store runtime and converter, which updates a
  repeated tool-call id in place, preserves identical text either side of a
  resume, and replaces only the active history head.
- The app-shell child store publishes complete snapshots scoped to an exact
  native invocation and authoritative child thread. Current-leg replay replaces
  the prior snapshot, a superseded leg cannot overwrite an admitted continuation,
  and view unsubscription does not clear the host's output — closing and
  reopening a view neither invokes a model nor loses output produced meanwhile.
  The store coalesces streaming notifications to one per 16 ms window.
- Accept a child decision only if its validated native ancestry includes that
  view's invocation; a live snapshot supplies live identity, a restored view
  resolves against the durable graph, and both still require native host
  authorization. Action metadata and run configuration go through the OWNING ROOT
  runtime without the child's message parent/source ids, and ordinary follow-up
  prompts are not decision messages.
- Opening a child view must never construct another inference runtime;
  `AssistantUiPanel.onRuntimeReady` registers the owning runtime and its cleanup
  runs on disposal.
- The workspace owns the ephemeral root registry, keyed by owner resource and
  root thread together. Snapshot reads are pure; committed subscriptions acquire
  a lease per mounted owner or child view, and releasing the final lease evicts
  the root and clears its converted transcripts. Cleanup and registration are
  identity-aware: a stale cleanup cannot evict a replacement, and decision append
  rejects a retargeted handle.
- Child tab addresses encode owner, root and child identifiers and use the
  existing selection store's singleton/open/close/hydrate behaviour. An address
  is NOT authority: the durable graph still authorizes history reads, and
  malformed reserved addresses surface as errors rather than disappearing during
  restoration. `DelegatedWorkspaceTabsProvider` registers saved addresses before
  the ordinary provider reconciles selection, resolving graph ownership and
  persisted callsign/color before mounting a transcript; unselected restored tabs
  load metadata only, retained only while the tab is open.
- A live host snapshot replaces the saved projection with its own baseline and
  continuation, and opening either view never invokes `onNew`. An explicit search
  hit extends a child baseline backwards through bounded native history pages
  while retaining the host's current head and live controls.
- The subagent card's Open conversation action is separate from its collapse
  toggle and absent until the workspace supplies a navigation capability. It
  binds the exact parent tool-call id to its host baseline thread id;
  contradictory addresses surface as card-local alerts, never a throw from the
  streaming selector. A pending lookup failure stays visible beside the action,
  which clears it and performs ONE fresh lookup on explicit retry — the shared UI
  never polls or silently retries a host binding.
- A child reopened after renderer restart has no live snapshot identity: its
  persisted-decision resolver validates owner, root, parent run, parent call,
  child run and persona. Same-persona siblings are never interchangeable, and the
  owning runtime must exist before lookup and be the same after it.
- Child pause rediscovery queries the owning root's thread/resource, then
  projects only paths whose durable invocation belongs to the selected child;
  root-only and sibling pauses are omitted, and missing or conflicting bindings
  surface an explicit discovery error while known transcript content and valid
  recovered decisions stay visible.
- The shared action bar reads the public runtime `capabilities.reload` before
  rendering regeneration: a child without an `onReload` adapter must not
  advertise it, and enabling the composer or a generic `onNew` dispatcher does
  not authorize it. Copy stays available.
- Keep component exports and hooks in separate modules so Fast Refresh preserves
  state, and remove metadata cache entries from the selection store's
  close/hydrate notification rather than a synchronous setState during an effect.
  Shrink-only wrapper budgets ratchet DOWNWARD after extraction, and ESLint
  warning baselines must not increase to accommodate a boundary.
- Attachment identity keys on capability PRESENCE, so disabling a model's vision
  support does not discard already staged attachments.

Evidence: `assistant-subagents/child-view-binding.md`.
Guard: `packages/app-shell/src/__tests__/delegated-child-reload.integration.test.tsx`,
`packages/app-shell/src/__tests__/assistant-ui-panel-wrapper-runtime.test.ts`.

### Waiting-turn cancellation and native child control

- `POST /assistant/cancel` records cancellation against the owning
  resource/root/turn BEFORE aborting registered legs. A completed host leg is
  eligible only while public native suspended-run discovery still finds one of
  that turn's root invocations, and native snapshots stay Mastra-owned: none is
  edited or used as application state.
- A cancelled original turn rejects a newly created resume leg in the atomic
  durable admission statement, and both native attempt legs recheck the owner
  signal after awaited admission, before invoking resume.
- Server and renderer terminal writers preserve an existing cancelled status.
  Acknowledgement waits for teardown, then finalizes even when the normal
  terminal write preceded unregister; completed earlier legs keep their status
  unless they are the specifically requested waiting leg.
- A native pending decision with no admission record in a cancelled turn gets the
  explicit non-actionable `cancelled` display state, never a fabricated
  admission. Cancellation is cooperative for work already executing, never
  rollback.

Evidence: `assistant-subagents/child-view-binding.md`.

### Child interactive production entry

- Custom personas may explicitly declare askUser and submitPlan; their maps reuse
  the parent runtime's canonical `resolveSuspendToolsForRun` gate with the
  complete durable child-decision capability as the availability condition. That
  gate is INDEPENDENT of permission-ask flags: a read-allow self-suspending tool
  still requires storage, exact routing, admission and settlement.
- Default built-in toolsets, read-only enforcement and parent-owned task lists
  are unchanged.
- A child plan approval never exits the ROOT's plan mode, including when its
  forwarded notice is acted on in the parent panel.

Evidence: `assistant-subagents/child-view-binding.md`.

## Recursive work admission and cancellation

- The root host owns invocation and output counters in migration 132; host run,
  resource, original turn and complete ancestry are validated inside the
  admission transaction. Duplicate native admission consumes no extra invocation,
  deleting a child never refunds spent allocation, and step reservations survive
  database reload.
- A turn created before budget admission existed cannot start fresh child
  inference or admit another sibling — the visible error asks for a new parent
  turn — and invocation rows without their original budget never seed fresh
  counters.
- **Admission is answered at delegation START, and a refusal never kills the
  root.** `DelegatedBudgetPort.admitInvocation` (`delegated-tree-admission.ts`)
  evaluates depth, invocations and the output summary reservation before any
  native child exists; it RESERVES nothing but opens the root and the turn's
  budget row idempotently and takes the row lock. `createDelegationConfig`
  consults it in `onDelegationStart`, and a refusal returns `proceed: false` with
  the host's reason, which Mastra hands the model as `[Delegation Rejected] …`. A
  host IDENTITY refusal at start becomes a rejection too — nothing has run, so it
  costs one delegation, never the root. Only deliberate budget and identity
  refusals become that answer; a database or schema fault propagates.
- The reservation at persist time remains the authority (same checks, now
  mutating), so a sibling race can still refuse there. That refusal is non-fatal
  too: it runs inside the child's input processing before the child streams a
  part, so Mastra turns it into that delegation's tool error (`subagent.failed`,
  no `rejected` marker) while the root continues.
- Two rules make any refusal survivable: `resolveChildDelegation`
  (`delegated-stream-projection.ts`) treats same-run-id nested output as NOT a
  child stream and binds nothing, because Mastra streams a refused delegation's
  text through the parent's writer under the parent's run id; and every
  `DelegatedConversationIdentityError` escaping the host is logged at error level
  with its bounded `reason`, method and host run before it propagates.
- Each leg's runtime shares one FIFO queue of `maxConcurrentWork` active
  model/tool operations across all descendants. Model permits end before
  native tool/delegation execution and a delegation wait acquires no permit, so
  more child streams may be admitted than are runnable. The in-flight backstop
  is disabled only when both the durable budget and the shared queue exist.
- Synthesis forces `toolChoice: none` with no active tools and rejects a provider
  tool call before execution even if the provider ignores that request.
- **Child budgets are USER SETTINGS; a cut synthesis is a truncated completion.**
  Tree/per-child limits and the runtime limit are `RuntimeSubagentSettings`
  (`subagent-settings.ts`, ranges `SUBAGENT_SETTINGS_LIMITS`), persisted by
  `assistant-subagent-preferences.v1`, edited in Settings → Subagents → Subagent limits,
  sent on EVERY request as `runtimeData.subagentSettings`; the ONLY intake is
  `parseRuntimeSubagentSettings` (absent → defaults, malformed THROWS) and no
  limits constant exists. What the budget row stores at first admission is
  TURN-scoped: a later leg runs under `applyTurnSubagentLimits(request,
  budget.readTurnLimits())`; only `maxConcurrentWork` / `maxChildRuntimeMs` are
  per request. A host leg on a child thread is refused (`resolveDelegatedHostScope`).
- The host's synthesis reservation names its `cap` (`steps` / `child-output` /
  `tree-output`) and the numbers behind it. `delegated-work-budget.ts` reads
  Mastra's `finishReason` on `processOutputStep`, records the outcome in the
  per-runtime `DelegatedSynthesisOutcomes` registry keyed by native child thread
  id, and streams the transient synthesis part. Three readers consume it:
  `makeTerminalRunEvent` maps a `length` finish on a TRUNCATED synthesis to
  `run.finished` / `outcome: 'truncated'`; `onDelegationComplete` reads the
  REGISTRY, never the projected stream, because the hook runs before the parent
  consumer maps the child's parts; `resolveTruncatedAnswer` appends the
  `[Truncated summary]` note to `resultText`. Empty text stays `no-answer` even
  when a synthesis was truncated.
- Settlement charges ALL reported tokens — a provider may cap visible text while
  billing reasoning on top — and throws
  `DelegatedOutputReservationExceededError` only AFTER the transaction commits.
  Only a reserved synthesis ending with `length` and no tool calls may retain its
  partial findings after that error, staying visibly truncated, disclosing actual
  versus reserved tokens, and reserving no further step. Working-step overages,
  tool calls, uncut summaries, duplicate settlements and persistence failures
  still reject.
- Every child stream creates its own budget processor. Admission uses the
  INVOCATION signal from the conversation binding (it already includes host-leg
  cancellation) composed with the processor signal when present, and releases a
  held permit on abort — Mastra 1.64 can omit the processor abortSignal during
  unwind and does not call user `onFinish` on abort. Admission also includes the
  native executor deadline captured by the delegation hook, otherwise a timed-out
  child strands a work permit; without a bound invocation it uses the host-leg
  signal. A deadline stays failed/timed_out rather than cancelled.
- Cancellation is the existing `subagent.failed` event with `cancelled` status,
  not a new kind; add no timeout or detached executor, since the native
  completion join still owns draining.
- Grandchild navigation before completion resolves the exact persisted invocation
  from its subagent event's parent runtime/run-tool identity, within the selected
  child's authorized root and parent thread. The card reads its OWNING message,
  never a call-ID-only scan across turns — providers reuse call IDs — and host
  child-event attribution must not overwrite a nested event's own
  `parentToolCallId` or `personaId`.
- Native completion `success=false` is captured by parent native run and
  tool-call identity, separately from no-answer: Mastra's projected result can
  omit `finishReason` even after a provider failure, so the mapper uses the
  authoritative HOOK outcome rather than labelling the tool-result completed.
  Other ancestors may still complete after handling the failure.
- Delegation cards use tool-input task text and authorized live publications
  keyed by parent run/tool call, never retaining child stream in parent message.
  Owning workspace repository validates actual parent and supplies durable
  name/color; missing or contradictory live/result identity is a visible error.
- A child-open request made before the workspace repository is available fails
  visibly and clears its session intent; boot hydration cannot replay it.

Settled 2026-09-14 (BST-1751): admission answers at delegation start. Settled
2026-09-15: child budgets are user settings, and a truncated synthesis is a
completion the root can use. Evidence:
`assistant-subagents/tree-admission-and-budgets.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/delegated-tree-limits.integration.test.ts`,
`apps/desktop/src/__tests__/assistant-server/delegated-budget-settings.integration.test.ts`,
`packages/agent/src/__tests__/delegation-rejection.integration.spec.ts`,
`packages/agent/src/__tests__/delegated-work-budget.integration.spec.ts`,
`packages/agent/src/__tests__/delegated-synthesis-outcome.spec.ts`,
`packages/assistant-contract/src/__tests__/subagent-settings.test.ts`.

### Background worker execution and pending controls

- Persona delegation defaults to nonblocking native BACKGROUND execution when
  desktop run-scoped memory supplies `backgroundTaskScope`; the native
  `_background` argument retains foreground selection, and recursive descendants
  run foreground inside the background child under the same durable limits.
- `projectBackgroundStream` (`background-stream.ts`) folds native task events
  into the host stream. A `background-task-output` carries either a child
  envelope or a RAW `data-*` chunk and both forward unchanged; only a non-data,
  non-envelope chunk is a contract break. A forwarded `data-*` part keeps the
  CHILD's `runId` — attribute by that id, never by position in the host stream.
- **ONE DELIVERY PER BACKGROUND CALL** (settled 2026-09-15, do not relitigate).
  `patches/@mastra__core@1.71.0.patch` makes the background executor's
  `outputWriter` publish to the TASK only, and `projectBackgroundStream` throws
  on a background call's `tool-output` on its dispatching turn as the backstop if
  that patch stops applying. It also DROPS a turn's `tool-call-approval` /
  `tool-call-suspended` for a call known as background, logging
  `background_turn_copy_dropped` once per call, and throws if a turn copy arrived
  before the turn acknowledged that call's dispatch. Because the task is the only
  delivery, the background manager's `progressThrottleMs` must stay UNSET. A
  resume leg's host executor writes only to its own stream.
- **The HOST owns retries (none, ever) and the deadline.** A scoped
  `createTask()` pins model-requested retries to 0 and `timeoutMs` to the host's
  `resolveChildTaskTimeoutMs`, logging `background_task_retries_pinned` /
  `background_task_timeout_pinned`, and the delegation dispatches; `updateTask`
  rejects either change. The root's instruction states subagents run as
  background workers and `_background` is host-owned.
- A background child's SUSPENSION closes the parent stream for that iteration
  with no finish part, so the leg that observes it ends as a PAUSE: the initial
  leg and `createBackgroundResumeStream` both report `suspended`,
  `readNativeStreamStatus` ends the leg with a `tool-calls` finish, and the
  withheld child notice publishes.
- **The parent model is NEVER woken by a child's suspension** (settled
  2026-09-14, do not relitigate). The host does not pass `untilIdle`; every
  parent inference uses public `waitTimeoutMs: 0` and is wrapped by
  `withBackgroundIdleLoop` (`background-idle-loop.ts`), which mirrors Mastra's
  loop except that only a RETURNED, FAILED or CANCELLED task queues a wakeup. A
  suspension is a host-surfaced approval prompt; the model is not the messenger.
  The loop judges no silence: running work holds the leg open until its
  terminal; each child's own watchdog (`assistant-runtime.md`) judges liveness.
- **WAKEUP LEDGER** (settled 2026-09-15, do not relitigate): a parent wakeup is
  the whole LEDGER of this turn's background invocations, not one line per event.
  Read it from the DURABLE task rows (`background-ledger.ts`), scoped to the runs
  the host mapped to this GENERATION (migration 140) UNION the runs the leg
  observed itself — never the loop's `running`/`settled` sets. List every
  invocation as returned, failed, cancelled or still running, and say nothing is
  still running only when that is true; a SUSPENDED task is "still running". The
  idle loop, the resume stream's parent wakeup and the parked-root deferral read
  the same source, and the same ledger reaches the user as the
  `delegation.ledger` run event (`assistant-persistence.md`), published on every
  lifecycle change and joined before the leg closes.
- **ACTIVE PARENT STEPS:** root stream options refresh the same
  generation-scoped ledger and compact saved terminal outcomes before each input
  step, continuations included, because the idle loop queues terminal wakeups
  while a parent turn is streaming. One owned native `context` message is
  replaced before the input token limiter; it stays user-role tool data, is not
  drained into durable history, and starts no inference. Child-runtime legs do
  not install this processor, durable read failures propagate rather than
  publishing from a stale ledger, and the loop drops queued wakeups only after
  the active native turn SUCCEEDS — failed, aborted, unknown-status or parked
  turns retain pending delivery, and an altered notice stays unacknowledged.
- An approval for work parked before migration 140 can lack the durable native
  run mapping that names its generation. Approval preparation validates that
  mapping before recording policy-granted sibling answers or starting a native
  resume; the typed refusal releases the claim, leaves parked work unchanged, and
  tells the user to Stop or cancel. A new user request mints its own generation:
  the host never guesses an old one or replays unknown effects.
- **REJECTED ADMISSION IS NO INVOCATION** (settled 2026-09-15, do not
  relitigate). Mastra runs `onDelegationStart` INSIDE the task it already
  created, so a refusal still writes a task row that completes normally. The
  leg's `DelegationOutcomeCapture` reaches `withBackgroundIdleLoop` and
  `createBackgroundLedgerSource` as `rejectedDelegations`, required on both so
  neither can forget it: the refused terminal wakes nothing and is no ledger
  entry, while the model still reads the refusal as that call's saved result.
- The capture is leg-scoped and in memory, so the LEDGER also asks the host's
  invocation graph: a `completed` row whose dispatch address
  `resolveParkedInvocation` answers `undefined` for was refused, whichever leg
  dispatched it. Only a `completed` row asks — the child's `inputProcessor`
  awaits `persist` before it streams a part, and Mastra writes `completed` with
  the executor result. A host that CANNOT answer FAILS the read
  (`background_ledger_read_failed`, no row published, the wakeup fails loudly)
  and does not remember that failure. Never sniff the `[Delegation Rejected]`
  result text — a child can echo it.
- DURABILITY is part of the binding contract, stated on
  `resolveParkedInvocation`: an invocation, once persisted, stays resolvable from
  its dispatch address for the life of the parent thread. Nothing prunes
  `brainstrike_delegated_invocations`; a host that added pruning would silently
  stop counting a child that ran.
- The idle loop's bound is explicit: once more distinct background tasks wake the
  parent in one leg than one original root turn may admit invocations
  (`subagentSettings.maxInvocations`), the leg FAILS naming the numbers and logs
  `background_parent_wakeup_limit_exceeded` — never a silent close. A task wakes
  a leg at most once. The bound counts background TASKS, which equal delegations
  only because persona delegations are the sole background-eligible tools
  (`buildBackgroundAgentOptions`). **A new background-capable tool must revisit
  this bound and the ledger's graph question.**
- **EVERY parked leaf decision has a card in the ROOT thread** (settled
  2026-09-14). A foreground child's pause suspends the parent run, so Mastra's
  parent-level pause becomes that card once `decorate()` addresses it to the
  leaf. A background child's pause suspends nothing, so `withRootPauseNotices`
  (`root-pause-notices.ts`) synthesizes, for each child-scoped notice whose leaf
  has no root-level notice, a root card addressed to the ROOT edge (`path[0]`)
  with the leaf tool, args and risk metadata, preceded by the durable
  `tool.approval.requested` row for the delegation call; a foreground pause gets
  no duplicate. The card names the child: persona label plus the prompt.
- A background child's pause publishes LIVE — its scoped notice and synthesized
  root card leave the leg the moment its TASK is durably parked. The pause chunk
  streams before the storage row is suspended, so the notice is parked
  (`withholdPauseNotices`) and released by the native `background-task-suspended`
  part: a card must not exist before its decision can be applied. Only a
  FOREGROUND pause is withheld to the completion join.
- **PAUSE TERMINAL:** a background child's pause FINISH is the child view's
  TERMINAL frame — the receiver closes the child on it and throws on any later
  frame, tearing the root stream down. A parked child is not finished, so
  `releaseParkedNotices` HOLDS that finish in the leg's held notices and
  `dropHeldPauseFinish` discards it when `background-task-resumed` arrives.
- **REPEATED SUSPENSIONS:** one suspension can reach the host loop more than
  once, while a task resumed in-process legitimately suspends again later.
  `createSuspensionLedger` keys every suspension by Mastra's `suspendedAt` stamp
  — a repeat of a handled stamp is the same pause and is dropped — in the idle
  loop and the resume stream's terminal wait.
- **PARKED PARENT:** a parent turn ending on the PARENT's own pause parks the run
  on the user, and no wakeup runs a continuation on it. `withBackgroundIdleLoop`
  reads each piped turn's status: parked with children running keeps the leg open
  until they return; parked with nothing running closes the leg as the pause it
  is, dropping queued wakeups with
  `background_parked_parent_wakeups_deferred`.
- **LATE RESULTS AFTER A ROOT PAUSE:** Mastra's approve/resume restores the
  message list snapshotted at the pause, in which every still-running child is a
  dispatch acknowledgement, and replaces any `context` the resume is given. Three
  host rules close it: `listLateBackgroundResults` selects the finished tasks
  THIS run dispatched whose `completedAt` is not before the run's `suspendedAt`;
  `late-background-results-processor.ts` overlays them onto the acknowledgement
  tool results at the provider boundary on every request of the resumed run,
  FIRST in the leg's per-call processors, using the same text-only projection
  stored beside the raw durable child result; and a child card answered on a NEW
  leg while the root is parked resumes the child only, ending that leg as a
  pause. The PGlite message commit boundary also overlays terminal task rows on
  every native save, so no save restores stale acknowledgements.
- **CHILD PROVIDER COMPAT:** `buildChildProcessors` carries
  `OpenAIDuplicateItemCompat` for non-worker personas too, resolved against the
  CHILD's own provider like its error processors.
- **LIVE DECISIONS** (settled 2026-09-14, do not relitigate): a decision reaches
  the RUNNING leg. `live-decision-channel.ts` holds one channel per runtime; the
  background phase driving the stream owns it and hands out RESERVATIONS that
  keep the phase from settling until the reserved tasks are resumed or released,
  COUNTED per reservation because two deliveries can name the same suspended row.
  `armLiveDecisions` (`live-decisions.ts`), armed by every leg, validates against
  the live native snapshot exactly as a click would, validates the parked
  siblings the request's FRESH snapshot allows, records the answer and theirs as
  consumed in ONE all-or-none write (a refused answer records nothing, so the
  user's pause stays answerable; a sibling already answered durably is SKIPPED by
  discovery), publishes `tool-approval-answered` on the leg's own stream, resumes
  in-process, and REMEMBERS a lasting grant. Desktop transport:
  `registerDesktopDelegatedDecision` keyed by the steerable host run id, and
  `decide-endpoint.ts` (400 shape / 404 no live run / 409 host refusal with
  reason / 500 resume failure).
- Two in-process facts a fresh resume leg never met: the delegation config's
  per-leg caps count a RESUMED address once, and the delegated projection REOPENS
  a child that finished on a pause when its continuation re-enters. The parent
  still wakes only on returned/failed/cancelled work, so a decision on an
  all-parked turn takes the ordinary new-leg path.
- **SESSION GRANT STOPS ASKING** (settled 2026-09-15, do not relitigate): after a
  live "Allow <category> this session" the next gated call of EVERY child in the
  leg simply runs — no suspension, no card, no resume. `applyLiveApprovalGate`
  (`approval-gate.ts`) clones each kept ask tool with the PUBLIC FUNCTION form of
  the per-tool flag, which Mastra evaluates on EVERY tool call, and that function
  forwards to `createApprovalGate` — the agent's OWN ask set plus
  `runtime.liveDecisions.remembered`, read per call — so a mid-stream child is
  lifted on its very next call. Never a static `requireApproval: true`: Mastra
  copies that boolean once per stream call. NEVER synthesize a run-wide
  `requireToolApproval` predicate: any truthy run-wide gate forces every step to
  concurrency 1. Remember the grant once the host has recorded the decision and
  strictly BEFORE every `manager.resume`. Persisted "Always allow" policies work
  through the same flag.
- **RESUMED EXECUTORS:** every background phase (including the root's idle
  phase) owns its live decision seam (`channel.own`) before preparation. Before
  recording any approval answer, prepare every selected executor; register it
  before asking Mastra to resume. Preserve a native context still owned by the
  same runtime. A preparation failure leaves approvals answerable; every
  context the leg registered but Mastra never accepted is deregistered when the
  leg ends, and a refusal drops ONLY a context the leg still owns.
- Registration is SINGLE-FLIGHT per task: every caller shares the one live
  registration, so Mastra's context is never replaced, the task is never resumed
  twice while it runs, and it is never deregistered. Retirement is by GENERATION,
  not by forgetting the registration: every terminal raises the task's
  generation, and a registration landing on a stale generation commits nothing.
  The full state table is the module doc of `createResumedExecutors`
  (`background-resume.ts`) — keep it in step with that code.
- The leg's pause branch joins each resumed execution, and a join exists only for
  a task Mastra accepted; it settles when its executor settles or when Mastra
  publishes a terminal. Completed, failed and timed-out publish only AFTER the
  execution settled, and only a CANCEL publishes while it is in flight. Because
  the leg can close while a tool still runs, output written afterwards is dropped
  with `background_resume_output_after_close`, never thrown back into its
  execution. A SUSPENSION never settles a join.
- KNOWN LIMITS: the root's own foreground pause while children run is not
  live-deliverable and queues (404); a queued decision whose pause a root Stop
  cancelled dispatches and fails visibly (`run.failed`), never silently
  discarded; from the moment the resume stream's terminal wait ends until the
  parent wakeup starts a decision is `'no-live-run'` and queues, because
  `createTerminalWait` closes before it resolves and `reserve` refuses a closed
  wait.
- OPEN (foreground children, i.e. web): a sibling that has not yet paused when
  the parent run suspends on the first child's approval is not surfaced live; its
  pause appears on reload through rediscovery.
- A scripted transport fixture identifies root and child calls from their TOOL
  SURFACES, not the last user message: root context can end with a ledger
  refresh, and a wakeup quotes each child's prompt. Tests of new native
  continuations use `recordWakeup`, not the ledger header.

Settled 2026-09-14/15 and pinned by the named tests. The multi-approval matrix
(per-category grants, worker edits, reload, live rows) is in the evidence files;
its presentation and child-view halves are contracted in `assistant-runtime.md`
(PERMISSION ENGINE, "PARKED SIBLINGS", SWARM-AWARE PRESENTATION, CHILD VIEWS
READ THE ROOT'S ANSWERS). Evidence:
`assistant-subagents/background-delivery-and-ledger.md`,
`assistant-subagents/background-pauses-and-live-decisions.md`.
Guard: `packages/agent/src/mastra/__tests__/background-stream.spec.ts`,
`packages/agent/src/mastra/__tests__/background-idle-loop.spec.ts`,
`packages/agent/src/mastra/__tests__/background-ledger.spec.ts`,
`packages/agent/src/mastra/__tests__/background-resume.spec.ts`,
`packages/agent/src/mastra/__tests__/background-resume-terminal-wait.spec.ts`,
`packages/agent/src/mastra/__tests__/root-pause-notices.spec.ts`,
`packages/agent/src/mastra/__tests__/withhold-pause-notices.spec.ts`,
`packages/agent/src/mastra/__tests__/approval-gate.spec.ts`,
`packages/agent/src/__tests__/background-worker-policy.integration.spec.ts`,
`packages/agent/src/__tests__/background-rejected-delegation.integration.spec.ts`,
`packages/agent/src/__tests__/background-late-results.integration.spec.ts`,
`packages/agent/src/__tests__/active-parent-background-results.integration.spec.ts`,
`packages/agent/src/__tests__/mastra-background-contract.integration.spec.ts`,
`packages/agent/src/__tests__/root-live-approval-gate.integration.spec.ts`,
`packages/agent/src/pglite-mastra-memory/__tests__/pglite-background-store.integration.spec.ts`,
`apps/desktop/src/__tests__/assistant-server/delegated-sibling-grant.integration.test.ts`.

### Swarm diagnostics evidence

- Every model-facing wakeup, deferral and late overlay is durable evidence for
  the thread debug pack, recorded through the binding's `recordWakeup`.
  `withBackgroundIdleLoop` records `idle-loop` BEFORE the continuation streams,
  with the exact directive the parent receives; a parked parent leg records
  `deferred` and refuses to close while that record is pending;
  `createBackgroundResumeStream` records `resume-leg` before `agent.stream`; both
  `withLateBackgroundResults` call sites record `late-overlay` before approving
  or resuming.
- Prompt manifests: a fresh root turn records its system messages and registered
  tool names once, and resume legs record none. The delegation-start hook records
  `child-first-step` from the DISPATCHING agent's `childPromptFacts`; a
  delegation dispatched by any other agent logs
  `subagent_prompt_manifest_unrecorded` and records nothing. A child resumed
  within the same leg records nothing; one resumed on a NEW leg records a second
  row and the pack takes the earliest. A host-prepared follow-up records
  `continuation` only after the running child accepts it.
- Live decisions: the decide endpoint records `no-live-run`, `refused` (with the
  host reason) and `failed` BEFORE it answers; the running leg records
  `delivered` with the answered sibling task ids and the request's policy
  snapshot; a remembered grant records `remembered-answered` or
  `remembered-failed` after its attempt. Exactly one row per outcome.
- These rows are EVIDENCE, never inputs to the loop. The loop awaits each record,
  and the host binding logs a failed or run-missing write with a code and
  resolves, so a database failure never fails a leg. Storage contract:
  `assistant-persistence.md` ("SWARM DIAGNOSTICS TABLES").

Evidence: `assistant-subagents/swarm-diagnostics.md`.
Guard: `packages/agent/src/mastra/__tests__/prompt-manifest-root-leg.spec.ts`,
`packages/agent/src/mastra/__tests__/live-decisions.spec.ts`,
`apps/desktop/src/__tests__/assistant-server/decide-endpoint.test.ts`,
`apps/desktop/src/__tests__/assistant-server/live-decision-log.test.ts`.

### Background child deadlines

- A background executor that resolves after its native task signal aborted must
  REJECT before native outcome classification; Mastra 1.64 otherwise marks the
  empty delegation result completed. The delegation tool hooks capture the
  executor signal by native parent run/tool-call identity and check it after
  execution, and the host-owned resumed executor applies the same check. Add no
  timer, retry, native task-state override or dependency patch.
- Child projection reads that execution signal separately from selected
  cancellation authority: an expired execution produces ONE failed child terminal
  with the native abort reason, while selected Stop stays cancelled.
- Signal ownership survives queued output and is replaced on the next admitted
  execution of the invocation; rejected duplicate preparation preserves the
  active deadline signal, and host resume capture stages the signal by parent
  thread/tool call.
- A child's own watchdog ends a stalled execution through the same seam
  (`endStalledExecution`, never selected Stop): the hook rejects with the stall
  whatever the unwind threw, so the task fails alone with one failed terminal.

Evidence: `assistant-subagents/child-cancellation-and-deadlines.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/delegated-deadlines.integration.test.ts`,
`packages/agent/src/mastra/__tests__/delegated-conversation-binding-stall.spec.ts`.

### Downstream usage failure and cancelled child projections

- A rejected bound usage write closes the upstream iterator, so its catch and
  remaining terminal parts cannot reach the event observer. The root failure
  writer therefore atomically records the failed root and reconciles
  still-running child headers whose exact native invocation is already cancelled,
  appending ONE cancellation event per settled header.
- Foreground descendants of that cancelled invocation are included through their
  bound native ancestry, but a descendant with its own non-cancelled native task
  is excluded — ancestry alone never overrides that task, including when it is
  parked for approval.
- This is a projection of SETTLED native cancellation, never a state override or
  permission to accept rejected usage: the ownership graph, original root turn,
  native task owner/run/tool-call tuple and child event identity must agree.
  Suspended or running siblings, other turns and roots, changed owners and
  already-terminal headers stay unchanged, and repeating root failure appends no
  second child terminal.
- A terminal-event write failure rolls back the root and child status transition
  together. Emit no rejected usage refresh or replacement row; the original
  persistence error stays visible.

Evidence: `assistant-subagents/child-cancellation-and-deadlines.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/delegated-usage-failure.integration.test.ts`,
`apps/desktop/src/__tests__/assistant-server/delegated-stream-failure.integration.test.ts`.

### Selected child cancellation

- The child projection captures the invocation's existing abort signal at native
  admission, so selected Stop classifies that child's subsequent unwind as
  cancellation even when native execution reports an admission error while
  unwinding. Retain the controller for the runtime-owned binding lifetime, beyond
  native tool-hook completion: queued stream parts still belong to that
  invocation. Reuse a non-aborted controller on re-entered preparation while
  rejecting concurrent preparation and restarts of a stopped invocation.
- Never infer sibling cancellation from the root's state or suppress a
  persistence rejection.
- `POST /assistant/cancel-child` resolves an owned child and explicitly selects
  that child or its subtree. It revokes admission on the invocation rows FIRST,
  then joins registered native execution owners and stored background cleanup,
  and only then settles still-running child run projections and appends their
  `run.cancelled` event. Earlier completed legs and siblings retain their status,
  and a failed join returns an explicit INCOMPLETE cancellation response: revoked
  admission is durable and does not imply successful teardown.
- Stop selects a CONVERSATION, including its admitted invocation legs across
  turns, not just the displayed message. Child host-run IDs include the host leg
  and complete native invocation identity, so distinct invocations never share a
  terminal projection. Native task selection includes terminal tasks — completed
  status can precede workflow deletion, which Stop must still join — and stored
  cleanup preserves completed/failed outcomes while removing workflow snapshots.
- Controls register before the runtime can be returned for streaming and stay
  registered through shutdown. A later constructed runtime cannot admit a revoked
  invocation, and the same barrier rejects subsequent child steps, repeated
  admission and pending decision claims after host reconstruction. Closing a tab
  never invokes it.
- Construction must unwind cancellation registration and all runtime cleanup
  owners when a later Apps admission registration throws, preserving both
  construction and cleanup errors.
- Shared Stop eligibility reuses the approval/suspend notice's exact identity and
  resume outcome: a successful decision retires historical pause controls, a
  failed decision stays actionable, and a sibling decision does not retire the
  selected child's pause.
- Active human follow-ups use the observed child identity and its existing
  persona agent signal owner. The shared child composer sends through the
  authenticated host, which rechecks owner, root, active host and cancellation
  admission. Native user signals are durable chronological CHILD turns; they do
  not become parent input or launch a second runtime
  (`assistant-persistence.md`).

Evidence: `assistant-subagents/child-cancellation-and-deadlines.md`.
Guard: `apps/desktop/e2e/delegated-worker-write.desktop.test.ts`.

### Persona Settings host checks (BST-1727)

- Settings → Subagents refreshes the ordinary validated workspace/global persona
  scan and shows host preflight facts from the existing model catalog, typed
  credential reader and MCP tool registry.
- BLOCKERS: missing or unreadable required credentials, catalogued non-language
  models, providers without LLM capability, and the built-in local model's
  unsupported Worker discovery (that rule is shared with actual agent admission).
  An unlisted model pin or a missing/disabled MCP tool is actionable ATTENTION,
  not a claim that the model is invalid or the persona unavailable.
- Native capabilities, selected parent model, durable child controls and
  permission policy stay per-request checks: a passing preflight never promises
  effective access.
- Refresh rereads profile edits and host facts with ONE scan in flight, without
  executing a model or changing running children. A failed scan or check shows a
  visible error and Retry, retaining any previous list as such, and never
  silently substitutes built-ins for a successful user-profile scan.
- No credentials enter the IPC response and no new state is persisted; the
  existing subagent-personas factory-reset registration stays authoritative.

Evidence: `assistant-subagents/idle-child-continuations.md`.

### Managed idle-child input

- A user follow-up to an IDLE child starts a fresh managed root host leg and
  wakes that exact stored child through Mastra's public `createMessageSignal` /
  `sendSignal`. The renderer supplies only the selected child, a stable input ID
  and the structured payload; the host authorizes resource/root/ancestry and
  claims a separate continuation receipt, never changing the original invocation
  or manufacturing parent tool-call coordinates.
- Claim the receipt BEFORE native wake and bind the accepted native run before
  the first continuation envelope acknowledges input. A repeated admitted input
  ID never starts work again, including after an uncertain acknowledgement or a
  restart; different text or image content under that ID is a conflict.
- A pending decision owns its selected CHILD, not the root's execution slot, so
  multiple idle children retain independent approvals and questions, including
  same-persona siblings with identical leaf tool-call IDs. Only one receipt may
  be claimed or running under a root, only one active receipt may own each child,
  and fresh input and decision consumption both reject another running or
  cancelling managed root leg, ordinary parent input included.
- The selected child retains its admitted persona and step cap. Direct child legs
  must preserve the child's default budget and worker processors, because root
  per-call `inputProcessors` REPLACE those defaults in Mastra. Actual depth feeds
  recursive availability checks, so waking a grandchild cannot reset its depth
  allowance, and every model step charges the real child identity against the
  managed turn's durable budget.
- Fresh child input runs the ordinary workspace/reference/skill context injectors
  against that input, without copying client-supplied system-role request
  messages. Only host-injected system context crosses to the child, exactly once
  in the native model prompt, and the child's default context processor retains
  it in native RequestContext so a later descendant inherits the same authority.
- Live frames use the shared conversation mapper with
  `brainstrike.child-continuation` metadata, never fake parent invocation keys.
  The host assigns the new child assistant message ID before native execution and
  supplies it to Mastra's public ID generator, so live projection and reloaded
  messages share identity while parent and child assistant IDs stay distinct. The
  first direct envelope in each host leg carries its history baseline once.
- A child pause keeps the managed turn open, and each resumed host leg reuses the
  receipt's original turn anchor rather than allocating another budget. Reload
  discovers pending decisions with an INERT native agent at the admitted persona
  and exact stored child thread/run, then authorizes any descendant path,
  requiring neither the current persona registry nor a model execution.
- Suspended-run discovery validates every root and child timestamp before
  staleness and capping, even with no continuation receipt; invalid values fail
  the complete response visibly, and merged pauses stay oldest-first, newest ten.
- Multiple approval or question calls emitted in one model step stay individually
  addressable: the installed Mastra scheduler forces concurrency one when a
  called tool requires approval or has a suspend schema, and child agents use the
  native `strategy: 'called'` option, so reload discovers one pending call and
  then the next after the first decision resumes. A multi-call suspended snapshot
  is an explicit unsupported shape — do not remove its guard on the strength of
  parallel model emission alone.
- Completed child output reaches the managed root model through a public native
  notification signal and the normal root stream/persistence path, carrying the
  FINAL completed leg's text only. This is an actual model response, not a
  synthetic assistant message or another transcript writer, and approval,
  question pauses and cancellation do not wake that root model.
- Binding failure aborts and joins native stream consumption before runtime
  disposal; all terminal paths settle the receipt and preserve cleanup failures
  in an `AggregateError`. If initial history capture fails after admission
  commits, settle that receipt as FAILED before returning the error: the same
  input id cannot replay, while a new explicit input can be admitted. Decision
  disposal consumes only claims still owned by that host.
- Recognized human continuation signals use ONE decoder in both projection paths;
  malformed signals fail visibly instead of disappearing from child history, and
  restart replays neither the child input nor the parent notification.

Evidence: `assistant-subagents/idle-child-continuations.md`.
Guard: `packages/agent/src/__tests__/child-continuation.integration.spec.ts`,
`apps/desktop/src/__tests__/assistant-server/idle-grandchild-restart.integration.test.ts`.

### Admitted persona configuration on decision resume

- An admitted child's stored `configuration` holds its persona instructions,
  model pin, mode, effective tool IDs and the invocation's clamped step budget.
  The host returns this IMMUTABLE configuration only after authorizing the entire
  decision ancestry, and both approval and question/plan resume entry points
  restore those profiles before constructing discovery or execution Agents.
  Restoration is indexed by DEPTH, so two admitted generations of the same
  persona ID cannot overwrite one another.
- Registry edits, disable preferences and removal apply to FRESH root turns; a
  resumed native leg retains its admitted target profile through completion and
  never rewrites an already-admitted decision. Current host tool availability,
  permission rules and model credentials still gate execution.
- Missing or invalid snapshots and an unavailable admitted profile fail visibly
  before native resume; another persona or model is never substituted. The
  browser-safe `AdmittedChildConfigurationError` carries only a fixed reason and
  safe remediation, returned as HTTP 409, with profile text and underlying errors
  private. Missing or legacy shapes request a fresh delegation, a persona/path
  identity mismatch is a distinct integrity failure, and unknown fields, invalid
  model providers and empty tool catalogs reject.
- Expand wildcard worker profiles to their effective admitted tool IDs when
  building the admission map, capturing the full eligible catalog before
  discovery hides unloaded tools, so a later catalog addition cannot broaden that
  child's resume. Older records retaining an unexpanded `*` fail with an explicit
  request to start a new delegation.
- Cross-provider pins reacquire credentials through the trusted host reader, even
  when the live persona file has been deleted; credentials are never stored in
  child configuration. `assistant-service/stream-init.ts` is the sole production
  caller of the two public resume functions and injects that reader for both, and
  restoration without an authenticated root runtime rejects before reading
  secrets.
- The stored step budget must be a valid admitted value under this build's host
  ceiling, and current admission cannot write a value above it. A future host
  limit reduction must coordinate native snapshots and durable counters; clamping
  only this parser would not prove the running workflow uses the new limit.
- Read-only `resolveToolAction` runs before profile reconstruction and AGAIN
  before native decision admission; the second authorization rechecks current
  ownership rather than caching authority across model/tool construction.

Evidence: `assistant-subagents/idle-child-continuations.md`.
Guard: `packages/agent/src/__tests__/delegated-persona-snapshot.integration.spec.ts`,
`packages/agent/src/__tests__/recursive-worker.integration.spec.ts`,
`apps/desktop/src/__tests__/assistant-server/agent-stream-init-and-memory.integration.test.ts`.

### Settings inventory and reset release proof

- `delegated-factory-reset.desktop.test.ts` toggles Settings' master delegation
  switch and observes the next real native Mastra request at the external model
  provider boundary: enabled requests advertise `agent-worker`, disabled requests
  advertise no `agent-*` tools while retaining ordinary tool discovery. After
  factory reset and process restart the default switch and a worker-capable
  inventory return.
- The provider shim supplies model text only; the assistant endpoint, request
  preference propagation, persona resolution and tool catalog construction run
  unmodified. This case executes no delegated workspace effect — the worker
  fixtures own that proof.

Evidence: `assistant-subagents/child-run-controls-and-composer.md`.
Guard: `apps/desktop/e2e/delegated-factory-reset.desktop.test.ts`.

### Selected child scope and captured usage

- The selected child's details surface reads its authorized durable
  configuration, actual child run model/provider and tree depth through the same
  admitted-profile parser as native resume; an invalid legacy profile stays an
  explicit error, never a different persona, and the displayed tool list is the
  admitted MAXIMUM, still subject to current host permissions.
- A missing captured effort value displays as NOT RECORDED and is never inferred
  from the parent's current selector. Continuation receipts with an execution
  snapshot display their actual model, generation effort, output limit, plan
  state and permission policy, and the latest authorized receipt is read
  separately from the original admitted maximum.
- Direct captured usage and inclusive child-plus-descendant usage reuse the main
  conversation's cumulative usage component and pricing resolver. Inclusive
  totals already include the selected child and must not be added to direct
  totals; a missing usage record is not zero spend, and unknown model pricing
  stays unavailable.
- The reader follows exact invocation and continuation attribution because
  ordinary child usage rows are stored under the ROOT thread: never sum the
  root's entire bill into each child. Only retained conversation attribution is
  shown, and root totals keep numeric history after child deletion.

Evidence: `assistant-subagents/child-run-controls-and-composer.md`.

### Next idle child run controls

- The child reuses the main composer's model picker, generation/effort controls,
  plan control and tool menu, with a draft local to that exact child panel.
  Before an explicit override the selected model comes from the admitted persona
  pin or its owning root's live per-thread selector, and provider settings and
  plan mode come from that same root store. Desktop children use the same shared
  provider-discovery resource as the parent even when the parent panel is not
  mounted.
- Historical Retry/Edit reads admission ancestry and restart capture in bounded
  80-message pages; an empty branch prefix reads no message page. Its baseline
  excludes events whose canonical native-message owner (or, absent that, turn
  owner) is outside the branch, and Retry also excludes turn-owned events for the
  replaced answer. Legacy ownerless events keep chronological assignment.
- Idle input and historical branch actions WAIT for a valid admitted persona. A
  malformed latest execution receipt displays a concise explicit error while
  retaining the original admitted persona and tool/step limits; raw schema issue
  JSON is not user-facing copy, and unreadable execution settings are not
  inferred.
- Changes apply only to a NEW idle-child input; active input carries no next-run
  configuration. The shared composer captures the complete next-run request once,
  so an unconfirmed retry keeps that exact receipt and settings despite later
  control changes, and changing text or images still requires explicit discard.
  Browser receipts exclude credentials and local endpoint configuration.
- Every new native child records the actual generation options installed on its
  Agent through the existing trusted admission binding before native input is
  persisted. Original decision resume restores execution snapshots alongside
  admitted persona profiles at each exact ancestry depth, and a differently
  pinned descendant model uses its own defaults.
- **The admitted snapshot contributes ONLY its denies** through
  `intersectChildPermissionCeilings`
  (`packages/assistant-contract/src/child-permission-ceiling.ts`), so a root
  grant made after admission (session grant, per-tool "Always allow", yolo) lifts
  an admitted `ask` on the very next resume leg, while a later root reduction
  still applies and the admitted tool catalog stays frozen. SETTLED 2026-09-12
  (do not relitigate): a symmetric "stricter wins" rule froze every admitted
  `ask`, so a grant could never end the prompting.
- Because that grant removes the approved tool's `ask` flag before the child
  resumes, the approval-resume leg builds children with SEQUENTIAL tool calls
  (`resolveChildToolCallConcurrency`; `assistant-runtime.md`, "Parallel tool
  calls"); otherwise Mastra's parallel foreach resume re-raises approval for the
  allowed siblings of the approved call.
- Migration 137 persists an execution configuration on each continuation receipt.
  Admission validates the current host model and image capability, combines root
  permissions under the deny-only ceiling, prevents disabling root plan mode, and
  permits only REDUCTIONS of the original admitted tool catalog. Resume reads the
  receipt's exact profile and generation settings and applies current root
  permissions under that same ceiling. A pending decision is unaffected by future
  draft edits, reload or a different parent effort, child settings never replace
  the parent outcome leg's settings, null legacy execution configurations keep
  the original-profile compatibility path, and migration rollback refuses to
  discard non-null execution snapshots.

Evidence: `assistant-subagents/child-run-controls-and-composer.md`.
Guard: `packages/agent/src/mastra/__tests__/child-run-configuration.spec.ts`.

### Structured child composer input

- The shared composer uses the same image adapter, file mentions and workspace
  slash commands as the root. Image-only drafts are valid in both active and idle
  children, and Send and Enter share the same content-presence and delivery
  gates.
- The selected child's captured RUNNING model determines active vision
  availability; an idle child uses its admitted persona model pin, or its owning
  root's current per-thread selection when unpinned, and a previous run's model
  never overrides the next selection. Known unsupported models reject images
  visibly; unknown provider capabilities use the canonical root policy and
  surface actual provider errors.
- Only the authenticated host resolves file and skill references, and
  caller-supplied system context is rejected. Native message signals retain
  structured file parts and bounded host context, and the latest native user
  signal replaces only its input-context tag: absent or empty context clears the
  older tag without altering admitted persona or workspace authority.
- A stable receipt binds the entire normalized payload, image bytes included,
  through acknowledgement loss and restart. Migration 136 stores that payload on
  the existing reset-owned continuation receipt; legacy text-only receipts stay
  readable, and downgrade permits only payloads losslessly represented by the
  retained input text. Acknowledgement clears only the sent attachment cohort and
  unchanged text, preserving newly staged input; an unconfirmed changed payload
  requires explicit discard.
- The shared effort control offers an OpenRouter ladder only from the selected
  model's declared or matching live metadata, never direct OpenAI defaults while
  routed-model metadata is pending.
- Continuation token accounting uses Mastra's public `processOutputStep`, which
  reports the completed model response before a tool can pause. A paused native
  stream has no `step-finish` and its terminal usage is zero, while a resumed
  terminal includes earlier paused responses; neither is a per-host-leg charge.
  The admitted child's processor persists cumulative provider-reported counts
  within the current managed host leg, a fresh decision leg starts a fresh meter,
  and missing provider counts create no fabricated usage row.

Evidence: `assistant-subagents/child-run-controls-and-composer.md`.

### Settings inventory and reset release proof

Duplicate heading: the original contract carried this section twice with
identical text. The rules are stated once, above.

### Native child workspace reads and checkpoint undo

- The native tool EXECUTION THREAD, not the parent tool-factory closure, owns
  read-before-write timestamps and paged-read cursors. Per-file locks remain the
  serialization boundary, and the authorized delegated invocation resolves the
  checkpoint's resource and host-leg run with the same `delegatedHostRunId`
  function used by event persistence.
- Desktop memory wiring supplies pre-execution snapshot capture to host
  admission. The shared child view reuses `EditCheckpointProvider` /
  `useEditCheckpoints` with the CHILD's thread ID and refreshes the ledger on
  terminal store events; browser views without the checkpoint bridge neither
  query nor expose native checkpoint controls.
- Delegated native file mutations carry the selected execution's abort signal to
  the per-path mutation boundary: a child stopped while waiting for a shared file
  lock cannot mutate once the lock becomes available, completed child edits stay
  inspectable, and a sibling retains its own execution signal.

Evidence: `assistant-subagents/child-run-controls-and-composer.md`.
Guard: `apps/desktop/e2e/delegated-worker-write.desktop.test.ts`.
