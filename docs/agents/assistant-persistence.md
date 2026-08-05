# Assistant Persistence, Notifications, Context Meter

> Extracted from AGENTS.md (2026-07-12). Read before changing message persistence/hydration, run notifications, or token-budget wiring. Keep updated with the code.

## ASSISTANT THREAD PERSISTENCE & RELOAD HYDRATION

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
Malformed persisted ids never sanitize to "unbound" and cannot silently rebind
the thread. Server-side native tools validate only the id against the live root
inventory; the stored path is never an authority or fallback.

Automatic thread titles use Mastra Memory's top-level `generateTitle: true`
option and `Agent.generateTitleFromUserMessage`. At the terminal Mastra finish,
the stream adapter starts that canonical title request with the active agent
model before yielding the UI finish, then keeps the per-run Mastra instance
alive until the detached request settles. The main response therefore is not
held up by title latency, and generation remains independent of Observational
Memory, its token threshold, and whether OM is thread- or resource-scoped. The
generated title is persisted through `PgliteMemoryStore.saveThread`; that
transactional boundary may replace only an empty/default/system-owned title and stamps
`titleSource: 'om'`, while the manual rename path clears the marker and always
wins even if generation was already in flight. Title generation deliberately
does not delay the main assistant response, so provider `message-finish` is not
a reliable primary title-refresh signal. App-shell live-subscribes to the local
`mastra_threads` id/title projection and re-lists the loaded resource only when
that stable projection changes. This makes background titles visible in thread
rows and tabs without a timer or an API round trip. The existing
`message-finish` refresh remains intentionally separate: once per completed
turn it updates thread recency, ordering, and latest-run details, and provides
a best-effort recovery path if the live subscription has failed.

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
   (packages/app-shell/src/assistant-memory-repository.ts) therefore:
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
   failure, Stop, and a visible expired-session response remove the ephemeral
   record. The public assistant-ui runtime temporarily creates a generated
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
   BST-897 cases in `packages/ui/src/__tests__/assistant-ui-panel-architecture.test.ts`.

Approval/suspend ACTION messages are deliberately NEVER a Mastra row: the
"Approved <tool>." / "Approved the plan." user message the notices append is
UI/transport bookkeeping (its `runConfig` drives the resume; its metadata
marker drives the notice outcome locking + chip rendering). Neither resume
path passes messages to Mastra, and the shared transport
(`packages/ui/src/assistant-ui-panel/data-stream-runtime.ts` +
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
- The composer's attachment adapter (packages/ui assistant-ui-panel/
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

---

## ASSISTANT RUN NOTIFICATIONS

OS-level `Notification` API alerts for three run-lifecycle events — run
finished, run failed (including watchdog stalls surfacing as `run.failed`),
and tool approval required — fired only while the app is NOT the user's
active focus. One code path for Electron renderer AND web: the standard web
`Notification` constructor, no Electron `Notification` module, no new IPC.

Layers:
1. **Preferences** (`packages/app-state/src/stores/notification-preferences-store.ts`) —
   persisted master toggle (`masterEnabled`, default OFF) + per-event toggles
   (`events.{runFinished,runFailed,toolApprovalRequired}`, default ON).
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
   each. The input is a discriminated union carrying only `runId`/`kind`/an
   optional `threadTitle` (plus a REQUIRED `toolCallId` on the approval
   variant), never message content or tool args — and wires `onclick` to
   `window.focus()`.
3. **Settings UI** (`packages/settings-ui/src/settings/system/notification-settings-section.tsx`,
   registered via `createNotificationSettingsCategory()` from its own
   `notification-settings-category.tsx` — a non-component module, kept out of
   `settings-page-content.tsx` so Fast Refresh preserves `SettingsPageContent`
   state; imported in both `apps/web/src/app/settings/page-content.tsx` and
   `apps/desktop/src/renderer/components/settings/page-content.tsx`) —
   master + per-event toggles, surfaces a "blocked by your browser/OS"
   message when permission is denied/unsupported.
4. **Trigger source** (`packages/ui/src/assistant-ui-panel/run-lifecycle-notifications.ts`) —
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

When changing this flow, update this section and the paired tests
(`packages/app-state/src/__tests__/notification-*.test.ts(x)`,
`packages/ui/src/assistant-ui-panel/__tests__/run-lifecycle-notifications.test.ts`,
`packages/ui/src/assistant-ui-panel/__tests__/run-lifecycle-notifications-hydration.test.tsx`,
`packages/app-shell/src/__tests__/use-assistant-run-notifications.test.ts`).

---

## FOLLOW-UP MESSAGE QUEUE (COMPOSE DURING A RUN)

Report R3 v1 — the QUEUE half of mastra-code's steer/followUp pair. The
composer input already stays enabled during a run (only Send unmounts); this
adds a `QueueFollowUpButton` in the RUNNING branch (composer-input.tsx
`queueControl` seam), a per-thread zustand FIFO
(`packages/ui/src/assistant-ui-panel/follow-up-queue-store.ts`), removable
"queued" chips above the composer, and a render-nothing
`FollowUpQueueBridge` that dispatches ONE queued message per run end via
`aui.thread().append(...)` (the same programmatic-send seam the
approval/suspend notices use).

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
(`packages/ui/src/assistant-ui-panel/__tests__/follow-up-queue-store.test.ts`,
`packages/ui/src/assistant-ui-panel/__tests__/follow-up-queue.behavior.test.tsx`
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
- Usage store (packages/ui/src/assistant-ui-panel/context-usage-store.ts) is session-lived, NOT
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
- Estimator v2 (BST-940, `packages/ui/src/assistant-ui-panel/context-estimate.ts`):
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
  Missing or malformed cost metadata on a new OpenRouter completion fails
  visibly rather than being mislabeled as an exact or zero-cost run.
- Thread-total headline + run-kind attribution (BST-953): every
  `brainstrike_assistant_run_usage` row carries `run_kind`
  (`'chat' | 'subagent' | 'om-observation' | 'om-reflection'`, migration 077 +
  the repository bootstrap mirror; CHECK-constrained, default `'chat'`). TWO
  writers, never overlapping: the renderer writes ONLY parent `'chat'` rows
  (the `handleUsage` message-finish tap); the desktop server writes ONLY child
  rows, from the `child-run-usage` StreamChunk
  (`persistDesktopChildRunUsage` in apps/desktop/src/assistant-server/run-persistence.ts, a
  DUPLICATION-NOTE mirror of `recordRunUsage`). Child sources:
  - subagent: `onDelegationComplete`'s aggregate usage
    (`createDelegationConfig.onChildUsage` → per-leg `DelegationUsageCapture`
    queue drained by the stream generator). Provider-exact; model/provider =
    persona pin ?? parent run.
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
  refresh never reads pre-write state); the live sum has THREE clear paths —
  `handleUsage` (only AFTER the post-write refresh, so the total never dips
  and jumps), the wrapped `completePreparedRequest` on a cancelled/failed
  terminal status (the abort-gated tap never delivers those runs' finish), and
  thread selection (a just-selected thread cannot have its own in-flight
  accumulation, so a lingering sum is a stranded remainder). A repo-backed
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

## RUN-EVENT / THREAD-RUN SCHEMA OWNERSHIP (settled 2026-07-24 — do not relitigate)

`brainstrike_assistant_thread_runs` and `brainstrike_assistant_run_events` are
created ONLY by the renderer's lazy `ASSISTANT_THREAD_RUNS_SCHEMA_SQL` bootstrap
(`packages/app-shell/src/assistant-memory-repository.ts`, memoized per DB handle
in the `assistantThreadSchemaInitPromises` WeakMap and awaited by every
repository method). They have NO numbered migration, and must not get one: both
carry `ON DELETE CASCADE` FKs to parents no migration creates (the Mastra
threads table, and the runs row itself). An FK-less migration would either
break the bare-PGlite migration suite or permanently diverge fresh-vs-upgraded
installs and leak orphan rows — the same trade-off `brainstrike_assistant_edit_checkpoints`
resolved in the other direction by deliberately dropping its FKs for migration 052.

Do NOT confuse these with `brainstrike_assistant_run_outcomes`, which IS
migration-backed (062, registered in both runners) *and* mirrored in the
bootstrap SQL.

The desktop MAIN process has THREE writers against these relations, none of
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
  reaches a terminal status.

Neither carve-out is a regression introduced alongside this ruling, and neither
is currently worth runtime machinery — but they are why the provenance invariant
carries the weight here rather than error surfacing. If provenance is ever
broken, expect partial silence, not a clean failure. Paired test (clean-stream
path only): `apps/desktop/src/__tests__/assistant-server/run-event-schema-provenance.integration.test.ts`.

### RUN ERROR PROVIDER FORENSICS (Flight Recorder P3)

`brainstrike_assistant_run_errors` is the durable one-row-per-run provider
failure summary (migration 076, registered in both runners and mirrored
byte-for-byte in `ASSISTANT_THREAD_RUNS_SCHEMA_SQL`). It is deliberately
separate from both the run-event timeline and app-wide diagnostic events:
`run_events` describes lifecycle presentation, while `run_errors` retains the
terminal classification and bounded provider response evidence needed for
forensics.

The numbered migration cannot add an FK to the renderer-lazy
`brainstrike_assistant_thread_runs` parent. The canonical
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
`packages/app-shell/src/__tests__/assistant-memory-repository.integration.test.ts`,
and the desktop/renderer clear integration suites.

---

## SYNC-THE-MIND OP-LOG SEAM (BST-993)

Per the 2026-07-28 BST-911 ruling, future sync covers the "mind" —
threads/memory/prompts — never vectors/HNSW. The groundwork laid here is a
tombstone seam, deliberately nothing more (no engine choice, no write-path op
emission — that is engine territory):

- **Where state lives:** `brainstrike_mind_ops` (migration 079 in BOTH
  runners; also bootstrapped by the assistant memory repository for the
  bare-PGlite harness — keep the shapes byte-identical). Append-only:
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
- **Reset:** registered in the reset registry — the op-log is cleared with
  the mind it describes on all three clear paths.

Paired tests: `migration-079-mind-ops-log.test.ts`, the tombstone cases in
`assistant-memory-repository.integration.test.ts`,
`pglite-memory-store.integration.spec.ts`, and
`prompt-item-repository.test.ts`.

## CONVERSATION REWIND TOMBSTONES (BST-1115)

Soft rewind hides a contiguous suffix of a thread without destroying it, so a
one-level redo is exact and the messages only die when the next user message
finalizes the rewind.

- **Where state lives:** `brainstrike_assistant_message_tombstones` (migration
  080 in BOTH runners plus the byte-identical app-shell bootstrap mirror; no
  FKs — migration 055 message-parents precedent, since numbered migrations run
  against a bare schema with no Mastra tables). Columns:
  `message_id` (PRIMARY KEY), `thread_id`, `rewind_id` (NOT NULL),
  `revert_id` (NULLABLE), `tombstoned_at`. Indexed on `(thread_id)` for the
  read-path anti-join and `(rewind_id)` for batch redo. Registered in
  `THREAD_DELETE_SIDECAR_TABLES` (all three thread-delete cascades derive from
  it) and in the reset registry.
- **Two batch ids, because rewind has a scope choice.** `applyRewind` takes
  `mode: 'conversation-only' | 'conversation-and-files'`. `rewind_id` is the
  tombstone batch identity and the redo key, present in BOTH modes;
  `revert_id` links the paired edit-checkpoint journal file revert and is NULL
  for `conversation-only`, which performs no file revert at all. One shared
  column would force either a fabricated revert id or a nullable redo key —
  and a nullable redo key is how a batch gets lost.
- **`message_id` is the primary key on purpose.** A message is tombstoned at
  most once, by exactly one batch — that is what makes "delete the newest
  `rewind_id` batch" an exact inverse. A second rewind re-covering an already
  hidden message keeps the ORIGINAL batch's row (`ON CONFLICT DO NOTHING`), so
  undoing the newer rewind cannot resurrect what the older one hid.
- **THE FILE-REVERT RANGE ANCHORS THE TARGET MESSAGE AGAINST `completed_at`**
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
  **Run -> message is the inverse that does NOT round-trip**: no column links a
  run to the message whose turn it belongs to, so `resolveRewindMessageForRun`
  maps a MID-TURN run to the next turn's message and the rewind covers less than
  that run. Under-revert is the safe direction and the modal shows the resolved
  range; closing it needs a stored run<->turn link, not another timestamp rule.
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
  4. `app-shell assistant-memory-repository.listMessages` — the renderer
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

## TASK LEDGER (RUN OUTCOMES + LEDGER READ MODEL)

Per-run cost/outcome analytics over tables the assistant already writes.

- **Outcome labels:** `brainstrike_assistant_run_outcomes` (migration 062 +
  byte-identical bootstrap in `ASSISTANT_THREAD_RUNS_SCHEMA_SQL`; no FKs, purged
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
`packages/app-shell/src/__tests__/run-ledger-row.test.ts`, the run-outcome and
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
- View prefs (`groupBy`, independent `flatSortBy` / `groupedSortBy`, collapsed)
  persist via zustand `persist` (`brainstrike-assistant-thread-groups-v1`, state
  version 2); the store registers a session resetter in
  `register-factory-reset-session-stores.ts`.
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
disagree) → drop resolution `threads-panel-dnd.ts` (pure intent reducer) →
element wiring `threads-panel-dnd-elements.tsx`.

Cost of that ownership: a checkbox toggle or Show more now re-renders all of
`ThreadsPanel` rather than only `ThreadPanelTree`. `buildThreadPanelVisibleRows`
is memoized on the same deps, so this is render breadth, not recomputation —
fine at user-paced click rates, worth revisiting if the panel grows. Semantic color presentation is
owned once in `assistant-thread-presentation.ts` and shared by rows, folders,
and tabs. Keyboard/a11y fallback for
every drag operation: row context-menu "Move to <group>" / "Remove from Group".

Paired tests: `migration-054-assistant-thread-groups.test.ts` and
`migration-056-assistant-thread-group-presentation.test.ts` (packages/db),
`assistant-thread-groups-repository.test.ts`, `assistant-thread-groups-store.test.ts`,
`thread-list-sections.test.ts`, `threads-panel-dnd.test.ts`, and the
`ThreadsPanel groups` suite in `threads-panel.test.tsx`.

## TOOL OUTPUT ARTIFACT PERSISTENCE

Migration 068 and `ToolOutputArtifactRepository` own complete oversized tool
results independently of Mastra message rows:

- `brainstrike_assistant_tool_output_artifacts.content` is `BYTEA`, populated
  from exact UTF-8 bytes through hex text + PostgreSQL `decode`; this preserves
  U+0000 and avoids typed-array realm drift across browser workers and Electron
  IPC.
- The public id is an opaque uuidv7 token. Every read also requires the active
  `resource_id` and `thread_id`; a wrong scope is indistinguishable from a
  missing artifact. `run_id` and `tool_call_id` retain execution provenance,
  with one stored result per scoped tool call.
- Range reads are byte-addressed and capped by the shared 8000-byte page
  maximum. The repository returns bytes; the future reader/resolver owns
  UTF-8-boundary adjustment and signed/opaque cursor validation.
- Retention is seven days. `purgeExpired` deletes an explicitly bounded batch
  in oldest-first order. Expired reads return metadata without content.
- Storage, reads, and purge failures use a typed visible error. Settlement must
  finish the complete write before publishing an artifact envelope; it must
  never substitute a reference after a failed write.
- Exact replay of `(resource, thread, run, tool call)` returns the existing
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
so runtime state is not discarded, and a colored thread supplies the canonical
accent from `assistant-thread-presentation.ts` rather than a tab-local palette.
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
`use-assistant-thread-root-binding.test.ts`.

---
