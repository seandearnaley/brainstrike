# Paused action replay ownership

Supports `docs/agents/assistant-persistence.md` § "ASSISTANT THREAD PERSISTENCE & RELOAD HYDRATION", specifically "Message identity and reattachment".

On September 25, 2026, a live `brainstrike.manageCanvas` approval in a background-root continuation failed in 14 ms before native resume. The UI pause belonged to assistant ID `uzCHEYP`; its parent edge was backfilled when the user answered. Mastra's later tool-bearing assistant row was `61b3994a-a8b0-4c45-8f5f-810bd60d8d28`, so exact ID equality failed even though both were in the same turn. The persisted tool call was `call_SDU6yFAQUjPH1aerqkA14Kqp` under host leg `run-ae9577cf-59f1-4eff-8adf-f41129ce2fc7`. The failed answer leg `run-28ca9daa-244f-4fa1-b337-8b44f5ade3f7` never entered stream initialization; its terminal snapshot warning correctly left the original suspended turn open.

The stream and Mastra memory each have their own one-shot ID generator. Later native rows of a held root can therefore carry UUIDs while the visible paused message retains its UI ID. The UI locates the exact action data, not an adjacent message, but that ID need not name the final native row. The host resolves this split only when the UI ID has no native row, has a persisted parent edge into the same anchored turn, the tool call has one native owner, the native run belongs to the exact host leg or its scoped generation, and that leg has unresolved call evidence. An approval uses `tool.approval.requested`; a root-owned typed suspension uses its `tool.started` because its producer emits no durable pause event. `tool.resume.unsupported` is nonterminal: it cannot establish a typed pause by itself and cannot rule out later native resume. A durable but wrong assistant ID, missing edge, wrong turn/host/native run, reused native tool-call ID, or completed/declined call still fails. The terminal check includes the exact host leg even for a null legacy generation, and pairs other legs only by a nonnull generation. Native suspended-snapshot authorization remains the execution guard after replay preparation. Delegated pauses with an unmatched root host/native mapping remain fail-closed.

`packages/assistant-data/src/__tests__/assistant-action-replay-prefix.integration.test.ts` covers live approval and root-owned typed suspension using their actual durable event shapes, unsupported-only refusal, declined terminal, null-generation isolation, the identity refusals, and an unrelated generation reusing a tool-call ID. The desktop host emits `assistant_admission_rejected` only when an action leg fails before entering stream initialization, allowing the renderer to release its prepared request while retaining the original pending approval.

On the same day, review of PR #3319 found a second pause sequence: the first host leg raised an approval, and its approval resume raised a root-owned typed suspension. Mastra reused the native root run, so `recordNativeRootRun` kept its first host mapping; the typed `tool.started` event belonged to the later host leg. Checking only `native_run_id` plus the current `host_run_id` rejected that legitimate replay. Replay now accepts an exact first-owner mapping or a later host leg with the same nonnull generation, thread and resource as the mapped owner. The later leg still has to supply its own pause event, turn anchor and transient parent edge, and the call must remain unresolved in that generation. Two null generations do not match merely because they are both unset. The first native owner row is never changed. The focused integration test covers the two-leg chain and rejects different generations, threads, resources and null-generation resume legs.

On September 26, 2026, a real Electron regression test resumed a canvas approval into two background Workers, whose write approvals were projected to the root. The new UI assistant pause `QmzYNQQ` was a transient resume leg; its prior durable assistant `WD3RbLC` had the only parent edge. Mastra saved the Worker dispatch calls in a later snapshot row, grouped under `WD3RbLC` during hydration. The Worker action named `QmzYNQQ`, but the action-echo adapter resolved that ID to `WD3RbLC` and returned because the older edge already existed. Replay correctly rejected the unproven transient ID before either Worker could write. A resumed UI message remains an ordinary alias until an action echo names it as the paused owner; at that point the adapter records one proof edge from that ID to the exact host leg's turn message. It verifies the previous durable ancestor belongs to that turn, and retains ordinary aliasing for subsequent messages. The read-side owner guard and native snapshot authorization remain unchanged. `assistant-action-replay-prefix.integration.test.ts` covers this same-turn sequence, replay acceptance, a foreign host turn, and a conflicting proof edge.

PR #3329 review found two related producer races. The installed assistant-ui local runtime starts `history.append` and `startRun` in parallel, so the action POST could reach replay admission before the proof edge committed; a delayed-write hook test now holds fetch until that exact echo write resolves. The write uses the existing request-preparation deadline so a stalled append settles the SDK's parallel join without authorizing a request. Stop and history-adapter invalidation end the wait; a StrictMode effect replay reopens a new generation while fencing the old one. The SDK also keeps the optimistic action echo after a failed history append. Its durable-parent alias must therefore be installed before the awaited proof, even though the failed action cannot send. Finally, the proof accepts only the host turn or its direct child as the previous durable parent: walking arbitrary ancestors could connect a later turn to an earlier one. The focused adapter test covers a failed echo followed by a descendant and a later-turn chain that remains rejected.

## Child continuation ownership

A decision carrying `continuationId` resumes the child through its durable
continuation receipt and native transcript. Root active-run discovery must not
look for that tool call in the root transcript or attach a root action replay
prefix. The desktop HTTP integration pins that routing; the Electron active-child
regression proves typed input, images, context, idle continuation, reload and a
subsequent approval execute through the actual child receipt. Root Gate A/Gate B
replay and its exact native ownership checks remain enforced.

## Late background child approvals

On September 30, 2026, BST-1902 reproduced a late Explorer read approval after
its parent background dispatch had completed. The root's durable tool-bearing
assistant stored the dispatch acknowledgement as a result; a newer assistant
had no tools. The UI action named a transient resume assistant whose persisted
parent still proved the root turn. Its host had completed before the click.
The exact child approval arrived after the parent's `tool.completed` event.

The real-PGlite replay-prefix regression was RED with the retained request's
ownership-disagreement error: native generation, host turn, transient parent,
and exact projected host pause all passed, but the terminal check addressed
the parent surface call. That completed dispatch could not establish whether
the child read had been answered.

Delegated transient replay now walks every edge through the existing durable
conversation/invocation repository. Each child native run, persona and parent
thread must match; every invocation belongs to the selected host's root turn
and exact host or nonnull generation. The leaf event proof uses its child
resource/thread and full native identity, requires one exact pending call,
and rejects native terminal events, any durable leaf decision, or cancellation
on the root turn or any ancestry thread. No transcript
chronology chooses an owner, and the root-call terminal check is unchanged.

`assistant-delegated-action-replay.integration.test.ts` covers distinct
same-generation host legs, genuinely reconstructed repositories, nested paths,
ancestor/leaf/root cancellation, wrong child,
persona, parent call, appended ancestry, turn and leaf, missing/ambiguous pause
events, claimed/consumed/interrupted decisions, and child terminal outcomes.
This only prepares the root replay prefix. Execution remains guarded by
`assertDelegatedToolActionPending` through public native `listSuspendedRuns`,
an atomic durable claim, and a repeated snapshot read before native resume.
