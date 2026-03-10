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
  | 'docs'
  | 'api-reference'
  | 'structured-data'
  | 'large-context';

export type ChunkingPresetSelection = ChunkingPresetId | 'custom';

export interface ChunkingPresetDefinition {
  readonly chunkOverlap: number;
  readonly chunkSize: number;
  readonly description: string;
  readonly id: ChunkingPresetId;
  readonly isDefault?: boolean;
  readonly label: string;
  readonly strategy: ChunkingStrategy;
  readonly tokenLimit: number;
}

export interface RecursiveTextSplitterOptions {
  chunkOverlap: number;
  chunkSize: number;
  isSeparatorRegex?: boolean;
  separators?: string[];
}

export interface StrategyTextSplitterOptions extends RecursiveTextSplitterOptions {
  strategy: ResolvedChunkingStrategy;
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

const DEFAULT_SEPARATORS = ['\n\n', '\n', ' ', ''];

const CHUNKING_PRESETS: readonly ChunkingPresetDefinition[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'General-purpose defaults that auto-detect the best splitter for most files.',
    strategy: 'auto',
    chunkSize: 256,
    chunkOverlap: 50,
    tokenLimit: 4096,
    isDefault: true,
  },
  {
    id: 'codebase',
    label: 'Codebase',
    description: 'Keeps code boundaries tighter for retrieval and change-locality.',
    strategy: 'recursive',
    chunkSize: 224,
    chunkOverlap: 48,
    tokenLimit: 3072,
  },
  {
    id: 'docs',
    label: 'Docs',
    description: 'Prefers semantic markdown grouping for guides, notes, and README-heavy content.',
    strategy: 'semantic-markdown',
    chunkSize: 320,
    chunkOverlap: 56,
    tokenLimit: 4096,
  },
  {
    id: 'api-reference',
    label: 'API Reference',
    description: 'Smaller, denser chunks for reference docs where precision matters.',
    strategy: 'markdown',
    chunkSize: 192,
    chunkOverlap: 32,
    tokenLimit: 3072,
  },
  {
    id: 'structured-data',
    label: 'Structured Data',
    description: 'Structure-aware splitting for JSON-like payloads and schema-heavy content.',
    strategy: 'json',
    chunkSize: 384,
    chunkOverlap: 64,
    tokenLimit: 6144,
  },
  {
    id: 'large-context',
    label: 'Large Context',
    description: 'Fewer, larger chunks when downstream models can tolerate bigger payloads.',
    strategy: 'token',
    chunkSize: 512,
    chunkOverlap: 64,
    tokenLimit: 8192,
  },
] as const;

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
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
    return [...DEFAULT_SEPARATORS];
  }
  assertSeparators(separators);
  return [...separators];
}

function separatorMatches(text: string, separator: string, isSeparatorRegex: boolean): boolean {
  if (separator === '') {
    return true;
  }
  if (!isSeparatorRegex) {
    return text.includes(separator);
  }
  return new RegExp(separator, 'm').test(text);
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
  const regex = new RegExp(separator, 'gm');
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
    const chunk = text.slice(cursor, Math.min(text.length, cursor + chunkSize)).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    if (cursor + chunkSize >= text.length) {
      break;
    }
  }
  return chunks;
}

function selectSeparator(text: string, separators: string[], isSeparatorRegex: boolean): number {
  for (let index = 0; index < separators.length; index += 1) {
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
  isSeparatorRegex: boolean
): string[] {
  if (text.length <= chunkSize) {
    return [text];
  }

  const separatorIndex = selectSeparator(text, separators, isSeparatorRegex);
  const separator = separators[separatorIndex];
  if (separator === undefined) {
    throw new Error('separator resolution produced an invalid index');
  }

  if (separator === '') {
    return splitByLength(text, chunkSize);
  }

  const remainingSeparators = separators.slice(separatorIndex + 1);
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
    if (remainingSeparators.length === 0) {
      segments.push(...splitByLength(piece, chunkSize));
      continue;
    }
    segments.push(
      ...splitIntoAtomicSegments(piece, remainingSeparators, chunkSize, isSeparatorRegex)
    );
  }

  return segments;
}

function mergeAtomicSegments(
  atomicSegments: string[],
  chunkSize: number,
  chunkOverlap: number
): string[] {
  const normalizedSegments = atomicSegments.filter((segment) => segment.length > 0);
  if (normalizedSegments.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  const currentSegments: string[] = [];
  let currentLength = 0;

  const flushCurrentChunk = (): void => {
    const chunk = currentSegments.join('').trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  };

  for (const segment of normalizedSegments) {
    if (currentLength + segment.length > chunkSize && currentSegments.length > 0) {
      flushCurrentChunk();

      while (
        currentLength > chunkOverlap ||
        (currentLength + segment.length > chunkSize && currentLength > 0)
      ) {
        const removedSegment = currentSegments.shift();
        if (removedSegment === undefined) {
          throw new Error('segment merge state became inconsistent');
        }
        currentLength -= removedSegment.length;
      }
    }

    currentSegments.push(segment);
    currentLength += segment.length;
  }

  if (currentSegments.length > 0) {
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

function getStrategySeparators(
  strategy: ResolvedChunkingStrategy,
  custom?: string[]
): { isSeparatorRegex: boolean; separators: string[] } {
  if (custom?.length) {
    return { separators: [...custom], isSeparatorRegex: false };
  }

  switch (strategy) {
    case 'character':
      return { separators: [''], isSeparatorRegex: false };
    case 'token':
      return { separators: ['\n\n', '\n', '. ', '; ', ' ', ''], isSeparatorRegex: false };
    case 'sentence':
      return {
        separators: ['\n\n', '\n', '. ', '! ', '? ', '; ', ': ', ' ', ''],
        isSeparatorRegex: false,
      };
    case 'markdown':
      return {
        separators: [
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
        isSeparatorRegex: false,
      };
    case 'semantic-markdown':
      return {
        separators: ['\n## ', '\n### ', '\n#### ', '\n\n', '\n', '. ', ' ', ''],
        isSeparatorRegex: false,
      };
    case 'html':
      return {
        separators: [
          '</section>',
          '</article>',
          '</main>',
          '</div>',
          '</p>',
          '</li>',
          '<br',
          '\n',
          ' ',
          '',
        ],
        isSeparatorRegex: false,
      };
    case 'json':
      return {
        separators: ['},\n', '},', '],\n', '],', ',\n', '\n', ' ', ''],
        isSeparatorRegex: false,
      };
    case 'latex':
      return {
        separators: [
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
        isSeparatorRegex: false,
      };
    case 'recursive':
      return { separators: [...DEFAULT_SEPARATORS], isSeparatorRegex: false };
  }
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
  if (typeof text !== 'string') {
    throw new Error('text must be a string');
  }

  assertPositiveInteger(options.chunkSize, 'chunkSize');
  assertNonNegativeInteger(options.chunkOverlap, 'chunkOverlap');

  if (options.chunkOverlap >= options.chunkSize) {
    throw new Error('chunkOverlap must be smaller than chunkSize');
  }

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
  if (typeof text !== 'string') {
    throw new Error('text must be a string');
  }

  assertPositiveInteger(options.chunkSize, 'chunkSize');
  assertNonNegativeInteger(options.chunkOverlap, 'chunkOverlap');

  if (options.chunkOverlap >= options.chunkSize) {
    throw new Error('chunkOverlap must be smaller than chunkSize');
  }

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
  if (extension === 'md' || extension === 'mdx' || extension === 'markdown') {
    return 'semantic-markdown';
  }
  if (extension === 'html' || extension === 'htm' || extension === 'xhtml' || extension === 'xml') {
    return 'html';
  }
  if (extension === 'json') {
    return 'json';
  }
  if (extension === 'tex' || extension === 'latex') {
    return 'latex';
  }
  return 'sentence';
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
