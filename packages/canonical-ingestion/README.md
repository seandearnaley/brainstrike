# Utility canonical ingestion foundation

`CanonicalIngestionHost` executes explicitly bounded TEXT scans from its utility
or standalone Node owner. It reads exact authorized source bindings, hashes the
retained original text, applies source/catalog mutations, invokes the production
Node chunker and publishes its exact chunks/graph. PG completion metadata follows
native publication; native removal precedes catalog invalidation.

The host closes scan admission while physical work is owned. `cancel(requestId)`
aborts the exact local generation and joins reads, parsing, publication, discovery
retirement and receipt completion. `abortScan(ticket)` is a plain-token sink
operation, including when cancellation arrives during manifest verification.
Transport adapters never serialize `CanonicalOperationContext.signal`.

The four public ports separate PG catalog authority, utility source ownership,
the existing writer/receipt owner and the mandatory hidden inference relay.
Workspace/collection scopes and actual canonical IDs stay explicit. Nullable
root/path metadata remains nullable for standalone collections. TEXT never calls
model/profile resolution or inference. The generic inference profile is owned by
the engine; this foundation implements no vector execution or model substitution.

Workspace discoveries without a canonical ID use `CanonicalDiscoveredSourceFile`.
They count against the same scan batch bound and carry only granted source
metadata. After secure original-source read/hash, the required main catalog
`prepareManagedSourcesBatch` commits real source using the existing identity
lookup/UUID/mutation policy and awaits full trusted native binding acknowledgement.
Only its exact canonical identity/hash reply becomes publishable. Missing, extra,
repeated or mismatched bindings fail visibly before parser/native publication.
Cancellation joins a held preparation operation before retiring the scan.
Registered authorization/stat-skip behavior and retained rootless collection
source remain unchanged. Collection scope does not establish new filesystem
membership through this workspace preparation operation.

Actual filesystem discovery/watch/coalescing must reuse the current scanner
algorithm through a concrete utility adapter.
Those adapters, main PG transport, engine scope DTO integration, real utility
process/closed-window proof, reset, packaging and other platforms remain pending.
Controlled port tests are not a claim that those production paths are connected.

CI is disabled due to cost; validation must run locally.
