import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createNodeChunker } from '../node/index';

const PYTHON = [
  'class Greeter:',
  '    def __init__(self, name):',
  '        self.name = name',
  '',
  '    def greet(self):',
  '        return f"hello {self.name}"',
  '',
  '',
  'def main():',
  '    print(Greeter("café 🧠").greet())',
  '',
].join('\n');

describe('canonical chunking with the Babel parser', () => {
  it("chunks the recorded desktop canonical file exactly as desktop's oxc-parsed result", async () => {
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
      result: { chunks: unknown[]; symbolRefs: unknown[]; symbols: unknown[]; totalTokens: number };
    };
    const result = await createNodeChunker({ parser: 'babel' })(fixture.content, {
      filePath: fixture.relativePath,
      maxTokens: 256,
      strategy: 'auto',
      tokenTrueSizing: true,
    });
    expect(result.chunks).toEqual(fixture.result.chunks);
    expect(result.symbols).toEqual(fixture.result.symbols);
    expect(result.symbolRefs).toEqual(fixture.result.symbolRefs);
    expect(result.totalTokens).toBe(fixture.result.totalTokens);
  });

  it('parses Python with the vendored tree-sitter grammar, as the desktop chunker does', async () => {
    const options = { fileName: 'greeter.py', maxTokens: 64, strategy: 'auto' as const };
    const babel = await createNodeChunker({ parser: 'babel' })(PYTHON, options);
    expect(babel).toEqual(await createNodeChunker({ parser: 'oxc' })(PYTHON, options));
    // The symbols come from the grammar's parse tree; text splitting has none.
    if (!babel.symbols) {
      throw new Error('Expected grammar-derived Python symbols');
    }
    expect(babel.symbols.map((symbol) => symbol.name)).toEqual(['Greeter', 'main']);
  });
});
