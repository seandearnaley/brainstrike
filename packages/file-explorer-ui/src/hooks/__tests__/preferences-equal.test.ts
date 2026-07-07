import { describe, expect, it } from 'vitest';
import {
  type ColumnVisibility,
  type PreviewPanelPreferences,
  preferencesEqual,
} from '../../preview/use-preview-panel-persistence';

describe('preferencesEqual', () => {
  const columns: ColumnVisibility = {
    checkbox: true,
    path: true,
    rootFolderId: false,
    size: true,
    tokens: false,
    type: true,
  };

  const base: PreviewPanelPreferences<{ path: string }> = {
    collapsedGroups: [],
    columnVisibility: columns,
    groupingConfig: 'none',
    pageSize: 10,
    sortDirection: 'asc',
    sortField: 'path',
  };

  it('returns true for identical preferences', () => {
    const other = { ...base, collapsedGroups: [], columnVisibility: { ...columns } };
    expect(preferencesEqual(base, other)).toBe(true);
  });

  it('returns false when arrays differ', () => {
    const other = { ...base, collapsedGroups: ['a'] };
    expect(preferencesEqual(base, other)).toBe(false);
  });
});
