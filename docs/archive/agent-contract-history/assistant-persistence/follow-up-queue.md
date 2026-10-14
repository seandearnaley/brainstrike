# Follow-up message queue — evidence

Supports `docs/agents/assistant-persistence.md` §
"FOLLOW-UP MESSAGE QUEUE (COMPOSE DURING A RUN)". Read this before proposing to change run-end detection, the catch-up rule, or queue ownership in inspection panes.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Report R3 v1 — the QUEUE half of mastra-code's steer/followUp pair. The
composer input already stays enabled during a run (only Send unmounts); this
adds a `QueueFollowUpButton` in the RUNNING branch (composer-input.tsx
`queueControl` seam), a per-thread zustand FIFO
(`packages/assistant-ui/src/follow-up-queue-store.ts`), removable
"queued" chips above the composer, and a render-nothing
`FollowUpQueueBridge` that dispatches ONE queued message per run end via
`aui.thread().append(...)` (the same programmatic-send seam the
approval/suspend notices use).

Existing-runtime inspection panes (`AssistantConversationPanel`, BST-1724)
set `FollowUpQueueOwnershipContext` false. They neither dispatch/catch up the
root session queue nor offer its Queue/Steer controls or chips. The runtime
owner retains queued items unchanged; opening/reopening a view and observing
a child finish must not start another execution. Root panels keep the default
ownership and existing catch-up semantics. Paired regression:
`assistant-conversation-panel.test.tsx` seeds a queue before idle/running mounts,
then tests run-end and reopen without a send or dequeue.

Settled semantics (v1 — revisit only with the steering stage):
- **Run-end detection is the `state.thread.isRunning` true→false transition**,
  NOT the run-event data parts — it works identically for the web local
  runtime (whose events carry no `runId`) and fires for finished, failed, AND
  user-cancelled runs alike; the chip's remove control is the user's veto.
- Hydration/thread-switch guards mirror `run-lifecycle-notifications.ts`: no
  dispatch while `state.thread.isLoading`; a `threadKey` change reseeds the
  transition baseline (a switch is never a run end).
- FIFO one-per-run-end: the next queued item waits for the dispatched run to
  end (natural steering loop). A synchronous `append` throw requeues at the
  FRONT and logs (`append` returns void in the installed assistant-ui — there
  is no async failure channel; a run that starts and then fails is a normal
  `run.failed`, not a dispatch failure).
- **Missed-run-end catch-up:** the bridge lives inside the threadKey-keyed
  runtime subtree, so a thread switch unmounts it and a run ending off-screen
  produces no observable transition. Once per (re)mounted key, an idle
  non-loading thread with a non-empty queue is treated as that missed run end
  and dispatched — the chip's promise ("sends when the current run ends")
  holds across thread switches.
- Session-lived, deliberately NOT persisted (a queued message surviving a
  reload would be a surprise send); registered with factory reset in
  app-shell's `register-factory-reset-session-stores.ts`.
- Mid-run STEERING (injecting into the live loop at a step boundary) is the
  explicit v2 follow-up and lives in the agent loop, not this UI seam.

When changing this flow, update this section and the paired tests
(`packages/assistant-ui/src/__tests__/follow-up-queue-store.test.ts`,
`packages/assistant-ui/src/__tests__/follow-up-queue.behavior.test.tsx`
— the behavior suite runs a REAL assistant-ui local runtime, no mocked state).

