/**
 * Unit coverage for the read-before-write staleness tracker (report R8; core
 * 1.51 workspace `requireReadBeforeWrite` pattern, adopted compare-only).
 *
 * The tracker is pure in-memory state: it records the last mtime the assistant
 * OBSERVED for a file (via a content-bearing read or its own successful write),
 * keyed by scope (threadId) + canonical absolute path. The desktop edit tools
 * stat the file at write time and refuse when the recorded observation no
 * longer matches disk — the classic lost-update guard. The fs compare itself is
 * proved in assistant-tools.integration.test.ts; this spec pins the state
 * semantics (record/read-back, scope isolation, bounded size, reset).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FILE_READ_STATE_MAX_ENTRIES,
  forgetKnownFile,
  getKnownFileMtime,
  recordKnownFileMtime,
  resetFileReadState,
} from '../tools/file-read-state';

describe('file-read-state tracker', () => {
  beforeEach(() => {
    resetFileReadState();
  });

  it('returns undefined for a file never observed', () => {
    expect(getKnownFileMtime('thread-1', '/ws/a.ts')).toBeUndefined();
  });

  it('records and reads back the last observed mtime per scope+path', () => {
    recordKnownFileMtime('thread-1', '/ws/a.ts', 1000.5);
    expect(getKnownFileMtime('thread-1', '/ws/a.ts')).toBe(1000.5);

    // A newer observation replaces the old one.
    recordKnownFileMtime('thread-1', '/ws/a.ts', 2000);
    expect(getKnownFileMtime('thread-1', '/ws/a.ts')).toBe(2000);
  });

  it('isolates observations by scope (one thread never vouches for another)', () => {
    recordKnownFileMtime('thread-1', '/ws/a.ts', 1000);
    expect(getKnownFileMtime('thread-2', '/ws/a.ts')).toBeUndefined();
  });

  it('forgets a single file (delete/rename source cleanup)', () => {
    recordKnownFileMtime('thread-1', '/ws/a.ts', 1000);
    forgetKnownFile('thread-1', '/ws/a.ts');
    expect(getKnownFileMtime('thread-1', '/ws/a.ts')).toBeUndefined();
  });

  it('bounds total entries by evicting the oldest observation first', () => {
    for (let index = 0; index < FILE_READ_STATE_MAX_ENTRIES; index += 1) {
      recordKnownFileMtime('thread-1', `/ws/file-${index}.ts`, index);
    }
    expect(getKnownFileMtime('thread-1', '/ws/file-0.ts')).toBe(0);

    // One past the cap evicts the oldest entry, never grows unbounded.
    recordKnownFileMtime('thread-1', '/ws/overflow.ts', 9999);
    expect(getKnownFileMtime('thread-1', '/ws/overflow.ts')).toBe(9999);
    expect(getKnownFileMtime('thread-1', '/ws/file-0.ts')).toBeUndefined();
    expect(getKnownFileMtime('thread-1', '/ws/file-1.ts')).toBe(1);
  });

  it('re-recording an existing key refreshes its eviction slot (LRU on write)', () => {
    for (let index = 0; index < FILE_READ_STATE_MAX_ENTRIES; index += 1) {
      recordKnownFileMtime('thread-1', `/ws/file-${index}.ts`, index);
    }
    // Touch the oldest key again, then overflow: the SECOND-oldest is evicted.
    recordKnownFileMtime('thread-1', '/ws/file-0.ts', 42);
    recordKnownFileMtime('thread-1', '/ws/overflow.ts', 9999);
    expect(getKnownFileMtime('thread-1', '/ws/file-0.ts')).toBe(42);
    expect(getKnownFileMtime('thread-1', '/ws/file-1.ts')).toBeUndefined();
  });

  it('resets all state (test isolation seam)', () => {
    recordKnownFileMtime('thread-1', '/ws/a.ts', 1000);
    resetFileReadState();
    expect(getKnownFileMtime('thread-1', '/ws/a.ts')).toBeUndefined();
  });
});
