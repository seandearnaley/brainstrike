import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetFsWatchDispatcherForTest,
  ElectronRendererFileSystemAdapter,
  ElectronRendererStorageAdapter,
} from '../../renderer/adapters';
import { mockElectronAPI } from '../setup';

describe('ElectronRendererFileSystemAdapter', () => {
  let adapter: ElectronRendererFileSystemAdapter;

  beforeEach(() => {
    adapter = new ElectronRendererFileSystemAdapter();
    vi.clearAllMocks();
  });

  it('declares platform "electron" (roots registry derives kind "path" from this)', () => {
    expect(adapter.platform).toBe('electron');
  });

  describe('requestDirectoryAccess', () => {
    it('should call electronAPI.fileSystem.requestDirectoryAccess', async () => {
      const result = await adapter.requestDirectoryAccess();

      expect(mockElectronAPI.fileSystem.requestDirectoryAccess).toHaveBeenCalledOnce();
      expect(result).toEqual({
        kind: 'directory',
        name: 'mock-directory',
        path: '/mock/path',
        platform: 'electron',
      });
    });

    it('should save folder path when handle has path', async () => {
      const mockHandle = {
        kind: 'directory' as const,
        name: 'test-directory',
        path: '/test/folder/path',
        platform: 'electron' as const,
      };

      mockElectronAPI.fileSystem.requestDirectoryAccess.mockResolvedValueOnce(mockHandle);

      await adapter.requestDirectoryAccess();

      expect(mockElectronAPI.fileSystem.saveLastFolder).toHaveBeenCalledWith('/test/folder/path');
    });

    it('should not save folder path when handle has no path', async () => {
      const mockHandle = {
        kind: 'directory' as const,
        name: 'test-directory',
        path: '',
        platform: 'electron' as const,
      };

      mockElectronAPI.fileSystem.requestDirectoryAccess.mockResolvedValueOnce(mockHandle);

      await adapter.requestDirectoryAccess();

      expect(mockElectronAPI.fileSystem.saveLastFolder).not.toHaveBeenCalled();
    });
  });

  describe('readDirectory', () => {
    it('should call electronAPI.fileSystem.readDirectory with handle', async () => {
      const mockHandle = {
        kind: 'directory' as const,
        name: 'test',
        path: '/test',
        platform: 'electron' as const,
      };
      const mockFiles = [
        {
          depth: 0,
          isVisible: true,
          name: 'file1.txt',
          path: '/test/file1.txt',
          rootFolderId: 'test',
          selectionState: 'unchecked',
          type: 'file',
        },
      ];

      mockElectronAPI.fileSystem.readDirectory.mockResolvedValue(mockFiles);

      const result = await adapter.readDirectory(mockHandle);

      expect(mockElectronAPI.fileSystem.readDirectory).toHaveBeenCalledWith(mockHandle);
      expect(result).toEqual(mockFiles);
    });
  });

  describe('readFile', () => {
    it('should call electronAPI.fileSystem.readFile with handle', async () => {
      const mockHandle = {
        kind: 'file' as const,
        name: 'file.txt',
        path: '/test/file.txt',
        platform: 'electron' as const,
      };
      const mockContent = 'file content';

      mockElectronAPI.fileSystem.readFile.mockResolvedValue(mockContent);

      const result = await adapter.readFile(mockHandle);

      expect(mockElectronAPI.fileSystem.readFile).toHaveBeenCalledWith(mockHandle);
      expect(result).toBe(mockContent);
    });
  });

  describe('exists', () => {
    it('should call electronAPI.fileSystem.exists with path', async () => {
      const testPath = '/test/path';
      mockElectronAPI.fileSystem.exists.mockResolvedValue(true);

      const result = await adapter.exists(testPath);

      expect(mockElectronAPI.fileSystem.exists).toHaveBeenCalledWith(testPath);
      expect(result).toBe(true);
    });

    it('should return false when file does not exist', async () => {
      const testPath = '/nonexistent/path';
      mockElectronAPI.fileSystem.exists.mockResolvedValue(false);

      const result = await adapter.exists(testPath);

      expect(result).toBe(false);
    });
  });

  // BST-307: Tests for readFileByPath
  describe('readFileByPath', () => {
    it('should call electronAPI.fileSystem.readFileByPath with absolute path', async () => {
      const absolutePath = '/Users/test/project/file.ts';
      const mockContent = 'export const example = "hello";';

      mockElectronAPI.fileSystem.readFileByPath.mockResolvedValue(mockContent);

      const result = await adapter.readFileByPath(absolutePath);

      expect(mockElectronAPI.fileSystem.readFileByPath).toHaveBeenCalledWith(absolutePath);
      expect(result).toBe(mockContent);
    });

    it('should return file content for valid paths', async () => {
      const testPath = '/test/documents/readme.md';
      const expectedContent = '# Test README\n\nThis is a test file.';

      mockElectronAPI.fileSystem.readFileByPath.mockResolvedValue(expectedContent);

      const result = await adapter.readFileByPath(testPath);

      expect(result).toBe(expectedContent);
    });

    it('should handle errors from the IPC call', async () => {
      const testPath = '/nonexistent/file.txt';

      mockElectronAPI.fileSystem.readFileByPath.mockRejectedValue(new Error('File not found'));

      await expect(adapter.readFileByPath(testPath)).rejects.toThrow('File not found');
    });

    it('should propagate path validation errors from main process', async () => {
      const invalidPath = '/etc/passwd';

      mockElectronAPI.fileSystem.readFileByPath.mockRejectedValue(new Error('Invalid path'));

      await expect(adapter.readFileByPath(invalidPath)).rejects.toThrow('Invalid path');
      expect(mockElectronAPI.fileSystem.readFileByPath).toHaveBeenCalledWith(invalidPath);
    });
  });

  describe('addRoot', () => {
    it('should call electronAPI.fileSystem.addRoot and return the descriptor', async () => {
      const mockDescriptor = {
        displayName: 'my-project',
        handle: {
          kind: 'directory' as const,
          name: 'my-project',
          path: '/test/my-project',
          platform: 'electron' as const,
        },
        kind: 'path' as const,
        permissionState: 'granted' as const,
        persisted: true,
        rootId: 'abc-123',
      };
      mockElectronAPI.fileSystem.addRoot.mockResolvedValueOnce(mockDescriptor);

      const result = await adapter.addRoot();

      expect(mockElectronAPI.fileSystem.addRoot).toHaveBeenCalledOnce();
      expect(result).toEqual(mockDescriptor);
    });
  });

  describe('restoreRoots', () => {
    it('should call electronAPI.fileSystem.restoreRoots and return descriptors', async () => {
      const mockDescriptors = [
        {
          displayName: 'project-a',
          handle: {
            kind: 'directory' as const,
            name: 'project-a',
            path: '/test/project-a',
            platform: 'electron' as const,
          },
          kind: 'path' as const,
          permissionState: 'granted' as const,
          persisted: true,
          rootId: 'root-a',
        },
      ];
      mockElectronAPI.fileSystem.restoreRoots.mockResolvedValueOnce(mockDescriptors);

      const result = await adapter.restoreRoots();

      expect(mockElectronAPI.fileSystem.restoreRoots).toHaveBeenCalledOnce();
      expect(result).toEqual(mockDescriptors);
    });

    it('should return empty array when no roots are stored', async () => {
      mockElectronAPI.fileSystem.restoreRoots.mockResolvedValueOnce([]);

      const result = await adapter.restoreRoots();

      expect(result).toEqual([]);
    });
  });

  describe('restoreLastFolder', () => {
    it('should call electronAPI.fileSystem.restoreLastFolder', async () => {
      const mockHandle = {
        kind: 'directory' as const,
        name: 'restored-folder',
        path: '/restored/folder/path',
        platform: 'electron' as const,
      };

      mockElectronAPI.fileSystem.restoreLastFolder.mockResolvedValue(mockHandle);

      const result = await adapter.restoreLastFolder();

      expect(mockElectronAPI.fileSystem.restoreLastFolder).toHaveBeenCalledOnce();
      expect(result).toEqual(mockHandle);
    });

    it('should return null when no folder to restore', async () => {
      mockElectronAPI.fileSystem.restoreLastFolder.mockResolvedValue(null);

      const result = await adapter.restoreLastFolder();

      expect(mockElectronAPI.fileSystem.restoreLastFolder).toHaveBeenCalledOnce();
      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      mockElectronAPI.fileSystem.restoreLastFolder.mockRejectedValue(new Error('Restore failed'));

      await expect(adapter.restoreLastFolder()).rejects.toThrow('Restore failed');
    });
  });
});

describe('watcher health capability (BST-568 slice 3)', () => {
  const handle = {
    kind: 'directory' as const,
    name: 'root',
    path: '/roots/alpha',
    platform: 'electron' as const,
  };

  function makeHealthEvent(watchId: string, state: string) {
    return {
      backend: 'fs-events' as const,
      state: state as 'healthy' | 'failed',
      timestamp: 1,
      watchId,
    };
  }

  let adapter: ElectronRendererFileSystemAdapter;
  let pushHealth: ((event: ReturnType<typeof makeHealthEvent>) => void) | null;

  beforeEach(() => {
    __resetFsWatchDispatcherForTest();
    adapter = new ElectronRendererFileSystemAdapter();
    vi.clearAllMocks();
    pushHealth = null;
    vi.mocked(mockElectronAPI.fileSystem.onWatchHealth).mockImplementation(
      (callback: (event: unknown) => void) => {
        pushHealth = callback;
        return () => {
          pushHealth = null;
        };
      }
    );
    vi.mocked(mockElectronAPI.fileSystem.watchDirectory).mockResolvedValue({
      watchId: 'watch-alpha',
    });
  });

  it('resolves health events to the rootPath of the owning watch', async () => {
    const stop = adapter.watchDirectory(handle, vi.fn());
    await vi.waitFor(() => {
      expect(mockElectronAPI.fileSystem.watchDirectory).toHaveBeenCalled();
    });
    const received: Array<{ rootPath: string; state: string }> = [];
    const unsubscribe = adapter.onWatcherHealth((event) => {
      received.push({ rootPath: event.rootPath, state: event.state });
    });

    pushHealth?.(makeHealthEvent('watch-alpha', 'failed'));
    expect(received).toContainEqual({
      rootPath: '/roots/alpha',
      state: 'failed',
    });
    unsubscribe();
    stop();
  });

  it('replays the latest known state per root to a late subscriber', async () => {
    const stop = adapter.watchDirectory(handle, vi.fn());
    await vi.waitFor(() => {
      expect(mockElectronAPI.fileSystem.watchDirectory).toHaveBeenCalled();
    });
    // Prime the health state BEFORE anyone subscribes: an early subscription
    // captures pushHealth, then unsubscribes.
    const prime = adapter.onWatcherHealth(() => undefined);
    pushHealth?.(makeHealthEvent('watch-alpha', 'healthy'));
    pushHealth?.(makeHealthEvent('watch-alpha', 'failed'));
    prime();

    const received: Array<{ rootPath: string; state: string }> = [];
    const unsubscribe = adapter.onWatcherHealth((event) => {
      received.push({ rootPath: event.rootPath, state: event.state });
    });
    expect(received).toEqual([{ rootPath: '/roots/alpha', state: 'failed' }]);
    unsubscribe();
    stop();
  });

  it('retryWatcher maps the rootPath back to its watchId', async () => {
    const stop = adapter.watchDirectory(handle, vi.fn());
    await vi.waitFor(() => {
      expect(mockElectronAPI.fileSystem.watchDirectory).toHaveBeenCalled();
    });

    const outcome = await adapter.retryWatcher('/roots/alpha');
    expect(outcome).toEqual({ retried: true });
    expect(mockElectronAPI.fileSystem.retryWatch).toHaveBeenCalledWith('watch-alpha');
    stop();
  });

  it('retryWatcher reports unknown for a root without a live watch', async () => {
    const outcome = await adapter.retryWatcher('/roots/never-watched');
    expect(outcome).toEqual({ reason: 'unknown', retried: false });
    expect(mockElectronAPI.fileSystem.retryWatch).not.toHaveBeenCalled();
  });

  it('translates health into the shared FileSystemWatchSignal channel (#1764)', async () => {
    const signals: unknown[] = [];
    const stop = adapter.watchDirectory(handle, vi.fn(), (signal) => {
      signals.push(signal);
    });
    await vi.waitFor(() => {
      expect(mockElectronAPI.fileSystem.watchDirectory).toHaveBeenCalled();
    });
    // Prime the shared subscription so pushHealth is captured.
    const prime = adapter.onWatcherHealth(() => undefined);

    pushHealth?.(makeHealthEvent('watch-alpha', 'healthy'));
    expect(signals).toEqual([]);

    pushHealth?.(makeHealthEvent('watch-alpha', 'degraded'));
    expect(signals).toEqual([{ type: 'overflow' }]);

    pushHealth?.({
      backend: 'fs-events' as const,
      failure: { code: 'x', message: 'dead', retryable: true, terminal: false },
      state: 'failed' as const,
      timestamp: 2,
      watchId: 'watch-alpha',
    });
    expect(signals).toEqual([{ type: 'overflow' }, { message: 'dead', type: 'errored' }]);
    prime();
    stop();
  });

  it('disposing the watch clears its health state and mapping', async () => {
    const stop = adapter.watchDirectory(handle, vi.fn());
    await vi.waitFor(() => {
      expect(mockElectronAPI.fileSystem.watchDirectory).toHaveBeenCalled();
    });
    const prime = adapter.onWatcherHealth(() => undefined);
    pushHealth?.(makeHealthEvent('watch-alpha', 'failed'));
    prime();
    stop();

    const received: unknown[] = [];
    const unsubscribe = adapter.onWatcherHealth((event) => {
      received.push(event);
    });
    expect(received).toEqual([]);
    const outcome = await adapter.retryWatcher('/roots/alpha');
    expect(outcome).toEqual({ reason: 'unknown', retried: false });
    unsubscribe();
  });
});

describe('ElectronRendererStorageAdapter', () => {
  let adapter: ElectronRendererStorageAdapter;

  beforeEach(() => {
    adapter = new ElectronRendererStorageAdapter();
    vi.clearAllMocks();
  });

  describe('getItem', () => {
    it('should call electronAPI.storage.getItem with key', async () => {
      const key = 'test-key';
      const value = 'test-value';
      mockElectronAPI.storage.getItem.mockResolvedValue(value);

      const result = await adapter.getItem(key);

      expect(mockElectronAPI.storage.getItem).toHaveBeenCalledWith(key);
      expect(result).toBe(value);
    });

    it('should return null for non-existent key', async () => {
      const key = 'nonexistent-key';
      mockElectronAPI.storage.getItem.mockResolvedValue(null);

      const result = await adapter.getItem(key);

      expect(result).toBeNull();
    });
  });

  describe('setItem', () => {
    it('should call electronAPI.storage.setItem with key and value', async () => {
      const key = 'test-key';
      const value = 'test-value';

      await adapter.setItem(key, value);

      expect(mockElectronAPI.storage.setItem).toHaveBeenCalledWith(key, value);
    });
  });

  describe('removeItem', () => {
    it('should call electronAPI.storage.removeItem with key', async () => {
      const key = 'test-key';

      await adapter.removeItem(key);

      expect(mockElectronAPI.storage.removeItem).toHaveBeenCalledWith(key);
    });
  });

  describe('clear', () => {
    it('should call electronAPI.storage.clear', async () => {
      await adapter.clear();

      expect(mockElectronAPI.storage.clear).toHaveBeenCalledOnce();
    });
  });

  describe('getAllKeys', () => {
    it('should call electronAPI.storage.getAllKeys', async () => {
      const mockKeys = ['key1', 'key2', 'key3'];
      mockElectronAPI.storage.getAllKeys.mockResolvedValue(mockKeys);

      const result = await adapter.getAllKeys();

      expect(mockElectronAPI.storage.getAllKeys).toHaveBeenCalledOnce();
      expect(result).toEqual(mockKeys);
    });

    it('should return empty array when no keys exist', async () => {
      mockElectronAPI.storage.getAllKeys.mockResolvedValue([]);

      const result = await adapter.getAllKeys();

      expect(result).toEqual([]);
    });
  });
});

describe('ElectronRendererFileSystemAdapter.watchDirectory', () => {
  const handle = {
    kind: 'directory' as const,
    name: 'workspace',
    path: '/workspace',
    platform: 'electron' as const,
  };
  const sampleChanges = [
    { kind: 'file' as const, path: '/workspace/a.ts', type: 'added' as const },
  ];

  let adapter: ElectronRendererFileSystemAdapter;
  let pushEvent: ((event: { changes: typeof sampleChanges; watchId: string }) => void) | null;
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetFsWatchDispatcherForTest();
    adapter = new ElectronRendererFileSystemAdapter();
    vi.clearAllMocks();
    pushEvent = null;
    unsubscribe = vi.fn();
    mockElectronAPI.fileSystem.onWatchEvent.mockImplementation(
      (callback: (event: { changes: typeof sampleChanges; watchId: string }) => void) => {
        pushEvent = callback;
        return unsubscribe;
      }
    );
    mockElectronAPI.fileSystem.watchDirectory.mockResolvedValue({ watchId: 'watch-1' });
  });

  it('starts a bridge watch for the handle and forwards matching change events', async () => {
    const onChanges = vi.fn();

    adapter.watchDirectory(handle, onChanges);
    await vi.waitFor(() => {
      expect(pushEvent).not.toBeNull();
    });

    pushEvent?.({ changes: sampleChanges, watchId: 'watch-1' });
    expect(onChanges).toHaveBeenCalledWith(sampleChanges);
  });

  it('ignores change events stamped with a different watchId', async () => {
    const onChanges = vi.fn();

    adapter.watchDirectory(handle, onChanges);
    await vi.waitFor(() => {
      expect(pushEvent).not.toBeNull();
    });

    pushEvent?.({ changes: sampleChanges, watchId: 'someone-else' });
    expect(onChanges).not.toHaveBeenCalled();
  });

  it('shares ONE onWatchEvent subscription across many watches and routes by watchId', async () => {
    const onChangesA = vi.fn();
    const onChangesB = vi.fn();
    mockElectronAPI.fileSystem.watchDirectory
      .mockResolvedValueOnce({ watchId: 'watch-a' })
      .mockResolvedValueOnce({ watchId: 'watch-b' });

    adapter.watchDirectory(handle, onChangesA);
    adapter.watchDirectory({ ...handle, path: '/workspace-2' }, onChangesB);
    await vi.waitFor(() => {
      expect(mockElectronAPI.fileSystem.watchDirectory).toHaveBeenCalledTimes(2);
      expect(pushEvent).not.toBeNull();
    });

    // Only one bridge listener for the whole channel, no matter the root count.
    expect(mockElectronAPI.fileSystem.onWatchEvent).toHaveBeenCalledTimes(1);

    pushEvent?.({ changes: sampleChanges, watchId: 'watch-b' });
    expect(onChangesB).toHaveBeenCalledWith(sampleChanges);
    expect(onChangesA).not.toHaveBeenCalled();
  });

  it('keeps the shared subscription alive until the LAST watch is disposed', async () => {
    mockElectronAPI.fileSystem.watchDirectory
      .mockResolvedValueOnce({ watchId: 'watch-a' })
      .mockResolvedValueOnce({ watchId: 'watch-b' });

    const disposeA = adapter.watchDirectory(handle, vi.fn());
    const disposeB = adapter.watchDirectory({ ...handle, path: '/workspace-2' }, vi.fn());
    await vi.waitFor(() => {
      expect(mockElectronAPI.fileSystem.watchDirectory).toHaveBeenCalledTimes(2);
      expect(pushEvent).not.toBeNull();
    });

    disposeA();
    expect(mockElectronAPI.fileSystem.unwatchDirectory).toHaveBeenCalledWith('watch-a');
    // One watch remains → shared listener still attached.
    expect(unsubscribe).not.toHaveBeenCalled();

    disposeB();
    expect(mockElectronAPI.fileSystem.unwatchDirectory).toHaveBeenCalledWith('watch-b');
    // Last watch gone → shared listener torn down.
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('disposer unwatches in main', async () => {
    const dispose = adapter.watchDirectory(handle, vi.fn());
    await vi.waitFor(() => {
      expect(pushEvent).not.toBeNull();
    });

    dispose();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(mockElectronAPI.fileSystem.unwatchDirectory).toHaveBeenCalledWith('watch-1');
  });

  it('disposing before the watch resolves still unwatches once the id arrives', async () => {
    let resolveWatch: (value: { watchId: string }) => void = () => {};
    mockElectronAPI.fileSystem.watchDirectory.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWatch = resolve;
        })
    );

    const onChanges = vi.fn();
    const dispose = adapter.watchDirectory(handle, onChanges);
    dispose();
    resolveWatch({ watchId: 'watch-late' });

    await vi.waitFor(() => {
      expect(mockElectronAPI.fileSystem.unwatchDirectory).toHaveBeenCalledWith('watch-late');
    });
    // Disposed before resolve → never registered, so no bridge subscription.
    expect(mockElectronAPI.fileSystem.onWatchEvent).not.toHaveBeenCalled();
    pushEvent?.({ changes: sampleChanges, watchId: 'watch-late' });
    expect(onChanges).not.toHaveBeenCalled();
  });

  it('returns a no-op disposer when the bridge lacks the watch capability', () => {
    const original = mockElectronAPI.fileSystem.watchDirectory;
    // Simulate an older preload without the watch bridge.
    (mockElectronAPI.fileSystem as { watchDirectory?: unknown }).watchDirectory = undefined;
    try {
      const dispose = adapter.watchDirectory(handle, vi.fn());
      expect(() => dispose()).not.toThrow();
      expect(mockElectronAPI.fileSystem.onWatchEvent).not.toHaveBeenCalled();
    } finally {
      mockElectronAPI.fileSystem.watchDirectory = original;
    }
  });
});
