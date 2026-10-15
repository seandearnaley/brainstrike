# Local inference

## Execution boundary

Embeddings and local LLM generation run only in hidden renderer hosts on desktop,
never Electron main or a thread serving UI/log/client protocol. Main owns lifecycle
and authorized IPC. Hidden preloads expose only their role's request/report,
metadata, preferences and logging capabilities; no secrets or general database
or storage bridge. Web runs embeddings in its browser-safe runtime; it has no
built-in local LLM.

The built-in local LLM provider has exactly ONE engine: the desktop hidden
llm-host, proxied into the ordinary assistant-server run loop by
`LlmHostChatModel`. There is no in-renderer chat runtime and no in-process
model: a host without the llm-host bridge does not offer the `local` provider,
and `createProvider('local')` without an injected `runtime.localLlmHostClient`
throws rather than substituting another engine.

The visible renderer starts no duplicate embedding worker. Query and document
inference share the hidden runtime's physical owner and serialization. Local LLM
generations and disposal are likewise serialized by the backend, not caller locks.

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

Decision: [ADR-0007](../adr/0007-local-inference-placement.md). Implementation:
`packages/embeddings`, `packages/embedding-worker`, `packages/queue` and desktop
hidden-host adapters. Built-in local chat:
`packages/agent/src/providers/local` (engine, backend, `LlmHostChatModel`),
`packages/assistant-ui/src/local-runtime-desktop-host.ts` (renderer-side bridge
probe and model warmup).
