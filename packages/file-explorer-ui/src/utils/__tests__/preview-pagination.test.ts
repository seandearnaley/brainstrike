// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { GroupedData, TableRowData } from '../grouping-configs';
import { buildGroupedPageSections, getVisibleFilesOnPage } from '../preview-pagination';

const createRow = (id: string, path: string): TableRowData => ({
  compositeKey: id,
  id,
  path,
  rootFolderId: 'root',
  type: 'TS',
});

const createGroup = (groupKey: string, items: TableRowData[]): GroupedData<TableRowData> => ({
  count: items.length,
  groupKey,
  groupLabel: groupKey,
  items,
  totalSize: 0,
  totalTokens: 0,
});

describe('getVisibleFilesOnPage', () => {
  it('returns current page data when grouping is disabled', () => {
    const currentPageData = [createRow('a', 'a.ts'), createRow('b', 'b.ts')];

    const result = getVisibleFilesOnPage({
      collapsedGroups: new Set(),
      currentPageData,
      endIndex: 2,
      groupedData: [],
      groupingConfig: 'none',
      startIndex: 0,
    });

    expect(result).toEqual(currentPageData);
  });

  it('skips collapsed group items while still counting headers', () => {
    const groupA = createGroup('A', [createRow('a1', 'a1.ts'), createRow('a2', 'a2.ts')]);
    const groupB = createGroup('B', [createRow('b1', 'b1.ts'), createRow('b2', 'b2.ts')]);

    const result = getVisibleFilesOnPage({
      collapsedGroups: new Set(['A']),
      currentPageData: [],
      endIndex: 3,
      groupedData: [groupA, groupB],
      groupingConfig: 'rootFolder',
      startIndex: 0,
    });

    expect(result.map((item) => item.id)).toEqual(['b1']);
  });

  it('returns empty when the page only includes a group header', () => {
    const groupA = createGroup('A', [createRow('a1', 'a1.ts')]);

    const result = getVisibleFilesOnPage({
      collapsedGroups: new Set(),
      currentPageData: [],
      endIndex: 1,
      groupedData: [groupA],
      groupingConfig: 'rootFolder',
      startIndex: 0,
    });

    expect(result).toEqual([]);
  });

  it('respects pagination offsets across group headers', () => {
    const groupA = createGroup('A', [createRow('a1', 'a1.ts'), createRow('a2', 'a2.ts')]);
    const groupB = createGroup('B', [createRow('b1', 'b1.ts'), createRow('b2', 'b2.ts')]);

    const result = getVisibleFilesOnPage({
      collapsedGroups: new Set(),
      currentPageData: [],
      endIndex: 4,
      groupedData: [groupA, groupB],
      groupingConfig: 'rootFolder',
      startIndex: 2,
    });

    expect(result.map((item) => item.id)).toEqual(['a2']);
  });
});

describe('buildGroupedPageSections', () => {
  it('includes headers only when they fall on the page', () => {
    const groupA = createGroup('A', [createRow('a1', 'a1.ts'), createRow('a2', 'a2.ts')]);
    const groupB = createGroup('B', [createRow('b1', 'b1.ts')]);

    const sections = buildGroupedPageSections({
      collapsedGroups: new Set(),
      endIndex: 5,
      groupedData: [groupA, groupB],
      startIndex: 2,
    });

    expect(sections).toHaveLength(2);
    expect(sections[0]?.showHeader).toBe(false);
    expect(sections[0]?.items.map((item) => item.id)).toEqual(['a2']);
    expect(sections[1]?.showHeader).toBe(true);
    expect(sections[1]?.items.map((item) => item.id)).toEqual(['b1']);
  });
});
