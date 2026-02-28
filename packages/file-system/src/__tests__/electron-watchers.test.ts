import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFsWatch } from '../adapters/electron-watchers';
import type { DirectoryHandle, FileSystemChange } from '../types';

// Mock the logger
vi.mock('@brainstrike/utils', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockHandle: DirectoryHandle = {
  path: '/test/dir',
  name: 'dir',
  kind: 'directory',
  platform: 'electron',
};

describe('startFsWatch', () => {
  let mockWatchCallback: ((ev: string, filename: string | null) => void) | null;
  let mockClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWatchCallback = null;
    mockClose = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(require('node:fs') as any, 'watch').mockImplementation((...args: unknown[]) => {
      mockWatchCallback = args[2] as (ev: string, filename: string | null) => void;
      return { close: mockClose };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('coalesces multiple events within 150ms into one callback invocation', async () => {
    const statMock = vi.spyOn(require('node:fs').promises, 'stat').mockResolvedValue({
      isDirectory: () => false,
    });
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
    await vi.advanceTimersByTimeAsync(150);
    expect(callback).toHaveBeenCalledTimes(1);

    const changes: FileSystemChange[] = callback.mock.calls[0]![0];
    expect(changes).toHaveLength(3);
    expect(changes.map((c) => c.path)).toEqual([
      '/test/dir/a.txt',
      '/test/dir/b.txt',
      '/test/dir/c.txt',
    ]);

    statMock.mockRestore();
  });

  it('pushes removed event when stat rejects on rename', async () => {
    const statMock = vi
      .spyOn(require('node:fs').promises, 'stat')
      .mockRejectedValue(new Error('ENOENT'));
    const callback = vi.fn();
    startFsWatch(mockHandle, callback);

    mockWatchCallback?.('rename', 'deleted.txt');

    await vi.advanceTimersByTimeAsync(150);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'removed', path: '/test/dir/deleted.txt', kind: 'file' }),
    ]);

    statMock.mockRestore();
  });

  it('does NOT push removed event for change events that fail stat', async () => {
    const statMock = vi
      .spyOn(require('node:fs').promises, 'stat')
      .mockRejectedValue(new Error('ENOENT'));
    const callback = vi.fn();
    startFsWatch(mockHandle, callback);

    mockWatchCallback?.('change', 'transient.txt');

    await vi.advanceTimersByTimeAsync(150);
    // change event with failed stat and ev !== 'rename' is silently dropped
    expect(callback).not.toHaveBeenCalled();

    statMock.mockRestore();
  });

  it('stop function flushes remaining batch immediately', async () => {
    const statMock = vi.spyOn(require('node:fs').promises, 'stat').mockResolvedValue({
      isDirectory: () => false,
    });
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
    const statMock = vi.spyOn(require('node:fs').promises, 'stat').mockResolvedValue({
      isDirectory: () => false,
    });
    const callback = vi.fn();
    startFsWatch(mockHandle, callback);

    mockWatchCallback?.('change', null);

    await vi.advanceTimersByTimeAsync(150);
    expect(callback).not.toHaveBeenCalled();
    expect(statMock).not.toHaveBeenCalled();

    statMock.mockRestore();
  });

  it('detects directories via stat isDirectory', async () => {
    const statMock = vi.spyOn(require('node:fs').promises, 'stat').mockResolvedValue({
      isDirectory: () => true,
    });
    const callback = vi.fn();
    startFsWatch(mockHandle, callback);

    mockWatchCallback?.('rename', 'new-folder');

    await vi.advanceTimersByTimeAsync(150);
    expect(callback).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'added', kind: 'directory' }),
    ]);

    statMock.mockRestore();
  });
});
