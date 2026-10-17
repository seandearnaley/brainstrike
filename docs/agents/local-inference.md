# Local inference

## Execution boundary

Local inference means EMBEDDINGS. It runs only in hidden renderer hosts on
desktop, never Electron main or a thread serving UI/log/client protocol. Main
owns lifecycle and authorized IPC. Hidden preloads expose only their role's
request/report, metadata, preferences and logging capabilities; no secrets or
general database or storage bridge. Web runs embeddings in its browser-safe
runtime.

There is no built-in local CHAT model on either shell. The `local` provider
declares `capabilities.llm: false`, and the engine that backed it (Gemma 4 E2B
through transformers.js), its `llm-host` renderer role and the whole generation
transport were retired: a 131072-token declared window that had to be
contradicted by an 8192-token runtime budget because the WebGPU prefill
allocates an O(seq^2) attention buffer, tool calling that never became
reliable, and no token streaming. `createProvider('local')` refuses, derived
from that capability rather than from the provider's name.

The hidden inference host document (`embedding-host`) is cross-origin
isolated: the renderer protocol and the Vite dev server send them COOP and COEP,
and COEP on every other bundled response so their workers start (BST-1999). ONNX
Runtime then chooses its own WASM thread count; nothing sets `numThreads`. The
visible document stays unisolated because it frames the Canvas and MCP App shells.
`rendererIsolationHeaders` is the one policy.

The visible renderer starts no duplicate embedding worker. Query and document
inference share the hidden runtime's physical owner and serialization.

## Model identity

Resolve the selected profile through the existing catalog/plan and credential
owners. Preserve model, optional immutable revision, device, dtype, pooling and
actual dimensions through every hop. Do not invent pins, substitute models,
relabel a warm service or silently change its backend. Completion metadata,
cardinality and finite vector values must validate before publication. Explicit
revisions reach every vendor load/probe and cache key so cached models reopen
offline. Text-only search never initializes inference.

Device preferences have one canonical record shared through role-scoped
capabilities. A missing or failed preference read is not an implicit WebGPU choice.
Keep provider credentials out of local host payloads and diagnostic content.

## Cancellation and retirement

Keep AbortSignal process-local; bridges carry a validated request token. Cancel
only its exact admitted owner and refuse replayed tokens. Sending cancellation is
not completion: public promises settle after physical inference or joined host
retirement, retaining independent generate/cancel/join errors. Stale callbacks
cannot release replacement ownership or publish vectors.

On genuine GPU device loss, retire the existing worker; the next explicit request
acquires a clean runtime. Do not replay that request or select another backend.
Healthy model changes reuse their device. Terminal retirement fences admission
before cleanup and retains a failed owner until settlement/retry policy resolves it.

## Background work

Unmount/detach releases a subscriber, not longer-lived work. Explicit Stop,
disable, pause and reset reach the actual runtime and join it. Preserve generations
across late acquisition and completion; foreground admission must not race the
physical background/inference owner. Use the existing QoS and permit primitives,
not a new scheduler or pacing delay. Log bounded stage/identity information,
never text, vectors, endpoints or credentials.

## Liveness

A document batch's host deadline is an inactivity window. Model setup (coalesced
Transformers.js progress) and each completed slice re-arm it; nothing lengthens it or
adds a second timer. A batch that goes silent fails as the `embedding-host.unresponsive`
refusal, and the native index blocks as `embedding-host-unresponsive` with the stage
and elapsed time in plain words (the request id stays in the log). Only the person's
Retry indexing recovers it: the host's owner restarts it, then the failed generation
re-opens. Nothing restarts automatically, and a second hang blocks again (BST-2104).

Decision: [ADR-0007](../adr/0007-local-inference-placement.md) — its
local-chat-placement half is now history; its embedding-placement rules above
are live. Implementation: `packages/embeddings`, `packages/embedding-worker`,
`packages/queue` and desktop hidden-host adapters. The on-device EMBEDDING
model the assistant's semantic recall uses is
`packages/agent/src/providers/local/local-host-embedding-model.ts`.
