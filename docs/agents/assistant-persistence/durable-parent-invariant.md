# Durable-parent invariant and the host-leg anchor — evidence

Supports `docs/agents/assistant-persistence.md` §
"ASSISTANT THREAD PERSISTENCE & RELOAD HYDRATION". Read this before proposing to change the transient-alias map, the host-leg anchor, or the backfill race handling.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

3. **Edited-prompt branch topology:** Mastra remains the only writer of message
   CONTENT, but its rows do not retain assistant-ui's parent graph. The client
   history adapter therefore persists only `{messageId,parentId}` edges in
   `brainstrike_assistant_message_parents` (migration 055) from its canonical
   `append({message,parentId})` callback. An edge may land before Mastra saves
   the matching content row, so `message_id`/`parent_id` intentionally have no
   message FK. It also has no thread FK because the numbered migration runner
   executes against a bare schema; app-shell thread deletion and factory reset
   explicitly own cleanup. Hydration LEFT JOINs these edges and
   uses an explicit parent (including explicit `null`) instead of chronological
   chaining, which reconstructs edited prompts/regenerations as carousel
   siblings after reload. Rows without an edge are legacy data and retain the
   chronological fallback. The bounded 80-row hydration window is always a
   closed graph: retained messages whose parent fell outside the window are
   explicitly re-rooted. Hydration then performs a stable parent-first graph
   traversal so assistant-ui never imports a dangling or not-yet-imported
   parent. Mastra message creation time is immutable on same-id saves: a
   regeneration reuses its parent user id, and moving that legacy row later
   would invert pre-topology history.
   Conflicting edges for the same message id throw — branch corruption is never
   silently rewritten. Factory reset clears the companion table explicitly.
   **DURABLE-PARENT INVARIANT (BST-1243, 4th recurrence of the
   hydration-siblings class — enforce at the adapter, not per flow):** every
   persisted edge must reference a durable (Mastra-persisted) message id or
   null. Approval/suspend flows append UI-transient messages — the action
   echo, the post-resume leg, and the synthetic rediscovered-pause notices
   (`suspended-approval:*` / `suspended-pause:*`) — that Mastra never
   persists; before this ruling the adapter persisted their edges verbatim
   and the NEXT user message chained onto a ghost, so reload re-rooted it
   into a phantom root carousel sibling (one new sibling per approval turn).
   `createAssistantThreadHistoryAdapter` therefore keeps a per-instance
   transient-alias map: action echoes (recognized by the SAME strict guard
   the transport exclusion uses, now shared from
   `@brainstrike/assistant-contract/approval-action-message`) and assistant
   messages whose parent resolves through an alias (resume legs) are never
   persisted and alias to their nearest durable ancestor; `load()` seeds
   aliases for the synthetic pause ids. Because suspension prevents the
   suspended assistant message's own runEnd history append, the echo append
   backfills that durable edge so the reload group keys to the ALIGNED
   assistant id rather than a snapshot row id. The backfill parent, in order
   of authority: the hydrated graph parent when the suspended message was
   loaded; else the DURABLE HOST LEG the pause named (`hostRunId`) and its
   `turn_message_id` (BST-1163 — every leg of a turn stamps the same link, so
   this stays exact when other sends land during the suspension and when the
   suspended run is a regeneration branched from an older prompt). There is NO
   third fallback. An echo only REACHES that branch when neither earlier
   authority answered — the suspended message was not hydrated and carries no
   persisted edge — and every pause that can reach it names its host leg, so a
   missing one THERE is a producer defect and throws. A CHILD-CONTINUATION echo
   is not an exception to that rule but a case that never reaches the branch:
   its follow-up leg's root message completes, so the edge check above answers
   first (see the continuation paragraph below).

   **THE ANCHOR IS THE HOST LEG, NEVER THE MARKER'S `runId` (2026-09-15, do
   not relitigate).** The action marker's `runId` is the NATIVE Mastra run the
   resume routes address. Mastra mints it (`options?.runId ||
   generateId()`) and no leg passes the host id in, so it NEVER equals a
   `brainstrike_assistant_thread_runs` id; one host leg can also hold several
   native runs, because a background wake-up continuation mints another
   (`background-idle-loop.ts`). Keying the lookup on it therefore missed on
   every live backfill from the day it shipped, and the session tail silently
   answered instead — right only when the tail happened to be the suspended
   message's own turn, and wrong for exactly the regeneration/mid-suspension
   cases the turn link was introduced to fix. The paired tests hid it by
   seeding the marker `runId` equal to a thread-run id, a shape the runtime
   never produces. Evidence: the live fan-out verifier run 24 (a root
   `manageCanvas` approval carried `2cc9a50d-…` while the thread's runs were
   `run-ffcdbd6d-…` / `run-6172a925-…`), reproduced against the real Mastra
   loop on BOTH an initial leg and an idle-loop wake-up continuation.
   The host stamps `hostRunId` on the pauses of its own turn at the same seam
   that stamps `runId` on run events (`observeDesktopAssistantRunEvents`) — the
   root's own pause and a delegated child's card, whose decision the root
   runtime appends. A CHILD-CONTINUATION pause is deliberately NOT stamped: a
   continuation leg's `turn_message_id` is the continuation id, not a root
   message, so anchoring a root edge on it would persist exactly the dangling
   parent this invariant forbids. That omission is SAFE, not a gap: a
   continuation's root message COMPLETES, because the mapper opens root
   tool-call frames for a root pause (which is what leaves a suspended message
   `requires-action` and edge-less) but emits only a `data` frame for
   child-continuation frames — so the follow-up leg's runEnd append persists
   that edge and the decision echo, appended by the ROOT runtime, resolves
   through it before the host-leg branch is reached (pinned by "lets a
   child-continuation decision ride the edge its follow-up leg persisted").
   A REDISCOVERED pause carries none either (its
   leg ended at the restart) and never needs one — its echo resolves through
   the hydrated graph or the alias chain instead. HOSTED WEB never reaches this
   path at all: it has no host run observer and answers a decision leg with
   `tool_approval_unavailable` / `tool_resume_unavailable` (HTTP 409), so no
   live pause echo is ever appended there.
   The throw is deliberately loud and deliberately unreachable in these flows;
   were it to fire, `ThreadRuntime.append` rethrows from a detached `.catch`,
   so it surfaces at the renderer's global unhandled-rejection hook — which is
   why every producer seam is pinned by a test rather than trusted. `hostRunId` is an optional
   own bounded identifier on both action markers, validated by the SAME strict
   guards as `toolName`. Invalid action markers remain ordinary prompts and keep their edges
   (strict-guard symmetry with the wire). Two adjacent stances are SETTLED
   (PR #2392 review): approving a REDISCOVERED pause anchors the follow-up at
   the durable thread head — the resumed run's continuation rows land
   chronologically at the end of `mastra_messages`, so re-parenting under the
   old run's mid-thread assistant would fabricate a mid-thread branch whose
   content hydrates at the bottom; and a regeneration taken from a
   post-approval response (parent = the echo) is structurally
   indistinguishable from a resume leg at this seam, so its edge is
   deliberately not persisted — its Mastra content hydrates chronologically
   inside the turn's group, only the carousel affordance is not
   reconstructed (a timing-sensitive Mastra-row probe to distinguish them was
   rejected).
   Read-side hydration is deliberately untouched: re-rooting and the
   conflicting-edge throw stay as-is — fix producers, never coerce at read.
   Paired tests: packages/assistant-data
   `assistant-approval-topology.integration.test.ts` (its fixtures deliver the
   RUNTIME marker shape — a native `runId` plus the pause's `hostRunId` — and
   pin the loud refusal when a live echo names no host leg), the producer chain
   (`packages/agent` `root-pause-run-identity.integration.spec.ts` for what a
   root pause reports on an initial leg and on a wake-up continuation,
   `data-stream-session.spec.ts` for the transport, `apps/desktop`
   `run-persistence-direct.test.ts` for the host stamp and the deliberate
   continuation exclusion, `approval-decision-message.test.ts` +
   `assistant-tool-suspend-notice.test.tsx` for both echoes), and the desktop
   E2E `assistant-approval-reload-linearity.desktop.test.ts`.
   **Aborted-leg backfill race (2026-09-15, fan-out verifier runs 19 and 24):**
   an approval can arrive while its root leg is still streaming (background
   children returned and the parent continued). Approving appends the echo and
   starts the resume run, which aborts that leg, so the suspended message's own
   terminal runEnd append DOES fire and races the echo backfill. The backfill
   re-checks `persistedEdgeIds` after its turn-link lookup and defers to that
   authoritative edge. Adapter session state read across an await is
   re-validated, never trusted: the stale tail read wrote a self-parent edge and
   threw `conflicting branch topology`. In both runs the echo marker carried the
   native run id, which named no `brainstrike_assistant_thread_runs` row, so the
   turn-link lookup missed — that miss is what the `hostRunId` anchor above
   removes; the re-validation stays, because resolving the host leg is still an
   await the aborted leg can win. The throw reached the renderer's global
   unhandled-rejection hook because assistant-ui's public `ThreadRuntime.append`
   returns void and rethrows non-`MessageNotSentError` failures from a detached
   `.catch`; callers cannot observe it. Paired test: "keeps the edge an aborted
   leg persists while the echo turn lookup is pending" in the same topology file.
   That case forces tied edge timestamps and compares the exact parent map:
   SQL's timestamp/message-id order can place the assistant before the user,
   without changing either persisted edge (PR #3243 CI regression).

