# Image attachments end to end — evidence

Supports `docs/agents/assistant-persistence.md` §
"ASSISTANT THREAD PERSISTENCE & RELOAD HYDRATION". Read this before proposing to change the attachment caps, the persisted file dialect, the wire history bound, or the vision gate.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

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

