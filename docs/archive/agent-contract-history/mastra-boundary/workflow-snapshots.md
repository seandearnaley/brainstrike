# R9 workflow snapshots and the run timeline — evidence

Supports `docs/agents/mastra-boundary.md` § "R9 WORKFLOWS AND RUN TIMELINE". Read
this before reading `mastra_workflow_snapshot` from anywhere but the resume path,
or before treating `Run.timeTravel()` as a history browser. The unknown-resume
gap recorded at the end is still open and is listed under the contract's
FOLLOW-UPS.


**Workflow snapshots are runtime-resume state. The run timeline is Brainstrike
telemetry. Neither replaces the other.**

`mastra_workflow_snapshot` (`packages/agent/src/pglite-mastra-memory/workflows-store.ts:208`)
is written on suspend and read on resume — plus pending-approval discovery
(`suspended-run-discovery.ts`, moved out of `agent-streaming.ts` by BST-1649),
which is still the resume path. Nothing else
reads it: no analytics, no UI, no history view. Mastra's own guidance is to store
references rather than payloads, and `pruneSnapshot` must be pure and JSON-safe
because a snapshot may cross a pubsub boundary.

`Run.timeTravel()` exists (`dist/workflows/workflow.d.ts:655`) but is
**replay-from-a-chosen-step with injected context**, not a read-only history
browser. It is not a run-timeline substitute.

The run timeline is the Brainstrike contract: 31 event kinds in
`packages/assistant-contract/src/run-events.ts:3-35`, persisted by two writers with
byte-identical SQL (`recordDesktopAssistantRunEvent` in
`apps/desktop/src/assistant-server/run-persistence.ts`;
`packages/assistant-data/src/assistant-memory-repository.ts:2449-2502`), read by reload
hydration, the live timeline UI, and the debug bundle.

**Typed suspension UIs are supported and unknown resume schemas must be rejected
visibly.** The transport envelope is already validated and 400s on violation
(`packages/assistant-contract/src/tool-suspend.ts:82-95`). A *semantically* unknown
suspending tool currently renders a generic non-actionable notice
(`assistant-tool-suspend-notice.tsx:463-475`) and leaves the run suspended with no
error surface — that is a gap against this ruling, tracked below.

