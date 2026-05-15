export type ResolvedChunkingStrategy =
  | 'character'
  | 'recursive'
  | 'token'
  | 'markdown'
  | 'semantic-markdown'
  | 'html'
  | 'json'
  | 'latex'
  | 'sentence';

export type ChunkingStrategy = 'auto' | ResolvedChunkingStrategy;

export type ChunkingPresetId =
  | 'balanced'
  | 'codebase'
  | 'strict-code'
  | 'docs'
  | 'api-reference'
  | 'structured-data'
  | 'large-context';

export type ChunkingPresetSelection = ChunkingPresetId | 'custom';

export interface ChunkingPresetDefinition {
  readonly adaptiveRouting: boolean;
  readonly bestFor: readonly string[];
  readonly chunkOverlap: number;
  readonly chunkSize: number;
  readonly description: string;
  readonly id: ChunkingPresetId;
  readonly isDefault?: boolean;
  readonly label: string;
  readonly strategy: ChunkingStrategy;
  readonly tokenLimit: number;
  readonly tradeoff: string;
}

export interface ChunkingRoutePreview {
  readonly fileName: string;
  readonly label: string;
  readonly reason: string;
  readonly resolvedStrategy: ResolvedChunkingStrategy;
}

export interface RecursiveTextSplitterOptions {
  chunkOverlap: number;
  chunkSize: number;
  /**
   * Treats each separator as a trusted regular expression source.
   *
   * This is intended only for configuration-controlled inputs. Do not pass
   * user-provided regex strings through this path.
   */
  isSeparatorRegex?: boolean;
  separators?: string[];
}

export interface StrategyTextSplitterOptions extends RecursiveTextSplitterOptions {
  strategy: ResolvedChunkingStrategy;
}

export function countTokensHeuristic(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

export const MARKDOWN_CODE_FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;

export function isMarkdownBlockBoundaryLine(line: string): boolean {
  return MARKDOWN_CODE_FENCE_PATTERN.test(line) || /^(#{1,6})\s+/.test(line) || line.trim() === '';
}

export function formatTokenCount(count: number): string {
  if (count < 1000) {
    return `${count} tokens`;
  }

  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1)}K tokens`;
  }

  return `${(count / 1_000_000).toFixed(1)}M tokens`;
}

export function estimateTokenCost(inputTokens: number, outputTokens = 0): number {
  // These rates are only a UI heuristic for quick cost previews and are not used
  // for billing or enforcement. They are loosely aligned with GPT-4-class pricing
  // as of early 2026 (last verified 2026-03) and must be updated intentionally
  // alongside model pricing.
  const inputCost = inputTokens * 0.000_01;
  const outputCost = outputTokens * 0.000_03;
  return inputCost + outputCost;
}

const CODE_EXTENSIONS = new Set([
  'js',
  'ts',
  'jsx',
  'tsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'py',
  'java',
  'cpp',
  'c',
  'h',
  'hpp',
  'cs',
  'php',
  'rb',
  'go',
  'rs',
  'swift',
  'kt',
  'kts',
  'scala',
  'vue',
  'svelte',
]);

const RESOLVED_CHUNKING_STRATEGIES = new Set<ResolvedChunkingStrategy>([
  'character',
  'recursive',
  'token',
  'markdown',
  'semantic-markdown',
  'html',
  'json',
  'latex',
  'sentence',
]);

const DEFAULT_SEPARATORS = ['\n\n', '\n', ' ', ''];
const MAX_SEPARATOR_REGEX_CACHE_SIZE = 64;
const SEPARATOR_REGEX_CACHE = new Map<string, RegExp>();

export { ACCURATE_TOKEN_ENCODING, ACCURATE_TOKEN_MODEL_HINT } from './token-constants';
export {
  countTokensAccurate,
  disposeAccurateTokenCountingRuntime,
  getAccurateTokenCountingFailureReason,
  supportsAccurateTokenCounting,
} from './token-utils-accurate-lite';

export function isResolvedChunkingStrategy(value: unknown): value is ResolvedChunkingStrategy {
  return (
    typeof value === 'string' && RESOLVED_CHUNKING_STRATEGIES.has(value as ResolvedChunkingStrategy)
  );
}

export function isChunkingStrategy(value: unknown): value is ChunkingStrategy {
  return value === 'auto' || isResolvedChunkingStrategy(value);
}

const CHUNKING_PRESETS: readonly ChunkingPresetDefinition[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'General-purpose defaults that auto-detect the best splitter for most files.',
    adaptiveRouting: true,
    bestFor: ['mixed repos', 'teams starting out', 'general retrieval'],
    strategy: 'auto',
    chunkSize: 256,
    chunkOverlap: 50,
    tokenLimit: 4096,
    isDefault: true,
    tradeoff: 'Not as aggressive as specialist presets for code-only or schema-heavy corpora.',
  },
  {
    id: 'codebase',
    label: 'Codebase',
    description:
      'Adaptive mixed-repo preset: code stays tight while docs and data keep their own structure.',
    adaptiveRouting: true,
    bestFor: ['monorepos', 'product docs + code', 'engineering assistants'],
    strategy: 'auto',
    chunkSize: 224,
    chunkOverlap: 40,
    tokenLimit: 3072,
    tradeoff: 'More conservative chunk sizing can increase chunk count on very large repos.',
  },
  {
    id: 'strict-code',
    label: 'Strict Code',
    description:
      'Forces recursive code-centric chunking for source-only corpora where locality matters most.',
    adaptiveRouting: false,
    bestFor: ['source-only repos', 'symbol retrieval', 'diff-aware assistants'],
    strategy: 'recursive',
    chunkSize: 192,
    chunkOverlap: 40,
    tokenLimit: 3072,
    tradeoff: 'Will over-treat docs and schemas as code if you point it at a mixed corpus.',
  },
  {
    id: 'docs',
    label: 'Docs',
    description: 'Prefers semantic markdown grouping for guides, notes, and README-heavy content.',
    adaptiveRouting: false,
    bestFor: ['handbooks', 'runbooks', 'README sets'],
    strategy: 'semantic-markdown',
    chunkSize: 320,
    chunkOverlap: 56,
    tokenLimit: 4096,
    tradeoff: 'Non-markdown files won’t benefit from the heading-family bias.',
  },
  {
    id: 'api-reference',
    label: 'API Reference',
    description: 'Smaller, denser chunks for reference docs where precision matters.',
    adaptiveRouting: false,
    bestFor: ['API docs', 'SDK references', 'parameter lookups'],
    strategy: 'markdown',
    chunkSize: 192,
    chunkOverlap: 32,
    tokenLimit: 3072,
    tradeoff: 'Can fragment long-form guides more than general-purpose presets.',
  },
  {
    id: 'structured-data',
    label: 'Structured Data',
    description: 'Structure-aware splitting for JSON-like payloads and schema-heavy content.',
    adaptiveRouting: false,
    bestFor: ['JSON payloads', 'schemas', 'machine-readable docs'],
    strategy: 'json',
    chunkSize: 384,
    chunkOverlap: 64,
    tokenLimit: 6144,
    tradeoff: 'Less effective for prose-heavy files that only happen to live near structured data.',
  },
  {
    id: 'large-context',
    label: 'Large Context',
    description: 'Fewer, larger chunks when downstream models can tolerate bigger payloads.',
    adaptiveRouting: false,
    bestFor: ['large-context models', 'broad semantic recall', 'fewer chunk boundaries'],
    strategy: 'token',
    chunkSize: 512,
    chunkOverlap: 64,
    tokenLimit: 8192,
    tradeoff: 'Bigger chunks can reduce precision for exact retrieval and reranking.',
  },
] as const;

const ROUTE_PREVIEW_CANDIDATES: readonly Omit<ChunkingRoutePreview, 'resolvedStrategy'>[] = [
  {
    label: 'Code module',
    fileName: 'src/assistant/retrieval.ts',
    reason: 'Keeps symbols and local control flow together for code retrieval.',
  },
  {
    label: 'Guide / handbook',
    fileName: 'docs/getting-started.md',
    reason: 'Preserves heading families so sections stay coherent in retrieval.',
  },
  {
    label: 'Structured payload',
    fileName: 'schemas/search-response.json',
    reason: 'Favors object and array boundaries instead of sentence splits.',
  },
  {
    label: 'Markup page',
    fileName: 'public/reference/index.html',
    reason: 'Uses block and tag boundaries so markup stays readable in context.',
  },
  {
    label: 'Research paper',
    fileName: 'notes/retrieval-paper.tex',
    reason: 'Prefers section and environment boundaries for long technical writing.',
  },
  {
    label: 'Plain notes',
    fileName: 'notes/retro.txt',
    reason: 'Falls back to natural sentence boundaries for general prose.',
  },
] as const;

function assertInteger(value: number, label: string, allowZero: boolean): void {
  if (!Number.isInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} integer`);
  }
}

function assertSplitOptions(text: unknown, chunkSize: number, chunkOverlap: number): void {
  if (typeof text !== 'string') {
    throw new Error('text must be a string');
  }
  assertInteger(chunkSize, 'chunkSize', false);
  assertInteger(chunkOverlap, 'chunkOverlap', true);
  if (chunkOverlap >= chunkSize) {
    throw new Error('chunkOverlap must be smaller than chunkSize');
  }
}

function assertSeparators(separators: string[]): void {
  if (separators.length === 0) {
    throw new Error('separators must contain at least one entry');
  }
  for (const separator of separators) {
    if (typeof separator !== 'string') {
      throw new Error('separators must be strings');
    }
  }
}

function resolveSeparators(separators?: string[]): string[] {
  if (!separators) {
    // Defensive copy: callers receive an owned array they can pass on without
    // risking mutation back to the module-level DEFAULT_SEPARATORS constant.
    // The single per-splitText allocation is trivial.
    return [...DEFAULT_SEPARATORS];
  }
  assertSeparators(separators);
  return [...separators];
}

function createSeparatorRegex(separator: string, flags: string): RegExp {
  try {
    return new RegExp(separator, flags);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regex separator "${separator}": ${message}`);
  }
}

function separatorMatches(text: string, separator: string, isSeparatorRegex: boolean): boolean {
  if (separator === '') {
    return true;
  }
  if (!isSeparatorRegex) {
    return text.includes(separator);
  }
  let compiled = SEPARATOR_REGEX_CACHE.get(separator);
  if (!compiled) {
    // Regex separators are an advanced trusted-input path driven by explicit
    // app configuration, not arbitrary untrusted user input.
    if (SEPARATOR_REGEX_CACHE.size >= MAX_SEPARATOR_REGEX_CACHE_SIZE) {
      const oldestKey = SEPARATOR_REGEX_CACHE.keys().next().value;
      if (typeof oldestKey === 'string') {
        SEPARATOR_REGEX_CACHE.delete(oldestKey);
      }
    }
    compiled = createSeparatorRegex(separator, 'm');
    SEPARATOR_REGEX_CACHE.set(separator, compiled);
  }
  return compiled.test(text);
}

function splitByLiteralSeparator(text: string, separator: string): string[] {
  if (separator === '') {
    return Array.from(text);
  }

  const segments: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const separatorIndex = text.indexOf(separator, cursor);
    if (separatorIndex === -1) {
      const tail = text.slice(cursor);
      if (tail.length > 0) {
        segments.push(tail);
      }
      break;
    }
    const nextCursor = separatorIndex + separator.length;
    const piece = text.slice(cursor, nextCursor);
    if (piece.length > 0) {
      segments.push(piece);
    }
    cursor = nextCursor;
  }
  return segments;
}

function splitByRegexSeparator(text: string, separator: string): string[] {
  const regex = createSeparatorRegex(separator, 'gm');
  const segments: string[] = [];
  let cursor = 0;

  for (const match of text.matchAll(regex)) {
    const index = match.index;
    const matchedText = match[0];
    if (index === undefined || matchedText === undefined) {
      continue;
    }
    const nextCursor = index + matchedText.length;
    const piece = text.slice(cursor, nextCursor);
    if (piece.length > 0) {
      segments.push(piece);
    }
    cursor = nextCursor;
  }

  if (cursor < text.length) {
    segments.push(text.slice(cursor));
  }

  return segments;
}

function splitBySeparator(text: string, separator: string, isSeparatorRegex: boolean): string[] {
  if (!isSeparatorRegex) {
    return splitByLiteralSeparator(text, separator);
  }
  return splitByRegexSeparator(text, separator);
}

function splitByLength(text: string, chunkSize: number): string[] {
  if (text.length <= chunkSize) {
    return [text];
  }
  const segments: string[] = [];
  for (let cursor = 0; cursor < text.length; cursor += chunkSize) {
    segments.push(text.slice(cursor, Math.min(text.length, cursor + chunkSize)));
  }
  return segments;
}

function splitByLengthWithOverlap(text: string, chunkSize: number, chunkOverlap: number): string[] {
  if (text.length <= chunkSize) {
    return [text];
  }

  const step = chunkSize - chunkOverlap;
  if (step <= 0) {
    throw new Error('chunkOverlap must be smaller than chunkSize');
  }

  const chunks: string[] = [];
  for (let cursor = 0; cursor < text.length; cursor += step) {
    const chunk = text.slice(cursor, Math.min(text.length, cursor + chunkSize));
    // Preserve the raw overlap window so the requested overlap remains byte-stable.
    // We only drop slices that are entirely whitespace noise.
    if (chunk.trim().length > 0) {
      chunks.push(chunk);
    }
    if (cursor + chunkSize >= text.length) {
      break;
    }
  }
  return chunks;
}

function selectSeparator(
  text: string,
  separators: string[],
  startIndex: number,
  isSeparatorRegex: boolean
): number {
  for (let index = startIndex; index < separators.length; index += 1) {
    const separator = separators[index];
    if (separator === undefined) {
      continue;
    }
    if (separatorMatches(text, separator, isSeparatorRegex)) {
      return index;
    }
  }
  return separators.length - 1;
}

function splitIntoAtomicSegments(
  text: string,
  separators: string[],
  chunkSize: number,
  isSeparatorRegex: boolean,
  startIndex = 0
): string[] {
  if (text.length <= chunkSize) {
    return [text];
  }

  const separatorIndex = selectSeparator(text, separators, startIndex, isSeparatorRegex);
  const separator = separators[separatorIndex];
  if (separator === undefined) {
    throw new Error('separator resolution produced an invalid index');
  }

  if (separator === '') {
    return splitByLength(text, chunkSize);
  }

  const nextStartIndex = separatorIndex + 1;
  const hasRemainingSeparators = nextStartIndex < separators.length;
  const pieces = splitBySeparator(text, separator, isSeparatorRegex);
  const segments: string[] = [];

  for (const piece of pieces) {
    if (piece.length === 0) {
      continue;
    }
    if (piece.length <= chunkSize) {
      segments.push(piece);
      continue;
    }
    if (!hasRemainingSeparators) {
      segments.push(...splitByLength(piece, chunkSize));
      continue;
    }
    segments.push(
      ...splitIntoAtomicSegments(piece, separators, chunkSize, isSeparatorRegex, nextStartIndex)
    );
  }

  return segments;
}

function mergeAtomicSegments(
  atomicSegments: string[],
  chunkSize: number,
  chunkOverlap: number
): string[] {
  const chunks: string[] = [];
  // Sliding window over atomicSegments: [head, tail) are currently in the window.
  // Advancing `head` instead of Array.shift() keeps eviction O(1) per step;
  // the previous shift-loop was O(N) per evicted segment on a window that can
  // grow to hundreds of pieces for large documents.
  const window: string[] = [];
  let head = 0;
  let currentLength = 0;

  const flushCurrentChunk = (): void => {
    let buffer = '';
    for (let i = head; i < window.length; i += 1) {
      buffer += window[i];
    }
    const chunk = buffer.trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  };

  for (const segment of atomicSegments) {
    if (segment.length === 0) {
      continue;
    }

    if (currentLength + segment.length > chunkSize && head < window.length) {
      flushCurrentChunk();

      while (
        head < window.length &&
        (currentLength > chunkOverlap ||
          (currentLength + segment.length > chunkSize && currentLength > 0))
      ) {
        const removedSegment = window[head];
        if (removedSegment === undefined) {
          throw new Error('segment merge state became inconsistent');
        }
        currentLength -= removedSegment.length;
        head += 1;
      }
    }

    window.push(segment);
    currentLength += segment.length;
  }

  if (head < window.length) {
    flushCurrentChunk();
  }

  return chunks;
}

function splitTextIntoSections(text: string, matcher: RegExp, includeDelimiter = true): string[] {
  const sections: string[] = [];
  const matches = Array.from(text.matchAll(matcher));
  if (matches.length === 0) {
    return [text];
  }

  let cursor = 0;
  for (const match of matches) {
    const index = match.index;
    if (index === undefined) {
      continue;
    }
    if (index > cursor) {
      const leading = text.slice(cursor, index).trim();
      if (leading.length > 0) {
        sections.push(leading);
      }
    }
    cursor = includeDelimiter ? index : index + match[0].length;
  }

  const tail = text.slice(cursor).trim();
  if (tail.length > 0) {
    sections.push(tail);
  }
  return sections.length > 0 ? sections : [text];
}

function getFileExtension(filePath: string): string {
  const normalized = filePath.toLowerCase();
  const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  const lastDot = normalized.lastIndexOf('.');
  if (lastDot === -1 || lastDot < lastSlash) {
    return '';
  }
  return normalized.slice(lastDot + 1);
}

const STRATEGY_SEPARATORS: Readonly<Record<ResolvedChunkingStrategy, string[]>> = {
  character: [''],
  token: ['\n\n', '\n', '. ', '; ', ' ', ''],
  sentence: ['\n\n', '\n', '. ', '! ', '? ', '; ', ': ', ' ', ''],
  markdown: [
    '\n# ',
    '\n## ',
    '\n### ',
    '\n#### ',
    '\n```',
    '\n- ',
    '\n* ',
    '\n> ',
    '\n\n',
    '\n',
    '. ',
    ' ',
    '',
  ],
  'semantic-markdown': ['\n## ', '\n### ', '\n#### ', '\n\n', '\n', '. ', ' ', ''],
  html: ['</section>', '</article>', '</main>', '</div>', '</p>', '</li>', '<br', '\n', ' ', ''],
  json: ['},\n', '},', '],\n', '],', ',\n', '\n', ' ', ''],
  latex: [
    '\n\\chapter{',
    '\n\\section{',
    '\n\\subsection{',
    '\n\\subsubsection{',
    '\n\\begin{',
    '\n\n',
    '\n',
    ' ',
    '',
  ],
  recursive: DEFAULT_SEPARATORS,
};

function getStrategySeparators(
  strategy: ResolvedChunkingStrategy,
  custom?: string[]
): { isSeparatorRegex: boolean; separators: string[] } {
  if (custom?.length) {
    return { separators: [...custom], isSeparatorRegex: false };
  }
  // Copy the shared table entry so the caller can't mutate the module-level
  // STRATEGY_SEPARATORS through the returned reference.
  return { separators: [...STRATEGY_SEPARATORS[strategy]], isSeparatorRegex: false };
}

function splitMarkdownSemantically(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
  customSeparators?: string[]
): string[] {
  const headingRegex = /^(#{1,6})\s+.+$/gm;
  const sections = splitTextIntoSections(text, headingRegex);
  const { separators, isSeparatorRegex } = getStrategySeparators(
    'semantic-markdown',
    customSeparators
  );
  const normalized: string[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.length <= chunkSize) {
      normalized.push(trimmed);
      continue;
    }
    const atomicSegments = splitIntoAtomicSegments(
      trimmed,
      separators,
      chunkSize,
      isSeparatorRegex
    );
    normalized.push(...mergeAtomicSegments(atomicSegments, chunkSize, chunkOverlap));
  }

  return mergeAtomicSegments(normalized, chunkSize, chunkOverlap);
}

function splitMarkdownBySections(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
  customSeparators?: string[]
): string[] {
  const headingRegex = /^(#{1,6})\s+.+$/gm;
  const sections = splitTextIntoSections(text, headingRegex);
  const { separators, isSeparatorRegex } = getStrategySeparators('markdown', customSeparators);
  const normalized: string[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.length <= chunkSize) {
      normalized.push(trimmed);
      continue;
    }
    normalized.push(
      ...splitTextRecursively(trimmed, {
        chunkSize,
        chunkOverlap,
        separators,
        isSeparatorRegex,
      })
    );
  }

  return mergeAtomicSegments(normalized, chunkSize, chunkOverlap);
}

export function splitTextRecursively(
  text: string,
  options: RecursiveTextSplitterOptions
): string[] {
  assertSplitOptions(text, options.chunkSize, options.chunkOverlap);

  const separators = resolveSeparators(options.separators);
  const atomicSegments = splitIntoAtomicSegments(
    text,
    separators,
    options.chunkSize,
    options.isSeparatorRegex === true
  );

  return mergeAtomicSegments(atomicSegments, options.chunkSize, options.chunkOverlap);
}

export function splitTextByStrategy(text: string, options: StrategyTextSplitterOptions): string[] {
  assertSplitOptions(text, options.chunkSize, options.chunkOverlap);

  switch (options.strategy) {
    case 'character':
      return splitByLengthWithOverlap(text, options.chunkSize, options.chunkOverlap);
    case 'markdown':
      return splitMarkdownBySections(
        text,
        options.chunkSize,
        options.chunkOverlap,
        options.separators
      );
    case 'semantic-markdown':
      return splitMarkdownSemantically(
        text,
        options.chunkSize,
        options.chunkOverlap,
        options.separators
      );
    default: {
      const { separators, isSeparatorRegex } = getStrategySeparators(
        options.strategy,
        options.separators
      );
      return splitTextRecursively(text, {
        chunkSize: options.chunkSize,
        chunkOverlap: options.chunkOverlap,
        separators,
        isSeparatorRegex,
      });
    }
  }
}

export function getChunkingPresetDefinitions(): readonly ChunkingPresetDefinition[] {
  return CHUNKING_PRESETS;
}

export function getChunkingPreset(id: ChunkingPresetId): ChunkingPresetDefinition {
  const preset = CHUNKING_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) {
    throw new Error(`Unknown chunking preset: ${id}`);
  }
  return preset;
}

const EXTENSION_STRATEGY_MAP = new Map<string, ResolvedChunkingStrategy>([
  ['md', 'semantic-markdown'],
  ['mdx', 'semantic-markdown'],
  ['markdown', 'semantic-markdown'],
  ['rst', 'semantic-markdown'],
  ['adoc', 'semantic-markdown'],
  ['asciidoc', 'semantic-markdown'],
  ['html', 'html'],
  ['htm', 'html'],
  ['xhtml', 'html'],
  ['xml', 'html'],
  ['svg', 'html'],
  ['json', 'json'],
  ['jsonl', 'json'],
  ['ndjson', 'json'],
  ['geojson', 'json'],
  ['ipynb', 'json'],
  ['tex', 'latex'],
  ['latex', 'latex'],
  ['bib', 'latex'],
]);

export function resolveChunkingStrategyForFile(
  filePath: string,
  requested: ChunkingStrategy = 'auto'
): ResolvedChunkingStrategy {
  if (requested !== 'auto') {
    return requested;
  }

  const extension = getFileExtension(filePath);
  if (CODE_EXTENSIONS.has(extension)) {
    return 'recursive';
  }
  return EXTENSION_STRATEGY_MAP.get(extension) ?? 'sentence';
}

export function resolveEffectiveChunkingStrategy({
  requested,
  resolvedAutoStrategy,
  isCode,
}: {
  requested: ChunkingStrategy;
  resolvedAutoStrategy: ResolvedChunkingStrategy;
  isCode: boolean;
}): ResolvedChunkingStrategy {
  if (requested !== 'auto') {
    return requested;
  }
  if (resolvedAutoStrategy === 'recursive' && !isCode) {
    return 'sentence';
  }
  return resolvedAutoStrategy;
}

export function getChunkingRoutePreview(
  requested: ChunkingStrategy = 'auto'
): readonly ChunkingRoutePreview[] {
  return ROUTE_PREVIEW_CANDIDATES.map((candidate) => ({
    ...candidate,
    resolvedStrategy: resolveChunkingStrategyForFile(candidate.fileName, requested),
  }));
}

export class RecursiveTextSplitter {
  readonly #options: RecursiveTextSplitterOptions;

  constructor(options: RecursiveTextSplitterOptions) {
    const resolvedOptions: RecursiveTextSplitterOptions = {
      chunkSize: options.chunkSize,
      chunkOverlap: options.chunkOverlap,
      separators: resolveSeparators(options.separators),
    };
    if (options.isSeparatorRegex !== undefined) {
      resolvedOptions.isSeparatorRegex = options.isSeparatorRegex;
    }
    this.#options = resolvedOptions;
  }

  async splitText(text: string): Promise<string[]> {
    return splitTextRecursively(text, this.#options);
  }
}
