import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetHasherForTests, FileHasher } from '../file-hasher';

describe('FileHasher', () => {
  let hasher: FileHasher;

  beforeEach(() => {
    __resetHasherForTests();
    hasher = new FileHasher();
  });

  afterEach(() => {
    __resetHasherForTests();
  });

  describe('init', () => {
    it('initializes the hasher', async () => {
      expect(hasher.isReady()).toBe(false);
      await hasher.init();
      expect(hasher.isReady()).toBe(true);
    });

    it('can be initialized multiple times', async () => {
      await hasher.init();
      await hasher.init();
      expect(hasher.isReady()).toBe(true);
    });
  });

  describe('hashContent', () => {
    it('hashes content and returns a 16-character hex string', async () => {
      const hash = await hasher.hashContent('Hello, World!');
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('returns consistent hashes for same content', async () => {
      const hash1 = await hasher.hashContent('test content');
      const hash2 = await hasher.hashContent('test content');
      expect(hash1).toBe(hash2);
    });

    it('returns different hashes for different content', async () => {
      const hash1 = await hasher.hashContent('content A');
      const hash2 = await hasher.hashContent('content B');
      expect(hash1).not.toBe(hash2);
    });

    it('handles empty string', async () => {
      const hash = await hasher.hashContent('');
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('handles large content', async () => {
      const largeContent = 'x'.repeat(100_000);
      const hash = await hasher.hashContent(largeContent);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('handles unicode content', async () => {
      const hash = await hasher.hashContent('Hello, \u4e16\u754c! \ud83c\udf0d');
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe('hashContentStreaming', () => {
    async function* generateChunks(chunks: string[]): AsyncGenerator<string> {
      for (const chunk of chunks) {
        yield chunk;
      }
    }

    it('hashes streaming content', async () => {
      const chunks = ['Hello, ', 'World!'];
      const hash = await hasher.hashContentStreaming(generateChunks(chunks));
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('returns consistent hashes for same streaming content', async () => {
      const hash1 = await hasher.hashContentStreaming(generateChunks(['Hello', ', ', 'World!']));
      const hash2 = await hasher.hashContentStreaming(generateChunks(['Hello', ', ', 'World!']));
      expect(hash1).toBe(hash2);
    });

    it('returns same hash whether streamed or not', async () => {
      const content = 'Hello, World!';
      const regularHash = await hasher.hashContent(content);
      const streamingHash = await hasher.hashContentStreaming(generateChunks([content]));
      expect(regularHash).toBe(streamingHash);
    });

    it('handles empty stream', async () => {
      const hash = await hasher.hashContentStreaming(generateChunks([]));
      const emptyHash = await hasher.hashContent('');
      expect(hash).toBe(emptyHash);
    });
  });

  describe('shouldRevalidate', () => {
    it('returns true when size differs', () => {
      const cached = { mtimeMs: 1000, size: 100 };
      const current = { mtimeMs: 1000, size: 200 };
      expect(hasher.shouldRevalidate(cached, current)).toBe(true);
    });

    it('returns true when mtime differs', () => {
      const cached = { mtimeMs: 1000, size: 100 };
      const current = { mtimeMs: 2000, size: 100 };
      expect(hasher.shouldRevalidate(cached, current)).toBe(true);
    });

    it('returns false when size and mtime match', () => {
      const cached = { mtimeMs: 1000, size: 100 };
      const current = { mtimeMs: 1000, size: 100 };
      expect(hasher.shouldRevalidate(cached, current)).toBe(false);
    });

    it('returns false when size matches and no mtime', () => {
      const cached = { size: 100 };
      const current = { size: 100 };
      expect(hasher.shouldRevalidate(cached, current)).toBe(false);
    });

    it('returns false when size matches and only cached has mtime', () => {
      const cached = { mtimeMs: 1000, size: 100 };
      const current = { size: 100 };
      expect(hasher.shouldRevalidate(cached, current)).toBe(false);
    });

    it('returns false when size matches and only current has mtime', () => {
      const cached = { size: 100 };
      const current = { mtimeMs: 1000, size: 100 };
      expect(hasher.shouldRevalidate(cached, current)).toBe(false);
    });
  });

  describe('createCacheKey', () => {
    it('creates composite cache key', () => {
      const key = hasher.createCacheKey('folder-123', 'src/index.ts');
      expect(key).toBe('folder-123::src/index.ts');
    });

    it('handles special characters in path', () => {
      const key = hasher.createCacheKey('folder', 'path/with spaces/file.ts');
      expect(key).toBe('folder::path/with spaces/file.ts');
    });
  });

  describe('parseCacheKey', () => {
    it('parses composite cache key', () => {
      const result = hasher.parseCacheKey('folder-123::src/index.ts');
      expect(result).toEqual({
        filePath: 'src/index.ts',
        folderId: 'folder-123',
      });
    });

    it('returns null for invalid key', () => {
      const result = hasher.parseCacheKey('no-separator');
      expect(result).toBeNull();
    });

    it('handles multiple :: in path', () => {
      const result = hasher.parseCacheKey('folder::path::with::colons.ts');
      expect(result).toEqual({
        filePath: 'path::with::colons.ts',
        folderId: 'folder',
      });
    });
  });
});
