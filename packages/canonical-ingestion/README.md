# Canonical ingestion

`CanonicalIngestionHost` and `CanonicalWorkspaceIngestionRuntime` execute bounded
source scans from a utility or standalone Node owner. They read authorized source,
hash retained original text, apply admitted catalog/source changes, invoke the
production Node chunker and publish its exact chunks and graph.

## Authority and publication

Catalog, source, writer/receipt and hidden inference ports keep separate
responsibilities. Historical PG naming in a port does not select the desktop
storage engine: the current catalog adapter borrows the host's existing owner.
Workspace/collection scopes, actual canonical IDs and nullable standalone
collection root/path metadata stay explicit. TEXT calls neither model/profile
resolution nor inference; this package introduces no engine/model substitution.

Catalog completion follows acknowledged native publication; native removal
precedes catalog invalidation. A path match, partial inventory or progress event
cannot authorize source removal or prove completion.

Discovered workspace files without a canonical ID count against the same batch
bound. After secure original-source read/hash, `prepareManagedSourcesBatch` uses
the existing identity/mutation owner and awaits trusted native binding
acknowledgement. Only its exact identity/hash reply becomes publishable; missing,
extra, repeated or mismatched replies refuse before parsing/publication. Collection
scope does not establish new workspace filesystem membership.

## Lifetime and integration

Scan admission is fenced while physical work is owned. `cancel(requestId)` aborts
the exact generation and joins reads, parsing, publication, discovery retirement
and receipt completion. `abortScan(ticket)` is the plain-token sink operation,
including cancellation during manifest verification. AbortSignals stay local;
transport adapters carry validated cancellation tokens. Held source preparation
is joined before scan retirement.

Discovery/watch/coalescing reuses the existing scanner through its concrete
utility adapter. Desktop wiring lives in
[`canonical-utility-child.ts`](../../apps/desktop/src/canonical-utility-child.ts) and
[`native-canonical-catalog.ts`](../../apps/desktop/src/native-canonical-catalog.ts).
Those source connections replace the old blanket “integration pending” note;
platform/artifact acceptance remains separate from controlled port tests.

[`package.json`](package.json) owns exports/scripts. See
[indexing](../../docs/agents/indexer.md) and
[shared contribution/validation policy](../../AGENTS.md).
