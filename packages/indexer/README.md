# @brainstrike/indexer

A Node-only, rebuildable SQLite index (FTS/trigram text plus `sqlite-vec` vectors) with one writer process and authorized readers. It does no inference and is separate from the host StateStore and conversation log.

## Opening

- `openIndexer(options, deadlines)` forks the package's process entry, which runs the writer worker. Desktop uses the Electron utility-process adapter in [`indexer-host-manager.ts`](../../apps/desktop/src/indexer-host-manager.ts); both share the same process core.
- Shapes: [`contracts.ts`](src/contracts.ts), [`index.ts`](src/index.ts).
- Options name the owned database path, authorized roots/scopes and a mode: `text-only` creates the index; `open-existing` requires one.
- Deadlines: the owner supplies `closeMs`, the window from close request to exit, after which the process is killed and its exit still joined. Startup and requests have no deadline; the process is retired only on exit or a transport/protocol fault, never for being slow.

## Publish and read

- Forward the canonical producer's chunks, spans, hashes and syntax metadata unchanged through `prepareFile`/`prepareScopedFile`; never reparse or split.
- The standalone line-chunk API takes an explicit line policy and doesn't prove a tokenizer limit.
- A prepared plan captures the previous snapshot.
  - `commitTextFile` commits a root-list file's text and syntax (text-only).
  - Scoped publication validates authority and commits text, vectors and syntax together.
  - Publication acknowledgement, scan completion and coverage are different facts.
- Vectors: each scoped binding carries the full `VectorProfile` (provider, model, dimensions, distance) and is partitioned by `vectorProfileHash`; reuse needs matching text and profile.
- Reads:
  - BM25/trigram need text; scoped vector reads need the admitted profile.
  - Authorize roots/scopes before ranking, keep canonical hit metadata and exact rescoring, and report incomplete coverage.
  - Hybrid fusion belongs to the consumer's retrieval policy.
- State-message and observation projections are derived indexes, not another transcript writer.

## Retirement and rebuild

- An unsupported profile or schema refuses visibly; opening never deletes the index. Schema construction lives in [`index-metadata.ts`](src/index-metadata.ts).
- A rebuild preserves canonical chats, catalog and configuration.
- `close()` joins the process; `destroy()` joins it, then deletes the database, WAL and shared-memory files. A refused kill is logged, never a fault (ADR-0030).
- Contract: [indexer](../../docs/agents/indexer.md). Decision: [ADR-0018](../../docs/adr/0018-derived-sqlite-indexer.md).
