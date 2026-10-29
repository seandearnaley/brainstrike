/**
 * Expand All / Collapse All live in the TOOLBAR (whole-branch review F11).
 *
 * They used to float over the tree area's top-right corner (BST-571). BST-1208
 * put the tree grid's column header in that corner: at the Explorer's normal
 * width the overlay covered the trailing metadata header and intercepted its
 * clicks, so the grid's headline affordance — click a column to sort — was
 * unreachable by ordinary pointer use. The overlay is retired, not moved: its
 * absolute positioning existed only to avoid shifting tree rows.
 *
 * The historical `expand-all-button-small` / `collapse-all-button-small`
 * testids are load-bearing — every web/desktop e2e spec drives these actions by
 * id — so they travel with the buttons.
 */
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeExpansionButtons } from '../components/tree-expansion-buttons';
import { resolveTreeExpansionDisabledState } from '../utils/tree-expansion-disabled-state';

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

describe('TreeExpansionButtons', () => {
  it('renders both actions with their stable testids', () => {
    renderWithTooltips(<TreeExpansionButtons {...defaultProps} />);
    expect(screen.getByTestId('expand-all-button-small')).toBeInTheDocument();
    expect(screen.getByTestId('collapse-all-button-small')).toBeInTheDocument();
  });

  it('lays out INLINE — nothing absolute that could cover the column header', () => {
    renderWithTooltips(<TreeExpansionButtons {...defaultProps} />);
    const cluster = screen.getByTestId('tree-expansion-actions');

    expect(cluster.className).not.toContain('absolute');
    expect(cluster.className).not.toContain('fixed');
    // No stacking context either: the overlay's z-20 is what let it paint over
    // the sticky header in the first place.
    expect(cluster.className).not.toMatch(/\bz-\d/u);
  });

  it('invokes the handlers', async () => {
    const user = userEvent.setup();
    renderWithTooltips(<TreeExpansionButtons {...defaultProps} />);

    await user.click(screen.getByTestId('expand-all-button-small'));
    expect(defaultProps.onExpandAll).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('collapse-all-button-small'));
    expect(defaultProps.onCollapseAll).toHaveBeenCalledTimes(1);
  });

  it('disables expand while expanding but keeps collapse enabled as the stop affordance', () => {
    renderWithTooltips(<TreeExpansionButtons {...defaultProps} isExpandingAll />);
    expect(screen.getByTestId('expand-all-button-small')).toBeDisabled();
    expect(screen.getByTestId('collapse-all-button-small')).toBeEnabled();
  });

  it('disables both actions while loading or refreshing', () => {
    renderWithTooltips(<TreeExpansionButtons {...defaultProps} isRefreshing />);
    expect(screen.getByTestId('expand-all-button-small')).toBeDisabled();
    expect(screen.getByTestId('collapse-all-button-small')).toBeDisabled();
  });

  /**
   * Below 236px the buttons fold into the compact menu, so the two surfaces
   * MUST agree about availability — a menu item that stays clickable while its
   * button counterpart is disabled is a silent divergence.
   */
  it('derives one disabled rule for both the buttons and the compact menu', () => {
    expect(
      resolveTreeExpansionDisabledState({
        isExpandingAll: true,
        isLoading: false,
        isRefreshing: false,
      })
    ).toEqual({ collapse: false, expand: true });
    expect(
      resolveTreeExpansionDisabledState({
        isExpandingAll: false,
        isLoading: true,
        isRefreshing: false,
      })
    ).toEqual({ collapse: true, expand: true });
  });
});
