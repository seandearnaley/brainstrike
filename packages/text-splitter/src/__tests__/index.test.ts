import { describe, expect, it } from 'vitest';
import {
  ACCURATE_TOKEN_ENCODING,
  ACCURATE_TOKEN_MODEL_HINT,
  countTokensHeuristic,
  estimateTokenCost,
  formatTokenCount,
  getChunkingPreset,
  getChunkingPresetDefinitions,
  getChunkingRoutePreview,
  isChunkingStrategy,
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
        chunkSize: 2,
        chunkOverlap: 0,
        separators: [`${index}`],
        isSeparatorRegex: true,
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
      chunkSize: 32,
      chunkOverlap: 4,
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

  it('preserves overlapping context between neighboring chunks', () => {
    const chunks = splitTextRecursively('ab cd ef gh ij', {
      chunkSize: 6,
      chunkOverlap: 3,
      separators: [' ', ''],
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.slice(-2)).toBe(chunks[1]?.slice(0, 2));
  });

  it('preserves whitespace inside overlap windows', () => {
    const chunks = splitTextByStrategy('word1    word2    word3', {
      strategy: 'character',
      chunkSize: 12,
      chunkOverlap: 4,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain('    ');
    expect(chunks[1]).toContain('    ');
    expect(chunks[1]?.endsWith('wo')).toBe(true);
  });

  it('falls back to fixed-width splits when no separator matches', () => {
    const chunks = splitTextRecursively('abcdefghij', {
      chunkSize: 3,
      chunkOverlap: 0,
      separators: [''],
    });

    expect(chunks).toEqual(['abc', 'def', 'ghi', 'j']);
  });

  it('supports regex separators', () => {
    const chunks = splitTextRecursively('a1b2c3d4e5f6', {
      chunkSize: 4,
      chunkOverlap: 0,
      separators: ['\\d'],
      isSeparatorRegex: true,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4)).toBe(true);
  });

  it('throws a clear error for invalid regex separators', () => {
    expect(() =>
      splitTextRecursively('abcdef', {
        chunkSize: 3,
        chunkOverlap: 0,
        separators: ['[unclosed'],
        isSeparatorRegex: true,
      })
    ).toThrow('Invalid regex separator "[unclosed"');
  });

  it('supports character strategy with overlap', () => {
    const chunks = splitTextByStrategy('abcdefghij', {
      strategy: 'character',
      chunkSize: 4,
      chunkOverlap: 1,
    });

    expect(chunks).toEqual(['abcd', 'defg', 'ghij']);
  });

  it('supports markdown-aware splitting', () => {
    const chunks = splitTextByStrategy(
      '# Title\n\n## Section\n\nBody text\n\n### Detail\n\nMore text',
      {
        strategy: 'markdown',
        chunkSize: 18,
        chunkOverlap: 2,
      }
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((chunk) => chunk.includes('## Section'))).toBe(true);
  });

  it('supports semantic markdown grouping', () => {
    const chunks = splitTextByStrategy(
      '# Title\n\nIntro\n\n## A\n\nAlpha paragraph.\n\n## B\n\nBeta paragraph.',
      {
        strategy: 'semantic-markdown',
        chunkSize: 28,
        chunkOverlap: 4,
      }
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain('# Title');
  });

  it('supports html-aware splitting', () => {
    const chunks = splitTextByStrategy(
      '<article><section><p>Alpha beta gamma</p></section><section><p>Delta epsilon zeta</p></section></article>',
      {
        strategy: 'html',
        chunkSize: 40,
        chunkOverlap: 4,
      }
    );

    expect(chunks.length).toBeGreaterThan(1);
  });

  it('supports json-aware splitting', () => {
    const chunks = splitTextByStrategy(
      '{"rows":[{"id":1,"name":"alpha"},{"id":2,"name":"beta"},{"id":3,"name":"gamma"}]}',
      {
        strategy: 'json',
        chunkSize: 36,
        chunkOverlap: 4,
      }
    );

    expect(chunks.length).toBeGreaterThan(1);
  });

  it('supports latex-aware splitting', () => {
    const chunks = splitTextByStrategy(
      '\\section{Intro}\nAlpha beta gamma\n\\subsection{Detail}\nDelta epsilon zeta',
      {
        strategy: 'latex',
        chunkSize: 28,
        chunkOverlap: 2,
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
    expect(estimateTokenCost(1000, 1000)).toBe(0.04);
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
  });

  it('resolves final effective strategy from the shared contract', () => {
    expect(
      resolveEffectiveChunkingStrategy({
        requested: 'auto',
        resolvedAutoStrategy: 'recursive',
        isCode: true,
      })
    ).toBe('recursive');
    expect(
      resolveEffectiveChunkingStrategy({
        requested: 'auto',
        resolvedAutoStrategy: 'recursive',
        isCode: false,
      })
    ).toBe('sentence');
    expect(
      resolveEffectiveChunkingStrategy({
        requested: 'html',
        resolvedAutoStrategy: 'sentence',
        isCode: false,
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
        chunkSize: 4,
        chunkOverlap: 4,
      })
    ).toThrow('chunkOverlap must be smaller than chunkSize');
  });

  it('throws on invalid text and size inputs', () => {
    expect(() =>
      splitTextRecursively(123 as unknown as string, {
        chunkSize: 4,
        chunkOverlap: 0,
      })
    ).toThrow('text must be a string');

    expect(() =>
      splitTextRecursively('abc', {
        chunkSize: 0,
        chunkOverlap: 0,
      })
    ).toThrow('chunkSize must be a positive integer');

    expect(() =>
      splitTextRecursively('abc', {
        chunkSize: 4,
        chunkOverlap: -1,
      })
    ).toThrow('chunkOverlap must be a non-negative integer');
  });

  it('throws on invalid separator configuration', () => {
    expect(() =>
      splitTextRecursively('abc', {
        chunkSize: 4,
        chunkOverlap: 0,
        separators: [],
      })
    ).toThrow('separators must contain at least one entry');

    expect(() =>
      splitTextRecursively('abc', {
        chunkSize: 4,
        chunkOverlap: 0,
        separators: [' ', 1 as unknown as string],
      })
    ).toThrow('separators must be strings');
  });

  it('uses custom strategy separators without mutating shared defaults', () => {
    const chunks = splitTextByStrategy('alpha::beta::gamma', {
      strategy: 'markdown',
      chunkSize: 8,
      chunkOverlap: 0,
      separators: ['::', ''],
    });

    expect(chunks).toEqual(['alpha::', 'beta::', 'gamma']);
    expect(
      splitTextByStrategy('abcdef', { strategy: 'character', chunkSize: 10, chunkOverlap: 0 })
    ).toEqual(['abcdef']);
  });

  it('throws for unknown preset ids', () => {
    expect(() => getChunkingPreset('missing' as Parameters<typeof getChunkingPreset>[0])).toThrow(
      'Unknown chunking preset: missing'
    );
  });
});
