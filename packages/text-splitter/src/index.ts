export interface RecursiveTextSplitterOptions {
  chunkOverlap: number;
  chunkSize: number;
  isSeparatorRegex?: boolean;
  separators?: string[];
}

const DEFAULT_SEPARATORS = ['\n\n', '\n', ' ', ''];

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
