import {
  type ContextLineRange,
  normalizeContextLineRanges,
  splitContentLines,
} from '@brainstrike/utils/report-generator';
import type { TapestryRange } from '../tapestry/types';

export interface ContextSelectedTokenSummary {
  activeRangeFilesCount: number;
  outputPendingCount: number;
  outputSelectedTokens: number;
  rangeAdjustedFilesCount: number;
  sourcePendingCount: number;
  sourceSelectedTokens: number;
}

export type TapestryRangeMap = Record<string, TapestryRange[]>;

interface TokenCountItem {
  compositeKey?: string;
  tokens?: number;
  type: string;
}

interface RangedFileResolution {
  hasActiveSelection: boolean;
  tokens: number;
}

interface ContextSelectedTokenSummaryArgs {
  fileContents: Record<string, string>;
  selectedFiles: Set<string>;
  sourcePendingCount: number;
  sourceSelectedTokens: number;
  tapestryRangesByKey: TapestryRangeMap;
  tokenCountByFile: Map<string, number>;
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
  // Range convention is half-open [startLine, endLine), matching normalizeContextLineRanges output.
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
    // This ensures a ranged file never appears as a zero-token contribution unless all ranges are inactive.
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
    return { hasActiveSelection: false, tokens: 0 };
  }

  if (!content) {
    return { hasActiveSelection: true, tokens: fullFileTokenCount };
  }

  const lines = splitContentLines(content);
  const normalizedRanges = normalizeContextLineRanges(ranges, lines.length);
  if (normalizedRanges.length === 0) {
    return { hasActiveSelection: false, tokens: 0 };
  }

  return {
    hasActiveSelection: true,
    tokens: estimateRangeAdjustedTokens(fullFileTokenCount, lines, normalizedRanges),
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
    activeRangeFilesCount: 0,
    // Pending source files mean outputSelectedTokens is still a partial estimate.
    outputPendingCount: args.sourcePendingCount,
    outputSelectedTokens: args.sourceSelectedTokens,
    rangeAdjustedFilesCount: 0,
    sourcePendingCount: args.sourcePendingCount,
    sourceSelectedTokens: args.sourceSelectedTokens,
  };

  let sourceTokensFromKnownFiles = 0;
  let outputTokensFromKnownFiles = 0;

  for (const compositeKey of args.selectedFiles) {
    const fullFileTokenCount = args.tokenCountByFile.get(compositeKey);
    if (fullFileTokenCount === undefined) {
      continue;
    }

    sourceTokensFromKnownFiles += fullFileTokenCount;

    // Invariant: absence of ranges = whole file, and a present-but-EMPTY array
    // is equivalent to absence (empty ≡ absent) — both count full-file output
    // tokens. A present list of all-inactive ranges stays range-adjusted
    // (length > 0) and resolves to 0 active tokens below.
    const explicitRanges = args.tapestryRangesByKey[compositeKey];
    if (!explicitRanges || explicitRanges.length === 0) {
      outputTokensFromKnownFiles += fullFileTokenCount;
      continue;
    }

    summary.rangeAdjustedFilesCount++;

    const resolution = resolveRangedFileTokens({
      content: args.fileContents[compositeKey],
      fullFileTokenCount,
      ranges: explicitRanges,
    });
    if (resolution.hasActiveSelection) {
      summary.activeRangeFilesCount++;
    }

    outputTokensFromKnownFiles += resolution.tokens;
  }

  const knownFileDelta = outputTokensFromKnownFiles - sourceTokensFromKnownFiles;
  // Preserve the source aggregate as the baseline so pending/uncounted files are
  // still represented. The range math only adjusts known files via delta.
  summary.outputSelectedTokens = Math.max(0, args.sourceSelectedTokens + knownFileDelta);

  return summary;
}
