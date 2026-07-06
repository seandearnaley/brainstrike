import {
  splitByBlankLines,
  splitMarkdownIntoBlocks,
} from '@brainstrike/text-splitter/chunking-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNKING_CONFIG } from '../chunking-config';
import { chunkContent } from '../portable-chunking';

afterEach(() => {
  vi.doUnmock('@babel/parser');
  vi.doUnmock('@brainstrike/text-splitter');
  vi.doUnmock('../token-utils-lite');
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('portable-chunking', () => {
  describe('shared markdown helpers', () => {
    it('treats trim-whitespace-only lines as blank separators', () => {
      const parts = splitByBlankLines('alpha\n\u00A0\nbeta\n\f\n\v\ngamma');

      expect(parts).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('preserves lone carriage returns at EOF when scanning lines', () => {
      expect(splitByBlankLines('alpha\r')).toEqual(['alpha\r']);
      expect(splitMarkdownIntoBlocks('paragraph\r')).toEqual([{ meta: {}, text: 'paragraph\r' }]);
    });
  });

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

      it('should skip zero-byte files explicitly', async () => {
        const result = await chunkContent('', {
          strategy: 'recursive',
          fileName: 'empty.ts',
          tokenTrueSizing: true,
        });

        expect(result.skipped).toBe(true);
        expect(result.skipReason).toBe('Empty file content');
        expect(result.chunks).toHaveLength(0);
        expect(result.totalTokens).toBe(0);
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

      it('should include source line and character ranges for chunks', async () => {
        const text = 'line one\nline two\nline three';
        const result = await chunkContent(text, {
          strategy: 'sentence',
          fileName: 'test.txt',
        });

        expect(result.chunks[0]).toMatchObject({
          startLine: 1,
          endLine: 3,
          startOffset: 0,
          endOffset: text.length,
        });
      });

      it('advances source ranges for repeated identical chunk contents', async () => {
        const repeated = 'Alpha sentence.\n\nAlpha sentence.\n\nAlpha sentence.';
        const result = await chunkContent(repeated, {
          strategy: 'markdown',
          fileName: 'notes.md',
          maxTokens: 8,
          overlap: 0,
        });

        expect(result.chunks).toHaveLength(3);
        expect(result.chunks.map((chunk) => chunk.content)).toEqual([
          'Alpha sentence.',
          'Alpha sentence.',
          'Alpha sentence.',
        ]);
        expect(result.chunks.map((chunk) => chunk.startLine)).toEqual([1, 3, 5]);
        expect(result.chunks.map((chunk) => chunk.startOffset)).toEqual([0, 17, 34]);
      });

      it('resolves source ranges for markdown chunks emitted from CRLF content without warning', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const text = '# Title\r\n\r\nAlpha sentence\r\ncontinues here.\r\n\r\nBeta sentence.';
        const result = await chunkContent(text, {
          strategy: 'markdown',
          fileName: 'notes.md',
          maxTokens: 16,
          overlap: 0,
        });

        expect(result.chunks.map((chunk) => chunk.content)).toEqual([
          '# Title',
          'Alpha sentence\ncontinues here.',
          'Beta sentence.',
        ]);
        expect(result.chunks.map((chunk) => chunk.startLine)).toEqual([1, 3, 6]);
        expect(result.chunks.map((chunk) => chunk.endLine)).toEqual([1, 4, 6]);
        expect(result.chunks.map((chunk) => chunk.startOffset)).toEqual([0, 11, 46]);
        expect(result.chunks.map((chunk) => chunk.endOffset)).toEqual([7, 42, 60]);
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('resolves source ranges for semantic markdown chunks merged across sections', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const text =
          '# Title\n\nIntro paragraph.\n\n## A\n\nAlpha paragraph.\n\n## B\n\nBeta paragraph.';
        const result = await chunkContent(text, {
          strategy: 'auto',
          fileName: 'notes.md',
          maxTokens: 64,
          overlap: 0,
        });

        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0]?.content).toBe(
          '# Title\n\nIntro paragraph.## A\n\nAlpha paragraph.## B\n\nBeta paragraph.'
        );
        expect(result.chunks[0]).toMatchObject({
          startLine: 1,
          endLine: 11,
          startOffset: 0,
          endOffset: text.length,
        });
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('resolves whitespace-normalized ranges beyond the first-character candidate ceiling', async () => {
        vi.resetModules();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const prefix = Array.from(
          { length: 12_050 },
          (_, index) => `Alpha filler ${index} keeps the prefix unique.`
        ).join('\n');
        const target = 'Alpha target line\r\ncontinues with mixed newlines.';
        const text = `${prefix}\r\n\r\n${target}\r\n\r\nBeta tail.`;
        const startOffset = text.indexOf('Alpha target line');
        const endOffset = startOffset + target.length;
        vi.doMock('@brainstrike/text-splitter', async (importOriginal) => {
          const actual = await importOriginal<typeof import('@brainstrike/text-splitter')>();
          return {
            ...actual,
            splitTextByStrategy: () => ['Alpha target line\ncontinues with mixed newlines.'],
          };
        });
        const { chunkContent: isolatedChunkContent } = await import('../portable-chunking');

        const result = await isolatedChunkContent(text, {
          strategy: 'sentence',
          fileName: 'large-repetitive.txt',
          maxTokens: 64,
          overlap: 0,
          allowLargeFiles: true,
        });

        expect(result.skipped).toBe(false);
        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0]).toMatchObject({
          startLine: 12_052,
          endLine: 12_053,
          startOffset,
          endOffset,
        });
        expect(warnSpy).not.toHaveBeenCalled();
        expect(text.slice(startOffset, endOffset).replace(/\r\n/g, '\n')).toBe(
          'Alpha target line\ncontinues with mixed newlines.'
        );
        warnSpy.mockRestore();
      });

      it('uses source candidate positions without offset drift for mixed-newline anchors', async () => {
        vi.resetModules();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const prefix = Array.from(
          { length: 10_050 },
          (_, index) => `x filler ${index} keeps the prefix unique.`
        ).join('\n');
        const target = 'x\r\nNeedle anchor phrase spans after a normalized newline.';
        const text = `${prefix}\n${target}`;
        const startOffset = text.indexOf(target);
        const endOffset = startOffset + target.length;
        vi.doMock('@brainstrike/text-splitter', async (importOriginal) => {
          const actual = await importOriginal<typeof import('@brainstrike/text-splitter')>();
          return {
            ...actual,
            splitTextByStrategy: () => [
              'x\nNeedle anchor phrase spans after a normalized newline.',
            ],
          };
        });
        const { chunkContent: isolatedChunkContent } = await import('../portable-chunking');

        const result = await isolatedChunkContent(text, {
          strategy: 'sentence',
          fileName: 'mixed-newline-anchor.txt',
          maxTokens: 64,
          overlap: 0,
          allowLargeFiles: true,
        });

        expect(result.skipped).toBe(false);
        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0]).toMatchObject({
          startOffset,
          endOffset,
        });
        expect(text.slice(startOffset, endOffset).replace(/\r\n/g, '\n')).toBe(
          'x\nNeedle anchor phrase spans after a normalized newline.'
        );
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('enforces the anchored source candidate cap globally across anchors', async () => {
        vi.resetModules();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const chunk = 'AAAAAAAAAA BBBBBBBBBB\nC';
        const prefix = Array.from(
          { length: 10_000 },
          (_, index) => `AAAAAAAAAA nonmatching prefix ${index}`
        ).join('\n');
        const text = `${prefix}\nAAAAAAAAAA BBBBBBBBBB\r\nC`;
        vi.doMock('@brainstrike/text-splitter', async (importOriginal) => {
          const actual = await importOriginal<typeof import('@brainstrike/text-splitter')>();
          return {
            ...actual,
            splitTextByStrategy: () => [chunk],
          };
        });
        const { chunkContent: isolatedChunkContent } = await import('../portable-chunking');

        const result = await isolatedChunkContent(text, {
          strategy: 'sentence',
          fileName: 'global-anchor-budget.txt',
          maxTokens: 64,
          overlap: 0,
          allowLargeFiles: true,
        });

        expect(result).toMatchObject({
          chunks: [],
          skipped: true,
          skipReason: 'source range resolution failed',
          sourceRangeSkippedChunks: 1,
        });
        expect(warnSpy).toHaveBeenCalledWith(
          '[portable-chunking] skipped chunks with unresolved source ranges',
          {
            fileName: 'global-anchor-budget.txt',
            filePath: undefined,
            sourceRangeSkippedChunks: 1,
            totalCandidateChunks: 1,
          }
        );
        warnSpy.mockRestore();
      });

      it('uses the real text splitter after isolated text-splitter mocks', async () => {
        vi.resetModules();
        const { chunkContent: isolatedChunkContent } = await import('../portable-chunking');

        const result = await isolatedChunkContent('First sentence. Second sentence.', {
          strategy: 'sentence',
          fileName: 'unmocked.txt',
          maxTokens: 64,
          overlap: 0,
        });

        expect(result.skipped).toBe(false);
        expect(result.chunks.map((chunk) => chunk.content)).not.toEqual([
          'AAAAAAAAAA BBBBBBBBBB\nC',
        ]);
      });

      it('reports skipped chunks when source ranges cannot be resolved', async () => {
        vi.resetModules();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.doMock('@brainstrike/text-splitter', async (importOriginal) => {
          const actual = await importOriginal<typeof import('@brainstrike/text-splitter')>();
          return {
            ...actual,
            splitTextByStrategy: () => ['fabricated chunk text'],
          };
        });
        const { chunkContent: isolatedChunkContent } = await import('../portable-chunking');

        const result = await isolatedChunkContent('real source text', {
          strategy: 'sentence',
          fileName: 'source.txt',
        });

        expect(result).toMatchObject({
          chunks: [],
          skipped: true,
          skipReason: 'source range resolution failed',
          sourceRangeSkippedChunks: 1,
        });
        expect(warnSpy).toHaveBeenCalledWith(
          '[portable-chunking] skipped chunks with unresolved source ranges',
          {
            fileName: 'source.txt',
            filePath: undefined,
            sourceRangeSkippedChunks: 1,
            totalCandidateChunks: 1,
          }
        );
        warnSpy.mockRestore();
      });

      it('resolves source ranges for adjacent exported functions', async () => {
        const createExportedFunction = (name: string): string =>
          `export async function ${name}(): Promise<void> {\n` +
          Array.from({ length: 5 }, (_, index) => `  await step${index}();`).join('\n') +
          '\n}\n\n';
        const text =
          createExportedFunction('alpha') +
          createExportedFunction('beta') +
          createExportedFunction('gamma') +
          `function delta(): void {\n${Array.from(
            { length: 5 },
            (_, index) => `  run${index}();`
          ).join('\n')}\n}\n`;

        const result = await chunkContent(text, {
          strategy: 'recursive',
          fileName: 'exported-functions.ts',
          maxTokens: 80,
          overlap: 16,
        });

        expect(result.skipped).toBe(false);
        expect(result.chunks.length).toBeGreaterThan(1);
        for (const chunk of result.chunks) {
          expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
          expect(chunk.endOffset).toBeLessThanOrEqual(text.length);
          expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset);
        }
      });

      it('keeps nested class methods inside their top-level function chunk', async () => {
        const text = `export function outer(): void {
  class Inner {
    method(): void {
      run();
    }
  }
  new Inner().method();
}

export function after(): void {
  done();
}
`;

        const result = await chunkContent(text, {
          strategy: 'recursive',
          fileName: 'nested-method.ts',
          maxTokens: 80,
          overlap: 16,
        });

        expect(result.skipped).toBe(false);
        expect(result.chunks.some((chunk) => chunk.content.startsWith('method():'))).toBe(false);
        expect(result.chunks.map((chunk) => chunk.startOffset)).toEqual([0, 7, 119, 126]);
      });

      it('should split punctuation-poor text to the configured chunk target', async () => {
        const text = 'x'.repeat(5000);
        const result = await chunkContent(text, {
          strategy: 'sentence',
          fileName: 'plain.txt',
        });

        expect(result.chunks.length).toBeGreaterThan(1);
        for (const chunk of result.chunks) {
          expect(chunk.content.length).toBeLessThanOrEqual(CHUNKING_CONFIG.defaultMaxTokens * 8);
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

      it('falls back to recursive splitting when AST parsing fails', async () => {
        vi.doMock('@babel/parser', () => ({
          parse: () => {
            throw new Error('parser exploded');
          },
        }));

        const result = await chunkContent(
          `
const alpha = () => 1;
const beta = () => 2;
const gamma = () => alpha() + beta();
`.repeat(40),
          {
            strategy: 'recursive',
            fileName: 'broken.ts',
          }
        );

        expect(result.skipped).toBe(false);
        expect(result.strategyUsed).toBe('recursive');
        expect(result.chunks.length).toBeGreaterThan(1);
      });

      it('uses Babel parser modules bundled with a default export', async () => {
        vi.resetModules();
        const parse = vi.fn(() => ({
          type: 'File',
          program: {
            type: 'Program',
            body: [
              {
                type: 'FunctionDeclaration',
                start: 0,
                end: 'function alpha() { return 1; }'.length,
              },
            ],
          },
        }));
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
        vi.doMock('@babel/parser', () => ({
          default: { parse },
        }));
        const { chunkContent: isolatedChunkContent } = await import('../portable-chunking');

        const result = await isolatedChunkContent(
          'function alpha() { return 1; }\n\nconst beta = 2;',
          {
            strategy: 'recursive',
            fileName: 'default-parser.ts',
          }
        );

        expect(result.skipped).toBe(false);
        expect(parse).toHaveBeenCalledTimes(1);
        expect(debug).not.toHaveBeenCalledWith(
          '[portable-chunking] AST parsing failed for function-level splitting',
          expect.anything()
        );
      });

      it('falls back to recursive splitting when no top-level function ranges exist', async () => {
        const result = await chunkContent(
          `
const CONFIG = {
  name: 'brainstrike',
  version: '1.0.0',
  nested: { enabled: true, retries: 3 },
};

export const FLAGS = ['alpha', 'beta', 'gamma'];
`.repeat(50),
          {
            strategy: 'recursive',
            fileName: 'config.ts',
          }
        );

        expect(result.skipped).toBe(false);
        expect(result.strategyUsed).toBe('recursive');
        expect(result.chunks.length).toBeGreaterThan(1);
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

      it('splits markdown blocks across unicode whitespace-only separator lines', async () => {
        const markdown = '# Title\n\nAlpha paragraph.\n\u00A0\nBeta paragraph.';

        const result = await chunkContent(markdown, {
          strategy: 'markdown',
          fileName: 'notes.md',
          maxTokens: 32,
          overlap: 4,
        });

        expect(result.skipped).toBe(false);
        expect(result.strategyUsed).toBe('markdown');
        expect(result.chunks.map((chunk) => chunk.content)).toEqual(
          expect.arrayContaining(['# Title', 'Alpha paragraph.', 'Beta paragraph.'])
        );
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

      it('applies code-language defaults when recommendations are enabled', async () => {
        const generatedCode = Array.from(
          { length: 120 },
          (_, index) => `
export function feature${index}() {
  return 'feature-${index}';
}
`
        ).join('\n');

        const result = await chunkContent(generatedCode, {
          strategy: 'token',
          fileName: 'feature.ts',
        });

        expect(result.skipped).toBe(false);
        expect(result.chunks[0]?.chunkSize).toBe(
          CHUNKING_CONFIG.codeLanguageDefaults.typescript.maxTokens
        );
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

      it('clamps overlap below maxTokens when explicit overlap is too large', async () => {
        const result = await chunkContent('word '.repeat(200), {
          strategy: 'token',
          fileName: 'overlap.txt',
          maxTokens: 32,
          overlap: 64,
        });

        expect(result.skipped).toBe(false);
        expect(result.chunks[0]?.chunkSize).toBe(32);
        expect(result.chunks[0]?.content.length).toBeGreaterThan(0);
      });

      it('accepts legacy tokenTrueSizing without loading accurate token utilities', async () => {
        vi.doMock('../token-utils-lite', () => {
          throw new Error('accurate token utility module should not load for local estimation');
        });

        const result = await chunkContent('abcde '.repeat(160), {
          strategy: 'token',
          fileName: 'estimated-sizing.txt',
          maxTokens: 32,
          overlap: 8,
          tokenTrueSizing: true,
        });

        expect(result.skipped).toBe(false);
        expect(result.strategyUsed).toBe('token');
        expect(result.chunks.length).toBeGreaterThan(0);
        expect(result.totalTokens).toBeGreaterThan(0);
      });

      it('re-splits oversized chunks when true sizing exceeds the safety cap', async () => {
        vi.doMock('../token-utils-lite', () => ({
          countTokensAccurate: vi.fn(async (text: string) => {
            if (text.length > 120) {
              return 160;
            }
            return Math.max(1, Math.ceil(text.length / 8));
          }),
        }));

        const result = await chunkContent('word '.repeat(250), {
          strategy: 'token',
          fileName: 'true-sized.txt',
          maxTokens: 32,
          overlap: 8,
          tokenTrueSizing: true,
        });

        expect(result.skipped).toBe(false);
        expect(result.strategyUsed).toBe('token');
        expect(result.chunks.length).toBeGreaterThan(1);
        for (const chunk of result.chunks) {
          expect(chunk.content.length).toBeGreaterThan(0);
          expect(chunk.tokenCount).toBeGreaterThan(0);
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
