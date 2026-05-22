/**
 * Token Budget Summary Tests
 */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TokenBudgetSummary } from '../token-budget-summary';

describe('TokenBudgetSummary', () => {
  const defaultProps = {
    criticalTokens: 1000,
    conditionalTokens: 2000,
    totalBudget: 10_000,
    contextWindowSize: 128_000,
  };

  describe('rendering', () => {
    it('renders the component with correct token values', () => {
      render(<TokenBudgetSummary {...defaultProps} />);

      expect(screen.getByTestId('token-budget-summary')).toBeInTheDocument();
      expect(screen.getByText('Token Budget')).toBeInTheDocument();
      // Should show "3,000 / 10K" and "30%"
      expect(screen.getByText(/3,000/)).toBeInTheDocument();
      expect(screen.getByText(/10K/)).toBeInTheDocument();
      expect(screen.getByText(/30%/)).toBeInTheDocument();
    });

    it('renders progress bar segments', () => {
      render(<TokenBudgetSummary {...defaultProps} />);

      const criticalSegment = screen.getByTestId('critical-segment');
      const conditionalSegment = screen.getByTestId('conditional-segment');

      expect(criticalSegment).toBeInTheDocument();
      expect(conditionalSegment).toBeInTheDocument();
    });

    it('displays budget info in single line when collapsed', () => {
      render(<TokenBudgetSummary {...defaultProps} />);
      expect(screen.getByText('Token Budget')).toBeInTheDocument();
      expect(screen.getByTestId('progress-bar-inline')).toBeInTheDocument();
    });
  });

  describe('expanded state', () => {
    it('links the disclosure button to the mounted legend with ARIA state', () => {
      render(<TokenBudgetSummary {...defaultProps} />);

      const button = screen.getByRole('button', { name: /token budget/i });

      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(button).not.toHaveAttribute('aria-controls');

      fireEvent.click(button);

      expect(button).toHaveAttribute('aria-expanded', 'true');
      const legendId = button.getAttribute('aria-controls');
      expect(legendId).toBeTruthy();
      expect(document.getElementById(legendId as string)).toHaveTextContent('Critical (1,000)');
    });

    it('shows expanded details when clicked', () => {
      render(<TokenBudgetSummary {...defaultProps} />);

      // Initially, details should not be visible
      expect(screen.queryByText(/Critical \(1,000\)/)).not.toBeInTheDocument();

      // Click to expand
      const button = screen.getByRole('button');
      fireEvent.click(button);

      // Now details should be visible
      expect(screen.getByText(/Critical \(1,000\)/)).toBeInTheDocument();
      expect(screen.getByText(/Conditional \(2,000\)/)).toBeInTheDocument();
      expect(screen.getByText(/Available \(7,000\)/)).toBeInTheDocument();
    });

    it('collapses when clicked again', () => {
      render(<TokenBudgetSummary {...defaultProps} />);

      const button = screen.getByRole('button');

      // Expand
      fireEvent.click(button);
      expect(screen.getByText(/Critical \(1,000\)/)).toBeInTheDocument();

      // Collapse
      fireEvent.click(button);
      expect(screen.queryByText(/Critical \(1,000\)/)).not.toBeInTheDocument();
    });
  });

  describe('warning and error states', () => {
    it('shows warning state when usage exceeds 90%', () => {
      render(
        <TokenBudgetSummary
          conditionalTokens={4500}
          contextWindowSize={128_000}
          criticalTokens={5000}
          totalBudget={10_000}
        />
      );

      const summary = screen.getByTestId('token-budget-summary');
      // Should have warning styles (yellow border)
      expect(summary.className).toContain('border-yellow-500/50');
    });

    it('shows error state when usage exceeds 100%', () => {
      render(
        <TokenBudgetSummary
          conditionalTokens={5000}
          contextWindowSize={128_000}
          criticalTokens={6000}
          totalBudget={10_000}
        />
      );

      const summary = screen.getByTestId('token-budget-summary');
      // Should have error styles (destructive border)
      expect(summary.className).toContain('border-destructive/50');
    });

    it('shows normal state when usage is under 90%', () => {
      render(<TokenBudgetSummary {...defaultProps} />);

      const summary = screen.getByTestId('token-budget-summary');
      // Should have normal border
      expect(summary.className).toContain('border-border');
    });
  });

  describe('edge cases', () => {
    it('handles zero budget gracefully', () => {
      render(
        <TokenBudgetSummary
          conditionalTokens={0}
          contextWindowSize={128_000}
          criticalTokens={0}
          totalBudget={0}
        />
      );

      expect(screen.getByTestId('token-budget-summary')).toBeInTheDocument();
      expect(screen.getByText(/0%/)).toBeInTheDocument();
    });

    it('handles zero tokens with positive budget', () => {
      render(
        <TokenBudgetSummary
          conditionalTokens={0}
          contextWindowSize={128_000}
          criticalTokens={0}
          totalBudget={10_000}
        />
      );

      const criticalSegment = screen.getByTestId('critical-segment');
      const conditionalSegment = screen.getByTestId('conditional-segment');

      // Check style attribute contains width: 0%
      expect(criticalSegment.getAttribute('style')).toContain('width: 0%');
      expect(conditionalSegment.getAttribute('style')).toContain('width: 0%');
    });

    it('clamps available tokens to zero when over budget', () => {
      render(
        <TokenBudgetSummary
          conditionalTokens={6000}
          contextWindowSize={128_000}
          criticalTokens={6000}
          totalBudget={10_000}
        />
      );

      // Click to expand and check available tokens
      const button = screen.getByRole('button');
      fireEvent.click(button);

      // Available should be clamped to 0, not negative
      expect(screen.getByText(/Available \(0\)/)).toBeInTheDocument();
    });

    it('formats large numbers with locale separators', () => {
      render(
        <TokenBudgetSummary
          conditionalTokens={25_000}
          contextWindowSize={128_000}
          criticalTokens={15_000}
          totalBudget={100_000}
        />
      );

      // Should show formatted numbers
      expect(screen.getByText(/40,000/)).toBeInTheDocument();
      expect(screen.getByText(/100K/)).toBeInTheDocument();
    });
  });

  describe('progress bar calculations', () => {
    it('calculates correct percentages for segments', () => {
      render(
        <TokenBudgetSummary
          conditionalTokens={5000}
          contextWindowSize={128_000}
          criticalTokens={2500}
          totalBudget={10_000}
        />
      );

      const criticalSegment = screen.getByTestId('critical-segment');
      const conditionalSegment = screen.getByTestId('conditional-segment');

      // 2500/10000 = 25%
      expect(criticalSegment.getAttribute('style')).toContain('width: 25%');
      // 5000/10000 = 50%
      expect(conditionalSegment.getAttribute('style')).toContain('width: 50%');
    });

    it('caps critical segment at 100%', () => {
      render(
        <TokenBudgetSummary
          conditionalTokens={0}
          contextWindowSize={128_000}
          criticalTokens={15_000}
          totalBudget={10_000}
        />
      );

      const criticalSegment = screen.getByTestId('critical-segment');
      // Should be capped at 100%, not 150%
      expect(criticalSegment.getAttribute('style')).toContain('width: 100%');
    });

    it('displays overall percentage correctly', () => {
      render(
        <TokenBudgetSummary
          conditionalTokens={2000}
          contextWindowSize={128_000}
          criticalTokens={3000}
          totalBudget={10_000}
        />
      );

      // 5000/10000 = 50%
      expect(screen.getByText(/50%/)).toBeInTheDocument();
    });
  });
});
