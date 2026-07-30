import { describe, expect, it } from 'vitest';
import {
  type AstNode,
  adjustChunkingForFileType,
  analyzeContentRepetition,
  assertTokenBudgetIterationsWithinLimit,
  type ChunkAdjustmentConfig,
  detectCodeLanguage,
  findBalancedSplitPoint,
  getCodeSeparators,
  getTopLevelFunctionRanges,
  isAstNode,
  isFunctionNode,
  resolveMaxTokensCap,
  shouldSkipChunking,
  splitByBlankLines,
  splitCodeByFunctionRanges,
  splitMarkdownIntoBlocks,
} from '../chunking-core.js';

describe('analyzeContentRepetition', () => {
  it('does not expose unavailable uniqueness counts below the analysis threshold', () => {
    const result = analyzeContentRepetition('x'.repeat(1_000_000));

    expect(result).toEqual({
      isHighlyRepetitive: false,
      kind: 'below-threshold',
      totalLines: 1,
    });
    expect('uniqueLines' in result).toBe(false);
  });

  it('preserves the strict unique-line ratio boundary including a trailing line', () => {
    const uniqueLines = Array.from({ length: 100 }, (_, index) => `unique-${index}`);
    const content = `${Array.from({ length: 901 }, () => 'duplicate').join(
      '\n'
    )}\n${uniqueLines.join('\n')}`;

    expect(analyzeContentRepetition(content)).toEqual({
      inspectedLines: 1001,
      isHighlyRepetitive: false,
      kind: 'analyzed',
      totalLines: 1001,
      uniqueLines: 101,
    });
  });

  it('identifies generated content while retaining only distinct lines', () => {
    const content = Array.from({ length: 10_000 }, (_, index) => `generated-${index % 4}`).join(
      '\n'
    );

    expect(analyzeContentRepetition(content)).toEqual({
      inspectedLines: 10_000,
      isHighlyRepetitive: true,
      kind: 'analyzed',
      totalLines: 10_000,
      uniqueLines: 4,
    });
    expect(shouldSkipChunking(content, {}, Number.POSITIVE_INFINITY)).toEqual({
      reason: 'Highly repetitive content (likely generated file)',
      skip: true,
    });
  });

  it('stops retaining unique lines once diversity proves content is not repetitive', () => {
    const content = Array.from({ length: 10_000 }, (_, index) => `unique-${index}`).join('\n');

    expect(analyzeContentRepetition(content)).toEqual({
      inspectedLines: 1000,
      isHighlyRepetitive: false,
      kind: 'analyzed',
      totalLines: 10_000,
      uniqueLines: 1000,
    });
  });
});

describe('detectCodeLanguage', () => {
  it('matches default extension patterns case-insensitively', () => {
    expect(detectCodeLanguage('App.TSX')).toBe('typescript');
    expect(detectCodeLanguage('component.vue')).toBe('javascript');
    expect(detectCodeLanguage('main.rs')).toBe('rust');
  });

  it('returns null for files outside every pattern', () => {
    expect(detectCodeLanguage('README.md')).toBeNull();
  });

  it('consults only the caller-provided patterns when given', () => {
    const patterns = [{ language: 'sql', pattern: /\.sql$/i }] as const;

    expect(detectCodeLanguage('query.SQL', patterns)).toBe('sql');
    expect(detectCodeLanguage('main.ts', patterns)).toBeNull();
  });
});

describe('shouldSkipChunking', () => {
  it('skips lock files by name and dependency paths via the filePath fallback', () => {
    expect(shouldSkipChunking('{}', { fileName: 'package-lock.json' }, 1_000_000)).toEqual({
      reason: 'Lock file or dependency manifest: package-lock.json',
      skip: true,
    });
    expect(
      shouldSkipChunking('code', { filePath: 'repo/node_modules/pkg/index.js' }, 1_000_000).skip
    ).toBe(true);
  });

  it('skips empty content explicitly instead of forwarding it to token sizing', () => {
    expect(shouldSkipChunking('', {}, 1_000_000)).toEqual({
      reason: 'Empty file content',
      skip: true,
    });
  });

  it('detects NUL bytes only within the binary probe window', () => {
    expect(shouldSkipChunking('a\u0000b', {}, 1_000_000)).toEqual({
      reason: 'Binary content detected (NUL bytes present)',
      skip: true,
    });

    const nulBeyondProbe = `${'a'.repeat(4096)}\u0000`;
    expect(shouldSkipChunking(nulBeyondProbe, {}, 1_000_000)).toEqual({ skip: false });
  });

  it('reports oversize content in kilobytes unless large files are allowed', () => {
    const content = 'x'.repeat(2048);

    expect(shouldSkipChunking(content, {}, 1024)).toEqual({
      reason: 'File too large: 2KB (max: 1KB)',
      skip: true,
    });
    expect(shouldSkipChunking(content, { allowLargeFiles: true }, 1024)).toEqual({
      skip: false,
    });
  });
});

describe('resolveMaxTokensCap', () => {
  it('falls back to the safety cap for absent, non-finite, or non-positive caps', () => {
    expect(resolveMaxTokensCap(undefined, 8192, 2048)).toBe(2048);
    expect(resolveMaxTokensCap(Number.POSITIVE_INFINITY, 8192, 2048)).toBe(2048);
    expect(resolveMaxTokensCap(0, 8192, 2048)).toBe(2048);
    expect(resolveMaxTokensCap(-10, 8192, 2048)).toBe(2048);
  });

  it('floors fractional caps and bounds the result to [256, hard limit]', () => {
    expect(resolveMaxTokensCap(300.9, 8192, 2048)).toBe(300);
    expect(resolveMaxTokensCap(100, 8192, 2048)).toBe(256);
    expect(resolveMaxTokensCap(999_999, 8192, 2048)).toBe(8192);
  });
});

describe('adjustChunkingForFileType', () => {
  const config: ChunkAdjustmentConfig<'typescript' | 'python'> = {
    // Deliberately omits `python`: exercises the `languageDefaults ??
    // codeMaxTokens` fallback for languages a pattern can detect but the
    // defaults table does not size.
    codeLanguageDefaults: { typescript: { maxTokens: 512, overlap: 64 } },
    codeMaxTokens: 400,
    codeOverlap: 40,
    defaultMaxTokens: 800,
    defaultOverlap: 80,
    largeStructuredMaxTokens: 300,
    largeStructuredOverlap: 30,
    maxChunkableSize: 1_000_000,
    maxTokensHardLimit: 8192,
    maxTokensSafetyCap: 2048,
    overlapHardLimit: 1024,
    overlapSafetyCap: 256,
    veryLargeContentThreshold: 10_000,
    veryLargeMaxTokens: 200,
    veryLargeOverlap: 20,
  };

  const detectLanguage = (fileName: string): 'typescript' | 'python' | null => {
    if (fileName.endsWith('.ts')) {
      return 'typescript';
    }
    if (fileName.endsWith('.py')) {
      return 'python';
    }
    return null;
  };

  it('uses config defaults when no recommendation or explicit option applies', () => {
    expect(adjustChunkingForFileType('short', {}, config, detectLanguage)).toEqual({
      maxTokens: 800,
      overlap: 80,
    });
  });

  it('applies per-language defaults, falling back to generic code sizing', () => {
    expect(adjustChunkingForFileType('code', { fileName: 'a.ts' }, config, detectLanguage)).toEqual(
      { maxTokens: 512, overlap: 64 }
    );
    expect(adjustChunkingForFileType('code', { fileName: 'a.py' }, config, detectLanguage)).toEqual(
      { maxTokens: 400, overlap: 40 }
    );
  });

  it('caps large structured files and stacks the very-large cap by minimum', () => {
    expect(
      adjustChunkingForFileType('rows', { fileName: 'data.json' }, config, detectLanguage)
    ).toEqual({ maxTokens: 300, overlap: 30 });

    const veryLarge = 'y'.repeat(10_001);
    expect(
      adjustChunkingForFileType(veryLarge, { fileName: 'data.json' }, config, detectLanguage)
    ).toEqual({ maxTokens: 200, overlap: 20 });
  });

  it('keeps explicit maxTokens over recommendations while overlap still follows them', () => {
    expect(
      adjustChunkingForFileType(
        'code',
        { fileName: 'a.ts', maxTokens: 700 },
        config,
        detectLanguage
      )
    ).toEqual({ maxTokens: 700, overlap: 64 });
  });

  it('clamps explicit values to the hard limits, not the safety caps', () => {
    expect(
      adjustChunkingForFileType(
        'code',
        { maxTokens: 999_999, overlap: 5000 },
        config,
        detectLanguage
      )
    ).toEqual({ maxTokens: 8192, overlap: 1024 });
  });

  it('bounds non-explicit recommendations by the sanitized maxTokensCap', () => {
    expect(
      adjustChunkingForFileType(
        'code',
        { fileName: 'a.ts', maxTokensCap: 300 },
        config,
        detectLanguage
      )
    ).toEqual({ maxTokens: 300, overlap: 64 });
  });

  it('forces overlap strictly below maxTokens', () => {
    expect(
      adjustChunkingForFileType('code', { maxTokens: 50, overlap: 50 }, config, detectLanguage)
    ).toEqual({ maxTokens: 50, overlap: 49 });
  });

  it('ignores file-type recommendations on request', () => {
    expect(
      adjustChunkingForFileType(
        'code',
        { fileName: 'a.ts', ignoreFileTypeRecommendations: true },
        config,
        detectLanguage
      )
    ).toEqual({ maxTokens: 800, overlap: 80 });
  });

  it('treats non-finite explicit values as the config defaults', () => {
    // Pins the CURRENT coercion semantics (normalize's Number.isFinite
    // fallback, minimum 1 for maxTokens vs 0 for overlap). Whether malformed
    // explicit sizing should reject instead is a behavior-policy question for
    // its own change — chunking-worker's local duplicate shares these
    // semantics, so a flip must land in both.
    expect(
      adjustChunkingForFileType('code', { maxTokens: Number.NaN }, config, detectLanguage)
    ).toEqual({ maxTokens: 800, overlap: 80 });
    expect(
      adjustChunkingForFileType('code', { overlap: Number.NaN }, config, detectLanguage)
    ).toEqual({ maxTokens: 800, overlap: 80 });
  });
});

describe('AST helpers', () => {
  it('recognizes exactly the function-like node types', () => {
    for (const type of [
      'FunctionDeclaration',
      'FunctionExpression',
      'ArrowFunctionExpression',
      'ObjectMethod',
      'ClassMethod',
      'ClassPrivateMethod',
      'TSDeclareFunction',
      'TSMethodSignature',
      'TSCallSignatureDeclaration',
    ]) {
      expect(isFunctionNode(type)).toBe(true);
    }
    expect(isFunctionNode('VariableDeclaration')).toBe(false);
    expect(isFunctionNode(undefined)).toBe(false);
    expect(isFunctionNode('')).toBe(false);
  });

  it('narrows AST nodes structurally', () => {
    expect(isAstNode({ type: 'Program' })).toBe(true);
    expect(isAstNode(null)).toBe(false);
    expect(isAstNode(42)).toBe(false);
    expect(isAstNode({ start: 0 })).toBe(false);
  });

  it('collects only container-parented function ranges with finite bounds, sorted', () => {
    const ast: AstNode = {
      body: [
        {
          declaration: { end: 90, start: 67, type: 'FunctionDeclaration' },
          end: 90,
          start: 60,
          type: 'ExportNamedDeclaration',
        },
        { end: 30, start: 0, type: 'FunctionDeclaration' },
        {
          declarations: [
            {
              init: { end: 55, start: 40, type: 'ArrowFunctionExpression' },
              type: 'VariableDeclarator',
            },
          ],
          end: 56,
          start: 32,
          type: 'VariableDeclaration',
        },
        {
          body: {
            body: [{ end: 120, start: 100, type: 'ClassMethod' }],
            type: 'ClassBody',
          },
          end: 121,
          start: 95,
          type: 'ClassDeclaration',
        },
        { type: 'FunctionDeclaration' },
      ],
      type: 'Program',
    };

    expect(getTopLevelFunctionRanges(ast)).toEqual([
      { end: 30, start: 0 },
      { end: 90, start: 67 },
      { end: 120, start: 100 },
    ]);
  });

  it('returns no ranges for a missing AST', () => {
    expect(getTopLevelFunctionRanges(null)).toEqual([]);
  });
});

describe('getCodeSeparators', () => {
  it('returns a faithful defensive copy of custom separators', () => {
    const custom = ['\nA'];
    const result = getCodeSeparators(custom);
    result.push('X');

    expect(result).toEqual(['\nA', 'X']);
    expect(custom).toEqual(['\nA']);
  });

  it('falls back to a fresh copy of the shared defaults for empty input', () => {
    const first = getCodeSeparators([]);
    const second = getCodeSeparators();

    expect(first[0]).toBe('\n\n');
    expect(first.at(-1)).toBe('');
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});

describe('splitCodeByFunctionRanges', () => {
  const fnA = 'function a() { return 1; }';
  const fnB = 'function b() { return 2; }';
  const content = `head\n\n${fnA}\n\nmid\n\n${fnB}\n\ntail`;
  const rangeOf = (needle: string) => {
    const start = content.indexOf(needle);
    return { end: start + needle.length, start };
  };

  it('returns null when no ranges are available', async () => {
    await expect(
      splitCodeByFunctionRanges(content, {
        maxChars: 200,
        overlapChars: 0,
        ranges: [],
        separators: getCodeSeparators(),
      })
    ).resolves.toBeNull();
  });

  it('emits gap and range segments in document order', async () => {
    await expect(
      splitCodeByFunctionRanges(content, {
        maxChars: 200,
        overlapChars: 0,
        ranges: [rangeOf(fnA), rangeOf(fnB)],
        separators: getCodeSeparators(),
      })
    ).resolves.toEqual(['head', fnA, 'mid', fnB, 'tail']);
  });

  it('pads ranges with the requested character overlap', async () => {
    const pieces = await splitCodeByFunctionRanges(content, {
      maxChars: 200,
      overlapChars: 4,
      ranges: [rangeOf(fnA)],
      separators: getCodeSeparators(),
    });

    // Fully deterministic: the range is padded by exactly overlapChars on
    // each side, the leading gap stays unpadded, and the trailing remainder
    // is emitted from the unpadded cursor.
    expect(pieces).toEqual(['head', content.slice(2, 36).trim(), content.slice(32).trim()]);
  });

  it('keeps segments within the oversize tolerance intact and re-splits beyond it', async () => {
    const tolerated = 'x'.repeat(12);
    await expect(
      splitCodeByFunctionRanges(tolerated, {
        maxChars: 10,
        overlapChars: 0,
        ranges: [{ end: 12, start: 0 }],
        separators: getCodeSeparators(),
      })
    ).resolves.toEqual([tolerated]);

    const oversize = Array.from({ length: 10 }, (_, index) => `word${index}`).join(' ');
    const pieces = await splitCodeByFunctionRanges(oversize, {
      maxChars: 10,
      overlapChars: 0,
      ranges: [{ end: oversize.length, start: 0 }],
      separators: getCodeSeparators(),
    });

    expect(pieces?.length).toBeGreaterThan(1);
    expect(pieces?.every((piece) => piece.length <= 10)).toBe(true);
  });

  it('clamps out-of-bounds ranges to the content', async () => {
    await expect(
      splitCodeByFunctionRanges('short', {
        maxChars: 200,
        overlapChars: 0,
        ranges: [{ end: 10_000, start: -5 }],
        separators: getCodeSeparators(),
      })
    ).resolves.toEqual(['short']);
  });
});

describe('splitByBlankLines', () => {
  it('groups lines between blank lines, stripping carriage returns', () => {
    expect(splitByBlankLines('a\r\nb\n\n\nc\n')).toEqual(['a\nb', 'c']);
  });

  it('returns nothing for blank-only input', () => {
    expect(splitByBlankLines('')).toEqual([]);
    expect(splitByBlankLines('\n \n')).toEqual([]);
  });
});

describe('splitMarkdownIntoBlocks', () => {
  it('separates headings, paragraphs, and fenced code with their metadata', () => {
    const content = [
      '# Title',
      '',
      'intro one',
      'intro two',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      'tail',
    ].join('\n');

    expect(splitMarkdownIntoBlocks(content)).toEqual([
      { meta: { heading: 'Title' }, text: '# Title' },
      { meta: {}, text: 'intro one\nintro two' },
      { meta: { isFence: true }, text: '```ts\nconst x = 1;\n```' },
      { meta: {}, text: 'tail' },
    ]);
  });

  it('consumes an unclosed fence to the end of the document', () => {
    expect(splitMarkdownIntoBlocks('```\ncode')).toEqual([
      { meta: { isFence: true }, text: '```\ncode' },
    ]);
  });

  it('closes tilde fences only with at least the opening run length', () => {
    expect(splitMarkdownIntoBlocks('~~~~\nx\n~~~\n~~~~~\nafter')).toEqual([
      { meta: { isFence: true }, text: '~~~~\nx\n~~~\n~~~~~' },
      { meta: {}, text: 'after' },
    ]);
  });
});

describe('findBalancedSplitPoint', () => {
  it('splits after the strongest separator nearest the midpoint', () => {
    const content = 'aaaa\n\nbbbb';

    expect(findBalancedSplitPoint(content)).toBe(6);
    expect(content.slice(0, 6)).toBe('aaaa\n\n');
  });

  it('searches forward when the separator only occurs after the midpoint', () => {
    expect(findBalancedSplitPoint('abcdef. gh')).toBe(8);
  });

  it('falls back to the midpoint when no separator exists', () => {
    expect(findBalancedSplitPoint('abcdefgh')).toBe(4);
    expect(findBalancedSplitPoint('ab')).toBe(1);
  });
});

describe('assertTokenBudgetIterationsWithinLimit', () => {
  it('permits iteration counts at or below the limit', () => {
    expect(() => assertTokenBudgetIterationsWithinLimit(5, 5)).not.toThrow();
  });

  it('rejects runaway token-budget loops with the limit in the message', () => {
    expect(() => assertTokenBudgetIterationsWithinLimit(6, 5)).toThrow(
      'splitChunkToTokenBudget exceeded 5 iterations for a single chunk'
    );
  });
});
