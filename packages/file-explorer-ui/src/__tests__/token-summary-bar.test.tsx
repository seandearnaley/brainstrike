import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TokenSummaryBar } from '../indexing/token-summary-bar';
import type { TokenCountingState } from '../indexing/use-token-counting';

const defaultTokenCounting: TokenCountingState = {
  mode: 'heuristic',
  loading: false,
  reason: null,
  countTokens: async () => 0,
};

describe('TokenSummaryBar', () => {
  const defaultProps = {
    totalFiles: 10,
    selectedTokens: 5000,
    treeTokens: 1000,
    includeTree: true,
    budget: 100_000,
    isOverBudget: false,
    tokenCounting: defaultTokenCounting,
  };

  describe('BST-153: estimating state', () => {
    it('shows the local estimator token status badge', () => {
      render(<TokenSummaryBar {...defaultProps} />);

      expect(screen.getByText('Estimator')).toBeInTheDocument();
      expect(screen.queryByText('WASM')).not.toBeInTheDocument();
      expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
    });

    it('shows "selected" when no files are pending', () => {
      render(<TokenSummaryBar {...defaultProps} selectedTokensPendingCount={0} />);

      expect(screen.getByText(/5,000 selected/)).toBeInTheDocument();
    });

    it('shows "estimating..." when files are pending', () => {
      render(<TokenSummaryBar {...defaultProps} selectedTokensPendingCount={3} />);

      expect(screen.getByText(/5,000\+ estimating…/)).toBeInTheDocument();
    });

    it('shows correct tooltip when estimating', async () => {
      render(<TokenSummaryBar {...defaultProps} selectedTokensPendingCount={3} totalFiles={10} />);

      // The tooltip content should mention counting progress
      const selectedTokensElement = screen.getByText(/5,000\+ estimating…/);
      expect(selectedTokensElement).toBeInTheDocument();
    });

    it('defaults to not estimating when prop is omitted', () => {
      render(<TokenSummaryBar {...defaultProps} />);

      expect(screen.getByText(/5,000 selected/)).toBeInTheDocument();
      expect(screen.queryByText(/estimating/)).not.toBeInTheDocument();
    });

    it('shows output/source breakdown when tapestry range mode is enabled', () => {
      render(
        <TokenSummaryBar
          {...defaultProps}
          activeRangeFilesCount={2}
          rangeAdjustedFilesCount={3}
          selectedTokens={3200}
          sourceSelectedTokens={5000}
          useTapestryRanges
        />
      );

      expect(screen.getByText(/3,200 output/)).toBeInTheDocument();
      expect(screen.getByText(/5,000 source/)).toBeInTheDocument();
    });
  });

  describe('tree loading state', () => {
    it('shows "…" for tree tokens when loading', () => {
      render(<TokenSummaryBar {...defaultProps} treeLoading />);

      // When loading, shows ellipsis only (no "tree" suffix until loaded)
      expect(screen.getByText('…')).toBeInTheDocument();
    });

    it('shows tree token count when not loading', () => {
      render(<TokenSummaryBar {...defaultProps} treeLoading={false} />);

      expect(screen.getByText('1,000 tree')).toBeInTheDocument();
    });
  });

  describe('budget status', () => {
    it('shows remaining tokens when under budget', () => {
      render(<TokenSummaryBar {...defaultProps} isOverBudget={false} />);

      expect(screen.getByText('left')).toBeInTheDocument();
    });

    it('shows over budget indicator when over budget', () => {
      render(<TokenSummaryBar {...defaultProps} isOverBudget />);

      expect(screen.getByText('over')).toBeInTheDocument();
    });
  });
});
