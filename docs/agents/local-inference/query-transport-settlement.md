# Query transport physical settlement

The public query promise owns its hidden renderer inference until matching terminal completion or joined host retirement. Caller cancellation keeps the exact reason; independent inference and retirement failures remain visible.

The main query channel previously released its pending entry and rejected as soon as it sent cancel. The renderer owner still retained inference, so assistant Stop could join the tool promise before physical inference ended. The document transport already owned the necessary interruption and retirement joins.

Query now uses that same interruption algorithm and shared retirement owner, with runtime/request correlation and its own serialized cancellation code. Query and document keep their distinct generation methods and payloads. Cooperative cancellation does not retire siblings; timeout, failed delivery or failed lifecycle containment uses the shared host Stop/retirement and reports affected sibling outcomes honestly. Stop, reset, restart, load failure, close, crash and shutdown reject only at the appropriate physical boundary. New admission to an errored host joins its unresolved inference owner before lifecycle replacement. Existing 10s Stop, 3s shutdown and 30s reset budgets remain unchanged. Failed destruction stays owned and retryable.

Causal controls cover held query completion, exact caller reasons, unrelated AbortError, synchronous cancel response, sender/runtime fences, capacity, timeout/send failure, renderer exit, lifecycle joins, Stop/destruction/retry aggregation and document siblings. Real renderer runtime plus public SimpleEmbeddingService uses a controlled held queue to prove the public request remains pending while physical queue work continues. The unchanged document settlement suite protects accepted behavior. These controls establish ownership; actual model/GPU reclamation and complete assistant Stop/platform qualification remain separate acceptance.

Ticket: BST-1920. CI is disabled due to cost; validation must run locally.
