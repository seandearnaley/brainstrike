# SubagentCard rows, invocation index and timeline pairing — evidence

Supports `docs/agents/assistant-subagents.md` § "SUBAGENTS (PERSONA DELEGATION)".

Why child tool rows are read thread-wide, how the incremental invocation index stays cheap, and the run-event terminal pairing rules it forced.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 610–711 at commit 7c3eb8f38.

---

The SubagentCard renders per-child-tool rows from BOTH the tool part's persisted
`subAgentToolResults` (authoritative on reload + at completion) AND LIVE
`subagent.tool.*` run events read THREAD-WIDE, scoped by `parentToolCallId`
(`readLiveSubagentToolRowsFromMessages`); persisted rows supersede live rows by
child `toolCallId`, so a running delegation shows its in-progress tool count
instead of "Running · 0 tool calls". Thread-wide, not message-scoped, is
load-bearing (2026-08-24): hydration weaves a run's events into ONE assistant
group and an approval-resume turn SPLITS into sibling groups, so on reload the
events can land on a different message than the card — a message-scoped read
showed "0 tool calls" for a completed four-minute child. The events are
parent-scoped by construction, so the wider read cannot pick up another
delegation's rows. The same thread-wide rule applies to the no-answer outcome
read (`readSubagentDelegationOutcomeFromMessages`).

The thread-wide projection is maintained by ONE `SubagentInvocationIndexProvider`
per mounted thread. Cards subscribe by `parentToolCallId`; a child event changes
only that invocation's immutable snapshot. The index walks the O(message count)
outer list on a thread-store notification, but it never revisits retained parts:
new message parts are folded from the previous length, an unrelated text update
reads zero run-event parts, and a message settlement revises its unresolved rows
to `interrupted` without a part scan. Message ids are required by assistant-ui's
public `MessageState` contract. The provider subscribes through the public root
client, then rereads once after subscription to close the render/effect gap;
render and snapshot reads never mutate or notify. Removal/reorder/id replacement
or part shrink rebuilds the authoritative projection. A settled message is
immutable during a normal run, so a new parts array for the same settled id is
the public runtime boundary for hydration, import, reset, or branch replacement
and also rebuilds the projection. Metadata identity is deliberately ignored:
ordinary metadata publication must not rescan retained content.

The incremental cursor relies on an installed producer invariant, not array
identity: `assistant-stream` 0.3.41's `appendData` creates a finished part stream,
`handlePartStart` constructs a new data object, and `appendPart` installs a new
parts array. Later delta handlers can replace text/reasoning/tool indexes, but
there is no data-part delta handler. An already emitted run-event data payload
therefore cannot mutate at the same index. When a running message publishes a
new parts array, the index makes a cheap identity pass over the retained prefix;
it folds no retained payloads, but rebuilds if any retained part changed. The
only permitted same-length difference is the known mutable final
text/reasoning/tool-call part. Tests in
`subagent-invocation-index-model.test.ts` pin 1k/5k/10k retained-part work counts,
same-array and immutable-array append, sibling-message resume, settlement, authoritative same-id
replacement with stable metadata, shrink/reorder/outcome rebuilds, metadata-only
updates, snapshot isolation and listener cleanup.
`subagent-invocation-index.test.tsx` mounts the provider against the real public
assistant-ui local runtime and covers append, settlement, same-id replacement,
runtime switch, StrictMode, and unmount with zero React warnings. A controlled
stream proves started/completed data parts publish before the run settles;
disabling the subscription makes this regression fail. The public API rationale
follows the current
assistant-ui state selector, external projection, store state, and rendering-list
guidance: `docs/api-reference/hooks/state`, `docs/guides/state-outside-the-thread`,
`tap/docs/store/state`, and `tap/docs/store/rendering-lists`.

Because every `subagent.*` row is HIDDEN from the main run timeline (it belongs
to the card), the timeline's `.started` → terminal pairing never had to be right
for them — and it was not: `getMatchingCompletedKind` rewrote the suffix, so
`subagent.started` paired with `subagent.completed`, a kind neither declared in
`ASSISTANT_RUN_EVENT_KINDS` nor emitted by anything, while
`getMatchingFailedKind` returned null for both `subagent.started` and
`subagent.tool.started` despite their `.failed` terminals existing. Both helpers
now resolve candidate terminals AGAINST the declared kinds, so a pairing can
never name a kind nothing emits. Both live in
`packages/assistant-ui/src/assistant-run-event-derivation.ts` (the pure-logic
module #2477 split out of the component file). No user-visible change — the rows stay hidden either way — but the
"run-event terminal pairing contract" cases in `assistant-run-timeline.test.tsx`
pin every declared `.started` kind to its declared terminal so emitters and
pairing cannot drift apart again.

Enabling that pairing forced two rules the timeline previously never needed,
both pinned by tests in the same file:

- **Scope by the delegation's own id.** `MAX_CONCURRENT_DELEGATIONS` is 2, so
  two `subagent.started` rows are open at once, and subagent LIFECYCLE events
  carry `parentToolCallId` with NO `toolCallId` of their own. The timeline's
  scoping used to be `tool.started`-only (`toolCallId`); it is now keyed per
  kind (`scopeMetadataKey`) — `parentToolCallId` for `subagent.started`, the
  child `toolCallId` for `subagent.tool.started`. Unscoped, the first
  `subagent.finished` in a run closes EVERY open delegation row and reports one
  delegation's outcome on another's.
- **Take the terminal's own status, not a status derived from its kind.**
  `makeCancelledDelegationRunEventChunks` emits `subagent.failed` carrying
  status `cancelled`; a kind-derived `failed` would report an aborted run's
  delegations as hard failures. Both resolvers now read the matched terminal's
  status, which is identical for every other pairing (`tool.completed` is
  `completed`, `run.step.finished` is `completed`, and so on).

The SubagentCard routes by tool-name PREFIX for user personas:
assistant-ui's `by_name` map is exact-match, so only built-ins pre-register;
`ToolFallbackWithSubagents` (todo-progress.tsx) forwards any `agent-*` part to
the card, and `personaLabelForToolName` falls back to the persona id for
non-built-in delegation tools (never blank, never a raw tool card).

Shipped in v2: user-defined personas, persona model pinning, and the
preferences availability toggle (all above). Follow-ups (out of scope):
nested approval UX + a `subagent` policy row (D13), child input-budgeting
(`messageFilter`), per-persona label/description IPC enrichment of the
SubagentCard, and hot-reload of persona files mid-session (personas re-scan
per request, so edits apply on the next turn).

When changing this flow, update this section and the paired tests.
