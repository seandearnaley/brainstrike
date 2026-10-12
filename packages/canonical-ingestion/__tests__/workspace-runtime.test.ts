import { expect, it, vi } from 'vitest';
import type { CanonicalWorkspaceRuntimeDependencies } from '../src/workspace-runtime.js';
import { CanonicalWorkspaceIngestionRuntime } from '../src/workspace-runtime.js';

function fixture(): CanonicalWorkspaceRuntimeDependencies {
  return {
    catalog: {
      applyManagedCacheBatch: async () => {},
      completeFiles: async () => {},
      loadAuthorizedBatch: vi.fn(async () => []),
      prepareManagedSourcesBatch: async () => [],
      removeFiles: async () => {},
      resolveProfile: async () => {
        throw new Error('TEXT resolved inference');
      },
    },
    managedCollectionId: 'actual-managed-set',
    onError: vi.fn(),
    onReceipt: vi.fn(),
    onWatchHealth: vi.fn(),
    parser: { parser: 'oxc', treeSitterLanguages: ['python'] },
    publication: {
      abortScan: async () => {},
      beginScan: vi.fn(async (request) => ({ ...request, generation: 1, storeId: 'actual-store' })),
      commitTextFile: async () => {},
      finishScan: async (request) => ({
        reason: 'complete',
        scanComplete: true,
        ticket: request.ticket,
      }),
      removeFile: async () => {},
      verifyManifest: async () => ({
        changed: [],
        complete: true,
        missing: [],
        storeId: 'actual-store',
        unexpected: [],
      }),
    },
    request: { batchSize: 2, chunkingOptions: { strategy: 'auto' }, maxFileBytes: 1024 },
    source: {
      indexingPolicyPreset: 'balanced',
      inventory: {
        loadFiles: vi.fn(async () => []),
        readRetained: async () => {
          throw new Error('Unexpected retained read');
        },
      },
      lease: {
        canonicalPath: '/workspace',
        generation: 'actual-borrow',
        listDir: vi.fn(async () => ({ entries: [], inspected: 0, truncated: false })),
        readFile: async () => {
          throw new Error('Unexpected read');
        },
        retire: vi.fn(async () => {}),
        rootId: 'actual-root',
        signal: new AbortController().signal,
        subscribe: vi.fn(async () => ({ close: vi.fn(async () => {}) })),
      },
    },
  };
}

it('rejects invalid source bounds before catalog preflight or watcher admission', () => {
  const dependencies = fixture();
  expect(
    () =>
      new CanonicalWorkspaceIngestionRuntime({
        ...dependencies,
        request: { ...dependencies.request, batchSize: 0 },
      })
  ).toThrow('finite positive source bounds');
  expect(dependencies.source.lease.subscribe).not.toHaveBeenCalled();
  expect(dependencies.source.inventory.loadFiles).not.toHaveBeenCalled();
});

it('joins revoked catalog preflight without misreporting the exact mount cancellation as cleanup failure', async () => {
  const dependencies = fixture();
  const revoked = new AbortController();
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loadFiles = vi.fn(async () => {
    await held;
    return [];
  });
  const runtime = new CanonicalWorkspaceIngestionRuntime({
    ...dependencies,
    source: {
      ...dependencies.source,
      inventory: { ...dependencies.source.inventory, loadFiles },
      lease: { ...dependencies.source.lease, signal: revoked.signal },
    },
  });
  await runtime.start();
  await vi.waitFor(() => expect(loadFiles).toHaveBeenCalledOnce());
  revoked.abort(new Error('Actual mounted borrow revoked.'));
  let retired = false;
  const retiring = runtime.close().then(() => {
    retired = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(retired).toBe(false);
  release();
  await retiring;
  expect(dependencies.onError).not.toHaveBeenCalled();
  expect(dependencies.publication.beginScan).not.toHaveBeenCalled();
  expect(dependencies.source.lease.retire).toHaveBeenCalledOnce();
});

it('consumes explicit VECTOR dependencies and rejects missing full-root coverage without a ready receipt', async () => {
  const dependencies = fixture();
  const profile = {
    dimensions: 384,
    distance: 'cosine',
    dtype: 'q8',
    modelId: 'Xenova/all-MiniLM-L6-v2',
    provider: 'local',
    revision: 'a'.repeat(40),
    tokenCap: 256,
  } as const;
  const resolveProfile = vi.fn(async () => profile);
  const generate = vi.fn(async () => {
    throw new Error('Empty source must not infer.');
  });
  const proof = {
    authorityEpoch: 'epoch',
    authorityRevision: 1,
    scope: { kind: 'workspace', rootId: 'actual-root' } as const,
    storeId: 'actual-store',
  };
  const runtime = new CanonicalWorkspaceIngestionRuntime({
    ...dependencies,
    catalog: { ...dependencies.catalog, resolveProfile },
    inference: { cancel: async () => {}, generate, join: async () => {} },
    mode: 'VECTOR',
    publication: {
      ...dependencies.publication,
      commitVectorFile: async () => {
        throw new Error('Empty source must not publish vectors.');
      },
      prepareVectorFile: async () => {
        throw new Error('Empty source must not prepare a file.');
      },
      vectorCoverage: async () => ({
        ...proof,
        counts: { chunks: 0, indexedFiles: 0, missingVectors: 0, vectors: 0 },
        profile,
        profileHash: 'profile',
        vectorCoverageComplete: false,
      }),
      verifyVectorManifest: async () => ({
        ...proof,
        changed: [],
        complete: true,
        missing: [],
        unexpected: [],
      }),
    },
  });
  await runtime.start();
  await vi.waitFor(() => expect(dependencies.onError).toHaveBeenCalled());
  expect(resolveProfile).toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
  expect(dependencies.onReceipt).not.toHaveBeenCalled();
  await runtime.close();
});
