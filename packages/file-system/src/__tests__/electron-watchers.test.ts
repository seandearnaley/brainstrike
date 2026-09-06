// The shared change batcher (BST-568): 150ms trailing coalescing with a
// bounded batch size. Engine-level behavior (event normalization, ignore
// rules, health) lives in parcel-watchers.test.ts — the legacy chokidar /
// fs.watch engines were removed in slice 4.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFileSystemChangeBatcher,
  FS_WATCH_BATCH_WINDOW_MS,
  FS_WATCH_MAX_BATCH_SIZE,
} from '../adapters/electron-watchers.js';
import { FILE_SYSTEM_WATCH_FILTERED_BOUNDARY_LIMIT, type FileSystemChange } from '../types.js';

function change(pathSuffix: number): FileSystemChange {
  return { kind: 'file', path: `/root/f${pathSuffix}.txt`, type: 'added' };
}

describe('createFileSystemChangeBatcher', () => {
  let batches: FileSystemChange[][] = [];
  let metadataBatches: unknown[] = [];
  const collect = (changes: FileSystemChange[], metadata?: unknown) => {
    batches.push(changes);
    metadataBatches.push(metadata);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    batches = [];
    metadataBatches = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces changes within the 150ms window into one batch', () => {
    const batcher = createFileSystemChangeBatcher(collect);
    batcher.enqueue(change(1));
    batcher.enqueue(change(2));
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(FS_WATCH_BATCH_WINDOW_MS);
    expect(batches).toEqual([[change(1), change(2)]]);
    batcher.dispose();
  });

  it('flushes immediately when the bounded batch size is reached', () => {
    const batcher = createFileSystemChangeBatcher(collect);
    for (let i = 0; i < FS_WATCH_MAX_BATCH_SIZE; i += 1) {
      batcher.enqueue(change(i));
    }
    // No timer advance needed: the cap forces a synchronous flush.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(FS_WATCH_MAX_BATCH_SIZE);
    // The window restarts cleanly for subsequent changes.
    batcher.enqueue(change(9999));
    vi.advanceTimersByTime(FS_WATCH_BATCH_WINDOW_MS);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([change(9999)]);
    batcher.dispose();
  });

  it('dispose flushes the pending batch synchronously', () => {
    const batcher = createFileSystemChangeBatcher(collect);
    batcher.enqueue(change(1));
    batcher.dispose();
    expect(batches).toEqual([[change(1)]]);
  });

  it('drops changes enqueued after dispose and never double-flushes', () => {
    const batcher = createFileSystemChangeBatcher(collect);
    batcher.enqueue(change(1));
    batcher.dispose();
    batcher.enqueue(change(2));
    batcher.dispose();
    vi.advanceTimersByTime(FS_WATCH_BATCH_WINDOW_MS * 2);
    expect(batches).toEqual([[change(1)]]);
  });

  it('emits nothing when disposed with an empty batch', () => {
    const batcher = createFileSystemChangeBatcher(collect);
    batcher.dispose();
    expect(batches).toEqual([]);
  });

  it('dedupes filtered boundaries while retaining their root-relative identity', () => {
    const batcher = createFileSystemChangeBatcher(collect);
    batcher.markFilteredChangeBoundary('packages/app/dist');
    batcher.markFilteredChangeBoundary('packages/app/dist');
    batcher.markFilteredChangeBoundary('packages/docs/build');

    vi.advanceTimersByTime(FS_WATCH_BATCH_WINDOW_MS);

    expect(batches).toEqual([[]]);
    expect(metadataBatches).toEqual([
      {
        filteredChangeBoundaries: ['packages/app/dist', 'packages/docs/build'],
      },
    ]);
    batcher.dispose();
  });

  it('caps filtered boundaries at the typed limit and reports overflow explicitly', () => {
    const batcher = createFileSystemChangeBatcher(collect);
    expect(FILE_SYSTEM_WATCH_FILTERED_BOUNDARY_LIMIT).toBe(64);
    for (let index = 0; index <= FILE_SYSTEM_WATCH_FILTERED_BOUNDARY_LIMIT; index += 1) {
      batcher.markFilteredChangeBoundary(`repo-${index}/dist`);
    }

    vi.advanceTimersByTime(FS_WATCH_BATCH_WINDOW_MS);

    expect(batches).toEqual([[]]);
    expect(metadataBatches).toEqual([
      {
        filteredChangeBoundaries: Array.from(
          { length: FILE_SYSTEM_WATCH_FILTERED_BOUNDARY_LIMIT },
          (_, index) => `repo-${index}/dist`
        ),
        filteredChangeBoundariesOverflow: true,
      },
    ]);
    batcher.dispose();
  });

  it.each(['', '/dist', 'C:/dist', '../dist', 'packages//dist', 'packages\\dist'])(
    'rejects malformed filtered boundary %j instead of silently widening it',
    (boundary) => {
      const batcher = createFileSystemChangeBatcher(collect);
      expect(() => batcher.markFilteredChangeBoundary(boundary)).toThrow(
        /normalized root-relative path/u
      );
      batcher.dispose();
      expect(batches).toEqual([]);
    }
  );
});
