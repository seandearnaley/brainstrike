import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebFileSystemAdapter } from '../adapters/web-adapter';
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
      const list = await adapter.readDirectory(handle, { includeMetadata: true, concurrency });
      expect(list.filter((e) => e.type === 'file')).toHaveLength(count);
      expect(peak).toBeLessThanOrEqual(concurrency);
    });
  });

  describe('readDirectory', () => {
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
      if (!first || !second) throw new Error('unreachable');
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
  });

  describe('exists', () => {
    it('always returns false', async () => {
      const result = await adapter.exists('any/path');
      expect(result).toBe(false);
    });
  });
});
