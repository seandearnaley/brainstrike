# @brainstrike/canonical-ingestion

`CanonicalIngestionHost` and `CanonicalWorkspaceIngestionRuntime` run bounded source scans from the utility process or a standalone Node owner: read authorized source, hash the original text, apply admitted catalog/source changes, run the production Node chunker and publish its exact chunks and graph.

## Authority and publication

- Catalog, source, writer/receipt and inference ports keep separate responsibilities; the catalog adapter borrows the host's existing owner.
- A scan covers one workspace folder; canonical IDs stay explicit. TEXT mode does no model/profile resolution or inference.
- Ordering:
  - Catalog completion follows acknowledged native publication.
  - Native removal precedes catalog invalidation.
  - A path match, partial inventory or progress event never authorizes removal or proves completion.
- Discovered files without a canonical ID count against the same batch bound.
  - After the secure read/hash, `prepareManagedSourcesBatch` uses the existing identity owner and awaits trusted native binding acknowledgement.
  - Only an exact identity/hash reply is publishable; missing, extra, repeated or mismatched replies refuse before parsing.
- `canonicalIndexPublication` forwards the canonical producer's chunks unchanged (hashes, line/offset spans, token metadata, symbols and references); invalid sources or results never fall back to line chunks.

## Lifetime

- Scan admission is fenced while physical work is owned.
- `cancel(requestId)` aborts the exact generation and joins reads, parsing, publication, discovery retirement and receipt completion.
- `abortScan(ticket)` is the plain-token sink operation, including during manifest verification.
- AbortSignals stay local; transports carry validated cancellation tokens. Held source preparation is joined before scan retirement.
- Discovery/watch reuses the existing scanner through its utility adapter.
- Desktop wiring: [`canonical-utility-child.ts`](../../apps/desktop/src/canonical-utility-child.ts) and [`canonical-utility-parent.ts`](../../apps/desktop/src/canonical-utility-parent.ts).
- Contract: [indexer](../../docs/agents/indexer.md).
