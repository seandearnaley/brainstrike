import {
  type ContextLineRange,
  normalizeContextLineRanges,
  splitContentLines,
} from '@brainstrike/utils';
import type { TapestryRange } from '../tapestry/types';

export interface ContextSelectedTokenSummary {
  sourceSelectedTokens: number;
  outputSelectedTokens: number;
  sourcePendingCount: number;
  outputPendingCount: number;
  rangeAdjustedFilesCount: number;
  activeRangeFilesCount: number;
}

export type TapestryRangeMap = Record<string, TapestryRange[]>;

interface TokenCountItem {
  type: string;
  compositeKey?: string;
  tokens?: number;
}

interface RangedFileResolution {
  tokens: number;
  hasActiveSelection: boolean;
}

interface ContextSelectedTokenSummaryArgs {
  sourceSelectedTokens: number;
  sourcePendingCount: number;
  selectedFiles: Set<string>;
  useTapestryRangesForContextOutput: boolean;
  tapestryRangesByKey: TapestryRangeMap;
  tokenCountByFile: Map<string, number>;
  fileContents: Record<string, string>;
}

function buildLinePrefixLengths(lines: string[]): number[] {
  const prefix = new Array<number>(lines.length + 1).fill(0);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const isLastLine = index === lines.length - 1;
    // `splitContentLines` removes CRLF separators, so each non-last line contributes one normalized break.
    const lineLengthWithNormalizedBreak = line.length + (isLastLine ? 0 : 1);
    const previousLength = prefix[index] ?? 0;
    prefix[index + 1] = previousLength + lineLengthWithNormalizedBreak;
  }
  return prefix;
}

function estimateRangeAdjustedTokens(
  fullTokenCount: number,
  lines: string[],
  activeRanges: ContextLineRange[]
): number {
  // Heuristic estimate: assumes token density is roughly proportional to normalized character count.
  // This is intentionally approximate and can drift on mixed-density content (comments/minified segments).
  if (fullTokenCount <= 0 || activeRanges.length === 0) {
    return 0;
  }

  const linePrefixLengths = buildLinePrefixLengths(lines);
  const totalNormalizedChars = linePrefixLengths[lines.length] ?? 0;
  if (totalNormalizedChars <= 0) {
    return 0;
  }

  let selectedChars = 0;
  for (const range of activeRanges) {
    const rangeChars =
      (linePrefixLengths[range.endLine] ?? 0) - (linePrefixLengths[range.startLine] ?? 0);
    selectedChars += Math.max(rangeChars, 0);
  }

  const clampedSelectedChars = Math.min(selectedChars, totalNormalizedChars);
  if (clampedSelectedChars <= 0) {
    return 0;
  }

  const ratio = clampedSelectedChars / totalNormalizedChars;
  const estimatedTokens = Math.round(fullTokenCount * ratio);
  if (estimatedTokens === 0) {
    // Preserve a minimal contribution for tiny active selections that would otherwise round to zero.
    return 1;
  }
  return Math.min(estimatedTokens, fullTokenCount);
}

function resolveRangedFileTokens(args: {
  fullFileTokenCount: number;
  ranges: TapestryRange[];
  content: string | undefined;
}): RangedFileResolution {
  const { fullFileTokenCount, ranges, content } = args;
  const hasAnyActiveRange = ranges.some((range) => range.isActive !== false);
  if (!hasAnyActiveRange) {
    return { tokens: 0, hasActiveSelection: false };
  }

  if (!content) {
    return { tokens: fullFileTokenCount, hasActiveSelection: true };
  }

  const lines = splitContentLines(content);
  const normalizedRanges = normalizeContextLineRanges(ranges, lines.length);
  if (normalizedRanges.length === 0) {
    return { tokens: 0, hasActiveSelection: false };
  }

  return {
    tokens: estimateRangeAdjustedTokens(fullFileTokenCount, lines, normalizedRanges),
    hasActiveSelection: true,
  };
}

export function createSelectedFileContentSnapshot(args: {
  selectedFiles: Set<string>;
  tapestryRangesByKey: TapestryRangeMap;
  fileContents: Record<string, string>;
}): Record<string, string> {
  const snapshot: Record<string, string> = {};

  for (const [compositeKey, ranges] of Object.entries(args.tapestryRangesByKey)) {
    if (!args.selectedFiles.has(compositeKey) || ranges.length === 0) {
      continue;
    }

    const content = args.fileContents[compositeKey];
    if (typeof content === 'string') {
      snapshot[compositeKey] = content;
    }
  }

  return snapshot;
}

export function hasSameSelectedFileContentSnapshot(
  previous: Record<string, string>,
  next: Record<string, string>
): boolean {
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  // Length parity ensures there are no extra keys in either snapshot.
  if (previousKeys.length !== nextKeys.length) {
    return false;
  }

  for (const key of nextKeys) {
    if (previous[key] !== next[key]) {
      return false;
    }
  }

  return true;
}

export function createTokenCountByFile(
  flatListItems: readonly TokenCountItem[]
): Map<string, number> {
  const tokenCountByFile = new Map<string, number>();
  for (const item of flatListItems) {
    if (item.type !== 'file') {
      continue;
    }
    if (typeof item.compositeKey !== 'string') {
      continue;
    }
    if (typeof item.tokens !== 'number') {
      continue;
    }
    tokenCountByFile.set(item.compositeKey, item.tokens);
  }
  return tokenCountByFile;
}

export function computeContextSelectedTokenSummary(
  args: ContextSelectedTokenSummaryArgs
): ContextSelectedTokenSummary {
  const summary: ContextSelectedTokenSummary = {
    sourceSelectedTokens: args.sourceSelectedTokens,
    outputSelectedTokens: args.sourceSelectedTokens,
    sourcePendingCount: args.sourcePendingCount,
    outputPendingCount: args.sourcePendingCount,
    rangeAdjustedFilesCount: 0,
    activeRangeFilesCount: 0,
  };

  if (!args.useTapestryRangesForContextOutput) {
    return summary;
  }

  for (const [compositeKey, explicitRanges] of Object.entries(args.tapestryRangesByKey)) {
    if (!args.selectedFiles.has(compositeKey)) {
      continue;
    }

    const fullFileTokenCount = args.tokenCountByFile.get(compositeKey);
    if (fullFileTokenCount === undefined) {
      continue;
    }
    summary.rangeAdjustedFilesCount++;

    const resolution = resolveRangedFileTokens({
      fullFileTokenCount,
      ranges: explicitRanges,
      content: args.fileContents[compositeKey],
    });
    if (resolution.hasActiveSelection) {
      summary.activeRangeFilesCount++;
    }

    const removedTokens = Math.max(fullFileTokenCount - resolution.tokens, 0);
    summary.outputSelectedTokens = Math.max(0, summary.outputSelectedTokens - removedTokens);
  }

  return summary;
}
