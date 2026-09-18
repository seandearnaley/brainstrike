import type { ResolvedChunkingStrategy } from '@brainstrike/indexing-contract';

export type {
  ChunkingPresetDefinition,
  ChunkingPresetId,
  ChunkingPresetSelection,
  ChunkingRoutePreview,
  ChunkingStrategy,
  ResolvedChunkingStrategy,
} from '@brainstrike/indexing-contract';
/**
 * Chunking-policy ownership (BST-1144): `@brainstrike/indexing-contract` is the
 * single canonical home of the chunking-policy surface — strategy/preset
 * types, preset definitions, and strategy-resolution/route-preview behavior.
 * This package re-exports that surface so existing `@brainstrike/text-splitter`
 * consumers keep working. Do not reintroduce local copies here: the two
 * packages previously drifted by a single character with no test catching it.
 */
export {
  getChunkingPreset,
  getChunkingPresetDefinitions,
  getChunkingRoutePreview,
  isChunkingStrategy,
  isResolvedChunkingStrategy,
  resolveChunkingStrategyForFile,
  resolveEffectiveChunkingStrategy,
} from '@brainstrike/indexing-contract';

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

export const MARKDOWN_CODE_FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;

export function isMarkdownBlockBoundaryLine(line: string): boolean {
  return MARKDOWN_CODE_FENCE_PATTERN.test(line) || /^(#{1,6})\s+/.test(line) || line.trim() === '';
}

const DEFAULT_SEPARATORS = ['\n\n', '\n', ' ', ''];
const MAX_SEPARATOR_REGEX_CACHE_SIZE = 64;
const SEPARATOR_REGEX_CACHE = new Map<string, RegExp>();

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

const STRATEGY_SEPARATORS: Readonly<Record<ResolvedChunkingStrategy, string[]>> = {
  character: [''],
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
  recursive: DEFAULT_SEPARATORS,
  'semantic-markdown': ['\n## ', '\n### ', '\n#### ', '\n\n', '\n', '. ', ' ', ''],
  sentence: ['\n\n', '\n', '. ', '! ', '? ', '; ', ': ', ' ', ''],
  token: ['\n\n', '\n', '. ', '; ', ' ', ''],
};

function getStrategySeparators(
  strategy: ResolvedChunkingStrategy,
  custom?: string[]
): { isSeparatorRegex: boolean; separators: string[] } {
  if (custom?.length) {
    return { isSeparatorRegex: false, separators: [...custom] };
  }
  // Copy the shared table entry so the caller can't mutate the module-level
  // STRATEGY_SEPARATORS through the returned reference.
  return { isSeparatorRegex: false, separators: [...STRATEGY_SEPARATORS[strategy]] };
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
        chunkOverlap,
        chunkSize,
        isSeparatorRegex,
        separators,
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
        chunkOverlap: options.chunkOverlap,
        chunkSize: options.chunkSize,
        isSeparatorRegex,
        separators,
      });
    }
  }
}

export class RecursiveTextSplitter {
  readonly #options: RecursiveTextSplitterOptions;

  constructor(options: RecursiveTextSplitterOptions) {
    const resolvedOptions: RecursiveTextSplitterOptions = {
      chunkOverlap: options.chunkOverlap,
      chunkSize: options.chunkSize,
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
