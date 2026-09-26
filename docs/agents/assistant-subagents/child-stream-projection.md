# Scoped child stream projection — evidence

Supports `docs/agents/assistant-subagents.md` § "Child stream error parity".
Supports `docs/agents/assistant-subagents.md` § "Scoped child stream projection".

The BST-1719 delivery layer, including the two 2026-09-15 renderer-memory rulings (consumed child envelopes, grouped-parts render isolation).

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 992–1086 at commit 7c3eb8f38.

---

The nested tool-result reader shares the root mapper's display transformation
and canonical guarded-error classification. A guarded child throw may arrive as
a native `tool-result` without `isError`; it must produce `subagent.tool.failed`,
never `subagent.tool.completed`. The real production supervisor-loop regression
asserts both the rejected tool execution and its failed progress presentation.
Full child transcript routing and hydration remain the rest of BST-1719.

### Scoped child stream projection (BST-1719 delivery layer)

With the durable publication capability present, each native invocation has an
independent lifecycle/tool-name state and uses `processMastraStreamPart`, the
same mapper as the root. `delegated-conversation-chunk` retains observed native
parent-run/tool-call/child-run identity and the native message/part identifiers.
Authorization precedes projection at every encountered depth. The parent keeps
its compact delegation lifecycle; child text does not become parent text.

The data-stream mapper emits `brainstrike.delegated-conversation` data carrying
frames from an independent instance of the existing `DataStreamMapper`. The
normal assistant-stream decoder can consume those frames. A child finish never
finishes the parent, and replay uses the existing session's encoded event buffer
without remapping or minting duplicate child events. Child frames obey the same
parent text/input-stream deferral rules as other auxiliary data. No native
transcript result or parent model projection is replaced by this transport.

SETTLED 2026-09-15, CONSUMED CHILD ENVELOPES (do not relitigate): the renderer
tap (`createDelegatedConversationTap`) consumes every out-of-band `data` entry
named `brainstrike.delegated-conversation` or `brainstrike.child-continuation`
once it has routed it to its child receiver; the parent accumulator never sees
it. Other entries in the same list are forwarded. A `part-start` data part owns
a parent part index and is still forwarded. Forwarding made assistant-stream's
accumulator and assistant-ui's local runtime copy every child frame into the
parent's `metadata.unstable_data` and publish a new parent message per frame,
re-rendering every parent part. In one GLM fan-out the root held 8,146
envelopes and 860 parts, React's development build retained 14.1 million
performance measures, and the renderer grew to 15 GB. Paired:
`delegated-conversation-receiver.test.ts` ("consumes routed child envelopes so
the parent message neither retains nor re-emits them").

SETTLED 2026-09-15, GROUPED PARTS RENDER ISOLATION (pnpm patch, do not
relitigate without an upstream release that fixes it): a fan-out root message
carries hundreds of run-event data parts (755–1,083 observed), and
`MessagePrimitive.GroupedParts` in @assistant-ui/core 0.3.17 (unchanged in
0.3.19 and on upstream main) handed every leaf a new render closure on every
render, defeating `MessagePartChildren`'s cache. Every root token then
re-rendered every part subtree (~1,000 parts at ~60 commits/s in run 17) and
the dev renderer crashed at 17 GB. `patches/@assistant-ui__core@0.3.17.patch`
builds one leaf closure per `children` identity. Paired:
`grouped-parts-render-isolation.test.tsx` ("does not re-invoke unchanged leaf
parts when another part streams" — 80 extra leaf renders before the patch, 0
after; "renders leaves with the new render function when the caller replaces
it" — fails when the memo ignores `children`). The upstream report is drafted,
not filed; delete the patch when a release carries the fix.

The decoder belongs to the native invocation, not to each observed native
message id. A resumed turn may move from its persisted message id to a new
native step id; the envelope preserves that observation while the same decoder
continues through its single terminal. Such a change must not create a second
unfinished decoder or discard an active tool part.

Production-loop tests cover concurrent same-persona children with distinct
native threads/runs/messages, including intentionally reused child tool IDs and
text → reasoning → tool → text ordering. The desktop observer persists child
lifecycle events in ordinary child run/event records, with a separate opaque
host run id per native invocation and host resume leg. One atomic repository
mutation revalidates ancestry, native run/persona and both original/current host
turns before creating the header/event. The child model comes from its stored
persona pin or the original inherited model; unrelated root settings and user
message ids are not copied. A malformed pin rejects rather than changing model.

The existing history adapter attaches these events to their observed native
message ids, so several resume legs can share one assistant group without
losing later events. A real desktop Mastra/PGlite test decodes the saved child
text/tools/events through this adapter before and after engine reconstruction.
A native root-cancellation test proves one child cancellation/finish and retains
partial content; removing settlement fails that test. A child terminal or pause
settles only its own projection. If the parent ends while a child is still open,
the child is cancelled on user abort or visibly failed for an interrupted stream.

Active child calls receive an error tool result plus a paired failed/cancelled
tool run event before synthetic termination, so the normal decoder cannot leave
them running. Already completed calls are not terminated twice. Execution-time
measurements use `(native thread id, tool-call id)` inside the request's recorder;
the guarded executor's public agent context and the host's authorized invocation
binding supply the two matching scopes. Parent steering is not inherited.

Recreated native grandchild approval and decline tests now run resumed output
through the production mapper. The first resumed parent wrapper lacks its own
message id; the authorized invocation's persisted native message id supplies
that missing scope. Both child and grandchild finish once with valid identities.
This proves the mapping seam, not the later production approval UI/routing ticket.

This layer does not close BST-1719. Nested pause/resume production proofs,
oversized artifact reload recovery and
complete receiver routing remain acceptance work. Child UI and controls remain
BST-1720/1723/1724/1725; read-only/no-nesting restrictions stay in force.

## 2026-09-26: delegated custom tool progress

A Worker command failed after its native tool start with `Delegated stream
requires observed native identity.` Real Mastra/PGlite reproduction showed
`writer.custom()` shell-output parts arriving inside a native delegation envelope
without a nested `runId`. MCP progress uses the same custom-writer boundary.
The native parent run and delegation call still identify an already authorized
child; the custom part must also name a tool call currently active in that child.
These two progress types use that established ownership. They cannot establish
an invocation, reopen a completed child, or weaken identity checks for native
events. Native IDs that change remain errors. Budget `data-*` handling is unchanged.

The recorded command's effective permission policy had execute=`ask`, yolo=false,
and an explicit `brainstrike.executeCommand` per-tool `allow` override. That
override legitimately takes precedence over the category; the debug pack does
not establish when or how the user granted it. No permission policy change is
part of this fix.

Guards: `packages/agent/src/__tests__/delegated-custom-tool-output.integration.spec.ts`
uses real native Worker shell-output and MCP-progress writers;
`packages/agent/src/__tests__/delegated-stream-projection.spec.ts` checks exact
ownership and rejection boundaries;
`apps/desktop/e2e/delegated-worker-command-output.desktop.test.ts` exercises
real command approval, per-tool grant, streamed stdout/stderr, and reload history.

A real Electron approval test exposed the second boundary: on a fresh resume
leg Mastra executes the paused tool without replaying its native tool-call
event. The first custom output therefore has no admitted projection state.
Seed that leg from the already validated native pause and ancestry, authorize
each invocation through the existing binding, and project the leaf start using
the saved native message ID before consuming output. This also covers typed
resumes and session-granted siblings. A live decision in an existing leg instead
reopens only the exact parked invocation with its still-active tool call.
Completed invocations and terminal tools stay closed.

The live-decision guard is
`packages/agent/src/__tests__/delegated-live-tool-output.integration.spec.ts`;
`background-worker-policy.integration.spec.ts` proves both granted siblings
retain their own output owners.

Selective Stop also leaves already-queued custom output in the parent stream.
A production-mapper regression reproduces the first queued part cancelling its
child and the second part failing the parent. Once exact ownership and the known
leaf call are verified, discard output for a completed child without reopening
it; unknown ownership and malformed native identities still fail closed. A
sibling continues normally, and the selected child emits no duplicate terminal.
Guard: `delegated-cancelled-custom-output.spec.ts`.

On resume, publish answered-approval notices before seeded child starts so a
granted sibling cannot appear running with a still-actionable approval card.
The seed uses the canonical native tool-call payload shape. The native background
sibling integration asserts this ordering before either resumed output stream.
