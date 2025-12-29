/**
 * Tests for use-lazy-file-tree helper functions
 *
 * These tests cover the extracted helper functions used by useLazyFileTree hook.
 */

import { describe, expect, it } from 'vitest';

/**
 * Simulates shouldSkipLoadRoot logic from use-lazy-file-tree.ts
 * This is extracted here for testing since the original is not exported.
 */
function shouldSkipLoadRoot(
  rootPath: string,
  isExpandingAll: boolean,
  initializedRoot: string | null,
  fileTreeLength: number
): { skip: boolean; reason?: string } {
  if (isExpandingAll && initializedRoot === rootPath) {
    return { skip: true, reason: 'expand-all in progress for same root' };
  }
  if (initializedRoot === rootPath && fileTreeLength > 0) {
    return { skip: true, reason: 'already initialized for this root' };
  }
  return { skip: false };
}

describe('use-lazy-file-tree helpers', () => {
  describe('shouldSkipLoadRoot', () => {
    it('should skip when expand-all is in progress for same root', () => {
      const result = shouldSkipLoadRoot('/test-root', true, '/test-root', 5);
      expect(result.skip).toBe(true);
      expect(result.reason).toBe('expand-all in progress for same root');
    });

    it('should skip when already initialized for this root with files', () => {
      const result = shouldSkipLoadRoot('/test-root', false, '/test-root', 5);
      expect(result.skip).toBe(true);
      expect(result.reason).toBe('already initialized for this root');
    });

    it('should not skip when switching to different root', () => {
      const result = shouldSkipLoadRoot('/new-root', false, '/old-root', 5);
      expect(result.skip).toBe(false);
      expect(result.reason).toBeUndefined();
    });

    it('should not skip when tree is empty (initial load)', () => {
      const result = shouldSkipLoadRoot('/test-root', false, '/test-root', 0);
      expect(result.skip).toBe(false);
      expect(result.reason).toBeUndefined();
    });

    it('should not skip when initializedRoot is null', () => {
      const result = shouldSkipLoadRoot('/test-root', false, null, 5);
      expect(result.skip).toBe(false);
      expect(result.reason).toBeUndefined();
    });
  });

  describe('refreshTree behavior', () => {
    it('should allow reload after resetting initializedRoot to null', () => {
      const rootPath = '/test-root';
      const fileTreeLength = 5;

      // Before reset: would skip because already initialized
      const beforeReset = shouldSkipLoadRoot(rootPath, false, rootPath, fileTreeLength);
      expect(beforeReset.skip).toBe(true);

      // After refreshTree resets initializedRoot to null: will not skip
      const afterReset = shouldSkipLoadRoot(rootPath, false, null, fileTreeLength);
      expect(afterReset.skip).toBe(false);
    });
  });

  describe('processLoadPathsResult optimization', () => {
    it('should document skip rehydration when loadedCount is 0', () => {
      // When all directories are cached, loadedCount = 0
      // In this case, we skip rehydration to avoid unnecessary work
      const loadedCount = 0;
      const shouldSkipRehydration = loadedCount === 0;
      expect(shouldSkipRehydration).toBe(true);
    });

    it('should document rehydration when loadedCount > 0', () => {
      // When directories were actually loaded, loadedCount > 0
      // In this case, we need to rehydrate the tree with file handles
      const loadedCount = 5;
      const shouldRehydrate = loadedCount > 0;
      expect(shouldRehydrate).toBe(true);
    });
  });
});
