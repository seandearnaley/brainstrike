import type { FileContentProcessor, FileContentRequest } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle, FileSystemAdapter, HandleCache } from '@brainstrike/file-system';
import { WebFileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import { ChunkingRedispatchTracker } from '../workspace-collection-sync-import';
import { collectPreparedWorkspaceSyncChanges } from '../workspace-collection-sync-scan';
import { BALANCED_QOS_POLICY } from './workspace-collection-sync-service-test-helpers';

async function* emptyDirectoryListing(): AsyncGenerator<never> {
  // No entries: the scoped scan's sibling match misses the changed file, which
  // is the exact condition the raw-handle fallback exists to cover.
}

function createHandleCacheStub(overrides: Partial<HandleCache> = {}): HandleCache {
  return {
    clear: vi.fn(async () => undefined),
    getAllRootHandles: vi.fn(async () => []),
    getFileHandle: vi.fn(async () => null),
    getLastRootHandleForRestore: vi.fn(async () => null),
    getRootHandle: vi.fn(async () => null),
    markHandleRestored: vi.fn(async () => undefined),
    pruneOldHandles: vi.fn(async () => undefined),
    removeFileHandle: vi.fn(async () => undefined),
    removeRootHandle: vi.fn(async () => undefined),
    restoreLastRootHandle: vi.fn(async () => null),
    storeFileHandle: vi.fn(async () => undefined),
    storeRootHandle: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as HandleCache;
}

describe('workspace collection scoped traversal', () => {
  it('preserves the durable rootId on rebuilt directory handles', async () => {
    const rootHandle: DirectoryHandle = {
      kind: 'directory',
      name: 'workspace',
      path: '/workspace/root',
      platform: 'electron',
      rootId: 'outer-root-id',
    };
    const readDirectory = vi.fn(async (handle: DirectoryHandle): Promise<IFileNode[]> => {
      if (handle.path === rootHandle.path) {
        return [
          {
            children: [],
            depth: 0,
            handle: {
              kind: 'directory',
              name: 'nested-root',
              path: '/workspace/root/nested-root',
              platform: 'electron',
              rootId: 'outer-root-id',
            } as unknown as IFileNode['handle'],
            name: 'nested-root',
            path: '/workspace/root/nested-root',
            rootFolderId: 'outer-root-id',
            selectionState: 'unchecked',
            type: 'directory',
          },
        ];
      }
      return [];
    });
    const fileSystemAdapter = {
      exists: vi.fn(),
      readDirectory,
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
    } as unknown as FileSystemAdapter;

    await collectPreparedWorkspaceSyncChanges({
      abortSignal: new AbortController().signal,
      context: {
        activeRootPath: rootHandle.path,
        collectionId: 'set-1',
        dbRootId: 'outer-root-id',
        rootPath: rootHandle.path,
      },
      deps: {
        chunkingRedispatchTracker: new ChunkingRedispatchTracker(),
        fileRecordRepository: {
          listManagedCacheEntryMetadata: vi.fn(async () => []),
        },
        fileSystemAdapter,
        onScanningPath: vi.fn(),
      },
      qosPolicy: BALANCED_QOS_POLICY,
      request: {
        indexingPolicyPreset: 'balanced',
        rootDirectoryHandle: rootHandle,
        scope: {
          changes: [
            {
              kind: 'directory',
              path: '/workspace/root/nested-root',
              type: 'modified',
            },
          ],
          mode: 'paths',
        },
      },
    });

    expect(readDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/workspace/root/nested-root',
        rootId: 'outer-root-id',
      }),
      expect.any(Object)
    );
  });

  it('inherits the root handle rootId when a child directory handle is unstamped', async () => {
    const rootHandle: DirectoryHandle = {
      kind: 'directory',
      name: 'workspace',
      path: '/workspace/root',
      platform: 'electron',
      rootId: 'outer-root-id',
    };
    const readDirectory = vi.fn(async (handle: DirectoryHandle): Promise<IFileNode[]> => {
      if (handle.path === rootHandle.path) {
        return [
          {
            children: [],
            depth: 0,
            handle: {
              kind: 'directory',
              name: 'nested-root',
              path: '/workspace/root/nested-root',
              platform: 'electron',
            } as unknown as IFileNode['handle'],
            name: 'nested-root',
            path: '/workspace/root/nested-root',
            rootFolderId: 'folder-state-id',
            selectionState: 'unchecked',
            type: 'directory',
          },
        ];
      }
      return [];
    });
    const fileSystemAdapter = {
      exists: vi.fn(),
      readDirectory,
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
    } as unknown as FileSystemAdapter;

    await collectPreparedWorkspaceSyncChanges({
      abortSignal: new AbortController().signal,
      context: {
        activeRootPath: rootHandle.path,
        collectionId: 'set-1',
        dbRootId: 'outer-root-id',
        rootPath: rootHandle.path,
      },
      deps: {
        chunkingRedispatchTracker: new ChunkingRedispatchTracker(),
        fileRecordRepository: {
          listManagedCacheEntryMetadata: vi.fn(async () => []),
        },
        fileSystemAdapter,
        onScanningPath: vi.fn(),
      },
      qosPolicy: BALANCED_QOS_POLICY,
      request: {
        indexingPolicyPreset: 'balanced',
        rootDirectoryHandle: rootHandle,
        scope: {
          changes: [
            {
              kind: 'directory',
              path: '/workspace/root/nested-root',
              type: 'modified',
            },
          ],
          mode: 'paths',
        },
      },
    });

    expect(readDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/workspace/root/nested-root',
        rootId: 'outer-root-id',
      }),
      expect.any(Object)
    );
  });

  it('stamps the raw web child handle as _internal on rebuilt directory handles', async () => {
    // On web, adapter.readDirectory returns child nodes whose `handle` IS the
    // raw FileSystemDirectoryHandle (no `_internal`, no `platform`). The
    // web adapter can only read a rebuilt handle whose `_internal` is that raw
    // handle; without it, scoped scans throw AccessError below the root.
    const rawNestedWebHandle = {
      entries: () => undefined,
      kind: 'directory',
      name: 'nested',
    };
    const rootHandle: DirectoryHandle = {
      _internal: { entries: () => undefined, kind: 'directory', name: 'workspace' },
      kind: 'directory',
      name: 'workspace',
      path: 'workspace',
      platform: 'web',
    };
    const readDirectory = vi.fn(async (handle: DirectoryHandle): Promise<IFileNode[]> => {
      if (handle.path === rootHandle.path) {
        return [
          {
            children: [],
            depth: 0,
            handle: rawNestedWebHandle as unknown as IFileNode['handle'],
            name: 'nested',
            path: 'workspace/nested',
            rootFolderId: 'workspace',
            selectionState: 'unchecked',
            type: 'directory',
          },
        ];
      }
      return [];
    });
    const fileSystemAdapter = {
      exists: vi.fn(),
      readDirectory,
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
    } as unknown as FileSystemAdapter;

    await collectPreparedWorkspaceSyncChanges({
      abortSignal: new AbortController().signal,
      context: {
        activeRootPath: rootHandle.path,
        collectionId: 'set-1',
        dbRootId: 'root-1',
        rootPath: rootHandle.path,
      },
      deps: {
        chunkingRedispatchTracker: new ChunkingRedispatchTracker(),
        fileRecordRepository: {
          listManagedCacheEntryMetadata: vi.fn(async () => []),
        },
        fileSystemAdapter,
        onScanningPath: vi.fn(),
      },
      qosPolicy: BALANCED_QOS_POLICY,
      request: {
        indexingPolicyPreset: 'balanced',
        rootDirectoryHandle: rootHandle,
        scope: {
          changes: [
            {
              kind: 'directory',
              path: 'nested',
              type: 'modified',
            },
          ],
          mode: 'paths',
        },
      },
    });

    expect(readDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        _internal: rawNestedWebHandle,
        path: 'workspace/nested',
        platform: 'web',
      }),
      expect.any(Object)
    );
  });

  it('resolves the raw web FileHandle for a changed file missing from the sibling listing', async () => {
    // On web, a synthetic descriptor handle is unreadable: file content
    // processing stamps `node.handle` as the FileHandle's `_internal`, and the
    // web adapter's readFile requires that to be a raw FileSystemFileHandle.
    // When the sibling listing misses the changed file (truncated listing, or
    // created after the parent was listed), the scan must resolve the real
    // child handle through the adapter's capability seam.
    const rawFreshFileHandle = {
      getFile: () => undefined,
      kind: 'file',
      name: 'fresh.md',
    };
    const rootHandle: DirectoryHandle = {
      _internal: { entries: () => undefined, kind: 'directory', name: 'workspace' },
      kind: 'directory',
      name: 'workspace',
      path: 'workspace',
      platform: 'web',
      rootId: 'web-root-id',
    };
    const resolveFileHandleByPath = vi.fn(
      async () => rawFreshFileHandle as unknown as FileSystemFileHandle
    );
    const fileSystemAdapter = {
      exists: vi.fn(),
      readDirectory: vi.fn(async (): Promise<IFileNode[]> => []),
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
      resolveFileHandleByPath,
    } as unknown as FileSystemAdapter;
    const processFiles = vi.fn(async (requests: FileContentRequest[]) =>
      Object.fromEntries(
        requests.map((request) => [
          request.compositeKey,
          { content: '# fresh', status: 'accessible' as const },
        ])
      )
    );
    const fileContentProcessor: FileContentProcessor = { processFiles };

    await collectPreparedWorkspaceSyncChanges({
      abortSignal: new AbortController().signal,
      context: {
        activeRootPath: rootHandle.path,
        collectionId: 'set-1',
        dbRootId: 'root-1',
        rootPath: rootHandle.path,
      },
      deps: {
        chunkingRedispatchTracker: new ChunkingRedispatchTracker(),
        fileContentProcessor,
        fileRecordRepository: {
          listManagedCacheEntryMetadata: vi.fn(async () => []),
        },
        fileSystemAdapter,
        onScanningPath: vi.fn(),
      },
      qosPolicy: BALANCED_QOS_POLICY,
      request: {
        indexingPolicyPreset: 'balanced',
        rootDirectoryHandle: rootHandle,
        scope: {
          changes: [
            {
              kind: 'file',
              path: 'fresh.md',
              type: 'modified',
            },
          ],
          mode: 'paths',
        },
      },
    });

    // Keyed by the durable rootId, not the root's display name and not a bare
    // relative path: see the real-adapter tests below for why both are unsafe.
    expect(resolveFileHandleByPath).toHaveBeenCalledWith('web-root-id/fresh.md');
    const readRequests = processFiles.mock.calls[0]?.[0];
    expect(readRequests).toHaveLength(1);
    expect(readRequests?.[0]?.fileNode.handle).toBe(rawFreshFileHandle);
  });

  it('keeps an unresolvable synthetic file surfacing in inaccessiblePaths', async () => {
    // The capability seam can genuinely fail (file deleted before the scan,
    // permission revoked mid-walk). The miss must stay explicit: the file
    // still flows to content processing with its synthetic descriptor handle
    // and lands in inaccessiblePaths — never dropped from the scan silently.
    const rootHandle: DirectoryHandle = {
      _internal: { entries: () => undefined, kind: 'directory', name: 'workspace' },
      kind: 'directory',
      name: 'workspace',
      path: 'workspace',
      platform: 'web',
      rootId: 'web-root-id',
    };
    const resolveFileHandleByPath = vi.fn(async (): Promise<FileSystemFileHandle> => {
      throw new Error('A requested file or directory could not be found.');
    });
    const fileSystemAdapter = {
      exists: vi.fn(),
      readDirectory: vi.fn(async (): Promise<IFileNode[]> => []),
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
      resolveFileHandleByPath,
    } as unknown as FileSystemAdapter;
    const processFiles = vi.fn(async (requests: FileContentRequest[]) =>
      Object.fromEntries(
        requests.map((request) => [
          request.compositeKey,
          { message: 'Invalid file handle', status: 'inaccessible' as const },
        ])
      )
    );
    const fileContentProcessor: FileContentProcessor = { processFiles };

    const result = await collectPreparedWorkspaceSyncChanges({
      abortSignal: new AbortController().signal,
      context: {
        activeRootPath: rootHandle.path,
        collectionId: 'set-1',
        dbRootId: 'root-1',
        rootPath: rootHandle.path,
      },
      deps: {
        chunkingRedispatchTracker: new ChunkingRedispatchTracker(),
        fileContentProcessor,
        fileRecordRepository: {
          listManagedCacheEntryMetadata: vi.fn(async () => []),
        },
        fileSystemAdapter,
        onScanningPath: vi.fn(),
      },
      qosPolicy: BALANCED_QOS_POLICY,
      request: {
        indexingPolicyPreset: 'balanced',
        rootDirectoryHandle: rootHandle,
        scope: {
          changes: [
            {
              kind: 'file',
              path: 'fresh.md',
              type: 'modified',
            },
          ],
          mode: 'paths',
        },
      },
    });

    expect(resolveFileHandleByPath).toHaveBeenCalledWith('web-root-id/fresh.md');
    const readRequests = processFiles.mock.calls[0]?.[0];
    expect(readRequests).toHaveLength(1);
    expect(readRequests?.[0]?.fileNode.handle).toEqual(
      expect.objectContaining({ kind: 'file', path: 'workspace/fresh.md', platform: 'web' })
    );
    // Two different path conventions meet here, and the difference is load
    // bearing: the adapter seam takes a ROOT-RELATIVE path ('fresh.md'), while
    // the managed-cache identity keeps the root-name prefix, because a web root
    // path is a bare folder name and normalizeSelectionPathForFolder only
    // strips prefixes it recognizes as absolute.
    expect(result.prepared.inaccessiblePaths).toEqual(['workspace/fresh.md']);
  });

  it('hands a real registered web root a path it can actually walk', async () => {
    // The mocked-seam tests above pin the wiring but NOT the path convention,
    // because a vi.fn() resolves regardless of the argument it is given. A
    // registered web root is keyed by a generated UUID (`lastRootFolderId`)
    // while the root handle's `path` is the picked folder's display NAME, so a
    // name-prefixed path makes the adapter walk a phantom `workspace/` child
    // and the fallback silently degrades back to the unreadable synthetic
    // handle. Only a real adapter catches that.
    const leafFileHandle = {
      getFile: vi.fn(),
      kind: 'file',
      name: 'fresh.md',
    } as unknown as FileSystemFileHandle;
    const getDirectoryHandle = vi.fn((name: string) =>
      Promise.reject(new Error(`NotFoundError: ${name}`))
    );
    const getFileHandle = vi.fn((name: string) =>
      name === 'fresh.md'
        ? Promise.resolve(leafFileHandle)
        : Promise.reject(new Error(`NotFoundError: ${name}`))
    );
    const rootDirHandle = {
      entries: () => emptyDirectoryListing(),
      getDirectoryHandle,
      getFileHandle,
      kind: 'directory',
      name: 'workspace',
    } as unknown as FileSystemDirectoryHandle;
    let registeredRootId = '';
    const handleCache = createHandleCacheStub({
      getRootHandle: vi.fn(async (folderId: string) =>
        folderId === registeredRootId ? rootDirHandle : null
      ),
    });
    const fileSystemAdapter = new WebFileSystemAdapter({ handleCache });
    (
      window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
    ).showDirectoryPicker = vi.fn(async () => rootDirHandle);
    // Registers the root under a generated UUID, exactly as production does,
    // and stamps the handle with it the way `ensureStamped` guarantees for
    // every root handle that reaches the reducer.
    const descriptor = await fileSystemAdapter.addRoot();
    registeredRootId = descriptor.rootId;
    const rootHandle: DirectoryHandle = { ...descriptor.handle, rootId: descriptor.rootId };
    const processFiles = vi.fn(async (requests: FileContentRequest[]) =>
      Object.fromEntries(
        requests.map((request) => [
          request.compositeKey,
          { content: '# fresh', status: 'accessible' as const },
        ])
      )
    );

    await collectPreparedWorkspaceSyncChanges({
      abortSignal: new AbortController().signal,
      context: {
        activeRootPath: rootHandle.path,
        collectionId: 'set-1',
        dbRootId: 'root-1',
        rootPath: rootHandle.path,
      },
      deps: {
        chunkingRedispatchTracker: new ChunkingRedispatchTracker(),
        fileContentProcessor: { processFiles },
        fileRecordRepository: {
          listManagedCacheEntryMetadata: vi.fn(async () => []),
        },
        fileSystemAdapter,
        onScanningPath: vi.fn(),
      },
      qosPolicy: BALANCED_QOS_POLICY,
      request: {
        indexingPolicyPreset: 'balanced',
        rootDirectoryHandle: rootHandle,
        scope: {
          changes: [
            {
              kind: 'file',
              path: 'fresh.md',
              type: 'modified',
            },
          ],
          mode: 'paths',
        },
      },
    });

    const readRequests = processFiles.mock.calls[0]?.[0];
    expect(readRequests).toHaveLength(1);
    expect(readRequests?.[0]?.fileNode.handle).toBe(leafFileHandle);
    // No phantom root-name segment: walking one would also resolve the WRONG
    // file whenever the root happens to contain a same-named child directory.
    expect(getDirectoryHandle).not.toHaveBeenCalled();
    expect(getFileHandle).toHaveBeenCalledWith('fresh.md');
  });

  it('resolves against a restored root, where no root has been picked this session', async () => {
    // restoreRoots() rehydrates roots from IndexedDB but never sets
    // `lastRootFolderId` — the ordinary state after a page reload. A
    // root-relative path then makes the adapter treat the file's own first
    // segment as a root-cache key, which matches nothing. Only the durable
    // rootId identifies the root being scanned.
    const leafFileHandle = {
      getFile: vi.fn(),
      kind: 'file',
      name: 'fresh.md',
    } as unknown as FileSystemFileHandle;
    const getFileHandle = vi.fn((name: string) =>
      name === 'fresh.md'
        ? Promise.resolve(leafFileHandle)
        : Promise.reject(new Error(`NotFoundError: ${name}`))
    );
    const rootDirHandle = {
      entries: () => emptyDirectoryListing(),
      getDirectoryHandle: vi.fn((name: string) =>
        Promise.reject(new Error(`NotFoundError: ${name}`))
      ),
      getFileHandle,
      kind: 'directory',
      name: 'workspace',
    } as unknown as FileSystemDirectoryHandle;
    const handleCache = createHandleCacheStub({
      getRootHandle: vi.fn(async (folderId: string) =>
        folderId === 'restored-root-id' ? rootDirHandle : null
      ),
    });
    // Deliberately NO addRoot()/requestDirectoryAccess(): lastRootFolderId stays null.
    const fileSystemAdapter = new WebFileSystemAdapter({ handleCache });
    const rootHandle: DirectoryHandle = {
      _internal: rootDirHandle,
      kind: 'directory',
      name: 'workspace',
      path: 'workspace',
      platform: 'web',
      rootId: 'restored-root-id',
    };
    const processFiles = vi.fn(async (requests: FileContentRequest[]) =>
      Object.fromEntries(
        requests.map((request) => [
          request.compositeKey,
          { content: '# fresh', status: 'accessible' as const },
        ])
      )
    );

    await collectPreparedWorkspaceSyncChanges({
      abortSignal: new AbortController().signal,
      context: {
        activeRootPath: rootHandle.path,
        collectionId: 'set-1',
        dbRootId: 'root-1',
        rootPath: rootHandle.path,
      },
      deps: {
        chunkingRedispatchTracker: new ChunkingRedispatchTracker(),
        fileContentProcessor: { processFiles },
        fileRecordRepository: {
          listManagedCacheEntryMetadata: vi.fn(async () => []),
        },
        fileSystemAdapter,
        onScanningPath: vi.fn(),
      },
      qosPolicy: BALANCED_QOS_POLICY,
      request: {
        indexingPolicyPreset: 'balanced',
        rootDirectoryHandle: rootHandle,
        scope: {
          changes: [{ kind: 'file', path: 'fresh.md', type: 'modified' }],
          mode: 'paths',
        },
      },
    });

    const readRequests = processFiles.mock.calls[0]?.[0];
    expect(readRequests?.[0]?.fileNode.handle).toBe(leafFileHandle);
    expect(getFileHandle).toHaveBeenCalledWith('fresh.md');
  });

  it('never reads a sibling root when scanning a root that is not the active one', async () => {
    // The scan is multi-root (`rootDirectoryHandles`), but the adapter resolves
    // relative paths against `lastRootFolderId` — the LAST root added. Scanning
    // any other root with a root-relative path would silently return the same
    // relative path from the WRONG root and index those bytes under this root's
    // database id. Failing to resolve is acceptable here; cross-root content is not.
    const alphaFileHandle = {
      getFile: vi.fn(),
      kind: 'file',
      name: 'fresh.md',
    } as unknown as FileSystemFileHandle;
    const alphaGetFileHandle = vi.fn(() => Promise.resolve(alphaFileHandle));
    const alphaDirHandle = {
      entries: () => emptyDirectoryListing(),
      getDirectoryHandle: vi.fn((name: string) =>
        Promise.reject(new Error(`NotFoundError: ${name}`))
      ),
      getFileHandle: alphaGetFileHandle,
      kind: 'directory',
      name: 'alpha',
    } as unknown as FileSystemDirectoryHandle;
    const betaDirHandle = {
      entries: () => emptyDirectoryListing(),
      getDirectoryHandle: vi.fn((name: string) =>
        Promise.reject(new Error(`NotFoundError: ${name}`))
      ),
      getFileHandle: vi.fn((name: string) => Promise.reject(new Error(`NotFoundError: ${name}`))),
      kind: 'directory',
      name: 'beta',
    } as unknown as FileSystemDirectoryHandle;
    const rootHandlesById = new Map<string, FileSystemDirectoryHandle>();
    const handleCache = createHandleCacheStub({
      getRootHandle: vi.fn(async (folderId: string) => rootHandlesById.get(folderId) ?? null),
    });
    const fileSystemAdapter = new WebFileSystemAdapter({ handleCache });
    const picker = vi
      .fn<() => Promise<FileSystemDirectoryHandle>>()
      .mockResolvedValueOnce(betaDirHandle)
      .mockResolvedValueOnce(alphaDirHandle);
    (
      window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
    ).showDirectoryPicker = picker;
    const beta = await fileSystemAdapter.addRoot();
    rootHandlesById.set(beta.rootId, betaDirHandle);
    // alpha is added LAST, so it becomes the adapter's active root.
    const alpha = await fileSystemAdapter.addRoot();
    rootHandlesById.set(alpha.rootId, alphaDirHandle);
    const betaRootHandle: DirectoryHandle = { ...beta.handle, rootId: beta.rootId };
    const processFiles = vi.fn(async (requests: FileContentRequest[]) =>
      Object.fromEntries(
        requests.map((request) => [
          request.compositeKey,
          { message: 'unreadable', status: 'inaccessible' as const },
        ])
      )
    );

    await collectPreparedWorkspaceSyncChanges({
      abortSignal: new AbortController().signal,
      context: {
        activeRootPath: betaRootHandle.path,
        collectionId: 'set-1',
        dbRootId: 'beta-db-root',
        rootPath: betaRootHandle.path,
      },
      deps: {
        chunkingRedispatchTracker: new ChunkingRedispatchTracker(),
        fileContentProcessor: { processFiles },
        fileRecordRepository: {
          listManagedCacheEntryMetadata: vi.fn(async () => []),
        },
        fileSystemAdapter,
        onScanningPath: vi.fn(),
      },
      qosPolicy: BALANCED_QOS_POLICY,
      request: {
        indexingPolicyPreset: 'balanced',
        rootDirectoryHandle: betaRootHandle,
        scope: {
          changes: [{ kind: 'file', path: 'fresh.md', type: 'modified' }],
          mode: 'paths',
        },
      },
    });

    // The safety property: alpha's bytes must never be indexed as beta's.
    const readRequests = processFiles.mock.calls[0]?.[0];
    expect(readRequests?.[0]?.fileNode.handle).not.toBe(alphaFileHandle);
    expect(alphaGetFileHandle).not.toHaveBeenCalled();
  });

  it('does not query the adapter at all for a root with no durable rootId', async () => {
    // Without a rootId there is no way to name the root being scanned, and the
    // adapter would resolve a bare relative path against whichever root was
    // added last. Asking anyway risks importing another root's bytes, so the
    // node stays synthetic and the path surfaces as inaccessible instead.
    const rootHandle: DirectoryHandle = {
      _internal: { entries: () => undefined, kind: 'directory', name: 'workspace' },
      kind: 'directory',
      name: 'workspace',
      path: 'workspace',
      platform: 'web',
    };
    const resolveFileHandleByPath = vi.fn();
    const fileSystemAdapter = {
      exists: vi.fn(),
      readDirectory: vi.fn(async (): Promise<IFileNode[]> => []),
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
      resolveFileHandleByPath,
    } as unknown as FileSystemAdapter;
    const processFiles = vi.fn(async (requests: FileContentRequest[]) =>
      Object.fromEntries(
        requests.map((request) => [
          request.compositeKey,
          { message: 'Invalid file handle', status: 'inaccessible' as const },
        ])
      )
    );

    const result = await collectPreparedWorkspaceSyncChanges({
      abortSignal: new AbortController().signal,
      context: {
        activeRootPath: rootHandle.path,
        collectionId: 'set-1',
        dbRootId: 'root-1',
        rootPath: rootHandle.path,
      },
      deps: {
        chunkingRedispatchTracker: new ChunkingRedispatchTracker(),
        fileContentProcessor: { processFiles },
        fileRecordRepository: {
          listManagedCacheEntryMetadata: vi.fn(async () => []),
        },
        fileSystemAdapter,
        onScanningPath: vi.fn(),
      },
      qosPolicy: BALANCED_QOS_POLICY,
      request: {
        indexingPolicyPreset: 'balanced',
        rootDirectoryHandle: rootHandle,
        scope: {
          changes: [{ kind: 'file', path: 'fresh.md', type: 'modified' }],
          mode: 'paths',
        },
      },
    });

    expect(resolveFileHandleByPath).not.toHaveBeenCalled();
    expect(result.prepared.inaccessiblePaths).toEqual(['workspace/fresh.md']);
  });
});
