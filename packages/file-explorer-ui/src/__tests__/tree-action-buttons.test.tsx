import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeActionButtons } from '../components/tree-action-buttons';

const renderWithTooltips = (ui: ReactElement) =>
  render(ui, { wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider> });

const NARROW_HIDDEN = '@max-[240px]/explorer-toolbar:hidden';
const WIDE_HIDDEN = '@[240px]/explorer-toolbar:hidden';

describe('TreeActionButtons', () => {
  it('hides the inline expand/collapse buttons (but never refresh) below the narrow toolbar breakpoint', () => {
    renderWithTooltips(<TreeActionButtons {...defaultProps} />);

    // The Explorer panel's documented minimum width (~180px) cannot fit the
    // whole right cluster; the inline expand/collapse buttons yield first,
    // refresh stays.
    expect(screen.getByTestId('expand-all-button-small')).toHaveClass(NARROW_HIDDEN);
    expect(screen.getByTestId('collapse-all-button-small')).toHaveClass(NARROW_HIDDEN);
    expect(screen.getByTestId('refresh-button-small')).not.toHaveClass(NARROW_HIDDEN);
  });

  it('keeps expand/collapse reachable at narrow widths through the overflow menu', () => {
    renderWithTooltips(<TreeActionButtons {...defaultProps} />);

    // The overflow trigger is the narrow-width stand-in: it must be visible
    // exactly where the inline buttons hide, and gone where they show —
    // otherwise expand-all silently vanishes at default panel widths (the
    // #1683 regression).
    const overflowTrigger = screen.getByTestId('tree-actions-overflow-trigger');
    expect(overflowTrigger).toHaveClass(WIDE_HIDDEN);
    expect(overflowTrigger).not.toHaveClass(NARROW_HIDDEN);
  });

  it('runs expand-all and collapse-all from the overflow menu', async () => {
    const user = userEvent.setup();
    renderWithTooltips(<TreeActionButtons {...defaultProps} />);

    await user.click(screen.getByTestId('tree-actions-overflow-trigger'));
    await user.click(await screen.findByTestId('expand-all-menu-item'));
    expect(defaultProps.onExpandAll).toHaveBeenCalledTimes(1);

    // Selecting an item closes the menu; reopen for collapse.
    await user.click(screen.getByTestId('tree-actions-overflow-trigger'));
    await user.click(await screen.findByTestId('collapse-all-menu-item'));
    expect(defaultProps.onCollapseAll).toHaveBeenCalledTimes(1);
  });

  it('mirrors the inline disabled states in the overflow menu items', async () => {
    const user = userEvent.setup();
    renderWithTooltips(<TreeActionButtons {...defaultProps} isExpandingAll />);

    await user.click(screen.getByTestId('tree-actions-overflow-trigger'));
    // While expanding: expand is blocked (same as the inline button), collapse
    // stays enabled — it doubles as the way to stop a running expand.
    expect(await screen.findByTestId('expand-all-menu-item')).toHaveAttribute('data-disabled');
    expect(screen.getByTestId('collapse-all-menu-item')).not.toHaveAttribute('data-disabled');
  });

  const defaultProps = {
    isExpandingAll: false,
    isLoading: false,
    isRefreshing: false,
    onCollapseAll: vi.fn(),
    onExpandAll: vi.fn(),
    onRefresh: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders refresh, expand-all and collapse-all with stable testids', () => {
    renderWithTooltips(<TreeActionButtons {...defaultProps} />);
    expect(screen.getByTestId('refresh-button-small')).toBeInTheDocument();
    expect(screen.getByTestId('expand-all-button-small')).toBeInTheDocument();
    expect(screen.getByTestId('collapse-all-button-small')).toBeInTheDocument();
  });

  it('lays the buttons out inline (not as an absolute floating overlay)', () => {
    const { container } = renderWithTooltips(<TreeActionButtons {...defaultProps} />);
    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    // The old treatment floated over the tree with `absolute top-2 right-6`.
    // The consolidated treatment lives inline in the filter row instead.
    expect(root?.className).not.toContain('absolute');
  });

  describe('inline scanning indicator', () => {
    const scanning = (overrides = {}) => ({
      cancellable: true,
      isCancelling: false,
      isScanning: true,
      onCancel: vi.fn(),
      ...overrides,
    });

    it('shows a growing loaded/total count and never a percentage', () => {
      renderWithTooltips(
        <TreeActionButtons
          {...defaultProps}
          isExpandingAll
          scanningStatus={scanning({ loadedCount: 5, totalCount: 10 })}
        />
      );
      const indicator = screen.getByTestId('inline-scanning-indicator');
      expect(indicator).toHaveTextContent('5/10');
      expect(indicator.textContent).not.toContain('%');
    });

    it('keeps showing the monotonic loaded count as it grows', () => {
      const { rerender } = renderWithTooltips(
        <TreeActionButtons
          {...defaultProps}
          isExpandingAll
          scanningStatus={scanning({ loadedCount: 5, totalCount: 10 })}
        />
      );
      expect(screen.getByTestId('inline-scanning-indicator')).toHaveTextContent('5/10');

      // total grows as lazy subfolders are discovered; loaded only ever rises.
      rerender(
        <TreeActionButtons
          {...defaultProps}
          isExpandingAll
          scanningStatus={scanning({ loadedCount: 8, totalCount: 15 })}
        />
      );
      expect(screen.getByTestId('inline-scanning-indicator')).toHaveTextContent('8/15');
    });

    it('renders the count with tabular-nums so digit growth does not shift width', () => {
      renderWithTooltips(
        <TreeActionButtons
          {...defaultProps}
          isExpandingAll
          scanningStatus={scanning({ loadedCount: 5, totalCount: 10 })}
        />
      );
      expect(screen.getByTestId('inline-scanning-count')).toHaveClass('tabular-nums');
    });

    it('shows a stopping label while cancelling instead of the count', () => {
      renderWithTooltips(
        <TreeActionButtons
          {...defaultProps}
          isExpandingAll
          scanningStatus={scanning({ isCancelling: true, loadedCount: 5, totalCount: 10 })}
        />
      );
      const indicator = screen.getByTestId('inline-scanning-indicator');
      expect(indicator).toHaveTextContent(/stopping/i);
      expect(indicator).not.toHaveTextContent('5/10');
    });

    it('scopes the currentPath tooltip to the count, not the indicator or cancel button', () => {
      // A container-level `title` bled onto the cancel <Button>, stacking a
      // native tooltip on top of its Radix "Cancel operation" tooltip. Keep the
      // currentPath hover scoped to the (non-interactive) count span.
      renderWithTooltips(
        <TreeActionButtons
          {...defaultProps}
          isExpandingAll
          scanningStatus={scanning({
            currentPath: 'Loading 5/10 directories',
            loadedCount: 5,
            totalCount: 10,
          })}
        />
      );
      expect(screen.getByTestId('inline-scanning-count')).toHaveAttribute(
        'title',
        'Loading 5/10 directories'
      );
      expect(screen.getByTestId('inline-scanning-indicator')).not.toHaveAttribute('title');
      expect(screen.getByRole('button', { name: /cancel operation/i })).not.toHaveAttribute(
        'title'
      );
    });

    it('renders nothing when there is no spinner, label, or cancel to show', () => {
      // A refresh that is not cancellable and has no count would otherwise paint
      // an empty, zero-size div: hideSpinner (isRefreshing) hides the spinner,
      // countText is '' on the non-expand branch, isCancelling is false, and the
      // cancel X is gated on cancellable. Render null so the empty indicator
      // can't flake a future toBeVisible() assertion.
      renderWithTooltips(
        <TreeActionButtons
          {...defaultProps}
          isRefreshing
          scanningStatus={scanning({ cancellable: false })}
        />
      );
      expect(screen.queryByTestId('inline-scanning-indicator')).not.toBeInTheDocument();
    });

    it('does not render the indicator when not scanning', () => {
      renderWithTooltips(<TreeActionButtons {...defaultProps} scanningStatus={null} />);
      expect(screen.queryByTestId('inline-scanning-indicator')).not.toBeInTheDocument();
    });

    it('during refresh, hides the redundant spinner but keeps the cancel affordance', () => {
      // A refresh sets isInitialLoading -> scanningStatus.isScanning with
      // cancellable=true (cancellable === isLoading). The refresh button already
      // spins, so a second indicator spinner just crowds the row -- but the
      // operation is genuinely cancellable, so the X must remain reachable.
      // Suppressing the whole indicator (the prior approach) removed the only
      // way to cancel a slow/stuck refresh while the refresh button is disabled.
      renderWithTooltips(
        <TreeActionButtons {...defaultProps} isRefreshing scanningStatus={scanning()} />
      );
      // No second spinner crowding the filter row.
      expect(screen.queryByTestId('inline-scanning-spinner')).not.toBeInTheDocument();
      // ...but a slow/stuck refresh stays cancellable.
      expect(screen.getByRole('button', { name: /cancel operation/i })).toBeInTheDocument();
      expect(screen.getByTestId('refresh-button-small')).toBeInTheDocument();
    });

    it('during expand-all, hides the indicator spinner (expand button already spins) but keeps the count', () => {
      // The expand-all button swaps its chevron for a spinning Loader2 while
      // isExpandingAll, so an indicator spinner would be a second spinning
      // circle in the same row -- the exact redundancy removed for refresh.
      // The 5/10 count is the intended progress signal during expand.
      renderWithTooltips(
        <TreeActionButtons
          {...defaultProps}
          isExpandingAll
          scanningStatus={scanning({ loadedCount: 1, totalCount: 3 })}
        />
      );
      expect(screen.queryByTestId('inline-scanning-spinner')).not.toBeInTheDocument();
      expect(screen.getByTestId('inline-scanning-count')).toHaveTextContent('1/3');
    });

    it('shows the indicator spinner during a first load when nothing else spins', () => {
      // Plain initial load (not refresh, not expand-all): no adjacent button
      // is spinning, so the indicator's own spinner is the sole activity cue
      // and must remain visible.
      renderWithTooltips(<TreeActionButtons {...defaultProps} scanningStatus={scanning()} />);
      expect(screen.getByTestId('inline-scanning-spinner')).toBeInTheDocument();
    });

    it('still shows the count indicator during expand-all even alongside other work', () => {
      renderWithTooltips(
        <TreeActionButtons
          {...defaultProps}
          isExpandingAll
          scanningStatus={scanning({ loadedCount: 5, totalCount: 10 })}
        />
      );
      expect(screen.getByTestId('inline-scanning-indicator')).toHaveTextContent('5/10');
    });
  });
});
