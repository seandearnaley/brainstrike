// @vitest-environment node
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
} from '../shell/file-explorer-panel-toolbar-logic';
import { computeScanningStatusProps } from '../utils/scanning-status-props';

const baseInput = {
  hasRoot: true,
  // BST-1208 folded Expand/Collapse into this menu below 236px, so the same
  // resolver now derives their disabled state too (shared with the toolbar
  // buttons above the step, so the two surfaces cannot disagree).
  isExpandingAll: false,
  isFiltersExpanded: false,
  isLoading: false,
  isOperationInProgress: false,
  isRefreshing: false,
};

/** Expansion availability rides along with every `available` result. */
const EXPANSION_READY = { collapseDisabled: false, expandDisabled: false };

describe('resolveCompactToolbarActionsState', () => {
  it('derives expansion availability from the SAME rule as the toolbar buttons', () => {
    // A menu item that stays clickable while its button counterpart is
    // disabled is a silent divergence; both read resolveTreeExpansionDisabledState.
    expect(resolveCompactToolbarActionsState({ ...baseInput, isExpandingAll: true })).toMatchObject(
      {
        // Collapse stays live during a sweep — it is the discard-and-stop action.
        expansion: { collapseDisabled: false, expandDisabled: true },
      }
    );
  });

  it('is unavailable until a workspace root is attached', () => {
    expect(resolveCompactToolbarActionsState({ ...baseInput, hasRoot: false })).toEqual({
      availability: 'unavailable',
    });
  });

  it('offers refresh and view filters once a root is attached', () => {
    expect(resolveCompactToolbarActionsState(baseInput)).toEqual({
      availability: 'available',
      expansion: EXPANSION_READY,
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
    ).toEqual({
      availability: 'available',
      // Refresh in flight disables BOTH expansion actions, shared rule.
      expansion: { collapseDisabled: true, expandDisabled: true },
      filters: 'expanded',
      refresh: 'refreshing',
    });
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

  it('keeps yielding when a refresh spinner is also active', () => {
    // Narrow scope on purpose: isOperationInProgress is passed in literally, so
    // this only proves isRefreshing cannot override an already-true yield. The
    // refresh -> yield wiring lives in isCancellableOperationRunning (which
    // never reads isRefreshing) and is covered there.
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
    forestCancelExpandAll: null,
    isExpandingAll: false,
    isForestExpandingAll: false,
    loadingProgress: null,
  };
  const forestCancel = () => undefined;

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
    expect(
      isCancellableOperationRunning({
        ...idle,
        forestCancelExpandAll: forestCancel,
        isForestExpandingAll: true,
      })
    ).toBe(true);
  });

  it('does NOT yield for a forest sweep with no forest cancel to offer', () => {
    // resolveExpandAllScanningSource falls through to the focused provider when
    // the forest cancel is null, and that provider is idle mid-forest-sweep, so
    // computeScanningStatusProps renders no indicator. Yielding here would
    // unmount the compact menu and leave the 180px track with Select All alone.
    expect(
      isCancellableOperationRunning({
        ...idle,
        forestCancelExpandAll: null,
        isForestExpandingAll: true,
      })
    ).toBe(false);
  });

  it('is true during the initial load', () => {
    expect(
      isCancellableOperationRunning({ ...idle, loadingProgress: { isInitialLoading: true } })
    ).toBe(true);
  });

  it('yields for a refresh, which surfaces as isInitialLoading rather than isRefreshing', () => {
    // handleRefresh drives isLoading with no per-path loads, so the tree context
    // reports isInitialLoading — this is the ONLY route by which a refresh makes
    // the compact menu yield, since nothing here reads isRefreshing.
    expect(
      isCancellableOperationRunning({ ...idle, loadingProgress: { isInitialLoading: true } })
    ).toBe(true);
  });
});

/**
 * CROSS-CONTRACT INVARIANT (BST-657 × BST-1208).
 *
 * BST-1208 folded Expand All / Collapse All into the compact menu below 236px.
 * BST-657 makes that same menu UNMOUNT while a cancellable operation runs
 * (`yielded-to-cancel`), to keep the 76px track's math. Composed, that means
 * neither expansion action is reachable at 180px mid-sweep.
 *
 * That is only acceptable because a DIFFERENT control stops the sweep: the
 * scanning indicator's Cancel, which carries no width gate and calls
 * `cancelExpandAll` (`utils/scanning-status-props.ts`). Collapse All would also
 * stop it, but it additionally discards the partial expansion — a different
 * action, not the same affordance.
 *
 * So the invariant is: WHENEVER the compact menu yields, a stop control must
 * exist outside it. If either side ever changes — the menu stops yielding, or
 * the indicator stops rendering its cancel — this must fail loudly rather than
 * silently leaving a running sweep unstoppable at the default desktop width.
 */
describe('narrow-width stop affordance survives the menu yielding', () => {
  const RUNNING_SWEEP = {
    cancelExpandAll: () => undefined,
    cancellable: false,
    expandAllProgress: { loaded: 3, total: 9 },
    handleCancelOperation: () => undefined,
    isCancelling: false,
    isExpandingAll: true,
    loadingProgress: null,
  };

  it('yields the menu AND leaves a cancel that stops the sweep', () => {
    const isOperationInProgress = isCancellableOperationRunning({
      forestCancelExpandAll: null,
      isExpandingAll: true,
      isForestExpandingAll: false,
      loadingProgress: null,
    });
    expect(isOperationInProgress).toBe(true);

    // The menu is gone…
    expect(
      resolveCompactToolbarActionsState({
        ...baseInput,
        isExpandingAll: true,
        isOperationInProgress,
      })
    ).toEqual({ availability: 'yielded-to-cancel' });

    // …and the indicator that replaces it carries a cancel wired to the sweep's
    // own aborter, so the operation is still stoppable at 180px.
    const scanning = computeScanningStatusProps(RUNNING_SWEEP);
    expect(scanning).not.toBeNull();
    expect(scanning?.cancellable).toBe(true);
    expect(scanning?.onCancel).toBe(RUNNING_SWEEP.cancelExpandAll);
  });

  it('holds for a forest sweep too, where the focused provider is idle', () => {
    const forestCancelExpandAll = () => undefined;
    const isOperationInProgress = isCancellableOperationRunning({
      forestCancelExpandAll,
      isExpandingAll: false,
      isForestExpandingAll: true,
      loadingProgress: null,
    });
    expect(isOperationInProgress).toBe(true);
    expect(resolveCompactToolbarActionsState({ ...baseInput, isOperationInProgress })).toEqual({
      availability: 'yielded-to-cancel',
    });

    const scanning = computeScanningStatusProps({
      ...RUNNING_SWEEP,
      cancelExpandAll: forestCancelExpandAll,
    });
    expect(scanning?.cancellable).toBe(true);
    expect(scanning?.onCancel).toBe(forestCancelExpandAll);
  });
});
