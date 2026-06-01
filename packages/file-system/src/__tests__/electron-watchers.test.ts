import type { FSWatcher, Stats } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FS_WATCH_BATCH_WINDOW_MS,
  FS_WATCH_MAX_BATCH_SIZE,
  handleWatcherSetupError,
  startChokidarWatch,
  startFsWatch,
} from '../adapters/electron-watchers';
import type { DirectoryHandle, FileSystemChange } from '../types';

type ChokidarEvent = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir' | 'error';
type ChokidarHandler = (value: unknown) => void;

const { chokidarClose, chokidarHandlers, chokidarWatch, loggerMock } = vi.hoisted(() => {
  const hoistedLoggerMock = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const hoistedChokidarHandlers = new Map<ChokidarEvent, ChokidarHandler>();
  const hoistedChokidarClose = vi.fn();
  const hoistedChokidarWatcher = {
    on: vi.fn((event: ChokidarEvent, handler: ChokidarHandler) => {
      hoistedChokidarHandlers.set(event, handler);
      return hoistedChokidarWatcher;
    }),
    close: hoistedChokidarClose,
  };
  const hoistedChokidarWatch = vi.fn(() => hoistedChokidarWatcher);
  return {
    loggerMock: hoistedLoggerMock,
    chokidarHandlers: hoistedChokidarHandlers,
    chokidarClose: hoistedChokidarClose,
    chokidarWatch: hoistedChokidarWatch,
  };
});

vi.mock('@brainstrike/utils', () => ({
  createLogger: () => loggerMock,
}));

const mockHandle: DirectoryHandle = {
  path: '/test/dir',
  name: 'dir',
  kind: 'directory',
  platform: 'electron',
};

vi.mock('chokidar', () => ({
  watch: chokidarWatch,
}));

describe('startFsWatch', () => {
  let mockWatchCallback: ((ev: string, filename: string | null) => void) | null;
  let mockClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWatchCallback = null;
    mockClose = vi.fn();
    chokidarHandlers.clear();
    loggerMock.error.mockClear();

    vi.spyOn(fs, 'watch').mockImplementation(((...args: unknown[]) => {
      mockWatchCallback = args[2] as ((ev: string, filename: string | null) => void) | null;
      return { close: mockClose } as unknown as FSWatcher;
    }) as unknown as typeof fs.watch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('coalesces multiple events within 150ms into one callback invocation', async () => {
    const statMock = vi.spyOn(fs.promises, 'stat').mockResolvedValue({
      isDirectory: () => false,
    } as Stats);
    const callback = vi.fn();
    startFsWatch(mockHandle, callback);

    // Fire 3 events rapidly
    mockWatchCallback?.('change', 'a.txt');
    mockWatchCallback?.('change', 'b.txt');
    mockWatchCallback?.('rename', 'c.txt');

    // Let the async stat() calls resolve
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).not.toHaveBeenCalled();

    // Advance past the 150ms batch window
    await vi.advanceTimersByTimeAsync(FS_WATCH_BATCH_WINDOW_MS);
    expect(callback).toHaveBeenCalledTimes(1);

    const changes: FileSystemChange[] = callback.mock.calls[0]![0];
    expect(changes).toHaveLength(3);
    expect(changes.map((c) => c.path)).toEqual([
      path.join(mockHandle.path, 'a.txt'),
      path.join(mockHandle.path, 'b.txt'),
      path.join(mockHandle.path, 'c.txt'),
    ]);

    statMock.mockRestore();
  });

  it('flushes immediately when the batch reaches max size', async () => {
    const statMock = vi.spyOn(fs.promises, 'stat').mockResolvedValue({
      isDirectory: () => false,
    } as Stats);
    const callback = vi.fn();
    startFsWatch(mockHandle, callback);

    for (let index = 0; index < FS_WATCH_MAX_BATCH_SIZE; index += 1) {
      mockWatchCallback?.('change', `file-${index}.txt`);
    }

    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);

    const firstBatch: FileSystemChange[] = callback.mock.calls[0]![0];
    expect(firstBatch).toHaveLength(FS_WATCH_MAX_BATCH_SIZE);

    // Reaching the cap clears the pending timer and avoids duplicate flushes.
    await vi.advanceTimersByTimeAsync(FS_WATCH_BATCH_WINDOW_MS);
    expect(callback).toHaveBeenCalledTimes(1);

    statMock.mockRestore();
  });

  it('starts a new batch after an immediate max-size flush', async () => {
    const statMock = vi.spyOn(fs.promises, 'stat').mockResolvedValue({
      isDirectory: () => false,
    } as Stats);
    const callback = vi.fn();
    startFsWatch(mockHandle, callback);

    for (let index = 0; index < FS_WATCH_MAX_BATCH_SIZE + 1; index += 1) {
      mockWatchCallback?.('change', `file-${index}.txt`);
    }

    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]?.[0]).toHaveLength(FS_WATCH_MAX_BATCH_SIZE);

    await vi.advanceTimersByTimeAsync(FS_WATCH_BATCH_WINDOW_MS);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[1]?.[0]).toHaveLength(1);

    statMock.mockRestore();
  });

  it('pushes removed event when stat rejects on rename', async () => {
    const statMock = vi.spyOn(fs.promises, 'stat').mockRejectedValue(new Error('ENOENT'));
    const callback = vi.fn();
    startFsWatch(mockHandle, callback);

    mockWatchCallback?.('rename', 'deleted.txt');

    await vi.advanceTimersByTimeAsync(FS_WATCH_BATCH_WINDOW_MS);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'file',
        path: path.join(mockHandle.path, 'deleted.txt'),
        type: 'removed',
      }),
    ]);

    statMock.mockRestore();
  });

  it('does NOT push removed event for change events that fail stat', async () => {
    const statMock = vi.spyOn(fs.promises, 'stat').mockRejectedValue(new Error('ENOENT'));
    const callback = vi.fn();
    startFsWatch(mockHandle, callback);

    mockWatchCallback?.('change', 'transient.txt');

    await vi.advanceTimersByTimeAsync(FS_WATCH_BATCH_WINDOW_MS);
    // change event with failed stat and ev !== 'rename' is silently dropped
    expect(callback).not.toHaveBeenCalled();

    statMock.mockRestore();
  });

  it('stop function flushes remaining batch immediately', async () => {
    const statMock = vi.spyOn(fs.promises, 'stat').mockResolvedValue({
      isDirectory: () => false,
    } as Stats);
    const callback = vi.fn();
    const stop = startFsWatch(mockHandle, callback);

    mockWatchCallback?.('change', 'file.txt');

    // Let stat() resolve but don't advance timer
    await vi.advanceTimersByTimeAsync(0);

    // Stop before the 150ms timer fires
    stop();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalled();

    statMock.mockRestore();
  });

  it('ignores events with null filename', async () => {
    const statMock = vi.spyOn(fs.promises, 'stat').mockResolvedValue({
      isDirectory: () => false,
    } as Stats);
    const callback = vi.fn();
    startFsWatch(mockHandle, callback);

    mockWatchCallback?.('change', null);

    await vi.advanceTimersByTimeAsync(FS_WATCH_BATCH_WINDOW_MS);
    expect(callback).not.toHaveBeenCalled();
    expect(statMock).not.toHaveBeenCalled();

    statMock.mockRestore();
  });

  it('detects directories via stat isDirectory', async () => {
    const statMock = vi.spyOn(fs.promises, 'stat').mockResolvedValue({
      isDirectory: () => true,
    } as Stats);
    const callback = vi.fn();
    startFsWatch(mockHandle, callback);

    mockWatchCallback?.('rename', 'new-folder');

    await vi.advanceTimersByTimeAsync(FS_WATCH_BATCH_WINDOW_MS);
    expect(callback).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'added', kind: 'directory' }),
    ]);

    statMock.mockRestore();
  });

  it('returns a no-op stop function when native fs.watch fails', () => {
    vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('watch unavailable');
    });

    const stop = startFsWatch(mockHandle, vi.fn());
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
    expect(loggerMock.error).toHaveBeenCalledWith('Failed to start native fs.watch', {
      error: expect.any(Error),
      path: mockHandle.path,
    });
  });
});

describe('startChokidarWatch', () => {
  beforeEach(() => {
    chokidarHandlers.clear();
    chokidarWatch.mockClear();
    chokidarClose.mockClear();
    loggerMock.error.mockClear();
  });

  it('maps chokidar events to FileSystemChange payloads', async () => {
    const callback = vi.fn();
    const stop = await startChokidarWatch(mockHandle, callback);

    expect(chokidarWatch).toHaveBeenCalledWith(mockHandle.path, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
      ignored: /(^|[/\\])\../,
      depth: 0,
    });

    chokidarHandlers.get('add')?.('/test/dir/new.txt');
    chokidarHandlers.get('addDir')?.('/test/dir/sub');
    chokidarHandlers.get('change')?.('/test/dir/update.txt');
    chokidarHandlers.get('unlink')?.('/test/dir/remove.txt');
    chokidarHandlers.get('unlinkDir')?.('/test/dir/old-sub');
    chokidarHandlers.get('error')?.(new Error('watch error'));

    expect(callback).toHaveBeenNthCalledWith(1, [
      { type: 'added', path: '/test/dir/new.txt', kind: 'file' },
    ]);
    expect(callback).toHaveBeenNthCalledWith(2, [
      { type: 'added', path: '/test/dir/sub', kind: 'directory' },
    ]);
    expect(callback).toHaveBeenNthCalledWith(3, [
      { type: 'modified', path: '/test/dir/update.txt', kind: 'file' },
    ]);
    expect(callback).toHaveBeenNthCalledWith(4, [
      { type: 'removed', path: '/test/dir/remove.txt', kind: 'file' },
    ]);
    expect(callback).toHaveBeenNthCalledWith(5, [
      { type: 'removed', path: '/test/dir/old-sub', kind: 'directory' },
    ]);
    expect(loggerMock.error).toHaveBeenCalledWith('Chokidar watcher reported an error', {
      error: expect.any(Error),
      path: mockHandle.path,
    });

    stop();
    expect(chokidarClose).toHaveBeenCalledTimes(1);
  });
});

describe('handleWatcherSetupError', () => {
  let fallbackClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fallbackClose = vi.fn();
    vi.spyOn(fs, 'watch').mockImplementation(
      (() => ({ close: fallbackClose }) as unknown as FSWatcher) as unknown as typeof fs.watch
    );
    loggerMock.error.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs non-module errors before falling back to fs.watch', () => {
    const callback = vi.fn();
    const stop = handleWatcherSetupError(new Error('boom'), mockHandle, callback);

    expect(loggerMock.error).toHaveBeenCalledWith(
      'Failed to set up chokidar watcher, falling back to fs.watch',
      {
        error: expect.any(Error),
        path: mockHandle.path,
      }
    );

    stop();
  });

  it('suppresses log for MODULE_NOT_FOUND and still falls back to fs.watch', () => {
    const callback = vi.fn();
    const moduleError = Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' });
    const stop = handleWatcherSetupError(moduleError, mockHandle, callback);

    expect(loggerMock.error).not.toHaveBeenCalled();
    stop();
    expect(fallbackClose).toHaveBeenCalledTimes(1);
  });
});
