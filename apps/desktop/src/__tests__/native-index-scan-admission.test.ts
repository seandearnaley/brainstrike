// @vitest-environment node
import type { CanonicalFileIdentity, CanonicalSourceScope } from '@brainstrike/canonical-ingestion';
import {
  createNativeCanonicalPublication,
  createNativeScanAdmission,
} from '@brainstrike/canonical-ingestion';
import type { ScopedIndexerPort } from '@brainstrike/indexer';
import type { FileSystemWatchSignal } from '@brainstrike/types';
import { expect, it, vi } from 'vitest';
import { CanonicalUtilityChild } from '../canonical-utility-child';
import { CanonicalUtilityParent } from '../canonical-utility-parent';
import { catalogFingerprint, deferNativeIndexCatalog } from '../native-index-catalog-observation';

const workspace = { kind: 'workspace', rootId: 'root' } as const;
const file: CanonicalFileIdentity = {
  embeddingSetId: 'selected',
  fileId: 'file',
  fileName: 'file.txt',
  relativePath: 'file.txt',
  rootId: 'root',
  sourcePath: '/actual/root/file.txt',
};
const completion = { aborted: false, errors: [], files: [], full: true, truncatedDirectories: [] };
function requestedScope(request: unknown): CanonicalSourceScope {
  if (!request || typeof request !== 'object') {
    throw new Error('Expected an actual native request.');
  }
  const scope: unknown = Reflect.get(request, 'scope');
  if (!scope || typeof scope !== 'object') {
    throw new Error('Expected an explicit native scope.');
  }
  const kind: unknown = Reflect.get(scope, 'kind');
  const rootId: unknown = Reflect.get(scope, 'rootId');
  if (kind === 'workspace' && typeof rootId === 'string') {
    return { kind, rootId };
  }
  throw new Error('Expected an authorized native scope.');
}
function fixture() {
  const source = new AbortController();
  const admission = createNativeScanAdmission(() => source.signal.throwIfAborted(), source.signal);
  const writer = {
    commitScopedFile: vi.fn(),
    commitScopedTextFile: vi.fn(),
    coverageBatch: vi.fn(),
    coverageScope: vi.fn(),
    info: vi.fn(async () => ({
      dbPath: '/owned/index.sqlite',
      embedding: { indexMode: 'text-only' as const },
      journalMode: 'wal',
      pid: 1,
      readerQueryOnly: 1,
      storeId: 'store',
      vecVersion: '0.1.9',
      writerThreadId: 1,
    })),
    prepareScopedFile: vi.fn(),
    removeScopedFile: vi.fn(async () => true),
    verifyScopedManifest: vi.fn(
      async (request: Parameters<ScopedIndexerPort['verifyScopedManifest']>[0]) => ({
        authorityEpoch: 'epoch',
        authorityRevision: 1,
        changed: [],
        complete: true,
        missing: [],
        scope: requestedScope(request),
        storeId: 'store',
        unexpected: [],
      })
    ),
  };
  const nativePublication = createNativeCanonicalPublication(writer, [workspace]);
  const publication = admission.workspacePublication(nativePublication);
  const context = (requestId: string) => ({ requestId, signal: source.signal });
  return { admission, context, nativePublication, publication, source, writer };
}

it.each(['overflow', 'unexplained-mismatch', 'write-failure'] as const)(
  'keeps settled scan admission honest during %s',
  async (scenario) => {
    const test = fixture();
    const verifying = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const original = test.writer.verifyScopedManifest.getMockImplementation()!;
    const writeFailure = new Error('Actual native manifest read failed.');
    let verifications = 0;
    test.writer.verifyScopedManifest.mockImplementation(async (request) => {
      verifications += 1;
      if (verifications === 1) {
        verifying.resolve();
        await released.promise;
        if (scenario === 'write-failure') {
          throw writeFailure;
        }
      }
      return original(request);
    });
    let watchSignal: ((signal: FileSystemWatchSignal) => void) | undefined;
    const receipt = vi.fn(
      (
        result: Parameters<typeof test.admission.completeWorkspace>[0],
        sourceInvalidated?: true
      ) => {
        if (sourceInvalidated) {
          test.admission.releaseInvalidatedWorkspace(result);
          return;
        }
        test.admission.completeWorkspace(result);
      }
    );
    const error = vi.fn((operation: string, cause: unknown) => {
      if (operation === 'sync' || operation === 'sync loop') {
        test.admission.failWorkspace(workspace.rootId, cause);
      }
    });
    const parent = new CanonicalUtilityParent(
      (frame) => queueMicrotask(() => child.receive(structuredClone(frame))),
      vi.fn()
    );
    const child = new CanonicalUtilityChild((frame) =>
      queueMicrotask(() => parent.receive(structuredClone(frame)))
    );
    await parent.attachWorkspace({
      catalog: {
        applyManagedCacheBatch: async () => {},
        completeFiles: async () => {},
        loadAuthorizedBatch: async () => [],
        prepareManagedSourcesBatch: async () => [],
        removeFiles: async () => {},
        resolveProfile: async () => {
          throw new Error('TEXT must not resolve inference.');
        },
      },
      managedCollectionId: 'selected',
      onError: error,
      onReceipt: receipt,
      onWatchHealth: () => {},
      parser: { parser: 'oxc' },
      publication: test.publication,
      request: { batchSize: 2, chunkingOptions: { strategy: 'auto' }, maxFileBytes: 1024 },
      source: {
        indexingPolicyPreset: 'balanced',
        inventory: { loadFiles: async () => [] },
        lease: {
          canonicalPath: '/actual/root',
          generation: 'actual-borrow',
          listDir: async () => ({ entries: [], inspected: 0, truncated: false }),
          readFile: async () => {
            throw new Error('Empty root must not read files.');
          },
          retire: async () => {},
          rootId: workspace.rootId,
          signal: test.source.signal,
          subscribe: async (_batch, signal) => {
            watchSignal = signal;
            return { close: async () => {} };
          },
        },
      },
    });
    await vi.waitFor(() => expect(test.writer.verifyScopedManifest).toHaveBeenCalledOnce());
    await verifying.promise;
    // The real main watch owner invalidates readiness before forwarding overflow.
    test.nativePublication.invalidateScope(workspace);
    if (!watchSignal) {
      throw new Error('Expected the actual mounted watch subscription.');
    }
    if (scenario !== 'unexplained-mismatch') {
      watchSignal({ type: 'overflow' });
    }
    released.resolve();
    try {
      if (scenario !== 'overflow') {
        await vi.waitFor(() => expect(error).toHaveBeenCalled());
        expect(receipt).not.toHaveBeenCalled();
        if (scenario === 'write-failure') {
          expect(error.mock.calls[0]?.[1]).toMatchObject({ message: writeFailure.message });
          // The failed workspace stays owned: a catalog refresh joining it sees the original failure.
          await expect(Promise.all(test.admission.getWorkspaceCompletions())).rejects.toBe(
            error.mock.calls[0]?.[1]
          );
        } else {
          expect(error.mock.calls[0]?.[1]).toMatchObject({
            message: 'Canonical scan receipt is incomplete: manifest-mismatch.',
            name: 'CanonicalScanIncompleteError',
          });
        }
        return;
      }
      await vi.waitFor(() => expect(receipt).toHaveBeenCalledTimes(2));
      expect(error).not.toHaveBeenCalled();
      expect(receipt).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ reason: 'manifest-mismatch', scanComplete: false }),
        true
      );
      expect(receipt).toHaveBeenNthCalledWith(2, expect.objectContaining({ scanComplete: true }));
    } finally {
      await parent.close();
    }
  }
);

it('admits no binding ACK, read or publication once its source retires', async () => {
  const test = fixture();
  const reason = new Error('owned source retirement');
  test.source.abort(reason);
  const work = vi.fn(async () => {});
  await expect(test.admission.acquireBindings(test.context('later'), work)).rejects.toBe(reason);
  await expect(test.admission.acquireRead(work)).rejects.toBe(reason);
  await expect(test.publication.beginScan({ requestId: 'later', scope: workspace })).rejects.toBe(
    reason
  );
  expect(work).not.toHaveBeenCalled();
  expect(test.writer.info).not.toHaveBeenCalled();
});

it('keeps an aborted workspace fenced until its physical pass settles and preserves a failed VECTOR preparation cause', async () => {
  const test = fixture();
  const ticket = await test.publication.beginScan({ requestId: 'workspace', scope: workspace });
  const native = Promise.withResolvers<never>();
  test.writer.prepareScopedFile.mockImplementation(() => native.promise);
  const prepare = test.publication
    .prepareVectorFile({
      file,
      payload: { content: 'original', fileId: file.fileId, providedChunks: [] },
      profile: { dimensions: 2, distance: 'cosine', modelId: 'actual-model', provider: 'openai' },
      ticket,
    })
    .catch((error: unknown) => error);
  const aborting = test.publication.abortScan(ticket);
  const later = () => test.publication.beginScan({ requestId: 'later', scope: workspace });
  await expect(later()).rejects.toThrow('Workspace publication admission remains owned.');
  const failure = new AggregateError(
    [new Error('native prepare failure')],
    'original workspace failure',
    { cause: new Error('original cause') }
  );
  native.reject(failure);
  expect(await prepare).toBe(failure);
  await aborting;
  test.admission.failWorkspace(workspace.rootId, failure);
  // The failed workspace stays owned: a catalog refresh joining it sees the original failure.
  await expect(later()).rejects.toThrow('Workspace publication admission remains owned.');
  await expect(Promise.all(test.admission.getWorkspaceCompletions())).rejects.toBe(failure);
});

it.each(['complete', 'failed', 'terminal'] as const)(
  'joins existing workspace publication for changed catalog with %s settlement',
  async (outcome) => {
    const test = fixture();
    const ticket = await test.publication.beginScan({ requestId: 'discovery', scope: workspace });
    const records = [
      {
        chunksProcessed: true,
        content: null,
        contentHash: 'c'.repeat(64),
        embeddingSetId: file.embeddingSetId,
        fileId: file.fileId,
        fileName: file.fileName,
        path: file.relativePath,
        rootId: file.rootId,
        stat: { mtimeMs: 1, size: 4 },
      },
    ];
    const observation = {
      observedCatalogFingerprint: catalogFingerprint([]),
      settings: { managedCollectionId: 'selected' },
    };
    const completions = test.admission.getWorkspaceCompletions();
    expect(completions).toHaveLength(1);
    expect(deferNativeIndexCatalog(observation, [], completions)).toBeUndefined();
    const pending = deferNativeIndexCatalog(observation, records, completions);
    expect(pending).toBeDefined();
    let settled = false;
    const joining = test.admission.joinPublication(pending!).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    const original = new Error('Owned source failure');
    if (outcome === 'complete') {
      test.admission.completeWorkspace(
        await test.publication.finishScan({ ...completion, ticket })
      );
      expect(await joining).toBeUndefined();
      expect(test.admission.getWorkspaceCompletions()).toEqual([]);
      return;
    }
    if (outcome === 'failed') {
      test.admission.failWorkspace(workspace.rootId, original);
    } else {
      test.source.abort(original);
    }
    expect(await joining).toBe(original);
    expect(test.admission.getWorkspaceCompletions()).toEqual(completions);
  }
);
