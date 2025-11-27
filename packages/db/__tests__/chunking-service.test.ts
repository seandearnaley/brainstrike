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
      expect(result.strategyUsed).toBe('sentence');
    });
  });

  describe('skip heuristics coverage', () => {
    const lockAndArtifactCases = [
      ['npm lockfile', 'package-lock.json'],
      ['pnpm lockfile', 'pnpm-lock.yaml'],
      ['yarn lockfile', 'yarn.lock'],
      ['composer lockfile', 'composer.lock'],
      ['gemfile lockfile', 'Gemfile.lock'],
      ['pip lockfile', 'Pipfile.lock'],
      ['poetry lockfile', 'poetry.lock'],
      ['go sum file', 'go.sum'],
      ['cargo lockfile', 'Cargo.lock'],
      ['npm shrinkwrap', 'npm-shrinkwrap.json'],
      ['minified js', 'bundle.min.js'],
      ['source map', 'app.js.map'],
      ['wasm artifact', 'module.wasm'],
      ['binary artifact', 'payload.bin'],
      ['node_modules directory', 'packages/node_modules/acme/index.js'],
      ['dist directory', 'output/dist/app.js'],
      ['build directory', 'release/build/app.js'],
      ['coverage directory', 'reports/coverage/index.json'],
    ] as const;

    it.each(lockAndArtifactCases)('skips %s', async (_label, fileName) => {
      const result = await chunkingService.chunkContent('lock content', 'file-lock', {
        strategy: 'sentence',
        fileName,
      });

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('Lock file or dependency manifest');
      expect(result.chunks).toHaveLength(0);
      expect(result.strategyUsed).toBe('sentence');
    });

    it('skips binary-like content containing NUL bytes', async () => {
      const binaryLike = 'abc\u0000def';

      const result = await chunkingService.chunkContent(binaryLike, 'file-binary', {
        strategy: 'sentence',
        fileName: 'binary.dat',
      });

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('Binary content detected (NUL bytes present)');
      expect(result.strategyUsed).toBe('sentence');
    });

    it('skips highly repetitive generated content', async () => {
      const repetitive = 'SAME LINE\n'.repeat(2000);

      const result = await chunkingService.chunkContent(repetitive, 'file-repeat', {
        strategy: 'sentence',
        fileName: 'generated.txt',
      });

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('Highly repetitive content (likely generated file)');
      expect(result.strategyUsed).toBe('sentence');
    });
  });

  describe('chunkContent', () => {
    it('should skip chunking for files exceeding size limit', async () => {
      const largeContent = 'x'.repeat(CHUNKING_CONFIG.maxChunkableSize + 1);

      const result = await chunkingService.chunkContent(largeContent, 'file1', {
        strategy: 'sentence',
        fileName: 'test.txt',
      });

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('File too large');
      expect(result.chunks).toHaveLength(0);
      expect(result.strategyUsed).toBe('sentence');
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
      expect(result.strategyUsed).toBe('sentence');

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
      expect(result.strategyUsed).toBe('recursive');

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
      expect(result.strategyUsed).toBe('sentence');
    });

    it('applies TypeScript language defaults when no overrides are provided', async () => {
      const content = 'export const answer = 42;\n'.repeat(20);

      const result = await chunkingService.chunkContent(content, 'file-default', {
        strategy: 'recursive',
        fileName: 'default.ts',
      });

      expect(result.skipped).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0]?.chunkSize).toBe(
        CHUNKING_CONFIG.codeLanguageDefaults.typescript.maxTokens
      );
    });

    it('skips file-type recommendations when explicitly ignored', async () => {
      const content = 'export const answer = 42;\n'.repeat(20);

      const result = await chunkingService.chunkContent(content, 'file-ignore', {
        strategy: 'recursive',
        fileName: 'ignore.ts',
        ignoreFileTypeRecommendations: true,
      });

      expect(result.skipped).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0]?.chunkSize).toBe(CHUNKING_CONFIG.defaultMaxTokens);
    });

    it('applies language-specific defaults for Rust code', async () => {
      const content = 'fn main() { println!("hi"); }\n'.repeat(40);

      const result = await chunkingService.chunkContent(content, 'rust-file', {
        strategy: 'recursive',
        fileName: 'lib.rs',
      });

      expect(result.skipped).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0]?.chunkSize).toBe(CHUNKING_CONFIG.codeLanguageDefaults.rust.maxTokens);
    });

    it('respects custom chunk size for code files above defaults', async () => {
      const content = 'export const answer = 42;\n'.repeat(200);

      const result = await chunkingService.chunkContent(content, 'file1', {
        strategy: 'recursive',
        fileName: 'custom.ts',
        maxTokens: 800,
        overlap: 120,
      });

      expect(result.skipped).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0]?.chunkSize).toBe(800);
    });

    it('clamps chunk size to safety cap for extreme inputs', async () => {
      const content = Array.from(
        { length: 1000 },
        (_, i) => `function x${i}() { return ${i}; }`
      ).join('\n');

      const result = await chunkingService.chunkContent(content, 'file1', {
        strategy: 'recursive',
        fileName: 'extreme.ts',
        maxTokens: 99999,
        overlap: 9999,
      });

      expect(result.skipped).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0]?.chunkSize).toBe(CHUNKING_CONFIG.maxTokensSafetyCap);
    });

    it('applies custom token caps when provided by the caller', async () => {
      const content = Array.from({ length: 200 }, () => 'console.log("chunk");').join('\n');

      const result = await chunkingService.chunkContent(content, 'file-custom-cap', {
        strategy: 'sentence',
        maxTokens: 6000,
        maxTokensCap: 2048,
      });

      expect(result.skipped).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0]?.chunkSize).toBe(2048);
    });

    it('honors explicit sentence strategy for code files when forced', async () => {
      const content = 'export const answer = 42;\n'.repeat(10);

      const result = await chunkingService.chunkContent(content, 'file1', {
        strategy: 'sentence',
        fileName: 'force.ts',
        forceStrategy: true,
      });

      expect(result.skipped).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.strategyUsed).toBe('sentence');
      expect(result.chunks[0]?.chunkType).toBe('sentence');
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
      expect(result.strategyUsed).toBe('token');

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

    it('keeps TypeScript functions intact using AST-aware chunking', async () => {
      const tsContent = `function alpha() {\n${'const x = 1;\n'.repeat(150)}}\n\nfunction beta() {\n${'const y = 2;\n'.repeat(
        150
      )}}\n`;

      const result = await chunkingService.chunkContent(tsContent, 'ts-ast', {
        strategy: 'recursive',
        fileName: 'ast-sample.ts',
      });

      expect(result.strategyUsed).toBe('recursive');
      const chunkTexts = result.chunks.map((c) => c.content);
      const alphaChunk = chunkTexts.find((c) => c.includes('alpha'));
      const betaChunk = chunkTexts.find((c) => c.includes('beta'));

      expect(alphaChunk).toBeTruthy();
      expect(betaChunk).toBeTruthy();
    });

    it('falls back to token strategy for unsupported code languages', async () => {
      const codeContent = 'module Main exposing (.. )\nmain =\n    Debug.log "hi" 42';

      const result = await chunkingService.chunkContent(codeContent, 'elm-file', {
        strategy: 'recursive',
        fileName: 'Main.elm',
      });

      expect(result.strategyUsed).toBe('token');
      expect(result.chunks[0]?.chunkType).toBe('text');
    });

    it('recovers when AST parsing fails and still chunks content', async () => {
      const malformed = 'function () { return ;';

      const result = await chunkingService.chunkContent(malformed, 'bad-js', {
        strategy: 'recursive',
        fileName: 'broken.js',
      });

      expect(result.skipped).toBeUndefined();
      expect(result.chunks.length).toBeGreaterThan(0);
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

  describe('chunk parameter adjustments', () => {
    const invokeAdjust = (service: ChunkingService, content: string, options: ChunkingOptions) =>
      (
        service as unknown as {
          adjustChunkingForFileType: (
            content: string,
            options: ChunkingOptions
          ) => { maxTokens: number; overlap: number };
        }
      ).adjustChunkingForFileType.call(service, content, options);

    it('honors explicit chunk sizes for code files within safety limits', () => {
      const { maxTokens, overlap } = invokeAdjust(chunkingService, 'function foo() {}', {
        strategy: 'sentence',
        fileName: 'foo.ts',
        maxTokens: 1024,
        overlap: 128,
      });

      expect(maxTokens).toBe(1024);
      expect(overlap).toBe(128);
    });

    it('caps explicit chunk sizes at configured safety limits', () => {
      const { maxTokens, overlap } = invokeAdjust(chunkingService, 'function foo() {}', {
        strategy: 'sentence',
        fileName: 'foo.ts',
        maxTokens: 10000,
        overlap: 5000,
      });

      expect(maxTokens).toBe(CHUNKING_CONFIG.maxTokensHardLimit);
      expect(overlap).toBeLessThanOrEqual(CHUNKING_CONFIG.overlapHardLimit);
      expect(overlap).toBe(CHUNKING_CONFIG.overlapHardLimit);
    });

    it('applies code defaults when caller does not override', () => {
      const { maxTokens, overlap } = invokeAdjust(chunkingService, 'function foo() {}', {
        strategy: 'sentence',
        fileName: 'foo.tsx',
      });

      expect(maxTokens).toBe(CHUNKING_CONFIG.codeLanguageDefaults.typescript.maxTokens);
      expect(overlap).toBe(CHUNKING_CONFIG.codeLanguageDefaults.typescript.overlap);
    });
  });
});
