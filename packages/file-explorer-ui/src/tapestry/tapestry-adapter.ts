import type { TableRowData } from '../utils/grouping-configs';
import { splitFilePath } from '../utils/path-display';
import type { FileTapestry, LineData } from './types';
import { buildStructureFromContent, splitContentLines } from './utils';

const LOADING_PLACEHOLDER = 'Loading preview...';
const ESTIMATED_PLACEHOLDER = 'Estimated preview';
const AVERAGE_BYTES_PER_LINE = 80;
const AVERAGE_TOKENS_PER_LINE = 12;
const MIN_ESTIMATED_LINES = 12;
const MAX_ESTIMATED_LINES = 1200;
const PREVIEW_SNIPPETS = [
  'export function handler() {',
  'const result = buildResult();',
  'if (!result) return;',
  'return result;',
  '}',
  'type Params = {',
  '  id: string;',
  '};',
  'interface Config {',
  '  enabled: boolean;',
  '}',
  'const options = {',
  '  retries: 3,',
  '};',
  '// ...',
];

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

const buildEstimatedContent = (
  structure: LineData[],
  seedKey: string,
  header: string
): string[] => {
  const seed = hashSeed(seedKey);
  return structure.map((line, index) => {
    if (index === 0) {
      return `// ${header}`;
    }
    if (line.isEmpty) {
      return '';
    }
    const indent = '  '.repeat(line.indent);
    const snippet = PREVIEW_SNIPPETS[(seed + index) % PREVIEW_SNIPPETS.length] as string;
    return `${indent}${snippet}`;
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
  const hasContent = Boolean(content && content.length > 0);
  const contentLines = hasContent ? splitContentLines(content ?? '') : [];
  const estimatedLines = hasContent
    ? contentLines.length
    : (estimateLineCount(item.size, item.tokens) ?? 0);
  const normalizedEstimatedLines = hasContent
    ? contentLines.length
    : Math.max(MIN_ESTIMATED_LINES, estimatedLines);
  const structure = hasContent
    ? buildStructureFromContent(contentLines)
    : buildEstimatedStructure(normalizedEstimatedLines, item.compositeKey);
  const previewHeader = isLoading ? LOADING_PLACEHOLDER : ESTIMATED_PLACEHOLDER;
  const resolvedContentLines = hasContent
    ? contentLines
    : buildEstimatedContent(structure, item.compositeKey, previewHeader);
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
    totalLines: normalizedEstimatedLines,
    structure,
    content: resolvedContentLines,
  };
}
