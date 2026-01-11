import type { GroupedData, TableRowData } from './grouping-configs';

export interface VisibleFilesOnPageInput {
  groupingConfig: string;
  currentPageData: TableRowData[];
  groupedData: GroupedData<TableRowData>[];
  collapsedGroups: Set<string>;
  startIndex: number;
  endIndex: number;
}

export function getVisibleFilesOnPage(input: VisibleFilesOnPageInput): TableRowData[] {
  if (input.groupingConfig === 'none') {
    return input.currentPageData;
  }

  const visibleFiles: TableRowData[] = [];
  let itemCount = 0;

  for (const group of input.groupedData) {
    itemCount += 1; // group header

    if (input.collapsedGroups.has(String(group.groupKey))) {
      continue;
    }

    for (const item of group.items) {
      if (itemCount >= input.startIndex && itemCount < input.endIndex) {
        visibleFiles.push(item);
      }
      itemCount += 1;
      if (itemCount >= input.endIndex) {
        break;
      }
    }

    if (itemCount >= input.endIndex) {
      break;
    }
  }

  return visibleFiles;
}

export interface GroupedPageSection {
  group: GroupedData<TableRowData>;
  isCollapsed: boolean;
  showHeader: boolean;
  items: TableRowData[];
}

interface GroupedPageSectionsInput {
  groupedData: GroupedData<TableRowData>[];
  collapsedGroups: Set<string>;
  startIndex: number;
  endIndex: number;
}

function isIndexInPage(index: number, startIndex: number, endIndex: number): boolean {
  return index >= startIndex && index < endIndex;
}

function collectItemsForGroup(args: {
  group: GroupedData<TableRowData>;
  isCollapsed: boolean;
  startIndex: number;
  endIndex: number;
  itemCount: number;
}): { items: TableRowData[]; nextIndex: number } {
  if (args.isCollapsed) {
    return { items: [], nextIndex: args.itemCount };
  }

  const items: TableRowData[] = [];
  let currentIndex = args.itemCount;

  for (const item of args.group.items) {
    if (isIndexInPage(currentIndex, args.startIndex, args.endIndex)) {
      items.push(item);
    }
    currentIndex += 1;
    if (currentIndex >= args.endIndex) {
      break;
    }
  }

  return { items, nextIndex: currentIndex };
}

export function buildGroupedPageSections(input: GroupedPageSectionsInput): GroupedPageSection[] {
  const sections: GroupedPageSection[] = [];
  let itemCount = 0;

  for (const group of input.groupedData) {
    const isCollapsed = input.collapsedGroups.has(String(group.groupKey));
    const showHeader = isIndexInPage(itemCount, input.startIndex, input.endIndex);
    itemCount += 1;
    const { items, nextIndex } = collectItemsForGroup({
      endIndex: input.endIndex,
      group,
      isCollapsed,
      itemCount,
      startIndex: input.startIndex,
    });
    itemCount = nextIndex;

    if (showHeader || items.length > 0) {
      sections.push({ group, isCollapsed, showHeader, items });
    }

    if (itemCount >= input.endIndex) {
      break;
    }
  }

  return sections;
}
