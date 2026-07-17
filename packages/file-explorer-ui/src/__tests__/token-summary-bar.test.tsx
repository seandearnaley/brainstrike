import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TokenSummaryBar } from '../indexing/token-summary-bar';
import type { TokenCountingState } from '../indexing/use-token-counting';

const defaultTokenCounting: TokenCountingState = {
  countTokens: async () => 0,
  loading: false,
  mode: 'heuristic',
  reason: null,
};

describe('TokenSummaryBar', () => {
  const defaultProps = {
    budget: 100_000,
    includeTree: true,
    isOverBudget: false,
    selectedTokens: 5000,
    tokenCounting: defaultTokenCounting,
    totalFiles: 10,
    treeTokens: 1000,
  };

  describe('BST-153: estimating state', () => {
    it('shows the local estimator token status badge', () => {
      render(<TokenSummaryBar {...defaultProps} />);

      expect(screen.getByText('Estimator')).toBeInTheDocument();
      expect(screen.queryByText('WASM')).not.toBeInTheDocument();
      expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
    });

    it('shows "output" when no files are pending', () => {
      render(<TokenSummaryBar {...defaultProps} selectedTokensPendingCount={0} />);

      expect(screen.getByText(/5,000 output/)).toBeInTheDocument();
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

      expect(screen.getByText(/5,000 output/)).toBeInTheDocument();
      expect(screen.queryByText(/estimating/)).not.toBeInTheDocument();
    });

    it('always shows the source token breakdown alongside output tokens (single presentation, no toggle)', () => {
      render(
        <TokenSummaryBar
          {...defaultProps}
          activeRangeFilesCount={2}
          rangeAdjustedFilesCount={3}
          selectedTokens={3200}
          sourceSelectedTokens={5000}
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
