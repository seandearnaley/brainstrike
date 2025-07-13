import { beforeEach, describe, expect, it } from 'vitest';
import { CHUNKING_CONFIG } from '../src/config/chunking-config.js';
import type { ChunkingOptions } from '../src/services/chunking-service.js';
import { ChunkingService } from '../src/services/chunking-service.js';

describe('ChunkingService', () => {
  let chunkingService: ChunkingService;

  beforeEach(() => {
    chunkingService = new ChunkingService();
  });

  describe('chunkContent', () => {
    it('should throw error for missing content', async () => {
      await expect(
        chunkingService.chunkContent('', 'file1', { strategy: 'sentence' })
      ).rejects.toThrow('Content and fileRecordId are required for chunking');
    });

    it('should throw error for missing fileRecordId', async () => {
      await expect(
        chunkingService.chunkContent('some content', '', { strategy: 'sentence' })
      ).rejects.toThrow('Content and fileRecordId are required for chunking');
    });

    it('should skip chunking for files matching skip patterns', async () => {
      const result = await chunkingService.chunkContent('some content', 'file1', {
        strategy: 'sentence',
        fileName: 'package-lock.json',
      });

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('Lock file');
      expect(result.chunks).toHaveLength(0);
    });

    it('should skip chunking for files exceeding size limit', async () => {
      const largeContent = 'x'.repeat(CHUNKING_CONFIG.maxChunkableSize + 1);

      const result = await chunkingService.chunkContent(largeContent, 'file1', {
        strategy: 'sentence',
        fileName: 'test.txt',
      });

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('File too large');
      expect(result.chunks).toHaveLength(0);
    });

    it('should successfully chunk small text content using sentence strategy', async () => {
      const content =
        'This is the first sentence. This is the second sentence. This is the third sentence.';

      const result = await chunkingService.chunkContent(content, 'file1', {
        strategy: 'sentence',
        fileName: 'test.txt',
      });

      expect(result.skipped).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.avgTokensPerChunk).toBeGreaterThan(0);

      // Check chunk structure
      const firstChunk = result.chunks[0];
      expect(firstChunk).toHaveProperty('id');
      expect(firstChunk).toHaveProperty('fileRecordId', 'file1');
      expect(firstChunk).toHaveProperty('chunkIndex', 0);
      expect(firstChunk).toHaveProperty('content');
      expect(firstChunk).toHaveProperty('tokenCount');
      expect(firstChunk).toHaveProperty('contentHash');
      expect(firstChunk).toHaveProperty('chunkType', 'sentence');
      expect(firstChunk).toHaveProperty('chunkSize');
      expect(firstChunk).toHaveProperty('createdAt');
      expect(firstChunk).toHaveProperty('updatedAt');
    });

    it('should successfully chunk code content using recursive strategy', async () => {
      const codeContent = `
function example() {
  const data = {
    name: 'test',
    value: 42
  };
  
  if (data.value > 0) {
    console.log('Positive value');
  }
  
  return data;
}

class TestClass {
  constructor(value) {
    this.value = value;
  }
  
  getValue() {
    return this.value;
  }
}
`;

      const result = await chunkingService.chunkContent(codeContent, 'file1', {
        strategy: 'recursive',
        fileName: 'test.js',
      });

      expect(result.skipped).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);

      // Check that chunks have recursive-specific properties
      const firstChunk = result.chunks[0];
      expect(firstChunk.chunkType).toBe('recursive');
    });

    it('should use custom chunking options when provided', async () => {
      const content = 'A short piece of text for testing.';
      const customOptions: ChunkingOptions = {
        strategy: 'sentence',
        maxTokens: 10,
        overlap: 2,
        fileName: 'test.txt',
      };

      const result = await chunkingService.chunkContent(content, 'file1', customOptions);

      expect(result.skipped).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);
    });

    it('should handle token strategy', async () => {
      const content =
        'This is a test document that should be split into token-based chunks for processing.';

      const result = await chunkingService.chunkContent(content, 'file1', {
        strategy: 'token',
        fileName: 'test.txt',
      });

      expect(result.skipped).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);

      const firstChunk = result.chunks[0];
      expect(firstChunk.chunkType).toBe('text'); // Token strategy produces text chunks
    });

    it('should adjust chunk parameters for large structured files', async () => {
      const content = 'SELECT * FROM users WHERE active = true;';

      const result = await chunkingService.chunkContent(content, 'file1', {
        strategy: 'sentence',
        fileName: 'query.sql',
      });

      expect(result.skipped).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);
    });

    it('should handle very large content by adjusting chunk parameters', async () => {
      // Create content just over the very large threshold
      const content = 'This is a test. '.repeat(
        Math.ceil(CHUNKING_CONFIG.veryLargeContentThreshold / 16) + 1
      );

      const result = await chunkingService.chunkContent(content, 'file1', {
        strategy: 'sentence',
        fileName: 'large.txt',
      });

      expect(result.skipped).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);
    });

    it('should generate unique content hashes for different content', async () => {
      const content1 = 'This is the first piece of content.';
      const content2 = 'This is the second piece of content.';

      const result1 = await chunkingService.chunkContent(content1, 'file1', {
        strategy: 'sentence',
        fileName: 'test1.txt',
      });

      const result2 = await chunkingService.chunkContent(content2, 'file2', {
        strategy: 'sentence',
        fileName: 'test2.txt',
      });

      expect(result1.chunks[0].contentHash).not.toBe(result2.chunks[0].contentHash);
    });

    it('should generate consistent content hashes for same content', async () => {
      const content = 'This is consistent content.';

      const result1 = await chunkingService.chunkContent(content, 'file1', {
        strategy: 'sentence',
        fileName: 'test.txt',
      });

      const result2 = await chunkingService.chunkContent(content, 'file2', {
        strategy: 'sentence',
        fileName: 'test.txt',
      });

      expect(result1.chunks[0].contentHash).toBe(result2.chunks[0].contentHash);
    });

    it('should handle empty content after splitting', async () => {
      const content = '\n\n\n   \n\n\n'; // Only whitespace

      const result = await chunkingService.chunkContent(content, 'file1', {
        strategy: 'sentence',
        fileName: 'empty.txt',
      });

      // Should not skip entirely but may result in no chunks due to empty content
      expect(result.chunks).toHaveLength(0);
      expect(result.totalTokens).toBe(0);
    });

    it('should use default strategy when none provided', async () => {
      const content = 'This is a test document.';

      const result = await chunkingService.chunkContent(
        content,
        'file1'
        // No options provided, should use default { strategy: 'sentence' }
      );

      expect(result.skipped).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);
    });

    it('should handle JavaScript code files appropriately', async () => {
      const codeContent = 'function test() { return true; }';

      // ChunkingService doesn't infer strategy from extension - that's done by the caller
      // So we explicitly specify the strategy that would be used for JS files
      const result = await chunkingService.chunkContent(codeContent, 'file1', {
        strategy: 'recursive',
        fileName: 'test.js',
      });

      expect(result.skipped).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0].chunkType).toBe('recursive');
    });

    it('should handle unsupported strategy gracefully', async () => {
      // Test with an invalid strategy (TypeScript won't catch this in tests due to any casting)
      await expect(
        chunkingService.chunkContent('test content', 'file1', {
          // biome-ignore lint/suspicious/noExplicitAny: Intentionally testing invalid strategy
          strategy: 'invalid' as any,
          fileName: 'test.txt',
        })
      ).rejects.toThrow('Unsupported chunking strategy');
    });
  });

  describe('dispose', () => {
    it('should dispose without errors', async () => {
      await expect(chunkingService.dispose()).resolves.not.toThrow();
    });
  });
});
