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
type ChokidarWatchOptions = Record<string, unknown>;

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

function getChokidarWatchOptions(): ChokidarWatchOptions {
  const calls = chokidarWatch.mock.calls as unknown as [string, ChokidarWatchOptions][];
  const options = calls[0]?.[1];
  expect(options).toBeDefined();
  return options as ChokidarWatchOptions;
}

describe('startFsWatch', () => {
  let mockWatchCallback: ((ev: string, filename: string | null) => void) | null;
  let mockClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWatchCallback = null;
    mockClose = vi.fn();
    chokidarHandlers.clear();
    loggerMock.error.mockClear();
    loggerMock.warn.mockClear();

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

  it('starts the native fallback recursively and logs visible degraded behavior', () => {
    const callback = vi.fn();
    startFsWatch(mockHandle, callback);

    expect(fs.watch).toHaveBeenCalledWith(
      mockHandle.path,
      { recursive: true },
      expect.any(Function)
    );
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Using recursive native fs.watch fallback',
      expect.objectContaining({
        path: mockHandle.path,
        platform: process.platform,
        recursiveSupport: 'macos-windows-only',
      })
    );
  });

  it('uses project ignore rules before statting native fallback events', async () => {
    const statMock = vi.spyOn(fs.promises, 'stat').mockResolvedValue({
      isDirectory: () => false,
    } as Stats);
    const callback = vi.fn();
    startFsWatch(mockHandle, callback);

    mockWatchCallback?.('change', '.git/config');
    mockWatchCallback?.('change', 'node_modules/react/index.js');
    mockWatchCallback?.('change', 'dist/app.js');
    mockWatchCallback?.('change', '.github/workflows/ci.yml');

    await vi.advanceTimersByTimeAsync(0);

    expect(statMock).toHaveBeenCalledTimes(1);
    expect(statMock).toHaveBeenCalledWith(path.join(mockHandle.path, '.github/workflows/ci.yml'));

    await vi.advanceTimersByTimeAsync(FS_WATCH_BATCH_WINDOW_MS);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith([
      {
        kind: 'file',
        path: path.join(mockHandle.path, '.github/workflows/ci.yml'),
        type: 'modified',
      },
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

  it('does not emit native fallback events that resolve after stop', async () => {
    let resolveStat: ((stat: Stats) => void) | undefined;
    const statMock = vi.spyOn(fs.promises, 'stat').mockImplementation(
      () =>
        new Promise<Stats>((resolve) => {
          resolveStat = resolve;
        })
    );
    const callback = vi.fn();
    const stop = startFsWatch(mockHandle, callback);

    mockWatchCallback?.('change', 'late.txt');
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveStat).toBeDefined();

    stop();
    resolveStat?.({ isDirectory: () => false } as Stats);

    await vi.advanceTimersByTimeAsync(FS_WATCH_BATCH_WINDOW_MS);

    expect(callback).not.toHaveBeenCalled();

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

  it('returns a no-op stop function and logs when recursive native fs.watch fails', () => {
    vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('watch unavailable');
    });

    const stop = startFsWatch(mockHandle, vi.fn());
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Failed to start recursive native fs.watch; folder will not be watched',
      expect.objectContaining({
        error: expect.any(Error),
        path: mockHandle.path,
        platform: process.platform,
        recursiveSupport: 'macos-windows-only',
      })
    );
  });
});

describe('startChokidarWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    chokidarHandlers.clear();
    chokidarWatch.mockClear();
    chokidarClose.mockClear();
    loggerMock.error.mockClear();
    loggerMock.warn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('configures chokidar for recursive watching with project ignore rules', async () => {
    const callback = vi.fn();
    const stop = await startChokidarWatch(mockHandle, callback);

    expect(chokidarWatch).toHaveBeenCalledWith(
      mockHandle.path,
      expect.objectContaining({
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
        followSymlinks: false,
        atomic: true,
        ignored: expect.any(Function),
      })
    );

    const options = getChokidarWatchOptions();
    expect(options).not.toHaveProperty('depth');

    stop();
  });

  it('uses project ignore rules without blanket-ignoring dot-prefixed paths', async () => {
    const callback = vi.fn();
    const stop = await startChokidarWatch(mockHandle, callback);

    const options = getChokidarWatchOptions();
    const ignored = options['ignored'] as (filePath: string) => boolean;

    expect(ignored('/repo/.git/config')).toBe(true);
    expect(ignored('/repo/node_modules/react/index.js')).toBe(true);
    expect(ignored('/repo/dist/app.js')).toBe(true);
    expect(ignored('/repo/build/app.js')).toBe(true);
    expect(ignored('/repo/.pnpm-store/v10/files/00')).toBe(true);
    expect(ignored('/repo/.next/server/app.js')).toBe(true);
    expect(ignored('/repo/.DS_Store')).toBe(true);
    expect(ignored('/repo/.github/workflows/ci.yml')).toBe(false);

    stop();
  });

  it('batches nested chokidar add/change/unlink events in order after 150ms', async () => {
    const callback = vi.fn();
    await startChokidarWatch(mockHandle, callback);

    chokidarHandlers.get('add')?.('/test/dir/src/new.ts');
    chokidarHandlers.get('change')?.('/test/dir/src/nested/update.ts');
    chokidarHandlers.get('unlink')?.('/test/dir/src/nested/remove.ts');

    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FS_WATCH_BATCH_WINDOW_MS);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith([
      { type: 'added', path: '/test/dir/src/new.ts', kind: 'file' },
      { type: 'modified', path: '/test/dir/src/nested/update.ts', kind: 'file' },
      { type: 'removed', path: '/test/dir/src/nested/remove.ts', kind: 'file' },
    ]);
  });

  it('maps chokidar events to FileSystemChange payloads', async () => {
    const callback = vi.fn();
    const stop = await startChokidarWatch(mockHandle, callback);

    chokidarHandlers.get('add')?.('/test/dir/new.txt');
    chokidarHandlers.get('addDir')?.('/test/dir/sub');
    chokidarHandlers.get('change')?.('/test/dir/update.txt');
    chokidarHandlers.get('unlink')?.('/test/dir/remove.txt');
    chokidarHandlers.get('unlinkDir')?.('/test/dir/old-sub');
    chokidarHandlers.get('error')?.(new Error('watch error'));

    await vi.advanceTimersByTimeAsync(FS_WATCH_BATCH_WINDOW_MS);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith([
      { type: 'added', path: '/test/dir/new.txt', kind: 'file' },
      { type: 'added', path: '/test/dir/sub', kind: 'directory' },
      { type: 'modified', path: '/test/dir/update.txt', kind: 'file' },
      { type: 'removed', path: '/test/dir/remove.txt', kind: 'file' },
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
    loggerMock.warn.mockClear();
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
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Using recursive native fs.watch fallback',
      expect.objectContaining({
        path: mockHandle.path,
        platform: process.platform,
        recursiveSupport: 'macos-windows-only',
      })
    );

    stop();
  });

  it('logs visible fallback behavior for MODULE_NOT_FOUND and still falls back to fs.watch', () => {
    const callback = vi.fn();
    const moduleError = Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' });
    const stop = handleWatcherSetupError(moduleError, mockHandle, callback);

    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Using recursive native fs.watch fallback',
      expect.objectContaining({
        path: mockHandle.path,
        platform: process.platform,
        recursiveSupport: 'macos-windows-only',
      })
    );
    stop();
    expect(fallbackClose).toHaveBeenCalledTimes(1);
  });
});
