import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { createFileNode } from '@brainstrike/test-utils';
import type {
  FileContentReadResult,
  FileReadRequest,
} from '@brainstrike/workers/file-content-worker';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { FileExplorerProvider } from '../shell/file-explorer-provider';
import { useSharedFileContentLoading } from '../use-shared-file-content-loading';

vi.mock('@brainstrike/workers/file-content-worker', () => ({
  createFileContentWorker: vi.fn(),
}));

interface PendingWorkerRead {
  readonly complete: (content: string) => void;
  readonly requests: readonly FileReadRequest[];
}

function createPendingWorker(pendingReads: PendingWorkerRead[]) {
  return vi.fn(
    (
      requests: FileReadRequest[],
      onProgress?: (event: { key: string; loaded: number; total: number }) => void
    ) =>
      new Promise<Record<string, FileContentReadResult>>((resolve) => {
        pendingReads.push({
          complete: (content) => {
            const results = Object.fromEntries(
              requests.map((request) => {
                onProgress?.({ key: request.compositeKey, loaded: 1, total: requests.length });
                return [request.compositeKey, { content, status: 'accessible' as const }] as const;
              })
            );
            resolve(results);
          },
          requests,
        });
      })
  );
}

it('runs queued interactive reads before bulk work while bounding bulk starvation', async () => {
  const adapter = new MockFileSystemAdapter();
  const storage = new MemoryStorageAdapter();
  const nodes = [
    ...Array.from({ length: 3 }, (_, batchIndex) =>
      Array.from({ length: 2 }, (_, fileIndex) =>
        createFileNode({
          path: `/bulk-${batchIndex}-${fileIndex}.txt`,
          rootFolderId: 'root-priority',
        })
      )
    ).flat(),
    ...Array.from({ length: 3 }, (_, index) =>
      createFileNode({ path: `/interactive-${index}.txt`, rootFolderId: 'root-priority' })
    ),
  ];
  const keys = nodes.map((node) => encodeFileSelection('root-priority', node.path));
  const bulkA = keys.slice(0, 2);
  const bulkB = keys.slice(2, 4);
  const queuedBulk = keys.slice(4, 6);
  const interactive = keys.slice(6);
  const pendingReads: PendingWorkerRead[] = [];
  const worker = createPendingWorker(pendingReads);
  const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
  vi.mocked(createFileContentWorker).mockReturnValue(worker);

  function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
        <FileExplorerProvider storageAdapter={storage}>{children}</FileExplorerProvider>
      </AdaptersProvider>
    );
  }
  const { result } = renderHook(() => useSharedFileContentLoading(nodes), { wrapper: Wrapper });
  let loads: Promise<void>[] = [];
  act(() => {
    loads = [
      result.current.handleFileContentLoading(bulkA),
      result.current.handleFileContentLoading(bulkB),
      result.current.handleFileContentLoading(queuedBulk),
      ...interactive.map((key) => result.current.handleFileContentLoading([key])),
    ];
  });

  await waitFor(() => expect(pendingReads).toHaveLength(2));
  expect(pendingReads[0]?.requests.map((request) => request.compositeKey)).toEqual(bulkA);
  expect(pendingReads[1]?.requests.map((request) => request.compositeKey)).toEqual(bulkB);

  await act(async () => {
    pendingReads[0]?.complete('bulk a');
    await Promise.resolve();
  });
  await waitFor(() => expect(pendingReads).toHaveLength(3));
  expect(pendingReads[2]?.requests.map((request) => request.compositeKey)).toEqual([
    interactive[0],
  ]);

  await act(async () => {
    pendingReads[1]?.complete('bulk b');
    await Promise.resolve();
  });
  await waitFor(() => expect(pendingReads).toHaveLength(4));
  expect(pendingReads[3]?.requests.map((request) => request.compositeKey)).toEqual([
    interactive[1],
  ]);

  await act(async () => {
    pendingReads[2]?.complete('interactive zero');
    await Promise.resolve();
  });
  await waitFor(() => expect(pendingReads).toHaveLength(5));
  expect(pendingReads[4]?.requests.map((request) => request.compositeKey)).toEqual(queuedBulk);

  await act(async () => {
    pendingReads[3]?.complete('interactive one');
    await Promise.resolve();
  });
  await waitFor(() => expect(pendingReads).toHaveLength(6));
  expect(pendingReads[5]?.requests.map((request) => request.compositeKey)).toEqual([
    interactive[2],
  ]);

  await act(async () => {
    pendingReads[4]?.complete('queued bulk');
    pendingReads[5]?.complete('interactive two');
    await Promise.all(loads);
  });
});
