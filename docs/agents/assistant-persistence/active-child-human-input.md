# Active child human input — evidence

Supports `docs/agents/assistant-persistence.md` §
"Active child human input". Read this before proposing to change the receipt lifecycle, request-id reuse, or the child input endpoint status vocabulary.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

The active native child owns input consumption. Persist its canonical Mastra user
signal before `sendSignal`, scope the client request id to its native resource and
thread, and serialize requests per child owner. Store a pending receipt before
native acceptance and a delivered receipt after it. An identical delivered request
is acknowledged without another enqueue; changed content under the same id is
rejected. A pending receipt after an interrupted acknowledgement is ambiguous and
must never be automatically replayed into a writable child. Definitive native
non-delivery removes the signal from native memory, so a later continuation
cannot recall rejected input. An unconfirmed draft can be explicitly discarded
before composing a new request; ordinary repeats keep their original id. The native production
fixture injects receipt-write failure and proves a later explicit request remains
usable without duplicating the earlier signal.

Child frames use vendor `2` out-of-band data, so parent text and tool argument
controllers stay open while child views update. Decode legacy `aui-data` child
frames for stored replay too. Accepted native `data-user-message` signals route by
the previously observed exact invocation identity. A child human-input marker
splits only that child's shared runtime into assistant/user/assistant rows. Native
memory remains the durable transcript writer; the child composer never launches a
second runtime, queues a root turn or reconstructs a background task on disconnect.
The child input endpoint returns definitive non-delivery (409) for a missing or
retired host owner. Rejected serialized admission checks also become definitive
non-delivery with their original cause once any saved signal has been removed.
Failed signal cleanup preserves both rejection and cleanup errors and remains an
explicit 503; it cannot claim that rejected text is absent from future recall.
Initial foreign-owner/scope checks remain 404 and uncertain acceptance remains 503.
Reload
preserves the receipt in user-message custom metadata: pending input shows an
unconfirmed-delivery notice, while delivered input shows its accepted state.
Neither state dispatches work from hydration. Human input retains the native
creation timestamp through live projection and reload.

Production evidence: `background-worker-stream.integration.spec.ts`,
`delegated-live-wire.spec.ts`, `delegated-conversation-receiver.test.ts`,
`delegated-conversation-runtime.test.tsx`, and the active child composer case in
`delegated-child-control.desktop.test.ts` (live send, parent result, reload with no
additional model request). Idle input uses the separate managed continuation contract
in assistant-subagents.md: a fresh root host run owns a durable continuation receipt,
a distinct native child message ID and exact decision routing. The original
delegation invocation remains immutable.

Active child input retains the same request ID after an unconfirmed acknowledgement,
even if the user edits the draft. Replacing that request requires the explicit
Discard draft action. Stop waiting aborts only the acknowledgement transport;
it does not stop the child or retract an already accepted instruction. The UI
retains the request ID and reports unconfirmed delivery, ignores a late response
from the abandoned wait, and permits only an explicit same-ID retry until discard.
`assistant-conversation-panel.test.tsx` pins changed-draft refusal, late acknowledgement
isolation, same-ID retry, and attachment-enabled focus preservation. Pending feedback
and Stop waiting / Discard draft controls survive running-to-idle and transport-owner
removal without replaying through `onNew`. While the original wait is still active,
a successful acknowledgement arriving after idle clears only an unchanged draft.
Blank transport failures become an explicit unconfirmed-delivery receipt, with
Discard draft still available. The Vitest browser cases load compiled styles and
prove idle Send/Enter remain blocked; geometry and hit tests keep the receipt
controls reachable at narrow and wide widths. Attachment paste uses the same
admission gate without remounting the input frame or losing focus. A selected
conversation-key switch remounts provider state, isolating its retained receipt
and any late acknowledgement from the new conversation.

