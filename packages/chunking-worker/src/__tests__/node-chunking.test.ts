import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createNodeChunker } from '../node/index';
import { chunkContent } from '../portable-chunking';

/** A chunk with no letter, digit or identifier character carries nothing of its own. */
const WORDLESS = /^[^\p{L}\p{N}_$]*$/u;
const KEYWORD_ONLY = /^(?:export(?: default)?|default|declare|async|abstract|static)$/;

describe('canonical Node chunking', () => {
  it('preserves a recorded desktop canonical result including every graph and chunk field', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          import.meta.resolve('@brainstrike/test-utils/fixtures/canonical-provided-chunks.json')
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
    const result = await createNodeChunker({ parser: 'oxc' })(fixture.content, {
      filePath: fixture.relativePath,
      maxTokens: 256,
      strategy: 'auto',
      tokenTrueSizing: true,
    });
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
    expect(await createNodeChunker({ parser: 'oxc' })(content, options)).toEqual(
      await chunkContent(content, options)
    );
  });

  it('uses the canonical Python parser without renderer globals', async () => {
    const result = await createNodeChunker({ parser: 'oxc' })(
      'def greet(name):\n    return f"hello {name}"\n',
      { fileName: 'greet.py', strategy: 'auto' }
    );
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toBe('def greet(name):\n    return f"hello {name}"');
  });

  it('refuses an unavailable Python parser instead of substituting text splitting', async () => {
    await expect(
      chunkContent(
        'def greet(name):\n    return name\n',
        { fileName: 'greet.py', strategy: 'auto' },
        { selectAdapter: () => null, strict: true }
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
          selectAdapter: () => ({ id: 'oxc-native', parse: () => Promise.reject(failure) }),
          strict: true,
        }
      )
    ).rejects.toBe(failure);
  });
});

// BST-1983: every TypeScript file chunked to a lone `export` (or the class's
// closing `}`), and those identical vectors outranked real content.
describe('canonical declaration chunks', () => {
  it('keeps modifiers and closing braces with their declarations in a real TypeScript file', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL('./fixtures/real-typescript-declarations.json', import.meta.url),
        'utf8'
      )
    ) as { content: string; relativePath: string; sourceHash: string };
    expect(createHash('sha256').update(fixture.content).digest('hex')).toBe(fixture.sourceHash);

    const { chunks } = await createNodeChunker({ parser: 'oxc' })(fixture.content, {
      filePath: fixture.relativePath,
      maxTokens: 256,
      strategy: 'auto',
      tokenTrueSizing: true,
    });

    // Each chunk is its own exact source span, in source order: a lone `}` once
    // resolved to an earlier brace inside the method before it.
    expect(
      chunks.map((chunk) => fixture.content.slice(chunk.startOffset, chunk.endOffset))
    ).toEqual(chunks.map((chunk) => chunk.content));
    expect(
      chunks.filter((chunk, index) => chunk.startOffset < (chunks[index - 1]?.endOffset ?? 0))
    ).toEqual([]);
    expect(chunks.map((chunk) => chunk.content.split('\n')[0])).toEqual([
      "import type { ModelMessage, TextStreamPart, ToolSet } from 'ai';",
      'export function isModelStreamTelemetry(chunk: TextStreamPart<ToolSet>): chunk is ModelStreamPart {',
      '/**',
      'observe(chunk: ModelStreamPart): void {',
      'clear(): void {',
      '/** The observed partial assistant message, or undefined when the step streamed no text. */',
      'message(): ModelMessage | undefined {',
    ]);
    // The class's closing brace ends its last method's chunk.
    expect(chunks.at(-1)?.content.endsWith('\n  }\n}')).toBe(true);
  });

  it.each(['oxc', 'babel'] as const)(
    'never emits a chunk that is only a modifier or punctuation (%s)',
    async (parser) => {
      const chunk = createNodeChunker({ parser });
      const contents = async (fileName: string, content: string): Promise<string[]> =>
        (await chunk(content, { fileName, strategy: 'auto' })).chunks.map((item) => item.content);

      expect(
        await contents('bake.ts', 'export default function bake(): number {\n  return 42;\n}\n')
      ).toEqual(['export default function bake(): number {\n  return 42;\n}']);
      expect(await contents('rise.ts', 'export default async () => {\n  return 1;\n};\n')).toEqual([
        'export default async () => {\n  return 1;\n};',
      ]);
      expect(
        await contents(
          'overload.ts',
          'export declare function shape(a: string): void;\nexport function shape(a: string): void {\n  console.log(a);\n}\n'
        )
      ).toEqual([
        'export declare function shape(a: string): void;',
        'export function shape(a: string): void {\n  console.log(a);\n}',
      ]);
      expect(
        await contents(
          'oven.ts',
          'export class Oven {\n  @heat(220)\n  bake(): void {\n    console.log(1);\n  }\n\n  @heat(100)\n  static rest(): void {}\n}\n'
        )
      ).toEqual([
        'export class Oven {',
        '@heat(220)\n  bake(): void {\n    console.log(1);\n  }',
        '@heat(100)\n  static rest(): void {}\n}',
      ]);
    }
  );

  it('chunks a file whose syntax error the parser recovers from', async () => {
    const chunks = await createNodeChunker({ parser: 'oxc' })(
      'export function broken( {\n  return ;\n}\nexport function fine() { return 1; }\n',
      { fileName: 'broken.ts', strategy: 'auto' }
    );
    expect(chunks.chunks.length).toBeGreaterThan(0);
    expect(
      chunks.chunks.filter((item) => WORDLESS.test(item.content) || KEYWORD_ONLY.test(item.content))
    ).toEqual([]);
  });
});
