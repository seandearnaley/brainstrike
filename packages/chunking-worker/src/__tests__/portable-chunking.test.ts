import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNKING_CONFIG } from '../chunking-config';
import { chunkContent } from '../portable-chunking';

afterEach(() => {
  vi.doUnmock('@babel/parser');
  vi.doUnmock('../token-utils-lite');
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('portable-chunking', () => {
  describe('chunkContent', () => {
    describe('skip patterns', () => {
      it('should skip package-lock.json files', async () => {
        const result = await chunkContent('{"name": "test"}', {
          strategy: 'sentence',
          fileName: 'package-lock.json',
        });

        expect(result.skipped).toBe(true);
        expect(result.skipReason).toContain('Lock file');
        expect(result.chunks).toHaveLength(0);
      });

      it('should skip pnpm-lock.yaml files', async () => {
        const result = await chunkContent('lockfile: true', {
          strategy: 'sentence',
          fileName: 'pnpm-lock.yaml',
        });

        expect(result.skipped).toBe(true);
        expect(result.chunks).toHaveLength(0);
      });

      it('should skip node_modules paths', async () => {
        const result = await chunkContent('const x = 1;', {
          strategy: 'sentence',
          filePath: '/project/node_modules/foo/index.js',
        });

        expect(result.skipped).toBe(true);
      });

      it('should skip minified files', async () => {
        const result = await chunkContent('function a(){return 1}', {
          strategy: 'sentence',
          fileName: 'bundle.min.js',
        });

        expect(result.skipped).toBe(true);
      });

      it('should skip binary/wasm files', async () => {
        const result = await chunkContent('binary content', {
          strategy: 'sentence',
          fileName: 'module.wasm',
        });

        expect(result.skipped).toBe(true);
      });

      it('should skip content with NUL bytes', async () => {
        const result = await chunkContent('hello\u0000world', {
          strategy: 'sentence',
          fileName: 'mystery.dat',
        });

        expect(result.skipped).toBe(true);
        expect(result.skipReason).toContain('Binary content');
      });

      it('should skip files over the max chunkable size when large files are not allowed', async () => {
        const oversized = 'x'.repeat(CHUNKING_CONFIG.maxChunkableSize + 1);

        const result = await chunkContent(oversized, {
          strategy: 'sentence',
          fileName: 'oversized.txt',
        });

        expect(result.skipped).toBe(true);
        expect(result.skipReason).toContain('File too large');
      });

      it('should skip highly repetitive generated content', async () => {
        const repetitive = `${'same-line\n'.repeat(1001)}unique-tail`;

        const result = await chunkContent(repetitive, {
          strategy: 'sentence',
          fileName: 'generated.log',
          allowLargeFiles: true,
        });

        expect(result.skipped).toBe(true);
        expect(result.skipReason).toContain('Highly repetitive content');
      });
    });

    describe('sentence strategy', () => {
      it('should chunk text into sentences', async () => {
        const text =
          'This is the first sentence. This is the second sentence. And this is the third one.';
        const result = await chunkContent(text, {
          strategy: 'sentence',
          fileName: 'readme.md',
        });

        expect(result.skipped).toBe(false);
        expect(result.strategyUsed).toBe('sentence');
        expect(result.chunks.length).toBeGreaterThan(0);
        expect(result.totalTokens).toBeGreaterThan(0);
      });

      it('should include chunk metadata', async () => {
        const text = 'Hello world. This is a test.';
        const result = await chunkContent(text, {
          strategy: 'sentence',
          fileName: 'test.txt',
        });

        expect(result.chunks[0]).toMatchObject({
          chunkIndex: 0,
          content: expect.any(String),
          contentHash: expect.any(String),
          tokenCount: expect.any(Number),
          chunkType: expect.stringMatching(/^(text|sentence|recursive)$/),
          chunkSize: expect.any(Number),
        });
      });

      it('should split punctuation-poor text to the configured chunk target', async () => {
        const text = 'x'.repeat(5000);
        const result = await chunkContent(text, {
          strategy: 'sentence',
          fileName: 'plain.txt',
        });

        expect(result.chunks.length).toBeGreaterThan(1);
        for (const chunk of result.chunks) {
          expect(chunk.content.length).toBeLessThanOrEqual(2000);
        }
      });
    });

    describe('recursive strategy', () => {
      it('should chunk code using recursive character splitting', async () => {
        const code = `
function foo() {
  return 1;
}

function bar() {
  return 2;
}

function baz() {
  return foo() + bar();
}
`.trim();

        const result = await chunkContent(code, {
          strategy: 'recursive',
          fileName: 'code.ts',
        });

        expect(result.skipped).toBe(false);
        expect(result.strategyUsed).toBe('recursive');
        expect(result.chunks.length).toBeGreaterThan(0);
      });

      it('should honor forceStrategy for markdown and keep recursive strategy', async () => {
        const markdown = '# Header\n\nParagraph one.\n\nParagraph two.';

        const result = await chunkContent(markdown, {
          strategy: 'recursive',
          fileName: 'notes.md',
          forceStrategy: true,
        });

        expect(result.skipped).toBe(false);
        expect(result.strategyUsed).toBe('recursive');
      });
    });

    describe('token strategy', () => {
      it('should split long content into multiple chunks', async () => {
        const longText = 'word '.repeat(2000); // ~2000 words

        const result = await chunkContent(longText, {
          strategy: 'token',
          fileName: 'long.txt',
        });

        expect(result.skipped).toBe(false);
        expect(result.strategyUsed).toBe('token');
        expect(result.chunks.length).toBeGreaterThan(1);
        expect(result.totalTokens).toBeGreaterThan(0);

        // Verify chunks have proper structure
        for (const chunk of result.chunks) {
          expect(chunk.tokenCount).toBeGreaterThan(0);
          expect(chunk.content.length).toBeGreaterThan(0);
        }
      });

      it('should apply default recommendations for structured files', async () => {
        const json = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ i })) });
        const result = await chunkContent(json, {
          strategy: 'auto',
          fileName: 'dataset.json',
        });

        expect(result.skipped).toBe(false);
        expect(result.strategyUsed).toBe('json');
        expect(result.chunks[0]?.chunkSize).toBe(CHUNKING_CONFIG.largeStructuredMaxTokens);
      });

      it('should route non-legacy auto strategies through the canonical resolver', async () => {
        const docsResult = await chunkContent('= Guide\n\nSection body.', {
          strategy: 'auto',
          fileName: 'guide.adoc',
        });
        const dataResult = await chunkContent('{"rows":[{"id":1},{"id":2}]}', {
          strategy: 'auto',
          fileName: 'records.jsonl',
        });
        const svgResult = await chunkContent('<svg><text>Hello</text></svg>', {
          strategy: 'auto',
          fileName: 'diagram.svg',
        });

        expect(docsResult.strategyUsed).toBe('semantic-markdown');
        expect(dataResult.strategyUsed).toBe('json');
        expect(svgResult.strategyUsed).toBe('html');
      });

      it('should honor ignoreFileTypeRecommendations and use configured maxTokens', async () => {
        const json = JSON.stringify({ rows: Array.from({ length: 600 }, (_, i) => ({ i })) });
        const explicitMaxTokens = 320;
        const result = await chunkContent(json, {
          strategy: 'sentence',
          fileName: 'dataset.json',
          ignoreFileTypeRecommendations: true,
          maxTokens: explicitMaxTokens,
          overlap: 40,
        });

        expect(result.skipped).toBe(false);
        expect(result.chunks[0]?.chunkSize).toBe(explicitMaxTokens);
      });

      it('should sanitize invalid maxTokensCap values to the safety cap', async () => {
        const result = await chunkContent('word '.repeat(1000), {
          strategy: 'token',
          fileName: 'sanity.txt',
          maxTokens: 6000,
          maxTokensCap: Number.NaN,
        });

        expect(result.skipped).toBe(false);
        expect(result.chunks[0]?.chunkSize).toBe(CHUNKING_CONFIG.maxTokensSafetyCap);
      });
    });

    describe('small content handling', () => {
      it('should create single chunk for small content', async () => {
        const result = await chunkContent('Small content.', {
          strategy: 'sentence',
          fileName: 'small.txt',
        });

        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0]?.content).toBe('Small content.');
      });
    });

    describe('content hashing', () => {
      it('should generate consistent hashes for same content', async () => {
        const content = 'Test content for hashing.';

        const result1 = await chunkContent(content, {
          strategy: 'sentence',
          fileName: 'test1.txt',
        });
        const result2 = await chunkContent(content, {
          strategy: 'sentence',
          fileName: 'test2.txt',
        });

        expect(result1.chunks[0]?.contentHash).toBe(result2.chunks[0]?.contentHash);
      });

      it('should generate different hashes for different content', async () => {
        const result1 = await chunkContent('Content A', {
          strategy: 'sentence',
          fileName: 'a.txt',
        });
        const result2 = await chunkContent('Content B', {
          strategy: 'sentence',
          fileName: 'b.txt',
        });

        expect(result1.chunks[0]?.contentHash).not.toBe(result2.chunks[0]?.contentHash);
      });
    });

    describe('code language detection', () => {
      it('should detect TypeScript files', async () => {
        const tsCode = 'const x: number = 1;';
        const result = await chunkContent(tsCode, {
          strategy: 'recursive',
          fileName: 'code.ts',
        });

        expect(result.skipped).toBe(false);
        expect(result.chunks.length).toBeGreaterThan(0);
      });

      it('should detect JavaScript files', async () => {
        const jsCode = 'const x = 1;';
        const result = await chunkContent(jsCode, {
          strategy: 'recursive',
          fileName: 'code.js',
        });

        expect(result.skipped).toBe(false);
      });

      it('should handle Python files', async () => {
        const pyCode = 'def hello():\n    print("world")';
        const result = await chunkContent(pyCode, {
          strategy: 'recursive',
          fileName: 'code.py',
        });

        expect(result.skipped).toBe(false);
      });
    });
  });
});
