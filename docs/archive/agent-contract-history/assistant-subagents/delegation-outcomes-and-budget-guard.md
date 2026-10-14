# No-answer, rejected, wrap-up reserve and the budget guard — evidence

Supports `docs/agents/assistant-subagents.md` § "SUBAGENTS (PERSONA DELEGATION)".

The BST-1410 no-answer incident, the BST-1751 rejected marker, the in-loop summary reserve, and the 2026-08-24 oversized-result field failure.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 490–608 at commit 7c3eb8f38.

---

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
