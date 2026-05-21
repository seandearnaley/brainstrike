import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePreviewPanelPreferences } from '../../preview/use-preview-panel-preferences';

describe('usePreviewPanelPreferences', () => {
  const defaults = {
    activeTab: 'table',
    groupingConfig: 'none',
    sortDirection: 'asc' as const,
    sortField: 'path' as const,
    useTapestryRangesForContextOutput: true,
    footerMode: 'default' as const,
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
        footerCollapsed: true,
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
  });

  it('hydrates footer mode when only the legacy stored mode is present', () => {
    localStorage.setItem(
      'previewPanelPreferences.v1',
      JSON.stringify({
        footerMode: 'compact',
      })
    );

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    expect(result.current.footerMode).toBe('compact');
  });

  it('prefers the inferred mode when legacy stored mode and height disagree', () => {
    localStorage.setItem(
      'previewPanelPreferences.v1',
      JSON.stringify({
        footerMode: 'compact',
        footerHeight: 500,
      })
    );

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    expect(result.current.footerMode).toBe('expanded');
  });
});
