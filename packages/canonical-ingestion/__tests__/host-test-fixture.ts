/** Shared canonical ingestion host fixtures for the host suites. */
import { readFile } from 'node:fs/promises';
import { createNodeChunker } from '@brainstrike/chunking-worker/node';
import { vi } from 'vitest';
import { CanonicalIngestionHost } from '../src/host.js';
import type {
  CanonicalCatalogFile,
  CanonicalCatalogPort,
  CanonicalDiscoveredSourceFile,
  CanonicalDiscoveryCompletion,
  CanonicalPublicationPort,
  CanonicalScanRequest,
  CanonicalScanTicket,
  CanonicalSourceFile,
  CanonicalSourcePort,
  CanonicalSourceScope,
} from '../src/ports.js';

export function deferred(): {
  promise: Promise<void>;
  reject: (error: unknown) => void;
  resolve: () => void;
} {
  let resolve = (): void => {};
  let reject = (_error: unknown): void => {};
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}
export async function fixture(
  scope: CanonicalSourceScope = { kind: 'workspace', rootId: 'root' },
  /** A workspace's partition; null is the TEXT partition (BST-1988). */
  membership: string | null = scope.kind === 'collection' ? scope.embeddingSetId : 'managed-set'
) {
  const recorded = JSON.parse(
    await readFile(
      new URL('../../indexer/__tests__/fixtures/canonical-provided-chunks.json', import.meta.url),
      'utf8'
    )
  ) as {
    content: string;
    fileId: string;
    relativePath: string;
    sourceHash: string;
    result: { chunks: unknown[]; symbols: unknown[]; symbolRefs: unknown[] };
  };
  const file: CanonicalSourceFile = {
    embeddingSetId: membership,
    fileId: recorded.fileId,
    fileName: 'artifact-reader-model-projection.ts',
    relativePath: scope.kind === 'workspace' ? recorded.relativePath : null,
    rootId: scope.kind === 'workspace' ? scope.rootId : null,
    sourcePath: scope.kind === 'workspace' ? recorded.relativePath : null,
    stat: { mtimeMs: 123, size: Buffer.byteLength(recorded.content) },
  };
  const catalogFile: CanonicalCatalogFile = {
    ...file,
    chunksProcessed: false,
    contentHash: recorded.sourceHash,
  };
  const ticket: CanonicalScanTicket = {
    generation: 1,
    requestId: 'scan-1',
    scope,
    storeId: 'store',
  };
  const order: string[] = [];
  let aborted = false;
  const completion: CanonicalDiscoveryCompletion = {
    errors: [],
    full: true,
    truncatedDirectories: [],
  };
  const source: CanonicalSourcePort = {
    close: vi.fn(async () => {}),
    async *discover() {
      yield { files: [file], removed: [] };
      return completion;
    },
    read: vi.fn(async () => ({ content: recorded.content, stat: file.stat })),
  };
  const catalog: CanonicalCatalogPort = {
    applyManagedCacheBatch: vi.fn(async () => {}),
    completeFiles: vi.fn(async () => {}),
    loadAuthorizedBatch: vi.fn<CanonicalCatalogPort['loadAuthorizedBatch']>(async (request) =>
      request.files.map((entry) => ({ ...catalogFile, ...entry }))
    ),
    prepareManagedSourcesBatch: vi.fn(async () => {
      throw new Error('Registered source unexpectedly requested new identity preparation.');
    }),
    removeFiles: vi.fn(async () => {
      order.push('catalog-remove');
    }),
    resolveProfile: vi.fn(async () => {
      throw new Error('TEXT must never resolve a model profile.');
    }),
  };
  const publication: CanonicalPublicationPort = {
    abortScan: vi.fn(async () => {
      aborted = true;
    }),
    beginScan: vi.fn(async () => ticket),
    commitTextFile: vi.fn(async () => {}),
    finishScan: vi.fn<CanonicalPublicationPort['finishScan']>(async (request) => ({
      reason:
        aborted || request.aborted
          ? 'aborted'
          : request.errors.length > 0
            ? 'scan-errors'
            : request.truncatedDirectories.length > 0
              ? 'truncated'
              : 'complete',
      scanComplete:
        !(aborted || request.aborted) &&
        request.errors.length === 0 &&
        request.truncatedDirectories.length === 0,
      ticket,
    })),
    removeFile: vi.fn(async () => {
      order.push('native-remove');
    }),
    verifyManifest: vi.fn(async () => ({
      changed: [],
      complete: false,
      missing: [{ ...file, contentHash: recorded.sourceHash }],
      storeId: 'store',
      unexpected: [],
    })),
  };
  const request: CanonicalScanRequest = {
    batchSize: 64,
    chunkingOptions: { maxTokens: 256, strategy: 'auto', tokenTrueSizing: true },
    maxFileBytes: 100_000,
    requestId: 'scan-1',
    scope,
  };
  const host = new CanonicalIngestionHost({
    catalog,
    chunker: createNodeChunker({ parser: 'oxc' }),
    managedCollectionId: membership,
    publication,
    source,
  });
  return {
    catalog,
    catalogFile,
    completion,
    file,
    host,
    order,
    publication,
    recorded,
    request,
    source,
    ticket,
  };
}

export async function discoveredFixture(membership?: string | null) {
  const f = await fixture(undefined, membership);
  const discovered: CanonicalDiscoveredSourceFile = {
    fileName: f.file.fileName,
    relativePath: f.recorded.relativePath,
    rootId: 'root',
    sourcePath: f.recorded.relativePath,
    stat: f.file.stat,
  };
  f.source.discover = async function* () {
    yield { discovered: [discovered], files: [], removed: [] };
    return f.completion;
  };
  vi.mocked(f.catalog.prepareManagedSourcesBatch).mockResolvedValue([
    { ...f.file, contentHash: f.recorded.sourceHash },
  ]);
  return { ...f, discovered };
}
