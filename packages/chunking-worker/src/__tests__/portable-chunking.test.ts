import { describe, expect, it } from 'vitest';
import { chunkContent } from '../portable-chunking';

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
