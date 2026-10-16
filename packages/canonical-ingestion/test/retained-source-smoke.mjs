import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CanonicalIngestionHost, createNodeChunker } from '@brainstrike/canonical-ingestion';

assert.equal(globalThis.window, undefined);
assert.equal(globalThis.self, undefined);
const recorded = JSON.parse(
  await readFile(
    new URL('../../indexer/__tests__/fixtures/canonical-provided-chunks.json', import.meta.url),
    'utf8'
  )
);
const scope = { embeddingSetId: 'retained-collection', kind: 'collection' };
const file = {
  embeddingSetId: scope.embeddingSetId,
  fileId: recorded.fileId,
  fileName: 'artifact-reader-model-projection.ts',
  relativePath: null,
  rootId: null,
  sourcePath: null,
  stat: { mtimeMs: null, size: Buffer.byteLength(recorded.content) },
};
const ticket = { generation: 1, requestId: 'artifact-scan', scope, storeId: 'controlled-sink' };
let published;
let completed;
let retained;
const host = new CanonicalIngestionHost({
  catalog: {
    async applyManagedCacheBatch(request) {
      retained = request.files[0];
    },
    async completeFiles(request) {
      completed = request.files[0];
    },
    async loadAuthorizedBatch() {
      return [{ ...file, chunksProcessed: false, contentHash: recorded.sourceHash }];
    },
    async prepareManagedSourcesBatch() {
      assert.fail('Registered source requested new identity preparation.');
    },
    async removeFiles() {
      assert.fail('Unexpected removal.');
    },
    async resolveProfile() {
      assert.fail('TEXT resolved a model profile.');
    },
  },
  chunker: createNodeChunker({ parser: 'oxc' }),
  publication: {
    async abortScan() {
      assert.fail('Unexpected cancellation.');
    },
    async beginScan() {
      return ticket;
    },
    async commitTextFile(request) {
      published = request;
    },
    async finishScan(request) {
      assert.equal(request.full, true);
      assert.equal(request.aborted, false);
      assert.deepEqual(request.errors, []);
      assert.deepEqual(request.files, [{ ...file, contentHash: recorded.sourceHash }]);
      return { reason: 'complete', scanComplete: true, ticket };
    },
    async removeFile() {
      assert.fail('Unexpected removal.');
    },
    async verifyManifest() {
      return {
        changed: [],
        complete: false,
        missing: [{ ...file, contentHash: recorded.sourceHash }],
        storeId: ticket.storeId,
        unexpected: [],
      };
    },
  },
  source: {
    async close() {},
    async *discover() {
      yield { files: [file], removed: [] };
      return { errors: [], full: true, truncatedDirectories: [] };
    },
    async read() {
      return { content: recorded.content, stat: file.stat };
    },
  },
});
await host.scan({
  batchSize: 64,
  chunkingOptions: { maxTokens: 256, strategy: 'auto', tokenTrueSizing: true },
  maxFileBytes: 100_000,
  requestId: ticket.requestId,
  scope,
});
assert.deepEqual(published.file, file);
assert.deepEqual(published.payload.providedChunks, recorded.result.chunks);
assert.equal(published.payload.syntax.symbols[0].fileRecordId, recorded.fileId);
assert.equal(published.payload.syntax.refs.length, recorded.result.symbolRefs.length);
assert.equal(retained.content, recorded.content);
assert.equal(retained.contentHash, recorded.sourceHash);
assert.deepEqual(completed, {
  chunkCount: recorded.result.chunks.length,
  contentHash: recorded.sourceHash,
  fileId: recorded.fileId,
});
await host.close();
process.stdout.write(
  `${JSON.stringify({ builtNodeEntry: true, canonicalParity: true, chunks: completed.chunkCount, rootlessCollection: true })}\n`
);
