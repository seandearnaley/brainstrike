import type { TableRowData } from '../utils/grouping-configs';
import { splitFilePath } from '../utils/path-display';
import type { FileTapestry, LineData } from './types';
import { buildStructureFromContent, splitContentLines } from './utils';

const LOADING_PLACEHOLDER = 'Loading file preview…';
const EMPTY_PLACEHOLDER = 'Preview not available';
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
      width: isEmpty ? 0 : 10 + (value % 61),
      isEmpty,
    };
  });
};

const estimateLineCount = (size?: number, tokens?: number): number | undefined => {
  if (typeof tokens === 'number' && tokens > 0) {
    return clampEstimatedLines(tokens / AVERAGE_TOKENS_PER_LINE);
  }
  if (typeof size === 'number' && size > 0) {
    return clampEstimatedLines(size / AVERAGE_BYTES_PER_LINE);
  }
  return;
};

export function buildTapestryFileBase(args: {
  item: TableRowData;
  content: string | undefined;
  isLoading: boolean;
}): TapestryFileBase {
  const { item, content, isLoading } = args;
  const fallbackContent = isLoading ? LOADING_PLACEHOLDER : EMPTY_PLACEHOLDER;
  const hasContent = Boolean(content && content.length > 0);
  const resolvedContent = hasContent ? (content ?? fallbackContent) : fallbackContent;
  const contentLines = splitContentLines(resolvedContent);
  const estimatedLines = hasContent
    ? contentLines.length
    : (estimateLineCount(item.size, item.tokens) ?? contentLines.length);
  const structure = hasContent
    ? buildStructureFromContent(contentLines)
    : buildEstimatedStructure(estimatedLines, item.compositeKey);
  const { fileName } = splitFilePath(item.path);

  return {
    id: item.compositeKey,
    compositeKey: item.compositeKey,
    rootFolderId: item.rootFolderId,
    path: item.path,
    name: fileName || item.path,
    language: item.type.toLowerCase(),
    type: item.type,
    ...(item.size !== undefined ? { size: item.size } : {}),
    ...(item.tokens !== undefined ? { tokens: item.tokens } : {}),
    totalLines: estimatedLines,
    structure,
    content: contentLines,
  };
}
