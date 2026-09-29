# Activity grouping rules — evidence

Supports `docs/agents/assistant-runtime.md` § "ACTIVITY GROUPS".
Read before changing `groupAssistantActivityPart`, the grouped-parts indicator, or group status/chronology derivation. BST-1656, BST-1679, PR #3061.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 1588-1678), extracted verbatim.

The assistant message renders its parts through `MessagePrimitive.GroupedParts`
(`packages/assistant-ui/src/assistant-activity-parts.tsx`) with
`groupAssistantActivityPart` (`assistant-activity-grouping.ts`) as the grouper.
The library's legacy `components.ChainOfThought` path is gone from this repo
and must not return: its grouper ends a group on ANY part that is not
`tool-call`/`reasoning`, and this runtime emits a `brainstrike.run-event` data
part around every tool call (live via `aui-data` → `part-start`, and woven
between parts on reload), so every call rendered as its own "Worked · 1 step"
group. Grouping rule (pinned by `assistant-activity-grouping.test.ts`):

- `reasoning` / `tool-call` → the activity group.
- `brainstrike.run-event` → group-transparent, EXCEPT `isAlwaysVisibleRunEvent`
  kinds, which stay standalone so a collapsed group can never hide a failed or
  cancelled run, a skipped MCP server, or a pending approval row.
- shell-output / context-breakdown / child-run-usage → transparent (they
  render `null` either way).
- tool-approval / tool-suspend cards, `text`, and unknown data parts →
  standalone. A pause is a real boundary.
- MCP-app tool calls stay inside the group: Brainstrike detects apps by RESULT
  shape only, and a call must not change groups when its result lands.
- A `group-activity` node holding only transparent data parts (no
  `reasoning`/`tool-call` — for example a trailing `run.finished` after the
  final text) renders its children bare: `ActivityGroup`
  (`assistant-activity-parts.tsx`) returns them directly instead of mounting
  `ActivityTrace` — no chrome, no `assistant-activity-group` test id.

`AssistantActivityParts` passes `indicator="no-text"` to `GroupedParts` (the
library default), required for parity with the legacy path's empty-message
placeholders (`EmptyParts`, `ConditionalEmpty`) — `"never"` blanks the
assistant bubble from Send until the first part arrives, which regressed the
pre-first-token thinking indicator. The library also emits that slot whenever
the last part is a tool call or transparent data part, i.e. while an activity
group is live; the renderer drops it exactly when the TRAILING group holds an
activity part (`trailingGroupHasActivity(state.message.parts)`), so that
group's header is the sole live status and no second "Thinking" row trails a
collapsed group (CDT pass 4). The slot still renders for a running message
with no activity in its trailing group — zero parts, only standalone data such
as `run.started`, or `[…, text, tool.started]`, where the earlier group is no
longer trailing (it reads `Worked`) and the bare data-only group renders
nothing, so the slot is the turn's only live affordance until the next
tool-call part lands. Suppressing on "any activity part anywhere" darkened
that window (review finding, wave 3). A trailing approval/suspend card is
standalone as well, but a message paused on one is `requires-action`, not
`running`, so the library emits no slot there regardless.

Chronology rulings (unchanged): each contiguous group renders at its own
position; never hoist later parts into an earlier group or suppress later
groups. Group status is the library's `GroupPart.status` (running if any part
runs, else the last part's). `ActivityGroup`'s `isActivityActive` reads `true`
when: the group's own status is `running`; OR any of the group's ACTIVITY
parts is `requires-action` — a call paused at its approval gate carries this
status, never `running`, for as long as the gate stays open, and only this
branch makes the model's `waiting` → `Waiting for approval` label
(`activity-trace-model.ts`) reachable (BST-1679 task 6). That clause reads the
activity parts, never the raw group status: `GroupPart.status` mirrors the
group's LAST member, which a group-transparent run-event data part (or a
settled sibling call) can be, so reading it raw darkened the whole approval
wait in the same shape finding 1 (below) fixed for the headline. It is a
`.some` over the parts, matching `liveLabel`'s own `findLast(waiting)`: ANY
gated call holds the pause. OR the message is
still running, this group holds the message's last part, and the group's own
status has not resolved to `incomplete` — a tool call's result can land in the
same streamed chunk that fences the next call into the same coalesced group,
so a purely part-derived status would otherwise flash "Worked" for the
model-latency gap between two calls of the same run. Only the trailing group
gets this treatment: earlier, genuinely finished groups stay inactive when
later thinking starts (BST-1656 ruling preserved). The reasoning disclosure
renders live reasoning text directly from `useMessagePartReasoning`, never
through the text-part renderer; each reasoning part carries its own
disclosure (open while it streams, collapsed once it settles, a manual toggle
sticks), so a group with several thinking blocks never opens or closes them
together — test ids and labels unchanged. Reasoning-only groups omit the step
count. Incomplete group status is authoritative (cancelled → Stopped; other
reasons → Activity failed); a completed call with the canonical `isError`
flag is counted once into the header's `· N failed` suffix — it never turns
the group itself failed, only the group's own incomplete status does. The
group's `Stopped`/`Activity failed` headline is derived from its ACTIVITY
parts (running if any runs, else the last reasoning/tool-call part's status),
never from a transparent data member, so a trailing `tool.completed`/
`tool.started` cannot mask an interrupted call (PR #3061 review finding 1:
`getGroupStatus` mirrors the group's own last member — including transparent
data parts — which can read "complete" even though an earlier, resultless
call in the same group is `incomplete`) — and a group whose activity all
resolved reads `Worked` even on a cancelled/errored message (the standalone
`run.*` row carries the run outcome; this narrowed an earlier, over-wide fix
that inherited the message's incomplete reason onto the whole trailing group,
including one whose own activity had already resolved). Tool
durations and shell output correlate by call id across the message; each
group's elapsed fallback uses only its own tool events. The turn-wide task
list renders once, in the group holding the
message's first activity part.

## Separate approval cards (2026-09-29)

The ACTIVITY GROUPS contract gives each approval one presentation owner.
A card can appear in a separate message, while the original resultless tool
part retains `requires-action`. Searching only that original message left its
group animated after the card showed Approved. `approval-history.ts` also
matches the recorded `tool.approval.requested` event's durable host leg and
surface call against the thread's existing approval index. The incremental
index stores these display keys once, and clears them when history rewrites.
The card owns the decision history; no execution result is invented. A group
with other work remains, while an empty duplicate approval wrapper disappears.

The first reproduction incorrectly gave the event and approval the same run ID.
Review caught that desktop events use host-leg IDs while approvals retain native
Mastra IDs. The corrected fixture failed, then passed after correlating against
the request's existing `hostRunId`. A bare call ID, native run ID, another host
leg and child leaf ID cannot substitute for the host binding. Rediscovered
requests without a host binding do not invent one; ordinary settled hydration
and same-message card ownership retain their existing behavior.

Guards: `approval-history.test.ts`, `answered-approvals-index.test.ts`,
`assistant-activity-parts.test.tsx`, and `approval-group-history.browser.test.tsx`
in `packages/assistant-ui/src/__tests__/`. The browser test starts with separate
native/host IDs, clicks Approve through the real assistant-ui local runtime,
receives an acknowledgement, and checks static Approved history and one adapter
execution without the stale waiting group or shimmer. This is renderer coverage,
not a claim of a live-model desktop end-to-end run. Existing host stamping and
mapper-forwarding tests cover production of `hostRunId`.
