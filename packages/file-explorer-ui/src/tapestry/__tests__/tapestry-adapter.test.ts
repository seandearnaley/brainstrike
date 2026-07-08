import { describe, expect, it } from 'vitest';
import type { TableRowData } from '../../utils/grouping-configs';
import { buildTapestryFileBase } from '../tapestry-adapter';

const baseItem: TableRowData = {
  compositeKey: 'folder-a|@|src/file-a.ts',
  id: 'file-a',
  path: 'src/file-a.ts',
  rootFolderId: 'folder-a',
  type: 'ts',
};

describe('buildTapestryFileBase', () => {
  it('uses size-based line estimation over token-based estimation for unloaded files', () => {
    const item: TableRowData = {
      ...baseItem,
      size: 8000, // 100 estimated lines @ 80 bytes/line
      tokens: 2400, // 200 estimated lines @ 12 tokens/line
    };

    const file = buildTapestryFileBase({
      content: undefined,
      isLoading: false,
      item,
    });

    expect(file.totalLines).toBe(100);
    expect(file.structure).toHaveLength(100);
    expect(file.contentStatus).toBe('idle');
  });

  it('falls back to token estimation when size metadata is unavailable', () => {
    const item: TableRowData = {
      ...baseItem,
      tokens: 2400,
    };

    const file = buildTapestryFileBase({
      content: undefined,
      isLoading: false,
      item,
    });

    expect(file.totalLines).toBe(200);
    expect(file.structure).toHaveLength(200);
  });

  it('uses real content lines when content is loaded', () => {
    const item: TableRowData = {
      ...baseItem,
      size: 80_000,
      tokens: 24_000,
    };

    const file = buildTapestryFileBase({
      content: 'line 1\nline 2\nline 3',
      isLoading: false,
      item,
    });

    expect(file.totalLines).toBe(3);
    expect(file.contentStatus).toBe('ready');
    expect(file.content).toEqual(['line 1', 'line 2', 'line 3']);
  });
});
