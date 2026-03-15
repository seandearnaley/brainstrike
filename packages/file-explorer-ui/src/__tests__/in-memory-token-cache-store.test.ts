/**
 * Tests for the InMemoryTokenCacheStore clearFolder logic.
 *
 * These tests exercise the `::` separator matching pattern used in
 * `clearFolder` (now delegated to `startsWithDoubleCharPrefix`) to verify
 * correctness of the optimization that replaced `startsWith(\`${folderId}::\`)`.
 *
 * @see packages/token-cache/src/__tests__/token-cache-store.test.ts for the
 *   DB-backed TokenCacheStore tests (those mock functions intentionally use
 *   the simpler `startsWith` pattern since test code is not a hot path).
 */

import { describe, expect, it, vi } from 'vitest';

// Mock heavy dependencies so importing token-cache-context.tsx doesn't fail
vi.mock('@brainstrike/preferences/stores/token-preferences-store', () => ({
  useTokenPreferencesStore: vi.fn(() => false),
  tokenPreferencesSelectors: { accurateCounting: {} },
}));

vi.mock('@brainstrike/token-cache/cache-runtime', () => ({
  createTokenCacheWorkerPool: vi.fn(),
  FileHasher: class {
    init = vi.fn().mockResolvedValue(undefined);
  },
  TokenCacheStore: class {},
  useTokenCache: vi.fn(() => ({})),
}));

vi.mock('../resolve-token-cache-worker-url', () => ({
  resolveTokenCacheWorkerUrlHref: vi.fn(() => 'file:///mock-worker.js'),
}));

import { InMemoryTokenCacheStore } from '../token-cache-context';

/** Helper to create a minimal TokenCacheEntry for testing */
function createEntry(folderId: string, filePath: string, tokenCount = 10) {
  return {
    folderId,
    filePath,
    contentHash: 'hash',
    fileSize: 100,
    mtimeMs: Date.now(),
    tokenCount,
    countingMode: 'heuristic' as const,
    modelEncoding: 'o200k_base',
  };
}

describe('InMemoryTokenCacheStore clearFolder (:: separator optimization)', () => {
  it('clears entries that start with folderId::', async () => {
    const store = new InMemoryTokenCacheStore();
    await store.set(createEntry('folder1', 'file-a.ts', 10));
    await store.set(createEntry('folder1', 'file-b.ts', 20));
    await store.set(createEntry('folder2', 'file-c.ts', 30));

    const removed = await store.clearFolder('folder1');
    expect(removed).toBe(2);

    const remaining = await store.getAllForFolder('folder2');
    expect(remaining.length).toBe(1);
    const folder1Entries = await store.getAllForFolder('folder1');
    expect(folder1Entries.length).toBe(0);
  });

  it('does NOT clear entries where folderId is a prefix of another folder ID', async () => {
    const store = new InMemoryTokenCacheStore();
    await store.set(createEntry('folder1', 'file-a.ts', 10));
    await store.set(createEntry('folder10', 'chunk.ts', 50));
    await store.set(createEntry('folder100', 'deep.ts', 60));

    const removed = await store.clearFolder('folder1');
    expect(removed).toBe(1);

    // folder10 and folder100 entries must survive
    const folder10 = await store.getAllForFolder('folder10');
    expect(folder10.length).toBe(1);
    const folder100 = await store.getAllForFolder('folder100');
    expect(folder100.length).toBe(1);
  });

  it('does NOT clear entries that have folderId but not followed by ::', async () => {
    const store = new InMemoryTokenCacheStore();
    await store.set(createEntry('alpha', 'x.ts', 10));
    await store.set(createEntry('alphabet', 'y.ts', 20));

    const removed = await store.clearFolder('alpha');
    expect(removed).toBe(1);

    // "alphabet::y.ts" must survive
    const alphabetEntries = await store.getAllForFolder('alphabet');
    expect(alphabetEntries.length).toBe(1);
  });

  it('returns 0 when no entries match the folderId', async () => {
    const store = new InMemoryTokenCacheStore();
    await store.set(createEntry('other-folder', 'file.ts', 10));

    const removed = await store.clearFolder('nonexistent');
    expect(removed).toBe(0);

    const remaining = await store.getAllForFolder('other-folder');
    expect(remaining.length).toBe(1);
  });

  it('returns correct count of removed entries', async () => {
    const store = new InMemoryTokenCacheStore();
    await store.set(createEntry('target', 'a.ts', 10));
    await store.set(createEntry('target', 'b.ts', 20));
    await store.set(createEntry('target', 'c.ts', 30));
    await store.set(createEntry('keep', 'z.ts', 40));

    const removed = await store.clearFolder('target');
    expect(removed).toBe(3);

    const remaining = await store.getAllForFolder('keep');
    expect(remaining.length).toBe(1);
  });

  it('handles empty store gracefully', async () => {
    const store = new InMemoryTokenCacheStore();
    const removed = await store.clearFolder('any-folder');
    expect(removed).toBe(0);
  });

  it('handles empty folderId correctly (does not match non-empty keys)', async () => {
    const store = new InMemoryTokenCacheStore();
    await store.set(createEntry('folder1', 'file.ts', 10));
    // An empty folderId would look for keys starting with "" followed by "::"
    await store.set(createEntry('', 'orphan.ts', 5));

    const removed = await store.clearFolder('');
    // Key '::orphan.ts' starts with '' followed by '::', so startsWithDoubleCharPrefix matches
    expect(removed).toBe(1);
    // 'folder1::file.ts' should survive
    const folder1Entries = await store.getAllForFolder('folder1');
    expect(folder1Entries.length).toBe(1);
  });

  it('handles folderId with special characters', async () => {
    const store = new InMemoryTokenCacheStore();
    const specialFolder = '/path/to/my folder (1)';
    await store.set(createEntry(specialFolder, 'file.ts', 10));
    await store.set(createEntry('other', 'file.ts', 20));

    const removed = await store.clearFolder(specialFolder);
    expect(removed).toBe(1);

    const remaining = await store.getAllForFolder('other');
    expect(remaining.length).toBe(1);
  });
});
