import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createNodeChunker } from '../node/index';
import { chunkContent } from '../portable-chunking';

describe('canonical Node chunking', () => {
  it('preserves a recorded desktop canonical result including every graph and chunk field', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          '../../../indexer/__tests__/fixtures/canonical-provided-chunks.json',
          import.meta.url
        ),
        'utf8'
      )
    ) as {
      content: string;
      relativePath: string;
      result: {
        chunks: unknown[];
        skipped: boolean;
        strategyUsed: string;
        symbolRefs: unknown[];
        symbols: unknown[];
        totalTokens: number;
      };
    };
    const result = await createNodeChunker({ parser: 'oxc', treeSitterLanguages: ['python'] })(
      fixture.content,
      { filePath: fixture.relativePath, maxTokens: 256, strategy: 'auto', tokenTrueSizing: true }
    );
    expect(result.chunks).toEqual(fixture.result.chunks);
    expect(result.symbols).toEqual(fixture.result.symbols);
    expect(result.symbolRefs).toEqual(fixture.result.symbolRefs);
    expect(result.totalTokens).toBe(fixture.result.totalTokens);
    expect(result.skipped).toBe(fixture.result.skipped);
    expect(result.strategyUsed).toBe(fixture.result.strategyUsed);
  });

  it.each([
    {
      content: '# Heading\n\nA Unicode paragraph: café 🧠.\n\n## Next\n\nAnother paragraph.\n',
      fileName: 'notes.md',
    },
    { content: '{"name":"café","count":42,"enabled":true}\n', fileName: 'data.json' },
    { content: 'first line\r\nUnicode 🧠 line\r\nlast line\r\n', fileName: 'notes.txt' },
    { content: '', fileName: 'empty.txt' },
  ])('matches the current canonical algorithm for $fileName', async ({ content, fileName }) => {
    const options = { fileName, maxTokens: 256, strategy: 'auto' as const, tokenTrueSizing: true };
    expect(
      await createNodeChunker({ parser: 'oxc', treeSitterLanguages: ['python'] })(content, options)
    ).toEqual(await chunkContent(content, options));
  });

  it('uses the canonical Python parser without renderer globals', async () => {
    const result = await createNodeChunker({ parser: 'oxc', treeSitterLanguages: ['python'] })(
      'def greet(name):\n    return f"hello {name}"\n',
      { fileName: 'greet.py', strategy: 'auto' }
    );
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toBe('def greet(name):\n    return f"hello {name}"');
  });

  it('refuses an unavailable Python parser instead of substituting text splitting', async () => {
    await expect(
      createNodeChunker({ parser: 'oxc', treeSitterLanguages: [] })(
        'def greet(name):\n    return name\n',
        { fileName: 'greet.py', strategy: 'auto' }
      )
    ).rejects.toThrow('No canonical AST adapter');
  });

  it('rejects parser failure before publishing degraded chunks or graph', async () => {
    const failure = new Error('Parser host failed');
    await expect(
      chunkContent(
        'export function greet() { return 42; }',
        {
          fileName: 'greet.ts',
          strategy: 'auto',
        },
        {
          enabledTreeSitterLanguages: [],
          selectAdapter: () => ({ id: 'oxc-native', parse: () => Promise.reject(failure) }),
          strict: true,
        }
      )
    ).rejects.toBe(failure);
  });
});
