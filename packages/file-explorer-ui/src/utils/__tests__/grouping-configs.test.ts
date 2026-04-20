import { describe, expect, it } from 'vitest';
import { GROUPING_CONFIGS, groupData, type TableRowData } from '../grouping-configs';

const buildRow = (overrides: Partial<TableRowData>): TableRowData => ({
  compositeKey: overrides.compositeKey ?? 'root::file.ts',
  id: overrides.id ?? 'row-id',
  path: overrides.path ?? 'file.ts',
  rootFolderId: overrides.rootFolderId ?? 'root',
  type: overrides.type ?? 'ts',
  ...(overrides.size === undefined ? {} : { size: overrides.size }),
  ...(overrides.tokens === undefined ? {} : { tokens: overrides.tokens }),
});

describe('GROUPING_CONFIGS sort comparators', () => {
  it('keeps root-folder grouping lexicographic for numeric suffixes', () => {
    const data: TableRowData[] = [
      buildRow({ id: 'row-2', compositeKey: 'folder2::f.ts', rootFolderId: 'folder2' }),
      buildRow({ id: 'row-10', compositeKey: 'folder10::f.ts', rootFolderId: 'folder10' }),
      buildRow({ id: 'row-1', compositeKey: 'folder1::f.ts', rootFolderId: 'folder1' }),
    ];

    const result = groupData(data, GROUPING_CONFIGS.rootFolder);

    expect(result.map((group) => String(group.groupKey))).toEqual([
      'folder1',
      'folder10',
      'folder2',
    ]);
  });

  it('keeps file-type grouping lexicographic for numeric suffixes', () => {
    const data: TableRowData[] = [
      buildRow({ id: 'row-2', type: 'ext2' }),
      buildRow({ id: 'row-10', type: 'ext10' }),
      buildRow({ id: 'row-1', type: 'ext1' }),
    ];

    const result = groupData(data, GROUPING_CONFIGS.fileType);

    expect(result.map((group) => String(group.groupKey))).toEqual(['ext1', 'ext10', 'ext2']);
  });

  it('keeps directory grouping root-first and lexicographic for numeric suffixes', () => {
    const data: TableRowData[] = [
      buildRow({ id: 'row-dir-2', path: 'dir2/file.ts' }),
      buildRow({ id: 'row-root', path: 'root-file.ts' }),
      buildRow({ id: 'row-dir-10', path: 'dir10/file.ts' }),
      buildRow({ id: 'row-dir-1', path: 'dir1/file.ts' }),
    ];

    const result = groupData(data, GROUPING_CONFIGS.directory);

    expect(result.map((group) => group.groupLabel)).toEqual([
      'root',
      'root/dir1',
      'root/dir10',
      'root/dir2',
    ]);
  });

  it('uses root-prefixed labels for directory grouping on desktop-style absolute paths', () => {
    const data: TableRowData[] = [
      buildRow({
        id: 'row-root',
        compositeKey: 'brainstrike::README.md',
        rootFolderId: '/Users/me/BrainStrike',
        path: '/Users/me/BrainStrike/README.md',
      }),
      buildRow({
        id: 'row-source',
        compositeKey: 'brainstrike::source/index.ts',
        rootFolderId: '/Users/me/BrainStrike',
        path: '/Users/me/BrainStrike/source/index.ts',
      }),
    ];

    const result = groupData(data, GROUPING_CONFIGS.directory);

    expect(result.map((group) => group.groupLabel)).toEqual(['BrainStrike', 'BrainStrike/source']);
  });

  it('disambiguates duplicate directory labels by falling back to canonical root identities', () => {
    const data: TableRowData[] = [
      buildRow({
        id: 'row-root-a',
        compositeKey: 'brainstrike-a::README.md',
        rootFolderId: '/Users/me/BrainStrike',
        path: '/Users/me/BrainStrike/README.md',
      }),
      buildRow({
        id: 'row-root-b',
        compositeKey: 'brainstrike-b::README.md',
        rootFolderId: '/tmp/BrainStrike',
        path: '/tmp/BrainStrike/README.md',
      }),
    ];

    const result = groupData(data, GROUPING_CONFIGS.directory);

    expect(result.map((group) => group.groupLabel)).toEqual([
      '/tmp/BrainStrike',
      '/Users/me/BrainStrike',
    ]);
  });
});
