import type { TableRowData } from '../utils/grouping-configs';
import { splitFilePath } from '../utils/path-display';
import type { FileTapestry } from './types';
import { buildStructureFromContent, splitContentLines } from './utils';

const LOADING_PLACEHOLDER = 'Loading file preview…';
const EMPTY_PLACEHOLDER = 'Preview not available';

export type TapestryFileBase = Omit<FileTapestry, 'selections'>;

export function buildTapestryFileBase(args: {
  item: TableRowData;
  content: string | undefined;
  isLoading: boolean;
}): TapestryFileBase {
  const { item, content, isLoading } = args;
  const fallbackContent = isLoading ? LOADING_PLACEHOLDER : EMPTY_PLACEHOLDER;
  const resolvedContent = content && content.length > 0 ? content : fallbackContent;
  const contentLines = splitContentLines(resolvedContent);
  const structure = buildStructureFromContent(contentLines);
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
    totalLines: contentLines.length,
    structure,
    content: contentLines,
  };
}
