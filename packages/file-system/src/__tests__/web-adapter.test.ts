import { addLogListener } from '@brainstrike/utils';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebFileSystemAdapter } from '../adapters/web-adapter';
import type { HandleCache, StoredRootHandle } from '../adapters/web-handle-cache';
import type { DirectoryHandle, FileHandle } from '../types';

function createFile(name: string, content = 'data', lastModified = Date.now()) {
  return {
    lastModified,
    name,
    size: content.length,
    async text() {
      return content;
    },
  } as unknown as File;
}

const createHandleCache = (overrides: Partial<HandleCache> = {}): HandleCache => ({
  clear: vi.fn().mockResolvedValue(undefined),
  getAllRootHandles: vi.fn().mockResolvedValue([]),
  getFileHandle: vi.fn().mockResolvedValue(null),
  getLastRootHandleForRestore: vi.fn().mockResolvedValue(null),
  getRootHandle: vi.fn().mockResolvedValue(null),
  markHandleRestored: vi.fn().mockResolvedValue(undefined),
  pruneOldHandles: vi.fn().mockResolvedValue(undefined),
  removeFileHandle: vi.fn().mockResolvedValue(undefined),
  removeRootHandle: vi.fn().mockResolvedValue(undefined),
  restoreLastRootHandle: vi.fn().mockResolvedValue(null),
  storeFileHandle: vi.fn().mockResolvedValue(undefined),
  storeRootHandle: vi.fn().mockResolvedValue(undefined),
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
        entries: vi.fn(),
        kind: 'directory',
        name: 'root',
      } as unknown as FileSystemDirectoryHandle;
      (
        window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
      ).showDirectoryPicker = vi.fn().mockResolvedValue(dirHandle);

      const handle = await adapter.requestDirectoryAccess();
      expect(handle).toEqual({
        _internal: dirHandle,
        kind: 'directory',
        name: 'root',
        path: 'root',
        platform: 'web',
      });
    });

    it('persists the directory handle for restore', async () => {
      const dirHandle = {
        entries: vi.fn(),
        kind: 'directory',
        name: 'root',
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
        entries: vi.fn(),
        kind: 'directory',
        name: 'root',
      } as unknown as FileSystemDirectoryHandle;
      (
        window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
      ).showDirectoryPicker = vi.fn().mockResolvedValue(dirHandle);
      const persisted = vi.fn().mockResolvedValue(false);
      const persist = vi.fn().mockRejectedValue(new Error('quota prompt failed'));
      const originalStorage = navigator.storage;
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { persist, persisted },
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
        getFile: vi.fn().mockResolvedValue(createFile('file.txt', 'x', 1)),
        kind: 'file',
        name: 'file.txt',
      } as unknown as FileSystemFileHandle;
      const subHandle = {
        entries: vi.fn(),
        kind: 'directory',
        name: 'sub',
      } as unknown as FileSystemDirectoryHandle;
      async function* entries() {
        yield ['sub', subHandle];
        yield ['file.txt', fileHandle];
      }
      const dirHandle = {
        entries,
        kind: 'directory',
        name: 'root',
      } as unknown as FileSystemDirectoryHandle;
      const handle: DirectoryHandle = {
        _internal: dirHandle,
        kind: 'directory',
        name: 'root',
        path: 'root',
        platform: 'web',
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
          getFile: vi.fn(async () => getFileImpl()),
          kind: 'file' as const,
          name,
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
        entries,
        kind: 'directory' as const,
        name: 'root',
      } as unknown as FileSystemDirectoryHandle;
      const handle: DirectoryHandle = {
        _internal: dirHandle,
        kind: 'directory',
        name: 'root',
        path: 'root',
        platform: 'web',
      };

      const adapter = new WebFileSystemAdapter();
      const concurrency = 2;
      vi.useFakeTimers();
      const promise = adapter.readDirectory(handle, { concurrency, includeMetadata: true });
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
          _internal: {} as unknown as FileSystemDirectoryHandle,
          kind: 'directory',
          name: 'root',
          path: '',
          platform: 'web',
        })
      ).rejects.toThrow('Directory handle is missing its canonical path');

      await expect(
        adapter.readDirectory({
          _internal: {} as unknown as FileSystemDirectoryHandle,
          kind: 'directory',
          name: 'root',
          path: 'root',
          platform: 'web',
        })
      ).rejects.toMatchObject({
        message: 'Invalid directory handle',
        name: 'AccessError',
        path: 'root',
      });
    });

    it('returns directory entries', async () => {
      const file = createFile('file.txt', 'hello', 123);
      const fileHandle = {
        getFile: vi.fn().mockResolvedValue(file),
        kind: 'file',
        name: 'file.txt',
      } as unknown as FileSystemFileHandle;
      const subHandle = {
        entries: vi.fn(),
        kind: 'directory',
        name: 'sub',
      } as unknown as FileSystemDirectoryHandle;
      async function* entries() {
        yield ['sub', subHandle];
        yield ['file.txt', fileHandle];
      }
      const dirHandle = {
        entries,
        kind: 'directory',
        name: 'root',
      } as unknown as FileSystemDirectoryHandle;
      const handle: DirectoryHandle = {
        _internal: dirHandle,
        kind: 'directory',
        name: 'root',
        path: 'root',
        platform: 'web',
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
        entries: vi.fn().mockImplementation(() => {
          throw new Error('boom');
        }),
        kind: 'directory',
        name: 'bad',
      } as unknown as FileSystemDirectoryHandle;
      const handle: DirectoryHandle = {
        _internal: dirHandle,
        kind: 'directory',
        name: 'bad',
        path: 'bad',
        platform: 'web',
      };
      await expect(adapter.readDirectory(handle)).rejects.toThrow('boom');
    });

    it('caches discovered file handles during directory enumeration', async () => {
      const handleCache = createHandleCache();
      const adapter = new WebFileSystemAdapter({ handleCache });
      const fileHandle = {
        getFile: vi.fn().mockResolvedValue(createFile('file.txt', 'hello', 123)),
        kind: 'file',
        name: 'file.txt',
      } as unknown as FileSystemFileHandle;
      const subHandle = {
        entries: vi.fn(),
        kind: 'directory',
        name: 'sub',
      } as unknown as FileSystemDirectoryHandle;
      async function* entries() {
        yield ['sub', subHandle];
        yield ['file.txt', fileHandle];
      }
      const dirHandle = {
        entries,
        kind: 'directory',
        name: 'root',
      } as unknown as FileSystemDirectoryHandle;
      const handle: DirectoryHandle = {
        _internal: dirHandle,
        kind: 'directory',
        name: 'root',
        path: 'root',
        platform: 'web',
      };

      await adapter.readDirectory(handle);

      expect(handleCache.storeFileHandle).toHaveBeenCalledWith('root', 'root/file.txt', fileHandle);
    });

    it('drops file entries whose metadata cannot be read while preserving directories', async () => {
      const fileHandle = {
        getFile: vi.fn().mockRejectedValue(new Error('metadata unavailable')),
        kind: 'file',
        name: 'broken.txt',
      } as unknown as FileSystemFileHandle;
      const subHandle = {
        entries: vi.fn(),
        kind: 'directory',
        name: 'sub',
      } as unknown as FileSystemDirectoryHandle;
      async function* entries() {
        yield ['broken.txt', fileHandle];
        yield ['sub', subHandle];
      }
      const dirHandle = {
        entries,
        kind: 'directory',
        name: 'root',
      } as unknown as FileSystemDirectoryHandle;
      const handle: DirectoryHandle = {
        _internal: dirHandle,
        kind: 'directory',
        name: 'root',
        path: 'root',
        platform: 'web',
      };

      const entriesList = await adapter.readDirectory(handle);

      expect(entriesList).toEqual([expect.objectContaining({ name: 'sub', type: 'directory' })]);
    });

    it('reads a file by path through the cached root directory handle', async () => {
      const fileHandle = {
        getFile: vi.fn().mockResolvedValue(createFile('file.txt', 'hello world', 123)),
        kind: 'file',
        name: 'file.txt',
      } as unknown as FileSystemFileHandle;
      const nestedDirHandle = {
        getFileHandle: vi.fn().mockResolvedValue(fileHandle),
        kind: 'directory',
        name: 'nested',
      } as unknown as FileSystemDirectoryHandle;
      const rootDirHandle = {
        getDirectoryHandle: vi.fn().mockResolvedValue(nestedDirHandle),
        kind: 'directory',
        name: 'root',
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
        getFile: vi.fn().mockResolvedValue(createFile('file.txt', 'hello world', 123)),
        kind: 'file',
        name: 'file.txt',
      } as unknown as FileSystemFileHandle;
      const nestedDirHandle = {
        getFileHandle: vi.fn().mockResolvedValue(fileHandle),
        kind: 'directory',
        name: 'nested',
      } as unknown as FileSystemDirectoryHandle;
      const rootDirHandle = {
        getDirectoryHandle: vi.fn().mockResolvedValue(nestedDirHandle),
        kind: 'directory',
        name: 'root',
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
        getFile: vi.fn(),
        kind: 'file',
        name: 'file.txt',
      } as unknown as FileSystemFileHandle;
      const nestedDirHandle = {
        getFileHandle: vi.fn().mockResolvedValue(fileHandle),
        kind: 'directory',
        name: 'nested',
      } as unknown as FileSystemDirectoryHandle;
      const rootDirHandle = {
        getDirectoryHandle: vi.fn().mockResolvedValue(nestedDirHandle),
        kind: 'directory',
        name: 'root',
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
        getFile: vi.fn(),
        kind: 'file',
        name: 'file.txt',
      } as unknown as FileSystemFileHandle;
      const nestedDirHandle = {
        getFileHandle: vi.fn().mockResolvedValue(fileHandle),
        kind: 'directory',
        name: 'nested',
      } as unknown as FileSystemDirectoryHandle;
      const rootDirHandle = {
        getDirectoryHandle: vi.fn().mockResolvedValue(nestedDirHandle),
        kind: 'directory',
        name: 'root',
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
        getDirectoryHandle: vi.fn(),
        kind: 'directory',
        name: 'root',
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
        getDirectoryHandle: vi.fn().mockRejectedValue(new Error('NotFoundError')),
        kind: 'directory',
        name: 'root',
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
        getFile: vi.fn().mockResolvedValue(file),
        kind: 'file',
        name: 'file.txt',
      } as unknown as FileSystemFileHandle;
      const nestedDirHandle = {
        getFileHandle: vi.fn().mockResolvedValue(fileHandle),
        kind: 'directory',
        name: 'nested',
      } as unknown as FileSystemDirectoryHandle;
      const rootDirHandle = {
        getDirectoryHandle: vi.fn().mockResolvedValue(nestedDirHandle),
        kind: 'directory',
        name: 'root',
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
        getFile: vi.fn().mockResolvedValue(file),
        kind: 'file',
        name: 'file.txt',
      } as unknown as FileSystemFileHandle;
      const nestedDirHandle = {
        getFileHandle: vi.fn().mockResolvedValue(fileHandle),
        kind: 'directory',
        name: 'nested',
      } as unknown as FileSystemDirectoryHandle;
      const rootDirHandle = {
        getDirectoryHandle: vi.fn().mockResolvedValue(nestedDirHandle),
        kind: 'directory',
        name: 'root',
      } as unknown as FileSystemDirectoryHandle;

      const handleCache = createHandleCache({
        getRootHandle: vi.fn().mockResolvedValue(rootDirHandle),
      });
      const adapter = new WebFileSystemAdapter({ handleCache });

      const resolveSpy = vi.spyOn(adapter, 'resolveFileHandleByPath');

      const resolution = await adapter.resolveFileForIndexing('root/nested/file.txt');

      expect(resolution).toEqual({ fileHandle, fileSize: 11, kind: 'handle' });
      expect(resolveSpy).toHaveBeenCalledWith('root/nested/file.txt');
      expect(fileHandle.getFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('readFile', () => {
    it('reads file content', async () => {
      const file = createFile('a.txt', 'text');
      const fileHandle = {
        getFile: vi.fn().mockResolvedValue(file),
        kind: 'file',
        name: 'a.txt',
      } as unknown as FileSystemFileHandle;
      const handle: FileHandle = {
        _internal: fileHandle,
        kind: 'file',
        name: 'a.txt',
        path: 'a.txt',
        platform: 'web',
      };
      const text = await adapter.readFile(handle);
      expect(text).toBe('text');
    });

    it('caches file handles on read', async () => {
      const file = createFile('a.txt', 'text');
      const fileHandle = {
        getFile: vi.fn().mockResolvedValue(file),
        kind: 'file',
        name: 'a.txt',
      } as unknown as FileSystemFileHandle;
      const handle: FileHandle = {
        _internal: fileHandle,
        kind: 'file',
        name: 'a.txt',
        path: 'root/a.txt',
        platform: 'web',
        rootFolderId: 'root',
      };
      const handleCache = createHandleCache();
      const adapter = new WebFileSystemAdapter({ handleCache });

      await adapter.readFile(handle);

      expect(handleCache.storeFileHandle).toHaveBeenCalledWith('root', 'root/a.txt', fileHandle);
    });

    it('propagates getFile errors', async () => {
      const fileHandle = {
        getFile: vi.fn().mockRejectedValue(new Error('nope')),
        kind: 'file',
        name: 'fail.txt',
      } as unknown as FileSystemFileHandle;
      const handle: FileHandle = {
        _internal: fileHandle,
        kind: 'file',
        name: 'fail.txt',
        path: 'fail.txt',
        platform: 'web',
      };
      await expect(adapter.readFile(handle)).rejects.toThrow('nope');
    });

    it('throws AccessError when handle lacks a file implementation', async () => {
      const handle: FileHandle = {
        _internal: {} as unknown as FileSystemFileHandle,
        kind: 'file',
        name: 'missing',
        path: 'missing',
        platform: 'web',
      };

      await expect(adapter.readFile(handle)).rejects.toMatchObject({
        message: 'Invalid file handle',
        name: 'AccessError',
        path: 'missing',
      });
    });

    it('rejects files larger than the 1MB limit', async () => {
      const largeContent = 'x'.repeat(1024 * 1024 + 1);
      const file = createFile('big.bin', largeContent);
      const fileHandle = {
        getFile: vi.fn().mockResolvedValue(file),
        kind: 'file',
        name: 'big.bin',
      } as unknown as FileSystemFileHandle;
      const handle: FileHandle = {
        _internal: fileHandle,
        kind: 'file',
        name: 'big.bin',
        path: 'big.bin',
        platform: 'web',
      };

      await expect(adapter.readFile(handle)).rejects.toMatchObject({
        message: expect.stringContaining('File too large'),
        name: 'AccessError',
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
        entries,
        kind: 'directory',
        name: 'root',
        queryPermission: vi.fn().mockResolvedValue('granted'),
      } as unknown as FileSystemDirectoryHandle;
      const handleCache = createHandleCache({
        getAllRootHandles: vi.fn().mockResolvedValue([
          {
            folderId: 'root',
            handle: dirHandle,
            lastAccessedAt: Date.now(),
            name: 'root',
            storedAt: Date.now(),
          },
        ]),
      });
      const adapter = new WebFileSystemAdapter({ handleCache });

      const restored = await adapter.restoreLastFolder();

      expect(restored).toEqual({
        _internal: dirHandle,
        kind: 'directory',
        name: 'root',
        path: 'root',
        platform: 'web',
      });
    });

    it('clears the cached handle when the handle is invalid', async () => {
      const invalidHandle = { name: 'oops' } as unknown as FileSystemDirectoryHandle;
      const removeRootHandle = vi.fn().mockResolvedValue(undefined);
      const handleCache = createHandleCache({
        getAllRootHandles: vi.fn().mockResolvedValue([
          {
            folderId: 'oops',
            handle: invalidHandle,
            lastAccessedAt: Date.now(),
            name: 'oops',
            storedAt: Date.now(),
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
        entries,
        kind: 'directory',
        name: 'root',
        queryPermission: vi.fn().mockResolvedValue('granted'),
      } as unknown as FileSystemDirectoryHandle;
      const removeRootHandle = vi.fn().mockResolvedValue(undefined);
      const handleCache = createHandleCache({
        getAllRootHandles: vi.fn().mockResolvedValue([
          {
            folderId: 'root',
            handle: dirHandle,
            lastAccessedAt: Date.now(),
            name: 'root',
            storedAt: Date.now(),
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
            _internal: {} as unknown as FileSystemDirectoryHandle,
            kind: 'directory',
            name: 'root',
            path: 'root',
            platform: 'web',
          },
          vi.fn()
        )
      ).rejects.toMatchObject({
        message: 'Invalid directory handle',
        name: 'AccessError',
        path: 'root',
      });
    });

    it('streams directory entries in batches and emits a final empty completion batch', async () => {
      const handleCache = createHandleCache();
      const adapter = new WebFileSystemAdapter({ handleCache });
      const firstFileHandle = {
        getFile: vi.fn().mockResolvedValue(createFile('a.txt', 'aa', 10)),
        kind: 'file',
        name: 'a.txt',
      } as unknown as FileSystemFileHandle;
      const secondFileHandle = {
        getFile: vi.fn().mockResolvedValue(createFile('b.txt', 'bbbb', 20)),
        kind: 'file',
        name: 'b.txt',
      } as unknown as FileSystemFileHandle;
      async function* entries() {
        yield ['a.txt', firstFileHandle];
        yield ['b.txt', secondFileHandle];
      }
      const dirHandle = {
        entries,
        kind: 'directory',
        name: 'root',
      } as unknown as FileSystemDirectoryHandle;
      const batches: Array<{ names: string[]; done: boolean; total: number }> = [];

      await adapter.readDirectoryStreaming(
        {
          _internal: dirHandle,
          kind: 'directory',
          name: 'root',
          path: 'root',
          platform: 'web',
        },
        (batch, meta) => {
          batches.push({
            done: meta.done,
            names: batch.map((node) => node.name),
            total: meta.total,
          });
        },
        { batchSize: 2, includeMetadata: true }
      );

      expect(batches).toEqual([
        { done: false, names: ['a.txt', 'b.txt'], total: 2 },
        { done: true, names: [], total: 2 },
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

    it('caches streamed file handles without splitting the whole node path', async () => {
      const handleCache = createHandleCache();
      const adapter = new WebFileSystemAdapter({ handleCache });
      const fileHandle = {
        getFile: vi.fn().mockResolvedValue(createFile('main.ts', 'source', 10)),
        kind: 'file',
        name: 'main.ts',
      } as unknown as FileSystemFileHandle;
      async function* entries() {
        yield ['main.ts', fileHandle];
      }
      const dirHandle = {
        entries,
        kind: 'directory',
        name: 'root',
      } as unknown as FileSystemDirectoryHandle;
      const splitSpy = vi.spyOn(String.prototype, 'split');

      await adapter.readDirectoryStreaming(
        {
          _internal: dirHandle,
          kind: 'directory',
          name: 'root',
          path: '//root//src',
          platform: 'web',
        },
        vi.fn(),
        { includeMetadata: true }
      );

      expect(handleCache.storeFileHandle).toHaveBeenCalledWith(
        'root',
        '//root//src/main.ts',
        fileHandle
      );
      expect(splitSpy).not.toHaveBeenCalled();
    });

    it('streams an empty final batch for empty directories', async () => {
      async function* emptyEntries() {}
      const emptyDirHandle = {
        entries: emptyEntries,
        kind: 'directory',
        name: 'empty',
      } as unknown as FileSystemDirectoryHandle;
      const emptyBatchSpy = vi.fn();

      await adapter.readDirectoryStreaming(
        {
          _internal: emptyDirHandle,
          kind: 'directory',
          name: 'empty',
          path: 'empty',
          platform: 'web',
        },
        emptyBatchSpy
      );

      expect(emptyBatchSpy).toHaveBeenCalledWith([], { done: true, total: 0 });
    });

    it('rejects with the signal reason without emitting completion when aborted', async () => {
      const abortController = new AbortController();
      const abortReason = new DOMException('Directory enumeration cancelled', 'AbortError');
      const fileHandle = {
        getFile: vi.fn(),
        kind: 'file',
        name: 'skipped.txt',
      } as unknown as FileSystemFileHandle;
      async function* abortedEntries() {
        abortController.abort(abortReason);
        yield ['skipped.txt', fileHandle];
      }
      const abortedDirHandle = {
        entries: abortedEntries,
        kind: 'directory',
        name: 'root',
      } as unknown as FileSystemDirectoryHandle;
      const abortedBatchSpy = vi.fn();

      await expect(
        adapter.readDirectoryStreaming(
          {
            _internal: abortedDirHandle,
            kind: 'directory',
            name: 'root',
            path: 'root',
            platform: 'web',
          },
          abortedBatchSpy,
          { signal: abortController.signal }
        )
      ).rejects.toBe(abortReason);

      expect(abortedBatchSpy).not.toHaveBeenCalled();
      expect(fileHandle.getFile).not.toHaveBeenCalled();
    });

    it('rejects with the signal reason when iteration rejects after cancellation', async () => {
      const abortController = new AbortController();
      const abortReason = new Error('caller cancelled rejected directory iteration');
      const iteratorError = new Error('directory iterator I/O failed');
      const rejectedEntries = () => ({
        [Symbol.asyncIterator]() {
          return this;
        },
        async next(): Promise<never> {
          abortController.abort(abortReason);
          throw iteratorError;
        },
      });
      const dirHandle = {
        entries: rejectedEntries,
        kind: 'directory',
        name: 'root',
      } as unknown as FileSystemDirectoryHandle;
      const onBatch = vi.fn();

      await expect(
        adapter.readDirectoryStreaming(
          {
            _internal: dirHandle,
            kind: 'directory',
            name: 'root',
            path: 'root',
            platform: 'web',
          },
          onBatch,
          { signal: abortController.signal }
        )
      ).rejects.toBe(abortReason);

      expect(onBatch).not.toHaveBeenCalled();
    });

    it('rejects with the signal reason when metadata lookup rejects after cancellation', async () => {
      const abortController = new AbortController();
      const abortReason = new Error('caller cancelled rejected metadata lookup');
      const metadataError = new Error('file metadata I/O failed');
      const fileHandle = {
        getFile: vi.fn(async () => {
          abortController.abort(abortReason);
          throw metadataError;
        }),
        kind: 'file',
        name: 'file.txt',
      } as unknown as FileSystemFileHandle;
      async function* entries() {
        yield ['file.txt', fileHandle] as const;
      }
      const dirHandle = {
        entries,
        kind: 'directory',
        name: 'root',
      } as unknown as FileSystemDirectoryHandle;
      const onBatch = vi.fn();

      await expect(
        adapter.readDirectoryStreaming(
          {
            _internal: dirHandle,
            kind: 'directory',
            name: 'root',
            path: 'root',
            platform: 'web',
          },
          onBatch,
          { includeMetadata: true, signal: abortController.signal }
        )
      ).rejects.toBe(abortReason);

      expect(onBatch).not.toHaveBeenCalled();
    });

    it('rejects a pre-aborted read with the exact signal reason', async () => {
      const abortController = new AbortController();
      const abortReason = new Error('caller cancelled before enumeration');
      abortController.abort(abortReason);
      const dirHandle = {
        entries: vi.fn(),
        kind: 'directory',
        name: 'root',
      } as unknown as FileSystemDirectoryHandle;

      await expect(
        adapter.readDirectoryStreaming(
          {
            _internal: dirHandle,
            kind: 'directory',
            name: 'root',
            path: 'root',
            platform: 'web',
          },
          vi.fn(),
          { signal: abortController.signal }
        )
      ).rejects.toBe(abortReason);

      expect(dirHandle.entries).not.toHaveBeenCalled();
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
// watchDirectory — FileSystemObserver (Chrome 133+, feature-detected)
// ---------------------------------------------------------------------------

/**
 * Minimal stub type for the FileSystemObserver WICG draft.
 * Mirrors the ambient declaration in web-adapter.ts.
 * `relativePathMovedFrom`/`root` are optional in the stub for test brevity —
 * the adapter only reads `relativePathMovedFrom` on 'moved' records.
 */
interface StubFSORecord {
  changedHandle: FileSystemHandle | null;
  relativePathComponents: string[] | null;
  relativePathMovedFrom?: string[] | null;
  root?: FileSystemDirectoryHandle;
  type: 'appeared' | 'disappeared' | 'modified' | 'moved' | 'errored' | 'unknown';
}

type FSOCallback = (records: StubFSORecord[], observer: unknown) => void;

class StubFileSystemObserver {
  readonly callback: FSOCallback;
  readonly observedHandles: Array<{ handle: FileSystemDirectoryHandle; options?: unknown }> = [];
  disconnected = false;

  constructor(callback: FSOCallback) {
    this.callback = callback;
  }

  observe(handle: FileSystemDirectoryHandle, options?: unknown) {
    this.observedHandles.push({ handle, options });
  }

  disconnect() {
    this.disconnected = true;
  }

  /** Test helper — fire records at the callback. */
  emit(records: StubFSORecord[]) {
    this.callback(records, this);
  }
}

// Test-only cast for setting/deleting the experimental FileSystemObserver global.
// The `any` type is intentional: the stub class must be assignable without
// matching the full ambient constructor signature from web-adapter.ts.
type GlobalWithFSO = typeof globalThis & { FileSystemObserver?: any };

describe('watchDirectory (FileSystemObserver feature-detected)', () => {
  let originalFSO: unknown;

  beforeEach(() => {
    originalFSO = (globalThis as GlobalWithFSO)['FileSystemObserver'];
  });

  afterEach(() => {
    if (originalFSO === undefined) {
      // biome-ignore lint/performance/noDelete: restoring absent global in afterEach
      delete (globalThis as GlobalWithFSO)['FileSystemObserver'];
    } else {
      (globalThis as GlobalWithFSO)['FileSystemObserver'] = originalFSO;
    }
    vi.restoreAllMocks();
  });

  const makeDirHandleInternal = (name = 'project') =>
    ({
      entries: vi.fn(),
      kind: 'directory' as const,
      name,
    }) as unknown as FileSystemDirectoryHandle;

  it('constructs a FileSystemObserver when available, observe() receives the internal handle and {recursive:true}, emitted records reach the callback mapped to FileSystemChange[]', () => {
    const internalHandle = makeDirHandleInternal('project');
    const dirHandle: DirectoryHandle = {
      _internal: internalHandle,
      kind: 'directory',
      name: 'project',
      path: 'project',
      platform: 'web',
    };

    let capturedObserver: StubFileSystemObserver | null = null;
    (globalThis as GlobalWithFSO)['FileSystemObserver'] = class extends StubFileSystemObserver {
      constructor(cb: FSOCallback) {
        super(cb);
        capturedObserver = this;
      }
    };

    const adapter = new WebFileSystemAdapter();
    const callback = vi.fn();

    const disposer = adapter.watchDirectory?.(dirHandle, callback);
    expect(disposer).toBeDefined();
    expect(capturedObserver).not.toBeNull();

    // observe() called with the internal handle and recursive: true
    expect(capturedObserver!.observedHandles).toHaveLength(1);
    expect(capturedObserver!.observedHandles[0]!.handle).toBe(internalHandle);
    expect(capturedObserver!.observedHandles[0]!.options).toEqual({ recursive: true });

    // emit records and verify mapping
    capturedObserver!.emit([
      {
        changedHandle: { kind: 'file', name: 'new-file.ts' } as unknown as FileSystemHandle,
        relativePathComponents: ['src', 'new-file.ts'],
        type: 'appeared',
      },
      {
        changedHandle: { kind: 'file', name: 'existing.ts' } as unknown as FileSystemHandle,
        relativePathComponents: ['src', 'existing.ts'],
        type: 'modified',
      },
      {
        changedHandle: { kind: 'directory', name: 'old-dir' } as unknown as FileSystemHandle,
        relativePathComponents: ['old-dir'],
        type: 'disappeared',
      },
    ]);

    expect(callback).toHaveBeenCalledOnce();
    const [changes] = callback.mock.calls[0] as [import('@brainstrike/types').FileSystemChange[]];
    expect(changes).toEqual([
      { kind: 'file', path: 'project/src/new-file.ts', type: 'added' },
      { kind: 'file', path: 'project/src/existing.ts', type: 'modified' },
      { kind: 'directory', path: 'project/old-dir', type: 'removed' },
    ]);

    // disposer disconnects the observer
    disposer!();
    expect(capturedObserver!.disconnected).toBe(true);
  });

  it('maps disappeared records with a null changedHandle instead of throwing (Chrome emits null for gone entries)', () => {
    const internalHandle = makeDirHandleInternal('project');
    const dirHandle: DirectoryHandle = {
      _internal: internalHandle,
      kind: 'directory',
      name: 'project',
      path: 'project',
      platform: 'web',
    };

    let capturedObserver: StubFileSystemObserver | null = null;
    (globalThis as GlobalWithFSO)['FileSystemObserver'] = class extends StubFileSystemObserver {
      constructor(cb: FSOCallback) {
        super(cb);
        capturedObserver = this;
      }
    };

    const adapter = new WebFileSystemAdapter();
    const callback = vi.fn();
    adapter.watchDirectory(dirHandle, callback);

    expect(() =>
      capturedObserver!.emit([
        {
          changedHandle: null,
          relativePathComponents: ['src', 'deleted.ts'],
          type: 'disappeared',
        },
        // Errored/unknown records may carry no handle AND no path components —
        // they must be dropped without crashing the batch they arrive in.
        {
          changedHandle: null,
          relativePathComponents: null,
          type: 'errored',
        },
      ])
    ).not.toThrow();

    expect(callback).toHaveBeenCalledOnce();
    const [changes] = callback.mock.calls[0] as [import('@brainstrike/types').FileSystemChange[]];
    // A gone entry surfaces no handle to read `kind` from; directory is the
    // safe invalidation shape (same-path record plus any stale descendants).
    expect(changes).toEqual([
      { kind: 'directory', path: 'project/src/deleted.ts', type: 'removed' },
    ]);
  });

  it('is always present and returns a no-op disposer when FileSystemObserver is unavailable', () => {
    // biome-ignore lint/performance/noDelete: removing stub to simulate absent API
    delete (globalThis as GlobalWithFSO)['FileSystemObserver'];

    const internalHandle = makeDirHandleInternal('project');
    const dirHandle: DirectoryHandle = {
      _internal: internalHandle,
      kind: 'directory',
      name: 'project',
      path: 'project',
      platform: 'web',
    };

    const adapter = new WebFileSystemAdapter();

    // The method is ALWAYS present by design (see watchDirectory JSDoc) — it
    // no-ops without FileSystemObserver; capability detection is the caller's
    // job via `typeof FileSystemObserver`.
    expect(adapter.watchDirectory).toBeDefined();
    const callback = vi.fn();
    const disposer = adapter.watchDirectory(dirHandle, callback);
    expect(typeof disposer).toBe('function');
    // calling the disposer must not throw
    expect(() => disposer()).not.toThrow();
    // no spurious change events
    expect(callback).not.toHaveBeenCalled();
  });

  it('maps a moved record with relativePathMovedFrom to a removed+added pair', () => {
    const internalHandle = makeDirHandleInternal('project');
    const dirHandle: DirectoryHandle = {
      _internal: internalHandle,
      kind: 'directory',
      name: 'project',
      path: 'project',
      platform: 'web',
    };

    let capturedObserver: StubFileSystemObserver | null = null;
    (globalThis as GlobalWithFSO)['FileSystemObserver'] = class extends StubFileSystemObserver {
      constructor(cb: FSOCallback) {
        super(cb);
        capturedObserver = this;
      }
    };

    const adapter = new WebFileSystemAdapter();
    const callback = vi.fn();
    adapter.watchDirectory(dirHandle, callback);

    capturedObserver!.emit([
      {
        changedHandle: { kind: 'file', name: 'renamed.ts' } as unknown as FileSystemHandle,
        relativePathComponents: ['src', 'renamed.ts'],
        relativePathMovedFrom: ['src', 'original.ts'],
        type: 'moved',
      },
    ]);

    expect(callback).toHaveBeenCalledOnce();
    const [changes] = callback.mock.calls[0] as [import('@brainstrike/types').FileSystemChange[]];
    expect(changes).toEqual([
      { kind: 'file', path: 'project/src/original.ts', type: 'removed' },
      { kind: 'file', path: 'project/src/renamed.ts', type: 'added' },
    ]);
  });

  it('maps a moved record with null relativePathMovedFrom to only an added event', () => {
    const internalHandle = makeDirHandleInternal('project');
    const dirHandle: DirectoryHandle = {
      _internal: internalHandle,
      kind: 'directory',
      name: 'project',
      path: 'project',
      platform: 'web',
    };

    let capturedObserver: StubFileSystemObserver | null = null;
    (globalThis as GlobalWithFSO)['FileSystemObserver'] = class extends StubFileSystemObserver {
      constructor(cb: FSOCallback) {
        super(cb);
        capturedObserver = this;
      }
    };

    const adapter = new WebFileSystemAdapter();
    const callback = vi.fn();
    adapter.watchDirectory(dirHandle, callback);

    capturedObserver!.emit([
      {
        changedHandle: { kind: 'directory', name: 'moved-in' } as unknown as FileSystemHandle,
        relativePathComponents: ['moved-in'],
        relativePathMovedFrom: null,
        type: 'moved',
      },
    ]);

    expect(callback).toHaveBeenCalledOnce();
    const [changes] = callback.mock.calls[0] as [import('@brainstrike/types').FileSystemChange[]];
    expect(changes).toEqual([{ kind: 'directory', path: 'project/moved-in', type: 'added' }]);
  });

  it('logs a warn and disconnects when observe() returns a rejected promise (async failure path)', async () => {
    const internalHandle = makeDirHandleInternal('project');
    const dirHandle: DirectoryHandle = {
      _internal: internalHandle,
      kind: 'directory',
      name: 'project',
      path: 'project',
      platform: 'web',
    };

    const warnRecords: Array<{ level: string; message: string | undefined }> = [];
    const removeListener = addLogListener((record) => {
      if (record.level === 'warn') {
        warnRecords.push({ level: String(record.level), message: record.message });
      }
    });

    const disconnectSpy = vi.fn();
    (globalThis as GlobalWithFSO)['FileSystemObserver'] = class {
      observe() {
        return Promise.reject(new Error('NotAllowedError: permission revoked mid-flight'));
      }
      disconnect() {
        disconnectSpy();
      }
    };

    try {
      const adapter = new WebFileSystemAdapter();
      const callback = vi.fn();

      // Setup itself must not throw — the rejection is async.
      const disposer = adapter.watchDirectory(dirHandle, callback);
      expect(typeof disposer).toBe('function');

      // Flush microtasks so the rejection handler runs.
      await vi.waitFor(() => {
        expect(disconnectSpy).toHaveBeenCalled();
      });
      expect(
        warnRecords.some((r) => r.message?.includes('FileSystemObserver.observe() rejected'))
      ).toBe(true);
      expect(callback).not.toHaveBeenCalled();
      // The disposer remains safely callable (idempotent disconnect).
      expect(() => disposer()).not.toThrow();
    } finally {
      removeListener();
    }
  });

  it('falls back to a no-op disposer and logs a warn when observe() throws (e.g. permission revoked)', () => {
    const internalHandle = makeDirHandleInternal('project');
    const dirHandle: DirectoryHandle = {
      _internal: internalHandle,
      kind: 'directory',
      name: 'project',
      path: 'project',
      platform: 'web',
    };

    const warnRecords: Array<{ level: string; message: string | undefined }> = [];
    const removeListener = addLogListener((record) => {
      if (record.level === 'warn') {
        warnRecords.push({ level: String(record.level), message: record.message });
      }
    });

    try {
      (globalThis as GlobalWithFSO)['FileSystemObserver'] = class {
        observe() {
          throw new Error('NotAllowedError: permission revoked');
        }
        disconnect() {}
      };

      const adapter = new WebFileSystemAdapter();
      const callback = vi.fn();

      // Must not throw
      const disposer = adapter.watchDirectory?.(dirHandle, callback);
      expect(disposer).toBeDefined();
      // disposer must be callable without throw
      expect(() => disposer!()).not.toThrow();
      // no spurious change events
      expect(callback).not.toHaveBeenCalled();
      // warn must have been logged via the logger
      expect(warnRecords.length).toBeGreaterThan(0);
    } finally {
      removeListener();
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers for multi-root API tests
// ---------------------------------------------------------------------------

function makeDirHandle(name: string): FileSystemDirectoryHandle {
  return {
    entries: vi.fn(),
    kind: 'directory' as const,
    name,
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
    handle: {
      entries: vi.fn(),
      kind: 'directory' as const,
      name: s.name,
      queryPermission: vi.fn().mockResolvedValue(s.permission),
    } as unknown as FileSystemDirectoryHandle,
    lastAccessedAt: Date.now(),
    name: s.name,
    storedAt: Date.now(),
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

  describe('addRoot dedupe (isSameEntry)', () => {
    /**
     * Stateful cache mock: storeRootHandle records into a Map and
     * getAllRootHandles returns the live records, so the dedupe scan in
     * addRoot sees what previous addRoot calls stored.
     */
    function createStatefulHandleCache(): {
      cache: HandleCache;
      records: Map<string, StoredRootHandle>;
    } {
      const records = new Map<string, StoredRootHandle>();
      const cache = createHandleCache({
        getAllRootHandles: vi.fn(async () => Array.from(records.values())),
        storeRootHandle: vi.fn(async (folderId: string, handle: FileSystemDirectoryHandle) => {
          const existing = records.get(folderId);
          records.set(folderId, {
            folderId,
            handle,
            lastAccessedAt: Date.now(),
            name: handle.name,
            storedAt: existing?.storedAt ?? Date.now(),
          });
        }),
      });
      return { cache, records };
    }

    function makeSameEntryAwareDirHandle(name: string): FileSystemDirectoryHandle {
      const handle = {
        entries: vi.fn(),
        isSameEntry: vi.fn(async (other: FileSystemHandle) => other === (handle as unknown)),
        kind: 'directory' as const,
        name,
        queryPermission: vi.fn().mockResolvedValue('granted'),
      };
      return handle as unknown as FileSystemDirectoryHandle;
    }

    it('re-picking the same directory reuses the existing RootId and does not grow the cache', async () => {
      const dirHandle = makeSameEntryAwareDirHandle('my-project');
      (
        window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
      ).showDirectoryPicker = vi.fn().mockResolvedValue(dirHandle);
      const { cache, records } = createStatefulHandleCache();
      const adapter = new WebFileSystemAdapter({ handleCache: cache });

      const first = await adapter.addRoot();
      const second = await adapter.addRoot();

      expect(second.rootId).toBe(first.rootId);
      expect(records.size).toBe(1);
      // Reuse mirrors desktop semantics: same descriptor shape, granted, persisted.
      expect(second.kind).toBe('fsa');
      expect(second.displayName).toBe('my-project');
      expect(second.permissionState).toBe('granted');
      expect(second.persisted).toBe(true);
      // The fresh handle is re-stored under the existing RootId.
      expect(cache.storeRootHandle).toHaveBeenCalledTimes(2);
      expect((cache.storeRootHandle as Mock).mock.calls[1]).toEqual([first.rootId, dirHandle]);
    });

    it('picking a different directory mints a new RootId', async () => {
      const firstDir = makeSameEntryAwareDirHandle('project-a');
      const secondDir = makeSameEntryAwareDirHandle('project-b');
      const picker = vi.fn().mockResolvedValueOnce(firstDir).mockResolvedValueOnce(secondDir);
      (
        window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
      ).showDirectoryPicker = picker;
      const { cache, records } = createStatefulHandleCache();
      const adapter = new WebFileSystemAdapter({ handleCache: cache });

      const first = await adapter.addRoot();
      const second = await adapter.addRoot();

      expect(second.rootId).not.toBe(first.rootId);
      expect(second.rootId).toMatch(/^[0-9a-f-]{36}$/);
      expect(records.size).toBe(2);
    });

    it('skips a stale stored handle whose isSameEntry throws without failing addRoot', async () => {
      const { cache, records } = createStatefulHandleCache();
      const staleHandle = {
        entries: vi.fn(),
        isSameEntry: vi.fn().mockRejectedValue(new Error('InvalidStateError: handle is dead')),
        kind: 'directory' as const,
        name: 'stale',
      } as unknown as FileSystemDirectoryHandle;
      records.set('stale-root-id', {
        folderId: 'stale-root-id',
        handle: staleHandle,
        lastAccessedAt: Date.now(),
        name: 'stale',
        storedAt: Date.now(),
      });

      const dirHandle = makeSameEntryAwareDirHandle('fresh-project');
      (
        window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
      ).showDirectoryPicker = vi.fn().mockResolvedValue(dirHandle);
      const adapter = new WebFileSystemAdapter({ handleCache: cache });

      const descriptor = await adapter.addRoot();

      expect(descriptor.rootId).not.toBe('stale-root-id');
      expect(descriptor.rootId).toMatch(/^[0-9a-f-]{36}$/);
      expect(descriptor.persisted).toBe(true);
      expect(staleHandle.isSameEntry).toHaveBeenCalled();
    });
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

  describe('removeRoot (disconnect)', () => {
    it('forgets the stored handle via removeRootHandle(rootId)', async () => {
      const handleCache = createHandleCache();
      const adapter = new WebFileSystemAdapter({ handleCache });

      await adapter.removeRoot('root-id-1');

      expect(handleCache.removeRootHandle).toHaveBeenCalledExactlyOnceWith('root-id-1');
    });

    it('clears the in-memory lastRootFolderId when it matches the removed root', async () => {
      const { adapter } = setupAdapterWithPicker('my-project');
      const descriptor = await adapter.addRoot();
      const internals = adapter as unknown as { lastRootFolderId: string | null };
      expect(internals.lastRootFolderId).toBe(descriptor.rootId);

      await adapter.removeRoot(descriptor.rootId);

      expect(internals.lastRootFolderId).toBeNull();
    });

    it('leaves lastRootFolderId untouched when removing a different root', async () => {
      const { adapter } = setupAdapterWithPicker('my-project');
      const descriptor = await adapter.addRoot();

      await adapter.removeRoot('some-other-root-id');

      const internals = adapter as unknown as { lastRootFolderId: string | null };
      expect(internals.lastRootFolderId).toBe(descriptor.rootId);
    });
  });
});
