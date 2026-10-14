# A pause part does not end the leg — evidence

Supports `docs/agents/assistant-runtime.md` § "Native suspension completion".
Read before changing how a pause is read out of a native stream, or before making a leg stop at the first approval. Settled 2026-09-14; thread-f6be9761 is the incident.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 32-68), extracted verbatim.

A PAUSE PART DOES NOT END THE LEG'S READ (SETTLED 2026-09-14, do not
relitigate). Mastra's foreach kills only its QUEUED calls when one suspends;
calls already running carry on inside the same native stream, and a delegation
step runs its `agent-*` calls that way, so four parallel Explorers pause in ONE
leg. Stopping at the first `tool-call-approval` lost every later sibling's first
output (the projection's binding point) and pause: the resume leg then met a
child it had never bound ("Delegated stream requires observed native identity")
and three delegations never finished (thread-f6be9761). `streamAttemptChunks`
now reads to native close. Each pause's decision-exposing chunks
(`tool-approval-required` / `tool-suspend-required`, its `tool.approval.requested`
row, a paused child's projected `tool-calls` finish) are WITHHELD
(`isPauseNoticeChunk`) and published together behind the completion join, so
the rule above holds for every pause; the leg then ends ONCE with a `tool-calls`
finish (`resolveLegPart` strips the per-pause finish, `concludeClosedStream`
emits the leg's). Mastra closes a suspended run's stream with no finish part,
and a resumed leg whose sibling calls stay suspended closes the same way with no
pause part of its own (the earlier leg surfaced those notices): its synchronous
`MastraModelOutput.status` is `suspended` there, restored from the snapshot,
while `getFullOutput()` REJECTS ("promise 'suspendPayload' was not resolved" —
that payload was resolved by the earlier stream), so that leg skips the join
(`readNativeStreamStatus`) and still ends as the pause it is, never as a missing
finish. Exit rules for withheld notices (each drained where published, so no
exit repeats one): a rejected completion join DISCARDS them (a failed snapshot
write must not expose an unresumable decision); an explicit root Stop drops
them (paused work is cancelled, so no "awaiting your approval" row may surface);
any other failure later in the leg — a sibling's stream or projection — and a
genuinely missing finish PUBLISH them ahead of the failure or synthetic ending,
because the pause already reached Mastra and is parked durably, and hiding it
behind reload rediscovery is the stuck thread this rule exists to end. Scoped
chunks never nest at this seam: a child leg withholds its own children's
notices in its own loop, and the continuation layer wraps only published
chunks. A pause raised by a gated DIRECT tool in a sequential step is unchanged:
the queue is killed, so the stream closes right behind it ("PAUSES ONE CALL AT A
TIME"). The renderer keeps every notice actionable across legs and locks the
buttons while a leg streams (`actionLockedByRun`). Scenario proof:
`specialist-fanout.integration.spec.ts` (every pause live, `rediscovered === 0`,
one pause per child, intermediate legs end `tool-calls`, the last `stop`).
