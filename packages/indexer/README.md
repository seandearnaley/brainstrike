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
roots/scopes and an explicit embedding mode: `text-only`, `vector-configured` or
`open-existing`. The last mode requires an existing index. Text-only acquisition
loads no model. Each deadline is a finite positive duration supplied by the owner;
package defaults do not establish product latency policy.

## Publish and read

Forward the canonical producer's unchanged chunks, source spans, hashes and syntax
metadata through `prepareFile`/`prepareScopedFile`; do not reparse or split them.
The standalone line-chunk preparation API has an explicit caller line policy and
does not prove a tokenizer limit.

A prepared plan captures the previous snapshot. `commitFile` or scoped publication
validates that authority and commits text, vectors and syntax together.
`commitTextFile` accepts no embeddings and requires no inference; it retains valid
unchanged vectors and removes stale ones. Publication acknowledgements, source
scan completion and coverage are different facts.

The root-list API uses its qualified 384-dimensional `EmbeddingProfile`; the
scoped desktop API carries the full `VectorProfile` for each binding/request,
including provider, model, dimensions, distance and applicable local model facts.
Vector reuse requires matching text and profile identity. Do not infer one API's
profile limits from the other.

BM25/trigram reads need text; vector reads need the admitted profile and vector.
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
owned database, WAL and shared-memory files. A transport failure or deadline does
not prove retirement: `IndexerLifecycleError` retains the explicit cleanup owner
when termination/join fails. Keep profile/reset ownership until cleanup succeeds.

## Development

Build and check with this package's configured `build`, `test`, `test:integration`
and `type-check` scripts. Integration checks require actual native dependencies.
**CI is disabled due to cost; validation must run locally.** Use
[validation guidance](../../docs/agents/ci-quality.md).

Contract: [indexer](../../docs/agents/indexer.md).
Decision: [ADR-0018](../../docs/adr/0018-derived-sqlite-indexer.md).
