import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebFileSystemAdapter } from '../adapters/web-adapter';
import type { HandleCache, StoredRootHandle } from '../adapters/web-handle-cache';
import type { DirectoryHandle, FileHandle } from '../types';

function createFile(name: string, content = 'data', lastModified = Date.now()) {
  return {
    size: content.length,
    lastModified,
    async text() {
      return content;
    },
    name,
  } as unknown as File;
}

const createHandleCache = (overrides: Partial<HandleCache> = {}): HandleCache => ({
  storeRootHandle: vi.fn().mockResolvedValue(undefined),
  getRootHandle: vi.fn().mockResolvedValue(null),
  getAllRootHandles: vi.fn().mockResolvedValue([]),
  removeRootHandle: vi.fn().mockResolvedValue(undefined),
  restoreLastRootHandle: vi.fn().mockResolvedValue(null),
  getLastRootHandleForRestore: vi.fn().mockResolvedValue(null),
  markHandleRestored: vi.fn().mockResolvedValue(undefined),
  storeFileHandle: vi.fn().mockResolvedValue(undefined),
  getFileHandle: vi.fn().mockResolvedValue(null),
  removeFileHandle: vi.fn().mockResolvedValue(undefined),
  clear: vi.fn().mockResolvedValue(undefined),
  pruneOldHandles: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('WebFileSystemAdapter', () => {
  let adapter: WebFileSystemAdapter;

  beforeEach(() => {
    adapter = new WebFileSystemAdapter();
    vi.restoreAllMocks();
  });

  describe('requestDirectoryAccess', () => {
    it('returns handle when showDirectoryPicker resolves', async () => {
      const dirHandle = {
        name: 'root',
        kind: 'directory',
        entries: vi.fn(),
      } as unknown as FileSystemDirectoryHandle;
      (
        window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
      ).showDirectoryPicker = vi.fn().mockResolvedValue(dirHandle);

      const handle = await adapter.requestDirectoryAccess();
      expect(handle).toEqual({
        path: 'root',
        name: 'root',
        kind: 'directory',
        platform: 'web',
        _internal: dirHandle,
      });
    });

    it('persists the directory handle for restore', async () => {
      const dirHandle = {
        name: 'root',
        kind: 'directory',
        entries: vi.fn(),
      } as unknown as FileSystemDirectoryHandle;
      (
        window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
      ).showDirectoryPicker = vi.fn().mockResolvedValue(dirHandle);

      const handleCache = createHandleCache();
      const adapter = new WebFileSystemAdapter({ handleCache });

      await adapter.requestDirectoryAccess();

      // Since requestDirectoryAccess delegates to addRoot, storage is now keyed
      // by a generated RootId (UUID), not by dirHandle.name.
      expect(handleCache.storeRootHandle).toHaveBeenCalledOnce();
      const [storedKey, storedHandle] = (handleCache.storeRootHandle as Mock).mock.calls[0] ?? [];
      expect(storedKey).toMatch(/^[0-9a-f-]{36}$/);
      expect(storedHandle).toBe(dirHandle);
    });

    it('requests persistent storage once and still returns the directory when persistence fails', async () => {
      const dirHandle = {
        name: 'root',
        kind: 'directory',
        entries: vi.fn(),
      } as unknown as FileSystemDirectoryHandle;
      (
        window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
      ).showDirectoryPicker = vi.fn().mockResolvedValue(dirHandle);
      const persisted = vi.fn().mockResolvedValue(false);
      const persist = vi.fn().mockRejectedValue(new Error('quota prompt failed'));
      const originalStorage = navigator.storage;
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { persisted, persist },
      });
      const handleCache = createHandleCache();
      const adapter = new WebFileSystemAdapter({ handleCache });

      try {
        await expect(adapter.requestDirectoryAccess()).resolves.toMatchObject({
          name: 'root',
          path: 'root',
        });
        await expect(adapter.requestDirectoryAccess()).resolves.toMatchObject({
          name: 'root',
          path: 'root',
        });

        expect(persisted).toHaveBeenCalledOnce();
        expect(persist).toHaveBeenCalledOnce();
        expect(handleCache.storeRootHandle).toHaveBeenCalledTimes(2);
      } finally {
        Object.defineProperty(navigator, 'storage', {
          configurable: true,
          value: originalStorage,
        });
      }
    });

    it('throws when showDirectoryPicker is missing', async () => {
      // biome-ignore lint/performance/noDelete: simulating missing API
      delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
      await expect(adapter.requestDirectoryAccess()).rejects.toThrow(
        'File System Access API not supported'
      );
    });

    it('throws when showDirectoryPicker rejects', async () => {
      (window as unknown as { showDirectoryPicker: () => Promise<never> }).showDirectoryPicker = vi
        .fn()
        .mockRejectedValue(new Error('fail'));
      await expect(adapter.requestDirectoryAccess()).rejects.toThrow('fail');
    });

    it('supports includeMetadata: false (no size/lastModified on files)', async () => {
      const fileHandle = {
        kind: 'file',
        name: 'file.txt',
        getFile: vi.fn().mockResolvedValue(createFile('file.txt', 'x', 1)),
      } as unknown as FileSystemFileHandle;
      const subHandle = {
        kind: 'directory',
        name: 'sub',
        entries: vi.fn(),
      } as unknown as FileSystemDirectoryHandle;
      async function* entries() {
        yield ['sub', subHandle];
        yield ['file.txt', fileHandle];
      }
      const dirHandle = {
        name: 'root',
        kind: 'directory',
        entries,
      } as unknown as FileSystemDirectoryHandle;
      const handle: DirectoryHandle = {
        path: 'root',
        name: 'root',
        kind: 'directory',
        platform: 'web',
        _internal: dirHandle,
      };

      const adapter = new WebFileSystemAdapter();
      const entriesList = await adapter.readDirectory(handle, { includeMetadata: false });
      const file = entriesList.find((e) => e.type === 'file' && e.name === 'file.txt');
      expect(file).toBeTruthy();
      expect('size' in (file as object)).toBe(false);
      expect('lastModified' in (file as object)).toBe(false);
    });

    it('respects concurrency limit when fetching file metadata', async () => {
      const makeFileHandle = (name: string) => {
        let getFileImpl: () => Promise<File>;
        const fileHandle = {
          kind: 'file' as const,
          name,
          getFile: vi.fn(async () => getFileImpl()),
        } as unknown as FileSystemFileHandle;
        return {
          fileHandle,
          setImpl(impl: () => Promise<File>) {
            getFileImpl = impl;
          },
        };
      };

      const count = 8;
      const items = Array.from({ length: count }, (_, i) => makeFileHandle(`f${i}.txt`));

      let active = 0;
      let peak = 0;
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (const item of items) {
        item.setImpl(async () => {
          active++;
          peak = Math.max(peak, active);
          await delay(25);
          active--;
          return createFile('x.txt', 'x', 1);
        });
      }

      async function* entries() {
        for (const it of items) {
          yield [it.fileHandle.name, it.fileHandle as unknown as FileSystemHandle] as const;
        }
      }
      const dirHandle = {
        name: 'root',
        kind: 'directory' as const,
        entries,
      } as unknown as FileSystemDirectoryHandle;
      const handle: DirectoryHandle = {
        path: 'root',
        name: 'root',
        kind: 'directory',
        platform: 'web',
        _internal: dirHandle,
      };

      const adapter = new WebFileSystemAdapter();
      const concurrency = 2;
      vi.useFakeTimers();
      const promise = adapter.readDirectory(handle, { includeMetadata: true, concurrency });
      await vi.runAllTimersAsync();
      const list = await promise;
      vi.useRealTimers();
      expect(list.filter((e) => e.type === 'file')).toHaveLength(count);
      expect(peak).toBeLessThanOrEqual(concurrency);
    });
  });

  describe('readDirectory', () => {
    it('throws when directory handles are malformed', async () => {
      await expect(
        adapter.readDirectory({
          path: '',
          name: 'root',
          kind: 'directory',
          platform: 'web',
          _internal: {} as unknown as FileSystemDirectoryHandle,
        })
      ).rejects.toThrow('Directory handle is missing its canonical path');

      await expect(
        adapter.readDirectory({
          path: 'root',
          name: 'root',
          kind: 'directory',
          platform: 'web',
          _internal: {} as unknown as FileSystemDirectoryHandle,
        })
      ).rejects.toMatchObject({
        name: 'AccessError',
        message: 'Invalid directory handle',
        path: 'root',
      });
    });

    it('returns directory entries', async () => {
      const file = createFile('file.txt', 'hello', 123);
      const fileHandle = {
        kind: 'file',
        name: 'file.txt',
        getFile: vi.fn().mockResolvedValue(file),
      } as unknown as FileSystemFileHandle;
      const subHandle = {
        kind: 'directory',
        name: 'sub',
        entries: vi.fn(),
      } as unknown as FileSystemDirectoryHandle;
      async function* entries() {
        yield ['sub', subHandle];
        yield ['file.txt', fileHandle];
      }
      const dirHandle = {
        name: 'root',
        kind: 'directory',
        entries,
      } as unknown as FileSystemDirectoryHandle;
      const handle: DirectoryHandle = {
        path: 'root',
        name: 'root',
        kind: 'directory',
        platform: 'web',
        _internal: dirHandle,
      };

      const entriesList = await adapter.readDirectory(handle);
      expect(entriesList).toHaveLength(2);
      const first = entriesList[0];
      const second = entriesList[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!(first && second)) {
        throw new Error('unreachable');
      }
      expect(first.type).toBe('directory');
      expect(first.name).toBe('sub');
      expect(second.type).toBe('file');
      expect(second.name).toBe('file.txt');
      expect(second.size).toBe(file.size);
      expect(second.lastModified).toBe(file.lastModified);
    });

    it('propagates errors from entries()', async () => {
      const dirHandle = {
        name: 'bad',
        kind: 'directory',
        entries: vi.fn().mockImplementation(() => {
          throw new Error('boom');
        }),
      } as unknown as FileSystemDirectoryHandle;
      const handle: DirectoryHandle = {
        path: 'bad',
        name: 'bad',
        kind: 'directory',
        platform: 'web',
        _internal: dirHandle,
      };
      await expect(adapter.readDirectory(handle)).rejects.toThrow('boom');
    });

    it('caches discovered file handles during directory enumeration', async () => {
      const handleCache = createHandleCache();
      const adapter = new WebFileSystemAdapter({ handleCache });
      const fileHandle = {
        kind: 'file',
        name: 'file.txt',
        getFile: vi.fn().mockResolvedValue(createFile('file.txt', 'hello', 123)),
      } as unknown as FileSystemFileHandle;
      const subHandle = {
        kind: 'directory',
        name: 'sub',
        entries: vi.fn(),
      } as unknown as FileSystemDirectoryHandle;
      async function* entries() {
        yield ['sub', subHandle];
        yield ['file.txt', fileHandle];
      }
      const dirHandle = {
        name: 'root',
        kind: 'directory',
        entries,
      } as unknown as FileSystemDirectoryHandle;
      const handle: DirectoryHandle = {
        path: 'root',
        name: 'root',
        kind: 'directory',
        platform: 'web',
        _internal: dirHandle,
      };

      await adapter.readDirectory(handle);

      expect(handleCache.storeFileHandle).toHaveBeenCalledWith('root', 'root/file.txt', fileHandle);
    });

    it('drops file entries whose metadata cannot be read while preserving directories', async () => {
      const fileHandle = {
        kind: 'file',
        name: 'broken.txt',
        getFile: vi.fn().mockRejectedValue(new Error('metadata unavailable')),
      } as unknown as FileSystemFileHandle;
      const subHandle = {
        kind: 'directory',
        name: 'sub',
        entries: vi.fn(),
      } as unknown as FileSystemDirectoryHandle;
      async function* entries() {
        yield ['broken.txt', fileHandle];
        yield ['sub', subHandle];
      }
      const dirHandle = {
        name: 'root',
        kind: 'directory',
        entries,
      } as unknown as FileSystemDirectoryHandle;
      const handle: DirectoryHandle = {
        path: 'root',
        name: 'root',
        kind: 'directory',
        platform: 'web',
        _internal: dirHandle,
      };

      const entriesList = await adapter.readDirectory(handle);

      expect(entriesList).toEqual([expect.objectContaining({ name: 'sub', type: 'directory' })]);
    });

    it('reads a file by path through the cached root directory handle', async () => {
      const fileHandle = {
        kind: 'file',
        name: 'file.txt',
        getFile: vi.fn().mockResolvedValue(createFile('file.txt', 'hello world', 123)),
      } as unknown as FileSystemFileHandle;
      const nestedDirHandle = {
        kind: 'directory',
        name: 'nested',
        getFileHandle: vi.fn().mockResolvedValue(fileHandle),
      } as unknown as FileSystemDirectoryHandle;
      const rootDirHandle = {
        kind: 'directory',
        name: 'root',
        getDirectoryHandle: vi.fn().mockResolvedValue(nestedDirHandle),
      } as unknown as FileSystemDirectoryHandle;

      const handleCache = createHandleCache({
        getRootHandle: vi.fn().mockResolvedValue(rootDirHandle),
        storeFileHandle: vi.fn().mockResolvedValue(undefined),
      });
      const adapter = new WebFileSystemAdapter({ handleCache });

      await expect(adapter.readFileByPath('root/nested/file.txt')).resolves.toBe('hello world');
      expect(handleCache.getRootHandle).toHaveBeenCalledWith('root');
      expect(rootDirHandle.getDirectoryHandle).toHaveBeenCalledWith('nested');
      expect(nestedDirHandle.getFileHandle).toHaveBeenCalledWith('file.txt');
      expect(handleCache.storeFileHandle).toHaveBeenCalledWith(
        'root',
        'root/nested/file.txt',
        fileHandle
      );
    });

    it('reads a root-relative file path through the active cached root directory handle', async () => {
      const fileHandle = {
        kind: 'file',
        name: 'file.txt',
        getFile: vi.fn().mockResolvedValue(createFile('file.txt', 'hello world', 123)),
      } as unknown as FileSystemFileHandle;
      const nestedDirHandle = {
        kind: 'directory',
        name: 'nested',
        getFileHandle: vi.fn().mockResolvedValue(fileHandle),
      } as unknown as FileSystemDirectoryHandle;
      const rootDirHandle = {
        kind: 'directory',
        name: 'root',
        getDirectoryHandle: vi.fn().mockResolvedValue(nestedDirHandle),
      } as unknown as FileSystemDirectoryHandle;

      const handleCache = createHandleCache({
        getRootHandle: vi.fn().mockResolvedValue(rootDirHandle),
        storeFileHandle: vi.fn().mockResolvedValue(undefined),
      });
      const adapter = new WebFileSystemAdapter({ handleCache });
      (
        window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
      ).showDirectoryPicker = vi.fn().mockResolvedValue(rootDirHandle);

      await adapter.requestDirectoryAccess();

      await expect(adapter.readFileByPath('nested/file.txt')).resolves.toBe('hello world');

      // Since requestDirectoryAccess now delegates to addRoot, the lastRootFolderId
      // is a generated UUID. getRootHandle and storeFileHandle are called with that
      // UUID, not with the directory name.
      const firstGetRootCall = (handleCache.getRootHandle as Mock).mock.calls[0];
      const resolvedRootId = firstGetRootCall?.[0] as string;
      expect(resolvedRootId).toMatch(/^[0-9a-f-]{36}$/);
      expect(rootDirHandle.getDirectoryHandle).toHaveBeenCalledWith('nested');
      expect(nestedDirHandle.getFileHandle).toHaveBeenCalledWith('file.txt');
      expect(handleCache.storeFileHandle).toHaveBeenCalledWith(
        resolvedRootId,
        'nested/file.txt',
        fileHandle
      );
    });
  });

  describe('resolveFileHandleByPath', () => {
    it('returns the leaf FileSystemFileHandle by walking the cached root handle', async () => {
      const fileHandle = {
        kind: 'file',
        name: 'file.txt',
        getFile: vi.fn(),
      } as unknown as FileSystemFileHandle;
      const nestedDirHandle = {
        kind: 'directory',
        name: 'nested',
        getFileHandle: vi.fn().mockResolvedValue(fileHandle),
      } as unknown as FileSystemDirectoryHandle;
      const rootDirHandle = {
        kind: 'directory',
        name: 'root',
        getDirectoryHandle: vi.fn().mockResolvedValue(nestedDirHandle),
      } as unknown as FileSystemDirectoryHandle;

      const handleCache = createHandleCache({
        getRootHandle: vi.fn().mockResolvedValue(rootDirHandle),
      });
      const adapter = new WebFileSystemAdapter({ handleCache });

      const resolved = await adapter.resolveFileHandleByPath('root/nested/file.txt');

      expect(resolved).toBe(fileHandle);
      expect(handleCache.getRootHandle).toHaveBeenCalledWith('root');
      expect(rootDirHandle.getDirectoryHandle).toHaveBeenCalledWith('nested');
      expect(nestedDirHandle.getFileHandle).toHaveBeenCalledWith('file.txt');
      // Resolution alone must not call getFile() — keep main thread quiet.
      expect(fileHandle.getFile).not.toHaveBeenCalled();
    });

    it('caches the resolved file handle so future readFileByPath skips the walk', async () => {
      const fileHandle = {
        kind: 'file',
        name: 'file.txt',
        getFile: vi.fn(),
      } as unknown as FileSystemFileHandle;
      const nestedDirHandle = {
        kind: 'directory',
        name: 'nested',
        getFileHandle: vi.fn().mockResolvedValue(fileHandle),
      } as unknown as FileSystemDirectoryHandle;
      const rootDirHandle = {
        kind: 'directory',
        name: 'root',
        getDirectoryHandle: vi.fn().mockResolvedValue(nestedDirHandle),
      } as unknown as FileSystemDirectoryHandle;
      const storeFileHandle = vi.fn().mockResolvedValue(undefined);
      const handleCache = createHandleCache({
        getRootHandle: vi.fn().mockResolvedValue(rootDirHandle),
        storeFileHandle,
      });
      const adapter = new WebFileSystemAdapter({ handleCache });

      await adapter.resolveFileHandleByPath('root/nested/file.txt');

      expect(storeFileHandle).toHaveBeenCalledWith('root', 'root/nested/file.txt', fileHandle);
    });

    it('throws AccessError when the cached root handle is missing', async () => {
      const handleCache = createHandleCache();
      const adapter = new WebFileSystemAdapter({ handleCache });

      await expect(adapter.resolveFileHandleByPath('root/nested/file.txt')).rejects.toMatchObject({
        name: 'AccessError',
        path: 'root/nested/file.txt',
      });
    });

    it('throws AccessError when the path does not reference a file', async () => {
      const rootDirHandle = {
        kind: 'directory',
        name: 'root',
        getDirectoryHandle: vi.fn(),
      } as unknown as FileSystemDirectoryHandle;
      const handleCache = createHandleCache({
        getRootHandle: vi.fn().mockResolvedValue(rootDirHandle),
      });
      const adapter = new WebFileSystemAdapter({ handleCache });

      await expect(adapter.resolveFileHandleByPath('root')).rejects.toMatchObject({
        name: 'AccessError',
        path: 'root',
      });
      // No directory walk should have started for an empty relative path.
      expect(rootDirHandle.getDirectoryHandle).not.toHaveBeenCalled();
    });

    it('propagates underlying browser errors when an intermediate segment is missing', async () => {
      const rootDirHandle = {
        kind: 'directory',
        name: 'root',
        getDirectoryHandle: vi.fn().mockRejectedValue(new Error('NotFoundError')),
      } as unknown as FileSystemDirectoryHandle;
      const handleCache = createHandleCache({
        getRootHandle: vi.fn().mockResolvedValue(rootDirHandle),
      });
      const adapter = new WebFileSystemAdapter({ handleCache });

      await expect(adapter.resolveFileHandleByPath('root/missing/file.txt')).rejects.toThrow(
        'NotFoundError'
      );
    });

    it('readFileByPath delegates to resolveFileHandleByPath and reads the resolved file', async () => {
      const file = createFile('file.txt', 'hello world', 123);
      const fileHandle = {
        kind: 'file',
        name: 'file.txt',
        getFile: vi.fn().mockResolvedValue(file),
      } as unknown as FileSystemFileHandle;
      const nestedDirHandle = {
        kind: 'directory',
        name: 'nested',
        getFileHandle: vi.fn().mockResolvedValue(fileHandle),
      } as unknown as FileSystemDirectoryHandle;
      const rootDirHandle = {
        kind: 'directory',
        name: 'root',
        getDirectoryHandle: vi.fn().mockResolvedValue(nestedDirHandle),
      } as unknown as FileSystemDirectoryHandle;

      const handleCache = createHandleCache({
        getRootHandle: vi.fn().mockResolvedValue(rootDirHandle),
      });
      const adapter = new WebFileSystemAdapter({ handleCache });

      const resolveSpy = vi.spyOn(adapter, 'resolveFileHandleByPath');

      await expect(adapter.readFileByPath('root/nested/file.txt')).resolves.toBe('hello world');
      expect(resolveSpy).toHaveBeenCalledWith('root/nested/file.txt');
      expect(fileHandle.getFile).toHaveBeenCalledOnce();
    });

    it('resolveFileForIndexing returns kind: handle wrapping the resolved FileSystemFileHandle plus authoritative fileSize', async () => {
      // The web platform always has a real, structured-clone-safe handle, so
      // the union-typed adapter contract collapses to `kind: 'handle'`. The
      // background indexer integration uses this branch directly to hand
      // bytes off to the worker without round-tripping through the main
      // thread (the perf-critical fast path on Select All).
      //
      // The resolver also returns `fileSize` from `getFile()` metadata so the
      // dispatcher can enforce MAX_INDEXABLE_FILE_SIZE on resolver-surfaced
      // files (whose parent folder may never have been expanded and therefore
      // never had its size cached during the lazy tree walk).
      const file = createFile('file.txt', 'hello world', 11);
      const fileHandle = {
        kind: 'file',
        name: 'file.txt',
        getFile: vi.fn().mockResolvedValue(file),
      } as unknown as FileSystemFileHandle;
      const nestedDirHandle = {
        kind: 'directory',
        name: 'nested',
        getFileHandle: vi.fn().mockResolvedValue(fileHandle),
      } as unknown as FileSystemDirectoryHandle;
      const rootDirHandle = {
        kind: 'directory',
        name: 'root',
        getDirectoryHandle: vi.fn().mockResolvedValue(nestedDirHandle),
      } as unknown as FileSystemDirectoryHandle;

      const handleCache = createHandleCache({
        getRootHandle: vi.fn().mockResolvedValue(rootDirHandle),
      });
      const adapter = new WebFileSystemAdapter({ handleCache });

      const resolveSpy = vi.spyOn(adapter, 'resolveFileHandleByPath');

      const resolution = await adapter.resolveFileForIndexing('root/nested/file.txt');

      expect(resolution).toEqual({ kind: 'handle', fileHandle, fileSize: 11 });
      expect(resolveSpy).toHaveBeenCalledWith('root/nested/file.txt');
      expect(fileHandle.getFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('readFile', () => {
    it('reads file content', async () => {
      const file = createFile('a.txt', 'text');
      const fileHandle = {
        kind: 'file',
        name: 'a.txt',
        getFile: vi.fn().mockResolvedValue(file),
      } as unknown as FileSystemFileHandle;
      const handle: FileHandle = {
        path: 'a.txt',
        name: 'a.txt',
        kind: 'file',
        platform: 'web',
        _internal: fileHandle,
      };
      const text = await adapter.readFile(handle);
      expect(text).toBe('text');
    });

    it('caches file handles on read', async () => {
      const file = createFile('a.txt', 'text');
      const fileHandle = {
        kind: 'file',
        name: 'a.txt',
        getFile: vi.fn().mockResolvedValue(file),
      } as unknown as FileSystemFileHandle;
      const handle: FileHandle = {
        path: 'root/a.txt',
        name: 'a.txt',
        kind: 'file',
        platform: 'web',
        rootFolderId: 'root',
        _internal: fileHandle,
      };
      const handleCache = createHandleCache();
      const adapter = new WebFileSystemAdapter({ handleCache });

      await adapter.readFile(handle);

      expect(handleCache.storeFileHandle).toHaveBeenCalledWith('root', 'root/a.txt', fileHandle);
    });

    it('propagates getFile errors', async () => {
      const fileHandle = {
        kind: 'file',
        name: 'fail.txt',
        getFile: vi.fn().mockRejectedValue(new Error('nope')),
      } as unknown as FileSystemFileHandle;
      const handle: FileHandle = {
        path: 'fail.txt',
        name: 'fail.txt',
        kind: 'file',
        platform: 'web',
        _internal: fileHandle,
      };
      await expect(adapter.readFile(handle)).rejects.toThrow('nope');
    });

    it('throws AccessError when handle lacks a file implementation', async () => {
      const handle: FileHandle = {
        path: 'missing',
        name: 'missing',
        kind: 'file',
        platform: 'web',
        _internal: {} as unknown as FileSystemFileHandle,
      };

      await expect(adapter.readFile(handle)).rejects.toMatchObject({
        name: 'AccessError',
        message: 'Invalid file handle',
        path: 'missing',
      });
    });

    it('rejects files larger than the 1MB limit', async () => {
      const largeContent = 'x'.repeat(1024 * 1024 + 1);
      const file = createFile('big.bin', largeContent);
      const fileHandle = {
        kind: 'file',
        name: 'big.bin',
        getFile: vi.fn().mockResolvedValue(file),
      } as unknown as FileSystemFileHandle;
      const handle: FileHandle = {
        path: 'big.bin',
        name: 'big.bin',
        kind: 'file',
        platform: 'web',
        _internal: fileHandle,
      };

      await expect(adapter.readFile(handle)).rejects.toMatchObject({
        name: 'AccessError',
        message: expect.stringContaining('File too large'),
        path: 'big.bin',
      });
    });
  });

  describe('restoreLastFolder', () => {
    it('returns null when no cached handle exists', async () => {
      const handleCache = createHandleCache();
      const adapter = new WebFileSystemAdapter({ handleCache });

      const restored = await adapter.restoreLastFolder();

      expect(restored).toBeNull();
      expect(handleCache.getAllRootHandles).toHaveBeenCalledOnce();
    });

    it('returns a directory handle when permission is granted', async () => {
      const entries = async function* () {
        yield ['file.txt', {} as FileSystemHandle];
      };
      const dirHandle = {
        name: 'root',
        kind: 'directory',
        entries,
        queryPermission: vi.fn().mockResolvedValue('granted'),
      } as unknown as FileSystemDirectoryHandle;
      const handleCache = createHandleCache({
        getAllRootHandles: vi.fn().mockResolvedValue([
          {
            folderId: 'root',
            name: 'root',
            handle: dirHandle,
            storedAt: Date.now(),
            lastAccessedAt: Date.now(),
          },
        ]),
      });
      const adapter = new WebFileSystemAdapter({ handleCache });

      const restored = await adapter.restoreLastFolder();

      expect(restored).toEqual({
        path: 'root',
        name: 'root',
        kind: 'directory',
        platform: 'web',
        _internal: dirHandle,
      });
    });

    it('clears the cached handle when the handle is invalid', async () => {
      const invalidHandle = { name: 'oops' } as unknown as FileSystemDirectoryHandle;
      const removeRootHandle = vi.fn().mockResolvedValue(undefined);
      const handleCache = createHandleCache({
        getAllRootHandles: vi.fn().mockResolvedValue([
          {
            folderId: 'oops',
            name: 'oops',
            handle: invalidHandle,
            storedAt: Date.now(),
            lastAccessedAt: Date.now(),
          },
        ]),
        removeRootHandle,
      });
      const adapter = new WebFileSystemAdapter({ handleCache });

      const restored = await adapter.restoreLastFolder();

      expect(restored).toBeNull();
      expect(removeRootHandle).toHaveBeenCalledOnce();
    });

    it('clears the cached handle when directory access fails', async () => {
      const entries = vi.fn().mockImplementation(() => {
        throw new Error('boom');
      });
      const dirHandle = {
        name: 'root',
        kind: 'directory',
        entries,
        queryPermission: vi.fn().mockResolvedValue('granted'),
      } as unknown as FileSystemDirectoryHandle;
      const removeRootHandle = vi.fn().mockResolvedValue(undefined);
      const handleCache = createHandleCache({
        getAllRootHandles: vi.fn().mockResolvedValue([
          {
            folderId: 'root',
            name: 'root',
            handle: dirHandle,
            storedAt: Date.now(),
            lastAccessedAt: Date.now(),
          },
        ]),
        removeRootHandle,
      });
      const adapter = new WebFileSystemAdapter({ handleCache });

      const restored = await adapter.restoreLastFolder();

      expect(restored).toBeNull();
      expect(removeRootHandle).toHaveBeenCalledOnce();
    });
  });

  describe('readDirectoryStreaming', () => {
    it('throws AccessError for invalid directory handles', async () => {
      await expect(
        adapter.readDirectoryStreaming(
          {
            path: 'root',
            name: 'root',
            kind: 'directory',
            platform: 'web',
            _internal: {} as unknown as FileSystemDirectoryHandle,
          },
          vi.fn()
        )
      ).rejects.toMatchObject({
        name: 'AccessError',
        message: 'Invalid directory handle',
        path: 'root',
      });
    });

    it('streams directory entries in batches and emits a final empty completion batch', async () => {
      const handleCache = createHandleCache();
      const adapter = new WebFileSystemAdapter({ handleCache });
      const firstFileHandle = {
        kind: 'file',
        name: 'a.txt',
        getFile: vi.fn().mockResolvedValue(createFile('a.txt', 'aa', 10)),
      } as unknown as FileSystemFileHandle;
      const secondFileHandle = {
        kind: 'file',
        name: 'b.txt',
        getFile: vi.fn().mockResolvedValue(createFile('b.txt', 'bbbb', 20)),
      } as unknown as FileSystemFileHandle;
      async function* entries() {
        yield ['a.txt', firstFileHandle];
        yield ['b.txt', secondFileHandle];
      }
      const dirHandle = {
        name: 'root',
        kind: 'directory',
        entries,
      } as unknown as FileSystemDirectoryHandle;
      const batches: Array<{ names: string[]; done: boolean; total: number }> = [];

      await adapter.readDirectoryStreaming(
        {
          path: 'root',
          name: 'root',
          kind: 'directory',
          platform: 'web',
          _internal: dirHandle,
        },
        (batch, meta) => {
          batches.push({
            names: batch.map((node) => node.name),
            done: meta.done,
            total: meta.total,
          });
        },
        { batchSize: 2, includeMetadata: true }
      );

      expect(batches).toEqual([
        { names: ['a.txt', 'b.txt'], done: false, total: 2 },
        { names: [], done: true, total: 2 },
      ]);
      expect(handleCache.storeFileHandle).toHaveBeenCalledWith(
        'root',
        'root/a.txt',
        firstFileHandle
      );
      expect(handleCache.storeFileHandle).toHaveBeenCalledWith(
        'root',
        'root/b.txt',
        secondFileHandle
      );
    });

    it('streams an empty final batch for empty directories and stops when aborted', async () => {
      async function* emptyEntries() {}
      const emptyDirHandle = {
        name: 'empty',
        kind: 'directory',
        entries: emptyEntries,
      } as unknown as FileSystemDirectoryHandle;
      const emptyBatchSpy = vi.fn();

      await adapter.readDirectoryStreaming(
        {
          path: 'empty',
          name: 'empty',
          kind: 'directory',
          platform: 'web',
          _internal: emptyDirHandle,
        },
        emptyBatchSpy
      );

      expect(emptyBatchSpy).toHaveBeenCalledWith([], { done: true, total: 0 });

      const abortController = new AbortController();
      const fileHandle = {
        kind: 'file',
        name: 'skipped.txt',
        getFile: vi.fn(),
      } as unknown as FileSystemFileHandle;
      async function* abortedEntries() {
        abortController.abort();
        yield ['skipped.txt', fileHandle];
      }
      const abortedDirHandle = {
        name: 'root',
        kind: 'directory',
        entries: abortedEntries,
      } as unknown as FileSystemDirectoryHandle;
      const abortedBatchSpy = vi.fn();

      await adapter.readDirectoryStreaming(
        {
          path: 'root',
          name: 'root',
          kind: 'directory',
          platform: 'web',
          _internal: abortedDirHandle,
        },
        abortedBatchSpy,
        { signal: abortController.signal }
      );

      expect(abortedBatchSpy).toHaveBeenCalledWith([], { done: true, total: 0 });
      expect(fileHandle.getFile).not.toHaveBeenCalled();
    });
  });

  describe('exists', () => {
    it('always returns false', async () => {
      const result = await adapter.exists('any/path');
      expect(result).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers for multi-root API tests
// ---------------------------------------------------------------------------

function makeDirHandle(name: string): FileSystemDirectoryHandle {
  return {
    name,
    kind: 'directory' as const,
    entries: vi.fn(),
    queryPermission: vi.fn().mockResolvedValue('granted'),
  } as unknown as FileSystemDirectoryHandle;
}

function setupAdapterWithPicker(name: string): {
  adapter: WebFileSystemAdapter;
  dirHandle: FileSystemDirectoryHandle;
  handleCache: HandleCache;
} {
  const dirHandle = makeDirHandle(name);
  (
    window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
  ).showDirectoryPicker = vi.fn().mockResolvedValue(dirHandle);

  const handleCache = createHandleCache();
  const adapter = new WebFileSystemAdapter({ handleCache });
  return { adapter, dirHandle, handleCache };
}

interface StoredRootSpec {
  folderId: string;
  name: string;
  permission: PermissionState;
}

function setupAdapterWithStoredRoots(specs: StoredRootSpec[]): {
  adapter: WebFileSystemAdapter;
  handleCache: HandleCache;
} {
  const storedRoots: StoredRootHandle[] = specs.map((s) => ({
    folderId: s.folderId,
    name: s.name,
    handle: {
      name: s.name,
      kind: 'directory' as const,
      entries: vi.fn(),
      queryPermission: vi.fn().mockResolvedValue(s.permission),
    } as unknown as FileSystemDirectoryHandle,
    storedAt: Date.now(),
    lastAccessedAt: Date.now(),
  }));

  const handleCache = createHandleCache({
    getAllRootHandles: vi.fn().mockResolvedValue(storedRoots),
  });
  const adapter = new WebFileSystemAdapter({ handleCache });
  return { adapter, handleCache };
}

describe('multi-root API', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('addRoot stores the handle under a generated RootId and returns a descriptor', async () => {
    const { adapter, handleCache, dirHandle } = setupAdapterWithPicker('my-project');
    const descriptor = await adapter.addRoot();

    expect(descriptor.kind).toBe('fsa');
    expect(descriptor.displayName).toBe('my-project');
    expect(descriptor.permissionState).toBe('granted');
    expect(descriptor.persisted).toBe(true);
    expect(descriptor.rootId).toMatch(/^[0-9a-f-]{36}$/);
    expect(descriptor.handle.platform).toBe('web');
    expect(handleCache.storeRootHandle).toHaveBeenCalledWith(descriptor.rootId, dirHandle);
  });

  it('addRoot returns persisted: false without throwing when handle storage fails', async () => {
    const dirHandle = makeDirHandle('quota-folder');
    (
      window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
    ).showDirectoryPicker = vi.fn().mockResolvedValue(dirHandle);
    const handleCache = createHandleCache({
      storeRootHandle: vi.fn().mockRejectedValue(new Error('QuotaExceededError')),
    });
    const adapter = new WebFileSystemAdapter({ handleCache });

    const descriptor = await adapter.addRoot();

    expect(descriptor.persisted).toBe(false);
    expect(descriptor.displayName).toBe('quota-folder');
    expect(descriptor.permissionState).toBe('granted');
    expect(descriptor.rootId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('requestDirectoryAccess delegates to addRoot (same storage path, legacy return shape)', async () => {
    const { adapter, handleCache } = setupAdapterWithPicker('my-project');
    const handle = await adapter.requestDirectoryAccess();

    expect(handle.name).toBe('my-project');
    const [storedRootId] = (handleCache.storeRootHandle as Mock).mock.calls[0] ?? [];
    expect(storedRootId).toMatch(/^[0-9a-f-]{36}$/); // NOT dirHandle.name any more
  });

  it('restoreRoots returns one descriptor per stored root with queried permission, never prompting', async () => {
    // two stored roots: one granted, one prompt
    const { adapter } = setupAdapterWithStoredRoots([
      { folderId: 'id-granted', name: 'a', permission: 'granted' },
      { folderId: 'id-prompt', name: 'b', permission: 'prompt' },
    ]);
    const roots = await adapter.restoreRoots();

    expect(roots).toHaveLength(2);
    expect(roots.find((r) => r.rootId === 'id-granted')?.permissionState).toBe('granted');
    expect(roots.find((r) => r.rootId === 'id-prompt')?.permissionState).toBe('prompt');
    // Restored roots came FROM the persistence layer, so persisted is true.
    expect(roots.every((r) => r.persisted)).toBe(true);
    // requestPermission must never have been called on either handle
  });
});
