/**
 * Portable chunking logic that can run in a Web Worker.
 * Extracted from @brainstrike/db ChunkingService, removing all database dependencies.
 */

import {
  type ChunkingStrategy,
  RecursiveTextSplitter,
  type ResolvedChunkingStrategy,
  resolveChunkingStrategyForFile,
  splitTextByStrategy,
} from '@brainstrike/text-splitter';
import { CHUNKING_CONFIG, type CodeLanguage } from './chunking-config';
import type { ChunkingRequestOptions, ChunkType, PortableChunk } from './shared';

export interface PortableChunkingResult {
  avgTokensPerChunk: number;
  chunks: PortableChunk[];
  skipped: boolean;
  skipReason?: string;
  strategyUsed: ResolvedChunkingStrategy;
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

type ParserPlugin =
  | 'classProperties'
  | 'classPrivateProperties'
  | 'classPrivateMethods'
  | 'decorators-legacy'
  | 'dynamicImport'
  | 'importAttributes'
  | 'topLevelAwait'
  | 'jsx'
  | 'typescript';

type BabelParserModule = typeof import('@babel/parser');
type TokenUtilsLiteModule = typeof import('./token-utils-lite');

let babelParserModulePromise: Promise<BabelParserModule> | null = null;
let tokenUtilsLiteModulePromise: Promise<TokenUtilsLiteModule> | null = null;

async function loadBabelParserModule(): Promise<BabelParserModule> {
  if (!babelParserModulePromise) {
    babelParserModulePromise = import('@babel/parser');
  }
  return babelParserModulePromise;
}

async function loadTokenUtilsLiteModule(): Promise<TokenUtilsLiteModule> {
  if (!tokenUtilsLiteModulePromise) {
    tokenUtilsLiteModulePromise = import('./token-utils-lite');
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

  // Skip binary-like content early (NUL bytes in the first few KB)
  const probeWindow = content.slice(0, 4096);
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
  const uniqueLines = new Set(content.split('\n')).size;
  const totalLines = content.split('\n').length;
  if (totalLines > 1000 && uniqueLines / totalLines < 0.1) {
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

/**
 * Generate a content hash using Web Crypto API (works in workers).
 */
async function generateContentHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function estimateTokenCount(text: string): number {
  const charCount = text.length;
  return Math.ceil(charCount / 4);
}

async function computeCharsPerToken(content: string, useAccurate: boolean): Promise<number> {
  const sample = content.slice(0, Math.min(10_000, content.length));
  const tokens = useAccurate
    ? await (await loadTokenUtilsLiteModule()).countTokensAccurate(sample)
    : estimateTokenCount(sample);
  if (Number.isFinite(tokens) && tokens > 0) {
    const measured = sample.length / tokens;
    return Math.max(1, Math.min(8, measured));
  }
  if (useAccurate) {
    throw new Error('Accurate token counting produced an invalid token count');
  }
  return Number(CHUNKING_CONFIG.averageCharsPerToken);
}

function resolveEffectiveStrategy({
  requested,
  isHtml,
  isJson,
  isLatex,
  isMarkdown,
  isCode,
}: {
  requested: ChunkingStrategy;
  isHtml: boolean;
  isJson: boolean;
  isLatex: boolean;
  isMarkdown: boolean;
  isCode: boolean;
}): ResolvedChunkingStrategy {
  if (requested !== 'auto') {
    return requested;
  }
  if (isHtml) {
    return 'html';
  }
  if (isJson) {
    return 'json';
  }
  if (isLatex) {
    return 'latex';
  }
  if (isMarkdown) {
    return 'semantic-markdown';
  }
  if (isCode) {
    return 'recursive';
  }
  return 'sentence';
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
    pieces.push(...subPieces.map((p) => p.trim()).filter(Boolean));
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

// Markdown helpers
function splitByBlankLines(text: string): string[] {
  const parts: string[] = [];
  let buf: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === '') {
      if (buf.length) {
        parts.push(buf.join('\n'));
        buf = [];
      }
    } else {
      buf.push(line);
    }
  }
  if (buf.length) {
    parts.push(buf.join('\n'));
  }
  return parts;
}

interface MarkdownBlock {
  meta: { isFence?: boolean; heading?: string };
  text: string;
}

/** Regex to match code fence opening/closing (backticks or tildes, optionally indented) */
const CODE_FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;

function captureFence(
  lines: (string | undefined)[],
  start: number
): { consumed: number; block?: { text: string; meta: { isFence: true } } } {
  const line = lines[start] ?? '';
  const openMatch = CODE_FENCE_PATTERN.exec(line);
  if (!openMatch) {
    return { consumed: start };
  }
  // Track the fence character and minimum length for closing
  const fenceChar = openMatch[1]?.[0] ?? '`';
  const fenceLen = openMatch[1]?.length ?? 3;
  const closingPattern = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`);

  const buf: string[] = [line];
  let i = start + 1;
  while (i < lines.length) {
    const cur = lines[i] ?? '';
    if (closingPattern.test(cur)) {
      break;
    }
    buf.push(cur);
    i++;
  }
  if (i < lines.length) {
    buf.push(lines[i] ?? '');
    i++;
  }
  return { consumed: i, block: { text: buf.join('\n'), meta: { isFence: true } } };
}

function captureHeading(lines: (string | undefined)[], start: number) {
  const raw = lines[start] ?? '';
  const m = raw.match(/^(#{1,6})\s+(.*)$/);
  if (!m) {
    return { consumed: start } as const;
  }
  const headingText: string = m[2] ?? '';
  return { consumed: start + 1, heading: { text: raw, meta: { heading: headingText } } } as const;
}

function captureParagraph(lines: (string | undefined)[], start: number) {
  const buf: string[] = [];
  let i = start;
  while (i < lines.length) {
    const cur = lines[i] ?? '';
    if (cur.match(/^```/) || cur.match(/^(#{1,6})\s+/) || cur.trim() === '') {
      break;
    }
    buf.push(cur);
    i++;
  }
  if (buf.length === 0) {
    while (i < lines.length && (lines[i] ?? '').trim() === '') {
      i++;
    }
    return { consumed: i } as const;
  }
  while (i < lines.length && (lines[i] ?? '').trim() === '') {
    i++;
  }
  return { consumed: i, paragraph: { text: buf.join('\n'), meta: {} as const } } as const;
}

function splitMarkdownIntoBlocks(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const fence = captureFence(lines, i);
    if (fence.block) {
      blocks.push(fence.block);
      i = fence.consumed;
      continue;
    }

    const head = captureHeading(lines, i);
    if (head.heading) {
      blocks.push(head.heading);
      i = head.consumed;
      continue;
    }

    const para = captureParagraph(lines, i);
    if (para.paragraph) {
      blocks.push(para.paragraph);
    }
    i = para.consumed;
  }
  return blocks;
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
  const charsPerToken = await computeCharsPerToken(content, useTokenTrueSizing);
  const maxChars = Math.floor(effectiveMaxTokens * charsPerToken);
  const overlapChars = Math.floor(effectiveOverlap * charsPerToken);

  const name = (options.fileName || options.filePath || '').toLowerCase();
  const codeLanguage = detectCodeLanguage(name);
  const isMarkdown = initialStrategy === 'markdown' || initialStrategy === 'semantic-markdown';
  const isCode = initialStrategy === 'recursive' && Boolean(codeLanguage);
  const isJson = initialStrategy === 'json';
  const isHtml = initialStrategy === 'html';
  const isLatex = initialStrategy === 'latex';

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

  const effectiveStrategy = resolveEffectiveStrategy({
    requested: options.strategy,
    isHtml,
    isJson,
    isLatex,
    isMarkdown,
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

  for (const g of groups) {
    for (const txt of g.pieces) {
      const c = txt?.trim();
      if (!c) {
        continue;
      }

      const tokenCount = useTokenTrueSizing
        ? await (await loadTokenUtilsLiteModule()).countTokensAccurate(c)
        : estimateTokenCount(c);

      // Handle oversized chunks - reuse splitter, use estimates for sub-chunks
      if (tokenCount > maxSafeTokens) {
        const subPieces = await reSplitChunker.splitText(c);

        for (const subTxt of subPieces) {
          const subC = subTxt?.trim();
          if (!subC) {
            continue;
          }
          // PERF: Use estimates for re-split chunks (accurate counting already done on parent)
          const subTokenCount = estimateTokenCount(subC);
          pendingChunks.push({
            content: subC,
            tokenCount: subTokenCount,
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

  for (let i = 0; i < pendingChunks.length; i += HashBatchSize) {
    const batch = pendingChunks.slice(i, i + HashBatchSize);
    const hashes = await Promise.all(batch.map((p) => generateContentHash(p.content)));

    for (let j = 0; j < batch.length; j++) {
      const pending = batch[j];
      if (!pending) {
        continue;
      }
      chunks.push({
        chunkIndex: i + j,
        content: pending.content,
        contentHash: hashes[j] ?? '',
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
