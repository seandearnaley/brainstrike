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

/**
 * Structure resolution with reuse: a matching previous base's structure is
 * reused when the content is loaded (structure depends only on content) or
 * when an estimated structure's line count is unchanged.
 */
function resolveTapestryStructure(args: {
  compositeKey: string;
  contentLines: string[];
  hasContent: boolean;
  normalizedEstimatedLines: number;
  reusableBase: TapestryFileBase | undefined;
}): ReturnType<typeof buildStructureFromContent> {
  const { compositeKey, contentLines, hasContent, normalizedEstimatedLines, reusableBase } = args;
  if (reusableBase) {
    const canReuse = hasContent
      ? true
      : reusableBase.contentStatus !== 'ready' &&
        reusableBase.totalLines === normalizedEstimatedLines;
    if (canReuse) {
      return reusableBase.structure;
    }
  }
  return hasContent
    ? buildStructureFromContent(contentLines)
    : buildEstimatedStructure(normalizedEstimatedLines, compositeKey);
}

/**
 * True when `base` was built from exactly these item fields (the subset
 * buildTapestryFileBase reads). Used as the cache-validity check instead of
 * TableRowData object identity — row objects are rebuilt on every token-
 * resolution tick, which invalidated the cache for ALL files even though
 * only the resolving file's metadata changed.
 */
export function tapestryBaseMatchesItem(base: TapestryFileBase, item: TableRowData): boolean {
  return (
    base.compositeKey === item.compositeKey &&
    base.path === item.path &&
    base.rootFolderId === item.rootFolderId &&
    base.rootDisplayName === item.rootDisplayName &&
    base.type === item.type &&
    base.size === item.size &&
    base.tokens === item.tokens
  );
}

export function buildTapestryFileBase(args: {
  item: TableRowData;
  content: string | undefined;
  isLoading: boolean;
  /**
   * A previously built base plus the content string it was built from. The
   * expensive content-derived parts — split lines and per-line structure —
   * depend only on the content (or, for unloaded files, on the line
   * estimate), so they are reused when the content identity matches (verified
   * HERE, not trusted from the caller). Token counts resolve asynchronously
   * per selected file on a ~100ms cadence; without reuse each tick re-split
   * every loaded file's full content, and fresh structure identities defeated
   * the minimap's SVG memo.
   */
  previous?: { readonly base: TapestryFileBase; readonly content: string | undefined };
}): TapestryFileBase {
  const { item, content, isLoading, previous } = args;
  const hasContent = typeof content === 'string';
  const reusableBase = previous && previous.content === content ? previous.base : undefined;
  const contentLines = hasContent
    ? (reusableBase?.content ?? splitContentLines(content ?? ''))
    : [];
  const estimatedLines = hasContent
    ? contentLines.length
    : (estimateLineCount(item.size, item.tokens) ?? MIN_ESTIMATED_LINES);
  const normalizedEstimatedLines = hasContent
    ? contentLines.length
    : Math.max(MIN_ESTIMATED_LINES, estimatedLines);
  const structure = resolveTapestryStructure({
    compositeKey: item.compositeKey,
    contentLines,
    hasContent,
    normalizedEstimatedLines,
    reusableBase,
  });
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
