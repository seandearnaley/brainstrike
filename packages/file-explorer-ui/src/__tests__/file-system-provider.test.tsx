/**
 * @vitest-environment happy-dom
 */
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { act, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FileExplorerProvider } from '../shell/file-explorer-provider';
import { FileSystemProvider, useFileSystem } from '../shell/file-system-provider';

type FsValue = ReturnType<typeof useFileSystem>;

function Exposer({ onReady }: { onReady: (fs: FsValue) => void }) {
  const fs = useFileSystem();
  useEffect(() => {
    onReady(fs);
  }, [onReady, fs]);
  return null;
}

describe('FileSystemProvider (single shared instance)', () => {
  it('a root added through one consumer is visible to every other consumer', async () => {
    // THE invariant this provider exists for: with per-call useFileSystem
    // instances, Add Folder grew the explorer's handle list while the
    // background-indexing provider's list never changed — the indexer stayed
    // idle for new roots until the next app launch.
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      'cccccccc-dddd-eeee-ffff-000000000009' as ReturnType<typeof crypto.randomUUID>
    );
    const storage = new MemoryStorageAdapter();
    const fsAdapter = new MockFileSystemAdapter(MockFileSystemAdapter.createSimpleFileSystem());

    let explorerSide: FsValue | null = null;
    let indexerSide: FsValue | null = null;

    render(
      <AdaptersProvider fileSystemAdapter={fsAdapter} storageAdapter={storage}>
        <FileExplorerProvider storageAdapter={storage}>
          <FileSystemProvider>
            <Exposer
              onReady={(fs) => {
                explorerSide = fs;
              }}
            />
            <Exposer
              onReady={(fs) => {
                indexerSide = fs;
              }}
            />
          </FileSystemProvider>
        </FileExplorerProvider>
      </AdaptersProvider>
    );

    await waitFor(() => {
      expect(explorerSide).not.toBeNull();
      expect(indexerSide).not.toBeNull();
    });

    await act(async () => {
      await (explorerSide as unknown as FsValue).selectRootDirectory();
    });

    await waitFor(() => {
      const names = (indexerSide as unknown as FsValue).rootDirectoryHandles.map(
        (handle) => handle.name
      );
      expect(names).toContain('mock-root');
    });
  });

  it('uses the provider deleteRootData prop for delete-with-data disconnects', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      'cccccccc-dddd-eeee-ffff-000000000010' as ReturnType<typeof crypto.randomUUID>
    );
    const storage = new MemoryStorageAdapter();
    const fsAdapter = new MockFileSystemAdapter(MockFileSystemAdapter.createSimpleFileSystem());
    const deleteRootData = vi.fn().mockResolvedValue(undefined);
    let fsValue: FsValue | null = null;

    render(
      <AdaptersProvider fileSystemAdapter={fsAdapter} storageAdapter={storage}>
        <FileExplorerProvider storageAdapter={storage}>
          <FileSystemProvider deleteRootData={deleteRootData}>
            <Exposer
              onReady={(fs) => {
                fsValue = fs;
              }}
            />
          </FileSystemProvider>
        </FileExplorerProvider>
      </AdaptersProvider>
    );

    await waitFor(() => {
      expect(fsValue).not.toBeNull();
    });

    await act(async () => {
      await (fsValue as unknown as FsValue).selectRootDirectory();
    });
    const rootId = (fsValue as unknown as FsValue).rootDirectoryHandles[0]?.rootId;
    expect(rootId).toBe('cccccccc-dddd-eeee-ffff-000000000010');
    if (!rootId) {
      throw new Error('Expected selected root to have a rootId');
    }

    await act(async () => {
      await (fsValue as unknown as FsValue).removeRootDirectory(rootId, { deleteData: true });
    });

    expect(deleteRootData).toHaveBeenCalledExactlyOnceWith(
      rootId,
      expect.objectContaining({
        rootDirectoryHandles: expect.arrayContaining([
          expect.objectContaining({ path: 'mock-root', rootId }),
        ]),
        rootIdByPath: expect.any(Map),
      })
    );
    expect((fsValue as unknown as FsValue).rootDirectoryHandles).toHaveLength(0);
  });

  it('throws without a FileSystemProvider (no silent per-call fallback instance)', () => {
    function Bare() {
      useFileSystem();
      return null;
    }
    // Suppress React's error boundary console noise for the expected throw.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {
      // intentional: assertion below is the signal
    });
    try {
      expect(() => render(<Bare />)).toThrow(/requires a FileSystemProvider/);
    } finally {
      consoleError.mockRestore();
    }
  });
});
