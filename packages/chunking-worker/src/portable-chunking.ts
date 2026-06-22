/**
 * Portable chunking logic that can run in a Web Worker.
 * Extracted from @brainstrike/db ChunkingService, removing all database dependencies.
 */

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
import { getEnabledTreeSitterLanguages } from './parsers/environment';
import { selectAdapter } from './parsers/select-adapter';
import type { AstNode } from './parsers/types';
import type { ChunkingRequestOptions, ChunkType, PortableChunk } from './shared';

// Module-scoped flag for the one-shot "first parse audit" — see the
// auditFirstSuccessfulParse() helper below.
let auditFired = false;
function auditFirstSuccessfulParse(adapterId: string): void {
  if (auditFired) {
    return;
  }
  auditFired = true;
  const message = `[chunking-parser] first parse succeeded using adapter "${adapterId}" — IPC chain confirmed`;
  // When running inside the chunking Web Worker, post a WorkerLog message
  // so the parent (file-import's chunking-worker-port) can forward it
  // through the project's logger system at info level. That makes the
  // audit visible in the unified `pnpm dev` output without requiring
  // the operator to open the chunking-host renderer's DevTools.
  // Falls back to console.info for non-worker contexts (unit tests,
  // direct use from a non-Electron browser).
  const workerSelf = (globalThis as { self?: { postMessage?: (msg: unknown) => void } }).self;
  if (
    workerSelf &&
    typeof workerSelf.postMessage === 'function' &&
    (globalThis as { window?: unknown }).window !== workerSelf
  ) {
    try {
      workerSelf.postMessage({ type: 'log', level: 'info', message });
      return;
    } catch {
      // structured-clone or transport failure — fall through to console
    }
  }
  // biome-ignore lint/suspicious/noConsole: one-time operational signal
  console.info(message);
}

const BINARY_DETECTION_PROBE_BYTES = 4096;
const REPETITIVE_CONTENT_LINE_THRESHOLD = 1000;
const REPETITIVE_CONTENT_UNIQUE_RATIO = 0.1;
const CHARS_PER_TOKEN_SAMPLE_BYTES = 10_000;
const CHARS_PER_TOKEN_MAX = 8;
const MAX_WHITESPACE_NORMALIZED_SOURCE_CANDIDATES = 10_000;
const MAX_WHITESPACE_NORMALIZED_ANCHORS = 64;

export interface PortableChunkingResult {
  avgTokensPerChunk: number;
  chunks: PortableChunk[];
  skipped: boolean;
  skipReason?: string;
  sourceRangeSkippedChunks?: number;
  strategyUsed: ResolvedChunkingStrategy;
  totalTokens: number;
}

interface SourceRange {
  endLine: number;
  endOffset: number;
  startLine: number;
  startOffset: number;
}

interface SourceRangeMatch {
  endOffset: number;
  matchKind: 'exact' | 'whitespace-normalized';
  startOffset: number;
}

interface AnchoredSourceRangeMatchResult {
  exhaustedCandidateBudget: boolean;
  match: SourceRangeMatch | null;
}

interface SourceRangeResolution {
  fuzzyMatchedChunks: number;
  ranges: Array<SourceRange | null>;
}

interface SourceRangeAnchor {
  chunkOffset: number;
  text: string;
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
  // P2 fix from #1002 review: .pyi (Python stub files) also count as
  // Python source. Without this, the routing test for .pyi passes at the
  // selectAdapter level but the chunker's supportsAst gate (in chunkCode)
  // returns false for .pyi files because detectCodeLanguage returns null.
  // Net effect: .pyi files would silently bypass tree-sitter even when
  // the operator enables it.
  { pattern: /\.pyi?$/i, language: 'python' },
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

type TokenUtilsLiteModule = typeof import('./token-utils-lite');

let tokenUtilsLiteModulePromise: Promise<TokenUtilsLiteModule> | null = null;

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

function findPreviousNonWhitespaceOffset(content: string, endOffset: number): number {
  let offset = endOffset - 1;
  while (offset >= 0) {
    const character = content[offset];
    if (!isSourceWhitespace(character)) {
      break;
    }
    offset -= 1;
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

function canSkipElidedSourceWhitespaceBefore(
  content: string,
  contentOffset: number,
  chunkChar: string | undefined
): number | null {
  if (!isSourceWhitespace(content[contentOffset - 1])) {
    return null;
  }

  const previousSourceOffset = findPreviousNonWhitespaceOffset(content, contentOffset);
  const whitespaceStartOffset = previousSourceOffset + 1;
  if (
    whitespaceStartOffset >= contentOffset ||
    !sourceWhitespaceRunHasLineBreak(content, whitespaceStartOffset, contentOffset) ||
    content[previousSourceOffset] !== chunkChar
  ) {
    return null;
  }

  return previousSourceOffset + 1;
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

function findSourceMatchStartOffset(
  content: string,
  chunkContent: string,
  chunkEndOffset: number,
  sourceEndOffset: number
): number | null {
  let contentOffset = sourceEndOffset;
  let chunkOffset = chunkEndOffset;

  while (chunkOffset > 0) {
    const chunkChar = chunkContent[chunkOffset - 1];
    const skippedWhitespaceOffset = canSkipElidedSourceWhitespaceBefore(
      content,
      contentOffset,
      chunkChar
    );

    if (skippedWhitespaceOffset !== null) {
      contentOffset = skippedWhitespaceOffset;
      continue;
    }

    if (contentOffset <= 0) {
      return null;
    }

    if (chunkChar === '\n' && content[contentOffset - 1] === '\n') {
      const sourceCarriageReturnOffset = contentOffset - 2;
      if (content[sourceCarriageReturnOffset] === '\r') {
        chunkOffset -= 1;
        contentOffset -= 2;
        continue;
      }
    }

    if (chunkChar !== content[contentOffset - 1]) {
      return null;
    }

    chunkOffset -= 1;
    contentOffset -= 1;
  }

  return contentOffset;
}

function collectSourceRangeAnchors(chunkContent: string): SourceRangeAnchor[] {
  const anchors: SourceRangeAnchor[] = [];
  const seen = new Set<string>();
  let runStart: number | null = null;

  const pushRun = (endOffset: number): void => {
    if (runStart === null) {
      return;
    }
    const text = chunkContent.slice(runStart, endOffset);
    if (text.length > 1 && !seen.has(text)) {
      anchors.push({ chunkOffset: runStart, text });
      seen.add(text);
    }
    runStart = null;
  };

  for (let offset = 0; offset < chunkContent.length; offset += 1) {
    if (isSourceWhitespace(chunkContent[offset])) {
      pushRun(offset);
      continue;
    }
    runStart ??= offset;
  }
  pushRun(chunkContent.length);

  return anchors
    .sort((a, b) => b.text.length - a.text.length || a.chunkOffset - b.chunkOffset)
    .slice(0, MAX_WHITESPACE_NORMALIZED_ANCHORS);
}

function findAnchoredSourceRangeForChunkContent(
  content: string,
  chunkContent: string,
  searchStart: number
): AnchoredSourceRangeMatchResult {
  const anchors = collectSourceRangeAnchors(chunkContent);
  const checkedCandidateOffsets = new Set<number>();
  let candidateCount = 0;

  for (const anchor of anchors) {
    let anchorOffset = content.indexOf(anchor.text, searchStart);
    while (anchorOffset >= 0) {
      candidateCount += 1;
      if (candidateCount > MAX_WHITESPACE_NORMALIZED_SOURCE_CANDIDATES) {
        return { exhaustedCandidateBudget: true, match: null };
      }

      const candidateOffset = findSourceMatchStartOffset(
        content,
        chunkContent,
        anchor.chunkOffset,
        anchorOffset
      );
      if (
        candidateOffset !== null &&
        candidateOffset >= searchStart &&
        !checkedCandidateOffsets.has(candidateOffset)
      ) {
        checkedCandidateOffsets.add(candidateOffset);
        const endOffset = findSourceMatchEndOffset(content, chunkContent, candidateOffset);
        if (endOffset !== null) {
          return {
            exhaustedCandidateBudget: false,
            match: {
              matchKind: 'whitespace-normalized',
              startOffset: candidateOffset,
              endOffset,
            },
          };
        }
      }

      anchorOffset = content.indexOf(anchor.text, anchorOffset + 1);
    }
  }

  return { exhaustedCandidateBudget: false, match: null };
}

function findSourceRangeForChunkContent(
  content: string,
  chunkContent: string,
  searchStart: number
): SourceRangeMatch | null {
  const exactStartOffset = content.indexOf(chunkContent, searchStart);
  if (exactStartOffset >= 0) {
    return {
      matchKind: 'exact',
      startOffset: exactStartOffset,
      endOffset: exactStartOffset + chunkContent.length,
    };
  }

  const firstCharacter = chunkContent[0];
  if (firstCharacter === undefined) {
    return null;
  }

  const anchoredMatch = findAnchoredSourceRangeForChunkContent(content, chunkContent, searchStart);
  if (anchoredMatch.match) {
    return anchoredMatch.match;
  }
  if (anchoredMatch.exhaustedCandidateBudget) {
    return null;
  }

  // Exact matches cover the normal path. This fallback preserves line metadata
  // through splitter whitespace normalization; the caller advances searchStart
  // after each resolved chunk so generated files do not repeatedly rescan from
  // the beginning of the source.
  let candidateOffset = content.indexOf(firstCharacter, searchStart);
  let candidateCount = 0;
  while (candidateOffset >= 0) {
    candidateCount += 1;
    if (candidateCount > MAX_WHITESPACE_NORMALIZED_SOURCE_CANDIDATES) {
      return null;
    }
    const endOffset = findSourceMatchEndOffset(content, chunkContent, candidateOffset);
    if (endOffset !== null) {
      return {
        matchKind: 'whitespace-normalized',
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
): SourceRangeResolution {
  const lineStarts = buildLineStartOffsets(content);
  let searchStart = 0;
  let previousStartOffset = -1;
  let fuzzyMatchedChunks = 0;

  const ranges = chunks.map((chunk) => {
    const sourceRange =
      findSourceRangeForChunkContent(content, chunk.content, searchStart) ??
      findSourceRangeForChunkContent(content, chunk.content, Math.max(0, previousStartOffset));
    if (!sourceRange) {
      return null;
    }

    const { startOffset, endOffset, matchKind } = sourceRange;
    if (matchKind === 'whitespace-normalized') {
      fuzzyMatchedChunks += 1;
    }
    previousStartOffset = startOffset;
    searchStart = Math.max(0, endOffset - overlapChars - 1);

    return {
      startOffset,
      endOffset,
      startLine: findLineForOffset(lineStarts, startOffset),
      endLine: findLineForOffset(lineStarts, Math.max(startOffset, endOffset - 1)),
    };
  });

  return { ranges, fuzzyMatchedChunks };
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
    // ESTree-style class method wrapper used by oxc-parser and most non-Babel
    // tooling. Without this, every class method in an oxc-parsed tree would
    // be invisible to function-level chunking (Babel calls these ClassMethod
    // directly; oxc emits MethodDefinition wrapping a FunctionExpression).
    // Surfaced by Phase 6 differential test reviewer (#992).
    type === 'MethodDefinition' ||
    type === 'TSDeclareFunction' ||
    type === 'TSMethodSignature' ||
    type === 'TSCallSignatureDeclaration' ||
    // Tree-sitter Python node types (Phase 5 of #998). The Python grammar
    // emits these for top-level definitions; the chunker treats them as
    // chunk-worthy units identically to JS/TS functions. class_definition
    // is included as a single chunk (per-method splitting deferred).
    type === 'function_definition' ||
    type === 'class_definition' ||
    type === 'decorated_definition'
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
    type === 'ClassBody' ||
    // Tree-sitter Python root (Phase 5 of #998). Without 'module' here,
    // function_definition / class_definition / decorated_definition would
    // never qualify as top-level chunks because their parent type would
    // not match any container.
    type === 'module'
  );
}

function hasFunctionAncestor(ancestors: readonly AstNode[]): boolean {
  return ancestors.some((ancestor) => isFunctionNode(ancestor.type));
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
    !hasFunctionAncestor(ancestors) &&
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
    fileName,
  }: {
    maxChars: number;
    overlapChars: number;
    language: CodeLanguage | null;
    separators: string[];
    /**
     * Optional file name/path. Plumbed through so selectAdapter (Phase 5
     * of #998) can route extensions like .py to tree-sitter.
     */
    fileName?: string;
  }
): Promise<string[] | null> {
  let ast: AstNode | null = null;
  const adapter = selectAdapter(fileName);
  if (adapter === null) {
    // selectAdapter returned null (Phase 9 strict): the file is not
    // AST-chunkable in this configuration. Most common case: a .py file
    // with tree-sitter Python disabled. We log at warn (same level as
    // parse failures) and return null so the chunker falls back to the
    // recursive splitter — the loud-degrade pattern from PRD §8.2.
    // biome-ignore lint/suspicious/noConsole: visible signal that AST chunking is skipped
    console.warn(
      '[portable-chunking] No AST adapter for file; falling back to recursive splitting',
      {
        fileName,
        language,
      }
    );
    return null;
  }
  try {
    ast = await adapter.parse(content, {
      errorRecovery: true,
      jsx: true,
      language: language === 'typescript' ? 'typescript' : 'javascript',
    });
    // First-parse audit (logs once per worker session). This is the
    // operator's confirmation that selectAdapter picked the right adapter
    // AND that the first parse round-trip actually completed — without
    // this, "no errors in the log" is ambiguous between "oxc works" and
    // "oxc is silently bypassed." After the first successful parse the
    // audit goes silent so the log isn't spammy.
    auditFirstSuccessfulParse(adapter.id);
  } catch (err) {
    // WARN level (not debug): an AST parse failure means function-aware
    // chunking degraded to non-AST recursive splitting for this file.
    // That's a meaningful quality regression for code retrieval, and a
    // sustained pattern (e.g., every file failing) indicates the parser
    // is broken — which we want LOUD, not hidden. The caller-side
    // catch returns null so the pipeline still produces chunks via
    // the recursive splitter; this log is the signal that we paid a
    // quality cost to do so.
    // biome-ignore lint/suspicious/noConsole: visible signal for parser quality regression
    console.warn('[portable-chunking] AST parsing failed; falling back to recursive splitting', {
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

    // Function ranges are intentionally emitted without cross-function padding.
    // The recursive splitter still applies overlap inside oversized segments,
    // while persisted source ranges stay exact for line-aware retrieval.
    await appendRange(clampedStart, clampedEnd);
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
    // AST chunking is supported for:
    //  - JS/TS (always — via Babel in browser or oxc in chunking-host)
    //  - Python (when tree-sitter is opted in via
    //    __BRAINSTRIKE_TREE_SITTER_LANGUAGES__; Phase 5 of #998)
    // The flag is read at chunk time (not at module load) so the rollout
    // flip in Phase 8 doesn't require reloading the worker.
    const enabledTreeSitterLanguages = getEnabledTreeSitterLanguages();
    const supportsAst =
      codeLanguage === 'typescript' ||
      codeLanguage === 'javascript' ||
      (codeLanguage === 'python' && enabledTreeSitterLanguages.includes('python'));

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
      const resolvedFileName = options.fileName ?? options.filePath;
      const pieces = await splitCodeByFunctions(content, {
        maxChars,
        overlapChars,
        language: codeLanguage,
        separators: getCodeSeparators(options.separators),
        // Plumb fileName so selectAdapter(fileName) can extension-route
        // (e.g., .py → tree-sitter). For JS/TS the routing ignores
        // fileName and uses the env/flag globals, so this is a no-op for
        // the existing path. Conditional spread keeps the property absent
        // when no name is available (exactOptionalPropertyTypes).
        ...(resolvedFileName ? { fileName: resolvedFileName } : {}),
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
  let sourceRangeSkippedChunks = 0;
  const sourceRangeResolution = resolveSourceRanges(content, pendingChunks, overlapChars);
  const sourceRanges = sourceRangeResolution.ranges;

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
        sourceRangeSkippedChunks += 1;
        continue;
      }
      chunks.push({
        // Preserve the splitter position even when an unresolved source range
        // creates a gap; downstream diagnostics need to identify the dropped
        // candidate rather than renumbering the surviving chunks.
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

  if (sourceRangeSkippedChunks > 0) {
    // biome-ignore lint/suspicious/noConsole: worker warning surfaces partial line-range indexing gaps.
    console.warn('[portable-chunking] skipped chunks with unresolved source ranges', {
      fileName: options.fileName,
      filePath: options.filePath,
      sourceRangeSkippedChunks,
      totalCandidateChunks: pendingChunks.length,
    });
  }
  if (pendingChunks.length > 0 && chunks.length === 0) {
    return {
      chunks,
      totalTokens: 0,
      avgTokensPerChunk: 0,
      strategyUsed: effectiveStrategy,
      skipped: true,
      skipReason: 'source range resolution failed',
      sourceRangeSkippedChunks,
    };
  }

  return {
    chunks,
    totalTokens,
    avgTokensPerChunk,
    strategyUsed: effectiveStrategy,
    skipped: false,
    ...(sourceRangeSkippedChunks > 0 ? { sourceRangeSkippedChunks } : {}),
  };
}
