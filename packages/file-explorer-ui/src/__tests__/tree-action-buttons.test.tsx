import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TreeActionButtons } from '../components/tree-action-buttons';

const renderWithTooltips = (ui: ReactElement) =>
  render(ui, { wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider> });

describe('TreeActionButtons', () => {
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
      isScanning: true,
      cancellable: true,
      isCancelling: false,
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

    it('does not render the indicator when not scanning', () => {
      renderWithTooltips(<TreeActionButtons {...defaultProps} scanningStatus={null} />);
      expect(screen.queryByTestId('inline-scanning-indicator')).not.toBeInTheDocument();
    });
  });
});
