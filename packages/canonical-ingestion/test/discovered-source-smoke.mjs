import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CanonicalIngestionHost, createNodeChunker } from '@brainstrike/canonical-ingestion';

assert.equal(globalThis.window, undefined);
assert.equal(globalThis.self, undefined);
const recorded = JSON.parse(
  await readFile(
    new URL(import.meta.resolve('@brainstrike/test-utils/fixtures/canonical-provided-chunks.json')),
    'utf8'
  )
);
const scope = { kind: 'workspace', rootId: 'controlled-source-root' };
const stat = { mtimeMs: 123, size: Buffer.byteLength(recorded.content) };
const discovered = {
  fileName: 'artifact-reader-model-projection.ts',
  relativePath: recorded.relativePath,
  rootId: scope.rootId,
  sourcePath: recorded.relativePath,
  stat,
};
const canonical = {
  ...discovered,
  embeddingSetId: 'controlled-managed-set',
  fileId: recorded.fileId,
};
const ticket = {
  generation: 1,
  requestId: 'discovery-artifact',
  scope,
  storeId: 'controlled-sink',
};
let bound = false;
let published = false;
let completed = false;
let closed = false;
const host = new CanonicalIngestionHost({
  catalog: {
    async applyManagedCacheBatch() {
      assert.fail('Unresolved source used the registered mutation.');
    },
    async completeFiles(request) {
      assert.equal(published, true);
      assert.deepEqual(request.files, [
        {
          chunkCount: recorded.result.chunks.length,
          contentHash: recorded.sourceHash,
          fileId: recorded.fileId,
        },
      ]);
      completed = true;
    },
    async loadAuthorizedBatch(request) {
      assert.deepEqual(request.files, []);
      return [];
    },
    async prepareManagedSourcesBatch(request) {
      assert.deepEqual(request, {
        files: [{ ...discovered, content: recorded.content, contentHash: recorded.sourceHash }],
        scope,
      });
      assert.equal(Object.hasOwn(request.files[0], 'fileId'), false);
      assert.equal(Object.hasOwn(request.files[0], 'embeddingSetId'), false);
      await Promise.resolve();
      bound = true;
      return [{ ...canonical, contentHash: recorded.sourceHash }];
    },
    async removeFiles() {
      assert.fail('Unexpected removal.');
    },
    async resolveProfile() {
      assert.fail('TEXT resolved a model profile.');
    },
  },
  chunker: createNodeChunker({ parser: 'oxc' }),
  managedCollectionId: canonical.embeddingSetId,
  publication: {
    async abortScan() {
      assert.fail('Unexpected cancellation.');
    },
    async beginScan() {
      return ticket;
    },
    async commitTextFile(request) {
      assert.equal(bound, true);
      assert.deepEqual(request.file, canonical);
      assert.deepEqual(request.payload.providedChunks, recorded.result.chunks);
      assert.equal(request.payload.syntax.symbols[0].fileRecordId, recorded.fileId);
      published = true;
    },
    async finishScan(request) {
      assert.equal(completed, true);
      assert.equal(request.full, true);
      assert.equal(request.aborted, false);
      assert.deepEqual(request.errors, []);
      assert.deepEqual(request.files, [{ ...canonical, contentHash: recorded.sourceHash }]);
      return { reason: 'complete', scanComplete: true, ticket };
    },
    async removeFile() {
      assert.fail('Unexpected removal.');
    },
    async verifyManifest(request) {
      assert.deepEqual(request.files, []);
      return { changed: [], complete: false, missing: [], storeId: ticket.storeId, unexpected: [] };
    },
  },
  source: {
    async close() {
      closed = true;
    },
    async *discover() {
      yield { discovered: [discovered], files: [], removed: [] };
      return { errors: [], full: true, truncatedDirectories: [] };
    },
    async read(file) {
      assert.equal(Object.hasOwn(file, 'fileId'), false);
      return { content: recorded.content, stat };
    },
  },
});
try {
  await host.scan({
    batchSize: 64,
    chunkingOptions: { maxTokens: 256, strategy: 'auto', tokenTrueSizing: true },
    maxFileBytes: 100_000,
    requestId: ticket.requestId,
    scope,
  });
} finally {
  await host.close();
}
assert.equal(closed, true);
process.stdout.write(
  `${JSON.stringify({
    canonicalIdentity: true,
    canonicalParity: true,
    discoveredSource: true,
    joinedClose: true,
    originalSource: true,
  })}\n`
);
