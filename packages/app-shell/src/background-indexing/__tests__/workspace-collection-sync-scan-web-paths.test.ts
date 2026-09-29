import type { FileContentRequest } from '@brainstrike/file-explorer-hooks';
import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import { ChunkingRedispatchTracker } from '../workspace-collection-sync-import';
import { collectPreparedWorkspaceSyncChanges } from '../workspace-collection-sync-scan';
import { BALANCED_QOS_POLICY } from './workspace-collection-sync-service-test-helpers';

/**
 * How the WEB watcher's path shape flows through the scoped scan.
 *
 * The web adapter emits change paths as `${rootHandle.path}/${relative}` —
 * already anchored at the root — while the desktop adapter emits absolute
 * paths whose root prefix IS stripped. These tests pin that difference at
 * every place the two coordinates meet, plus a desktop regression guard.
 */
describe('workspace collection scoped traversal — web watcher paths', () => {
  it('keeps the managed-cache identity stable for a real web watcher path', async () => {
    // The web watcher emits `${rootHandle.path}/${relative}` (web-adapter
    // watchDirectory), i.e. 'workspace/fresh.md' — already anchored at the
    // root, NOT root-relative. Re-joining it onto the root path doubles the
    // leading segment, so the scan writes a row at 'workspace/workspace/…'
    // that no full scan will ever match: the file's real row never updates and
    // a phantom duplicate accumulates instead.
    const existingEntry = {
      chunksProcessedAt: '2026-08-19T00:00:00.000Z',
      contentHash: 'stale-hash',
      embeddingSetId: 'set-1',
      fileRecordId: 'file-record-1',
      mtimeMs: 1,
      relativePath: 'workspace/fresh.md',
      rootId: 'root-1',
      size: 1,
      updatedAt: '2026-08-19T00:00:00.000Z',
    };
    const rootHandle: DirectoryHandle = {
      _internal: { entries: () => undefined, kind: 'directory', name: 'workspace' },
      kind: 'directory',
      name: 'workspace',
      path: 'workspace',
      platform: 'web',
      rootId: 'web-root-id',
    };
    const rawFileHandle = { getFile: vi.fn(), kind: 'file', name: 'fresh.md' };
    const fileSystemAdapter = {
      exists: vi.fn(),
      // Sibling listing misses the file: the synthetic-fallback branch.
      readDirectory: vi.fn(async (): Promise<IFileNode[]> => []),
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
      resolveFileHandleByPath: vi.fn(async () => rawFileHandle as unknown as FileSystemFileHandle),
    } as unknown as FileSystemAdapter;
    const processFiles = vi.fn(async (requests: FileContentRequest[]) =>
      Object.fromEntries(
        requests.map((request) => [
          request.compositeKey,
          { content: '# fresh', status: 'accessible' as const },
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
          listManagedCacheEntryMetadata: vi.fn(async () => [existingEntry]),
        },
        fileSystemAdapter,
        onScanningPath: vi.fn(),
      },
      qosPolicy: BALANCED_QOS_POLICY,
      request: {
        indexingPolicyPreset: 'balanced',
        rootDirectoryHandle: rootHandle,
        scope: {
          changes: [{ kind: 'file', path: 'workspace/fresh.md', type: 'modified' }],
          mode: 'paths',
        },
      },
    });

    // Updates the file's existing row rather than minting a doubled-path duplicate.
    expect(result.prepared.changes).toHaveLength(1);
    expect(result.prepared.changes[0]?.relativePath).toBe('workspace/fresh.md');
    expect(result.prepared.changes[0]?.mode).toBe('replace');
    expect(result.prepared.changes[0]?.id).toBe('file-record-1');
  });

  it('asks the adapter for the path relative to the root, not the cache identity', async () => {
    // On web the managed-cache identity keeps the root-name prefix
    // ('workspace/fresh.md') while the adapter walks from the root handle and
    // needs 'fresh.md'. Handing it the cache identity makes it walk a phantom
    // 'workspace' child of the root.
    const rootHandle: DirectoryHandle = {
      _internal: { entries: () => undefined, kind: 'directory', name: 'workspace' },
      kind: 'directory',
      name: 'workspace',
      path: 'workspace',
      platform: 'web',
      rootId: 'web-root-id',
    };
    const rawFileHandle = { getFile: vi.fn(), kind: 'file', name: 'fresh.md' };
    const resolveFileHandleByPath = vi.fn(
      async () => rawFileHandle as unknown as FileSystemFileHandle
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
          changes: [{ kind: 'file', path: 'workspace/fresh.md', type: 'modified' }],
          mode: 'paths',
        },
      },
    });

    expect(resolveFileHandleByPath).toHaveBeenCalledWith('web-root-id/fresh.md');
    const readRequests = processFiles.mock.calls[0]?.[0];
    expect(readRequests?.[0]?.fileNode.handle).toBe(rawFileHandle);
    expect(readRequests?.[0]?.fileNode.path).toBe('workspace/fresh.md');
  });

  it('leaves absolute (desktop) watcher paths untouched', async () => {
    // Regression guard for the fix above: on desktop the change path is
    // absolute and the cache identity IS the root-relative path, so anchoring
    // must not disturb either.
    const rootHandle: DirectoryHandle = {
      kind: 'directory',
      name: 'root',
      path: '/workspace/root',
      platform: 'electron',
      rootId: 'desktop-root',
    };
    const fileSystemAdapter = {
      exists: vi.fn(),
      readDirectory: vi.fn(async (): Promise<IFileNode[]> => []),
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
    } as unknown as FileSystemAdapter;
    const processFiles = vi.fn(async (requests: FileContentRequest[]) =>
      Object.fromEntries(
        requests.map((request) => [
          request.compositeKey,
          { content: '# fresh', status: 'accessible' as const },
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
          changes: [{ kind: 'file', path: '/workspace/root/nested/fresh.md', type: 'modified' }],
          mode: 'paths',
        },
      },
    });

    expect(result.prepared.changes[0]?.relativePath).toBe('nested/fresh.md');
    const readRequests = processFiles.mock.calls[0]?.[0];
    expect(readRequests?.[0]?.fileNode.path).toBe('/workspace/root/nested/fresh.md');
  });

  it('indexes a changed subtree for a real web watcher directory path', async () => {
    // The web watcher classifies every appeared/removed directory as
    // kind:'directory' and emits a root-anchored path. Walking that path as if
    // it were root-relative looks for a child of the root named after the ROOT,
    // finds nothing, and drops the entire subtree — with no inaccessiblePaths
    // entry, so the loss is invisible.
    const rootHandle: DirectoryHandle = {
      _internal: { entries: () => undefined, kind: 'directory', name: 'workspace' },
      kind: 'directory',
      name: 'workspace',
      path: 'workspace',
      platform: 'web',
      rootId: 'web-root-id',
    };
    const nestedRawHandle = { entries: () => undefined, kind: 'directory', name: 'nested' };
    const readDirectory = vi.fn(async (handle: DirectoryHandle): Promise<IFileNode[]> => {
      if (handle.path === 'workspace') {
        return [
          {
            children: [],
            depth: 0,
            handle: nestedRawHandle as unknown as IFileNode['handle'],
            name: 'nested',
            path: 'workspace/nested',
            rootFolderId: 'workspace',
            selectionState: 'unchecked',
            type: 'directory',
          },
        ];
      }
      if (handle.path === 'workspace/nested') {
        return [
          {
            depth: 0,
            handle: {
              getFile: () => undefined,
              kind: 'file',
              name: 'a.md',
            } as unknown as IFileNode['handle'],
            lastModified: 5,
            name: 'a.md',
            path: 'workspace/nested/a.md',
            rootFolderId: 'workspace',
            selectionState: 'unchecked',
            size: 3,
            type: 'file',
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
    const processFiles = vi.fn(async (requests: FileContentRequest[]) =>
      Object.fromEntries(
        requests.map((request) => [
          request.compositeKey,
          { content: '# a', status: 'accessible' as const },
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
          changes: [{ kind: 'directory', path: 'workspace/nested', type: 'modified' }],
          mode: 'paths',
        },
      },
    });

    expect(result.prepared.changes.map((change) => change.relativePath)).toEqual([
      'workspace/nested/a.md',
    ]);
  });

  it('uses the sibling listing for a real web watcher file path', async () => {
    // The parent walk must find the root for a root-anchored change path.
    // When it does not, every web file change silently falls through to the
    // synthetic fallback and loses the listing's size/mtime — which the
    // stat-cache fast path needs.
    const rootHandle: DirectoryHandle = {
      _internal: { entries: () => undefined, kind: 'directory', name: 'workspace' },
      kind: 'directory',
      name: 'workspace',
      path: 'workspace',
      platform: 'web',
      rootId: 'web-root-id',
    };
    const listedFileHandle = { getFile: () => undefined, kind: 'file', name: 'fresh.md' };
    const resolveFileHandleByPath = vi.fn();
    const fileSystemAdapter = {
      exists: vi.fn(),
      readDirectory: vi.fn(
        async (handle: DirectoryHandle): Promise<IFileNode[]> =>
          handle.path === 'workspace'
            ? [
                {
                  depth: 0,
                  handle: listedFileHandle as unknown as IFileNode['handle'],
                  lastModified: 7,
                  name: 'fresh.md',
                  path: 'workspace/fresh.md',
                  rootFolderId: 'workspace',
                  selectionState: 'unchecked',
                  size: 11,
                  type: 'file',
                },
              ]
            : []
      ),
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
          changes: [{ kind: 'file', path: 'workspace/fresh.md', type: 'modified' }],
          mode: 'paths',
        },
      },
    });

    const readRequests = processFiles.mock.calls[0]?.[0];
    // Node came from the listing, so it carries real stat metadata...
    expect(readRequests?.[0]?.fileNode.handle).toBe(listedFileHandle);
    expect(readRequests?.[0]?.fileNode.size).toBe(11);
    // ...and the synthetic-handle fallback was never needed.
    expect(resolveFileHandleByPath).not.toHaveBeenCalled();
  });

  it('applies exclusion policy to the root-relative path on web', async () => {
    // The entry policy contract (background-indexing-policy.ts) requires a
    // ROOT-RELATIVE path. Handing it the web cache identity prefixes every path
    // with the root name, so prefix-anchored exclusions never match.
    const rootHandle: DirectoryHandle = {
      _internal: { entries: () => undefined, kind: 'directory', name: 'workspace' },
      kind: 'directory',
      name: 'workspace',
      path: 'workspace',
      platform: 'web',
      rootId: 'web-root-id',
    };
    const fileSystemAdapter = {
      exists: vi.fn(),
      readDirectory: vi.fn(async (): Promise<IFileNode[]> => []),
      readFile: vi.fn(),
      requestDirectoryAccess: vi.fn(),
      resolveFileHandleByPath: vi.fn(),
    } as unknown as FileSystemAdapter;
    const processFiles = vi.fn(async () => ({}));

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
          changes: [{ kind: 'directory', path: 'workspace/node_modules', type: 'modified' }],
          mode: 'paths',
        },
      },
    });

    expect(result.prepared.excludedEntries).toBeGreaterThan(0);
    expect(result.prepared.changes).toEqual([]);
  });
});
