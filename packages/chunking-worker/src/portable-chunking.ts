/**
 * Portable chunking logic that can run in a Web Worker.
 * Extracted from @brainstrike/db ChunkingService, removing all database dependencies.
 */

import {
  RecursiveTextSplitter,
  type ResolvedChunkingStrategy,
  resolveChunkingStrategyForFile,
  resolveEffectiveChunkingStrategy,
  splitTextByStrategy,
} from '@brainstrike/text-splitter';
import {
  analyzeContentRepetition,
  splitByBlankLines,
  splitMarkdownIntoBlocks,
} from '@brainstrike/text-splitter/chunking-core';
import { countTokensHeuristic } from '@brainstrike/tokenization';
import {
  type CanonicalChunkingRuntime,
  parseCanonicalSource,
  supportsCanonicalAst,
} from './canonical-parser-runtime';
import { CHUNKING_CONFIG, type CodeLanguage } from './chunking-config';
import type { ExtractedSymbols } from './extract-symbols';
import { createCooperativeYieldController } from './ordered-batch-map';
import type { AstNode } from './parsers/types';
import type { ChunkingRequestOptions, ChunkType, PortableChunk } from './shared';
import {
  computeCharsPerToken,
  resolveSourceRanges,
  type TokenCounter,
} from './source-range-resolution';

const BINARY_DETECTION_PROBE_BYTES = 4096;
const TOKEN_COUNT_YIELD_CHECK_INTERVAL = 20;
const TOKEN_COUNT_YIELD_TIME_BUDGET_MS = 5;

export interface PortableChunkingResult {
  avgTokensPerChunk: number;
  chunks: PortableChunk[];
  skipped: boolean;
  skipReason?: string;
  sourceRangeSkippedChunks?: number;
  strategyUsed: ResolvedChunkingStrategy;
  /** Name-based references extracted from the same parse (BST-919). Absent
   * when the file was not AST-chunked or extraction degraded. */
  symbolRefs?: import('./extract-symbols').PortableSymbolRef[];
  /** Symbol definitions extracted from the same parse (BST-919). */
  symbols?: import('./extract-symbols').PortableSymbol[];
  totalTokens: number;
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
  { language: 'javascript', pattern: /\.vue$/i },
  { language: 'javascript', pattern: /\.svelte$/i },
  { language: 'typescript', pattern: /\.(ts|tsx|mts|cts)$/i },
  { language: 'javascript', pattern: /\.(js|jsx|mjs|cjs)$/i },
  { language: 'cpp', pattern: /\.mm$/i },
  { language: 'cpp', pattern: /\.m$/i },
  // P2 fix from #1002 review: .pyi (Python stub files) also count as
  // Python source. Without this, the routing test for .pyi passes at the
  // selectAdapter level but the chunker's supportsAst gate (in chunkCode)
  // returns false for .pyi files because detectCodeLanguage returns null.
  // Net effect: .pyi files would silently bypass tree-sitter even when
  // the operator enables it.
  { language: 'python', pattern: /\.pyi?$/i },
  { language: 'rust', pattern: /\.rs$/i },
  { language: 'go', pattern: /\.go$/i },
  { language: 'java', pattern: /\.(java|class)$/i },
  { language: 'csharp', pattern: /\.cs$/i },
  { language: 'cpp', pattern: /\.(c|cc|cpp|cxx|h|hh|hpp)$/i },
  { language: 'ruby', pattern: /\.rb$/i },
  { language: 'php', pattern: /\.php$/i },
  { language: 'swift', pattern: /\.swift$/i },
  { language: 'kotlin', pattern: /\.(kt|kts)$/i },
];

const LARGE_STRUCTURED_PATTERNS = [
  /\.json$/i,
  /\.xml$/i,
  /\.csv$/i,
  /\.tsv$/i,
  /\.sql$/i,
  /\.log$/i,
];

type TokenUtilsLiteModule = typeof import('@brainstrike/tokenization/token-utils-lite');

let tokenUtilsLiteModulePromise: Promise<TokenUtilsLiteModule> | null = null;

async function loadTokenUtilsLiteModule(): Promise<TokenUtilsLiteModule> {
  if (!tokenUtilsLiteModulePromise) {
    tokenUtilsLiteModulePromise = import('@brainstrike/tokenization/token-utils-lite').catch(
      (error: unknown) => {
        tokenUtilsLiteModulePromise = null;
        throw error;
      }
    );
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
        reason: `Lock file or dependency manifest: ${fileName}`,
        skip: true,
      };
    }
  }

  // Zero-byte files are valid repository inputs. Skip them explicitly so the
  // worker never treats an empty accurate token count as a chunking failure.
  if (content.length === 0) {
    return { reason: 'Empty file content', skip: true };
  }

  // Skip binary-like content early (NUL bytes in the first few KB)
  const probeWindow = content.slice(0, BINARY_DETECTION_PROBE_BYTES);
  if (probeWindow.includes('\u0000')) {
    return { reason: 'Binary content detected (NUL bytes present)', skip: true };
  }

  // Check content size
  if (!options.allowLargeFiles && content.length > CHUNKING_CONFIG.maxChunkableSize) {
    return {
      reason: `File too large: ${Math.round(content.length / 1024)}KB (max: ${Math.round(
        CHUNKING_CONFIG.maxChunkableSize / 1024
      )}KB)`,
      skip: true,
    };
  }

  // Check for very repetitive content (common in generated files)
  if (analyzeContentRepetition(content).isHighlyRepetitive) {
    return {
      reason: 'Highly repetitive content (likely generated file)',
      skip: true,
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

export { buildLineStartOffsets, findLineForOffset } from './line-offsets';

async function resolveTokenCounter(
  useAccurate: boolean,
  tokenUtilsModule: TokenUtilsLiteModule | null
): Promise<TokenCounter> {
  if (!useAccurate) {
    return estimateTokenCount;
  }
  if (!tokenUtilsModule) {
    throw new Error('Accurate token counting module was not loaded');
  }

  const counter = await tokenUtilsModule.getAccurateTokenCounter();
  if (counter) {
    return counter;
  }

  const reason = tokenUtilsModule.getAccurateTokenCountingFailureReason();
  throw new Error(
    reason
      ? `Accurate token counting unavailable: ${reason}`
      : 'Accurate token counting unavailable'
  );
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
    ranges.push({ end: Number(node.end), start: Number(node.start) });
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
    runtime,
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
    runtime?: CanonicalChunkingRuntime;
  }
): Promise<{ pieces: string[]; symbols: ExtractedSymbols | null } | null> {
  const parsed = await parseCanonicalSource(content, language, fileName, runtime);
  if (!parsed) {
    return null;
  }
  const { ast, symbols } = parsed;

  const ranges: Array<{ start: number; end: number }> = [];
  collectTopLevelFunctionRanges(ast, [], ranges);

  if (!ranges.length) {
    // No function-shaped ranges does NOT mean no symbols: an interfaces-only
    // types.ts, a constants module, or a barrel index.ts parses fine and
    // extracts fine — only the CHUNKING strategy has nothing to split on.
    // Returning the symbols with empty pieces lets the caller fall back to
    // separator chunking without discarding the graph rows (review finding on
    // #2032: the import refs lost here are exactly the files whose whole job
    // is importing).
    return { pieces: [], symbols };
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);

  const pieces: string[] = [];
  let cursor = 0;

  const recursiveChunker = new RecursiveTextSplitter({
    chunkOverlap: overlapChars,
    chunkSize: maxChars,
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

  return { pieces, symbols };
}

/**
 * Main entry point for chunking content in the worker.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Chunking strategy routing is intentionally branching.
export async function chunkContent(
  content: string,
  options: ChunkingRequestOptions & { fileName?: string; filePath?: string },
  runtime?: CanonicalChunkingRuntime
): Promise<PortableChunkingResult> {
  const initialStrategy = resolveChunkingStrategyForFile(
    options.filePath ?? options.fileName ?? '',
    options.strategy
  );
  // Check if we should skip this file
  const skipResult = shouldSkipChunking(content, options);
  if (skipResult.skip) {
    const skippedResult: PortableChunkingResult = {
      avgTokensPerChunk: 0,
      chunks: [],
      skipped: true,
      strategyUsed: initialStrategy,
      totalTokens: 0,
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
  const countTokens = await resolveTokenCounter(useTokenTrueSizing, tokenUtilsModule);
  const charsPerToken = computeCharsPerToken(content, useTokenTrueSizing, countTokens);
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
            chunkOverlap: overlapChars,
            chunkSize: maxChars,
            strategy: 'markdown',
          }),
          type: 'sentence',
        });
      }
    }
    return groups;
  };

  // Populated by the AST branch inside chunkCode; attached to the successful
  // result so symbols ride the same worker response as the chunks they came
  // from (BST-919).
  const symbolHolder: { current: ExtractedSymbols | null } = { current: null };

  const chunkCode = async (): Promise<ChunkGroup[]> => {
    const chunkWithCodeSeparators = async (): Promise<ChunkGroup[]> => {
      const codeSeparators = getCodeSeparators(options.separators);
      const recursiveChunker = new RecursiveTextSplitter({
        chunkOverlap: overlapChars,
        chunkSize: maxChars,
        separators: codeSeparators,
      });
      return [{ pieces: await recursiveChunker.splitText(content), type: 'recursive' }];
    };

    if (supportsCanonicalAst(codeLanguage, runtime)) {
      const resolvedFileName = options.fileName ?? options.filePath;
      const astSplit = await splitCodeByFunctions(content, {
        language: codeLanguage,
        maxChars,
        overlapChars,
        separators: getCodeSeparators(options.separators),
        ...(runtime ? { runtime } : {}),
        // Plumb fileName so selectAdapter(fileName) can extension-route
        // (e.g., .py → tree-sitter). For JS/TS the routing ignores
        // fileName and uses the env/flag globals, so this is a no-op for
        // the existing path. Conditional spread keeps the property absent
        // when no name is available (exactOptionalPropertyTypes).
        ...(resolvedFileName ? { fileName: resolvedFileName } : {}),
      });

      if (astSplit) {
        // Symbols decouple from chunking strategy: keep them even when the
        // splitter found no function ranges and we fall back to separators.
        symbolHolder.current = astSplit.symbols;
        if (astSplit.pieces.length > 0) {
          return [{ pieces: astSplit.pieces, type: 'recursive' }];
        }
      }

      return chunkWithCodeSeparators();
    }
    if (codeLanguage) {
      return chunkWithCodeSeparators();
    }

    return [
      {
        pieces: splitTextByStrategy(content, {
          chunkOverlap: overlapChars,
          chunkSize: maxChars,
          strategy: 'token',
        }),
        type: 'text',
      },
    ];
  };

  const effectiveStrategy = resolveEffectiveChunkingStrategy({
    isCode,
    requested: options.strategy,
    resolvedAutoStrategy: initialStrategy,
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
          chunkOverlap: overlapChars,
          chunkSize: maxChars,
          strategy: effectiveStrategy,
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
    chunkOverlap: Math.min(overlapChars, Math.floor(maxChars / 10)),
    chunkSize: Math.floor(Math.min(effectiveMaxTokens, maxSafeTokens) * charsPerToken),
    separators: ['\n\n', '\n', '. ', ' ', ''],
  });

  // Accurate tokenization is synchronous after the encoder resolves once.
  // Periodically yield a macrotask when the work exceeds a short budget so a
  // large file cannot monopolize the worker's event loop.
  const maybeYieldAfterTokenCount = createCooperativeYieldController({
    checkEvery: TOKEN_COUNT_YIELD_CHECK_INTERVAL,
    yieldAfterMs: TOKEN_COUNT_YIELD_TIME_BUDGET_MS,
  });
  for (const g of groups) {
    for (const txt of g.pieces) {
      const c = txt?.trim();
      if (!c) {
        continue;
      }
      const tokenCount = countTokens(c);
      await maybeYieldAfterTokenCount();
      if (tokenCount > maxSafeTokens) {
        const subPieces = await reSplitChunker.splitText(c);
        for (const subTxt of subPieces) {
          const subC = subTxt?.trim();
          if (!subC) {
            continue;
          }
          pendingChunks.push({
            chunkType: 'text',
            content: subC,
            tokenCount: countTokens(subC),
          });
          await maybeYieldAfterTokenCount();
        }
        continue;
      }

      pendingChunks.push({ chunkType: g.type, content: c, tokenCount });
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
        chunkSize: effectiveMaxTokens,
        chunkType: pending.chunkType,
        content: pending.content,
        contentHash: hashes[j] ?? '',
        endLine: sourceRange.endLine,
        endOffset: sourceRange.endOffset,
        startLine: sourceRange.startLine,
        startOffset: sourceRange.startOffset,
        tokenCount: pending.tokenCount,
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
      avgTokensPerChunk: 0,
      chunks,
      skipped: true,
      skipReason: 'source range resolution failed',
      sourceRangeSkippedChunks,
      strategyUsed: effectiveStrategy,
      totalTokens: 0,
    };
  }

  return {
    avgTokensPerChunk,
    chunks,
    skipped: false,
    strategyUsed: effectiveStrategy,
    totalTokens,
    ...(sourceRangeSkippedChunks > 0 ? { sourceRangeSkippedChunks } : {}),
    ...(symbolHolder.current
      ? { symbolRefs: symbolHolder.current.refs, symbols: symbolHolder.current.symbols }
      : {}),
  };
}
