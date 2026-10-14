# Title generation and desktop stream replay — evidence

Supports `docs/agents/assistant-runtime.md` § "ATTEMPTS VS TURNS".
Read before changing the title-generation join, the replay cursor headers, or `GET /assistant/resume` reconciliation.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 1551-1584), extracted verbatim.

Mastra title generation has its own finish-boundary lifecycle. The PGlite
memory factory opts into top-level `generateTitle`, while
`streamAttemptChunks` starts the public
`Agent.generateTitleFromUserMessage` request before yielding the terminal
finish. The downstream data-stream consumer stops pulling immediately after
that finish, so the generator's `finally` must await the already-started title
task before aborting the internal stream controller or shutting down the
per-run Mastra instance. This wait happens after the finish has reached the UI:
it protects background persistence without adding title-model latency to the
visible assistant response. Approval/suspend terminal parts and memory-free
runs never start the task.

Each desktop response exposes an opaque absolute replay cursor in
`X-Brainstrike-Assistant-Event-Id` and the durable assistant message identity in
`X-Brainstrike-Assistant-Message-Id`. While the run is active, the renderer
stores only `{assistantMessageId, eventId, runId}` in thread-scoped
`sessionStorage`. After history hydration on renderer reload, it reconnects with
`GET /assistant/resume` plus `Last-Event-ID`; it never composes a second model
request. Replay must reuse the durable assistant message ID and its persisted
parent rather than append a duplicate hydrated message. The installed
assistant-ui runtime creates a temporary streaming message for `resumeRun`;
Brainstrike removes the hydrated durable leaf before replay, then reconciles
the history append to the durable ID and maps the temporary local ID back
through the public thread `export`/`import` API after assistant-ui's `runEnd`
event. Waiting for `runEnd` is required because error and incomplete outcomes
can update the local message after the replay iterator closes. Do not patch
assistant-ui internals to add a message-ID input. A missing durable leaf or a
leaf with descendants is a visible replay error, never a guessed parent.
Transient replay
failures receive at most two automatic retries; a missing/expired session is a
visible 404 and clears the stale renderer record. Terminal completion, failure,
or explicit Stop clears the record. The endpoint base must come from the
already-resolved assistant runtime API (`getAuth()`/`getUrl()`), never from the
legacy optional `window.assistant.url` field alone.
