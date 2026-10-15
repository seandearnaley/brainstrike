// @vitest-environment node
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
  ...(overrides.rootDisplayName === undefined
    ? {}
    : { rootDisplayName: overrides.rootDisplayName }),
  ...(overrides.rootPath === undefined ? {} : { rootPath: overrides.rootPath }),
});

describe('GROUPING_CONFIGS sort comparators', () => {
  it('keeps root-folder grouping lexicographic for numeric suffixes', () => {
    const data: TableRowData[] = [
      buildRow({ compositeKey: 'folder2::f.ts', id: 'row-2', rootFolderId: 'folder2' }),
      buildRow({ compositeKey: 'folder10::f.ts', id: 'row-10', rootFolderId: 'folder10' }),
      buildRow({ compositeKey: 'folder1::f.ts', id: 'row-1', rootFolderId: 'folder1' }),
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
        compositeKey: 'brainstrike::README.md',
        id: 'row-root',
        path: '/Users/me/BrainStrike/README.md',
        rootFolderId: '/Users/me/BrainStrike',
      }),
      buildRow({
        compositeKey: 'brainstrike::source/index.ts',
        id: 'row-source',
        path: '/Users/me/BrainStrike/source/index.ts',
        rootFolderId: '/Users/me/BrainStrike',
      }),
    ];

    const result = groupData(data, GROUPING_CONFIGS.directory);

    expect(result.map((group) => group.groupLabel)).toEqual(['BrainStrike', 'BrainStrike/source']);
  });

  // Storage v5: rootFolderId is a RootId UUID; rows carry the descriptor's
  // rootDisplayName/rootPath so group labels never render the UUID.
  it('labels directory groups with the root displayName for UUID root ids', () => {
    const ROOT_ID = '11111111-0000-4000-8000-000000000011';
    const data: TableRowData[] = [
      buildRow({
        compositeKey: `${ROOT_ID}|@|/Users/me/BrainStrike/README.md`,
        id: 'row-root',
        path: '/Users/me/BrainStrike/README.md',
        rootDisplayName: 'BrainStrike',
        rootFolderId: ROOT_ID,
        rootPath: '/Users/me/BrainStrike',
      }),
      buildRow({
        compositeKey: `${ROOT_ID}|@|/Users/me/BrainStrike/source/index.ts`,
        id: 'row-source',
        path: '/Users/me/BrainStrike/source/index.ts',
        rootDisplayName: 'BrainStrike',
        rootFolderId: ROOT_ID,
        rootPath: '/Users/me/BrainStrike',
      }),
    ];

    const result = groupData(data, GROUPING_CONFIGS.directory);

    expect(result.map((group) => group.groupLabel)).toEqual(['BrainStrike', 'BrainStrike/source']);
  });

  it('labels root-folder groups with the root displayName for UUID root ids', () => {
    const ROOT_ID_A = '11111111-0000-4000-8000-000000000011';
    const ROOT_ID_B = '22222222-0000-4000-8000-000000000022';
    const data: TableRowData[] = [
      buildRow({
        compositeKey: `${ROOT_ID_A}|@|/a/file.ts`,
        id: 'row-a',
        path: '/a/file.ts',
        rootDisplayName: 'alpha',
        rootFolderId: ROOT_ID_A,
        rootPath: '/a',
      }),
      buildRow({
        compositeKey: `${ROOT_ID_B}|@|/b/file.ts`,
        id: 'row-b',
        path: '/b/file.ts',
        rootDisplayName: 'beta',
        rootFolderId: ROOT_ID_B,
        rootPath: '/b',
      }),
    ];

    const result = groupData(data, GROUPING_CONFIGS.rootFolder);

    expect(result.map((group) => group.groupLabel).sort()).toEqual(['alpha', 'beta']);
    // Identity stays the rootId — same-named roots must never merge.
    expect(result.map((group) => group.groupKey).sort()).toEqual([ROOT_ID_A, ROOT_ID_B]);
  });

  it('disambiguates duplicate directory labels by falling back to canonical root identities', () => {
    const data: TableRowData[] = [
      buildRow({
        compositeKey: 'brainstrike-a::README.md',
        id: 'row-root-a',
        path: '/Users/me/BrainStrike/README.md',
        rootFolderId: '/Users/me/BrainStrike',
      }),
      buildRow({
        compositeKey: 'brainstrike-b::README.md',
        id: 'row-root-b',
        path: '/tmp/BrainStrike/README.md',
        rootFolderId: '/tmp/BrainStrike',
      }),
    ];

    const result = groupData(data, GROUPING_CONFIGS.directory);

    expect(result.map((group) => group.groupLabel)).toEqual([
      '/tmp/BrainStrike',
      '/Users/me/BrainStrike',
    ]);
  });
});
