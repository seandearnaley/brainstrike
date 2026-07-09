import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePreviewPanelPreferences } from '../../preview/use-preview-panel-preferences';

describe('usePreviewPanelPreferences', () => {
  const defaults = {
    activeTab: 'table',
    footerMode: 'default' as const,
    groupingConfig: 'none',
    sortDirection: 'asc' as const,
    sortField: 'path' as const,
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('sanitizes stored preferences', () => {
    localStorage.setItem(
      'previewPanelPreferences.v1',
      JSON.stringify({
        activeTab: 'unknown',
        collapsedGroups: ['keep', 12, null],
        columnVisibility: { size: false, tokens: 'nope' },
        footerCollapsed: true,
        footerHeight: 9999,
        footerMode: 'not-a-mode',
        groupingConfig: 'folder',
        sortDirection: 'up',
        sortField: 'invalid-field',
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
        footerHeight: 500,
        footerMode: 'compact',
      })
    );

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    expect(result.current.footerMode).toBe('expanded');
  });

  it('hydrates valid persisted values and saves preference updates after the debounce', async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      'previewPanelPreferences.v1',
      JSON.stringify({
        activeTab: 'tapestry',
        collapsedGroups: ['group-a'],
        groupingConfig: 'fileType',
        pageSize: 100,
        sortDirection: 'desc',
        sortField: 'tokens',
      })
    );

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    expect(result.current.activeTab).toBe('tapestry');
    expect(result.current.collapsedGroups).toEqual(new Set(['group-a']));
    expect(result.current.groupingConfig).toBe('fileType');
    expect(result.current.pageSize).toBe(100);
    expect(result.current.sortDirection).toBe('desc');
    expect(result.current.sortField).toBe('tokens');

    act(() => {
      result.current.setActiveTab('table');
      result.current.setCollapsedGroups(new Set(['group-b']));
      result.current.setGroupingConfig('rootFolder');
      result.current.setPageSize(250);
    });

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(JSON.parse(localStorage.getItem('previewPanelPreferences.v1') ?? '{}')).toMatchObject({
      activeTab: 'table',
      collapsedGroups: ['group-b'],
      groupingConfig: 'rootFolder',
      pageSize: 250,
      sortDirection: 'desc',
      sortField: 'tokens',
    });
  });

  it('tolerates a stale useTapestryRangesForContextOutput field in a persisted blob (no migration mechanism, field silently ignored)', async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      'previewPanelPreferences.v1',
      JSON.stringify({
        activeTab: 'tapestry',
        sortField: 'tokens',
        useTapestryRangesForContextOutput: false,
      })
    );

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    // The blob loads cleanly and the stale field is simply absent from state.
    expect(result.current.activeTab).toBe('tapestry');
    expect(result.current.sortField).toBe('tokens');
    expect(result.current).not.toHaveProperty('useTapestryRangesForContextOutput');

    act(() => {
      result.current.setSortField('path');
    });

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const saved = JSON.parse(localStorage.getItem('previewPanelPreferences.v1') ?? '{}');
    expect(saved).not.toHaveProperty('useTapestryRangesForContextOutput');
  });

  it('falls back to defaults when stored preferences cannot be parsed', () => {
    localStorage.setItem('previewPanelPreferences.v1', '{bad json');

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    expect(result.current.activeTab).toBe('table');
    expect(result.current.groupingConfig).toBe('none');
    expect(result.current.sortDirection).toBe('asc');
    expect(result.current.sortField).toBe('path');
  });

  it('falls back to defaults when stored preferences are null or invalid', () => {
    localStorage.setItem('previewPanelPreferences.v1', 'null');

    const nullStored = renderHook(() => usePreviewPanelPreferences(defaults));
    expect(nullStored.result.current.groupingConfig).toBe('none');
    nullStored.unmount();

    localStorage.setItem(
      'previewPanelPreferences.v1',
      JSON.stringify({
        groupingConfig: 'unknown',
      })
    );

    const invalidStored = renderHook(() => usePreviewPanelPreferences(defaults));
    expect(invalidStored.result.current.groupingConfig).toBe('none');
  });

  it('ignores storage write failures after the debounce', async () => {
    vi.useFakeTimers();
    const setItem = vi.fn(() => {
      throw new Error('storage unavailable');
    });
    vi.stubGlobal('localStorage', {
      clear: vi.fn(),
      getItem: vi.fn(() => null),
      key: vi.fn(() => null),
      length: 0,
      removeItem: vi.fn(),
      setItem,
    } satisfies Storage);

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    act(() => {
      result.current.setGroupingConfig('fileType');
    });

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(setItem).toHaveBeenCalledWith(
      'previewPanelPreferences.v1',
      expect.stringContaining('"groupingConfig":"fileType"')
    );
  });

  it('ignores quota errors after the debounce', async () => {
    vi.useFakeTimers();
    const setItem = vi.fn(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    vi.stubGlobal('localStorage', {
      clear: vi.fn(),
      getItem: vi.fn(() => null),
      key: vi.fn(() => null),
      length: 0,
      removeItem: vi.fn(),
      setItem,
    } satisfies Storage);

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    act(() => {
      result.current.setActiveTab('tapestry');
    });

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(setItem).toHaveBeenCalledWith(
      'previewPanelPreferences.v1',
      expect.stringContaining('"activeTab":"tapestry"')
    );
  });
});
