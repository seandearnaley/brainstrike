/**
 * Source-range resolution for chunked content.
 * Extracted verbatim from portable-chunking.ts (BST-1129) — maps each
 * splitter-produced chunk back to its start/end offset and line range in the
 * original source, tolerating whitespace normalization introduced by the
 * splitter, plus the chars-per-token estimation helper used alongside it.
 * `TokenCounter` is declared here (not in portable-chunking.ts) so the
 * dependency edge stays one-directional — portable-chunking.ts imports it
 * type-only, matching the line-offsets.ts precedent for avoiding a cycle
 * between the two modules.
 */

import { CHUNKING_CONFIG } from './chunking-config';
import {
  buildLineStartOffsets as buildLineStarts,
  findLineForOffset as lineForOffset,
} from './line-offsets';

export type TokenCounter = (text: string) => number;

const CHARS_PER_TOKEN_SAMPLE_BYTES = 10_000;
const CHARS_PER_TOKEN_MAX = 8;
const MAX_WHITESPACE_NORMALIZED_SOURCE_CANDIDATES = 10_000;
const MAX_WHITESPACE_NORMALIZED_ANCHORS = 64;

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

/** Validate a supplied span with the chunker's existing matcher; do not relocate it. */
export function matchesChunkSourceRange(
  content: string,
  chunkContent: string,
  startOffset: number,
  endOffset: number
): boolean {
  if (
    !(Number.isSafeInteger(startOffset) && Number.isSafeInteger(endOffset)) ||
    startOffset < 0 ||
    endOffset <= startOffset ||
    endOffset > content.length ||
    chunkContent.length === 0
  ) {
    return false;
  }
  const source = content.slice(startOffset, endOffset);
  const match = findSourceRangeForChunkContent(source, chunkContent, 0);
  return match?.startOffset === 0 && match.endOffset === source.length;
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
              endOffset,
              matchKind: 'whitespace-normalized',
              startOffset: candidateOffset,
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
      endOffset: exactStartOffset + chunkContent.length,
      matchKind: 'exact',
      startOffset: exactStartOffset,
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
        endOffset,
        matchKind: 'whitespace-normalized',
        startOffset: candidateOffset,
      };
    }

    candidateOffset = content.indexOf(firstCharacter, candidateOffset + 1);
  }

  return null;
}

export function resolveSourceRanges(
  content: string,
  chunks: readonly { content: string }[],
  overlapChars: number
): SourceRangeResolution {
  const lineStarts = buildLineStarts(content);
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
      endLine: lineForOffset(lineStarts, Math.max(startOffset, endOffset - 1)),
      endOffset,
      startLine: lineForOffset(lineStarts, startOffset),
      startOffset,
    };
  });

  return { fuzzyMatchedChunks, ranges };
}

export function computeCharsPerToken(
  content: string,
  useAccurate: boolean,
  countTokens: TokenCounter
): number {
  const sample = content.slice(0, Math.min(CHARS_PER_TOKEN_SAMPLE_BYTES, content.length));
  const tokens = countTokens(sample);
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
