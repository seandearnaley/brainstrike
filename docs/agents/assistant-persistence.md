# Assistant Persistence, Notifications, Context Meter

> Extracted from AGENTS.md (2026-07-12). Read before changing message persistence/hydration, run notifications, or token-budget wiring. Keep updated with the code.

## ASSISTANT THREAD PERSISTENCE & RELOAD HYDRATION

Per-thread workspace snapshots (`brainstrike_assistant_thread_workspaces`) are
loaded into renderer-owned live stores by
`useThreadWorkspaceCoordinator`; those stores remain the working authority.
Initial boot is an ordering boundary because the active thread can restore
before PGlite is ready. While that first snapshot read is pending, store
notifications must not persist the unhydrated singleton state over the saved
row. The coordinator captures a boot baseline instead, then merges only fields
that changed in the live stores after that baseline into the loaded snapshot
before applying and immediately persisting it. This delta covers apps and
selection, file tabs, editor mode/scroll/pane state, Explorer expansion/scroll,
and root views. If the initial read rejects after a live edit, the coordinator
persists the current live snapshot immediately instead of waiting for another
notification. Editor deltas are admitted only for tabs in the loaded snapshot;
a changed tab set is preserved atomically with its live editor map. That key
filter is required so stale pane/editor state from another thread cannot leak
through a boot or `A -> null -> B` transition. Ordinary thread switches never
reuse this boot merge: they synchronously flush the outgoing live snapshot,
then hydrate the incoming snapshot under an intent guard. The deterministic
ordering regressions live in
`packages/app-shell/src/thread-workspace/__tests__/use-thread-workspace-coordinator.test.tsx`.

Desktop assistant threads also persist their operating-root capability in the
existing `mastra_threads.metadata` JSON (no schema migration):
`operatingRootId` is the durable DB `roots.id`; `operatingRootDisplayName` and
`operatingRootPath` are display-only. The first data-stream request writes the
binding before creating the run. Before that write, app-shell resolves the
mounted adapter root's absolute path to exactly one live `roots` row; adapter
root ids are never persisted as execution authority because reconnects may
change them. Later requests/resumes reuse the durable id instead of reading the
current global Main/Focused root. The app-shell metadata sanitizer and write
boundary reject partial bindings and any present-but-invalid operating-root
field: id and display name are required together, while path is optional.
Checkout transitions use the same post-persistence projection in the loaded
thread store as the repository row: setting a mode removes `checkoutBranch`,
and setting Local additionally removes `checkoutLocalRootId`,
`checkoutWorktreeId`, and `checkoutWorktreePath` before the patch is merged.
The store changes only after the repository write succeeds.
Bulk metadata updates reject every `checkout*` key: checkout transitions require
the single-thread writer's atomic deletion projection and must never raw-merge a
partial checkout record across threads.
Malformed persisted ids never sanitize to "unbound" and cannot silently rebind
the thread. Server-side native tools validate only the id against the live root
inventory; the stored path is never an authority or fallback.

Automatic thread titles use Mastra Memory's top-level `generateTitle: true`
option and `Agent.generateTitleFromUserMessage`. At the terminal Mastra finish,
the stream adapter starts that canonical title request with the active agent
model before yielding the UI finish, then keeps the per-run Mastra instance
alive for one bounded 30-second title lifecycle. The title model receives the
active request's provider options and output-token cap; OpenRouter retries one
text-empty result on that same model, never a fallback provider. Expiry aborts
the underlying model call and marks the transactional PGlite save for rollback,
rather than merely detaching either operation. Provider, invalid-output,
configuration, persistence-read, and persistence-write failures are logged with
stage-specific privacy-safe metadata while the successful main response remains
intact. Generation remains independent of Observational Memory, its token
threshold, and whether OM is thread- or resource-scoped. The generated title is
persisted through `PgliteMemoryStore.saveThread`; that transactional boundary
may replace only an empty/default/system-owned title and stamps `titleSource:
'om'`, while the manual rename path clears the marker and always wins even if
generation was already in flight. Title generation deliberately does not delay
the main assistant response, so provider `message-finish` is not a reliable
primary title-refresh signal. App-shell live-subscribes to the local
`mastra_threads` id/title projection and re-lists the loaded resource only when
that stable projection changes. This makes background titles visible in thread
rows and tabs without a timer or an API round trip. The existing
`message-finish` refresh remains intentionally separate: once per completed
turn it updates thread recency, ordering, and latest-run details, and provides
a best-effort recovery path if the live subscription has failed.

Loaded resource thread lists enforce latest-successful-start ordering per
resource without timers. Every refresh receives a generation from that
resource's map entry. A non-empty successful result applies unless a
later-started successful result has already applied; a newer empty result or
rejected read does not suppress an older successful result. Empty-result and
stale-generation checks remain separate because they encode different
contracts. `resetAssistantThreadStore` clears the generation map, and each
in-flight refresh also retains its map-entry identity, so a result from before
reset cannot publish into the reset store even if a new resource refresh later
reuses the same numeric generation. The gated-promise regressions live in
`packages/assistant-data/src/__tests__/assistant-thread-store.test.ts`.

Hosted-provider turns are persisted by Mastra (the durable writer) into
`mastra_messages`; the client history adapter is read-through only. Two
contracts keep reloaded threads identical to live ones:

1. **Persisted dialect (Mastra v2 / `MastraMessageContentV2`):** content is
   `{ format: 2, parts: [...] }`. Tool calls are
   `{ type: 'tool-invocation', toolInvocation: { toolCallId, toolName, args,
   state, result } }` parts with results INLINE — there are NO `role: 'tool'`
   rows in this dialect (the legacy `tool-call` part + separate tool rows is
   still supported for old data). Reasoning may arrive with a `reasoning`
   field instead of `text` (and is often empty for encrypted provider
   reasoning). `step-start` and `data-om-*` bookkeeping parts are not
   renderable. Live-loop proof (real agent + real PGlite memory, no mocks):
   packages/agent/src/__tests__/mastra-memory-persistence.integration.spec.ts. Hydration
   fixtures must mirror REAL persisted rows, never hand-written shapes — a
   hand-written `tool-call` fixture previously kept tests green while real
   tool history silently vanished on every reload.
   Tool output uses a deliberate dual channel: Mastra persists
   `toolInvocation.result`, while `toModelOutput` supplies the bounded text or
   multimodal projection repeated into provider requests. Native tools keep the
   raw domain result. Approval resumes seed the live stream from Mastra's exact
   storage-backed suspended-tool snapshot before consuming resumed output. That
   preserves the original `toolInvocation.args` when the resumed provider emits
   only a terminal result; both the live completed card and this format-2 row
   therefore hydrate with the same arguments. While the approval and resume
   legs temporarily occupy separate assistant-ui messages, rendering correlates
   their non-empty arguments by the unchanged `toolCallId`; a resumed live copy
   exposing `{}` cannot replace the approved payload. Missing snapshot arguments
   abort the decision before execution instead of persisting an invented empty object.
   PostToolUse context is model-only: hook execution uses a
   discriminated internal carrier, `transform.display` unwraps it for the live
   UI, and `transform.transcript` unwraps it for storage. Mastra 1.51 attaches
   the correct transcript transform metadata but still hands its raw in-memory
   message to `MemoryStorage.saveMessages`; `PgliteMemoryStore.saveMessages`
   therefore applies that official transcript projection again at the durable
   boundary, returns the projected messages from `saveMessages`, and
   independently refuses to store or return a surviving internal carrier.
   The real-memory hook regression proves the stored invocation is the exact
   domain result while `providerMetadata.mastra.modelOutput` retains the
   model-only guidance. OpenAI hosted `tool_search` calls add a stricter
   round-trip invariant: Mastra's consolidated invocation retains the `tsc_`
   call as `toolCallId`, the distinct `tso_` output in provider metadata, and
   `providerExecuted: true`. On reload Mastra projects the result metadata onto
   both model parts, so the OpenAI-only request processor restores the call
   reference from `toolCallId` and the output reference from the persisted
   metadata at the transient provider boundary. The real PGlite integration
   proof serializes the next turn with the production OpenAI Responses model
   and requires each item reference exactly once; missing output metadata
   remains a visible error, never a call-ID fallback. MCP results remain inline
   only within the explicit temporary persistence ceilings documented in
   `assistant-providers.md`; text-only MCP output is preview-bounded until
   artifact settlement is wired. Never replace a native result inside
   `execute()` merely to save prompt tokens; that destroys
   reload/application evidence. The real-memory proof includes an oversized
   native sentinel and replays a second turn from the same thread in
   `packages/agent/src/__tests__/mastra-memory-persistence.integration.spec.ts`;
   it also reconstructs a fresh hosted runtime over three stored native reads
   and proves that transient stale-history filtering removes only the oldest
   provider-facing call scaffolding while all three raw database rows remain.
   the live-provider proofs that raw sentinels are absent and MCP image/audio
   remain model-native live in `mastra-tool-execution.integration.spec.ts`.

   **Provider citation markers are normalized at this same durable boundary.**
   OpenAI models running native web search emit citation bookkeeping inline in
   the text stream, wrapped in private-use codepoints
   (`U+E200 <type> U+E202 <payload> U+E201`, plus `U+E203..U+E204` hidden spans).
   `projectMessageContentForTranscript` in
   `packages/agent/src/pglite-mastra-memory/transcript-projection.ts` strips them
   from BOTH `parts[].text` and
   the flattened `content` string — the latter is the search extractor's
   fallback for rows with no text parts (see the `CONTENT_TEXT_SQL` contract in
   `packages/db/src/repositories/thread-search-repository.ts`). The rule itself
   is `stripProviderCitationMarkers` in
   `@brainstrike/assistant-contract/citation-markers`, shared with the render
   seam so the two cannot diverge. Three constraints are load-bearing and must
   survive any future writer:
   - **ASSISTANT ROWS ONLY.** Providers emit these markers on assistant text.
     Rewriting a user row is irreversible, makes a reloaded prompt differ from
     what the user typed, and alters the history replayed to the model; it also
     contradicts the renderer, where `UserMarkdownText` renders user-authored
     text verbatim.
   - **Settled-text mode.** Durable writers pass `{ unterminated: 'keep' }`.
     The unterminated-span heuristic exists for half-arrived markers mid-stream
     and is only safe where a later render can undo a false positive; these
     codepoints are also Nerd Fonts glyphs, so at a write-once seam an
     unterminated opener is treated as content, not as a truncated marker.
   - **`text` PARTS ONLY.** `reasoning` parts are persisted verbatim and keep
     any markers in the row. Nothing downstream reads them as prose (search
     filters `type = 'text'`; `getCopyText()` does not join reasoning), and the
     one consumer that renders them, `assistant-reasoning-part.tsx`, strips at
     read. The projection is not "everything downstream is clean" — it is these
     parts, for these readers.
   - **WRITE-TIME ONLY.** Rows persisted before this shipped keep their markers
     and stay that way in search until rewritten. Do not assume stored text is
     clean; backfilling is an unperformed data migration.

   Test seam: `packages/agent/src/pglite-mastra-memory/__tests__/pglite-memory-store.save-messages.spec.ts`
   (assistant rows stripped, user rows verbatim, trailing glyph preserved).
2. **Snapshot grouping + live-order interleaving:** observational-memory
   sealing and per-step saves split ONE live assistant turn into several
   `mastra_messages` rows (progressive snapshots under fresh ids, so one
   toolCallId can appear in several rows). Hydration
   (packages/assistant-data/src/assistant-memory-repository.ts) therefore:
   - merges consecutive assistant rows into ONE assistant-ui message (id =
     last row, createdAt = first row; legacy `role: 'tool'` rows don't split
     a group),
   - dedupes tool calls by toolCallId (first occurrence wins; later
     result/error fields merge in),
   - recalls the latest 80 message rows together with events from the latest
     80 runs, partitions events by `runId`, assigns each run to the assistant
     turn inside that run's time window, and weaves them between content parts
     in time order. Never attach only the newest run to the newest message:
     older turns would lose tool failure state, timings, and subagent activity
     after reload. Tool-invocation parts carry no persisted timestamp, so each
     is re-timed to its `tool.started` run event (matched via
     `metadata.toolCallId`); other untimed parts anchor to their snapshot row's
     save time. Equal-timestamp rows use Mastra's per-part `createdAt` values
     before the row role/id fallback. A group with only run events still
     renders.
   - recognizes guarded tool results with the canonical
     `@brainstrike/assistant-contract` type guard. A known guarded result
     (`ok:false`) hydrates as a failed tool call even though Mastra persists
     the invocation itself with `state:'result'`; the execution and replay
     paths must never maintain independent guarded-error code lists.

Mastra deliberately skips its normal finish writer (`executeOnFinish`) when an
abort signal wins. Since Mastra >= 1.62 (upstream #22243; BST-1667 moved core
to 1.64.0) that is no longer the whole story: the `MessageHistory` output
processor persists a cancelled run's transcript through normal output
processing (`processOutputResult` → `persistMessages` →
`storage.saveMessages`, partial tool calls filtered), the
`persistPartialOnAbort` opt-in is gone because cancellation persistence is no
longer optional, and that write is NOT awaited by the aborted loop. Measured on
the live-loop PGlite proof
(`packages/agent/src/__tests__/mastra-memory-persistence.integration.spec.ts`):
a user Stop landing right after a tool result carries the completed tool work
and no partial text; a watchdog abort persists the stalled attempt's partial
text as its OWN assistant row; an approval-resume cancel persists the partial
text. For terminal watchdog aborts and user cancellation only,
`packages/agent/src/mastra/aborted-turn-persistence.ts` (created by
`createRuntimeAbortedTurnPersistence` in `turn-attempts.ts`) therefore owns one
bounded abort-finalization seam over Mastra's public live `MessageList`: it
drains the unsaved messages, keeps the user input and every assistant message,
REMOVES tool invocations that never completed (Mastra filters partial tool calls
from its own write and the seam must not re-introduce one, or Stop could
resurrect execution on the next turn), RETAINS partial text (dropping it cannot
remove the row Mastra already wrote, and a snapshot that disagrees with the UI
transcript is the BST-1415 failure), drops assistant messages left with only
`step-start`, appends the model-visible
`[Assistant turn aborted before completion.]` marker as the last text part of
the last retained assistant message (or as a standalone assistant message when
none remains), and awaits `Memory.saveMessages` before disposing the per-run
runtime — including when a recovery continuation fails during construction.
Re-saving ids Mastra already wrote is an upsert of identical content. Under
Contract A the partial text tail is therefore RETAINED; only incomplete TOOL
work is excluded. The awaited save is also load-bearing as a join: with
`shouldPersist` forced false (measured 2026-09-06), Mastra's floating
abort-time write raced the PGlite `close()` in suite teardown and wedged the
vitest worker at 100% CPU — the BST-1320 mechanism. Initial, approval-resume,
and suspended-tool resume streams share this Brainstrike-owned terminal seam;
read-only memory streams skip it and remain write-free. If the snapshot write
itself fails, the seam emits the structured
`mastra_agent_aborted_turn_persist_failed` server error and preserves the turn's
existing terminal chunks and cleanup instead of throwing after termination. A
normally finished turn marks the seam closed before teardown, leaving Mastra's
existing writer exactly-once. The live-loop PGlite proof covers normal
completion, watchdog abort, user Stop, resumed streams, next-turn recall, and
non-reexecution of completed tools; the unit proof
(`packages/agent/src/__tests__/aborted-turn-persistence.spec.ts`, two cases)
pins the content rule. An individual provider attempt that stalls but is
replaced by a successful continuation is not an aborted turn and does not
persist an abort snapshot; abort finalization runs only when the turn itself
becomes terminal.

The same terminal owner also joins delegated child snapshots (BST-1719). Native
delegation sets `lastMessages: false`, so the child cannot rely on automatic
MessageHistory output persistence. Capture the child's public native MessageList
at Stop and await the native `afterToolCall` hook before re-saving that snapshot:
saving before completion allowed a late native write to restore a tool result
and erase the abort marker after the root had returned. All captured child saves
settle even if one fails; the root still attempts its own snapshot and the
existing coded abort-persistence failure reports the errors. No second transcript
store or client-generated child prompt/message id is introduced. Child snapshots
also finalize at a replaced watchdog attempt, independently of the root's
successful-continuation policy, and before runtime disposal. Their content is
frozen through the same JSON representation as the memory store, so a value
accepted by normal storage is not rejected merely by `structuredClone`.

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
   loaded; else the suspending run's `turn_message_id` (BST-1163 — the echo
   marker carries the runId, and every leg of a turn stamps the same link, so
   this stays exact when other sends land during the suspension and when the
   suspended run is a regeneration branched from an older prompt); else the
   live session tail only as a legacy last resort for runs predating the turn
   link. Invalid action markers remain ordinary prompts and keep their edges
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
   `assistant-approval-topology.integration.test.ts` and the desktop E2E
   `assistant-approval-reload-linearity.desktop.test.ts`.
   The UI transport preserves each assistant-ui user message id through the
   generic-message conversion, and the desktop request parser preserves
   assistant-ui's `unstable_assistantMessageId`; the stream session and Mastra
   id generator both use those validated ids for the persisted user/visible
   assistant pair. A normally finished stream asserts that the one-shot Mastra
   generator consumed the assistant id through its memory message context,
   making upstream contract drift visible instead of quietly substituting a
   UUID. Initial turns and both approval/suspend resume paths pass a separate
   per-call stream-id generator with the same initial id; the Mastra-global
   generator remains reserved for the persisted memory row, so a transient
   resume stream id cannot consume the durable identity first. If
   observational-memory sealing creates additional snapshot rows,
   hydration keeps the topology-bearing row's id for the combined assistant-ui
   message. A new topology-bearing assistant id always starts a new hydration
   group, including after an open legacy group, so consecutive regenerated
   responses remain carousel siblings rather than being mistaken for snapshots
   of one response.
   This end-to-end identity alignment is what lets a later edited prompt point
   to its durable assistant parent without correlation heuristics.
   Desktop generation continues in the main-process data-stream session when a
   renderer response detaches. The durable run row is updated only after that
   session closes. Its mapper-owned terminal outcome is authoritative for
   abnormal model finishes: an output-limit or missing-finish terminal state is
   stored as `failed` with the bounded visible error, while only explicit
   `POST /assistant/cancel` records `cancelled`.
   Renderer reload reattachment is deliberately ephemeral rather than a second
   durable run store: thread-scoped `sessionStorage` holds the server session's
   opaque replay cursor, durable run id, and durable assistant message id only
   while the main-process session is active. Reload hydrates persisted history
   first, then replays that exact session through `GET /assistant/resume` into
   the same assistant message and persisted parent; it does not create a
   duplicate branch, another run row, or resend model input. Completion,
   failure, Stop, a visible expired-session response, replay retry
   exhaustion, and the stale-record reclaim below remove the ephemeral
   record. The record is a HINT, never a second authority: before the
   "awaiting stream reattachment" guard rejects a new run, `prepareRequest`
   reconciles the record against the durable run row through
   `GET /assistant/run-status` (the same authority as the BST-1244
   Threads-panel projection) — a terminal or missing durable run reclaims
   the record with a logged warning and the new run proceeds; only a
   genuinely `running` durable row keeps the guard, and a failed probe keeps
   the guard (fail-safe, never a silent reclaim). Replay failures that
   exhaust the retry budget run the SAME durable-status reconciliation:
   the record is released only when the run is provably over, and KEPT
   while the durable row still says `running` — the main-process stream
   continues after renderer detachment, so an unconditional clear would
   let the next send start a second concurrent turn against the orphan
   (Codex review, #2510). Keeping it cannot wedge the thread anymore: the
   next send's reconcile heals once the run ends (2026-08-18 field
   failure: a dev-mode renderer reload mid-stream orphaned a record whose
   run finished seconds later, and every send until app close was
   rejected). The
   expired-resume 404 is logged server-side so "expired" and "never
   attempted" are distinguishable in diagnostics. The public assistant-ui runtime temporarily creates a generated
   streaming leaf; the client removes the hydrated durable leaf before replay,
   remaps the history append to the durable ID, and after `runEnd` remaps the
   generated local ID through thread `export`/`import`. Waiting for `runEnd`
   preserves assistant-ui's final error/incomplete state before identity
   reconciliation. This keeps Mastra's durable content identity and
   assistant-ui's parent graph aligned without a package patch. Missing leaves
   and leaves with descendants fail visibly.
   While this graph is loading, `ChatThreadUI` disables every composer send
   path using assistant-ui's `state.thread.isLoading`. The installed runtime
   captures a new message's parent from the current in-memory tail before its
   async append waits for history initialization; allowing a send against the
   initial empty snapshot would therefore persist an explicit `null` edge and
   replay a normal continuation as a root carousel revision. Draft text remains
   intact and sending re-enables when hydration settles. The real-runtime
   regression pin is `history-hydration-composer.behavior.test.tsx`; existing
   repository integration cases continue to pin genuine prompt edits and
   regenerated responses as siblings.
   Hydration must also not YANK the viewport: `ThreadPrimitive.Viewport` keeps
   `scrollToBottomOnInitialize={false}` and `scrollToBottomOnRunStart={false}`,
   so reopening a thread restores where the reader was instead of jumping to
   the newest message. Live auto-follow, the jump-to-latest affordance, and the
   pinned-only `overflow-anchor` opt-out are the viewport store's business —
   see assistant-runtime.md § THREAD SCROLLING. Above the virtualization
   threshold those two props no longer describe the opening position on their
   own: the virtualized tier has no library initialize step and anchors to the
   newest message itself, without animation, and only when the reader was not
   already scrolled up — same section. The stance is pinned by the BST-896 and
   BST-897 cases in `packages/assistant-ui/src/__tests__/assistant-ui-panel-architecture.test.ts`.

Approval/suspend ACTION messages are deliberately NEVER a Mastra row: the
"Approved <tool>." / "Approved the plan." user message the notices append is
UI/transport bookkeeping (its `runConfig` drives the resume; its metadata
marker drives the notice outcome locking + chip rendering). Neither resume
path passes messages to Mastra, and the shared transport
(`packages/assistant-ui/src/data-stream-runtime.ts` +
`approval-action-message.ts`) excludes action-marked messages from every
outbound payload and ships `messages: []` on the action legs. Consequences:
the echo is absent after reload (restart-safe rediscovery owns the
post-restart approval UI — see assistant-runtime.md PERMISSION ENGINE), and a
regenerate-after-approval resends the previous REAL user prompt, never the
echo. Live pin (real Agent + real PGlite): the "never persists an approval
action echo" case in
packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts —
if a Mastra writer ever starts persisting the echo, extend the exclusion at
that writer and update this section.

Image attachments (composer → model → persistence → reload):
- The composer's attachment adapter (packages/assistant-ui/src/
  attachment-adapter.ts) accepts IMAGES ONLY and enforces the shared caps in
  `@brainstrike/assistant-contract` assistant-attachments (allowlisted media
  types; 5MB/image; 4/message; 10MB combined) — the SAME module the server
  validates with, so client and server can never drift. Validation failures
  THROW (surfaced via the `composer.attachmentAddError` alert), never a
  silent drop/resize. The 16MB default request body limit is sized against
  the combined cap (base64 ≈ 13.4MB + prompt headroom).
- assistant-stream merges attachment content into the outgoing user message
  as `{type:'file', data:<base64 data URL>, mediaType}` parts; the agent's
  `convertAssistantUiMessages` intercepts file parts BEFORE the text walk
  (the base64 body must never flatten into prompt text), validates them, and
  `convertMessagesToMastra` emits an AI-SDK content ARRAY with a canonical
  user-message ImagePart (text-only messages keep the legacy string join).
- Mastra persists the user row with the v2 FILE dialect
  `{type:'file', data, mimeType}` (NOTE: `mimeType`, not `mediaType`) plus a
  flattened `content` text string and an `experimental_attachments` mirror —
  pinned from a REAL captured row in
  packages/agent mastra-memory-persistence.integration.spec.ts.
- Hydration (assistant-memory-repository `toUserHistoryAttachments`) rebuilds
  `message.attachments` from the persisted file dialect (image/* only);
  image-only user messages survive reload. Hydrated attachments render
  through the same user-bubble strip as live sends, and their content
  re-merges into later outbound turns so the model keeps seeing the image.
- Resent image history is BOUNDED on the wire: non-memory-backed transports
  resend full history, so `boundResentImageHistory` (packages/ui
  data-stream-runtime) caps one request's total inline images at the SAME
  combined cap — the current turn always ships, history image bodies spend
  the remainder newest-first, and once one image no longer fits, it and every
  older one is replaced by a visible text note (recency-monotonic; the model
  never sees an older image while missing a newer one). Elision is wire-only
  and loud (`data.transportImageElision` metadata + client warn log); the
  strict Web boundary accepts only its bounded shared-contract shape and
  discards it before model runtime construction. The thread state and persisted
  rows keep the image bytes, so reload hydration is untouched. Memory-backed
  requests are already compacted to the current turn and no-op through this
  bound. Measurement is strict for the CURRENT turn (a non-data-URL part throws
  — the composer just made it, that is a bug) but degrades for HISTORY parts: an
  unmeasurable old attachment is always elided with its own note
  (`unmeasurableImageCount` in the metadata) instead of aborting the send, so one
  malformed old row cannot block every later turn in the thread.
- Availability gating lives in the app-shell wrapper
  (`resolveComposerAttachmentsAvailability`), layered: (1) provider gate —
  every HOSTED provider is eligible (desktop assistant server AND the web
  /api/assistant route share the same image-aware conversion; the local
  transport must not gate hosted providers), only the text-only built-in
  local provider is excluded; failing it HIDES the affordance entirely;
  (2) per-model vision gate — the SELECTED MODEL's `vision` capability
  (`ModelVisionSupport = 'supported' | 'unsupported' | 'unknown'`, declared on
  every static registry LLM entry, mirrored into the DB catalog's
  capabilities jsonb by migration 061, and carried through
  `LocalRuntimeNormalizedModel.capabilities.vision` for Ollama /api/show +
  LM Studio vlm/llm discovery). 'unsupported' renders a visibly DISABLED
  attach button whose title names the model and the reason (never a silent
  hide); NEW adds are blocked by the disabled button and the absent paste
  frame, but the attachment ADAPTER stays registered and the preview strip
  stays mounted — an attachment staged under a vision model must remain
  visible/removable after a switch to a text-only model (assistant-ui's
  composer wipes text + staged attachments and throws an unhandled
  "Attachments are not supported" rejection if Send runs with no adapter;
  a sent-anyway staged image surfaces the visible provider error instead).
  Only ABSENT availability (provider gate) registers no adapter.
  'unknown' (runtime-discovered model without a capability signal) and an
  unresolved definition stay optimistic — a wrong guess surfaces as a visible
  provider error, never a silently blocked composer.
Paired tests: assistant-attachments.test.ts (contract),
provider-registry-vision.test.ts (static vision declarations),
packages/local-runtime/src/__tests__/local-runtime-model-catalog.test.ts (BST-977 extraction)
(runtime vision discovery),
frontier-models-migration.test.ts (DB catalog vision backfill),
assistant-messages.spec.ts + mastra-image-input.spec.ts (agent, incl. the
live-loop prompt proof), mastra-memory-persistence.integration.spec.ts
(persisted dialect pin), assistant-memory-repository.integration.test.ts
(hydration), attachment-adapter.test.ts (composer adapter),
assistant-ui-panel-wrapper-runtime.test.ts + assistant-ui-panel-wrapper.test.tsx
(availability gate), assistant-ui-panel.test.tsx (composer render states),
data-stream-runtime.test.ts `boundResentImageHistory` (wire history bound).

Built-in LOCAL provider turns persist on DESKTOP: local chat routes through
the assistant server's Mastra loop (see LOCAL LLM ARCHITECTURE), so memory,
run events, and reload hydration behave exactly like hosted providers.
Observational memory is ON by default (BST-940) at Mastra's documented
thresholds (observation.messageTokens 30K / reflection.observationTokens 40K)
with the `'auto'` observer target (`OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET`).
`resolveEffectiveObservationalMemorySettings` (app-shell wrapper-runtime, memo'd
once in the wrapper) resolves `'auto'` into CONCRETE settings consumed by
request data, memory validation, and the OM meter alike, under the PRIVACY
RULING (PR #2039 review — do not relitigate): the auto observer is only ever a
Mastra-tested fast model FROM THE SELECTED CHAT PROVIDER — the party already
receiving the conversation — never a different keyed provider (anthropic →
claude-haiku-4-5, google → gemini-2.5-flash, openai → gpt-5.4-mini; openrouter
carries ORDERED fallbacks — gemini-2.5-flash → gemini-3.5-flash-lite →
deepseek-v4-flash — because its catalog seeds the preferred Gemini targets
disabled; via the contract's pure `listAutoObservationalMemoryCandidates`,
first catalog-eligible candidate wins). A local/keyless/web chat, or a
candidate set the user fully disabled in the model catalog (the wrapper passes
an `isTargetEligible` predicate over the loaded registry, same gate as the
settings dropdown), flips `enabled → false` with an explicit unresolved reason
surfaced as the popover's 'awaiting-observer' OM state and the Settings auto
note. An unresolved auto must NEVER disable thread memory, and `'auto'` must
never reach the provider/model validator (the validator also resolves
defensively, and the desktop server resolves the sentinel again at request
intake — `resolveServerAutoObservationalMemory` — so a raw client shipping
'auto' can neither 502 a local stream nor conjure a cross-provider observer).
The built-in local Gemma is deliberately NOT an auto candidate — its 8K
runtime budget cannot observe the 30K message threshold. An EXPLICIT
(non-auto) target keeps the original loud validation: enabling a hosted target
without that provider's key fails visibly.
Construction seams that receive no settings (memory factory default arg,
desktop-server absent-field fallbacks) use
`CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS` (observation OFF) — an
absent settings object must never manufacture an enabled observer.
Hosted EMBEDDERS for Mastra memory (`createEmbeddingProvider`) are wrapped in
`asSpecV3EmbeddingModel`: current @ai-sdk embedding models declare
specification 'v4', and @mastra/memory's embed dispatch switches on that
literal ('v3'/'v2' → modern pipelines, anything else → a legacy v1-only
pipeline that throws "AI SDK 4 only supports … v1"). A raw 'v4' embedder
therefore failed EVERY observational-memory vector-retrieval cycle in the
field (BST-940 debug bundle 2026-07-27) — the facade is load-bearing, not a
type cast. OM cycle failures streamed as `data-om-*-failed` chunks surface as
durable `memory.observation.failed` run events (see assistant-runtime.md).
Pinned by the VECTOR-retrieval and observer wire cases in
`mastra-memory-persistence.integration.spec.ts`.
Known gap: WEB local turns still use the in-renderer LocalRuntimeChat (no
history adapter) and remain session-only.

When changing message persistence or hydration, update this section and the
paired tests in packages/agent and packages/app-shell.

MCP Task status is deliberately outside assistant message persistence. A task
handle is not a synchronous tool result, and the renderer must not serialize
its live status, input requests, result metadata, or control identity into a
message part to make restart recovery appear to work. Migration 115 and the
exact principal/server/resource/authority-epoch scope remain authoritative.
After a restart, an opt-in host adapter must rebuild the bounded presentation
from that durable row and mark it `restart_required`; `McpTaskStatusCard` owns only the
controlled display and action focus. This layer adds no renderer store and no
fallback to stale message history.

---

## ASSISTANT RUN NOTIFICATIONS

OS-level `Notification` API alerts for three run-lifecycle events plus two
forge observations — run finished, run failed (including watchdog stalls
surfacing as `run.failed`), tool approval required, pull request opened, and
pull request checks finished — fired only while the app is NOT the user's
active focus. One code path for Electron renderer AND web: the standard web
`Notification` constructor, no Electron `Notification` module, no new IPC.

Layers:
1. **Preferences** (`packages/app-state/src/stores/notification-preferences-store.ts`) —
   persisted master toggle (`masterEnabled`, default OFF) + per-event toggles
   (`events.{runFinished,runFailed,toolApprovalRequired,prOpened,prChecks}`,
   default ON).
   PERSISTED via the same `createBrowserJsonStorage` pattern as sibling
   stores. Registered in the factory-reset pipeline: like
   `permission-policy-store`, `resetNotificationPreferencesStoreToDefaults`
   is called directly from `factory-reset-helpers.ts`'s `clearBrowserStorage`
   (not `registerFactoryResetSessionStore` — that seam is for stores OUTSIDE
   the `preferences` package) so the live in-memory toggle never survives a
   reset that does not reload the page (web path).
2. **Decision + dispatch** (`packages/app-state/src/notifications/`) —
   `should-notify.ts` is a PURE gate (`shouldNotify`): master on, event on,
   `Notification.permission === 'granted'`, and the window is unfocused
   (`document.visibilityState === 'hidden' || !document.hasFocus()`,
   evaluated AT EVENT TIME). `notification-permission.ts` wraps
   `Notification.permission`/`requestPermission()` — permission is requested
   ONLY from the Settings toggle-on click (never on load), and the store
   never persists `masterEnabled: true` when the browser denies or has not
   granted permission. `run-notification-dispatcher.ts`
   (`createRunNotificationDispatcher`) evaluates the gate and constructs a
   `Notification` with privacy-safe copy. Coalescing key is `runId:kind` for
   run finished/failed and `runId:kind:toolCallId` for `toolApprovalRequired`,
   so a run that suspends for more than one distinct approval still alerts on
   each. The input is a discriminated union: run events carry only
   `runId`/`kind`/an optional `threadTitle` (plus a REQUIRED `toolCallId` on
   the approval variant), while forge observations carry only
   `observationKey`/`kind`/`prNumber`/an optional settled checks outcome and
   thread title. Neither variant carries message content or tool args, and the
   dispatcher wires `onclick` to `window.focus()`.
3. **Settings UI** (`packages/settings-ui/src/settings/system/notification-settings-section.tsx`,
   registered via `createNotificationSettingsCategory()` from its own
   `notification-settings-category.tsx` — a non-component module, kept out of
   `settings-page-content.tsx` so Fast Refresh preserves `SettingsPageContent`
   state; imported in both `apps/web/src/app/settings/page-content.tsx` and
   `apps/desktop/src/renderer/components/settings/page-content.tsx`) —
   master + per-event toggles, surfaces a "blocked by your browser/OS"
   message when permission is denied/unsupported.
4. **Trigger source** (`packages/assistant-ui/src/run-lifecycle-notifications.ts`) —
   pure selectors (`selectTerminalRunEvents`, `selectOpenToolApprovalRequests`)
   scan thread messages for `run.finished`/`run.failed`
   (`ASSISTANT_RUN_EVENT_DATA_NAME`) and tool-approval-required
   (`TOOL_APPROVAL_DATA_NAME`) data parts. `useRunLifecycleNotifications`
   reports each NEW one exactly once (deduped via refs) through THREE new
   optional `AssistantUiPanelProps` callbacks — and DEFERS seeding its "seen"
   baseline until `state.thread.isLoading` is false, so async history
   hydration (opening/reloading an existing thread first renders an empty
   snapshot) seeds the replayed history without firing stale notifications
   (`onRunFinished`/`onRunFailed`/`onToolApprovalRequired`) that thread the
   SAME 5 layers as `onUsage` (`AssistantUiPanel` → `LocalRuntimeChat`/
   `DataStreamRuntimeChat` → `ChatThreadUI`, which mounts
   `RunLifecycleNotificationBridge`). This package NEVER touches
   `window.Notification` or the preferences store — it only reports raw
   events, mirroring the `onUsage` seam.
5. **Composition** (`packages/app-shell/src/use-assistant-run-notifications.ts`,
   wired into `assistant-ui-panel-wrapper.tsx`) — the ONLY layer that reads
   live `document.hasFocus()`/`visibilityState` and owns a
   `createRunNotificationDispatcher` instance (stable for the panel's
   lifetime, so per-run coalescing is meaningful). Hosted turns coalesce on
   the wire `runId`; web local-runtime events carry no `runId`
   (`createLocalRunEvent` assigns only a per-event `id`), so the hook falls
   back to `event.id` — a stable, unique key, never a fabricated runId that
   could collide across runs. Desktop's hidden
   embedding/llm hosts (`embedding-host-app.tsx`, `llm-host-app.tsx`) never
   import `AssistantUiPanel` at all, so they structurally can never notify —
   this hook only ever runs inside the visible assistant surface.
6. **Forge trigger source** (`packages/app-shell/src/hooks/use-forge-run-events.ts`) —
   `forge:prUpdated` pushes from the main-process ForgeService. Not a stream
   scan: a forge observation never appears in the message stream. Coalesced on
   `<repoCommonDir>\0<branch>\0<headSha>:<kind>` (the `\0` separator matches
   `forge-service.ts`'s own `cacheKey` convention), gated per thread by
   `metadata.forgePrWatch !== false`.
   The branch lookup this trigger source matches pushes against
   (`useThreadBranchByRootPath`, activated on demand — see that hook's doc)
   starts EMPTY and only resolves asynchronously; a push that arrives before
   the first resolution is BUFFERED (a ref queue, deduped by
   `<observationKey>\0<transition>`) rather than treated as a non-match, and
   drained once the lookup reports `loaded` — see `ForgeBranchLookup` and
   `isLookupReady` in `use-forge-run-events.ts` (BST-1391 M2). This closes the
   "the very first push is lost" gap; it does not add a live-refresh path for
   an ALREADY-OPEN thread — see the reload-visibility note below.
   RELOAD-VISIBILITY LIMITATION (BST-1391 M4): the appended `pr.*` row is
   durable in `brainstrike_assistant_run_events` the moment
   `appendThreadRunEvent` resolves, but the assistant-run-timeline UI renders
   from assistant-ui DATA PARTS on the message stream, not from a live query
   against that table — `listThreadRunEvents` is read ONLY at thread-history
   HYDRATION time (`createAssistantThreadHistoryAdapter`, on thread
   open/reload), which is what turns persisted run events into synthetic data
   parts. No existing seam re-hydrates an already-open thread's timeline
   mid-session. This is NOT the timeline lagging behind a live
   `thread.metadata.forgePrUrl` — `useAssistantThreadStore` is
   REFRESH-DRIVEN (`refreshResourceThreads`), not a live query, so
   `forgePrUrl` does not update live either. The PR chip and thread-row pill
   stay fresh through their OWN independent live sources instead:
   `use-thread-forge-pr.ts` reads `window.forge` directly (the chip), and
   `use-forge-pr-cache.ts` reads a PGlite live query over
   `brainstrike_forge_prs` (the pill, Task 5) — neither reads
   `thread.metadata` or `listThreadRunEvents`.
   `pr.*` row therefore does not appear in an OPEN thread's timeline until
   that thread is reopened or the app reloads. Inventing a live-refresh path
   for this is future work, not this task's — see Task 7's CDT checklist for
   how this is verified rather than assumed.

When changing this flow, update this section and the paired tests
(`packages/app-state/src/__tests__/notification-*.test.ts(x)`,
`packages/assistant-ui/src/__tests__/run-lifecycle-notifications.test.ts`,
`packages/assistant-ui/src/__tests__/run-lifecycle-notifications-hydration.test.tsx`,
`packages/app-shell/src/__tests__/use-assistant-run-notifications.test.ts`,
`packages/app-shell/src/__tests__/use-forge-run-events.test.ts`).

---

## FOLLOW-UP MESSAGE QUEUE (COMPOSE DURING A RUN)

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

---


## CONTEXT USAGE METER (TOKEN AWARENESS)

One derivation feeds three consumers per request — keep them consistent:
`buildAgentLoopSettings(prefs, selectedModelBudgetDef)` in packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts
produces `agentLoopSettings.inputTokenLimit` (explicit user pref wins, else
`deriveEffectiveInputBudget(contextWindow, maxOutputTokens)` from
packages/assistant-contract/src/context-budget.ts — throws, never clamps). That ONE number is:
1. the Mastra `TokenLimiter` budget (`runtimeData.agentLoop.inputTokenLimit` → `buildToolLoopOptions`),
2. the meter denominator (`effectiveInputBudget` prop on `AssistantUiPanel`),
3. the instruction budget note (`buildContextBudgetNote`, appended per-request at Agent construction).

Runtime invariants:
- Usage store (packages/assistant-ui/src/context-usage-store.ts) is session-lived, NOT
  persisted; key = `selectedMemoryThreadId ?? 'active'` — the writer (`handleUsage` in the app-shell
  wrapper) and the reader (`ContextUsageMeter`, via the panel's `threadKey` prop) MUST use the same key.
- Both turn paths report usage: hosted via the data-stream `message-finish` tap
  (`onUsage` in data-stream-runtime.ts), local via the llm-host result (`onUsage` in
  local-runtime-adapter.ts; `LocalLlmGenerationResult.usage` is optional at the IPC boundary — guard it).
- Hosted multi-step finishes carry two distinct token views. Aggregate
  `inputTokens`/`outputTokens` remain the durable billing and cost totals across
  every provider step. `contextInputTokens`/`contextOutputTokens` carry only the
  latest provider step and feed the transient context meter. A transport that
  structurally has no per-step fields uses its aggregate single-step values.
  Never display a billed cross-step sum as context occupancy.
- The meter shows estimated (the FULL-PART conversation walk, see below) until exact usage lands;
  provenance must never lie — wire-format usage is
  `{inputTokens, outputTokens, contextInputTokens?, contextOutputTokens?, billedCostUsd?}`
  (e2e mocks must use the token field names).
- Estimator v2 (BST-940, `packages/assistant-ui/src/context-estimate.ts`):
  `estimateConversationTokens` walks EVERY message part — text, reasoning, tool args + results
  (per-tool attribution), attachment counts — with the shared chars/4 heuristic, memoized per
  settled message object in a WeakMap. The v1 text-only walk read coding threads absurdly low
  (tool output is ~90% of context) — never regress to a text-only walk. Heuristic accuracy is
  pinned against the REAL o200k tokenizer in
  `packages/tokenization/src/__tests__/token-counting-heuristic-accuracy.test.ts` (code ≈ +4%,
  tool JSON ≈ −22%, repetitive prose ≤ +45%).
- Display selection is `resolveDisplayedContextUsage` (same module): idle+exact → exact; while a
  run streams → LIVE estimate (server breakdown baseline: system + task list + tool definitions,
  plus the conversation walk), floored at the last exact figure (context never shrinks mid-run) and
  flagged `est.`; before any exact usage → the estimate alone. `ThreadContextMeter` re-walks on
  every message snapshot so the gauge moves during streaming.
- UI shape: a compact ring row (`context-ring.tsx` donut + used/budget fraction) that triggers the
  "Context Usage" popover (`context-usage-popover.tsx` — Cursor-style anatomy: "% full" header, a
  segmented capacity bar over the effective input budget whose segments derive from the SAME
  figures as the color-keyed legend rows [System instructions / Tool definitions / Task list /
  Conversation / Attachments / Unattributed], per-tool top-5 sub-rows with an aggregated
  remainder, a conversation split [You / Assistant / Reasoning / Tool activity + per-tool], OM
  stats, and cumulative+cost).
  The critical (≥90%) trimming-risk notice renders INLINE next to the ring, never inside the hover
  popover — a warning must not hide behind hover or claim that compaction already happened. The
  ONE-DERIVATION invariant above is unchanged:
  `agentLoopSettings.inputTokenLimit` remains the TokenLimiter budget, the meter/ring denominator,
  and the instruction budget note; the popover introduces no second derivation.
- Prompt breakdown channel: the agent computes category counts at prompt
  assembly (`packages/agent/src/mastra/prompt-breakdown.ts` — instruction-side at Agent
  construction, message-side at stream start; tool-definition totals + per-tool figures come from
  the run's `RunTokenDiagnostics.toolDefinitionContextBreakdown()`, tokenizer-measured when the
  o200k counter loads, chars/4 backstop otherwise — breakdown `provenance` is
  `'measured' | 'heuristic'` accordingly, and every displayed figure keeps its "~") and emits
  them once per initial turn as the
  TRANSIENT `brainstrike.context-breakdown` aui-data part
  (`@brainstrike/assistant-contract/context-breakdown`), honoring the same text-part deferral
  contract as run events / shell output. NOT a run-event ON PURPOSE (shell-output precedent): the
  desktop run-event persistence tap passes non-run-event chunks through, so the breakdown is never
  persisted — after reload the popover honestly has none until the next run. Non-measurable
  categories are ABSENT fields, never zero-faked (memory-backed runs omit `historyMessagesTokens`
  because the wire carries only the current turn; the popover falls back to the client heuristic
  walk). The renderer tap (`onContextBreakdown` in the ui data-stream runtime → app-shell
  `handleContextBreakdown`) parses via the contract guard — malformed wire payload →
  `{ invalid: true }`, stored and SURFACED in the popover, never coerced — and records into
  `breakdownByThread` on the same session-only usage store under the same thread-key contract as
  `recordUsage`. The "Unattributed" row is display math only (exact `inputTokens` − displayed
  categories, clamped ≥ 0 with a debug log) and appears only once exact usage lands. The
  in-renderer local runtime path has no breakdown channel (capability-absent — web
  `LocalRuntimeChat` unaffected). The data part is registered with a null renderer in
  `AssistantDataRendererRegistration` (assistant-ui-panel.tsx, mirroring `SHELL_OUTPUT_DATA_NAME`)
  so the transient part never surfaces as a stray element in the message flow — it is consumed only
  by the `onContextBreakdown` tap, never rendered inline. Because a capability-absent local turn
  can never refresh the breakdown, `handleUsage` clears the thread's stale breakdown
  (`useContextUsageStore.getState().clearBreakdown`) whenever `hasContextBreakdownChannel`
  (assistant-ui-panel-wrapper-runtime.ts) is false for the active provider/transport pair —
  otherwise a later local turn on a thread that previously had a hosted turn would update exact
  usage while the popover kept showing the earlier hosted turn's stale category rows.
- OpenRouter finish messages must additionally carry `billedCostUsd`, sourced
  from Mastra's official OpenRouter provider metadata. Persist it in
  `brainstrike_assistant_run_usage.billed_cost_usd`; cumulative and cross-root
  views use the provider amount for reported rows and registry pricing only for
  legacy/unreported rows. Mixed groups add both portions and retain estimated
  provenance; entirely provider-reported groups use `provider-reported`.
  Approval/suspension pauses emit a zero-token finish without cost because
  Mastra emits the pause before exposing that model step's `step-finish`. On
  resume, Mastra emits the deferred pre-pause step finish and all subsequent
  steps; the normal terminal usage tap persists their exact aggregate once.
  MISSING cost metadata on a new OpenRouter completion records the cost as
  UNKNOWN — the field is omitted, `billed_cost_usd` stores null, and the row
  falls through to registry-priced/estimated provenance — with a visible
  `provider_billed_cost_unreported` warning. It is never mislabeled as an exact
  or zero-cost run, which is what the previous fail-visibly rule protected, and
  it no longer destroys the completed turn: OpenRouter reports no cost at all
  for anonymous/stealth routes (`stealth/ox-alpha`, migration 107), so the old
  rule failed every one of those turns at the finish. MALFORMED metadata is
  loud but equally non-fatal: it records unknown too, with
  `provider_billed_cost_malformed` logged at ERROR rather than a throw, because
  binning a finished answer over a telemetry field is the same bad trade
  whatever the shape of the bad value. Absent is a fact about the route;
  malformed is a broken contract someone should fix. Neither is ever recorded
  as zero.
- Thread-total headline + run-kind attribution (BST-953): every
  `brainstrike_assistant_run_usage` row carries `run_kind`
  (`'chat' | 'subagent' | 'compaction-summary' | 'om-observation' |
  'om-reflection'`, migrations 077/090, sole author since BST-1651 retired the
  repository bootstrap mirror; CHECK-constrained, default `'chat'`). TWO
  writers, never overlapping: the renderer writes ONLY parent `'chat'` rows
  (the `handleUsage` message-finish tap); the desktop server writes ONLY child
  rows, from the `child-run-usage` StreamChunk
  (`persistDesktopChildRunUsage` in apps/desktop/src/assistant-server/run-persistence.ts, a
  DUPLICATION-NOTE mirror of `recordRunUsage`). Child sources:
  - subagent: `onDelegationComplete`'s aggregate usage
    (`createDelegationConfig.onChildUsage` → per-leg `DelegationUsageCapture`
    queue drained by the stream generator). Provider-exact; model/provider =
    persona pin ?? parent run. Bound desktop runs include native parent-run,
    tool-call and child-thread/resource identity. The existing writer reconciles
    one row per invocation against the original host leg (migration 128), so
    duplicate delivery and cumulative snapshot resume do not double-count.
    Bound authorization or write failures propagate before the UI refresh;
    they never fall through to the legacy unattributed insert. Historical rows
    retain NULL invocation keys. Deleting a child also NULLs only those keys,
    preserving already-spent root totals. Numeric usage is retained on root
    deletion as before; it is excluded from the existing transcript sidecar
    deletion list and cleared by factory reset. See assistant-subagents.md for stream ordering
    and the exact limits of the cumulative-usage proof.
  - OM cycles: `data-om-observation-end` / `data-om-buffering-end` chunks
    (`tokensObserved`/`observationTokens` and `tokensBuffered`/`bufferedTokens`)
    mapped in `mapObservationalMemoryCycleEnd`. These are Mastra's LOCAL tokenx
    estimates (`estimated: true`) — the UI must label OM figures "est.", and
    attribution is ONLY the run's resolved observer target
    (`resolveDesktopObserverUsageTarget`): never the chat model, unattributable
    rows are dropped with a warn, and `provider === 'local'` rows are skipped
    (unbilled — an unpriceable row would blank the whole thread cost).
  Child rows reuse the PARENT `runId`, so the Task Ledger's per-run totals
  include them automatically. `getThreadCumulativeUsage` groups by
  (provider, model, run_kind) and sums cache classes UNCONDITIONALLY (the
  savings line needs them for billed rows too); `resolveCumulativeUsageDisplay`
  (assistant-cumulative-usage.ts) derives in/out totals, by-source subtotals,
  and net cache savings (read discount − write premium, per-model registry
  rates; ABSENT when any cache-bearing model lacks rates). The meter chip leads
  with the THREAD TOTAL (+cost when priceable); the context fraction moves to
  the ring/title/popover ("Context N% full" section). Live tick: the renderer
  taps `run.step.finished` run events' `promptTokens`/`completionTokens`
  (`onStepUsage` → `recordLiveStepUsage`, summed per in-flight run) and the
  forwarded `brainstrike.child-run-usage` aui-data part (`onChildRunUsage` →
  cumulative re-read; the server AWAITS the row before forwarding, so the
  refresh never reads pre-write state); the live sum is CLEARED on three paths.
  Two are settle-side — `handleUsage` (only AFTER the post-write refresh, so the
  total never dips and jumps) and the wrapped `completePreparedRequest` on a
  cancelled/failed terminal status (the abort-gated tap never delivers those
  runs' finish). The third is RUN START: the wrapped `prepareRequestData`
  resets the thread's sum synchronously before composition awaits, because
  every clear keys off the CURRENT selection, so switching away mid-stream
  strands the old thread's partial sum permanently — its later steps and its
  settle-clear both land on the newly selected thread.
  A fourth path used to sweep on thread selection; BST-1652 replaced it with a
  READER-side gate, because a sweep is an effect and an effect fires after
  paint. `ContextUsageMeter` gates the recorded sum on `isRunning === true ||
  settlingRunUsageByThread[key]` and passes the gated value to the popover.
  **The gate and the run-start reset are a required pair and neither covers the
  other's case**: the gate hides a stranded sum while the thread is idle, and
  the reset removes it before the next run on that thread can expose and
  accumulate onto it. Without the reset, a new run re-opens the gate on the
  retained tokens and the headline stays inflated with its cost suppressed for
  the whole run.
  The settle marker is the gate's other half, and it is not optional:
  `isRunning` goes false at STREAM FINISH, while `handleUsage` deliberately
  holds the live sum until the post-write refresh absorbs the row. Gating on
  `isRunning` alone drops the whole run from the headline for that window and
  jumps it back when the refresh lands — the same dip the write ordering exists
  to prevent, on EVERY run rather than in an edge case. `handleUsage` claims
  the window with `beginLiveRunUsageSettle` once past the no-sink guard —
  without a durable write there is nothing to protect — and the release is
  STRUCTURAL: the chain's `finally` plus a `catch` for a synchronous throw that
  never reaches it. That is not belt-and-braces. A claim that outlives its sum
  is strictly worse than no claim, because it holds the gate open on an idle
  thread and the headline stays inflated until some later run on that thread
  settles; the run-start reset is the second self-heal, since
  `clearLiveRunUsage` drops the marker together with the sum.
  The claim is keyed to the SELECTED thread, like every other write here
  (`selectedMemoryThreadId ?? 'active'`), so the thread a user walked away from
  mid-stream never enters the window — but the claim for the finishing run
  lands on whatever thread is selected when it settles. A stranded sum on THAT
  thread is briefly visible for the duration of the durable write, then wiped
  by the same `clearLiveRunUsage`. A repo-backed
  thread with no rows yet hydrates the honest ZERO baseline
  (`EMPTY_THREAD_CUMULATIVE_USAGE_DISPLAY`) so the FIRST run's live steps
  render as the thread total; a failed load stays null (never $0). While live
  tokens are included, the chip suppresses the durable cost and the popover
  qualifies it "(excl. live)" — a current total must not sit beside a lagging
  price.
- OM rows in the WIDER cost surfaces (settled ruling, BST-953 review): the
  daily-spend guardrail, cross-root usage, and run-ledger analytics aggregate
  `run_usage` without a `run_kind` predicate, so `'om-observation'`/
  `'om-reflection'` rows flow into them priced at the observer model's
  registry rate like any unbilled row. This is DELIBERATE: the tokens are
  genuinely billed by the provider; Mastra's tokenx content-size figure is a
  weaker (under-)estimate of their count, and EXCLUDING them would silently
  under-count real spend — the worse failure for a budget guardrail. Those
  surfaces already qualify their totals as captured-usage estimates;
  per-source itemization outside the context meter is future work, not a
  correctness gap. Subagent rows are provider-exact and belong in all of them.

---

## RUN-EVENT / THREAD-RUN SCHEMA OWNERSHIP (revised 2026-09-05, BST-1651)

`brainstrike_assistant_thread_runs` and `brainstrike_assistant_run_events` are
created by **migration 118**, and NOTHING creates them at runtime.

**This supersedes the 2026-07-24 ruling** that they must never get a numbered
migration. That ruling was correct for its premise and the premise is gone: both
tables carry `ON DELETE CASCADE` FKs to parents no migration created (the Mastra
threads table, and the runs row itself), so the only options then were an FK-less
migration or a runtime bootstrap. **Migration 117 now creates Mastra's memory
schema**, so 118 declares both FKs exactly as the bootstrap did. Do not restore
the bootstrap.

### The repository PROBES; it never creates (do not relitigate)

`createPgliteAssistantThreadRepository` used to `exec` a ~590-line
`CREATE TABLE IF NOT EXISTS` mirror of migrations 046-095 on first use per
handle. The mirror was required to stay byte-identical to those migrations by
hand, and **nothing could observe a violation**: on a migrated database the
`IF NOT EXISTS` never fires, so a divergence stayed invisible until a user hit a
column the two had shaped differently. Retiring it found one that had already
shipped — `brainstrike_assistant_tool_projection_rewrites` had `kind` at ordinal
5 on a bootstrapped database and ordinal 8 on a migrated one, because migration
084 creates the table and 087 ADDs the column.

The replacement is a `to_regclass` probe over every relation the repository
reads or writes (the explicit run tables plus every entry of
`THREAD_DELETE_SIDECAR_TABLES`, which the thread-delete cascade references
unconditionally), memoized per handle in the
`assistantThreadSchemaProbePromises` WeakMap and awaited by every repository
method. A missing relation throws `AssistantMemorySchemaMissingError` naming it.

- `to_regclass` ONLY — it returns NULL for an absent relation instead of raising,
  so one statement answers for the whole set.
- **No `IF NOT EXISTS`, no catch-and-create, no create-if-missing fallback.** A
  missing relation means migrations did not run. Creating it quietly is exactly
  how the divergence above was manufactured.
- A FAILED probe drops its memo so the handle re-probes; only success is cached.
- Additive statements that used to reach old installs through the bootstrap's
  per-init re-run now live in migration 118: `thread_runs.turn_message_id`
  (`ADD COLUMN IF NOT EXISTS`, BST-1163), the two partial approval indexes, and
  the `DROP INDEX IF EXISTS` of the pre-BST-1440 `…_approval_answer_idx`.

### 118 must CONVERGE, because every existing install already has these tables

The fresh database is the easy case. The one that decides this migration is the
install that has been running the assistant for months: the retired bootstrap
already created both relations there, and 118 is about to run over them.

- A bare `CREATE TABLE` **errors on upgrade for every existing user**. It is not
  an option and never was.
- A conditional `CREATE TABLE` **skips**, and by itself that is exactly the
  silent drift this ticket deletes — preserved on precisely the installs that
  matter. So the conditional create is only half the migration. The other half
  is the additive statements above, which must cover every difference between
  what a shipped bootstrap era left and what the create declares.

That obligation is what makes the additive statements load-bearing rather than
defensive noise, and it is CHECKED, not asserted:
`assistant-run-schema-upgrade-path.test.ts` (db) seeds a database the way each
shipped bootstrap era actually left it — pre-BST-1163 (no `turn_message_id`),
BST-1404 (the `run_id`-shaped answer index), and the final BST-1440 shape — runs
the chain over it, and asserts the resulting catalog is IDENTICAL to a
freshly-migrated one: columns WITH THEIR ORDINALS, indexes, and constraints
including the `thread_id` foreign key. Column ordinal is in the comparison
deliberately; it is the projection the `tool_projection_rewrites` divergence
above hid in.

Its seeds are frozen history, identified by the commit that shipped them. If a
future change to 118 makes that test fail, the bug is the missing forward
statement — **never** the seed.

Paired coverage: `assistant-memory-schema-probe.integration.test.ts`
(assistant-data), `mastra-schema-migration-parity.test.ts` and
`assistant-run-schema-upgrade-path.test.ts` (db).

### Test fixtures are not a licence to reshape these tables

Three suites used to stand up their own copy of the run header because the
chain did not create it, and all three dropped the `thread_id` foreign key or
most of the column set to keep the fixture small — a fourth schema authority,
below the mirror the ticket set out to remove, and the reason the FK looked
"new" when 118 landed. It is not new: the run header has carried
`brainstrike_assistant_thread_runs_thread_id_fkey` since it first shipped
(2026-06-20). Seed a `mastra_threads` parent row; never re-declare the table.

Do NOT confuse these with `brainstrike_assistant_run_outcomes`, which has been
migration-backed since 062.

`pr.opened` / `pr.checks` / `pr.merged` (BST-1391) are the only run-event
kinds not produced by the agent stream. They are appended to the thread's MOST
RECENT run because `run_id` is `NOT NULL`; a thread with no runs gets no
timeline row, logged at `info`. This adds no writer and no schema change.

The desktop MAIN process has FOUR writers against these relations, none of
which creates them (all in `apps/desktop/src/assistant-server/run-persistence.ts`, all reached
through injected handles rather than a module-level import —
`recordDesktopAssistantRunEvent` and `completeDesktopAssistantThreadRun` take a
database PROVIDER, `recordDesktopAssistantHookRunOutcome` takes an
already-resolved handle; the sole composition site is the `assistant-server.ts`
root, which supplies `db-main`'s `getDatabase` — the service's `stream-init.ts` takes
that provider on `InitializeAgentStreamParams` and forwards it (or its awaited
result) to the writers — so every write still resolves the same main-process
handle (BST-972 A1/A2) — and all gated on `if (runId)`):

| Writer | Shape | On a missing parent row |
| --- | --- | --- |
| `recordDesktopAssistantRunEvent` | `INSERT … SELECT FROM brainstrike_assistant_thread_runs` | 0 rows, silent no-op |
| `recordDesktopAssistantHookRunOutcome` | `INSERT … SELECT FROM brainstrike_assistant_thread_runs` | THROWS (deliberate) |
| `completeDesktopAssistantThreadRun` | `UPDATE brainstrike_assistant_thread_runs` | 0 rows, silent no-op |
| `reapOrphanedThreadRuns` (BST-1162, startup only) | `UPDATE … WHERE status = 'running' AND started_at < bootedAt` | 0 rows, empty sweep. A MISSING RELATION is not a case: migration 118 owns the table and `getDatabase()` resolves only after `migrate()`, so an unmigrated database raises 42P01 into main's own `catch` (BST-1651 retired the `runsTableMissing` report, which had reduced that state to an `info` line) |

Run-critical desktop reads and event writes use the existing foreground `DatabaseWorkScheduler`
lane. A run-scoped `mastra_workflow_snapshot` SELECT and same-id event upsert may retry once for
typed, non-terminating host saturation. Snapshot retries emit `run.database.retried`; event retries
stamp sanitized `metadata.databaseRetry`. Serial host ordering plus same-id upsert prevents duplication
after late completion. Retries are logged; arbitrary, wedged, terminating, and exhausted failures remain typed.

**`duration_ms` is an INTEGER column, and durations are rounded at the
PRODUCER.** The guard wrapper measures tool execution with `performance.now()`,
whose deltas are fractional; forwarding the raw float made every stamped
terminal tool event fail to persist (field regression 2026-08-23, 22P02
"invalid input syntax for type integer") — holes in the exact timeline the
debug bundle reads. `withRunEventDuration`
(`packages/agent/src/mastra/tool-lifecycle-processors.ts`) is the single seam
where a duration enters a run event and rounds there (non-finite drops the
field). The column contract is pinned by the real-PGlite pair in
`run-event-schema-provenance.integration.test.ts` — integer persists,
fractional rejected — so the rounding is provably load-bearing.

That is safe, and the reason is **runId provenance — NOT startup ordering**:

- `memory.runId` has exactly ONE producer: `createAssistantThreadRunPromise`
  (`assistant-ui-panel-wrapper-runtime.ts`) → `repository.createThreadRun`,
  which awaits the schema bootstrap before it can return an id.
- Every main-process write is gated on `if (runId)`, and `buildAssistantRequestData`
  puts no `runId` on `data.memory`, so no stale or restored id can bypass the mint.
- Desktop has ONE physical database: the renderer's handle is
  `window.electronAPI.db`, whose `db:exec` resolves through the same `db-main`
  `getDatabase()` the assistant server's composition sites inject into the
  run-persistence writers.

Therefore do NOT add a defensive `CREATE TABLE IF NOT EXISTS` in main, and do
not add an ordering handshake: both would be machinery for an unreachable state,
and would mask a genuinely broken invariant if provenance ever changes.

**The regression that WOULD make this real** is a second runId producer — a
server-side background run, a cron/headless run, or subagent runs persisted
under their own ids. Any such producer must bootstrap the schema itself.

**Loudness is NOT uniform — do not read the above as a blanket guarantee.** An
un-bootstrapped write always raises PG `42P01` at the driver, but only one path
propagates it:

- `observeDesktopAssistantRunEvents` `logger.error`s every failed event and
  rethrows on flush — but the rethrow is CONDITIONAL (in
  `assistant-server/run-persistence.ts`): when the source stream ALSO threw, the persistence failure is
  downgraded to a `logger.error` and only the stream error propagates.
- `recordDesktopAssistantThreadRunStatus` (same module) wraps
  `completeDesktopAssistantThreadRun` in a `try/catch` that only logs. A
  `42P01` on the run-status `UPDATE` is SWALLOWED; the run row simply never
  reaches a terminal status. Rows stranded in `'running'` this way (or by a
  crash/quit killing both status writers) are recovered at the NEXT app
  start by `reapOrphanedThreadRuns`
  (`apps/desktop/src/assistant-server/thread-run-startup-reaper.ts`, wired
  into main.ts's startup fire-and-forget sweep, BST-1162): boot-time
  evidence (`started_at < mainProcessStartedAt` — no renderer exists before
  whenReady, so a row this boot minted can never match) marks them `failed`
  with a visible error, un-sticking `hasInFlightThreadRun`'s rewind gate
  without weakening it — live runs and unknown statuses still refuse.
  Paired test: `thread-run-startup-reaper.integration.test.ts`.

Neither carve-out is a regression introduced alongside this ruling, and neither
is currently worth runtime machinery — but they are why the provenance invariant
carries the weight here rather than error surfacing. If provenance is ever
broken, expect partial silence, not a clean failure. Paired test (clean-stream
path only): `apps/desktop/src/__tests__/assistant-server/run-event-schema-provenance.integration.test.ts`.

### WORKTREE LIFECYCLE KINDS (BST-1390)

`worktree.created`, `worktree.archived` and `worktree.setup` are additive
`ASSISTANT_RUN_EVENT_KINDS` members, emitted by `worktree-run-events.ts` through
the SAME `recordDesktopAssistantRunEvent` writer (exported for this purpose —
do not add a second INSERT) and therefore under the same documented `if (runId)`
gate as every other main-process writer.

They are emitted ONLY for an operation that happens inside a run. A worktree
created from the Mode chip before the thread's first request has no
`brainstrike_assistant_thread_runs` row to reference (`run_id` is `NOT NULL`
with an FK), and NO orphan row is invented for it: the create sheet reports the
outcome inline, a toast confirms it, and `brainstrike_worktrees` is the durable
record. Writing the same fact into both tables would be a second source of
truth — the argument that kept `tool.approval.resolved` out of the contract.

All three are `NEVER_RUNNING` (status `info`, or `failed` for a failed setup),
so none declares a terminal. `AssistantRunTimeline` needs no change: it renders
`label`/`detail`/`status` and derives only a `lifecycle` colour from the kind
prefix (via `classifyRunEvent` in `tool-visual-classification.ts`, which falls
through to `'lifecycle'` for any kind that isn't `memory.*`/`tool.*`). A kind
missing from `ASSISTANT_RUN_EVENT_KINDS` is REJECTED by `readAssistantRunEvent`
and the row disappears — which is why the contract entry is the first thing to
add.

`worktree.created` carries a `metadata.via` discriminator with a CLOSED
vocabulary (BST-1392), emitted by exactly three sites in
`worktree-run-events.ts`: `'app'` and `'tool'` (`emitWorktreeCreateEvents`,
`worktree-service.ts`'s single `create()`), `'adopt'`
(`emitWorktreeAdoptedEvent`), and `'shell'` (`emitWorktreeShellCreatedEvent`,
the correlator). No new run-event kind was added for any of these: a second
kind would need its own pairing-contract row and a second label vocabulary for
the same fact. `'app'` vs `'tool'` is not a second writer's opinion — the Mode
chip's IPC handler and the `brainstrike.manageWorktree` tool executor both
flow through the ONE `emitWorktreeCreateEvents` emitter, which derives the
breadcrumb from the ledger row's `createdBy` (`'user'` → `'app'`, `'agent'` →
`'tool'`), so the timeline can never disagree with `brainstrike_worktrees`
about who created a worktree. Paired test:
`apps/desktop/src/__tests__/assistant-server/worktree-run-events.test.ts`.

Correlation reads the `executeCommand` TOOL RESULT, never the git-metadata
watcher. `GitInventoryInvalidation` carries `{ gitCommonDir, repositoryRoot }`
with no worktree path, no create-vs-remove discrimination, and a 300–2000 ms
coalescing window — attributing that to a run would be a temporal guess. The
correlator is fire-and-forget: it runs after the result exists and can never
delay or fail the tool call.

A `git worktree remove` run in a shell is reported as a VANISHED ledger row,
never archived: an archive carries a restorable snapshot and a shell removal
produced none. The ghost row's "missing on disk — restore it or archive it"
is the honest surface.

### MCP DISCOVERY SKIP KIND (BST-1602)

`mcp.tools.unavailable` is an additive `ASSISTANT_RUN_EVENT_KINDS` member
recording that a configured MCP server contributed ZERO tools to a run —
discovery lost its 5s timeout race, or that server's `listTools` failed. Unlike
the worktree kinds it is emitted by the AGENT STREAM, not a main-process writer:
`prependMcpDiscoverySkipChunks` yields it from
`createStreamIteratorFromRuntime`, the initial-turn seam, so it reaches
persistence through the ordinary run-event chunk path.

Status is always `'failed'` and never `'running'`, so it declares no terminal
and can never leave a row spinning. It is filed under `NEVER_RUNNING` in
`assistant-run-event-pairing-contract.test.ts`; that guard's own comment notes
it can force a kind to be CLASSIFIED but cannot check the classification against
the emitter, so `packages/agent/src/__tests__/mcp-discovery-run-events.spec.ts`
asserts the emitted status directly.

It is in `isAlwaysVisibleRunEvent`, and that membership is LOAD-BEARING rather
than incidental. Run-event rows are hidden unless background activity /
Developer detail is on, so a kind added to the contract alone would still report
nothing to the user it exists for — reproducing the silent degradation it was
added to end. It passes that allowlist's "does anything else card this?" test
cleanly: the tool never entered the run's map, so nothing cards it, and the
"Tool execution failed." card the user does see belongs to the model's follow-up
call on the missing tool and names the wrong cause. Carrying no `toolCallId` it
needs no exemption from the card-suppression rule.

`AssistantRunTimeline` needs no change: it renders `label`/`detail`/`status` and
derives only a lifecycle colour from the kind prefix via `classifyRunEvent`,
which falls through to `'lifecycle'` for any kind that is not `memory.*` /
`tool.*`. As always, a kind missing from `ASSISTANT_RUN_EVENT_KINDS` is REJECTED
by `readAssistantRunEvent` and the row disappears, which is why the contract
entry is the first thing to add.

Emission scope is fresh turns ONLY. The approval- and suspend-resume legs call
`runTurnAttempts` directly, so although a resume rebuilds the runtime and
re-runs discovery, it re-emits nothing. See
`docs/agents/assistant-providers.md` for the discovery-side contract.

### PROVIDER CALL-WARNING KIND (BST-1701)

`provider.request.warned` is an additive `ASSISTANT_RUN_EVENT_KINDS` member
recording that the provider did NOT carry a request out as written — every AI
SDK adapter answers a setting the model rejects by DROPPING it and listing it on
the call's `warnings` array instead of returning 400, so a user-set
`temperature` from the Prompt Workbench is simply ignored on a model that
refuses one.

Rows identify the configured provider/model in the detail prefix and metadata.
Identical warnings deduplicate per model within a run; a distinct pinned model
retains its own warning. Origin fields use the same bounded redaction contract.

Like `mcp.tools.unavailable` it comes from the AGENT STREAM, not a main-process
writer, and reaches persistence through the ordinary run-event chunk path. It is
NOT a prelude: a call warning does not exist until the request has gone out, so
`streamAttemptChunks` drains it per part
(`drainProviderCallWarningChunks`), which lands the row as soon as the adapter
opens its stream and never after the finish chunk that stops the consumer
pulling. Status is always `'failed'`, never `'running'`, so it declares no
terminal and cannot leave a row spinning; it is filed under `NEVER_RUNNING` in
`assistant-run-event-pairing-contract.test.ts`, and the emitted status is
asserted directly by
`packages/agent/src/mastra/__tests__/provider-warning-run-events.spec.ts`.

It is in `isAlwaysVisibleRunEvent`, LOAD-BEARING for the same reason: the turn
completes normally, so there is no failed tool, no error bubble and no card of
any kind — this row is the only evidence the setting was dropped, and a row
hidden at default detail would leave the silent degradation exactly as it was
found.

One row per DISTINCT bounded warning: the same rejection recurs on every step of a
multi-step turn (it is a property of the request), and the sink dedupes it to
one fact, one row across supervisor and persona calls. Provider-controlled
fields are bounded/redacted before the sink retains them, and metadata and
no-detail prose are bounded at presentation too. Exceptional termination drains
captured warnings before propagating the original failure (BST-1745).
The capture-side contract — including why the warnings are
read at the MODEL rather than off a Mastra chunk — is in
`docs/agents/assistant-providers.md`.

### Threads-panel active-run projection (BST-1244)

The Threads panel derives its running indicators directly from
`brainstrike_assistant_thread_runs` through ONE resource-scoped PGlite live
query (`packages/app-shell/src/use-active-assistant-thread-ids.ts`). It does not
own a second activity store, poll, or subscribe once per row. The query selects
the distinct thread ids whose durable status is `running`; the virtualized row
surface only performs `Set.has(thread.id)` for visible rows.

This makes all existing lifecycle writers authoritative for the indicator:
renderer-created runs appear after their durable insert; completed, failed, and
cancelled runs clear after their terminal update; thread deletion clears via
the existing cascade; and startup orphan sweeps clear pre-boot crash rows
through the same status transition. Desktop runs the sweep in main before the
renderer can create work. Web has no surviving run owner across reloads, so the
Threads-panel projection runs the shared boot-time predicate after schema
bootstrap and before starting its live query. It uses the navigation time
origin, not hook mount time, so opening or remounting the panel cannot classify
a current-page long run as an orphan. Desktop skips the renderer sweep because
its main-process stream can survive a renderer reload and reattach.

Once schema bootstrap has succeeded for a database handle, the subscription
stays enabled across transient thread-list loading states (including thread
creation) and only resets when the handle changes. Sweep, subscription, or
row-shape failures clear possibly stale indicators and render an explicit
unavailable state instead of silently presenting every thread as idle. The
spinner is a labelled graphic rather than a live region, avoiding repeated
screen-reader announcements as virtualized rows mount, and keeps a static
active treatment under reduced motion.

Paired coverage: `packages/app-shell/src/__tests__/threads-panel.test.tsx` and
the concurrent-run case in `apps/web/e2e/assistant-ui-panel.test.ts`.

### Threads-panel awaiting-approval projection (BST-1404)

The panel's second — and last — live query,
`packages/app-shell/src/hooks/use-threads-awaiting-approval.ts`, answers "which
threads are parked on a tool approval the user has not answered", under the same
BST-1244 discipline: one resource-scoped subscription for the whole list, no
second activity store, no polling, no per-thread round trip. This is the reason
the durable `tool.approval.requested` row exists at all; rediscovering a pause
from the Mastra suspended-workflow snapshot is per-thread and cannot answer a
list-wide question.

Three rulings the SQL depends on (do not relitigate):

- **Resolution is paired on `metadata->>'toolCallId'`, run-agnostically.** The
  approval-resume leg mints its OWN runId and `thread_runs` row, so the
  `tool.started` / `tool.completed` / `tool.failed` / `tool.resume.unsupported`
  that answers a pause carries a DIFFERENT `run_id` than the pause. `sequence`
  is per-run and meaningless across the two legs, so ordering is never expressed
  as a comparison. A pause row with a NULL `toolCallId` is excluded — nothing
  could ever answer it, and `NULL = NULL` inside the `NOT EXISTS` would pin the
  badge forever.
- **An answer must OCCUR AFTER the pause it answers, and that comparison is the
  whole ordering guard.** Mastra's approval gate runs INSIDE `toolCallStep`,
  i.e. after the model's `tool-call` part has already streamed; that part maps
  to `status: 'start'` (`packages/agent/src/mastra/tool-event-mapper.ts`) and so
  to a `tool.started` run event carrying the SAME `toolCallId`, emitted BEFORE
  the pause row. The observed live order is
  `['tool.started', 'tool.approval.requested']`, pinned against the real
  `@mastra/core` approval loop in
  `packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts`.
  Pairing `tool.started` on `toolCallId` alone therefore let every pause answer
  ITSELF, and the "needs you" glyph never lit for anyone. The guard is
  `AND answer.occurred_at > requested.occurred_at`. `sequence` could not serve
  (it is per-run, so it is meaningless across the two legs), but `occurred_at`
  is wall-clock from one process and IS comparable across them. A tie fails the
  comparison and so counts as NOT an answer — the safe direction, because it
  keeps an obligation lit rather than silently dropping one. The three terminal
  kinds could not be emitted by the pausing leg anyway, so the guard only ever
  binds on `tool.started`.

  IT USED TO BE `run_id`-SHAPED (`AND NOT (answer.kind = 'tool.started' AND
  answer.run_id = requested.run_id)`), on the reasoning that the runs already
  carry the ordering: a call's pre-pause start shares its pause's run, and only
  a post-approve start is on a different one. **That premise is false whenever
  one step holds TWO gated calls**, and it was corrected in BST-1440's review.
  `foreach(toolCallStep)` is sequential, so Mastra pauses on A alone while B's
  `tool-call` part has ALREADY streamed: leg 1 emits `tool.started` for BOTH,
  and B does not reach its own gate — or its own pause row — until leg 2. B's
  pre-pause start is therefore on a DIFFERENT run than B's pause, the same-run
  exclusion never fired for it, and B's own pre-pause start answered B's pause:
  the glyph went dark while the user was still genuinely being asked about B.
  The producer shape is pinned by "PAUSES ONE CALL AT A TIME" in the approval
  spec above; the projection outcome by "keeps the thread lit when a SECOND
  gated call pauses on the resume leg" in
  `packages/app-shell/src/__tests__/use-threads-awaiting-approval.integration.test.ts`.
  The defect PREDATES BST-1440 — under the older producer it merely surfaced
  later, once `tool.completed` cleared the first pause, which that lane also
  pins.

  THE RE-YIELD IS REAL, and only became so in BST-1440. Mastra never replays a
  resumed step's `tool-call` part (`approveToolCall` delegates to
  `resumeStream`, which re-executes `toolCallStep` with `messages: []`; the one
  `tool-call` replay inside that step is gated on a background-task manager
  Brainstrike does not register — @mastra/core 1.59). `makeResumedStartChunks`
  (`packages/agent/src/mastra/agent-streaming.ts`) therefore SYNTHESISES the
  start chunk for every pending call of the resumed step, and routes it through
  `makeToolLifecycleRunEventChunk` — the same single seam the mainline
  `tool-call` part reaches through `mapGenericToolEvent`, so the `tool.started`
  run event cannot ship on one path and not the other. Before that it shipped
  only on the mainline, this exclusion clause was dead weight, and the glyph
  cleared when the approved tool FINISHED rather than when the user answered —
  masking the truthful Running state for the whole execution. The resume-leg
  emission is pinned against the live approval loop in
  `packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts`;
  the projection outcome is pinned in
  `packages/app-shell/src/__tests__/use-threads-awaiting-approval.integration.test.ts`.
- **The query does NOT read `thread_runs.status`.** A leg that pauses for
  approval finishes with `finishReason: 'tool-calls'`, which every terminal
  writer records as `status = 'completed'`, while the user's obligation and the
  suspended Mastra snapshot both outlive that row. Filtering on
  `status = 'running'` would make this projection permanently EMPTY. For the
  same reason it needs no web startup-reap gating (unlike the active-run
  projection above): the reap only corrects stale `running` rows, and this query
  reads none. It is gated on `schemaReady` alone — which since BST-1651 means
  the thread repository's schema probe has passed, not that a renderer
  bootstrap has created `brainstrike_assistant_run_events`. Migration 118
  creates that table.

Note that `tool.started` counts as a resolution HERE and deliberately does not
in `assistant-run-event-derivation.ts`: the timeline asks whether the pause row
has reached a terminal state (a still-executing tool has not), while the panel
asks whether the user still has to answer (a tool that started was approved).

Both sides of that anti-join are served by two PARTIAL indexes on
`brainstrike_assistant_run_events` — `…_approval_pause_idx`
`(resource_id, thread_id) WHERE kind = 'tool.approval.requested'` and
`…_approval_answer_at_idx`
`(resource_id, thread_id, (metadata->>'toolCallId'), occurred_at)` over the four
answer kinds (`occurred_at` trails so the postdating comparison above stays on
the index). Every pre-existing index on that table leads with `thread_id` or
`run_id`, so without these the query full-scanned the largest assistant table
twice on every `run_events` notify. They live in **migration 118** and nowhere
else, alongside the `DROP INDEX IF EXISTS` that retires the pre-BST-1440
`run_id`-shaped answer index — `CREATE INDEX IF NOT EXISTS` keys off the NAME,
so an install carrying the old one is upgraded by that DROP and the renamed
CREATE, which is the same upgrade path as 118's `turn_message_id` ADD COLUMN.

Paired coverage: `packages/app-shell/src/__tests__/use-threads-awaiting-approval.test.ts`
(query text) and `…/use-threads-awaiting-approval.integration.test.ts` (real
PGlite: the SELECT's OUTCOME over rows seeded through the production repository
writers, including the cross-run resolution, the per-thread/per-resource
scoping, and the paused-run-row-is-`completed` case that a status-correlated
query would fail — a substring assertion cannot catch that class of error).

### RUN ERROR PROVIDER FORENSICS (Flight Recorder P3)

`brainstrike_assistant_run_errors` is the durable one-row-per-run provider
failure summary (migration 076, registered in both runners and sole author
since BST-1651 retired the bootstrap mirror). It is deliberately
separate from both the run-event timeline and app-wide diagnostic events:
`run_events` describes lifecycle presentation, while `run_errors` retains the
terminal classification and bounded provider response evidence needed for
forensics.

The table is FK-less, a shape inherited from when the parent was created at
runtime and NOT revisited by BST-1651. Migration 118 now creates
`brainstrike_assistant_thread_runs`, so an FK has become expressible — but none
is declared, and nothing is scheduled to declare one. The parent link is
enforced in code, not by the schema, and the paragraph below is that
enforcement; do not read the FK's absence as an oversight. The canonical
`AssistantRunErrorRepository.record` therefore derives `thread_id` and
`resource_id` from the durable renderer-minted parent run; callers provide
neither. A missing parent returns no row and THROWS. A conflict on `run_id`
returns the existing row only while the parent still exists, so independent
terminal writers are first-terminal-wins and can never overwrite the original
classification. An already-stored orphan is not accepted as a successful
duplicate.

Desktop catches that loud repository failure at the stream integration boundary
and records `Failed to persist assistant provider failure forensics` with the
run and event ids. The failure MUST remain observable, but it MUST NOT replace
the original provider-failure stream (for example when a thread is deleted
mid-run). The run-event timeline write immediately before it retains its
existing flush semantics.

The row contains `code`, nullable `message`, nullable array-shaped
`cause_chain`, nullable `http_status`, nullable `provider_request_id`, nullable
object-shaped allowlisted `response_headers`, and `occurred_at`. It has NO
`attempts` field: current Mastra error processors expose neither the complete
attempt sequence nor the actual rate-limit wait, so an attempts array would be
fabricated/incomplete data. The application extraction boundary owns content
bounds and the literal response-header allowlist; the database independently
CHECKs JSON shape and HTTP status.

With no FK, lifecycle is explicit: `deleteThread` / `deleteThreads` remove run
errors before their parent runs, and all three table-enumerating reset paths
(desktop `db:clearAll`, renderer direct clear, renderer factory-reset purge)
clear the table before Mastra threads. Paired tests:
`packages/db/__tests__/migration-076-assistant-run-errors.test.ts`,
`packages/db/__tests__/assistant-run-error-repository.test.ts`,
the thread-deletion cases in
`packages/assistant-data/src/__tests__/assistant-memory-repository.integration.test.ts`,
and the desktop/renderer clear integration suites.

---

## SYNC-THE-MIND OP-LOG SEAM (BST-993)

Per the 2026-07-28 BST-911 ruling, future sync covers the "mind" —
threads/memory/prompts — never vectors/HNSW. The groundwork laid here is a
tombstone seam, deliberately nothing more (no engine choice, no write-path op
emission — that is engine territory):

- **Where state lives:** `brainstrike_mind_ops` (migration 079 in BOTH
  runners; migration-owned since BST-1651 retired the repository's bootstrap
  mirror). Append-only:
  `seq BIGSERIAL` is the lamport-ish local order; `entity_kind` ∈
  {`thread`, `prompt_item`} and `op` = `delete` are CHECK-constrained on
  purpose — widening the vocabulary is a conscious migration, never a drift
  channel. Thread tombstones capture `resource_id` from the delete's own
  RETURNING — the workspace scope is unrecoverable once the thread row is
  gone, and a per-resource sync engine could never partition the log after
  the fact (nullable: prompt items are global). Sidecar-not-ALTER: Mastra
  owns the `mastra_*` schema and its lazy tables have no evolution
  mechanism.
- **Tombstones derive FROM the log.** No `deleted_at` columns anywhere: rows
  still physically disappear, so the thread-search orphan GC's anti-join and
  the readonly sandbox role's visibility rules are untouched.
- **One cascade spec.** `THREAD_DELETE_SIDECAR_TABLES` (assistant contract,
  `mastra-memory-schema`) is the ordered thread-delete cascade over the
  Brainstrike sidecars. All THREE delete implementations derive from it: the
  single-thread CTE, the bulk CTE (previously drifted in both stage-set and
  order), and the Mastra `MemoryStorage.deleteThread` override (previously
  deleted only the three Mastra tables). The single-thread CTE now owns the
  placements stage itself instead of relying on the panel's separate
  `clearThreadPlacement` round trip.
- **Ops record actual deletions.** Each path inserts one `thread` op per
  thread row it actually deleted (idempotent deletes emit nothing; a rejected
  bulk delete emits nothing). `PromptItemRepository.delete` emits
  `prompt_item` ops the same way. The standalone Mastra store probes the
  app-owned sidecars with `to_regclass` (a bare store legitimately lacks
  them and has no seam to feed); on a migrated database every probe passes.
- **Delegated branches:** all three paths use `DELEGATED_THREAD_DELETE_CTES`
  to include descendant native threads and their sidecars. It validates the
  complete live ancestry and descendants before selecting any deletion target;
  a changed owner/resource rejects the whole command. Parent/sibling threads
  outside a selected subtree survive. Overlapping bulk requests emit each
  tombstone once. The desktop `delegated-thread-deletion.integration.test.ts`
  exercises all three real-PGlite paths, including rejected deletions.
- **Reset:** registered in the reset registry — the op-log is cleared with
  the mind it describes on all three clear paths.

Paired tests: `migration-079-mind-ops-log.test.ts`, the tombstone cases in
`assistant-memory-repository.integration.test.ts`,
`pglite-memory-store.integration.spec.ts`, and
`prompt-item-repository.test.ts`.

## STALE TOOL-PROJECTION REWRITE OVERLAYS (BST-1192, LAYER 1)

Desktop native workspace inspection history is compacted at the transient
provider-request boundary without mutating Mastra-owned message content.

- **Where state lives:**
  `brainstrike_assistant_tool_projection_rewrites` (migration 084 plus the
  migration-087 `kind` extension, sole authors since BST-1651 retired the
  bootstrap mirror — that mirror declared `kind` inline, so a bootstrapped
  database had it at ordinal 5 where a migrated one has it at ordinal 8; no FKs
  because migrations run without Mastra's lazy tables). `tool_call_id` is the
  primary key; `thread_id` owns cleanup; `rewrite_id` groups one committed
  batch for diagnostics; `superseded_by_tool_call_id` is the live-evidence
  guard; `marker_text` is the exact compact replay; `original_chars` records
  the decoded model-projection character count (BST-1195 ruler) used for
  diagnostics. The table is registered in the reset registry and the shared
  thread-delete sidecar cascade.
- **Detection and batching are desktop-local and restart-safe.** After a
  successful `readWorkspaceFile` or `grepSearch`, and after a successful
  `writeWorkspaceFile` or `stringReplaceWorkspaceFile`, desktop scans the
  thread's visible persisted tool invocations and excludes calls already in
  the overlay. Resolved-file identity is canonical `rootId` plus workspace path
  (root-name fallback exists only for legacy persisted results that predate
  `rootId`). Overlapping reads supersede earlier reads; either supported edit
  supersedes all earlier reads of that file; an identical normalized grep
  pattern/scope supersedes the earlier grep. Persisted unchanged-read dedup
  stubs are neither candidates nor superseders. Read markers name a later read
  only when one exists; edit-superseded markers direct the model to re-read, and
  multi-root markers use the same unambiguous root-label rule as the live read
  projector. No in-memory pending queue exists. Reclaimable size is measured in
  DECODED characters (BST-1195's `decodedWorkspaceTextModelOutputChars` ruler —
  code points in the projected model-facing text plus the fixed envelope
  reserve, never `JSON.stringify(...).length`), matching the SAME ruler the
  live `readWorkspaceFile`/`grepSearch` projectors self-fit against, so the
  64 KiB batch threshold below reflects the actual model-facing saving rather
  than an inflated JSON-escaped approximation. It is still an honest character
  approximation, never token-exactness. Predicate matching is cheap; model
  projections are built once, only for a winning pair. One transaction commits
  the whole pending batch only at 65,536 reclaimable decoded characters or
  more; below threshold it writes nothing. Detection/commit is post-success
  optimization bookkeeping: any failure is logged and the already successful
  tool result remains successful. Malformed persisted records warn ONCE per
  process, not once per scan (BST-1248): a module-scope memo keyed by
  `tool_call_id` dedupes the WARN ONLY — every scan still re-parses, because
  `read`/`grepKey` feed supersession detection in both directions and a
  record that fails one consumer's stricter contract must keep acting as the
  superseder of other, valid records (gating the parse silently lost their
  reclamation; review-caught, pinned by the A/X/L geometry test). Before the
  memo, one bad record re-warned on every subsequent tool call in the thread
  (139 duplicates from a single record in the 2026-08 audit). The first
  encounter always warns; distinct records warn independently; past a
  distinct-record ceiling ONE summary warning
  (`tool_projection_rewrite_malformed_history_suppressed`) announces
  suppression instead of an eviction cliff
  (`tool-projection-rewrite-repository.test.ts` pins all of it). Candidate
  size is measured from the PERSISTED model output
  (`providerMetadata.mastra.modelOutput`, the same source recency pruning
  reads), never by re-projecting the raw result (BST-1249): re-projection
  re-applies the DEFAULT domain budget, smaller than the loop-guard/scaled
  budget some runtimes used, so legitimately-large historical reads threw
  RangeError and were mislabeled malformed on every scan — the 2026-08
  audit's three "malformed" records were exactly this. Only legacy rows
  without a persisted model output re-project, under the CEILING scaled
  budget.
- **Replay rewriting is surgical and transient.** The agent-side Mastra input
  processor receives the fully built AI-SDK prompt and replaces only matching
  `tool-result.output` values with text markers. It runs before provider-history
  compatibility and the final contiguous token limiter. An absent desktop
  lookup capability omits the processor; an empty lookup or inert diff returns
  `undefined` and preserves the golden path.
- **Rewind self-heals without undo state.** Before applying X's overlay
  (`superseded_by_tool_call_id = Y`), the processor verifies that Y is still
  present somewhere in the CURRENT prompt. Mastra's five rewind-aware read
  paths have already removed tombstoned messages by this point. If rewind hid
  Y, X replays its original durable content; no stored invocation result was
  ever overwritten, so there is no content-loss or rollback log.
- **A committed batch resets loop guards for the same thread scope.** Desktop
  calls `resetToolCallLoopGuards(readStateScope(runtimeData))` only after a
  transaction inserted overlay rows. This prevents an unchanged-read dedup
  stub from referring to evidence the new batch will collapse. Below-threshold
  scans do not reset the guards.

## RECENCY-WINDOW TOOL-PROJECTION PRUNING (BST-1200, LAYER 2)

Layer 2 reuses Layer 1's transient overlay and never mutates Mastra message
content.

- **State and replay kind:** migration 087 adds CHECK-constrained
  `kind IN ('supersession', 'prune')`, makes
  `superseded_by_tool_call_id` nullable, and ties the two with a second CHECK:
  supersession requires a non-null superseder; prune requires NULL. Existing
  rows backfill to `supersession`. The processor keeps Layer 1's
  current-prompt superseder-presence gate only for supersession rows. A prune
  row applies whenever its own call remains in the already-tombstone-filtered
  prompt; rewinding unrelated later messages does not make age-selected
  evidence fresh again. Migration 087's `down` deletes every `kind = 'prune'`
  row before restoring the migration-084 `NOT NULL` on
  `superseded_by_tool_call_id` — those rows are a rebuildable transient
  overlay, so dropping them on rollback is correct, and without the delete
  `SET NOT NULL` fails outright once any prune row exists.
- **Deterministic selection:** desktop measures each persisted
  `providerMetadata.mastra.modelOutput` projection with
  `decodedPersistedModelOutputChars` — `decodedTextModelOutputChars` for
  `type: 'text'`/`type: 'content'` shapes, and the same ruler applied to the
  `toJsonSafe`-serialized value for `type: 'json'` shapes (the artifact
  reader's `buildModelPage()` and artifact settlement's
  `createArtifactOutputs()` both persist `json`, and artifact spill is
  precisely the large-output path pruning targets — treating it as malformed
  would silently disable pruning on exactly the threads with the most to
  reclaim). Only a genuinely unknown shape throws. An invocation persisted
  before `providerMetadata.mastra.modelOutput` existed (`modelOutput ===
  undefined`) is skipped from the size walk entirely, matching how
  `projection-safe-tool-call-filter.ts`/`projection-aware-token-limiter.ts`
  already treat absence as normal — never a pass-aborting throw.
  `TOOL_PROJECTION_PRUNE_PROTECT_WINDOW_TOKENS` (40,000) protects whole
  invocations overlapping the newest window, derived as 160,000 decoded chars
  through `APPROX_CHARS_PER_TOKEN = 4`. `TOOL_PROJECTION_PRUNE_MIN_RECLAIM_TOKENS`
  (20,000) gates the sum of decoded full-result-minus-marker savings, likewise
  derived as 80,000 chars. Below the floor the pass writes nothing. Repeated
  Mastra snapshot copies of one `toolCallId` keep their latest projection and
  count once. Eligibility is an explicit ALLOWLIST of read-only, cheap-to-
  re-run native tools (`grepSearch`, `readWorkspaceFile`, `globWorkspace`,
  `hybridSearch`, `queryEmbeddingSpace`, `querySelf`, `queryDiagnostics`,
  `listWorkspaceContext`, `readWorkspaceDirectory`, `findWorkspaceSymbol`,
  `lspInspect`, `webSearch`, `webExtract`, `readToolOutputArtifact`,
  `skill_search`, `inspectCommandSessions`) — never a denylist — so every new
  or future native tool is exempt by default. Mutating/interactive tools
  (`writeWorkspaceFile`, `executeCommand`, `runPython`, `runSkillScript`,
  `askUser`, `manageCanvas`, `manageTaskList`, …) are ineligible: re-running
  one is either not idempotent (a mutation repeats) or not what the marker
  implies (`askUser`/`submitPlan` suspend for a NEW answer), and their
  projections are tiny, so the reclaim is near zero against a real downside.
  `skill` and `skill_read` stay unconditionally exempt (their output IS the
  working skill body a later turn may still need); `skill_search` differs —
  its output is a disposable search-result list, so it is allowlisted like
  `grepSearch`. This allowlist is deliberately narrower than and NOT derived
  from `tool-risk.ts`'s `'read'` risk bucket, which several exempt tools
  (`askUser`, `submitPlan`, `manageTaskList`, `manageCanvas`) also resolve to
  for the unrelated reason that they don't mutate workspace/fs state.
- **Current turn is an explicit persisted boundary:** the scan uses the latest
  visible persisted user message, matching the runtime's last-real-user turn
  anchor. Assistant rows after that anchor are current-turn rows, and every
  tool-call id they carry or reference is ineligible even if an earlier
  snapshot repeats it. With no visible user anchor, every assistant row is
  conservatively current. Current-turn results still participate in the
  newest-window size walk, but can never become candidates.
- **Markers are generic and visible:** one line names the canonical native tool
  id, a 12-hex SHA-256 digest of `stableNormalizedArgsKey(args)`, and directs
  the model to re-run the tool. Raw invocation args/results stay byte-identical
  in `mastra_messages`.
- **Trigger and commit:** the scan runs after successful executions at Layer
  1's existing four decoration points (`grepSearch`, `readWorkspaceFile`,
  `stringReplaceWorkspaceFile`, `writeWorkspaceFile`). This keeps one
  deterministic post-success path and fixed-count SQL reads; it adds no job,
  queue, LLM call, or per-invocation query. One transaction inserts the batch
  with `ON CONFLICT (tool_call_id) DO NOTHING`, so replay scans cannot
  double-prune. Only an actually inserted prune batch resets
  `resetToolCallLoopGuards(readStateScope(runtimeData))`, preventing dedup stubs
  from pointing at newly collapsed evidence, and emits the structured
  `tool_projection_prune_batch_committed` log with row and reclaimed-char
  totals.

## CONVERSATION REWIND TOMBSTONES (BST-1115)

Soft rewind hides a contiguous suffix of a thread without destroying it, so a
one-level redo is exact and the messages only die when the next user message
finalizes the rewind.

- **Where state lives:** `brainstrike_assistant_message_tombstones` (migration
  080 in BOTH runners, sole author since BST-1651 retired the bootstrap
  mirror; no FKs — migration 055 message-parents precedent). Columns:
  `message_id` (PRIMARY KEY), `thread_id`, `rewind_id` (NOT NULL),
  `revert_id` (NULLABLE), `tombstoned_at`. Indexed on `(thread_id)` for the
  read-path anti-join and `(rewind_id)` for batch redo. Registered in
  `THREAD_DELETE_SIDECAR_TABLES` (all three thread-delete cascades derive from
  it) and in the reset registry.
- **Two batch ids, because rewind has a scope choice.** `applyRewind` takes
  `mode: 'conversation-only' | 'conversation-and-files'`. `rewind_id` is the
  tombstone batch identity and the redo key, present in BOTH modes;
  `revert_id` links the paired file restore (since W7 T3: the `pre-revert`
  snapshot ledger rows recorded under `run_id = revert_id`) and is NULL
  for `conversation-only`, which performs no file revert at all. One shared
  column would force either a fabricated revert id or a nullable redo key —
  and a nullable redo key is how a batch gets lost.
- **`message_id` is the primary key on purpose.** A message is tombstoned at
  most once, by exactly one batch — that is what makes "delete the newest
  `rewind_id` batch" an exact inverse. A second rewind re-covering an already
  hidden message keeps the ORIGINAL batch's row (`ON CONFLICT DO NOTHING`), so
  undoing the newer rewind cannot resurrect what the older one hid.
- **THE FILE-REVERT RANGE PREFERS THE STORED RUN↔TURN LINK** (BST-1163):
  `brainstrike_assistant_thread_runs.turn_message_id` (nullable; created by
  MIGRATION 118, whose `ADD COLUMN IF NOT EXISTS` is the upgrade path for
  installs that predate BST-1163) records the user message whose turn each run
  belongs to. Because the chain guarantees the column, the main-process
  `information_schema` COLUMN probe that used to guard every read of it was
  retired by BST-1651 — `resolveRewindRunRange` and `resolveRewindMessageForRun`
  now reference `turn_message_id` unconditionally, and NULL-link rows are
  handled by the query's own `CASE`, not by a schema branch. It is
  stamped at `createThreadRun` — the transport resolves the per-leg turn
  anchor (`resolveTurnAnchorMessageId` in `data-stream-runtime.ts`: the last
  REAL user message, approval action echoes excluded) and threads it through
  `prepareRequest`/`prepareRequestData`, so initial sends AND
  approval/suspend resume legs stamp the SAME id. `resolveRewindRunRange`
  puts a linked run in range exactly when its turn message is at-or-after
  the target in the message total order, and `resolveRewindMessageForRun`
  answers a linked run's own turn message exactly (closing the documented
  mid-turn under-coverage). NULL-link rows (pre-link, or a link whose
  message a finalized rewind deleted) keep the `completed_at` fallback
  below. Paired tests: `rewind-turn-link.integration.test.ts` +
  `assistant-thread-run-turn-link.integration.test.ts`.

  **THE FALLBACK ANCHORS THE TARGET MESSAGE AGAINST `completed_at`**
  (`resolveRewindRunRange`): a run is in range when it had not yet finished at
  the moment the target message was sent. **A TURN IS NOT ONE RUN** — every
  tool-approval / askUser resume mints another `brainstrike_assistant_thread_runs`
  row through `prepareRequestData` -> `createThreadRun`, while the turn's
  assistant message row is persisted at the START of the turn and upserted in
  place as it streams on. The original rule anchored on the message PRECEDING
  the target and compared `started_at`, which swept the previous turn's resume
  runs into the revert; the 2026-08-05 live smoke reverted a run that started 81
  seconds BEFORE the message rewound to, and because that run's capture was a
  `created` row the revert DELETED the user's file. `completed_at` also settles
  the boundary the old rule was built around: a run row is minted milliseconds
  BEFORE its own user message is persisted, so `started_at` cannot order them,
  but the run always ends later. NULL `completed_at` counts as in range and is
  unreachable from `applyRewind` (`hasInFlightThreadRun` refuses first).
  **Run -> message round-trips through the stored link** for every post-link
  row; only NULL-link fallback rows retain the old mid-turn under-coverage
  (`resolveRewindMessageForRun` maps such a resume run to the next turn's
  message — the safe direction, and the modal shows the resolved range).
- **A REWIND IS INVISIBLE WITHOUT A RE-HYDRATION BUMP.** Every read path below
  excludes tombstoned messages, but the live assistant thread is not a read
  path — it is assistant-ui in-memory state, hydrated ONCE by
  `ThreadHistoryAdapter.load()` when the runtime mounts. The 2026-08-05 live
  smoke applied a rewind, wrote its tombstones, reverted its files, and the user
  watched an unchanged conversation over a Changes surface still listing the
  reverted files. `useRewindStore.generation` (app-shell) is the fix: bumped on
  a successful apply AND a successful redo, forwarded as the panel's
  `historyGeneration` prop into the data-stream runtime's `key`, and read by
  `useChangeset` as a load input. A bump remounts the runtime, which re-runs
  hydration against the filtered query, and re-resolves the changeset view.
  **Discarding the live thread's in-memory state is the point**, not collateral:
  post-rewind the durable state IS the truth. It is deliberately NOT folded into
  `threadKey` — per-thread state (follow-up queue, `ActiveThreadKeyContext`,
  viewport pinnedness) is keyed by that and must survive a rewind, including the
  composer text the rewind just repopulated. The modal bumps BEFORE handing text
  to `useRewindComposerStore`, because `RewindComposerBridge` lives inside the
  remounted runtime and it is the new instance that must drain it.
- **RESTORES DELETE FILES, SO THEY MUST PRUNE DIRECTORIES.** A turn that
  scaffolds a project creates directories no ledger row (and no snapshot tree
  entry) names. The 2026-08-05 smoke round 2 rewound a scaffolded React app
  and got every file unlinked over an intact folder tree. The rule survived
  the W7 engine swap in `pruneEmptyAncestorDirectories`
  (`snapshot-restore-plan.ts`, shared by the rewind restore plan and the
  checkpoint undo's `restorePathsFromSnapshot`): after deleting a
  restore-plan-absent path, walk UP from its parent removing each now-empty
  directory, stopping at the first `rmdir` refusal (ENOTEMPTY = something the
  run did not create) and unconditionally at the workspace root. Failures are
  swallowed: the file is already gone and a leftover directory must not
  report a successful restore as failed. KNOWN LIMITATION, accepted: an
  intentionally-empty pre-existing directory on the created file's exact path
  is indistinguishable from a scaffolded one and will be pruned.
- **CAPTURE SCOPE: SHELL SIDE EFFECTS ARE COVERED NOW.** The W7 snapshot
  engine captures everything between turn boundaries — assistant-tool edits
  AND shell side effects (`npm install`'s `package-lock.json`, a build's
  `dist/`) — so the old `REWIND_SHELL_CAPTURE_QUALIFIER` copy ("files created
  by shell commands aren't restored") became UNTRUE and was DELETED in T4
  with its `rewind-copy.ts` module; `rewind-confirm-dialog.test.tsx` pins its
  ABSENCE. The honest states that remain are the ones that still occur:
  "this turn predates workspace snapshots" (conversation-only rewind,
  `REWIND_TURN_PREDATES_SNAPSHOTS_MESSAGE` in `rewind-snapshot-engine.ts`,
  reused as the checkpoint-undo unavailability reason) and per-turn
  capture-failed refusals.
- **Mastra stays the writer of message content.** Nothing here alters a
  `mastra_*` table; hiding is an anti-join in Brainstrike-owned reads, and the
  finalizing hard delete goes through Mastra's own `deleteMessages` storage
  API. **FIVE read paths apply the exclusion — they are separate seams, and
  four of them do NOT share a WHERE clause with the first:**
  1. `PgliteMemoryStore.listMessagesWhere` — `listMessages` /
     `listMessagesByResourceId`. Exclusion sits in the shared `where[]`, so
     the COUNT and the page query agree and `total`/`hasMore` describe the
     VISIBLE set. Observational memory reads messages ONLY through these two
     entry points, so this one clause covers all of OM.
  2. `PgliteMemoryStore.findMessageRowById` — semantic recall's include
     TARGETS. Recall reaches messages via `listMessages({ include })`, which
     never passes its targets through the main WHERE clause. A hidden target
     resolves to null and `appendIncludedMessages` skips the whole item, so it
     contributes no neighbour window either.
  3. `PgliteMemoryStore.listAdjacentThreadMessageRows` — the include NEIGHBOUR
     window. **TRUNCATES at a tombstone; it does NOT skip over one.**
     `withPreviousMessages: 2` means "the two messages immediately before the
     hit". Filtering hidden rows out of the WHERE clause would silently
     redefine that as "the two nearest VISIBLE messages" — reaching further
     back than asked, splicing two never-adjacent turns into one window and
     inflating the token budget the recall config was tuned against. The rows
     are flagged in place and cut at the first hidden one: less context, never
     fabricated context.
  4. `assistant-data assistant-memory-repository.listMessages` — the renderer
     hydration window. The exclusion is INSIDE the windowing subquery so it
     applies before `limitLatest`: the window is the latest N VISIBLE
     messages. This query is also what a reload runs, which is why a rewind
     survives a restart with no renderer-side state at all.
  5. `db thread-search-repository` — Explorer search, `fullTextSearch` and
     `searchSimilar`. A message hidden from its thread must not surface as a
     hit that navigates nowhere. **Applied to the SEARCH ARMS only**, never to
     `sync` / `refreshActiveThreads` / `getCoverage`: the index row and its
     embedding deliberately stay put so redo restores visibility instantly
     instead of owing a re-embed, and because the sync membership fast path
     compares `COUNT(*) FROM mastra_messages` against the index count —
     skipping tombstoned rows on insert would hold those counts permanently
     unequal AND the orphan GC (which keys off a MISSING source row) would
     never converge. Finalization deletes the message through Mastra and the
     GC reaps the index row on its own.
- **Sidecar presence is PROBED in `PgliteMemoryStore`, not assumed.** That
  class's `initialize()` creates only the Mastra schema, so a standalone store
  legitimately lacks the table (same reason `deleteThread` probes its cascade
  tables). `to_regclass` answers, and the result is latched TRUE only —
  caching "absent" would leave a store built before migrations ran ignoring
  every rewind for the life of the process. The app-shell repository and the
  db repository both assume the table: they run against a bootstrapped /
  migrated database by construction.
- **KNOWN LIMITATION — OM residue (accepted; do not try to fix).**
  Observations the observer ALREADY distilled from a message survive that
  message being tombstoned, so the model can still carry a summary of a hidden
  turn. Mastra exposes no partial un-observe — only `clearObservationalMemory`,
  which would discard the whole thread's memory to erase one turn. Do NOT
  scrub observation text; that is guesswork over prose the observer wrote.
- **FINALIZATION — where it runs, and what triggers it (W5 T4b).**
  `finalizeThreadRewinds` lists a thread's tombstones, hard-deletes those
  messages through `PgliteMemoryStore.deleteMessages`, and drops the sidecar
  rows. It lives in MAIN because everything it touches does: the store is
  constructed in `assistant-server/mastra-memory.ts` (main), the sidecar is
  written only by `assistant-server/rewind-repository.ts` (main), and the
  renderer holds no store instance at all — a renderer-side finalization could
  only reach `mastra_messages` with raw SQL, which is exactly the second-writer
  the read-path rules above forbid. `createRewindFinalizationDeps` builds a
  BARE `PgliteMemoryStore` over the main database rather than a full
  `createPgliteMastraMemory`, which throws without an embedder under some
  memory settings; `deleteMessages` needs only the database handle.
  - **The trigger is renderer-side, over `changes:finalizeRewinds`.** A
    USER-AUTHORED message starting a NEW run — the conjunction of the composer
    submit and the run-creation seam. See the RUN-CREATION SEAM section in
    `assistant-runtime.md` for why one signal alone is wrong in both directions.
  - **The delete runs FIRST and its failure PROPAGATES**, so a thread whose
    messages could not be removed keeps its tombstones and stays hidden.
    Dropping the sidecar rows anyway would resurrect a rewound conversation
    silently. The CALLER never blocks the send on it: the failure is logged and
    toasted, and the next send retries.
  - **Idempotent and serialized per thread.** A thread with nothing outstanding
    answers `finalized: false` and writes nothing, so a double fire is free.
    `withThreadRewindLock` serializes finalization against `redoRewind`,
    because they are the two ways a batch stops existing and both are one click
    away from each other. Redo re-reads its batch INSIDE the lock so it can
    LOSE: a redo racing a committed finalization returns the typed
    `rewind-not-found` refusal before touching a file, instead of reverting the
    files and reporting success over an empty restore set.
- **No `mind_ops` row, by ruling.** `brainstrike_mind_ops.entity_kind` is
  CHECK-constrained to {`thread`, `prompt_item`} and widening that vocabulary
  is a conscious migration for when a sync engine is actually chosen (BST-993,
  above) — a tombstone is not a deletion at all, and the finalizing message
  delete follows the existing precedent that per-message deletes emit no op.

Paired tests: `migration-080-assistant-message-tombstones.test.ts` (both
runners, indexes, the at-most-once invariant, the conversation-only NULL
`revert_id` shape, the NOT NULL `rewind_id`, reset registration),
`pglite-memory-store-tombstones.integration.spec.ts` (one case per store seam,
the window-truncation contract, redo, reload, and the presence-probe latch),
the `soft-rewind tombstone hydration` cases plus the thread-delete cascade case
in `assistant-memory-repository.integration.test.ts`, the `soft-rewind
tombstones` cases in `search-thread-message-index.test.ts`, and the clear/reset
sentinels in `clear-data.integration.test.tsx` and
`ipc-handlers-db-clear-all.integration.test.ts`. Finalization adds the
`finalizeThreadRewinds` and `redoRewind vs finalizeThreadRewinds` cases in
`rewind-service.integration.test.ts` (idempotency, double-fire, the redo race
in either order), the `changes:finalizeRewinds` cases in
`rewind-ipc-handlers.integration.test.ts`, and the two renderer-trigger suites
named in `assistant-runtime.md`.

## AGENTIC CONVERSATION COMPACTION (BST-1200, MILESTONE 2)

Milestone 2 adds a durable, visible compaction pass on top of Milestone 1's
transient recency pruning (Layer 2, above). Where Layer 1/2 rewrite individual
tool-result projections without ever touching Mastra message content,
Milestone 2 introduces a durable **compaction summary message** and a
**message-range overlay** that excludes already-summarized raw messages from
the provider prompt — while leaving every raw message physically unchanged in
`mastra_messages` and fully visible in thread history/scrollback.

- **Trigger:** before each request, the previous run's durable prompt baseline
  (`systemInstructionsTokens + taskListTokens + toolDefinitionsTokens`) is
  added to the current conversation-message estimate and checked against 90%
  of the same `deriveEffectiveInputBudget` denominator the context-usage meter
  (BST-940) uses. Milestone 1's recency
  pruning runs first (it already fires at its own trigger points); compaction
  only proceeds if usage is STILL ≥ 90% of the effective input budget after
  pruning has had a chance to reclaim. Target is ~70% of the same budget. Both
  percentages are computed against the identical
  `agentLoopSettings.inputTokenLimit` denominator the meter uses, so a
  90%-trigger accounts for the same prompt categories the streaming ring adds.
  No previous calibration row, or a failed lookup, uses baseline 0 with an
  observable debug log and therefore preserves the pre-091 first-turn
  behavior. A baseline already at/above the 70% target warns and no-ops the
  agentic path for that turn to avoid repeated pruning toward an unreachable
  target; deterministic provider-overflow recovery remains available.
  BST-1707 made the denominator claim above TRUE in code:
  `resolveCompactionInputBudget` (apps/desktop/src/assistant-server/conversation-compaction.ts)
  now RETURNS `runtimeData.agentLoop.inputTokenLimit` whenever the run carries
  one, instead of re-deriving a second budget from the catalog's hard
  `maxOutputTokens`. The two disagreed wherever the request path reserves less
  output than the model's maximum — OpenRouter caps its reservation at
  `OPENROUTER_CODING_MAX_OUTPUT_TOKENS` (32,000), so 49 of 57 OpenRouter rows
  compacted against a budget SMALLER than the run's (`meta/muse-spark-1.3`:
  52,429 vs the run's 964,147), and `moonshotai/kimi-k3`
  (contextWindow === maxOutputTokens) made the derivation THROW — swallowed by
  `runConversationCompactionBeforeStream`, so that recommended coding model
  silently got no pre-request compaction at all. Never re-derive a second
  budget here: one derivation, three consumers. The catalog derivation stays
  ONLY as the fallback for runs that carry no `agentLoop`; a PRESENT but
  unusable `inputTokenLimit` throws rather than quietly resolving to a
  different number (the desktop assistant HTTP path does not sanitize
  `agentLoop`). Paired test:
  `apps/desktop/src/__tests__/assistant-server/conversation-compaction-input-budget.test.ts`.
- **Persistence — no new enum, a metadata marker (matches the
  `approval-action-message.ts` precedent):** the summary is an ordinary
  `role: 'assistant'` Mastra message whose `metadata.custom` carries a
  well-known key (`brainstrikeCompactionSummary`), validated by a strict guard
  mirroring `ACTION_MARKER_GUARD_BY_KEY`. The payload records `{ rewriteId,
  fallbackKind: 'agentic' | 'deterministic', firstCompactedMessageId,
  lastCompactedMessageId, droppedSummaryLine?, createdAt }`. Migration 088 adds
  `brainstrike_assistant_compaction_ranges` (FK-less, thread-scoped, mirrors
  084/087's shape): `compaction_message_id` PK, `thread_id`,
  `compacted_message_ids jsonb`, `kind CHECK IN ('agentic','deterministic')`,
  `created_at`. The exact ordered ID set is stored because persisted message
  IDs are opaque client-supplied strings or UUIDv4 values, not sortable range
  keys. Registered in BOTH migration runners (numbered `index.ts` + drizzle
  `customMigrations` in `migrate.ts`) — the renderer-lazy bootstrap SQL this
  originally also had to mirror was retired by BST-1651, so migrations are now
  the only registration — plus `THREAD_DELETE_SIDECAR_TABLES` and the
  factory-reset registry (thread-scoped, FK-less state must be wired into both
  per `docs/agents/database.md` / `platform-contracts.md`).
- **Message-list exclusion, not deletion — extends the Layer 1/2 overlay
  pattern instead of building a parallel mechanism:** a new
  `CompactionOverlayProcessor` implements `Processor.processInputStep`, where
  Mastra still exposes the current ID-bearing `MastraDBMessage[]`. It is wired
  into the SAME per-call `inputProcessors` pipeline adjacent to
  `ToolProjectionRewriteProcessor`. Hook-kind ordering is fixed by Mastra:
  compaction's `processInputStep` runs upstream of prompt conversion and Layer
  1/2's `processLLMRequest`, so Layer 1/2 rewrites only whatever messages
  compaction left standing. For the thread's active compaction rows,
  it excises current messages whose IDs occur in `compacted_message_ids` —
  except protected-set messages from that exact set (skill activations,
  plan/submitPlan tool-call messages, pinned messages, prior compaction
  summaries, hook-injected system context adjacent to the current user turn),
  which are never excised. Protection is closed to a fixed point over shared
  tool-call ids, so a call and its result can never straddle the compaction
  boundary even when one message carries parts for multiple calls. The summary message itself is already
  in the message list as an ordinary message and supplies the condensed
  content; raw `mastra_messages` rows are never mutated or deleted.
- **Rewind interplay — the load-bearing design decision, settled by directly
  extending Layer 1's existing "rewind self-heals without undo state" rule to
  message-granularity:** `CompactionOverlayProcessor` treats a compaction row as
  active ONLY IF its `compaction_message_id` is still present (not tombstoned)
  in the current, already-tombstone-filtered `args.messages` — exactly how Layer
  1 gates a supersession row on the superseding tool-call id's presence.
  Consequences, with no additional coupling code anywhere in the
  tombstone/rewind machinery itself:
  - **Rewind to a point at or after the summary message:** the summary stays
    live (not tombstoned); the compacted range stays excised. No change in
    behavior.
  - **Rewind to a point before the summary message** (whether the target is the
    raw-message boundary, a message strictly inside the compacted range, or
    earlier still): the tombstone suffix-hide already hides the summary message
    along with everything chronologically after the rewind target, by Mastra's
    existing five rewind-aware read paths. The compaction row's
    `compaction_message_id` is therefore no longer present in the
    tombstone-filtered message list, so `CompactionOverlayProcessor` treats the
    whole compaction as inactive and stops excising — the raw messages in the
    (never-touched) compacted range flow through untouched, exactly as if
    compaction had never run. This is "free" self-healing: no resurrection
    logic, no special-cased branch in `finalizeThreadRewinds`/the anti-join,
    because the raw content was never destroyed in the first place.
  - **Redo (un-rewind) before finalize:** since the summary message is a normal
    tombstoned row like any other, redo un-hides it through the same `rewind_id`
    batch mechanism Layer 1 already relies on — no special case.
  - **Finalize (`finalizeThreadRewinds` hard-deletes on the next user
    message):** if a compaction summary is among the hard-deleted rows, its
    `brainstrike_assistant_compaction_ranges` row becomes orphaned (FK-less, so
    no cascade). `CompactionOverlayProcessor`'s active-row lookup already
    re-derives liveness from message presence every request, so an orphaned row
    is simply inert forever after — matching the "rebuildable transient
    overlay" ruling Layer 2's migration 087 `down` already established for
    prune rows. No cleanup job is required for correctness (it may be added
    later as pure housekeeping, out of scope here).
- **Reload/hydration:** the summary message hydrates through the existing
  80-row windowing path in `assistant-memory-repository.ts` like any other
  assistant row — no special-case hydration logic. Its producer also writes a
  `brainstrike_assistant_message_parents` row with `parent_id = NULL`, so it
  starts a new topology group instead of merging into the preceding assistant
  turn on reload. The renderer recognizes
  `metadata.custom.brainstrikeCompactionSummary` and renders a labeled
  divider/card (not a chat bubble), following the `approval-action-message.ts`
  render-seam precedent, so raw pre-compaction turns remain visible on
  scrollback while the model-facing prompt excludes them.
- **Agentic summary generation:** runs on the thread's current chat provider;
  its cost is metered through the normal provider-usage path
  (provider-reported usage only — no new accounting authority). The
  summarizer's OWN input is built by walking the already-processed prompt (post
  Layer-1/2 rewrite, i.e., PROJECTED tool-result text), never raw
  `mastra_messages` content, so a summarizer call can never re-inflate the very
  budget it exists to shrink. Output follows the fixed section schema Goal /
  State / Decisions / Next / Files touched.
- **Deterministic fallback:** triggers off the PR #2244 local-vs-provider
  classification (`mastra_agent_stream_provider_error` carrying an
  OpenRouter-canonical token-limit / context-length-exceeded signal, or
  equivalent providers' overflow errors) — never off a second LLM call. It
  commits the identical message+overlay shape with `fallbackKind:
  'deterministic'`, marker-based truncation of the oldest eligible turns, and
  an honest one-line index of what was dropped (counts/date-range, not a
  synthesized narrative) so the message body itself states plainly that no
  summarization model ran.
- **Guard/dedup reset:** a committed compaction batch (agentic or
  deterministic) calls
  `resetToolCallLoopGuards(readStateScope(runtimeData))` and
  `resetFileReadState`, identical to Layer 1/2's commit path, since a compaction
  batch collapses evidence a loop guard or read-dedup stub may still be
  pointing at.

### Trigger and prune-first mechanics (BST-1200 M2, chunk 2)

`initializeAgentStream` runs the compaction capability after the
`UserPromptSubmit` gate has proceeded and before `resolveInitialAgentStream`
constructs the real user turn. The denominator is resolved for the selected
provider/model from the static catalog as
`deriveEffectiveInputBudget(contextWindow, maxOutputTokens)`; a runtime-
discovered model may use only the already-resolved positive
`agentLoop.inputTokenLimit`, never a guessed window. The numerator walks the
current tombstone-filtered durable messages plus request messages not yet
persisted and applies active compaction ranges with
`filterMessagesByCompactionRanges`. The common-case first threshold estimate
walks those raw messages without materializing the deep projection clone; only
after that estimate reaches 90% does the prune-first path load Layer 1/2
rewrites, project the messages, and recompute provider-visible usage. The
counter includes text, reasoning, tool arguments/results, bounded attachment
markers, and legacy flattened string content. This server-side persisted-message
walker is a second implementation of the BST-940 renderer heuristic because
the renderer walker depends on assistant-ui message utilities; it should move
to a shared dialect-aware package if those message shapes converge.

Below `previousPromptBaseline + messageTokens < 0.90 * effectiveInputBudget`
the trigger is a strict no-op: no recency scan or write. At or above it,
desktop calls the extracted
`runRecencyPruneScan({ threadId, runtimeData })`, then re-reads both rewrite
overlays and messages and recomputes provider-visible usage. If pruning brought
usage below 90% after the same baseline is added, the turn proceeds. Otherwise
compaction commits candidates outside `selectProtectedMessageIds` and aims to
leave message-side usage at
`max(1024, 0.70 * effectiveInputBudget - previousPromptBaseline)`; protected
messages can make that target unreachable and are never sacrificed. The fixed
1024-token floor prevents deterministic pruning from erasing useful recent
state merely because baseline prompt content consumes most of a small model's
target.

### Agentic summary call, projection, persistence, and metering

`projectCompactionMessages` is the plain-data counterpart of
`ToolProjectionRewriteProcessor`: prune markers always replace the stored
result, while supersession markers apply only when their superseder remains in
the provider-visible message set. Candidate selection happens after existing
compaction ranges are removed, and the summarizer prompt is serialized from
those already-projected candidates. Neither `toolInvocation.result` nor
`providerMetadata.mastra.modelOutput` can retain a rewritten raw result.

The auxiliary call uses `createMastraAgentRuntime` with the current trusted
provider/model transport but no memory, MCP, tools, personas, permissions,
hooks, task list, or compaction callbacks, then invokes the installed Mastra
`Agent.generate()` once with the fixed Goal / State / Decisions / Next / Files
touched instruction. The first occurrence of all five headers must appear in
order; content may begin on the header line after a colon, and later duplicate
header-shaped prose does not invalidate an otherwise complete summary. A
missing or out-of-order section is a schema failure and causes deterministic
fallback. Provider-reported `totalUsage` is required. Its
`AssistantChildRunUsage` is emitted as a `child-run-usage` chunk with
`source: 'compaction-summary'`, passes through
`persistDesktopChildRunUsage`, and is inserted under the parent `runId`.
Migration 090 and the renderer bootstrap widen the `run_kind` CHECK for that
value; estimates never enter this cost-accounting path.

On success, desktop saves an ordinary format-2 assistant Mastra message with
the fixed-section text and `brainstrikeCompactionSummary` payload, records that
message as a new root topology group, then calls `recordCompactionRange` with
the exact ordered candidate ids. Only schema validation failure or a stable
summarizer-side context-overflow code reuses the already-computed
candidate/protected set and commits a deterministic summary-shaped message.
Abort, rate limit, authentication, network, and other unclassified failures
leave history intact and return a no-op so a later turn can retry naturally.
Failures of the whole best-effort pre-request compaction facility do not prevent
construction of the user's real turn — and, since BST-1737, are no longer
invisible when they happen. See the next section.

### SWALLOWED-COMPACTION BREADCRUMB KIND (BST-1737)

`compaction.failed` is an additive `ASSISTANT_RUN_EVENT_KINDS` member recording
that `runConversationCompactionBeforeStream`
(packages/assistant-service/src/stream-init-compaction.ts) caught a throw from
the pre-request pass, so THIS turn reached the provider uncompacted and over
budget. The catch itself is correct and stays: a compaction failure must never
kill the user's turn. What it must not do is degrade in silence — that is the
`AGENTS.md` no-silent-degradation rule, and the silence is what let BST-1707's
live defect (`moonshotai/kimi-k3`'s budget derivation throwing on EVERY turn of
a recommended coding model) survive from `2966627ff` until someone read the
arithmetic.

WHAT CAN STILL REACH THAT CATCH, verified against `runPreRequestCompaction`
after BST-1707 landed (apps/desktop/src/assistant-server/conversation-compaction.ts):

- All three `resolveCompactionInputBudget` throws — missing run provider/model;
  a present-but-unusable `agentLoop.inputTokenLimit` (BST-1707's new throw,
  reachable because the desktop assistant HTTP path does not sanitize
  `agentLoop`; only the IPC tool path's `sanitizeAgentLoop` does); and
  `Unknown compaction input budget for <provider>/<model>.` for a run carrying
  no `agentLoop` whose model is not in the catalog (dynamic ollama/lmstudio,
  raw clients).
- The two trusted-lookup guards: `Conversation compaction requires the trusted
  compaction overlay lookup.` (via `loadMessages`, so on the unprojected AND
  projected loads) and `... the trusted tool projection lookup.` (via
  `loadProjectedState`).
- A `memoryStore.listMessages` rejection inside `loadMessages`, and a
  `runRecencyPruneScan` DB failure.
- Everything on the DETERMINISTIC COMMIT path, which runs outside the agentic
  try/catch on the baseline-dominates branch and again inside the agentic catch
  as the fallback: `Compaction candidate <id> has no valid creation time.`,
  `memoryStore.saveMessages`, `Assistant message <id> has conflicting branch
  topology.`, and `recordCompactionRange` DB errors.

Two entries in BST-1737's own enumeration do NOT survive that reading and are
recorded here so they are not re-added:

- `AgenticCompactionSummarySchemaError` does not reach this catch.
  `isNonRetryableSummarizerFailure` returns true for it, so the pass handles it
  internally and routes to the deterministic fallback; it only reaches the outer
  catch indirectly, if that fallback's commit then throws.
- Prompt-baseline lookup failures do not reach it either. The inner
  `resolvePromptBaselineTokens` wrapper catches them, logs
  `conversation_compaction_baseline_corrupt` /
  `conversation_compaction_baseline_lookup_failed`, and returns zero.
  `usageForSummary`'s "requires the run provider and model" throw is likewise
  unreachable from here: `resolveCompactionInputBudget` already demanded both
  before any summarizer ran.

SURFACE AND SHAPE. Modelled on `mcp.tools.unavailable` (see that section above),
which was filed for the same class of problem. Status is always `'failed'`,
never `'running'` — the pass has already finished, by throwing, when the row is
minted — so it declares no terminal and can never leave a row spinning. Filed
under `NEVER_RUNNING` in `assistant-run-event-pairing-contract.test.ts`; that
guard can force a kind to be CLASSIFIED but cannot check the classification
against the emitter, so `stream-init-compaction.test.ts` asserts the emitted
status directly. Deliberately NOT `run.failed`: the turn is healthy and
completes, and `data-stream-mapper` derives `thread_runs.error` from
`run.failed`, so that spelling would persist a degraded turn as a failed one.

It is in `isAlwaysVisibleRunEvent`, and that membership is LOAD-BEARING for the
reason spelled out on `mcp.tools.unavailable`: run-event rows are hidden unless
background activity / Developer detail is on, so a kind added to the contract
alone would still report nothing to the user it exists for. Nothing else cards
this fact — the user's only other symptom is a later provider context-overflow
error naming an unrelated cause, or quietly degraded output.

ONE KIND, REASON IN THE ROW. There is no `compaction.budget.failed` /
`compaction.schema.failed` taxonomy. The discriminating fact is already written
at each throw site and travels in `detail` and `metadata.reason`; a
hand-maintained classifier would have to be extended for every new throw and
would bucket the next unanticipated one into "other" — re-creating exactly the
defect this kind exists to end. The reason is redacted and length-bounded by
`boundRunEventReason` (`@brainstrike/assistant-contract/run-events`) before it
becomes durable metadata or a rendered row; that helper is BST-1602's
`boundMcpDiscoveryReason`, promoted so the two callers share ONE copy of the
credential-stripping regexes. Promotion WIDENED that helper's input, and the
patterns had to widen with it: BST-1602's only caller was MCP discovery, whose
transports are HTTP, so the userinfo and query patterns were anchored to
`https?://`. Compaction failures reach `memoryStore` reads/writes,
`runRecencyPruneScan`, and `recordCompactionRange`, whose driver errors quote
`postgres://user:pass@host/db` — which both anchored patterns passed straight
through into durable metadata and an always-visible row. They now match any
`scheme://`, pinned by `postgres`/`postgresql`/`redis`/`mongodb+srv` cases in
`run-events.test.ts`; an HTTPS URL merely *named* like a database (the original
`https://user:hunter2@db.test/x?token=sk-live` fixture) does not exercise this
and must not be mistaken for coverage of it. The row does NOT carry the resolved budget: the
failure class where a budget would be most informative is precisely the one
where no budget was ever resolved.

ONCE PER (THREAD, REASON), not per turn. Most of what reaches this catch is
sticky — an unknown model, a malformed `agentLoop`, a missing overlay lookup —
and fails identically on every turn, so an unlatched row would grow one
identical always-visible entry per turn forever, push real content out of the
timeline, and train the user to ignore it. The latch keys on the reason and
never on the thread alone, so it can never hide a DIFFERENT failure; the `warn`
log is NOT latched, so per-turn operator evidence is never lost. The latch is an
in-memory `Set` with no persistence, mirroring
`warnedBaselineExceedsTargetThreadIds` in `conversation-compaction.ts`: a
restart re-arms it. It is keyed on the reason's SHAPE and capped since
BST-1744 — see the next section, which supersedes #3119's "no eviction".

THE KEY IS THE SHAPE OF THE THROW, AND THE SET IS CAPPED (BST-1744; raised by
the Claude review of #3119 and deliberately deferred there). #3119 keyed on the
whole bounded reason, which defeated the latch outright for the two reachable
throws that embed a per-message id — `Compaction candidate <id> has no valid
creation time.` and `Assistant message <id> has conflicting branch topology.` —
and for any driver error quoting a per-row identifier. A new reason every turn
is a new key every turn, so the row was never deduplicated and the `Set` grew
one entry per failing turn. The opposite edge was real too, and reproduced by
the test that now pins it: because the key used the ALREADY-TRUNCATED reason,
two failures agreeing on their first 199 characters collapsed onto one entry and
the first silenced the second.

BOTH HALVES, NOT EITHER ONE. Neither candidate closes this alone, which is why
the ruling took both:

- `compactionFailureKey` digests the SHAPE of the untruncated message — volatile
  tokens masked, then sha256. Shaping alone cannot be proven complete:
  `mastra_messages.id` is free-form `TEXT` (migration 117), so an id in a shape
  the patterns do not recognise still mints a fresh key every turn.
- `MAX_TRACKED_COMPACTION_FAILURES` caps the set at 512 with drop-oldest
  eviction. The cap alone would have bounded memory while leaving the per-turn
  row noise — the timeline noise this latch exists to prevent — fully in place.

THE MASKING IS NOT THE CLASSIFIER THIS KIND REFUSED. ONE KIND, REASON IN THE ROW
(above) rejected a hand-maintained taxonomy because it would need extending for
every new throw and would bucket the next unanticipated one into "other". The
shaping has neither property: there is no registry of known throws, and an
unrecognised throw keys on its own text rather than being bucketed anywhere. Its
failure direction is UNDER-merging — at worst an extra visible row — never
over-merging across distinct throws, which would be a silence. The row still
renders the FULL unnormalized reason, id included: normalization is KEY-ONLY.
State the limit of that precisely, because #3138's first draft overstated it:
the user keeps the id of the FIRST message wedged in a given shape. A second
message wedged the same way deduplicates against it and never reaches a row, so
its id survives only in the unlatched `warn`. That is the deliberate price of
not minting a row per turn, not an oversight.

TWO VOLATILE TOKEN CLASSES, BOTH EVIDENCE-BACKED: canonical UUIDs (both
id-bearing throws take theirs from `randomUUID`) and ISO-8601 timestamps (the
compaction fixture in `run-events.test.ts` quotes a creation time, and a driver
error that does so changes on every turn). SHORT DIGIT RUNS ARE DELIBERATELY NOT
VOLATILE: `ollama/llama3.2` and `ollama/llama3.3` are DIFFERENT failures, and a
blanket digit mask would let the first permanently silence the second — the one
thing this latch must never do. Do not widen these patterns to chase a residue
the cap already bounds.

THE KEY IS BUILT FROM THE UNTRUNCATED MESSAGE, through `redactRunEventReason` —
`boundRunEventReason` minus the bounding, split out by BST-1744 so there is
still exactly ONE copy of the credential patterns and ONE extraction. #3138's
first pass skipped redaction altogether, reasoning that the key never leaves the
in-memory `Set`; the Claude review of that PR showed the reasoning was aimed at
the wrong target. It is a fair objection to COPYING the patterns and no
objection at all to REUSING them, and redaction is not secrecy here — it is part
of the SHAPE. A message quoting a rotating secret (a provider auth error, a
signed URL, a session id) otherwise mints a fresh key on every rotation: this
ticket's own defect, relocated from ids to credentials, and no less reachable
than the timestamp case. Sharing one extraction also keeps the key describing
the same text the row renders; a second `value instanceof Error ? …` would be
free to drift the moment either side grew a case, and a drifted key merges or
splits rows the user sees differently. Both are pinned — "deduplicates a reason
whose only variable part is a rotating credential" and "keys a non-Error throw
from the same text the row renders".
Hashing is what makes an untruncated key affordable: a fixed-width digest turns
the cap into a real BYTE bound rather than a bare entry count. Length framing is
retained even though a fixed-width digest is already self-delimiting — it costs
nothing, and it keeps the ruling below and its test intact.

DROP-OLDEST, NOT LRU. The dedupe fast path only READS the set, so recency would
have to be written on every suppressed turn, and first-seen order is already
exact because a key the set holds is never re-added. Eviction costs the evicted
failure ONE more visible row if it recurs — a repeat row, never a silence, the
same direction every other ruling on this latch picks. NAME WHO DOES THE
EVICTING: the keys are per-thread but the cap and the eviction order are
process-GLOBAL, so a single thread wedged on an unmasked id is the noisy
neighbour — within 512 such turns it clears every OTHER thread's entry and each
of them re-reports once. That cost is bounded and is a repeat row rather than a
silence, so it is accepted. A per-thread sub-cap was considered and rejected: it
needs its own eviction policy, and it would let one thread's many distinct
failures evict each other, trading a bounded repeat row for a possible silence.
The idempotency guard in
`latchCompactionFailure` is load-bearing rather than a fast path: `markReported`
is documented idempotent, and THE LATCH ARMS ON DELIVERY (below) accepts two
turns committing the same key; at the cap, a commit that added nothing would
otherwise evict an unrelated thread's entry.

Pinned by `stream-init-compaction.test.ts` ("BST-1744: the key is the SHAPE of
the throw, not its literal text"). Every guard is mutation-proven: removing
either masking pattern, widening the masking to all digit runs, keying on the
bounded reason, removing the eviction, and removing the idempotency guard each
fail exactly the intended test and no other.

NO THREAD ID, NO LATCH. `runtime.memory?.threadId` can be absent, and keying
every unidentified turn under one shared bucket would let a single delivered row
permanently silence a DIFFERENT conversation failing the same way — precisely
the invariant the reason-keying exists to protect, broken where the latch knows
least. Such a turn therefore always mints, and its `markReported` is a no-op
(`NEVER_LATCHED`).

THE KEY IS LENGTH-FRAMED, NOT DELIMITED. `<threadId.length>:<threadId><reason>`
is unambiguous for any pair without needing a character that cannot occur in
either. It was a NUL separator until #3119's own Claude review quoted that line
and reproduced the separator as a real NUL character in its review text:
`scripts/claude-review.mjs` publishes the disposition with
`execFileSync('gh', […, '--body', body])`, Node refuses an argv string
containing a NUL, and the review gate went red at two different heads
(`a53612d266`, `9b66bfd7fb`) with the review itself complete and validated —
"Publication failed: The argument 'args[6]' must be a string without null
bytes." `lint:no-raw-nul-bytes` does not catch this: the source held the ESCAPE,
which is legal, and the raw byte only appeared two systems downstream. A key
that never leaves an in-memory `Set` must not carry a byte the rest of the
toolchain cannot transport, and the comment on it names the byte rather than
spelling the escape for the same reason. The framing is pinned by a test whose
thread ids and reasons concatenate identically ("keeps a thread/reason boundary
that bare concatenation would collapse").

THE LATCH ARMS ON DELIVERY, NEVER ON MINT (Codex review of #3119). Minting
happens while the outcome is still being CONSTRUCTED — `initializeAgentStream`
then awaits `resolveInitialAgentStream` and only afterwards wraps the prelude.
Adding the key at mint time meant a rejection in that await, or a returned
stream nobody consumes, produced a row that reached neither `observe()` nor
persistence while every later turn with the same thread and reason stayed
silent for the life of the process — this ticket's own defect, reborn inside its
fix, and invisible. So `compactionFailureChunk` READS the key and returns the
chunk bound to a `markReported` commit; `prependStreamChunks` calls it after the
consumer has taken the chunk and come back for the next one. The pairing is one
value (`PreRequestCompactionFailureBreadcrumb`), not two sibling fields, so the
row cannot be emitted without arming the latch nor the latch armed without
emitting the row. The accepted cost: two turns that fail identically before
either prelude is consumed both mint a row, which is honest — both turns really
were sent uncompacted — and is the only direction that cannot suppress a row
nobody ever saw. Delivery is NOT proof of persistence or of rendering: a wrapper
further out could still drop the chunk, and the latch would arm anyway. It
closes by far the widest part of that window, and what remains costs one
thread's repeated row rather than a permanent process-wide silence — do not read
"delivered" here as "durable". Pinned by `stream-init-compaction.test.ts` ("does NOT latch a
breadcrumb the stream never delivered", "leaves the latch UNcommitted for a
stream that is never consumed"), and the once-per-(thread, reason) test now has
to deliver the first row before the second turn is deduplicated against it.

A CANCELLED TURN MINTS NOTHING. When `input.signal.aborted`, the warn still
fires but no row is minted and the latch is untouched: `run.cancelled` already
reports a cancelled turn, and a "compaction unavailable" row would be a false
alarm on every cancellation landing mid-pass.

EMISSION PATH. The breadcrumb rides the SAME stream prelude the compaction
summary's `child-run-usage` chunk already rides
(`withCompactionPreludeChunks`, failure chunk first), so it reaches the
`observe()` wrapper — and therefore run-event persistence and the timeline —
through the ordinary run-event chunk path, with no second seam to keep in sync.

### Context-overflow recovery scope

The live Mastra `'error'` part checks only the stable
`context_length_exceeded`, `max_tokens_exceeded`, and
`token_limit_exceeded` codes. Before `makeProviderErrorTermination`, it awaits
the desktop recovery callback, which makes no model call, drops the oldest
eligible provider-visible messages until the 70% target is met (or all
eligible messages are exhausted), saves the deterministic summary message,
and commits `recordCompactionRange(kind: 'deterministic')`. Its visible text
and `droppedSummaryLine` are the same literal count/date-range index and state
that no summarization model ran. The terminal error then tells the user that
deterministic compaction was applied and to resend or continue.

Milestone 2 does **not** retry the same turn automatically. There is no outer
retry owner above `streamMastraAgent` / `createStreamIteratorFromRuntime`; a
safe implementation needs a separate bounded wrapper that cannot overlap
Mastra's `StreamErrorRetryProcessor`, cannot loop on deterministic overflow,
and leaves every non-overflow error terminal. Until that architecture is
implemented, recovery creates headroom only for the next request.

The renderer seam closes in `packages/assistant-ui/src/assistant-ui-panel.tsx`:
`AssistantMessage` recognizes the strict durable marker before its ordinary
bubble path and mounts `CompactionSummaryCard` from
`compaction-summary-card.tsx`. Desktop coverage lives in
`apps/desktop/e2e/assistant-compaction.desktop.test.ts`; its fixed format-2
history fixture verifies both the visible divider and a normal follow-up turn
in the same thread.

## CANVAS DOCUMENT VERSIONS (BST-1173)

Persisted Canvas HTML is application-owned, local-first state in
`brainstrike_canvas_versions` (migration 082 in BOTH runners, sole author since
BST-1651 retired the bootstrap mirror). Rows sharing `canvas_id` form one
document and the greatest integer `version` is current. Row ids and canvas ids
are app-side uuidv7 values; timestamps are read as `created_at::text`; and
`created_by` is CHECK-constrained to `assistant | user` and validated again on
repository reads. There are no foreign keys because the numbered runner uses a
bare schema.

`THREAD_DELETE_SIDECAR_TABLES` owns Canvas cleanup for all three thread-delete
implementations, while the reset registry owns all three table-enumerating
clear paths. The desktop repository creates version 1, reads/list latest rows,
and writes a new version for every update or rewrite. Exact updates require
`oldString` to occur once: zero and multiple matches return `no_match` and
`ambiguous_match` structured failures, respectively; missing canvases return
`not_found`. Stored-vocabulary drift throws visibly as corruption.

`brainstrike.manageCanvas` exposes `create`, `update`, `rewrite`, and `list` to
the assistant. Runtime thread/resource identity is mandatory and missing
identity returns a structured failure. This slice intentionally adds no Canvas
tab or other Canvas UI.

Paired tests: `migration-082-canvas-documents.test.ts`,
`canvas-repository.test.ts`, `manage-canvas-tool.test.ts`, the Canvas sidecar
case in `assistant-memory-repository.integration.test.ts`, and the reset
registry/clear sentinels.

## TOOL-CALL TOKEN TELEMETRY (BST-1190)

`brainstrike_tool_call_telemetry` (migration 083 in BOTH runners) stores one
row per observed final model projection. The model-output observer accumulates
tool id, actual serialized model-facing characters, generic/typed truncation,
and search-only zero-match/pagination booleans; a run-end internal stream chunk
hands those samples to the desktop main-process persistence capability. The
writer derives `thread_id` from the renderer-created run row with
`INSERT ... SELECT`, warns without failing the turn on a missing run or write
failure, and never accepts raw input/output fields. The renderer lazy-bootstrap
mirrors migration 083 byte-for-byte because its thread-delete CTE references
every registered sidecar unconditionally, even though it never writes rows.

Subagent/persona-delegated tool calls attribute to this same table under the
PARENT run's `run_id`/`thread_id` (BST-1196): `agent-runtime.ts` projects the
child tool map through the SAME `RunTokenDiagnostics` INSTANCE as the primary
tool map, but via a distinct telemetry-only method,
`recordSubagentToolOutput` (`token-measurement.ts`), NOT the primary map's
`recordModelOutput`. The two intentionally diverge: `recordModelOutput` also
feeds the run's `#projection` aggregate (`modelVisibleProjection*` in
`toLogFields`), which reconciles against `promptTokensSummedAcrossSteps`
(logged name; the lifecycle field is `providerReportedPromptTokens`, the
per-leg SUM across steps — spend, not a single request's context size, which
is `latestStepPromptTokens`; the 2026-08-23 "context explosion" was this sum
misread as one request). A subagent tool output never
enters the parent's prompt (only the delegation's final result does), so
routing it through `recordModelOutput` would inflate that aggregate for every
delegating run without a matching change in the prompt sum.
`recordSubagentToolOutput` pushes only the `ToolCallTelemetrySample`, leaving
`#projection` untouched. Both methods feed the SAME `#toolCallTelemetry`
array, so samples from either path ride the existing run-end
`tool-call-telemetry` drain with no new `StreamChunk` type or schema change.
The table currently has NO origin discriminator beyond each sample's
`toolId`; a per-persona/per-origin breakdown would require a migration and
remains deliberate future work, not implemented.

Measurement-fidelity caveat: the persona/subagent tool map is built from
`guardedTools` (pre-`settleRuntimeToolOutputs`), while the primary tool map is
built from `artifactSettledTools` (post-settlement) — see
`runtime-assembly/tool-pipeline.ts`. When a `runId` is present (desktop,
`stream-init.ts`), a parent call of a large-result tool like
`brainstrike.grepSearch` is measured against its settled, durable-artifact
page, while a CHILD call of the same tool on a comparably large result is
measured against the unsettled inline projection (bounded by
`MAX_MODEL_TOOL_RESULT_CHAR_BUDGET`). Both land in
`brainstrike_tool_call_telemetry` keyed only by `tool_id`, so the shipped
`token-spend-by-tool` lens's `avg_model_facing_chars` and
`truncation_hit_rate` blend settled and unsettled samples for that tool with
no way to separate them. This is a caveat on top of (not a substitute for)
the missing origin discriminator above.

The table is FK-less because numbered migrations cannot depend on lazy Mastra
parents. `THREAD_DELETE_SIDECAR_TABLES` removes thread rows; the reset registry
owns all three table-enumerating reset paths. The shipped
`token-spend-by-tool` lens aggregates calls, characters, truncation, zero-match,
and the deliberate follow-up/first-page proxy without storing a search-session
correlation key.

## TOKEN-ESTIMATE CALIBRATION PAIRS (BST-1205)

`brainstrike_token_estimate_calibration` (migration 086 plus additive migrations
089 and 091 in BOTH runners)
stores one attributable run-end pair: the chars/4 estimate measured by
`RunTokenDiagnostics` and `final_step_prompt_tokens`, the single most recent
step's prompt-token count. The internal `token-estimate-calibration` stream
chunk is consumed by the desktop main-process persistence wrapper and never
reaches the renderer. The writer uses `INSERT ... SELECT` through
`brainstrike_assistant_thread_runs` to derive `thread_id` from `run_id`, warns
without failing the assistant turn on a missing run or failed write, and stores
only ids, token counts, model/provider strings, and a timestamp. Migration 089
adds nullable positive `resolved_domain_budget_tokens` and
`resolved_transport_budget_tokens`: new runtime-produced samples populate both,
while historical rows remain NULL rather than receiving a guessed tier.
Migration 091 adds nullable positive `prompt_baseline_tokens`, the same run's
system-instructions + task-list + tool-definition total used by the next turn's
baseline-aware compaction trigger. Historical rows and continuation chunks
without a prompt breakdown remain NULL rather than receiving a guessed value.

The numerator is `modelVisibleProjectionBackstopTokens +
(toolDefinitionBackstopTokens ?? 0)`: chars/4 over model-visible tool-output
projections plus tool definitions, each counted once. The denominator is the
latest step's prompt count, which already contains every prior tool output once
via Mastra's resend behavior—not the cross-step accumulated billing total. Both
figures are comparable over the same final-prompt-content basis;
conversation/system-prompt text outside tool outputs and definitions is excluded
from both. Only completed runs with at least one measured tool output persist.
The ratio remains reconciliation evidence, not permission to tune
`APPROX_CHARS_PER_TOKEN`.

The table is FK-less because numbered migrations cannot depend on the lazy
assistant parents. The repository's thread-delete CTE references every sidecar
unconditionally, which is why the table is part of the schema PROBE (BST-1651);
`THREAD_DELETE_SIDECAR_TABLES` removes thread-owned rows, and the reset registry
owns all table-enumerating fresh-start paths. Scheduled database maintenance
prunes rows after 60 days on both idle and active-queue passes, using the
occurred-at-leading index created in migration 086; the idle pass also runs
`VACUUM (ANALYZE)` for the table.

The checked-in `estimator-calibration.sql` lens groups an inclusive time window
by model and both resolved budget-token columns, then returns sample count plus
min/median/max/average estimate-to-final-step ratios. NULL groups expose legacy
pre-089 samples honestly. It excludes zero estimates defensively and counts only positive
denominators, matching runs that actually exercised the estimator. Paired
proofs are the emission cases in `packages/agent/src/__tests__/mastra-streaming.spec.ts`,
the real-PGlite desktop persistence integration test, the migration/reset and
scheduled-maintenance tests in `packages/db/__tests__`, and
`search-lens-estimator-calibration.test.ts`, which parses and executes the
checked-in lens rather than an inlined copy.

## TASK LEDGER (RUN OUTCOMES + LEDGER READ MODEL)

Per-run cost/outcome analytics over tables the assistant already writes.

- **Experiment treatments (BST-1250, recursive self-improvement phase 2A):**
  `brainstrike_assistant_run_treatments` (migration 093, sole author since
  BST-1651 retired the bootstrap mirror; no FKs; retained on
  thread delete like run_outcomes, cleared on factory reset via the db reset
  registry; sole index is `(created_at)` — the lens's only predicate). One
  row per hosted run, `run_id` PK. Normal legs record DETACHED (`void`) from
  the injector seam (`self-improvement-signal-context.ts`) — the ONE place
  that knows whether BST-1241 injection actually happened and its exact text
  (`signal_content_hash` = SHA-256; null when nothing injected); the write
  never blocks prompt assembly, and the recorder logs its own failures.
  Approval/resume continuation legs mint their own runId but return BEFORE
  the injectors, so `stream-init` fires the optional
  `runPersistence.recordContinuationRunTreatment` capability for them —
  without it those legs carry outcome labels with no treatment row, a
  systematically biased gap. `injection_status`
  (`injected | preference_off | no_waste | query_failed | continuation`)
  keeps the non-injection reasons apart: an ENROLLED run whose signal query
  failed is NOT control evidence; `signal_injected` is derived and
  CHECK-pinned to `status = 'injected'`. `experiment_id`/`variant` come from
  the strictly-parsed renderer `experimentAssignment` (both fields required
  on the wire; malformed → warn + un-enrolled, never coerced) and stay NULL
  when un-enrolled. The renderer producer (BST-1251, phase 2B) is the
  experiment-assignment preference store + settings section; it attaches the
  pair only when both fields are set, so a half-filled preference stays
  un-enrolled instead of tripping the strict parse.
  `ON CONFLICT (run_id) DO NOTHING` — the first treatment wins. Do NOT infer
  treatment from date windows or the current preference value — this record
  exists because both are unsound. Queryable via the
  `experiment-outcome-correlation` lens (groups by injection_status; LEFT
  JOINs outcomes so unlabeled runs stay visible). Paired tests:
  `self-improvement-signal-context.test.ts` ("run treatment recording"),
  `run-treatment-persistence.integration.test.ts`,
  `search-lens-experiment-outcome-correlation.test.ts`.

- **Outcome labels:** `brainstrike_assistant_run_outcomes` (migration 062, sole
  author since BST-1651 retired the bootstrap mirror; no FKs, purged
  on factory reset via db-ipc `OptionalRelationTable`). At most ONE label per
  run (`verdict` succeeded/failed/mixed, upserted on run_id) with provenance
  `source` (`user` | `edit_revert` | `hook`) and bounded `detail` (2000 chars,
  oversized THROWS — never silently truncated). Writer: `recordRunOutcome`
  (app-shell repository). A later user verdict deliberately replaces a derived
  `edit_revert` or `hook` label. `edit_revert` labels are derived in
  `use-edit-checkpoints.ts` after a successful revert (see
  workspace-context.md § Edit Checkpoint Journal). `hook` labels come from the
  Stop-hook run-verdict protocol (a Stop hook prints one strict
  `{"brainstrikeRunVerdict":…}` JSON line; see assistant-runtime.md
  § TOOL-LIFECYCLE HOOKS), recorded MAIN-PROCESS-side by
  `recordDesktopAssistantHookRunOutcome` (apps/desktop assistant-server/run-persistence.ts) —
  an upsert byte-consistent with `recordRunOutcome` (documented duplication,
  same precedent as the bootstrap SQL) that derives thread/resource ids from
  the runs row and carries the SQL precedence guard `source <> 'user'`: a hook
  label never overwrites an explicit user verdict (both writers enforce it —
  the repository applies the same guard for `source: 'hook'`), while a later
  user verdict still upserts over a hook label. The write is awaited in front
  of the stream's `message-finish` yield so a finishing run cannot lose it to
  terminal bookkeeping.
- **User verdicts (👍/👎):** `RunVerdictControl` (packages/ui
  `run-verdict-control.tsx`) mounts on every assistant message and renders once
  per run — on the message leg carrying the terminal `run.finished` run-event
  data part (works for edit-less runs; `run.failed` legs are deliberately
  excluded in v1, and web local-runtime events without a runId are skipped).
  The capability seam is `RunVerdictProvider`/`useRunVerdictContext`
  (`run-verdict-context.tsx`) — PARALLEL to EditCheckpointContext by design:
  verdicts gate on the repository's optional `recordRunOutcome` (present
  wherever the PGlite repo exists, including web), not the desktop checkpoint
  bridge. App-shell binds it via `useRunVerdictBinding`
  (`hooks/use-run-verdict.ts`, source `'user'`, upserts over derived labels);
  a rejected save shows a visible retry, never a silent drop. Write-only in
  v1 (no read-back of a stored label after reload — the ledger remains the
  authoritative view). The wrapper line-budget bump and the panel
  owned-module assertions live in `assistant-contract-boundary.test.ts` and
  `assistant-ui-panel-architecture.test.ts`.
- **Ledger read model:** `getRunLedger(resourceId, {limitLatest})` aggregates
  each `thread_runs` row with SUM'd run_usage tokens + exact billed cost
  (absent — never a fabricated 0 — when unreported), top-level
  `tool.completed`/`tool.failed` counts (subagent.tool.* excluded in v1),
  edit-checkpoint totals + reverted counts, computed `durationMs`, and the
  outcome label. `RUN_LEDGER_AGGREGATION_SQL` + `mapRunLedgerRow` are the
  exported single source of truth (same convention as
  `CROSS_ROOT_USAGE_AGGREGATION_SQL`); the strict mapper THROWS on malformed
  aggregates. Both are optional on `AssistantThreadRepository` (read-only/test
  repositories) and required on `BulkAssistantThreadRepository`.

- **Ledger panel:** the Task Ledger renders inside the existing **Cost
  Tracking settings category** (`createCostTrackingSettingsCategory` in
  `packages/app-shell/src/cost-tracking/index.tsx`, consumed by both apps'
  settings page-content), stacked below `CostAggregationPanel`. Data is
  renderer-direct (Path A): `use-run-ledger.ts` is a PGlite live query over the
  shared `RUN_LEDGER_AGGREGATION_SQL` + `mapRunLedgerRow` pair (limit 50), and
  `use-ledger-analytics.ts` fetches `getLedgerCostTrend` (day bucket) +
  `getModelComparison` with a manual refresh. Both gate on
  `hasDurableAssistantUsageCapability()` exactly like the sibling cost panel
  (web renders an honest session-only state). Honest-cost rules: exact
  provider-reported cost renders as-is; a registry-priced remainder is marked
  "est."; unpriced models read "cost unavailable" and zero-usage runs read
  "no usage recorded" — NEVER a fabricated $0; malformed aggregates and query
  failures surface as a visible error state with retry, never an
  empty-but-fine panel.

- **Budget guardrails (v1):** user-set spend caps over the ledger's own data.
  State ownership: the caps (`dailyCapUsd`, `perRunCapUsd`, both null = off by
  default) are persisted in
  `packages/app-state/src/stores/assistant-budget-preferences-store.ts`
  (STRICT set validation — finite > 0 or null, else THROW; factory-reset via
  `resetAssistantBudgetPreferencesStoreToDefaults`), edited in the Cost
  Tracking settings category (`budget-settings-panel.tsx`, blank = off,
  invalid input shows a visible validation message — never coerced). Spend is
  derived, never stored: `DAILY_SPEND_AGGREGATION_SQL` (+ strict
  `mapDailySpendUsageRow` / pure `resolveDailySpendSummary` in
  `cost-tracking/daily-spend.ts`, live-queried by `use-daily-spend.ts` under
  the durable-usage capability gate) sums run_usage over a ROLLING
  `created_at >= NOW() - INTERVAL '24 hours'` window — deliberately
  timezone-free, so ALL UI copy says "last 24h", never "today"; it binds each
  SQL param exactly once (PGlite live format() constraint, see
  RUN_LEDGER_AGGREGATION_SQL). Honesty: exact billed cost + registry-priced
  remainder; unpriced-model tokens are EXCLUDED from the total and surfaced as
  an explicit "+N unpriced" marker — never a fabricated price. App-shell binds
  cap + spend (`hooks/use-budget-guardrail.ts`) into the packages/ui context
  seam (`budget-guardrail-context.tsx`, provider mounted in the wrapper beside
  RunVerdictProvider); the composer chip/notice/gate live in
  `budget-guardrail-control.tsx`. Over-cap rules — no silent block, no silent
  allow: while `overCap && !overridden`, BOTH send paths (composer input+Send,
  edit-composer resend) are disabled and a visible notice states "Last-24h
  budget cap reached — $X of $Y" with an explicit "Send anyway" session
  override; an active override is stated next to the chip; Stop/Cancel is
  never gated. If the spend query fails the guardrail deactivates (null
  binding) and the failure is logged as an error — v1 deliberately fails open
  because blocking on a broken analytics query would be a silent block with no
  honest number to show. `perRunCapUsd` is DISPLAY-ONLY: the ledger panel
  badges runs whose exact-or-priced cost exceeds it (`isRunOverCap`; unpriced
  or zero-usage runs are never flagged on a fabricated number).

When changing this flow, update this section and the paired tests
(`packages/db/__tests__/migration-062-assistant-run-outcomes.test.ts`,
`packages/assistant-data/src/__tests__/run-ledger-row.test.ts`, the run-outcome and
run-ledger cases in `assistant-memory-repository.integration.test.ts`
(including the hook-over-user precedence case), the
outcome-labeling suite in `use-edit-checkpoints.test.ts`, the hook-verdict
suites in `apps/desktop/src/__tests__/assistant-server/`
(`hooks/run-verdict.test.ts`, the verdict cases in
`hooks/server-composition.integration.test.ts`,
`hook-run-outcome.integration.test.ts`), the panel suites
in `packages/app-shell/src/cost-tracking/__tests__/` — `task-ledger-panel`,
`use-run-ledger`, `use-ledger-analytics`, and the budget-guardrail suites:
`daily-spend` / `use-daily-spend` / `budget-settings-panel` there,
`use-budget-guardrail` + `daily-spend.integration` in
`packages/app-shell/src/__tests__/`, `budget-guardrail-control` in
`packages/ui/src/__tests__/`, and `assistant-budget-preferences-store` +
`factory-reset-assistant-budget-preferences` in
`packages/app-state/src/__tests__/`).

---


## THREAD GROUPS (FOLDERS) IN THE THREADS PANEL

User-defined groups organize the Threads panel: rank-ordered group sections, an
**Ungrouped** section always last, drag-and-drop (Pragmatic drag and drop), and
a Group by / Sort by view-options popover. Plan/rationale:
`docs/thread-groups-plan-2026-07-12.md`.

Where state lives (do not relitigate):
- Groups: `brainstrike_assistant_thread_groups`; thread membership + manual
  order: `brainstrike_assistant_thread_placements` (migration 054; migration
  056 adds nullable validated folder `color` and independent `flat_rank`, seeded
  from the legacy `rank` so existing custom order survives the split; both are
  registered in both migration runners). Membership deliberately does NOT
  live in `mastra_threads.metadata`: grouping, folder color, and manual order
  are Brainstrike-owned presentation state while Mastra owns that schema.
- Thread icon/color metadata updates preserve conversational `updatedAt`; visual
  curation must never reshuffle a recency-sorted collection.
- Placements have no FK to `mastra_threads`: a placement whose thread is gone is
  inert (the panel joins by id). Bulk thread deletion removes placements and all
  owned thread rows in one guarded CTE; an unknown id mutates nothing. Deleting
  a group nulls its placements' `group_id` and removes the group in one CTE after
  staged UI confirmation, returning its threads to Ungrouped without partial
  state or discarding their independent flat-list ranks; the loaded store mirrors
  that transition by retaining each placement with `groupId: null`.
- `rank` columns are `fractional-indexing` keys (`generateKeyBetween`); a
  positional drop rewrites the destination section's ranks wholesale
  (`applyThreadOrder` → `setThreadPlacements`, a SINGLE multi-row upsert so the
  batch is atomic without the optional `DbHandle.transaction`; `reorderGroups` →
  `setGroupRanks` likewise) and silently switches Sort by → Custom so the drag
  is honored, never ignored. In Custom sort, unranked (new) threads render first
  by recency.
- View prefs (`groupBy`, independent `flatSortBy` / `groupedSortBy` /
  `folderSortBy`, collapsed) persist via zustand `persist`
  (`brainstrike-assistant-thread-groups-v1`, state version 3); the store
  registers a session resetter in `register-factory-reset-session-stores.ts`.
  `threadFilters` (needs-you / running / unseen) lives in the SAME store but is
  session-only: it is deliberately excluded from `partialize` and cleared by
  `reset()`. A malformed persisted blob still throws
  (`requirePersistedGroupBy` / `requirePersistedSort` /
  `requirePersistedFolderSort`) rather than being coerced.
- `groupBy: 'folder'` (BST-1403) groups threads by the folder they work in: the
  thread's primary root, `metadata.operatingRootId` (a durable `roots.id`;
  `operatingRootDisplayName`/`operatingRootPath` are display-only and never an
  identity). This is NOT a custom group — `buildThreadListSections` returns a
  `{ kind: 'folders' }` view whose sections carry a `ThreadListSectionHeader`
  discriminated union (`group` | `folder` | `unassigned`) and a `section.id`
  (`group.id`, `folder:${rootId}`, `folder-unassigned` — the sentinel is
  HYPHENATED on purpose, so it can never collide with a `folder:` id built from
  a root whose id is literally `unassigned`). Folder display rows are supplied
  BY THE CALLER as `folderRowsByRootId` (one `roots` query for the whole panel —
  `assistant-data` stays DB-free), and folder mode cannot arrive without them:
  `BuildThreadListSectionsInput` is a union discriminated on `groupBy`, so the
  compiler — not a runtime throw — requires the folder arm to carry
  `folderRowsByRootId` and `folderSortBy`, and the other arm to carry `groups`,
  `placements`, and `sortBy`. A thread whose root id is missing, blank, or has
  no display row lands
  in the trailing "No folder" section, which is omitted when empty; the pure
  builder never logs, the calling hook does.
- The caller is `use-thread-folder-rows.ts` (BST-1404): ONE batched
  `roots WHERE id = ANY($1)` per distinct id set, value-keyed on the sorted
  deduped list, and a `logger.warn` ONCE per id that has no `roots` row. It is
  deliberately NOT a live query — `reconcileRoots` never modifies a matched
  row's `id`/`kind`/`path`/`display_name` and disconnecting a root flips
  `status` rather than deleting the row, so the columns it reads are immutable
  and there is no live-ness to subscribe to. A newly connected folder reaches
  the panel through the INPUT instead (binding a thread to it changes that
  thread's `operatingRootId`, hence the id set, hence the query). Its `rootIds`
  are THREAD-DERIVED, so **a mounted folder with no threads produces no
  section**: a folder section is a view over threads, not a mirror of the mount
  list, and unlike a user-created group there is no durable object whose
  emptiness must stay visible. A failed `roots` query is reported as
  `error`, NOT as an empty resolved map: an empty map with `loading: false`
  renders every thread under "No folder", which is the same silent degrade the
  run-state indicators above already refuse. Its `rowsByRootId` carries the RAW
  `roots.path`, while the branch map below is keyed by NORMALIZED path — a
  consumer joining the two must normalize first or the chip silently never
  appears.
- Unseen/needs-attention badges come from `use-unseen-thread-ids.ts` (BST-1404):
  a pure `deriveUnseenThreadIds` (terminal `latestRun` completed after the
  thread's watermark, active thread excluded, `failedUnseen ⊂ unseen`; a
  terminal run with NO `completedAt` is excluded rather than given a substitute
  timestamp) plus `useMarkActiveThreadViewed`, which stamps the watermark on the
  way in AND out of a thread and again whenever the active thread's run reaches a
  new `completedAt` while it is still active — so a run finishing in the
  foreground can never later read as unseen. Folder branch chips come from
  `use-thread-branch-by-root-path.ts`: ONE `useGitInventory()` GATED on
  `enabled` (`active: enabled`, `deferInitialLoad: !enabled`) because one load is a full
  repo/worktree scan across every workspace root (BST-1116 W6 finding 4) and the
  chips exist only in folders grouping — entering that grouping is the gesture,
  so this is a deferral, not a silent disable; the flip itself performs the
  load. Leaving folder grouping makes the hook inactive, so later push
  invalidations do not pay for full inventory scans; re-entering performs a
  fresh load. THREE KEYED LOOKUPS are available to `resolveThreadBranch`
  (`threads-panel.tsx`). FIRST `byRootId`, keyed by DB `roots.id` — the same id
  space as `metadata.operatingRootId` — holding only ids that appear in the
  `containment` of EXACTLY ONE worktree. A present durable id is authoritative:
  an id-only miss checks `byRootIdAndPath` for the SAME durable id plus the
  thread's exact normalized worktree path. This restores a root checkout when
  its root also contains a nested agent worktree without borrowing a branch
  from a replacement root mounted at the same display path. THEN, only for a
  legacy thread with no durable id, `byRootPath` uses the exact normalized
  worktree path as the fallback. A root that merely contains several
  repositories remains absent from `byRootId`; it gets a chip only when the
  durable id plus exact path identifies one of its claimed worktrees. BARE
  worktrees are omitted from all three maps: they carry no checkout,
  hence no branch, and a mapped bare entry (`branch: null, detached: false`)
  would render as an icon-only chip with no text (they therefore do not make a
  root's containment ambiguous either).
  Desktop only; web reports `available: false` and renders no chip.
  WHY THE ID JOIN EXISTS (BST-1406 → fixed in BST-1404/1405):
  `normalizeRootPathForLookup` trims and strips trailing separators — it does
  NOT resolve symlinks, and it cannot: `roots.path` keeps the path the folder
  was MOUNTED through while git reports the REALPATH. A root mounted through a
  symlink (the macOS `/var` → `/private/var` tmpdir is the reproducer) matched
  nothing by path, so its rows got no branch badge while the composer's branch
  chip — which asks git with that path as cwd instead of joining on it — still
  showed one. Same root, two answers. `containment` is computed in MAIN against
  realpath'd root paths, so the id join is immune to that skew.
- Folder grouping's SURFACE (BST-1405) is the same treegrid: folder sections are
  real expandable parents whose node id IS `section.id`
  (`folder:${rootId}` / `folder-unassigned`), so one id addresses the row, its
  disclosure limit, its collapsed flag and its membership
  (`getThreadPanelMemberSectionId` / `getThreadPanelCollapseId` in
  `thread-panel-visible-rows.ts`; a section id this module did not mint throws
  rather than becoming an unreachable node). `ThreadPanelVisibleRow` group rows
  carry a `header` — `group` | `ungrouped` | `folder` | `unassigned` — because
  the custom-groups **Ungrouped** section and the folder view's **No folder**
  section are different facts and must not collapse into one. Sort is
  `folderSortBy` (Recency/Name; **Custom is not offered** — a folder section has
  nowhere to persist a drag) and `setSortBy` THROWS if called in folder mode.
  There is NO drag shell and no `move-to-group`/`remove-from-group` row action
  in folder mode, and `resolveThreadsPanelDrop` answers `none` for a folders
  view before any resolver runs (the drop monitor is global, so this is a
  reachable input, not a dead branch); the header's tooltip says why —
  re-binding is the composer's folder chip. The header's one action is **New
  thread here**: `createThread` then ONE `updateThreadMetadata` carrying the
  whole binding (`operatingRootDisplayName` + `operatingRootId`, plus
  `operatingRootPath` only when the root has one — the repository rejects a
  partial triple). A create failure reports clean failure. If creation succeeds
  but metadata binding fails, the thread is preserved in **No folder** and the
  destructive toast reports explicit partial success plus guidance to open the
  thread and select the intended folder; it is never deleted to make the toast
  look atomic. Panel chrome stays TWO rows: the
  `Show only` filters (Running / Needs you / Unseen) live INSIDE the view-options
  popover, they are a UNION not an intersection, they light the trigger's dot
  like any other non-default view, and when they empty the list the panel names
  THEM (`threads-filtered-empty-card`) instead of claiming there are no threads.
  In folder grouping an unresolved or failed folder map replaces the treegrid
  (`threads-folders-loading-card` / `threads-folders-error-card`) rather than
  filing every thread under "No folder".
- Run state gets ONE badge slot per row, not three: `thread-row-status-glyph.tsx`
  owns the priority `needs-you > running > failed-unseen > done-unseen` as a
  pure function (a thread parked on an approval is also "running"; a failed run
  is also "unseen"). Every glyph carries an `aria-label` naming its thread, and
  the running state keeps the original spinner testid and `motion-reduce`
  behavior.
- ONE LIVE QUERY PER SIGNAL, NEVER PER ROW. The active-run projection
  (`use-active-assistant-thread-ids.ts`) has two siblings — the awaiting-approval
  projection (`use-threads-awaiting-approval.ts`, one resource-scoped live query
  over `brainstrike_assistant_run_events`) and the unseen watermark
  (`use-unseen-thread-ids.ts`, pure over threads already loaded, plus one
  batched `roots` read for folder rows). Each one reports its own failure and
  the panel renders that failure explicitly — `thread-activity-error`,
  `thread-approvals-error`, and the folder cards above — rather than presenting
  the resulting empty set as "every thread is idle / unblocked / in no folder".
- The per-thread viewed watermark `lastViewedAtByThreadId` (epoch ms) lives in
  `assistant-thread-store.ts` (`brainstrike-assistant-threads-v1`, state
  version 4, partialized; `migrate` fills ONLY that key and `unseenBaselineAt`
  for older blobs and passes the rest through — the threads blob has never been
  validated on load and must not start being silently repaired).
  `markThreadViewed` is idempotent and monotonic (never lowers an existing
  watermark); thread deletion prunes it and `resetAssistantThreadStore` clears
  it. Selection/tab actions do NOT mark implicitly — the panel decides when a
  thread counts as seen.
- `unseenBaselineAt` (epoch ms, persisted in the same slice) is the FLOOR under
  that watermark, and `deriveUnseenThreadIds` compares against
  `max(watermark, baseline)`. Without it an empty watermark record reads as "the
  user has never seen anything", so a fresh install — and the first launch after
  this shipped — would dot EVERY thread whose latest run ever completed, on the
  one signal that is supposed to mean "this finished while you were away". It is
  stamped at store creation, again by the v3 -> v4 migrate (the v3 blob carries
  no thread ids and no run timestamps, so per-thread watermarks CANNOT be seeded
  from it), and re-stamped by `resetAssistantThreadStore`. It is only ever
  raised, never lowered, and never inferred from a run.
- Folder sections mint persisted collapse keys (`folder:${rootId}`) in
  `collapsedGroupIds`, so `pruneFolderCollapseIds` in
  `assistant-thread-groups-store.ts` is the symmetric half of the group-key
  prune `deleteGroup` does. Call it ONLY with a live root set you actually know
  — the panel calls it from RESOLVED folder rows, because an empty folder map is
  also what loading, a failed `roots` query and every non-folder grouping mode
  look like, and pruning on that would wipe every folder's collapse state. Group
  keys and the `folder-unassigned` sentinel are never touched.
- The Threads panel uses shared `TreeTable` as its only scroll owner. Folder
  rows are real expandable treegrid parents with Left/Right keyboard behavior.
  Disclosed section rows are virtualized and capped at 50 initially, with an
  explicit 50-row Show more action; folder selection still targets the complete
  section, while Select visible targets only disclosed threads.
- Panel chrome is TWO rows, not three: `ThreadsPanelToolbar` (heading + live
  disclosed count + select-visible toggle + view options / new group / new
  thread) then the search row. The count and the toggle describe the treegrid,
  so they render only when `resolveThreadPanelContentState` says the treegrid —
  not a state card — is on screen AND search is idle. Search results replace the
  tree in a hidden subtree that also contains the bulk-action overlay, so a live
  toggle there would select threads with no feedback and no way to clear.
- E2E (BST-1406): `apps/desktop/e2e/threads-panel-folders.desktop.test.ts`
  (one `@smoke` test in the PR lane, one regression sibling) and
  `apps/web/e2e/threads-panel-folders.test.ts` (`@web-smoke`). Threads are
  SEEDED as `mastra_threads` rows through the renderer's `electronAPI.db`
  bridge (`e2e/utils/seed-threads.ts`) because the binding is written at the
  FIRST REQUEST, so the product gestures that mint a bound thread — "New thread
  here", and the workspace bar's "Make primary" (`use-workspace-bar.ts` writes
  the same three `operatingRoot*` metadata keys as `persistThreadRootBinding`;
  see `docs/agents/workspace-context.md` § workspace bar) — each need a folder
  section that only a bound thread can produce.
  The seed reads the DURABLE `roots.id` back from the database rather than
  reusing the adapter root id, and the desktop fixture `realpath`s its temp
  repo: `roots.path` keeps whatever path was mounted while git reports the
  resolved one. Resolving the fixture keeps its path projection coincident with
  the checkout, while the unit suite separately grades the authoritative
  containment-id join and the legacy path-only fallback. The web
  spec additionally pins that `window.changes` does not exist there at all —
  the structural reason the badge is desktop-only, which still holds for a
  bound thread. Both specs also pin the EMPTY-resource bootstrap thread
  (`loadResourceThreadsForGeneration` creates one when `listThreads` is empty):
  it has never made a request, so it belongs in "No folder".

Layers: repository `assistant-thread-groups-repository.ts` → store
`assistant-thread-groups-store.ts` → pure view-model `thread-list-sections.ts`
(grouping/sorting; `buildThreadMembership` is the single source of effective
membership; `getGroupMemberIds` answers section membership and weakly caches
the projected ids by immutable `ThreadListView`, indexing sections once but
projecting each group's ids only when its virtualized row is requested, so
selection-only rerenders do not rescan sections or reallocate visible groups'
id arrays and first paint does not project offscreen groups) → panel state
`use-thread-panel-selection.ts` (disclosure limits + bulk selection, owned by
`ThreadsPanel` so the toolbar and the treegrid read one source of truth rather
than two copies) → body arbitration `thread-panel-content-state.ts` (pure: tree
or which state card, read by BOTH the body and the toolbar so they cannot
disagree; it also owns `hasActiveThreadFilters`) → view surface
`threads-panel-view-options.tsx` (the one popover: grouping, sorting, filters) → drop resolution `threads-panel-dnd.ts` (pure intent reducer) →
element wiring `threads-panel-dnd-elements.tsx`.

Cost of that ownership: a checkbox toggle or Show more now re-renders all of
`ThreadsPanel` rather than only `ThreadPanelTree`. `buildThreadPanelVisibleRows`
is memoized on the same deps, so this is render breadth, not recomputation —
fine at user-paced click rates, worth revisiting if the panel grows. Semantic color presentation is
owned once in `assistant-thread-presentation.ts` and shared by rows, folders,
and tabs. Keyboard/a11y fallback for
every drag operation: row context-menu "Move to <group>" / "Remove from Group".

Paired tests for folder grouping: the `ThreadsPanel folders` suite in
`threads-panel.test.tsx` (whose `usePGliteLiveQuery` double routes rows BY
`cacheKey` — the two projections have identical `{ threadId }` row shapes and an
order-based double would feed one the other's rows), plus the folders cases in
`thread-panel-visible-rows.test.ts`, `threads-panel-dnd.test.ts` and
`thread-panel-content-state.test.ts`.

Paired tests: `migration-054-assistant-thread-groups.test.ts` and
`migration-056-assistant-thread-group-presentation.test.ts` (packages/db),
`assistant-thread-groups-repository.test.ts`, `assistant-thread-groups-store.test.ts`,
`thread-list-sections.test.ts`, `threads-panel-dnd.test.ts`, and the
`ThreadsPanel groups` suite in `threads-panel.test.tsx`.

## TOOL OUTPUT ARTIFACT PERSISTENCE

Migration 068 and `ToolOutputArtifactRepository` own complete oversized tool
outputs; migration 129 adds native execution-thread identity to deduplication
within the same root resource/thread/run. Existing artifacts backfill their root
thread without changing references, bytes or expiry. A child cursor is readable
through the root-owned reader capability, never by supplying execution identity
as read authority. Exact same-execution replay remains byte-immutable. Native
sibling tests cover reused tool-call IDs, complete model paging, reconstructed
engine reads and hydrated child envelopes.

The table stores results independently of Mastra message rows:

- `brainstrike_assistant_tool_output_artifacts.content` is `BYTEA`, populated
  from exact UTF-8 bytes through hex text + PostgreSQL `decode`; this preserves
  U+0000 and avoids typed-array realm drift across browser workers and Electron
  IPC.
- The public id is an opaque uuidv7 token. Every read also requires the active
  `resource_id` and `thread_id`; a wrong scope is indistinguishable from a
  missing artifact. `run_id`, `execution_thread_id` and `tool_call_id` retain
  execution provenance,
  with one stored result per scoped tool call.
- Range reads are byte-addressed and capped by the shared 8000-byte page
  maximum. The repository returns bytes; the future reader/resolver owns
  UTF-8-boundary adjustment and signed/opaque cursor validation.
- Retention is seven days. `purgeExpired` deletes an explicitly bounded batch
  in oldest-first order. Expired reads return metadata without content.
- Storage, reads, and purge failures use a typed visible error. Settlement must
  finish the complete write before publishing an artifact envelope; it must
  never substitute a reference after a failed write.
- Exact replay of `(resource, thread, run, execution thread, tool call)` returns
  the existing
  reference only when format and complete bytes match. A different replay
  returns no row and surfaces as a typed storage conflict; settlement never
  overwrites prior evidence.
- There are deliberately no Mastra FKs because the numbered migration runner
  operates on a bare schema. Both direct-PGlite reset paths and desktop
  `db:clearAll` delete artifacts explicitly; only a pre-068 missing relation is
  tolerated.

The desktop assistant now injects a trusted, request-scoped repository adapter
when resource, thread, and server-owned run ids are all present. The agent's
central settlement wrapper persists complete non-media native/MCP results above
12,000 UTF-8 bytes, caps one artifact at 16 MiB, and publishes a preview
envelope only after the repository returns coherent metadata. Display and
transcript store that envelope; a private in-process carrier lets model
projection consume the original result. MCP image/audio remains inline for
display/transcript rendering and keeps its media plus metadata ceilings in both
host modes. Hosts without the adapter additionally retain the temporary MCP
text/JSON inline ceiling. The artifact reader remains a separate later slice.
The wrapper also accepts stricter per-tool serialized-character thresholds.
Desktop sets `brainstrike.webExtract` to 2400 characters so complete small
extracts stay inline while larger page content, exact URLs, and failure reasons
are committed as one exact JSON artifact before any compact model view is
published. When that stored JSON fits one model page, display keeps the complete
raw result and the model page reports completion without an EOF cursor.
Paired tests:
`migration-068-tool-output-artifacts.test.ts`,
`tool-output-artifact-repository.test.ts`,
`tool-output-artifact-settlement.spec.ts`,
`mastra-tool-execution.integration.spec.ts`,
the desktop `assistant-server/run-persistence-http.integration.test.ts` and
`assistant-server/agent-stream-init-and-memory.integration.test.ts` (the
pre-BST-1028 `assistant-server.integration.test.ts` split),
`factory-reset.test.tsx`, and the desktop `ipc-handlers-db.test.ts`.

## THREADS PANEL HYBRID SEARCH

Hybrid (lexical + semantic + title) search over threads, rendered at the top
of the Threads panel. Mastra has no cross-thread content search
(`listThreads` filters metadata only; `semanticRecall` is vector-only,
per-thread, retrieval-for-context), so this is Brainstrike-owned derived
state under the SAME ownership ruling as thread groups: never ALTER the
Mastra tables.

Where state lives (do not relitigate):
- Index: `brainstrike_thread_message_index` (migration 067; one row PER
  mastra message, no FKs — orphans are inert via query-time joins and swept
  by the bounded sync GC). `content_text` is bounded plain text extracted
  IN SQL from the Mastra v2 content JSONB (text parts only — tool payloads
  are never indexed; non-conversational roles keep '' so the anti-join sync
  still sees them as processed). `content_hash` = md5 of the RAW content
  JSONB: the sync upsert's `IS DISTINCT FROM` CAS detects progressive
  same-id saves and resets the row's embedding to pending. The tsvector is
  a STORED generated column (034 precedent) + GIN; deliberately NO
  pg_textsearch BM25 index (the 065/066 durability-gate burden is not
  re-paid for a second hot-write table; ts_rank_cd orders the lexical arm).
- Semantic arm HNSW tuning (BST-576): `searchSimilar` runs its filtered ANN
  SELECT inside ONE transaction with `SET LOCAL hnsw.ef_search` +
  `iterative_scan='strict_order'` (`SET LOCAL` outside a transaction is a
  silent no-op → pgvector default ef_search=40, the #1141 filtered-ANN
  under-return class). Path order in `runVectorSearchInTransaction`: desktop
  runs the `ThreadSearchDatabase.runTransaction` atomic IPC primitive; web
  (ScheduledDbHandle) and raw PGlite handles run the callback-style
  `transaction`, which holds the single connection's lock so concurrent
  scheduled work (the controller's embedding-backlog writes run alongside
  searches) cannot interleave inside the open transaction; the raw
  BEGIN/COMMIT-over-`query` fallback remains only for legacy/mock seams.
  Paired tests: the mock-db describe in
  `packages/db/__tests__/search-thread-message-index.test.ts`.
- Embeddings: per-message inline `vector(384)` column (typed to the
  singleton profile; a partial HNSW index serves the semantic arm) with the
  singleton `brainstrike_thread_search_profiles` row — the prompt-library
  (051) pattern, NOT the file-collection `embedding_sets` lifecycle, and NOT
  the hidden-host job_queue: embedding runs in the visible renderer through
  the registered embedding queue factory + shared `SearchEmbedderProvider`,
  drained in bounded sequential resource-scoped passes. Writes are
  double-CAS'd: content hash (stale text) AND profile model key (a
  mid-flight same-dimension model swap must not land a cross-space vector).
  The source hash covers role + raw content, since extraction depends on
  both.
- Sync: `ThreadSearchRepository.sync()` — a row-count membership fast path
  (idle searches pay two COUNTs, not anti-join scans; a same-count
  delete+insert pair defers one pass and heals on the next divergence),
  bounded anti-join inserts, a PER-THREAD refresh
  (`brainstrike_thread_search_state`: threads strictly newer than their own
  recorded activity, plus a trailing 2-minute live window for same-id
  progressive saves — never a global watermark, which could let one busy
  thread push a quiet thread's pending change out of the refresh window
  forever), and bounded orphan GC. Runs per search pass behind a 5s TTL and
  an in-flight guard (concurrent searches share one sync); every statement
  is bounded (single-PGlite-connection contract).
- Fusion: `ThreadSearchService` (packages/db/src/search/thread-search-service.ts)
  is the thread-native binding of the SHARED generic RRF core (`rrf.ts`) —
  `HybridSearchService` stays FileChunk-bound on purpose; do not fake chunk
  shapes to reuse it. Two levels: message arms (FTS + vector) fuse per
  message id, then content-ranked threads fuse with trigram-ranked title
  matches (title+content beats equal content-only; title-only threads still
  surface). Titles are matched live off `mastra_threads` (few + mutable),
  never copied into the index.
- UI/state: session-only `thread-search-store.ts` (app-shell) with the
  workspace-search generation contract (monotonic token gates every async
  completion; `clearResults` keeps the typed query, `clearSearch` is the
  full Esc/✕ dismiss). Like workspace-search, `setQuery` deliberately does
  NOT bump the generation — the debounced auto-search owns that transition,
  so the previous query's results may render for ≤ debounce+search time
  (settled; keep the two stores' contracts aligned).
  `use-thread-search-controller.ts` owns debounce (250ms, 2-char minimum),
  sync, the embedding backlog drain, and semantic honesty: an unproducible
  query embedding runs lexical-only WITH a visible `unavailable` reason
  (failure cached 60s so searches never stall behind a repeatedly-failing
  model init; a success recorded after a stale attempt started wins), plus
  coverage progress AND embedding-failure counts — never a silent downgrade
  or a silently shrinking semantic corpus.
  `ThreadsPanelSearch` renders ts_headline `<mark>` tokens as elements and
  everything else as plain text (persisted content is never HTML), with
  aria-activedescendant keyboard nav. While searching, the tree is hidden
  (not unmounted) so disclosure/selection state survives dismissal.
- Cleanup: panel thread deletion clears index rows eagerly (like
  placements); missed paths self-heal via sync GC. Factory reset clears
  `brainstrike_thread_message_index` + `_state` on BOTH the desktop
  db:clearAll path and the web DbProvider paths; the search profile row is
  configuration and survives (prompt-profile precedent). The session store
  registers in `register-factory-reset-session-stores.ts`.

Paired tests: `migration-067-thread-search-index.test.ts`,
`search-thread-message-index.test.ts`, `search-thread-search-service.test.ts`
(packages/db); `thread-search-store.test.ts`, `thread-search-embedding.test.ts`,
`use-thread-search-controller.test.ts`, `threads-panel-search.test.tsx`
(packages/app-shell).

## ASSISTANT THREAD TABS

Open tab order is durable workspace-scoped state in `assistant-thread-store.ts`;
`reorderThreadTabs` persists the complete ordered id list atomically. The tab
controller uses the WAI-ARIA automatic-activation pattern with roving tab focus,
Home/End, Delete, and `Alt+Shift+Left/Right` reorder controls. Pointer drag uses
Pragmatic drag and drop plus edge auto-scroll; context-menu Move Left / Move
Right provides the non-drag alternative. Panels remain mounted while inactive
so runtime state is not discarded. Open tabs project BOTH the icon and color
from the current loaded thread after every `useAssistantThreadStore` transition:
`assistant-thread-presentation.ts` owns the exhaustive icon registry, the
Message default for absent icon metadata, and the canonical color surfaces.
The Threads panel rows, customization pickers, group icon choices, and tabs
consume those shared contracts rather than declaring local glyph maps or
palettes. A successful metadata write updates the one loaded thread object, so
an open tab reflects customization without a PGlite re-read, timer, global
invalidation, or assistant-panel remount; a failed write performs no store
transition and remains visibly failed in the panel. `listThreads` returns the
thread row plus its latest-run badge data in ONE SQL snapshot; splitting those
reads permits a metadata write to interleave before a stale title refresh lands
in the store. Historical run model ids remain plain persisted evidence: ids
known to `MODEL_ID_MIGRATIONS` render as `Unavailable · <raw id>` in both the
row badge and expanded details, while unrecognized ids remain visible verbatim
instead of disappearing or being rewritten to the current replacement. The
refresh captures each loaded metadata object before its read;
if an immutable metadata transition lands while that read is in flight, the
refresh preserves the current metadata while still applying refreshed titles,
run badges, and ordering. That store-side ordering guard closes the stale
metadata overwrite, while the single SQL statement removes the intra-read
inconsistency and one local database round trip. Neither path uses polling or
retries.
The persisted store contains tab/selection ids but not `mastra_threads` rows.
After restore, `loadStateByResourceId` therefore remains `idle`/`loading` until
`ensureResourceThreads` hydrates the selected row and its metadata. Composer
sends stay disabled during both states even when no workspace root is focused,
and root-binding resolution/persistence also rejects a selected id whose row is
not loaded; that transient absence is never interpreted as an unbound thread
eligible for the current Main root. A terminal database initialization error
always outranks the transient loading reason so a failed capability cannot
remain disguised as pending hydration.

The non-reloading Database Explorer **Clear Database** path deletes
`mastra_threads`, so its app-shell composition must synchronously reset the
thread store and thread-groups store immediately after the database clear
succeeds and before collection reloads begin. `DatabaseDemoPanel` requires and
preflights that post-clear callback; capability absence blocks the clear
visibly instead of leaving persisted selection pointed at a deleted thread.
`resetAssistantThreadStore` clears every persisted selection/tab/draft map,
every loaded thread map, and the resource-load promise registry. Both thread
stores invalidate in-flight hydration generations during reset so a stale
completion cannot repopulate deleted rows into the live mirrors.

Paired tests: `assistant-thread-store.test.ts`,
`database-tab-chunk.test.tsx`, `database-demo-panel.test.tsx`,
`assistant-thread-tabs-dnd.test.ts`, `assistant-thread-tabs-dnd-elements.test.tsx`,
`assistant-thread-tabs-workspace.test.tsx`,
`assistant-ui-panel-wrapper-runtime.test.ts`, and
`use-assistant-thread-root-binding.test.ts`; the live customize-and-reload browser
contract is `apps/web/e2e/assistant-ui-panel.test.ts`.

---

## Delegated conversation identity storage (BST-1718 foundation)

`@brainstrike/db` exposes `createDelegatedConversationRepository` over a minimal
query interface for trusted host use. Register the real root, then bind each
actual native child thread beneath its immediate parent. Write inputs must come
from the host's observed native delegation context, never model-supplied ids or
renderer requests. A native resource id is execution scope, not user authority.

Every read and child creation walks the persisted graph outward from the live,
authorized root and verifies each native thread/resource pair. A grandchild
whose intermediate ancestor changes native scope is inaccessible even if the
grandchild's own row still matches. The authenticated host supplies root owner
and root id; these query methods are not unauthenticated endpoints. Missing
legacy graph nodes return no identity and do not fabricate transcripts or
ancestry from compact tool results.

Nodes are immutable: duplicate creation with the same configuration is
idempotent, conflicting ownership/ancestry/configuration is an error, and two
calls to one persona use distinct native thread ids. Display name/color are
host-assigned identity snapshots; this foundation does not yet implement their
UI or rename controls. Workspace binding is captured when the child is created;
existing children and their descendants retain that binding after the root's
workspace changes. See `database.md` for migration/reset/deletion semantics.

This storage foundation does not change production runtime behavior or usage
writers. Migration 127 now provides invocation/run binding records (see database.md).
BST-1718 still needs lifecycle and exact usage reconciliation, authenticated
host wiring, resume hydration, and complete native branch deletion. Full child message persistence/rendering remains BST-1719.

### Scoped child stream hydration (BST-1719 delivery layer)

Native Mastra memory remains the sole child transcript writer. The desktop run
event observer routes scoped child lifecycle events through the delegated
repository's atomic authorization/header/event mutation into the existing
thread-run/run-event tables. A native invocation plus current root host leg
gets its own opaque child host-run id; the root turn id is not a child user
message id, so the nullable child header field stays unset. Usage remains in
the existing root-attributed writer and is not duplicated for these headers.

Child lifecycle persistence is deliberately awaited before publication. It
revalidates the invocation and makes the published event durable; an exhausted
write or identity failure propagates through the root error path. The root's
queued writer also fails at final flush, rather than tolerating lost events.
This child path introduces database backpressure at lifecycle boundaries;
ordinary text/reasoning deltas do not perform database round trips. Native
memory's transcript ownership does not make lifecycle authorization optional.

Events retain observed native message identity in sanitized metadata. The
shared history adapter assigns these events by row id before applying the
legacy run-window heuristic, permitting several resume legs in one assistant
group. An observed message outside the loaded window is never assigned to a
different turn. The normal session buffer replays encoded scoped frames without
remapping; the normal assistant-stream decoder consumes child frames.

For a scoped child's `tool.started` event, the observed native message id and
tool-call id anchor the event **after** its persisted tool part, matching the
shared live encoder. Millisecond timestamps cannot establish this boundary:
text, reasoning and a tool start can share the same time, and timestamp weaving
alone moved the event ahead of all three. The shared hydrator preserves content
and journal order while waiting for that specific tool boundary: the anchor
blocks the event queue, so later journal entries cannot overtake it. Exact native
row-to-group assignment happens before tool anchoring, including when different
turns reuse a tool-call id. A final tool part releases its queued events through
the existing trailing flush. Tool-call deduplication is scoped to one assistant
group: snapshot rows of that turn still merge, while later turns and regenerated
siblings retain their own same-id tool parts. Legacy events keep their existing
time-based placement. A cancelled call whose unfinished
tool part was removed still retains its journal events; hydration never invents
that missing tool part or drops its failure history.

Scoped `tool.completed` and `tool.failed` events also wait until their own tool
part has been emitted, including when the loaded journal contains no matching
start. This is a lower bound, not a replacement timestamp: terminal events
still wait for their recorded time so text emitted while a tool ran remains
before its completion. Journal order is preserved for following legacy events.
The paired history tests cover both terminal kinds with tied timestamps and
no start, mixed legacy events, and text emitted during tool execution.

`delegated-stream-parity.integration.test.ts` compares text, reasoning, tool
name/id/input/result and every lifecycle data payload in order from the real
native desktop stream with the current and reconstructed memory engine. The deterministic hydration tests cover tied
timestamps, two distinct tool boundaries, native grouping with reused tool ids,
a final tool event tail and a removed cancelled tool part. Decoder-private
fields and ephemeral tool runtime fields are outside that parity assertion.
This proves the tested normal turn; changed native ids across resume and full
receiver/replay remain separate BST-1719 acceptance.

The host returns sanitized metadata to the live stream as well as storage.
On snapshot resume, a parent wrapper can precede its own native message id.
Atomic invocation binding returns its latest previously observed message id
from the existing event journal, restricted to the exact native run, parent
call and persona. Projection uses that id until Mastra supplies the current
one. A missing identity fails before child projection state is registered;
termination never invents a transcript id or silently drops an event.

Paired proofs: desktop `delegated-runtime.integration.test.ts` (real native
transcript, shared hydration and engine reconstruction),
`delegated-conversation-host.integration.test.ts` (host ownership, pins,
idempotency and resumed event grouping), and agent `data-stream-session.spec.ts`
(decoder and byte-identical replay). These do not claim packaged UI parity or
cancelled child transcript durability; those scenarios remain tracked.

### Tool input live/reload parity (BST-1719)

Native Mastra storage already retained complete child tool arguments. The
transport must emit them through the normal decoder's argument-delta path
before closing a started tool; the completion frame alone does not populate
that part. `delegated-stream-parity.integration.test.ts` uses the real desktop
memory, host event observer, native loop, transport encoder, installed decoder
and shared history adapter. It establishes the observed native message id
against the actual saved row and compares text/reasoning/tool input/result
content and order before/after engine reconstruction. There is no duplicate
content writer or new durable store. Full event placement, changed native ids
on resume and receiver reattachment remain separate BST-1719 acceptance work.

### Renderer receiver and native transcript ownership (BST-1719)

The optional panel/runtime `onDelegatedConversation` callback receives full,
ephemeral child snapshots through the ordinary decoder and accumulator, keyed
by native invocation across observed message changes. Full replay replaces
snapshots; native memory remains the sole transcript writer. Missing terminals
and unseeded/mismatched replay openings fail visibly. Child error isolation,
recursive descendants, cancellation and upstream-fault settlement are covered
at the public runtime adapter; the desktop native fixture now tests that adapter
against the reconstructed persisted transcript. See the renderer receiver
contract in `assistant-runtime.md` for lifecycle and remaining acceptance scope.
Child tabs/rendering and durable graph association remain BST-1724 work.

Receiver completion uses the same `deferMessageFinishUntilFlush` transform as the
parent. Both final part streams and descendant receivers settle before a complete
snapshot is published. Producer failures/cancellations still emit their required
`d` finish frame; an error frame alone is a truncated stream, not a valid child
terminal. Cleanup preserves the primary transport/envelope/abort failure and logs
secondary settlement failures once. Consumer presence selects receiver installation
at run start; an installed receiver reads the latest committed callback on each
update, including callback replacement during an active run.

The receiver also retains its first observed failure if decoding or descendant
settlement subsequently fails; the competing observer/decoder regression pins
this through the public runtime adapter.

### Child continuation row identity (BST-1719)

Child output processors preserve the final native response boundary before
Mastra re-adds response rows during finish. This prevents an earlier approved
tool row from being merged into the newly rotated continuation ID. PGlite remains
the native content store; no text-equality deduplication or additional content
writer is introduced. The reconstructed parent/child/grandchild resume fixture
compares both live legs against history and retains intentionally repeated text.
See `assistant-subagents.md` for the native API and verification scope.

Native `toolInvocation.state: output-denied` hydrates to the shared
`DeclinedToolCallResult`, preserving arguments and the approval reason. It is
terminal without an error flag, matching live `tool-output-denied`; a missing
`result` in the native row does not mean the declined call is still pending.
Both live and hydrated paths use `createDeclinedToolCallResult` from the
browser-safe approval contract. Existing pending/result/error rows retain their
original behavior.

### Hydrated delegated pause identity (BST-1720)

Synthetic rediscovered approvals and questions preserve their exact delegated
leaf path in the normal data part. Their transient message IDs use the native
leaf run/call rather than the reused root delegation alias. Repeated discovery
of the same leaf is stable; a subsequent leaf pause produces a different ID
and cannot retain an earlier card's answered state. Both still chain onto the
durable history head through the existing transient-parent topology adapter.
Ordinary root pause IDs are unchanged. The history repository regression covers
successive leaves, repeated discovery and the preserved parent edge.


### Decision discovery failures remain visible (BST-1720)

A failed or timed-out suspended-decision request and a malformed response are
explicit recovery states, not successful empty lists. Valid entries in a partly
malformed response remain visible alongside the error. An absent optional
`suspends` array retains the established additive protocol contract.

Hydration keeps durable history and appends a transient `suspended-run-discovery-error`
data notice. It is neither a native tool action nor a failed model response:
regeneration/copy controls must not appear on it. Its transient parent alias
chains the next real message to durable history; it does not add a persistence
store or a native message row. A successful later hydration removes the notice.
The current recovery action is to reopen the thread. A future persistent child
runtime host must provide explicit history refresh rather than equating closing
an inspection view with resetting its runtime.

The request deadline starts after endpoint and auth resolution and covers the
fetch and response body. A malformed notice payload renders an explicit invalid
recovery status beside the saved conversation; it must not throw during render
and replace the thread with an error boundary.

The real assistant-ui activity renderer and topology adapter have paired tests;
Electron coverage exercises a failed discovery and successful renderer reload
with saved content retained and zero model requests. The discovery endpoint is
controlled by that E2E fixture; this is not native process-restart evidence.


### Durable delegated decision recovery display (BST-1720)

Rediscovered pause data retains the host's optional durable `decisionState`
through the existing transient notice hydration path. It creates no message
content rows or durable parent edges. Reload refreshes status; it never resumes
a workflow. The shared cards preserve tool/plan/question content and disable
resubmission of claimed, consumed or interrupted decisions. Unknown present
states fail wire validation. See assistant-subagents.md, “Durable delegated
decision recovery display”, for the host authority and paired database/renderer
proof. Missing snapshots still produce the visible discovery error.

Delegated live views receive an immutable pre-leg history baseline from the
admitted desktop host. The host and the ordinary renderer repository call the
same `@brainstrike/db` `readAssistantHistoryMessages` /
`readAssistantHistoryRunEvents` readers,
so rewind filtering, topology and hydration bounds cannot diverge. The stream
baseline never writes or replaces native message rows. See
`assistant-subagents.md`, "Child history boundary for a live stream leg", for
the admission, replay and identical-text invariants and native proofs.

### Workspace tabs and cancellation publication (BST-1720/BST-1725)

The shared workspace coordinator publishes app open/close/selection immediately;
viewport/editor changes retain the existing debounce. Reload must not discard a
new delegated tab while an unrelated scroll timer is pending. Existing native
workspace persistence owns this state; no child-specific persistence is added.
Thread-run cancellation is monotonic in both renderer and server terminal
writers, so a late completion cannot reopen a cancelled turn's child decisions.

### Explicit cancellation publication

Desktop cancellation first marks all authoritative same-owner/root/turn legs
`cancelling`, which is nonterminal and blocks new delegated decision admission.
It aborts registered legs and awaits their owner teardown before acknowledging
cancellation, including the gap after a terminal write but before unregister.
A live leg owns its normal turn-end capture; waiting work has no remaining
stream, so cancellation closes
only a snapshot bracket whose first run belongs to those authoritative legs,
including after process restart. Only then does waiting work become `cancelled`.
The renderer does not preempt the server-owned cancellation with an optimistic
terminal database write. Both completion writers preserve cancelling/cancelled
authority against every stream terminal report, including cancelled. Only the
cancel endpoint finalizes cancelling rows after owner teardown; stream writers
never cascade terminal cancellation into sibling legs. Startup reaping retains a
crashed cancellation as cancelled with the existing orphan diagnostic; it never
restores admission or fabricates the lost turn-end capture. Reattachment treats
cancelling as in-flight. The text status column needs no schema migration.

A renderer Stop latches cancellation on its prepared request before issuing HTTP,
so a racing abort/error cannot publish failed over the server-owned request.
The local completion callback runs only after cancellation acknowledgement. A
failed POST does not fabricate a terminal result; a later send reconciles the
latched request against actual durable status and remains blocked while running
or cancelling. Worktree archive also treats cancelling as active.

### Cross-root child navigation (BST-1725)

A sidebar child action activates its owning root before opening the workspace app.
`ThreadWorkspaceNavigation` holds only a session navigation intent; the existing
workspace coordinator owns hydration and persistence. It drains that intent after
cached or asynchronous incoming hydration completes, so the outgoing root never
captures another root's child tab. A newer root switch discards the intent. Read
failure shows an explicit error; another user click may retry that read. No run is
started, no alternate snapshot store is introduced, and reload uses the ordinary
thread workspace record. Coordinator regressions cover delayed, superseded and
failed reads; the Electron workspace fixture checks both roots' actual saved tabs.


### Durable native background outcomes (BST-1723)

Migration 133 registers `mastra_background_tasks` with the native PGlite adapter;
the table participates in database clear and factory reset. Task scope is the
root resource/thread, not a renderer tab. Updates use expected-status comparison
so competing lifecycle transitions cannot overwrite each other.

Completed, failed and timed-out outcomes are reconciled before inference. The
native task row carries `delivered_at`, separate from native status, so transcript
retention cannot make an already delivered task poison every subsequent turn.
Native completion hooks acknowledge only after native `onResult` flushes memory;
resumed/repaired outcomes acknowledge only after the host message write succeeds.
A failed acknowledgement remains recoverable and never re-executes the effect.
Exactly one retained matching invocation is updated; ambiguous matches fail.
If retention removed the invocation, the task's durable input and outcome create
a deterministic recovery message that visibly explains the missing original and
that no work was rerun. Missing failure details and timeouts get explicit error
text, including uncertainty about external effects. Result/error and cleared
pending-decision metadata are saved together. Recovery scans every undelivered
page before acknowledging, so acknowledgements cannot shift pagination and skip
a task. `background-outcome-recovery.integration.spec.ts` covers lost messages,
all three terminal outcomes, repeat repair and delivery acknowledgement reload. Native resuspension joins the workflow snapshot before exposing a
new resumable decision. Native reconstructed-runtime recovery is tested separately
from the actual desktop process-restart pending-approval case; it is not evidence
of completed-undelivered recovery through every host restart boundary.

Delegated background notices can create multiple topology-bearing assistant rows
within one user turn. History run-event reads retain the originating user message
from the owning run. Delegation events bind to their exact tool call within that
turn, before chronological assignment; they cannot attach to a reused call ID in
another turn. The normal shared workspace resolver then opens the persisted child
from that native invocation. The owning-turn hydration regression and the real
Electron stopped-child close/reload/reopen case cover both producer and consumer.
