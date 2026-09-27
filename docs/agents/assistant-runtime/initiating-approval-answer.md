# Initiating approval acknowledgement

Supports `assistant-runtime.md` — § "Live approval answers while the parent is parked".

On 2026-09-27 a captured desktop run showed a completed Explorer beside an
actionable directory-read approval. The durable leaf decision was consumed and
the read result was present. A later click was correctly rejected as stale;
it did not demonstrate a missing execution or a Mastra failure.

The reconstructed approval leg emitted `tool-approval-answered` for grant-covered
siblings but omitted the initiating decision. The live-decision path emitted
both. The initiating card therefore depended on its temporary user-action echo
or mounted optimistic state. The debug export does not retain those renderer
states, so their precise disappearance in that session cannot be established
from the export alone.

The approval leg now publishes its accepted decision using the validated native
snapshot's tool name and the exact submitted leaf identity. Publication follows
admission and stream construction; rejected construction emits no acceptance.
It does not infer success from parent completion, replay a tool, or bypass the
stale-decision guard. Both live and reconstructed legs use the existing answer
protocol and renderer index.

Regression: `background-worker-policy.integration.spec.ts` failed because its
two-child grant emitted only the sibling's answer. It now requires both answers,
one effect per child, correct output attribution, and no remaining parked task.
The one-shot case requires only its own answer and leaves the sibling parked.
`mastra-tool-approval-chunks.spec.ts` covers approve and decline;
`assistant-tool-approval-live-answer.test.tsx` covers completed-card locking without
an action echo and independence of a later leaf on the same delegation.
`delegated-worker-write.desktop.test.ts` requires no actionable approval in either
root or child view after completion.
