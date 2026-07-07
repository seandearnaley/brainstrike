import { splitContentLines } from '@brainstrike/utils/report-generator';
import type { TableRowData } from '../utils/grouping-configs';
import { splitFilePath } from '../utils/path-display';
import type { FileTapestry, LineData } from './types';
import { buildStructureFromContent } from './utils';

const AVERAGE_BYTES_PER_LINE = 80;
const AVERAGE_TOKENS_PER_LINE = 12;
const MIN_ESTIMATED_LINES = 12;
const MAX_ESTIMATED_LINES = 1200;
export type TapestryFileBase = Omit<FileTapestry, 'selections'>;

const clampEstimatedLines = (value: number): number =>
  Math.min(MAX_ESTIMATED_LINES, Math.max(MIN_ESTIMATED_LINES, Math.round(value)));

const hashSeed = (value: string): number => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash === 0 ? 1 : hash;
};

const buildEstimatedStructure = (lines: number, seedKey: string): LineData[] => {
  const seed = hashSeed(seedKey);
  return Array.from({ length: lines }, (_, index) => {
    const value = (seed + index * 73) >>> 0;
    const isEmpty = value % 11 === 0;
    return {
      indent: isEmpty ? 0 : value % 5,
      isEmpty,
      width: isEmpty ? 0 : 10 + (value % 61),
    };
  });
};

const estimateLineCount = (size?: number, tokens?: number): number | undefined => {
  // Prefer byte size for unloaded files. Token counts resolve asynchronously and can
  // arrive later than size metadata, which would otherwise cause minimap/card
  // heights to jump as token values stream in.
  if (typeof size === 'number' && size > 0) {
    return clampEstimatedLines(size / AVERAGE_BYTES_PER_LINE);
  }
  if (typeof tokens === 'number' && tokens > 0) {
    return clampEstimatedLines(tokens / AVERAGE_TOKENS_PER_LINE);
  }
  return;
};

export function buildTapestryFileBase(args: {
  item: TableRowData;
  content: string | undefined;
  isLoading: boolean;
}): TapestryFileBase {
  const { item, content, isLoading } = args;
  const hasContent = typeof content === 'string';
  const contentLines = hasContent ? splitContentLines(content ?? '') : [];
  const estimatedLines = hasContent
    ? contentLines.length
    : (estimateLineCount(item.size, item.tokens) ?? MIN_ESTIMATED_LINES);
  const normalizedEstimatedLines = hasContent
    ? contentLines.length
    : Math.max(MIN_ESTIMATED_LINES, estimatedLines);
  const structure = hasContent
    ? buildStructureFromContent(contentLines)
    : buildEstimatedStructure(normalizedEstimatedLines, item.compositeKey);
  const contentStatus: FileTapestry['contentStatus'] = hasContent
    ? 'ready'
    : isLoading
      ? 'loading'
      : 'idle';
  const { fileName } = splitFilePath(item.path);

  return {
    compositeKey: item.compositeKey,
    id: item.compositeKey,
    rootFolderId: item.rootFolderId,
    ...(item.rootDisplayName === undefined ? {} : { rootDisplayName: item.rootDisplayName }),
    language: item.type.toLowerCase(),
    name: fileName || item.path,
    path: item.path,
    type: item.type,
    ...(item.size === undefined ? {} : { size: item.size }),
    ...(item.tokens === undefined ? {} : { tokens: item.tokens }),
    content: contentLines,
    contentStatus,
    structure,
    totalLines: normalizedEstimatedLines,
  };
}
