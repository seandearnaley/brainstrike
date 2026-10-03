// @vitest-environment node
import type { CanonicalFileIdentity } from '@brainstrike/canonical-ingestion';
import { describe, expect, it, vi } from 'vitest';
import { createNativeCanonicalPublication } from '../native-canonical-publication';

const scope = { embeddingSetId: 'collection', kind: 'collection' } as const;
const file: CanonicalFileIdentity = {
  embeddingSetId: 'collection',
  fileId: 'file',
  fileName: 'file.txt',
  relativePath: null,
  rootId: null,
  sourcePath: null,
};
const storeId = 'store';
function fixture() {
  const port = {
    commitScopedFile: vi.fn(),
    commitScopedTextFile: vi.fn(),
    coverageScope: vi.fn(),
    info: vi.fn(async () => ({
      dbPath: '/owned/index.sqlite',
      embedding: { indexMode: 'text-only' as const },
      journalMode: 'wal',
      pid: 1,
      readerQueryOnly: 1,
      storeId,
      vecVersion: '0.1.9',
      writerThreadId: 1,
    })),
    prepareScopedFile: vi.fn(),
    removeScopedFile: vi.fn(async () => true),
    verifyScopedManifest: vi.fn(async (request) => ({
      authorityEpoch: 'epoch',
      authorityRevision: 1,
      changed: [],
      complete: true,
      missing: [],
      scope: request.scope,
      storeId,
      unexpected: [],
    })),
  };
  const publication = createNativeCanonicalPublication(port, [scope]);
  return { port, publication };
}
const completion = { aborted: false, errors: [], files: [], full: true, truncatedDirectories: [] };

describe('main canonical publication ownership', () => {
  it('joins an admitted rootless removal before abort and refuses late writes', async () => {
    const { port, publication } = fixture();
    const held = Promise.withResolvers<boolean>();
    port.removeScopedFile.mockReturnValueOnce(held.promise);
    const ticket = await publication.beginScan({ requestId: 'scan', scope });
    const write = publication.removeFile({ file, ticket });
    await vi.waitFor(() => expect(port.removeScopedFile).toHaveBeenCalledOnce());
    let settled = false;
    const abort = publication.abortScan(ticket).then(() => {
      settled = true;
    });
    await expect(publication.removeFile({ file, ticket })).rejects.toThrow('closed');
    await Promise.resolve();
    expect(settled).toBe(false);
    held.resolve(true);
    await write;
    await abort;
    expect(await publication.finishScan({ ...completion, ticket })).toMatchObject({
      reason: 'aborted',
      scanComplete: false,
    });
    expect(port.removeScopedFile).toHaveBeenCalledWith({ fileId: 'file', scope });
    expect(port.verifyScopedManifest).not.toHaveBeenCalled();
  });

  it('retains a failed write in its receipt even when its caller observed the rejection', async () => {
    const { port, publication } = fixture();
    const cause = new Error('native removal failed');
    port.removeScopedFile.mockRejectedValueOnce(cause);
    const ticket = await publication.beginScan({ requestId: 'scan', scope });
    await expect(publication.removeFile({ file, ticket })).rejects.toBe(cause);
    expect(await publication.finishScan({ ...completion, ticket })).toMatchObject({
      reason: 'write-failed',
      scanComplete: false,
    });
    expect(port.verifyScopedManifest).not.toHaveBeenCalled();
  });

  it('refuses overlapping and consumed tickets and verifies the actual empty collection', async () => {
    const { port, publication } = fixture();
    const ticket = await publication.beginScan({ requestId: 'scan', scope });
    await expect(publication.beginScan({ requestId: 'overlap', scope })).rejects.toThrow('owned');
    expect(await publication.finishScan({ ...completion, ticket })).toMatchObject({
      reason: 'complete',
      scanComplete: true,
    });
    expect(port.verifyScopedManifest).toHaveBeenCalledWith({ files: [], scope });
    await expect(publication.finishScan({ ...completion, ticket })).rejects.toThrow('stale');
    await expect(publication.removeFile({ file, ticket })).rejects.toThrow('stale');
  });

  it('keeps readiness false when cancellation arrives during physical manifest verification', async () => {
    const { port, publication } = fixture();
    const held = Promise.withResolvers<Awaited<ReturnType<typeof port.verifyScopedManifest>>>();
    port.verifyScopedManifest.mockReturnValueOnce(held.promise);
    const ticket = await publication.beginScan({ requestId: 'scan', scope });
    const finish = publication.finishScan({ ...completion, ticket });
    await vi.waitFor(() => expect(port.verifyScopedManifest).toHaveBeenCalledOnce());
    let aborted = false;
    const abort = publication.abortScan(ticket).then(() => {
      aborted = true;
    });
    await Promise.resolve();
    expect(aborted).toBe(false);
    held.resolve({
      authorityEpoch: 'epoch',
      authorityRevision: 1,
      changed: [],
      complete: true,
      missing: [],
      scope,
      storeId,
      unexpected: [],
    });
    expect(await finish).toMatchObject({ reason: 'aborted', scanComplete: false });
    await abort;
    expect(publication.getReadiness()).toEqual([{ scanComplete: false, scope }]);
  });
});

it('invalidates an overlapping collection receipt when a workspace mutation is admitted', async () => {
  const { port } = fixture();
  const workspace = { kind: 'workspace', rootId: 'root' } as const;
  const publication = createNativeCanonicalPublication(port, [scope, workspace]);
  const collectionTicket = await publication.beginScan({ requestId: 'collection-complete', scope });
  await publication.finishScan({ ...completion, ticket: collectionTicket });
  expect(publication.getReadiness()[0]?.scanComplete).toBe(true);
  const ticket = await publication.beginScan({ requestId: 'workspace-change', scope: workspace });
  const held = Promise.withResolvers<boolean>();
  port.removeScopedFile.mockReturnValueOnce(held.promise);
  const removing = publication.removeFile({
    file: { ...file, relativePath: 'file.txt', rootId: 'root' },
    ticket,
  });
  expect(publication.getReadiness()[0]?.scanComplete).toBe(false);
  held.resolve(true);
  await removing;
  await publication.abortScan(ticket);
  await publication.finishScan({ ...completion, ticket });
});
