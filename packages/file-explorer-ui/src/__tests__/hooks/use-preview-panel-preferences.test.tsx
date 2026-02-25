import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePreviewPanelPreferences } from '../../hooks/use-preview-panel-preferences';

describe('usePreviewPanelPreferences', () => {
  const defaults = {
    activeTab: 'table',
    groupingConfig: 'none',
    sortDirection: 'asc' as const,
    sortField: 'path' as const,
    useTapestryRangesForContextOutput: true,
    footerMode: 'default' as const,
    footerHeight: 152,
  };

  it('sanitizes stored preferences', () => {
    localStorage.setItem(
      'previewPanelPreferences.v1',
      JSON.stringify({
        columnVisibility: { size: false, tokens: 'nope' },
        sortField: 'invalid-field',
        sortDirection: 'up',
        groupingConfig: 'folder',
        activeTab: 'unknown',
        collapsedGroups: ['keep', 12, null],
        footerMode: 'not-a-mode',
        footerHeight: 9999,
      })
    );

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    expect(result.current.sortField).toBe('path');
    expect(result.current.sortDirection).toBe('asc');
    expect(result.current.groupingConfig).toBe('rootFolder');
    expect(result.current.activeTab).toBe('table');
    expect(result.current.columnVisibility.size).toBe(false);
    expect(result.current.columnVisibility.tokens).toBe(true);
    expect(Array.from(result.current.collapsedGroups)).toEqual(['keep']);
    expect(result.current.footerMode).toBe('expanded');
    expect(result.current.footerHeight).toBe(360);
  });

  it('hydrates canonical height when only footer mode is stored', () => {
    localStorage.setItem(
      'previewPanelPreferences.v1',
      JSON.stringify({
        footerMode: 'compact',
      })
    );

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    expect(result.current.footerMode).toBe('compact');
    expect(result.current.footerHeight).toBe(88);
  });
});
