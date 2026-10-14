# Native subagent contract matrix — evidence

Supports `docs/agents/assistant-subagents.md` § "First-class subagent architecture gate".

Read before upgrading `@mastra/core` or `@mastra/memory`, or before changing what `mastra-subagent-contract.integration.spec.ts` claims. The capability matrix below was verified against installed core 1.64.0 / memory 1.28.2.

CORRECTION (2026-09-21): the "Current background API" row describes what the NATIVE probe exercises. Production never passes `untilIdle` — `withBackgroundIdleLoop` replaced it (settled 2026-09-14, contract § "Background worker execution and pending controls"). The only `untilIdle: true` call sites in the repo are `mastra-subagent-contract.integration.spec.ts`, `mastra-background-contract.integration.spec.ts` and `delegated-waiting-cancel.integration.test.ts`.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 14–82 at commit 7c3eb8f38.

---

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
