// @vitest-environment node
import type { CanonicalFileIdentity, CanonicalSourceScope } from '@brainstrike/canonical-ingestion';
import type { ScopedIndexerPort } from '@brainstrike/indexer';
import { expect, it, vi } from 'vitest';
import { createNativeCanonicalPublication } from '../native-canonical-publication';
import { createNativeScanAdmission } from '../native-index-scan-admission';

const workspace = { kind: 'workspace', rootId: 'root' } as const;
const collection = { embeddingSetId: 'selected', kind: 'collection' } as const;
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
  const embeddingSetId: unknown = Reflect.get(scope, 'embeddingSetId');
  if (kind === 'workspace' && typeof rootId === 'string') {
    return { kind, rootId };
  }
  if (kind === 'collection' && typeof embeddingSetId === 'string') {
    return { embeddingSetId, kind };
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
  const publication = admission.workspacePublication(
    createNativeCanonicalPublication(writer, [workspace, collection])
  );
  const context = (requestId: string) => ({ requestId, signal: source.signal });
  return { admission, context, publication, source, writer };
}

it('drains native workspace removal and the physical host receipt; existing ACK stays admissible and later publication waits', async () => {
  const test = fixture();
  const ticket = await test.publication.beginScan({ requestId: 'workspace', scope: workspace });
  const removed = Promise.withResolvers<boolean>();
  test.writer.removeScopedFile.mockImplementation(() => removed.promise);
  const removing = test.publication.removeFile({ file, ticket });
  const admitted = Promise.withResolvers<void>();
  const scan = Promise.withResolvers<void>();
  const collectionPass = test.admission.runCollection('collection', async () => {
    test.admission.retainInventory([]);
    admitted.resolve();
    await scan.promise;
  });
  const currentAck = vi.fn(async () => {});
  await test.admission.acquireBindings(test.context('workspace'), currentAck);
  expect(currentAck).toHaveBeenCalledOnce();
  const later = test.publication.beginScan({ requestId: 'later', scope: workspace });
  await Promise.resolve();
  expect(test.writer.info).toHaveBeenCalledOnce();
  removed.resolve(true);
  await removing;
  const receipt = await test.publication.finishScan({ ...completion, ticket });
  // Native finish is still inside the original host/channel pass.
  expect(test.admission.getInventory()).toBeUndefined();
  test.admission.completeWorkspace(receipt);
  await admitted.promise;
  expect(test.writer.info).toHaveBeenCalledOnce();
  const ownedAck = vi.fn(async () => {});
  await test.admission.acquireBindings(test.context('collection'), ownedAck);
  expect(ownedAck).toHaveBeenCalledOnce();
  scan.resolve();
  await collectionPass;
  const laterTicket = await later;
  test.admission.completeWorkspace(
    await test.publication.finishScan({ ...completion, ticket: laterTicket })
  );
});

it('joins an already-admitted binding ACK before loading the single collection snapshot and keeps identical reads available', async () => {
  const test = fixture();
  const ack = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const prior = test.admission.acquireRead(async () => {
    started.resolve();
    await ack.promise;
  });
  await started.promise;
  const snapshot = Promise.withResolvers<void>();
  const scan = Promise.withResolvers<void>();
  const pass = test.admission.runCollection('collection', async () => {
    test.admission.retainInventory([]);
    snapshot.resolve();
    await scan.promise;
  });
  const read = vi.fn(async () => 'reader');
  const queued = test.admission.acquireRead(read);
  await Promise.resolve();
  expect(read).not.toHaveBeenCalled();
  ack.resolve();
  await prior;
  await snapshot.promise;
  expect(await queued).toBe('reader');
  expect(await test.admission.acquireRead(read)).toBe('reader');
  scan.resolve();
  await pass;
});

it('rejects queued ACK, read and publication on source retirement while running native work keeps its snapshot through physical settlement', async () => {
  const test = fixture();
  const entered = Promise.withResolvers<void>();
  const native = Promise.withResolvers<void>();
  const pass = test.admission
    .runCollection('collection', async () => {
      test.admission.retainInventory([]);
      entered.resolve();
      await native.promise;
      test.source.signal.throwIfAborted();
    })
    .catch((error: unknown) => error);
  await entered.promise;
  const callback = vi.fn(async () => {});
  const ack = test.admission
    .acquireBindings(test.context('later'), callback)
    .catch((error: unknown) => error);
  const publication = test.publication
    .beginScan({ requestId: 'later', scope: workspace })
    .catch((error: unknown) => error);
  const reason = new Error('owned source retirement');
  test.source.abort(reason);
  expect(await ack).toBe(reason);
  expect(await publication).toBe(reason);
  expect(callback).not.toHaveBeenCalled();
  expect(test.admission.getInventory()).toEqual([]);
  await expect(test.admission.acquireRead(callback)).rejects.toBe(reason);
  native.resolve();
  expect(await pass).toBe(reason);
  expect(test.admission.getInventory()).toEqual([]);
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
  const admitted = vi.fn(async () => {});
  const pass = test.admission
    .runCollection('collection', admitted)
    .catch((error: unknown) => error);
  const aborting = test.publication.abortScan(ticket);
  const failure = new AggregateError(
    [new Error('native prepare failure')],
    'original workspace failure',
    { cause: new Error('original cause') }
  );
  native.reject(failure);
  expect(await prepare).toBe(failure);
  await aborting;
  expect(admitted).not.toHaveBeenCalled();
  test.admission.failWorkspace(workspace.rootId, failure);
  expect(await pass).toBe(failure);
  expect(admitted).not.toHaveBeenCalled();
  await expect(test.admission.acquireBindings(test.context('later'), async () => {})).rejects.toBe(
    failure
  );
});

it('rejects a read queued before inventory capture on retirement and still joins the original physical binding ACK', async () => {
  const test = fixture();
  const native = Promise.withResolvers<void>();
  const prior = test.admission.acquireRead(() => native.promise);
  const work = vi.fn(async () => {});
  const pass = test.admission.runCollection('collection', work).catch((error: unknown) => error);
  const read = test.admission.acquireRead(work).catch((error: unknown) => error);
  const reason = new Error('retire before inventory capture');
  test.source.abort(reason);
  expect(await pass).toBe(reason);
  expect(await read).toBe(reason);
  expect(work).not.toHaveBeenCalled();
  native.resolve();
  await prior;
});

it('retains a failed binding ACK and rejects later admission with its exact aggregate failure', async () => {
  const test = fixture();
  const failure = new AggregateError([new Error('replacement failed')], 'original ACK failure', {
    cause: new Error('original ACK cause'),
  });
  await expect(
    test.admission.acquireRead(async () => {
      throw failure;
    })
  ).rejects.toBe(failure);
  const work = vi.fn(async () => {});
  await expect(test.admission.runCollection('collection', work)).rejects.toBe(failure);
  await expect(test.admission.acquireRead(work)).rejects.toBe(failure);
  expect(work).not.toHaveBeenCalled();
});
