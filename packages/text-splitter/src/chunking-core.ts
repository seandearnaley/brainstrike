// Keep this dependency one-way: chunking-core may read low-level text-splitter
// primitives from index, but index must not re-export chunking-core.
import {
  isMarkdownBlockBoundaryLine,
  MARKDOWN_CODE_FENCE_PATTERN,
  RecursiveTextSplitter,
} from './index.js';

export type SharedCodeLanguage =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'csharp'
  | 'cpp'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'kotlin';

export interface ChunkAdjustmentConfig<TLanguage extends string> {
  readonly codeLanguageDefaults: Record<TLanguage, { maxTokens: number; overlap: number }>;
  readonly codeMaxTokens: number;
  readonly codeOverlap: number;
  readonly defaultMaxTokens: number;
  readonly defaultOverlap: number;
  readonly largeStructuredMaxTokens: number;
  readonly largeStructuredOverlap: number;
  readonly maxChunkableSize: number;
  readonly maxTokensHardLimit: number;
  readonly maxTokensSafetyCap: number;
  readonly overlapHardLimit: number;
  readonly overlapSafetyCap: number;
  readonly veryLargeContentThreshold: number;
  readonly veryLargeMaxTokens: number;
  readonly veryLargeOverlap: number;
}

export interface SharedChunkingOptions {
  readonly allowLargeFiles?: boolean;
  readonly fileName?: string;
  readonly filePath?: string;
  readonly ignoreFileTypeRecommendations?: boolean;
  readonly maxTokens?: number;
  readonly maxTokensCap?: number;
  readonly overlap?: number;
}

export interface MarkdownBlock {
  readonly meta: { readonly heading?: string; readonly isFence?: boolean };
  readonly text: string;
}

export interface FunctionRange {
  readonly end: number;
  readonly start: number;
}

export type AstNode = {
  type?: string;
  start?: number;
  end?: number;
} & Record<string, unknown>;

export const DEFAULT_SKIP_CHUNKING_PATTERNS = [
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
] as const;

export const DEFAULT_CODE_LANGUAGE_PATTERNS: ReadonlyArray<{
  readonly language: SharedCodeLanguage;
  readonly pattern: RegExp;
}> = [
  { language: 'javascript', pattern: /\.vue$/i },
  { language: 'javascript', pattern: /\.svelte$/i },
  { language: 'typescript', pattern: /\.(ts|tsx|mts|cts)$/i },
  { language: 'javascript', pattern: /\.(js|jsx|mjs|cjs)$/i },
  { language: 'cpp', pattern: /\.mm$/i },
  { language: 'cpp', pattern: /\.m$/i },
  { language: 'python', pattern: /\.py$/i },
  { language: 'rust', pattern: /\.rs$/i },
  { language: 'go', pattern: /\.go$/i },
  { language: 'java', pattern: /\.(java|class)$/i },
  { language: 'csharp', pattern: /\.cs$/i },
  { language: 'cpp', pattern: /\.(c|cc|cpp|cxx|h|hh|hpp)$/i },
  { language: 'ruby', pattern: /\.rb$/i },
  { language: 'php', pattern: /\.php$/i },
  { language: 'swift', pattern: /\.swift$/i },
  { language: 'kotlin', pattern: /\.(kt|kts)$/i },
] as const;

export const DEFAULT_LARGE_STRUCTURED_PATTERNS = [
  /\.json$/i,
  /\.xml$/i,
  /\.csv$/i,
  /\.tsv$/i,
  /\.sql$/i,
  /\.log$/i,
] as const;

const CHAR_CR = 13;

const BINARY_DETECTION_PROBE_BYTES = 4096;
const REPETITIVE_CONTENT_LINE_THRESHOLD = 1000;
const REPETITIVE_CONTENT_UNIQUE_RATIO = 0.1;
const FUNCTION_RANGE_OVERSIZE_TOLERANCE = 1.25;

function forEachLine(text: string, visitLine: (line: string) => void): void {
  let lineStart = 0;

  while (lineStart <= text.length) {
    const nextNewline = text.indexOf('\n', lineStart);
    const hasLineFeed = nextNewline !== -1;
    const lineFeedIndex = hasLineFeed ? nextNewline : text.length;
    let lineEnd = lineFeedIndex;

    if (hasLineFeed && lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === CHAR_CR) {
      lineEnd -= 1;
    }

    visitLine(text.slice(lineStart, lineEnd));

    if (!hasLineFeed) {
      return;
    }

    lineStart = lineFeedIndex + 1;
  }
}

export function detectCodeLanguage<TLanguage extends string = SharedCodeLanguage>(
  fileName: string,
  patterns?: ReadonlyArray<{ readonly language: TLanguage; readonly pattern: RegExp }>
): TLanguage | null {
  const normalizedPatterns =
    patterns ??
    (DEFAULT_CODE_LANGUAGE_PATTERNS as ReadonlyArray<{
      readonly language: TLanguage;
      readonly pattern: RegExp;
    }>);
  const normalizedName = fileName.toLowerCase();
  for (const { pattern, language } of normalizedPatterns) {
    if (pattern.test(normalizedName)) {
      return language;
    }
  }
  return null;
}

function countUniqueLines(content: string): { totalLines: number; uniqueLines: number } {
  const uniqueLines = new Set<string>();
  let totalLines = 0;

  forEachLine(content, (line: string) => {
    uniqueLines.add(line);
    totalLines += 1;
  });

  return { totalLines, uniqueLines: uniqueLines.size };
}

export function shouldSkipChunking(
  content: string,
  options: SharedChunkingOptions,
  maxChunkableSize: number,
  skipPatterns: readonly RegExp[] = DEFAULT_SKIP_CHUNKING_PATTERNS
): { reason?: string; skip: boolean } {
  const fileName = options.fileName || options.filePath || '';
  for (const pattern of skipPatterns) {
    if (pattern.test(fileName)) {
      return {
        reason: `Lock file or dependency manifest: ${fileName}`,
        skip: true,
      };
    }
  }

  // Zero-byte files are valid repository inputs. They should be skipped explicitly
  // rather than flowing into token sizing where an empty sample has no valid token count.
  if (content.length === 0) {
    return { reason: 'Empty file content', skip: true };
  }

  const probeWindow = content.slice(0, BINARY_DETECTION_PROBE_BYTES);
  if (probeWindow.includes('\u0000')) {
    return { reason: 'Binary content detected (NUL bytes present)', skip: true };
  }

  if (!options.allowLargeFiles && content.length > maxChunkableSize) {
    return {
      reason: `File too large: ${Math.round(content.length / 1024)}KB (max: ${Math.round(
        maxChunkableSize / 1024
      )}KB)`,
      skip: true,
    };
  }

  const { totalLines, uniqueLines } = countUniqueLines(content);
  if (
    totalLines > REPETITIVE_CONTENT_LINE_THRESHOLD &&
    uniqueLines / totalLines < REPETITIVE_CONTENT_UNIQUE_RATIO
  ) {
    return {
      reason: 'Highly repetitive content (likely generated file)',
      skip: true,
    };
  }

  return { skip: false };
}

export function resolveMaxTokensCap(
  cap: number | undefined,
  maxTokensHardLimit: number,
  maxTokensSafetyCap: number
): number {
  if (!Number.isFinite(cap ?? Number.NaN)) {
    return maxTokensSafetyCap;
  }
  const sanitized = Math.floor(cap as number);
  if (sanitized <= 0) {
    return maxTokensSafetyCap;
  }
  return Math.max(256, Math.min(maxTokensHardLimit, sanitized));
}

export function adjustChunkingForFileType<TLanguage extends string>(
  content: string,
  options: SharedChunkingOptions,
  config: ChunkAdjustmentConfig<TLanguage>,
  detectLanguage: (fileName: string) => TLanguage | null,
  largeStructuredPatterns: readonly RegExp[] = DEFAULT_LARGE_STRUCTURED_PATTERNS
): { maxTokens: number; overlap: number } {
  const fileName = options.fileName || options.filePath || '';
  const ignoreRecommendations = options.ignoreFileTypeRecommendations === true;
  const maxTokensCap = resolveMaxTokensCap(
    options.maxTokensCap,
    config.maxTokensHardLimit,
    config.maxTokensSafetyCap
  );

  const normalize = (value: number | undefined, fallback: number, minimum: number): number => {
    const candidate = Number.isFinite(value) ? (value as number) : fallback;
    return Math.max(minimum, Math.floor(candidate));
  };

  const requestedMaxTokens = options.maxTokens;
  const requestedOverlap = options.overlap;
  const hasExplicitMaxTokens = requestedMaxTokens !== undefined;
  const hasExplicitOverlap = requestedOverlap !== undefined;

  let maxTokens = hasExplicitMaxTokens
    ? normalize(requestedMaxTokens, config.defaultMaxTokens, 1)
    : Number.POSITIVE_INFINITY;
  let overlap = hasExplicitOverlap
    ? normalize(requestedOverlap, config.defaultOverlap, 0)
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
    const codeLanguage = detectLanguage(fileName);
    if (codeLanguage) {
      adjustments.push((state) => {
        const languageDefaults = config.codeLanguageDefaults[codeLanguage];
        const cap: Partial<ChunkAdjustment> = {};
        if (!hasExplicitMaxTokens) {
          cap.maxTokens = languageDefaults?.maxTokens ?? config.codeMaxTokens;
        }
        if (!hasExplicitOverlap) {
          cap.overlap = languageDefaults?.overlap ?? config.codeOverlap;
        }
        return apply(state, cap);
      });
    }

    if (largeStructuredPatterns.some((pattern) => pattern.test(fileName))) {
      adjustments.push((state) => {
        const cap: Partial<ChunkAdjustment> = {};
        if (!hasExplicitMaxTokens) {
          cap.maxTokens = config.largeStructuredMaxTokens;
        }
        if (!hasExplicitOverlap) {
          cap.overlap = config.largeStructuredOverlap;
        }
        return apply(state, cap);
      });
    }

    if (content.length > config.veryLargeContentThreshold) {
      adjustments.push((state) => {
        const cap: Partial<ChunkAdjustment> = {};
        if (!hasExplicitMaxTokens) {
          cap.maxTokens = config.veryLargeMaxTokens;
        }
        if (!hasExplicitOverlap) {
          cap.overlap = config.veryLargeOverlap;
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
    config.maxTokensHardLimit,
    maxTokensCap,
    hasExplicitMaxTokens
  );
  const overlapLimit = resolveLimit(
    config.overlapHardLimit,
    config.overlapSafetyCap,
    hasExplicitOverlap
  );

  maxTokens = clamp(maxTokens, config.defaultMaxTokens, maxTokensLimit);
  overlap = clamp(overlap, config.defaultOverlap, overlapLimit);

  if (overlap >= maxTokens) {
    overlap = Math.max(0, maxTokens - 1);
  }

  return { maxTokens, overlap };
}

export function isFunctionNode(type?: string): boolean {
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

export function isAstNode(value: unknown): value is AstNode {
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

function collectTopLevelFunctionRanges(
  node: AstNode | null,
  ancestors: AstNode[],
  ranges: FunctionRange[]
): void {
  if (!node) {
    return;
  }

  const parentType = ancestors.at(-1)?.type;
  if (
    isTopLevelContainerType(parentType) &&
    isFunctionNode(node.type ?? '') &&
    Number.isFinite(node.start) &&
    Number.isFinite(node.end)
  ) {
    ranges.push({ end: Number(node.end), start: Number(node.start) });
  }

  ancestors.push(node);
  for (const child of iterateAstChildren(node)) {
    collectTopLevelFunctionRanges(child, ancestors, ranges);
  }
  ancestors.pop();
}

export function getTopLevelFunctionRanges(ast: AstNode | null): FunctionRange[] {
  const ranges: FunctionRange[] = [];
  collectTopLevelFunctionRanges(ast, [], ranges);
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  return ranges;
}

const CODE_SEPARATORS: readonly string[] = [
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

export function getCodeSeparators(custom?: string[]): string[] {
  if (custom?.length) {
    return [...custom];
  }
  // Copy the shared CODE_SEPARATORS so callers can't mutate the constant
  // through the returned reference; preserves readonly safety without
  // changing the public string[] return type.
  return [...CODE_SEPARATORS];
}

export async function splitCodeByFunctionRanges(
  content: string,
  options: {
    readonly maxChars: number;
    readonly overlapChars: number;
    readonly ranges: readonly FunctionRange[];
    readonly separators: string[];
  }
): Promise<string[] | null> {
  if (options.ranges.length === 0) {
    return null;
  }

  const pieces: string[] = [];
  let cursor = 0;
  const recursiveChunker = new RecursiveTextSplitter({
    chunkOverlap: options.overlapChars,
    chunkSize: options.maxChars,
    separators: options.separators,
  });

  const pushSegment = async (segment: string) => {
    const trimmed = segment.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed.length <= options.maxChars * FUNCTION_RANGE_OVERSIZE_TOLERANCE) {
      pieces.push(trimmed);
      return;
    }
    const subPieces = await recursiveChunker.splitText(trimmed);
    pieces.push(...subPieces.map((piece) => piece.trim()).filter(Boolean));
  };

  const appendRange = async (startIndex: number, endIndex: number) => {
    const safeStart = Math.max(0, Math.min(startIndex, content.length));
    const safeEnd = Math.max(safeStart, Math.min(endIndex, content.length));
    await pushSegment(content.slice(safeStart, safeEnd));
  };

  for (const range of options.ranges) {
    const clampedStart = Math.max(0, Math.min(range.start, content.length));
    const clampedEnd = Math.max(clampedStart, Math.min(range.end, content.length));

    if (clampedStart > cursor) {
      await appendRange(cursor, clampedStart);
    }

    const paddedStart = Math.max(0, clampedStart - options.overlapChars);
    const paddedEnd = Math.min(content.length, clampedEnd + options.overlapChars);
    await appendRange(paddedStart, paddedEnd);
    cursor = clampedEnd;
  }

  if (cursor < content.length) {
    await appendRange(cursor, content.length);
  }

  return pieces;
}

export function splitByBlankLines(text: string): string[] {
  const parts: string[] = [];
  let buffer: string[] = [];

  forEachLine(text, (line: string) => {
    if (line.trim() === '') {
      if (buffer.length > 0) {
        parts.push(buffer.join('\n'));
        buffer = [];
      }
    } else {
      buffer.push(line);
    }
  });

  if (buffer.length > 0) {
    parts.push(buffer.join('\n'));
  }

  return parts;
}

function captureFence(
  lines: readonly (string | undefined)[],
  start: number
): { block?: { meta: { isFence: true }; text: string }; consumed: number } {
  const line = lines[start] ?? '';
  const openMatch = MARKDOWN_CODE_FENCE_PATTERN.exec(line);
  if (!openMatch) {
    return { consumed: start };
  }

  const fenceChar = openMatch[1]?.[0] ?? '`';
  const fenceLength = openMatch[1]?.length ?? 3;
  const closingPattern = new RegExp(`^\\s*${fenceChar}{${fenceLength},}\\s*$`);
  const buffer: string[] = [line];
  let index = start + 1;

  while (index < lines.length) {
    const current = lines[index] ?? '';
    if (closingPattern.test(current)) {
      break;
    }
    buffer.push(current);
    index += 1;
  }

  if (index < lines.length) {
    buffer.push(lines[index] ?? '');
    index += 1;
  }

  return {
    block: { meta: { isFence: true }, text: buffer.join('\n') },
    consumed: index,
  };
}

function captureHeading(lines: readonly (string | undefined)[], start: number) {
  const raw = lines[start] ?? '';
  const match = raw.match(/^(#{1,6})\s+(.*)$/);
  if (!match) {
    return { consumed: start } as const;
  }
  return {
    consumed: start + 1,
    heading: { meta: { heading: match[2] ?? '' }, text: raw },
  } as const;
}

function captureParagraph(lines: readonly (string | undefined)[], start: number) {
  const buffer: string[] = [];
  let index = start;

  while (index < lines.length) {
    const current = lines[index] ?? '';
    if (isMarkdownBlockBoundaryLine(current)) {
      break;
    }
    buffer.push(current);
    index += 1;
  }

  if (buffer.length === 0) {
    while (index < lines.length && (lines[index] ?? '').trim() === '') {
      index += 1;
    }
    return { consumed: index } as const;
  }

  while (index < lines.length && (lines[index] ?? '').trim() === '') {
    index += 1;
  }

  return {
    consumed: index,
    paragraph: { meta: {} as const, text: buffer.join('\n') },
  } as const;
}

export function splitMarkdownIntoBlocks(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines: string[] = [];
  forEachLine(content, (line: string) => {
    lines.push(line);
  });

  let index = 0;

  while (index < lines.length) {
    const fence = captureFence(lines, index);
    if (fence.block) {
      blocks.push(fence.block);
      index = fence.consumed;
      continue;
    }

    const heading = captureHeading(lines, index);
    if (heading.heading) {
      blocks.push(heading.heading);
      index = heading.consumed;
      continue;
    }

    const paragraph = captureParagraph(lines, index);
    if (paragraph.paragraph) {
      blocks.push(paragraph.paragraph);
    }
    index = paragraph.consumed;
  }

  return blocks;
}

export function findBalancedSplitPoint(content: string): number {
  const midpoint = Math.floor(content.length / 2);
  const separators = ['\n\n', '\n', '. ', ' '] as const;

  for (const separator of separators) {
    const before = content.lastIndexOf(separator, midpoint);
    if (before > 0 && before < content.length - separator.length) {
      return before + separator.length;
    }

    const after = content.indexOf(separator, midpoint);
    if (after > 0 && after < content.length - separator.length) {
      return after + separator.length;
    }
  }

  return Math.max(1, midpoint);
}

export function assertTokenBudgetIterationsWithinLimit(
  iterations: number,
  maxIterations: number
): void {
  if (iterations > maxIterations) {
    throw new Error(
      `splitChunkToTokenBudget exceeded ${String(maxIterations)} iterations for a single chunk`
    );
  }
}
