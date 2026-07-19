/**
 * BST-571: Expand All / Collapse All live in a floating cluster pinned to the
 * top-right of the explorer tree area (the toolbar's right cluster was
 * overcrowded, and the tree's top-right corner is usually empty). This
 * deliberately reverses part of the older "consolidate into the toolbar"
 * ruling — but ONLY for expand/collapse; Refresh and the inline scanning
 * indicator stay on the toolbar (see tree-action-buttons.test.tsx).
 *
 * The cluster keeps the historical `expand-all-button-small` /
 * `collapse-all-button-small` testids: every web/desktop e2e spec drives the
 * actions through those ids, wherever the buttons live.
 */
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingTreeActions } from '../components/floating-tree-actions';

const renderWithTooltips = (ui: ReactElement) =>
  render(ui, { wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider> });

const defaultProps = {
  isExpandingAll: false,
  isLoading: false,
  isRefreshing: false,
  onCollapseAll: vi.fn(),
  onExpandAll: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FloatingTreeActions', () => {
  it('renders expand-all and collapse-all with their stable testids', () => {
    renderWithTooltips(<FloatingTreeActions {...defaultProps} />);
    expect(screen.getByTestId('expand-all-button-small')).toBeInTheDocument();
    expect(screen.getByTestId('collapse-all-button-small')).toBeInTheDocument();
  });

  it('floats over the tree instead of participating in layout flow', () => {
    renderWithTooltips(<FloatingTreeActions {...defaultProps} />);
    // Pinned to the tree area's top-right as an overlay: mounting it must
    // never shift tree rows (same contract as the RestorationStatus overlay).
    const cluster = screen.getByTestId('floating-tree-actions');
    expect(cluster.className).toContain('absolute');
  });

  it('invokes the handlers from the floating buttons', async () => {
    const user = userEvent.setup();
    renderWithTooltips(<FloatingTreeActions {...defaultProps} />);

    await user.click(screen.getByTestId('expand-all-button-small'));
    expect(defaultProps.onExpandAll).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('collapse-all-button-small'));
    expect(defaultProps.onCollapseAll).toHaveBeenCalledTimes(1);
  });

  it('disables expand while expanding but keeps collapse enabled as the stop affordance', () => {
    renderWithTooltips(<FloatingTreeActions {...defaultProps} isExpandingAll />);
    expect(screen.getByTestId('expand-all-button-small')).toBeDisabled();
    expect(screen.getByTestId('collapse-all-button-small')).toBeEnabled();
  });

  it('disables both actions while loading or refreshing', () => {
    renderWithTooltips(<FloatingTreeActions {...defaultProps} isRefreshing />);
    expect(screen.getByTestId('expand-all-button-small')).toBeDisabled();
    expect(screen.getByTestId('collapse-all-button-small')).toBeDisabled();
  });
});
