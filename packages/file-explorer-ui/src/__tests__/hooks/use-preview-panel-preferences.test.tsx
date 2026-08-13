import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePreviewPanelPreferences } from '../../preview/use-preview-panel-preferences';

describe('usePreviewPanelPreferences', () => {
  const defaults = {
    footerMode: 'default' as const,
    groupingConfig: 'none',
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
        collapsedGroups: ['keep', 12, null],
        footerHeight: 9999,
        footerMode: 'not-a-mode',
        groupingConfig: 'folder',
      })
    );

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    expect(result.current.groupingConfig).toBe('rootFolder');
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

  it.each([
    [193.49, 'compact'],
    [193.5, 'compact'],
    [194.49, 'compact'],
    [194.5, 'default'],
    [313.49, 'default'],
    [313.5, 'expanded'],
  ] as const)('rounds legacy footer height %s before inferring %s mode', (footerHeight, mode) => {
    localStorage.setItem('previewPanelPreferences.v1', JSON.stringify({ footerHeight }));

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    expect(result.current.footerMode).toBe(mode);
  });

  it.each([
    ['positive overflow', '{"footerHeight":1e400,"footerMode":"compact"}'],
    ['negative overflow', '{"footerHeight":-1e400,"footerMode":"compact"}'],
  ] as const)('ignores a non-finite legacy footer height from %s and preserves a valid stored mode', (_case, storedPreferences) => {
    localStorage.setItem('previewPanelPreferences.v1', storedPreferences);

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    expect(result.current.footerMode).toBe('compact');
  });

  it('hydrates valid persisted values and saves preference updates after the debounce', async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      'previewPanelPreferences.v1',
      JSON.stringify({
        collapsedGroups: ['group-a'],
        groupingConfig: 'fileType',
        tapestryScale: 7,
      })
    );

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    expect(result.current.collapsedGroups).toEqual(new Set(['group-a']));
    expect(result.current.groupingConfig).toBe('fileType');
    expect(result.current.tapestryScale).toBe(7);

    act(() => {
      result.current.setCollapsedGroups(new Set(['group-b']));
      result.current.setGroupingConfig('rootFolder');
      result.current.setTapestryScale(2);
    });

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(JSON.parse(localStorage.getItem('previewPanelPreferences.v1') ?? '{}')).toEqual({
      collapsedGroups: ['group-b'],
      footerMode: 'default',
      groupingConfig: 'rootFolder',
      tapestryScale: 2,
    });
  });

  // BST-1211 migration: a profile written by the retired Table View carries four
  // keys this hook no longer models. They must neither crash the load nor leave
  // a dead surface behind — in particular `activeTab: 'table'` must not survive
  // into state or storage, because there is no table to land on any more.
  it('drops retired Table View keys from a legacy stored profile', async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      'previewPanelPreferences.v1',
      JSON.stringify({
        activeTab: 'table',
        collapsedGroups: ['group-a'],
        columnVisibility: { checkbox: false, size: false },
        groupingConfig: 'fileType',
        pageSize: 250,
        sortDirection: 'desc',
        sortField: 'tokens',
        tapestryScale: 5,
      })
    );

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    // Surviving preferences hydrate untouched...
    expect(result.current.groupingConfig).toBe('fileType');
    expect(result.current.collapsedGroups).toEqual(new Set(['group-a']));
    expect(result.current.tapestryScale).toBe(5);
    // ...and the retired ones are simply absent from state.
    expect(result.current).not.toHaveProperty('activeTab');
    expect(result.current).not.toHaveProperty('columnVisibility');
    expect(result.current).not.toHaveProperty('sortField');
    expect(result.current).not.toHaveProperty('sortDirection');
    expect(result.current).not.toHaveProperty('pageSize');

    act(() => {
      result.current.setGroupingConfig('rootFolder');
    });

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    // The next write prunes them from storage, so the upgrade is one-way.
    expect(JSON.parse(localStorage.getItem('previewPanelPreferences.v1') ?? '{}')).toEqual({
      collapsedGroups: ['group-a'],
      footerMode: 'default',
      groupingConfig: 'rootFolder',
      tapestryScale: 5,
    });
  });

  it('rejects an out-of-range stored Tapestry scale', () => {
    localStorage.setItem(
      'previewPanelPreferences.v1',
      JSON.stringify({
        tapestryScale: 99,
      })
    );

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    expect(result.current.tapestryScale).toBe(4);
  });

  it('rejects a fractional stored Tapestry scale', () => {
    localStorage.setItem(
      'previewPanelPreferences.v1',
      JSON.stringify({
        tapestryScale: 3.5,
      })
    );

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    expect(result.current.tapestryScale).toBe(4);
  });

  it('tolerates a stale useTapestryRangesForContextOutput field in a persisted blob (no migration mechanism, field silently ignored)', async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      'previewPanelPreferences.v1',
      JSON.stringify({
        groupingConfig: 'fileType',
        useTapestryRangesForContextOutput: false,
      })
    );

    const { result } = renderHook(() => usePreviewPanelPreferences(defaults));

    // The blob loads cleanly and the stale field is simply absent from state.
    expect(result.current.groupingConfig).toBe('fileType');
    expect(result.current).not.toHaveProperty('useTapestryRangesForContextOutput');

    act(() => {
      result.current.setGroupingConfig('rootFolder');
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

    expect(result.current.groupingConfig).toBe('none');
    expect(result.current.footerMode).toBe('default');
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
      result.current.setTapestryScale(6);
    });

    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(setItem).toHaveBeenCalledWith(
      'previewPanelPreferences.v1',
      expect.stringContaining('"tapestryScale":6')
    );
  });
});
