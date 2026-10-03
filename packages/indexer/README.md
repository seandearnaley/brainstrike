# @brainstrike/indexer

Independent Node-only derived index. Build with
`pnpm exec turbo run build --filter=@brainstrike/indexer`; import the emitted
public package. `openIndexer()` forks `dist/process-entry.js`, which launches
`dist/writer-worker.js`. The Electron utility-process adapter and product
cutover are separate work.

```ts
import { openIndexer } from '@brainstrike/indexer';

const profile = {
  modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
  revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
  dtype: 'fp16',
  dimensions: 384,
  tokenCap: 256,
} as const;
const indexer = await openIndexer({
  dbPath: '/owned/data-root/derived-index.sqlite',
  profile,
  rootIds: ['authorized-workspace-root'],
});
const plan = await indexer.prepareFile({
  rootId: 'authorized-workspace-root',
  fileId: 'canonical-file-record-id',
  relativePath: 'src/example.ts',
  content: sourceText,
  chunkLines: explicitChunkLinePolicy,
});
// Hidden renderer producer supplies one vector per embeddingChunkId, carrying
// the exact profile above. Forward existing parser metadata; do not parse again.
await indexer.commitFile({ plan, profile, embeddings, syntax });
const result = await indexer.search({
  mode: 'bm25', rootIds: ['authorized-workspace-root'], text: 'example', limit: 10,
});
await indexer.close();
```

`prepareFile` returns byte-preserving line chunks, stable `chunkId`, text/profile
hashes, missing `embeddingChunkIds`, and a previous snapshot hash. A concurrent
commit invalidates an older preparation. Line count is an explicit caller policy
and does not guarantee a tokenizer cap; the producer owns tokenization/inference.

`commitFile` receives `{plan,profile,embeddings,syntax?}`. Every requested chunk
requires exactly one finite, nonzero 384-dimensional Float32 vector. Syntax uses
canonical `FileSymbolInsert`/`FileSymbolRefInsert` field names; omitted syntax
retains metadata for unchanged content and clears it for changed content.
Commit results report `writtenChunks`, `reusedEmbeddings`, `writtenSymbols`,
`writtenRefs`, `syntaxStatus` and `unchanged`. `removeFile({rootId,fileId})`
transactionally removes the file's chunks, vectors and syntax graph.

`search` accepts `bm25` or `trigram` with `text`, or `vector` with a full `profile`
and vector. Each request names a subset of the roots authorized at open and a
limit from 1 to 100. Results contain `profileHash`, `candidateCount` and ordered
hits with `chunkId`, `rootId`, `fileId`, `relativePath`, source line span, content
and score. Scores sort ascending: native BM25 or cosine distance. Vector coarse
selection retains at most 100 candidates per requested root before exact
rescoring; hybrid fusion belongs to a consumer with an explicit quality policy.

Profile/schema mismatches raise `IndexerError` with code `rebuild-required`.
Startup never deletes an existing database. `destroy()` closes and joins the
process before deleting this owned database, WAL and shared-memory files.
Consumers must coordinate their data-root ownership and factory-reset lifecycle.

Qualification:

```sh
pnpm exec turbo run build test test:integration type-check --filter=@brainstrike/indexer --force
```

The integration task is uncached and requires actual native dependencies. See
`docs/agents/indexer.md` and ADR-0018 for the boundary and remaining product gates.
