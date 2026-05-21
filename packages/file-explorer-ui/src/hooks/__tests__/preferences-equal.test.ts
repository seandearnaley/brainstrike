import { describe, expect, it } from 'vitest';
import {
  type ColumnVisibility,
  type PreviewPanelPreferences,
  preferencesEqual,
} from '../../preview/use-preview-panel-persistence';

describe('preferencesEqual', () => {
  const columns: ColumnVisibility = {
    checkbox: true,
    rootFolderId: false,
    path: true,
    type: true,
    tokens: false,
    size: true,
  };

  const base: PreviewPanelPreferences<{ path: string }> = {
    columnVisibility: columns,
    sortField: 'path',
    sortDirection: 'asc',
    groupingConfig: 'none',
    collapsedGroups: [],
    pageSize: 10,
  };

  it('returns true for identical preferences', () => {
    const other = { ...base, columnVisibility: { ...columns }, collapsedGroups: [] };
    expect(preferencesEqual(base, other)).toBe(true);
  });

  it('returns false when arrays differ', () => {
    const other = { ...base, collapsedGroups: ['a'] };
    expect(preferencesEqual(base, other)).toBe(false);
  });
});
