import { describe, expect, it } from 'vitest';
import {
  ACCURATE_TOKEN_ENCODING,
  ACCURATE_TOKEN_MODEL_HINT,
  countTokensHeuristic,
  formatTokenCount,
  getChunkingPreset,
  getChunkingPresetDefinitions,
  getChunkingRoutePreview,
  isChunkingStrategy,
  isMarkdownBlockBoundaryLine,
  isResolvedChunkingStrategy,
  RecursiveTextSplitter,
  resolveChunkingStrategyForFile,
  resolveEffectiveChunkingStrategy,
  splitTextByStrategy,
  splitTextRecursively,
} from '../index.js';

describe('@brainstrike/text-splitter', () => {
  it('bounds the compiled separator regex cache', () => {
    for (let index = 0; index < 70; index += 1) {
      const chunks = splitTextRecursively(`a${index}b${index}c`, {
        chunkOverlap: 0,
        chunkSize: 2,
        isSeparatorRegex: true,
        separators: [`${index}`],
      });
      expect(chunks.length).toBeGreaterThan(0);
    }
  });

  it('exports shared accurate token constants for worker runtimes', () => {
    expect(ACCURATE_TOKEN_MODEL_HINT).toBe('gpt-5.2');
    expect(ACCURATE_TOKEN_ENCODING).toBe('o200k_base');
  });

  it('splits long text recursively with literal separators', async () => {
    const splitter = new RecursiveTextSplitter({
      chunkOverlap: 4,
      chunkSize: 32,
      separators: ['\n\n', '\n', '. ', ' ', ''],
    });

    const chunks = await splitter.splitText(
      'Alpha beta gamma. Delta epsilon zeta. Eta theta iota. Kappa lambda mu.'
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(32);
    }
  });

  it('uses owned default separators when none are provided', () => {
    const chunks = splitTextRecursively('Alpha beta gamma delta', {
      chunkOverlap: 2,
      chunkSize: 10,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toContain('Alpha');
  });

  it('recognizes markdown block boundary lines', () => {
    expect(isMarkdownBlockBoundaryLine('```ts')).toBe(true);
    expect(isMarkdownBlockBoundaryLine('~~~')).toBe(true);
    expect(isMarkdownBlockBoundaryLine('### Heading')).toBe(true);
    expect(isMarkdownBlockBoundaryLine('   ')).toBe(true);
    expect(isMarkdownBlockBoundaryLine('plain text')).toBe(false);
  });

  it('preserves overlapping context between neighboring chunks', () => {
    const chunks = splitTextRecursively('ab cd ef gh ij', {
      chunkOverlap: 3,
      chunkSize: 6,
      separators: [' ', ''],
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.slice(-2)).toBe(chunks[1]?.slice(0, 2));
  });

  it('preserves whitespace inside overlap windows', () => {
    const chunks = splitTextByStrategy('word1    word2    word3', {
      chunkOverlap: 4,
      chunkSize: 12,
      strategy: 'character',
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain('    ');
    expect(chunks[1]).toContain('    ');
    expect(chunks[1]?.endsWith('wo')).toBe(true);
  });

  it('falls back to fixed-width splits when no separator matches', () => {
    const chunks = splitTextRecursively('abcdefghij', {
      chunkOverlap: 0,
      chunkSize: 3,
      separators: [''],
    });

    expect(chunks).toEqual(['abc', 'def', 'ghi', 'j']);
  });

  it('supports regex separators', () => {
    const chunks = splitTextRecursively('a1b2c3d4e5f6', {
      chunkOverlap: 0,
      chunkSize: 4,
      isSeparatorRegex: true,
      separators: ['\\d'],
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4)).toBe(true);
  });

  it('throws a clear error for invalid regex separators', () => {
    expect(() =>
      splitTextRecursively('abcdef', {
        chunkOverlap: 0,
        chunkSize: 3,
        isSeparatorRegex: true,
        separators: ['[unclosed'],
      })
    ).toThrow('Invalid regex separator "[unclosed"');
  });

  it('supports character strategy with overlap', () => {
    const chunks = splitTextByStrategy('abcdefghij', {
      chunkOverlap: 1,
      chunkSize: 4,
      strategy: 'character',
    });

    expect(chunks).toEqual(['abcd', 'defg', 'ghij']);
  });

  it('supports markdown-aware splitting', () => {
    const chunks = splitTextByStrategy(
      '# Title\n\n## Section\n\nBody text\n\n### Detail\n\nMore text',
      {
        chunkOverlap: 2,
        chunkSize: 18,
        strategy: 'markdown',
      }
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((chunk) => chunk.includes('## Section'))).toBe(true);
  });

  it('supports semantic markdown grouping', () => {
    const chunks = splitTextByStrategy(
      '# Title\n\nIntro\n\n## A\n\nAlpha paragraph.\n\n## B\n\nBeta paragraph.',
      {
        chunkOverlap: 4,
        chunkSize: 28,
        strategy: 'semantic-markdown',
      }
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain('# Title');
  });

  it('splits long semantic markdown sections before merging them', () => {
    const chunks = splitTextByStrategy(
      '# Title\n\nThis section has enough prose to exceed the small chunk target and needs recursive splitting within the heading family.',
      {
        chunkOverlap: 4,
        chunkSize: 24,
        strategy: 'semantic-markdown',
      }
    );

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]).toContain('# Title');
  });

  it('supports html-aware splitting', () => {
    const chunks = splitTextByStrategy(
      '<article><section><p>Alpha beta gamma</p></section><section><p>Delta epsilon zeta</p></section></article>',
      {
        chunkOverlap: 4,
        chunkSize: 40,
        strategy: 'html',
      }
    );

    expect(chunks.length).toBeGreaterThan(1);
  });

  it('supports json-aware splitting', () => {
    const chunks = splitTextByStrategy(
      '{"rows":[{"id":1,"name":"alpha"},{"id":2,"name":"beta"},{"id":3,"name":"gamma"}]}',
      {
        chunkOverlap: 4,
        chunkSize: 36,
        strategy: 'json',
      }
    );

    expect(chunks.length).toBeGreaterThan(1);
  });

  it('supports latex-aware splitting', () => {
    const chunks = splitTextByStrategy(
      '\\section{Intro}\nAlpha beta gamma\n\\subsection{Detail}\nDelta epsilon zeta',
      {
        chunkOverlap: 2,
        chunkSize: 28,
        strategy: 'latex',
      }
    );

    expect(chunks.length).toBeGreaterThan(1);
  });

  it('returns documented preset definitions', () => {
    const presets = getChunkingPresetDefinitions();

    expect(presets).toHaveLength(7);
    expect(presets.find((preset) => preset.isDefault)?.id).toBe('balanced');
    expect(getChunkingPreset('docs').strategy).toBe('semantic-markdown');
    expect(getChunkingPreset('codebase').strategy).toBe('auto');
    expect(getChunkingPreset('strict-code').strategy).toBe('recursive');
  });

  it('recognizes canonical chunking strategies', () => {
    expect(isResolvedChunkingStrategy('markdown')).toBe(true);
    expect(isResolvedChunkingStrategy('auto')).toBe(false);
    expect(isChunkingStrategy('auto')).toBe(true);
    expect(isChunkingStrategy('semantic-markdown')).toBe(true);
    expect(isChunkingStrategy('bogus')).toBe(false);
  });

  it('exports lightweight token heuristics from the package root', () => {
    expect(countTokensHeuristic('abcdefgh')).toBe(2);
    expect(formatTokenCount(1500)).toBe('1.5K tokens');
  });

  it('resolves auto strategy from file extension', () => {
    expect(resolveChunkingStrategyForFile('/tmp/readme.md')).toBe('semantic-markdown');
    expect(resolveChunkingStrategyForFile('/tmp/guide.adoc')).toBe('semantic-markdown');
    expect(resolveChunkingStrategyForFile('/tmp/component.tsx')).toBe('recursive');
    expect(resolveChunkingStrategyForFile('/tmp/schema.json')).toBe('json');
    expect(resolveChunkingStrategyForFile('/tmp/records.ndjson')).toBe('json');
    expect(resolveChunkingStrategyForFile('/tmp/notebook.ipynb')).toBe('json');
    expect(resolveChunkingStrategyForFile('/tmp/diagram.svg')).toBe('html');
    expect(resolveChunkingStrategyForFile('/tmp/paper.tex')).toBe('latex');
    expect(resolveChunkingStrategyForFile('/tmp/references.bib')).toBe('latex');
    expect(resolveChunkingStrategyForFile('/tmp/notes.txt')).toBe('sentence');
    expect(resolveChunkingStrategyForFile('/tmp/README')).toBe('sentence');
  });

  it('honors explicit regex separators on RecursiveTextSplitter instances', async () => {
    const splitter = new RecursiveTextSplitter({
      chunkOverlap: 0,
      chunkSize: 6,
      isSeparatorRegex: true,
      separators: ['\\d+'],
    });

    await expect(splitter.splitText('alpha123beta456gamma')).resolves.toEqual([
      'alpha1',
      '23',
      'beta45',
      '6gamma',
    ]);
  });

  it('resolves final effective strategy from the shared contract', () => {
    expect(
      resolveEffectiveChunkingStrategy({
        isCode: true,
        requested: 'auto',
        resolvedAutoStrategy: 'recursive',
      })
    ).toBe('recursive');
    expect(
      resolveEffectiveChunkingStrategy({
        isCode: false,
        requested: 'auto',
        resolvedAutoStrategy: 'recursive',
      })
    ).toBe('sentence');
    expect(
      resolveEffectiveChunkingStrategy({
        isCode: false,
        requested: 'html',
        resolvedAutoStrategy: 'sentence',
      })
    ).toBe('html');
  });

  it('builds a routing preview for adaptive and fixed strategies', () => {
    const adaptivePreview = getChunkingRoutePreview('auto');
    expect(adaptivePreview.find((entry) => entry.fileName.endsWith('.ts'))?.resolvedStrategy).toBe(
      'recursive'
    );
    expect(adaptivePreview.find((entry) => entry.fileName.endsWith('.md'))?.resolvedStrategy).toBe(
      'semantic-markdown'
    );
    expect(
      adaptivePreview.find((entry) => entry.fileName.endsWith('.json'))?.resolvedStrategy
    ).toBe('json');

    const fixedPreview = getChunkingRoutePreview('recursive');
    expect(fixedPreview.every((entry) => entry.resolvedStrategy === 'recursive')).toBe(true);
  });

  it('throws on invalid chunk overlap', () => {
    expect(() =>
      splitTextRecursively('abc', {
        chunkOverlap: 4,
        chunkSize: 4,
      })
    ).toThrow('chunkOverlap must be smaller than chunkSize');
  });

  it('throws on invalid text and size inputs', () => {
    expect(() =>
      splitTextRecursively(123 as unknown as string, {
        chunkOverlap: 0,
        chunkSize: 4,
      })
    ).toThrow('text must be a string');

    expect(() =>
      splitTextRecursively('abc', {
        chunkOverlap: 0,
        chunkSize: 0,
      })
    ).toThrow('chunkSize must be a positive integer');

    expect(() =>
      splitTextRecursively('abc', {
        chunkOverlap: -1,
        chunkSize: 4,
      })
    ).toThrow('chunkOverlap must be a non-negative integer');
  });

  it('throws on invalid separator configuration', () => {
    expect(() =>
      splitTextRecursively('abc', {
        chunkOverlap: 0,
        chunkSize: 4,
        separators: [],
      })
    ).toThrow('separators must contain at least one entry');

    expect(() =>
      splitTextRecursively('abc', {
        chunkOverlap: 0,
        chunkSize: 4,
        separators: [' ', 1 as unknown as string],
      })
    ).toThrow('separators must be strings');
  });

  it('uses custom strategy separators without mutating shared defaults', () => {
    const chunks = splitTextByStrategy('alpha::beta::gamma', {
      chunkOverlap: 0,
      chunkSize: 8,
      separators: ['::', ''],
      strategy: 'markdown',
    });

    expect(chunks).toEqual(['alpha::', 'beta::', 'gamma']);
    expect(
      splitTextByStrategy('abcdef', { chunkOverlap: 0, chunkSize: 10, strategy: 'character' })
    ).toEqual(['abcdef']);
  });

  it('throws for unknown preset ids', () => {
    expect(() => getChunkingPreset('missing' as Parameters<typeof getChunkingPreset>[0])).toThrow(
      'Unknown chunking preset: missing'
    );
  });
});
