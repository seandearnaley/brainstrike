# @brainstrike/indexer

A Node-only, rebuildable SQLite index with one writer process and authorized
readers. It does no inference and is separate from the canonical host StateStore
and committed conversation log.

## Acquire the existing owner

`openIndexer(options, deadlines)` launches the package process entry and compiled
writer worker. Desktop uses the explicit Electron utility-process adapter in
[`indexer-host-manager.ts`](../../apps/desktop/src/indexer-host-manager.ts).
Both transports share the same process core. Desktop native-index wiring is
implemented; the original foundation-stage “cutover pending” notes are historical.

The public shapes live in [`contracts.ts`](src/contracts.ts) and
[`index.ts`](src/index.ts). Opening specifies the owned database path, authorized
roots/scopes and an explicit mode: `text-only` creates the index and
`open-existing` requires an existing one. The owner supplies the close window, `closeMs`: from the close request
to the exit, after which the process is killed and its exit still joined. Startup
and requests have no deadline: the process is retired only on its exit or a transport
or protocol fault, never because it is slow.

## Publish and read

Forward the canonical producer's unchanged chunks, source spans, hashes and syntax
metadata through `prepareFile`/`prepareScopedFile`; do not reparse or split them.
The standalone line-chunk preparation API has an explicit caller line policy and
does not prove a tokenizer limit.

A prepared plan captures the previous snapshot. `commitTextFile` commits a
root-list file's text and syntax; scoped publication validates that authority and
commits text, vectors and syntax together. Publication acknowledgements, source
scan completion and coverage are different facts.

The root-list API is text-only. The scoped desktop API carries the full
`VectorProfile` (provider, model, dimensions and distance) for each
binding/request, and vectors are partitioned by its `vectorProfileHash`. Vector
reuse requires matching text and profile identity.

BM25/trigram reads need text; scoped vector reads need the admitted profile and vector.
Authorize the roots/scopes before ranking, retain canonical hit metadata and exact
rescoring, and expose incomplete coverage honestly. Hybrid fusion belongs to the
consumer's explicit retrieval policy. State-message/observation projections are
also derived indexes, not another transcript writer.

## Retirement and rebuild

Unsupported profile/schema acquisition refuses visibly; opening never deletes the
index. Supported schema construction is owned by
[`index-metadata.ts`](src/index-metadata.ts) and the store acquisition code.
A rebuild preserves canonical chats/catalog/configuration.

`close()` joins the physical process. `destroy()` joins it before deleting its
owned database, WAL and shared-memory files. The close window runs from the close
request to the exit; a process still running then is killed, and only its exit ends
it. A refused kill is logged, never a fault (ADR-0030).

## Development

Build and check with this package's configured `build`, `test`, `test:integration`
and `type-check` scripts. Integration checks require actual native dependencies.
**CI is disabled due to cost; validation must run locally.** Use
`pnpm check`.

Contract: [indexer](../../docs/agents/indexer.md).
Decision: [ADR-0018](../../docs/adr/0018-derived-sqlite-indexer.md).
