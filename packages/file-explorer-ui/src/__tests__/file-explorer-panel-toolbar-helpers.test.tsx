/**
 * The compact (narrow-width) toolbar menu's availability contract.
 *
 * At the 180px minimum panel width the toolbar's right track is 76px. It fits
 * the compact menu and Select All, OR the scanning indicator's cancel and
 * Select All -- not all three. While a cancellable operation runs the cancel
 * wins the slot: the compact menu's only live item is View Filters (its
 * Refresh item is disabled mid-operation), whereas the cancel is the sole way
 * to abort a running expand-all sweep (BST-657).
 */

import { describe, expect, it } from 'vitest';
import {
  isCancellableOperationRunning,
  resolveCompactToolbarActionsState,
} from '../shell/file-explorer-panel-toolbar-helpers';

const baseInput = {
  hasRoot: true,
  isFiltersExpanded: false,
  isLoading: false,
  isOperationInProgress: false,
  isRefreshing: false,
};

describe('resolveCompactToolbarActionsState', () => {
  it('is unavailable until a workspace root is attached', () => {
    expect(resolveCompactToolbarActionsState({ ...baseInput, hasRoot: false })).toEqual({
      availability: 'unavailable',
    });
  });

  it('offers refresh and view filters once a root is attached', () => {
    expect(resolveCompactToolbarActionsState(baseInput)).toEqual({
      availability: 'available',
      filters: 'collapsed',
      refresh: 'ready',
    });
  });

  it('reports the refresh spinner and the expanded filters state', () => {
    expect(
      resolveCompactToolbarActionsState({
        ...baseInput,
        isFiltersExpanded: true,
        isRefreshing: true,
      })
    ).toEqual({ availability: 'available', filters: 'expanded', refresh: 'refreshing' });
  });

  it('disables refresh while the tree loads', () => {
    expect(resolveCompactToolbarActionsState({ ...baseInput, isLoading: true })).toMatchObject({
      refresh: 'disabled',
    });
  });

  it('yields its narrow-track slot to the cancel affordance while an operation runs', () => {
    expect(
      resolveCompactToolbarActionsState({ ...baseInput, isOperationInProgress: true })
    ).toEqual({ availability: 'yielded-to-cancel' });
  });

  it('yields even while refreshing, so a stuck refresh stays abortable', () => {
    expect(
      resolveCompactToolbarActionsState({
        ...baseInput,
        isOperationInProgress: true,
        isRefreshing: true,
      })
    ).toEqual({ availability: 'yielded-to-cancel' });
  });

  it('still reports unavailable without a root even mid-operation', () => {
    expect(
      resolveCompactToolbarActionsState({
        ...baseInput,
        hasRoot: false,
        isOperationInProgress: true,
      })
    ).toEqual({ availability: 'unavailable' });
  });
});

describe('isCancellableOperationRunning', () => {
  const idle = {
    isExpandingAll: false,
    isForestExpandingAll: false,
    loadingProgress: null,
  };

  it('is false when nothing is running', () => {
    expect(isCancellableOperationRunning(idle)).toBe(false);
    expect(isCancellableOperationRunning({ ...idle, loadingProgress: undefined })).toBe(false);
    expect(
      isCancellableOperationRunning({ ...idle, loadingProgress: { isInitialLoading: false } })
    ).toBe(false);
  });

  it('is true during a single-root expand-all sweep', () => {
    expect(isCancellableOperationRunning({ ...idle, isExpandingAll: true })).toBe(true);
  });

  it('is true during a forest sweep, where the focused provider stays idle', () => {
    // Each section expands inside its OWN provider, so isExpandingAll is false
    // even though a cancellable sweep is very much running.
    expect(isCancellableOperationRunning({ ...idle, isForestExpandingAll: true })).toBe(true);
  });

  it('is true during the initial load', () => {
    expect(
      isCancellableOperationRunning({ ...idle, loadingProgress: { isInitialLoading: true } })
    ).toBe(true);
  });
});
