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
import { describe, expect, it, vi } from 'vitest';
import { FileExplorerProvider, useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import { useSharedFileContentLoading } from '../use-shared-file-content-loading';

vi.mock('@brainstrike/workers/file-content-worker', () => ({
  createFileContentWorker: vi.fn(),
}));

interface PendingWorkerRead {
  readonly complete: (content: string) => void;
  readonly requests: readonly FileReadRequest[];
}

function createWrapper(adapter: MockFileSystemAdapter) {
  const storage = new MemoryStorageAdapter();
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
        <FileExplorerProvider storageAdapter={storage}>{children}</FileExplorerProvider>
      </AdaptersProvider>
    );
  };
}

describe('useSharedFileContentLoading reload ordering', () => {
  it('never republishes an older in-flight result after a refresh invalidation', async () => {
    const adapter = new MockFileSystemAdapter();
    const fileNode = createFileNode({ path: '/file.txt', rootFolderId: 'root-a' });
    const compositeKey = encodeFileSelection('root-a', '/file.txt');
    const pendingReads: PendingWorkerRead[] = [];
    const worker = vi.fn(
      (
        requests: FileReadRequest[],
        onProgress?: (event: { key: string; loaded: number; total: number }) => void
      ) =>
        new Promise<Record<string, FileContentReadResult>>((resolve) => {
          pendingReads.push({
            complete: (content) => {
              const results: Record<string, FileContentReadResult> = {};
              for (const request of requests) {
                results[request.compositeKey] = { content, status: 'accessible' };
                onProgress?.({ key: request.compositeKey, loaded: 1, total: requests.length });
              }
              resolve(results);
            },
            requests,
          });
        })
    );
    const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
    vi.mocked(createFileContentWorker).mockReturnValue(worker);

    const wrapper = createWrapper(adapter);
    const { result } = renderHook(
      () => {
        const store = useFileExplorerStoreContext();
        return { store, ...useSharedFileContentLoading([fileNode]) };
      },
      { wrapper }
    );

    let initialLoad: Promise<void> | undefined;
    act(() => {
      initialLoad = result.current.handleFileContentLoading([compositeKey]);
    });
    await waitFor(() => expect(pendingReads).toHaveLength(1));

    let reload: Promise<void> | undefined;
    act(() => {
      reload = result.current.reloadFileContents([compositeKey]);
    });

    await act(async () => {
      pendingReads[0]?.complete('stale content');
      await initialLoad;
    });
    await waitFor(() => expect(pendingReads).toHaveLength(2));
    expect(result.current.fileContents[compositeKey]).toBeUndefined();

    await act(async () => {
      pendingReads[1]?.complete('fresh content');
      await reload;
    });

    expect(result.current.fileContents[compositeKey]).toBe('fresh content');
    expect(worker).toHaveBeenCalledTimes(2);
  });
});
