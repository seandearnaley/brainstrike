# Query transport physical settlement

The public query promise owns its hidden renderer inference until matching terminal completion or joined host retirement. Caller cancellation keeps the exact reason; independent inference and retirement failures remain visible.

The main query channel previously released its pending entry and rejected as soon as it sent cancel. The renderer owner still retained inference, so assistant Stop could join the tool promise before physical inference ended. The document transport already owned the necessary interruption and retirement joins.

Query now uses that same interruption algorithm and shared retirement owner, with runtime/request correlation and its own serialized cancellation code. Query and document keep their distinct generation methods and payloads. Cooperative cancellation does not retire siblings; timeout, failed delivery or failed lifecycle containment uses the shared host Stop/retirement and reports affected sibling outcomes honestly. Stop, reset, restart, load failure, close, crash and shutdown reject only at the appropriate physical boundary. New admission to an errored host joins its unresolved inference owner before lifecycle replacement. Existing 10s Stop, 3s shutdown and 30s reset budgets remain unchanged. Failed destruction stays owned and retryable.

Causal controls cover held query completion, exact caller reasons, unrelated AbortError, synchronous cancel response, sender/runtime fences, capacity, timeout/send failure, renderer exit, lifecycle joins, Stop/destruction/retry aggregation and document siblings. Real renderer runtime plus public SimpleEmbeddingService uses a controlled held queue to prove the public request remains pending while physical queue work continues. The unchanged document settlement suite protects accepted behavior. These controls establish ownership; actual model/GPU reclamation and complete assistant Stop/platform qualification remain separate acceptance.

Ticket: BST-1920. CI is disabled due to cost; validation must run locally.

## 2026-10-03: worker cancellation reason propagation

The actual semantic Stop qualification at `d3fc35ca060235e4c81c96e2b07f7f953b7e4de0` held the real pinned MiniLM worker submission, observed its matching hidden cancellation while the request remained owned, and then released the unchanged RPC. The worker physically settled with a plain `AbortError`; the hidden terminal report lost `EMBEDDING_HOST_QUERY_CANCELED`, so the strict Stop assertion failed. Raw evidence remains in `m2-semantic-prefixed-submission-stop-20261004T020825Z-86758ed7` under the external desktop acceptance directory.

The worker now identifies its own request-control cancellation with an explicit discriminator and task ID, which workerpool preserves through its own-property Error serialization. The queue restores the owning signal's original reason only after that matching worker rejection settles. Pre-aborted admission and cancellation after successful physical work use the same signal reason. Ordinary failures, unrelated `AbortError`s and cancellations belonging to another task remain unchanged. No cancellation race, queue ownership, physical join, worker lifetime or qualification guard is weakened.
