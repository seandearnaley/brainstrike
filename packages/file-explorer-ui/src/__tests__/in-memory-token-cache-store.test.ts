/**
 * Tests for the InMemoryTokenCacheStore clearFolder logic.
 *
 * InMemoryTokenCacheStore is a private class inside token-cache-context.tsx.
 * These tests exercise the `::` separator matching pattern used in
 * `clearFolder` (now delegated to `startsWithDoubleCharPrefix`) to verify
 * correctness of the optimization that replaced `startsWith(\`${folderId}::\`)`.
 *
 * NOTE: Because InMemoryTokenCacheStore is not exported, this test file
 * replicates the clearFolder logic in a standalone function rather than
 * testing the actual class directly. If the class is ever extracted or
 * exported, these tests should be updated to use the real implementation.
 *
 * @see packages/token-cache/src/__tests__/token-cache-store.test.ts for the
 *   DB-backed TokenCacheStore tests (those mock functions intentionally use
 *   the simpler `startsWith` pattern since test code is not a hot path).
 */

import { startsWithDoubleCharPrefix } from '@brainstrike/utils/string-prefix';
import { describe, expect, it } from 'vitest';

/**
 * Portable replica of InMemoryTokenCacheStore.clearFolder logic.
 * Uses the same `startsWithDoubleCharPrefix` helper as token-cache-context.tsx.
 */
function clearFolder(entries: Map<string, unknown>, folderId: string): number {
  let removed = 0;
  for (const key of entries.keys()) {
    if (startsWithDoubleCharPrefix(key, folderId, '::')) {
      entries.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/** Helper: builds a key in the same format as InMemoryTokenCacheStore.createKey */
function createKey(folderId: string, filePath: string): string {
  return `${folderId}::${filePath}`;
}

describe('InMemoryTokenCacheStore clearFolder (:: separator optimization)', () => {
  it('clears entries that start with folderId::', () => {
    const entries = new Map<string, unknown>();
    entries.set(createKey('folder1', 'file-a.ts'), { tokenCount: 10 });
    entries.set(createKey('folder1', 'file-b.ts'), { tokenCount: 20 });
    entries.set(createKey('folder2', 'file-c.ts'), { tokenCount: 30 });

    const removed = clearFolder(entries, 'folder1');
    expect(removed).toBe(2);
    expect(entries.size).toBe(1);
    expect(entries.has(createKey('folder2', 'file-c.ts'))).toBe(true);
  });

  it('does NOT clear entries where folderId is a prefix of another folder ID', () => {
    const entries = new Map<string, unknown>();
    entries.set(createKey('folder1', 'file-a.ts'), { tokenCount: 10 });
    entries.set(createKey('folder10', 'chunk.ts'), { tokenCount: 50 });
    entries.set(createKey('folder100', 'deep.ts'), { tokenCount: 60 });

    const removed = clearFolder(entries, 'folder1');
    expect(removed).toBe(1);

    // folder10 and folder100 entries must survive
    expect(entries.has(createKey('folder10', 'chunk.ts'))).toBe(true);
    expect(entries.has(createKey('folder100', 'deep.ts'))).toBe(true);
  });

  it('does NOT clear entries that have folderId but not followed by ::', () => {
    const entries = new Map<string, unknown>();
    entries.set(createKey('alpha', 'x.ts'), { tokenCount: 10 });
    entries.set(createKey('alphabet', 'y.ts'), { tokenCount: 20 });

    const removed = clearFolder(entries, 'alpha');
    expect(removed).toBe(1);

    // "alphabet::y.ts" must survive
    expect(entries.has(createKey('alphabet', 'y.ts'))).toBe(true);
  });

  it('returns 0 when no entries match the folderId', () => {
    const entries = new Map<string, unknown>();
    entries.set(createKey('other-folder', 'file.ts'), { tokenCount: 10 });

    const removed = clearFolder(entries, 'nonexistent');
    expect(removed).toBe(0);
    expect(entries.size).toBe(1);
  });

  it('returns correct count of removed entries', () => {
    const entries = new Map<string, unknown>();
    entries.set(createKey('target', 'a.ts'), { tokenCount: 10 });
    entries.set(createKey('target', 'b.ts'), { tokenCount: 20 });
    entries.set(createKey('target', 'c.ts'), { tokenCount: 30 });
    entries.set(createKey('keep', 'z.ts'), { tokenCount: 40 });

    const removed = clearFolder(entries, 'target');
    expect(removed).toBe(3);
    expect(entries.size).toBe(1);
    expect(entries.has(createKey('keep', 'z.ts'))).toBe(true);
  });

  it('handles empty map gracefully', () => {
    const entries = new Map<string, unknown>();
    const removed = clearFolder(entries, 'any-folder');
    expect(removed).toBe(0);
  });

  it('handles empty folderId correctly (does not match non-empty keys)', () => {
    const entries = new Map<string, unknown>();
    entries.set(createKey('folder1', 'file.ts'), { tokenCount: 10 });
    // An empty folderId would look for keys starting with "" followed by "::"
    // createKey('', 'file.ts') === '::file.ts' which starts with '' and has :: at index 0
    entries.set(createKey('', 'orphan.ts'), { tokenCount: 5 });

    const removed = clearFolder(entries, '');
    // Key '::orphan.ts' starts with '' followed by '::', so startsWithDoubleCharPrefix matches
    expect(removed).toBe(1);
    // 'folder1::file.ts' should survive
    expect(entries.has(createKey('folder1', 'file.ts'))).toBe(true);
  });

  it('does not match key that equals folderId without :: suffix', () => {
    const entries = new Map<string, unknown>();
    // Manually create a key that is exactly the folderId (no :: separator)
    entries.set('folder1', { tokenCount: 10 });
    entries.set(createKey('folder1', 'file.ts'), { tokenCount: 20 });

    const removed = clearFolder(entries, 'folder1');
    // Only the properly keyed entry should be removed, not the bare folderId
    expect(removed).toBe(1);
    expect(entries.has('folder1')).toBe(true);
  });

  it('handles key with single colon (not double) after folderId', () => {
    const entries = new Map<string, unknown>();
    // Key with single colon: 'folder1:file.ts'
    entries.set('folder1:file.ts', { tokenCount: 10 });
    entries.set(createKey('folder1', 'file.ts'), { tokenCount: 20 });

    const removed = clearFolder(entries, 'folder1');
    // Only the double-colon keyed entry should be removed
    expect(removed).toBe(1);
    expect(entries.has('folder1:file.ts')).toBe(true);
  });

  it('handles folderId with special characters', () => {
    const entries = new Map<string, unknown>();
    const specialFolder = '/path/to/my folder (1)';
    entries.set(createKey(specialFolder, 'file.ts'), { tokenCount: 10 });
    entries.set(createKey('other', 'file.ts'), { tokenCount: 20 });

    const removed = clearFolder(entries, specialFolder);
    expect(removed).toBe(1);
    expect(entries.has(createKey('other', 'file.ts'))).toBe(true);
  });
});
