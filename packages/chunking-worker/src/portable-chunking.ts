/**
 * Portable chunking logic that can run in a Web Worker.
 * Extracted from @brainstrike/db ChunkingService, removing all database dependencies.
 */

import type { ParserPlugin } from '@babel/parser';
import {
  countTokensHeuristic,
  RecursiveTextSplitter,
  type ResolvedChunkingStrategy,
  resolveChunkingStrategyForFile,
  resolveEffectiveChunkingStrategy,
  splitTextByStrategy,
} from '@brainstrike/text-splitter';
import {
  splitByBlankLines,
  splitMarkdownIntoBlocks,
} from '@brainstrike/text-splitter/chunking-core';
import { CHUNKING_CONFIG, type CodeLanguage } from './chunking-config';
import type { ChunkingRequestOptions, ChunkType, PortableChunk } from './shared';

const BINARY_DETECTION_PROBE_BYTES = 4096;
const REPETITIVE_CONTENT_LINE_THRESHOLD = 1000;
const REPETITIVE_CONTENT_UNIQUE_RATIO = 0.1;
const CHARS_PER_TOKEN_SAMPLE_BYTES = 10_000;
const CHARS_PER_TOKEN_MAX = 8;

export interface PortableChunkingResult {
  avgTokensPerChunk: number;
  chunks: PortableChunk[];
  skipped: boolean;
  skipReason?: string;
  strategyUsed: ResolvedChunkingStrategy;
  totalTokens: number;
}

interface SourceRange {
  endLine: number;
  endOffset: number;
  startLine: number;
  startOffset: number;
}

// File patterns that should be skipped or handled differently
const SKIP_CHUNKING_PATTERNS = [
  /package-lock\.json$/i,
  /pnpm-lock\.yaml$/i,
  /yarn\.lock$/i,
  /composer\.lock$/i,
  /Gemfile\.lock$/i,
  /Pipfile\.lock$/i,
  /poetry\.lock$/i,
  /go\.sum$/i,
  /Cargo\.lock$/i,
  /npm-shrinkwrap\.json$/i,
  /\.min\.[jt]s$/i,
  /\.map$/i,
  /\.wasm$/i,
  /\.bin$/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)dist(\/|$)/i,
  /(^|\/)build(\/|$)/i,
  /(^|\/)coverage(\/|$)/i,
];

const CODE_LANGUAGE_PATTERNS: Array<{ pattern: RegExp; language: CodeLanguage }> = [
  { pattern: /\.vue$/i, language: 'javascript' },
  { pattern: /\.svelte$/i, language: 'javascript' },
  { pattern: /\.(ts|tsx|mts|cts)$/i, language: 'typescript' },
  { pattern: /\.(js|jsx|mjs|cjs)$/i, language: 'javascript' },
  { pattern: /\.mm$/i, language: 'cpp' },
  { pattern: /\.m$/i, language: 'cpp' },
  { pattern: /\.py$/i, language: 'python' },
  { pattern: /\.rs$/i, language: 'rust' },
  { pattern: /\.go$/i, language: 'go' },
  { pattern: /\.(java|class)$/i, language: 'java' },
  { pattern: /\.cs$/i, language: 'csharp' },
  { pattern: /\.(c|cc|cpp|cxx|h|hh|hpp)$/i, language: 'cpp' },
  { pattern: /\.rb$/i, language: 'ruby' },
  { pattern: /\.php$/i, language: 'php' },
  { pattern: /\.swift$/i, language: 'swift' },
  { pattern: /\.(kt|kts)$/i, language: 'kotlin' },
];

const LARGE_STRUCTURED_PATTERNS = [
  /\.json$/i,
  /\.xml$/i,
  /\.csv$/i,
  /\.tsv$/i,
  /\.sql$/i,
  /\.log$/i,
];

type AstNode = {
  type?: string;
  start?: number;
  end?: number;
} & Record<string, unknown>;

type BabelParserModule = typeof import('@babel/parser');
type TokenUtilsLiteModule = typeof import('./token-utils-lite');

let babelParserModulePromise: Promise<BabelParserModule> | null = null;
let tokenUtilsLiteModulePromise: Promise<TokenUtilsLiteModule> | null = null;

async function loadBabelParserModule(): Promise<BabelParserModule> {
  if (!babelParserModulePromise) {
    babelParserModulePromise = import('@babel/parser').catch((error: unknown) => {
      babelParserModulePromise = null;
      throw error;
    });
  }
  return babelParserModulePromise;
}

async function loadTokenUtilsLiteModule(): Promise<TokenUtilsLiteModule> {
  if (!tokenUtilsLiteModulePromise) {
    tokenUtilsLiteModulePromise = import('./token-utils-lite').catch((error: unknown) => {
      tokenUtilsLiteModulePromise = null;
      throw error;
    });
  }
  return tokenUtilsLiteModulePromise;
}

function detectCodeLanguage(fileName: string): CodeLanguage | null {
  const name = fileName.toLowerCase();
  for (const { pattern, language } of CODE_LANGUAGE_PATTERNS) {
    if (pattern.test(name)) {
      return language;
    }
  }
  return null;
}

function shouldSkipChunking(
  content: string,
  options: ChunkingRequestOptions & { fileName?: string; filePath?: string }
): { skip: boolean; reason?: string } {
  const fileName = options.fileName || options.filePath || '';
  for (const pattern of SKIP_CHUNKING_PATTERNS) {
    if (pattern.test(fileName)) {
      return {
        skip: true,
        reason: `Lock file or dependency manifest: ${fileName}`,
      };
    }
  }

  // Zero-byte files are valid repository inputs. Skip them explicitly so the
  // worker never treats an empty accurate token count as a chunking failure.
  if (content.length === 0) {
    return { skip: true, reason: 'Empty file content' };
  }

  // Skip binary-like content early (NUL bytes in the first few KB)
  const probeWindow = content.slice(0, BINARY_DETECTION_PROBE_BYTES);
  if (probeWindow.includes('\u0000')) {
    return { skip: true, reason: 'Binary content detected (NUL bytes present)' };
  }

  // Check content size
  if (!options.allowLargeFiles && content.length > CHUNKING_CONFIG.maxChunkableSize) {
    return {
      skip: true,
      reason: `File too large: ${Math.round(content.length / 1024)}KB (max: ${Math.round(
        CHUNKING_CONFIG.maxChunkableSize / 1024
      )}KB)`,
    };
  }

  // Check for very repetitive content (common in generated files)
  const allLines = content.split('\n');
  const uniqueLines = new Set(allLines).size;
  const totalLines = allLines.length;
  if (
    totalLines > REPETITIVE_CONTENT_LINE_THRESHOLD &&
    uniqueLines / totalLines < REPETITIVE_CONTENT_UNIQUE_RATIO
  ) {
    return {
      skip: true,
      reason: 'Highly repetitive content (likely generated file)',
    };
  }

  return { skip: false };
}

function resolveMaxTokensCap(cap?: number): number {
  if (!Number.isFinite(cap ?? Number.NaN)) {
    return CHUNKING_CONFIG.maxTokensSafetyCap;
  }
  const sanitized = Math.floor(cap as number);
  if (sanitized <= 0) {
    return CHUNKING_CONFIG.maxTokensSafetyCap;
  }
  return Math.max(256, Math.min(CHUNKING_CONFIG.maxTokensHardLimit, sanitized));
}

function adjustChunkingForFileType(
  content: string,
  options: ChunkingRequestOptions & { fileName?: string; filePath?: string }
): { maxTokens: number; overlap: number } {
  const fileName = options.fileName || options.filePath || '';
  const ignoreRecommendations = options.ignoreFileTypeRecommendations === true;
  const maxTokensCap = resolveMaxTokensCap(options.maxTokensCap);

  const normalize = (value: number | undefined, fallback: number, minimum: number): number => {
    const candidate = Number.isFinite(value) ? (value as number) : fallback;
    return Math.max(minimum, Math.floor(candidate));
  };

  const requestedMaxTokens = options.maxTokens;
  const requestedOverlap = options.overlap;
  const hasExplicitMaxTokens = requestedMaxTokens !== undefined;
  const hasExplicitOverlap = requestedOverlap !== undefined;

  let maxTokens = hasExplicitMaxTokens
    ? normalize(requestedMaxTokens, CHUNKING_CONFIG.defaultMaxTokens, 1)
    : Number.POSITIVE_INFINITY;
  let overlap = hasExplicitOverlap
    ? normalize(requestedOverlap, CHUNKING_CONFIG.defaultOverlap, 0)
    : Number.POSITIVE_INFINITY;

  interface ChunkAdjustment {
    maxTokens: number;
    overlap: number;
  }
  const apply = (state: ChunkAdjustment, cap: Partial<ChunkAdjustment>) => {
    const next: ChunkAdjustment = { ...state };
    if (typeof cap.maxTokens === 'number') {
      next.maxTokens = Math.min(state.maxTokens, cap.maxTokens);
    }
    if (typeof cap.overlap === 'number') {
      next.overlap = Math.min(state.overlap, cap.overlap);
    }
    return next;
  };

  if (!ignoreRecommendations) {
    const adjustments: Array<(state: ChunkAdjustment) => ChunkAdjustment> = [];
    const codeLanguage = detectCodeLanguage(fileName);
    const isCode = Boolean(codeLanguage);
    if (isCode) {
      adjustments.push((state) => {
        const cap: Partial<ChunkAdjustment> = {};
        const languageDefaults = codeLanguage
          ? CHUNKING_CONFIG.codeLanguageDefaults[codeLanguage]
          : undefined;
        if (!hasExplicitMaxTokens) {
          cap.maxTokens = languageDefaults?.maxTokens ?? CHUNKING_CONFIG.codeMaxTokens;
        }
        if (!hasExplicitOverlap) {
          cap.overlap = languageDefaults?.overlap ?? CHUNKING_CONFIG.codeOverlap;
        }
        return apply(state, cap);
      });
    }

    const matchesStructured = LARGE_STRUCTURED_PATTERNS.some((pattern) => pattern.test(fileName));
    if (matchesStructured) {
      adjustments.push((state) => {
        const cap: Partial<ChunkAdjustment> = {};
        if (!hasExplicitMaxTokens) {
          cap.maxTokens = CHUNKING_CONFIG.largeStructuredMaxTokens;
        }
        if (!hasExplicitOverlap) {
          cap.overlap = CHUNKING_CONFIG.largeStructuredOverlap;
        }
        return apply(state, cap);
      });
    }

    const exceedsVeryLargeThreshold = content.length > CHUNKING_CONFIG.veryLargeContentThreshold;
    if (exceedsVeryLargeThreshold) {
      adjustments.push((state) => {
        const cap: Partial<ChunkAdjustment> = {};
        if (!hasExplicitMaxTokens) {
          cap.maxTokens = CHUNKING_CONFIG.veryLargeMaxTokens;
        }
        if (!hasExplicitOverlap) {
          cap.overlap = CHUNKING_CONFIG.veryLargeOverlap;
        }
        return apply(state, cap);
      });
    }

    let state: ChunkAdjustment = { maxTokens, overlap };
    for (const adjust of adjustments) {
      state = adjust(state);
    }
    maxTokens = state.maxTokens;
    overlap = state.overlap;
  }

  const clamp = (value: number, fallback: number, limit: number) => {
    if (!Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(1, Math.min(value, limit));
  };

  const resolveLimit = (hardLimit: number, safetyCap: number, explicit: boolean) =>
    explicit ? hardLimit : Math.min(hardLimit, safetyCap);

  const maxTokensLimit = resolveLimit(
    CHUNKING_CONFIG.maxTokensHardLimit,
    maxTokensCap,
    hasExplicitMaxTokens
  );
  const overlapLimit = resolveLimit(
    CHUNKING_CONFIG.overlapHardLimit,
    CHUNKING_CONFIG.overlapSafetyCap,
    hasExplicitOverlap
  );

  maxTokens = clamp(maxTokens, CHUNKING_CONFIG.defaultMaxTokens, maxTokensLimit);
  overlap = clamp(overlap, CHUNKING_CONFIG.defaultOverlap, overlapLimit);

  if (overlap >= maxTokens) {
    overlap = Math.max(0, maxTokens - 1);
  }

  return { maxTokens, overlap };
}

const HEX_BYTE_TABLE: readonly string[] = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, '0')
);

async function generateContentHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hashBuffer);
  let hex = '';
  for (const byte of bytes) {
    hex += HEX_BYTE_TABLE[byte];
  }
  return hex;
}

function estimateTokenCount(text: string): number {
  return countTokensHeuristic(text);
}

function buildLineStartOffsets(content: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lineStarts.push(index + 1);
    }
  }
  return lineStarts;
}

function findLineForOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  let best = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const lineStart = lineStarts[mid] ?? 0;
    if (lineStart <= offset) {
      best = mid;
      low = mid + 1;
      continue;
    }
    high = mid - 1;
  }

  return best + 1;
}

function findNextNonWhitespaceOffset(content: string, startOffset: number): number {
  let offset = startOffset;
  while (offset < content.length) {
    const character = content[offset];
    if (!isSourceWhitespace(character)) {
      break;
    }
    offset += 1;
  }
  return offset;
}

function isSourceWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

function sourceWhitespaceRunHasLineBreak(
  content: string,
  startOffset: number,
  endOffset: number
): boolean {
  for (let offset = startOffset; offset < endOffset; offset += 1) {
    const character = content[offset];
    if (character === '\n' || character === '\r') {
      return true;
    }
  }
  return false;
}

function canSkipElidedSourceWhitespace(
  content: string,
  contentOffset: number,
  chunkChar: string | undefined
): number | null {
  if (!isSourceWhitespace(content[contentOffset])) {
    return null;
  }

  const nextSourceOffset = findNextNonWhitespaceOffset(content, contentOffset);
  if (
    nextSourceOffset <= contentOffset ||
    !sourceWhitespaceRunHasLineBreak(content, contentOffset, nextSourceOffset) ||
    content[nextSourceOffset] !== chunkChar
  ) {
    return null;
  }

  return nextSourceOffset;
}

function findSourceMatchEndOffset(
  content: string,
  chunkContent: string,
  candidateOffset: number
): number | null {
  let contentOffset = candidateOffset;
  let chunkOffset = 0;

  while (chunkOffset < chunkContent.length && contentOffset < content.length) {
    const chunkChar = chunkContent[chunkOffset];
    const sourceChar = content[contentOffset];
    const skippedWhitespaceOffset = canSkipElidedSourceWhitespace(
      content,
      contentOffset,
      chunkChar
    );

    if (skippedWhitespaceOffset !== null) {
      contentOffset = skippedWhitespaceOffset;
      continue;
    }

    if (chunkChar === '\n' && sourceChar === '\r' && content[contentOffset + 1] === '\n') {
      chunkOffset += 1;
      contentOffset += 2;
      continue;
    }

    if (chunkChar !== sourceChar) {
      return null;
    }

    chunkOffset += 1;
    contentOffset += 1;
  }

  return chunkOffset === chunkContent.length ? contentOffset : null;
}

function findSourceRangeForChunkContent(
  content: string,
  chunkContent: string,
  searchStart: number
): { endOffset: number; startOffset: number } | null {
  const exactStartOffset = content.indexOf(chunkContent, searchStart);
  if (exactStartOffset >= 0) {
    return {
      startOffset: exactStartOffset,
      endOffset: exactStartOffset + chunkContent.length,
    };
  }

  const firstCharacter = chunkContent[0];
  if (firstCharacter === undefined) {
    return null;
  }

  let candidateOffset = content.indexOf(firstCharacter, searchStart);
  while (candidateOffset >= 0) {
    const endOffset = findSourceMatchEndOffset(content, chunkContent, candidateOffset);
    if (endOffset !== null) {
      return {
        startOffset: candidateOffset,
        endOffset,
      };
    }

    candidateOffset = content.indexOf(firstCharacter, candidateOffset + 1);
  }

  return null;
}

function resolveSourceRanges(
  content: string,
  chunks: readonly { content: string }[],
  overlapChars: number
): SourceRange[] {
  const lineStarts = buildLineStartOffsets(content);
  let searchStart = 0;

  return chunks.map((chunk, index) => {
    const sourceRange = findSourceRangeForChunkContent(content, chunk.content, searchStart);
    if (!sourceRange) {
      throw new Error(`Unable to resolve source range for chunk ${index}`);
    }

    const { startOffset, endOffset } = sourceRange;
    searchStart = Math.max(0, endOffset - overlapChars - 1);

    return {
      startOffset,
      endOffset,
      startLine: findLineForOffset(lineStarts, startOffset),
      endLine: findLineForOffset(lineStarts, Math.max(startOffset, endOffset - 1)),
    };
  });
}

async function computeCharsPerToken(
  content: string,
  useAccurate: boolean,
  tokenUtilsModule: TokenUtilsLiteModule | null
): Promise<number> {
  const sample = content.slice(0, Math.min(CHARS_PER_TOKEN_SAMPLE_BYTES, content.length));
  const tokens =
    useAccurate && tokenUtilsModule
      ? await tokenUtilsModule.countTokensAccurate(sample)
      : estimateTokenCount(sample);
  if (Number.isFinite(tokens) && tokens > 0) {
    const measured = sample.length / tokens;
    return Math.max(1, Math.min(CHARS_PER_TOKEN_MAX, measured));
  }
  if (useAccurate) {
    // The worker path is intentionally fail-fast here. Unlike the service path,
    // this runtime should surface invalid accurate token counts as a hard chunk
    // failure rather than quietly degrading inside the hidden host/browser worker.
    throw new Error('Accurate token counting produced an invalid token count');
  }
  return Number(CHUNKING_CONFIG.averageCharsPerToken);
}

// AST helpers
function isFunctionNode(type?: string): boolean {
  if (!type) {
    return false;
  }
  return (
    type === 'FunctionDeclaration' ||
    type === 'FunctionExpression' ||
    type === 'ArrowFunctionExpression' ||
    type === 'ObjectMethod' ||
    type === 'ClassMethod' ||
    type === 'ClassPrivateMethod' ||
    type === 'TSDeclareFunction' ||
    type === 'TSMethodSignature' ||
    type === 'TSCallSignatureDeclaration'
  );
}

function isAstNode(value: unknown): value is AstNode {
  return Boolean(
    value && typeof value === 'object' && 'type' in (value as Record<string, unknown>)
  );
}

function isTopLevelContainerType(type?: string): boolean {
  return (
    type === 'Program' ||
    type === 'ExportNamedDeclaration' ||
    type === 'ExportDefaultDeclaration' ||
    type === 'ClassBody'
  );
}

function iterateAstChildren(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) {
          children.push(child);
        }
      }
    } else if (isAstNode(value)) {
      children.push(value);
    }
  }
  return children;
}

/**
 * Collect top-level function ranges from the AST.
 * Uses mutating push/pop pattern for ancestors to avoid creating intermediate arrays.
 */
function collectTopLevelFunctionRanges(
  node: AstNode | null,
  ancestors: AstNode[],
  ranges: Array<{ start: number; end: number }>
): void {
  if (!node) {
    return;
  }

  const nodeType = node.type ?? '';
  const parentType = ancestors.at(-1)?.type;
  if (
    isTopLevelContainerType(parentType) &&
    isFunctionNode(nodeType) &&
    Number.isFinite(node.start) &&
    Number.isFinite(node.end)
  ) {
    ranges.push({ start: Number(node.start), end: Number(node.end) });
  }

  // Use push/pop pattern instead of creating new arrays on every call
  ancestors.push(node);
  for (const child of iterateAstChildren(node)) {
    collectTopLevelFunctionRanges(child, ancestors, ranges);
  }
  ancestors.pop();
}

function getCodeSeparators(custom?: string[]) {
  if (custom?.length) {
    return custom;
  }
  return [
    '\n\n',
    '\nexport default ',
    '\nexport class ',
    '\nclass ',
    '\nexport function ',
    '\nfunction ',
    '\nexport const ',
    '\nconst ',
    '\nlet ',
    '\nvar ',
    '\nexport interface ',
    '\ninterface ',
    '\ntype ',
    '\nimport ',
    '\ndescribe(',
    '\nit(',
    '\nelse ',
    '\ntry {',
    '\ncatch (',
    '\nfinally {',
    '\nswitch (',
    '\n}',
    '\n};',
    '\n',
    ';',
    ',',
    ' ',
    '',
  ];
}

async function splitCodeByFunctions(
  content: string,
  {
    maxChars,
    overlapChars,
    language,
    separators,
  }: { maxChars: number; overlapChars: number; language: CodeLanguage | null; separators: string[] }
): Promise<string[] | null> {
  const { parse } = await loadBabelParserModule();
  const plugins: ParserPlugin[] = [
    'classProperties',
    'classPrivateProperties',
    'classPrivateMethods',
    'decorators-legacy',
    'dynamicImport',
    'importAttributes',
    'topLevelAwait',
    'jsx',
  ];

  if (language === 'typescript') {
    plugins.push('typescript');
  }

  let ast: AstNode | null = null;
  try {
    ast = parse(content, {
      sourceType: 'module',
      plugins,
      errorRecovery: true,
      allowReturnOutsideFunction: true,
    }) as unknown as AstNode;
  } catch (err) {
    // Log at debug level to help diagnose why code isn't being chunked at function boundaries
    // biome-ignore lint/suspicious/noConsole: debug logging for AST parsing failures
    console.debug('[portable-chunking] AST parsing failed for function-level splitting', {
      language,
      contentLength: content.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const ranges: Array<{ start: number; end: number }> = [];
  collectTopLevelFunctionRanges(ast, [], ranges);

  if (!ranges.length) {
    return null;
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);

  const pieces: string[] = [];
  let cursor = 0;

  const recursiveChunker = new RecursiveTextSplitter({
    chunkSize: maxChars,
    chunkOverlap: overlapChars,
    separators,
  });

  const pushSegment = async (segment: string) => {
    const trimmed = segment.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed.length <= maxChars * 1.25) {
      pieces.push(trimmed);
      return;
    }
    const subPieces = await recursiveChunker.splitText(trimmed);
    pieces.push(...subPieces.map((piece: string) => piece.trim()).filter(Boolean));
  };

  const appendRange = async (startIndex: number, endIndex: number) => {
    const safeStart = Math.max(0, Math.min(startIndex, content.length));
    const safeEnd = Math.max(safeStart, Math.min(endIndex, content.length));
    await pushSegment(content.slice(safeStart, safeEnd));
  };

  for (const range of ranges) {
    const clampedStart = Math.max(0, Math.min(range.start, content.length));
    const clampedEnd = Math.max(clampedStart, Math.min(range.end, content.length));

    if (clampedStart > cursor) {
      await appendRange(cursor, clampedStart);
    }

    const paddedStart = Math.max(0, clampedStart - overlapChars);
    const paddedEnd = Math.min(content.length, clampedEnd + overlapChars);
    await appendRange(paddedStart, paddedEnd);
    cursor = clampedEnd;
  }

  if (cursor < content.length) {
    await appendRange(cursor, content.length);
  }

  return pieces;
}

/**
 * Main entry point for chunking content in the worker.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Chunking strategy routing is intentionally branching.
export async function chunkContent(
  content: string,
  options: ChunkingRequestOptions & { fileName?: string; filePath?: string }
): Promise<PortableChunkingResult> {
  const initialStrategy = resolveChunkingStrategyForFile(
    options.filePath ?? options.fileName ?? '',
    options.strategy
  );
  // Check if we should skip this file
  const skipResult = shouldSkipChunking(content, options);
  if (skipResult.skip) {
    const skippedResult: PortableChunkingResult = {
      chunks: [],
      totalTokens: 0,
      avgTokensPerChunk: 0,
      strategyUsed: initialStrategy,
      skipped: true,
    };
    // Only include skipReason if defined (exactOptionalPropertyTypes compliance)
    if (skipResult.reason !== undefined) {
      skippedResult.skipReason = skipResult.reason;
    }
    return skippedResult;
  }

  const adjusted = adjustChunkingForFileType(content, options);
  const maxTokensCap = resolveMaxTokensCap(options.maxTokensCap);
  const effectiveMaxTokens = Math.min(adjusted.maxTokens, maxTokensCap);
  const effectiveOverlap = Math.min(adjusted.overlap, CHUNKING_CONFIG.overlapSafetyCap);

  // Maximum safe token limit for embedding models
  const maxSafeTokens = Math.min(effectiveMaxTokens * 4, CHUNKING_CONFIG.maxTokensSafetyCap);

  // Compute chars per token
  const useTokenTrueSizing = options.tokenTrueSizing ?? false;
  const tokenUtilsModule = useTokenTrueSizing ? await loadTokenUtilsLiteModule() : null;
  const charsPerToken = await computeCharsPerToken(content, useTokenTrueSizing, tokenUtilsModule);
  const maxChars = Math.floor(effectiveMaxTokens * charsPerToken);
  const overlapChars = Math.floor(effectiveOverlap * charsPerToken);

  const name = (options.fileName || options.filePath || '').toLowerCase();
  const codeLanguage = detectCodeLanguage(name);
  // `resolveChunkingStrategyForFile()` is the canonical routing source of truth.
  // We only keep the recursive->sentence override when code-language detection
  // says the file is not actually source code, so these two extension sets must
  // remain aligned.
  const isCode = initialStrategy === 'recursive' && Boolean(codeLanguage);

  interface ChunkGroup {
    pieces: string[];
    type: ChunkType;
  }

  const splitMarkdownBlocks = async (): Promise<ChunkGroup[]> => {
    const blocks = splitMarkdownIntoBlocks(content);
    const groups: ChunkGroup[] = [];
    for (const block of blocks) {
      if (block.meta.isFence) {
        const parts =
          block.text.length > maxChars * 2 ? splitByBlankLines(block.text) : [block.text];
        groups.push({ pieces: parts, type: 'recursive' });
      } else {
        groups.push({
          pieces: splitTextByStrategy(block.text, {
            strategy: 'markdown',
            chunkSize: maxChars,
            chunkOverlap: overlapChars,
          }),
          type: 'sentence',
        });
      }
    }
    return groups;
  };

  const chunkCode = async (): Promise<ChunkGroup[]> => {
    const supportsAst = codeLanguage === 'typescript' || codeLanguage === 'javascript';

    const chunkWithCodeSeparators = async (): Promise<ChunkGroup[]> => {
      const codeSeparators = getCodeSeparators(options.separators);
      const recursiveChunker = new RecursiveTextSplitter({
        chunkSize: maxChars,
        chunkOverlap: overlapChars,
        separators: codeSeparators,
      });
      return [{ pieces: await recursiveChunker.splitText(content), type: 'recursive' }];
    };

    if (supportsAst) {
      const pieces = await splitCodeByFunctions(content, {
        maxChars,
        overlapChars,
        language: codeLanguage,
        separators: getCodeSeparators(options.separators),
      });

      if (pieces && pieces.length > 0) {
        return [{ pieces, type: 'recursive' }];
      }

      return chunkWithCodeSeparators();
    }
    if (codeLanguage) {
      return chunkWithCodeSeparators();
    }

    return [
      {
        pieces: splitTextByStrategy(content, {
          strategy: 'token',
          chunkSize: maxChars,
          chunkOverlap: overlapChars,
        }),
        type: 'text',
      },
    ];
  };

  const effectiveStrategy = resolveEffectiveChunkingStrategy({
    requested: options.strategy,
    resolvedAutoStrategy: initialStrategy,
    isCode,
  });

  let groups: ChunkGroup[] = [];

  if (effectiveStrategy === 'recursive' && isCode) {
    groups = await chunkCode();
  } else if (effectiveStrategy === 'markdown') {
    groups = await splitMarkdownBlocks();
  } else {
    const chunkType: ChunkType =
      effectiveStrategy === 'recursive' || effectiveStrategy === 'json' ? 'recursive' : 'sentence';
    const normalizedChunkType: ChunkType =
      effectiveStrategy === 'character' || effectiveStrategy === 'token' ? 'text' : chunkType;

    groups = [
      {
        pieces: splitTextByStrategy(content, {
          strategy: effectiveStrategy,
          chunkSize: maxChars,
          chunkOverlap: overlapChars,
          ...(effectiveStrategy === 'recursive' && options.separators
            ? { separators: getCodeSeparators(options.separators) }
            : {}),
        }),
        type: normalizedChunkType,
      },
    ];
  }

  // Process groups into portable chunks
  // PERF: Collect all pieces first, then batch hash generation
  interface PendingChunk {
    chunkType: ChunkType;
    content: string;
    tokenCount: number;
  }
  const pendingChunks: PendingChunk[] = [];

  // PERF: Reuse splitter instance for all oversized chunks
  const reSplitChunker = new RecursiveTextSplitter({
    chunkSize: Math.floor(Math.min(effectiveMaxTokens, maxSafeTokens) * charsPerToken),
    chunkOverlap: Math.min(overlapChars, Math.floor(maxChars / 10)),
    separators: ['\n\n', '\n', '. ', ' ', ''],
  });

  // Hoist the tokenizer dispatch out of the per-chunk loop. The previous shape
  // re-evaluated `useTokenTrueSizing && tokenUtilsModule` per chunk and per
  // sub-chunk; here we pick once and reuse a stable callback.
  const accurateModule = useTokenTrueSizing ? tokenUtilsModule : null;
  const countTokens = accurateModule
    ? (text: string) => accurateModule.countTokensAccurate(text)
    : (text: string) => Promise.resolve(estimateTokenCount(text));

  for (const g of groups) {
    for (const txt of g.pieces) {
      const c = txt?.trim();
      if (!c) {
        continue;
      }

      const tokenCount = await countTokens(c);

      if (tokenCount > maxSafeTokens) {
        const subPieces = await reSplitChunker.splitText(c);

        for (const subTxt of subPieces) {
          const subC = subTxt?.trim();
          if (!subC) {
            continue;
          }
          // Reuse the hoisted dispatch so callers who opted into
          // tokenTrueSizing keep getting accurate counts on sub-pieces too —
          // downstream budget enforcement depends on those numbers being
          // tight, not on a faster-but-loose char/4 heuristic.
          pendingChunks.push({
            content: subC,
            tokenCount: await countTokens(subC),
            chunkType: 'text',
          });
        }
        continue;
      }

      pendingChunks.push({
        content: c,
        tokenCount,
        chunkType: g.type,
      });
    }
  }

  // PERF: Batch hash generation with Promise.all
  const HashBatchSize = 50;
  const chunks: PortableChunk[] = [];
  let totalTokens = 0;
  const sourceRanges = resolveSourceRanges(content, pendingChunks, overlapChars);

  for (let i = 0; i < pendingChunks.length; i += HashBatchSize) {
    const batch = pendingChunks.slice(i, i + HashBatchSize);
    const hashes = await Promise.all(batch.map((p) => generateContentHash(p.content)));

    for (let j = 0; j < batch.length; j++) {
      const pending = batch[j];
      if (!pending) {
        continue;
      }
      const sourceRange = sourceRanges[i + j];
      if (!sourceRange) {
        throw new Error(`Missing source range for chunk ${i + j}`);
      }
      chunks.push({
        chunkIndex: i + j,
        content: pending.content,
        contentHash: hashes[j] ?? '',
        startLine: sourceRange.startLine,
        endLine: sourceRange.endLine,
        startOffset: sourceRange.startOffset,
        endOffset: sourceRange.endOffset,
        tokenCount: pending.tokenCount,
        chunkType: pending.chunkType,
        chunkSize: effectiveMaxTokens,
      });
      totalTokens += pending.tokenCount;
    }
  }

  const avgTokensPerChunk = chunks.length ? totalTokens / chunks.length : 0;

  return {
    chunks,
    totalTokens,
    avgTokensPerChunk,
    strategyUsed: effectiveStrategy,
    skipped: false,
  };
}
