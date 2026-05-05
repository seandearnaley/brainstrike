import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmbeddingStatusBar, type EmbeddingStatusBarProps } from '../embedding-status-bar';

describe('EmbeddingStatusBar', () => {
  const defaultProps: EmbeddingStatusBarProps = {
    vectorEnabled: true,
    workerStatus: 'running',
    throughput: 10.5,
    latencyStats: { avgMs: 100, p50Ms: 95, p95Ms: 150 },
    queueCounts: { queued: 5, running: 2, failed: 1, succeeded: 100 },
    telemetryTrend: [
      { timestamp: Date.now() - 60_000, throughput: 8, latencyP95: 140, errorCount: 0 },
      { timestamp: Date.now(), throughput: 10, latencyP95: 150, errorCount: 1 },
    ],
  };

  const renderStatusBar = (props: Partial<EmbeddingStatusBarProps> = {}) =>
    render(<EmbeddingStatusBar {...defaultProps} {...props} />);

  describe('StatusBar container', () => {
    it('renders with unique embedding-status-bar testId', () => {
      renderStatusBar();
      expect(screen.getByTestId('embedding-status-bar')).toBeInTheDocument();
    });

    it('applies custom className when provided', () => {
      renderStatusBar({ className: 'custom-class' });
      const statusBar = screen.getByTestId('embedding-status-bar');
      expect(statusBar).toHaveClass('custom-class');
    });
  });

  describe('PG status badge', () => {
    it('shows "PG" when vector is enabled', () => {
      renderStatusBar({ vectorEnabled: true });
      expect(screen.getByText('PG')).toBeInTheDocument();
    });

    it('shows "PG: OFF" when vector is disabled', () => {
      renderStatusBar({ vectorEnabled: false });
      expect(screen.getByText('PG: OFF')).toBeInTheDocument();
    });
  });

  describe('Worker status badge', () => {
    it('shows "● RUN" when worker is running', () => {
      renderStatusBar({ workerStatus: 'running' });
      expect(screen.getByText('● RUN')).toBeInTheDocument();
    });

    it('shows "✕ ERR" when worker has error', () => {
      renderStatusBar({ workerStatus: 'error' });
      expect(screen.getByText('✕ ERR')).toBeInTheDocument();
    });

    it('shows "○ IDLE" when worker is disabled', () => {
      renderStatusBar({ workerStatus: 'disabled' });
      expect(screen.getByText('○ IDLE')).toBeInTheDocument();
    });

    it('shows "○ IDLE" when worker is initializing', () => {
      renderStatusBar({ workerStatus: 'initializing' });
      expect(screen.getByText('○ IDLE')).toBeInTheDocument();
    });
  });

  describe('Throughput metrics', () => {
    it('displays formatted throughput value with decimal for < 10', () => {
      renderStatusBar({ throughput: 5.5 });
      expect(screen.getByText('5.5')).toBeInTheDocument();
    });

    it('rounds throughput >= 10 to whole number', () => {
      renderStatusBar({ throughput: 10.5 });
      expect(screen.getByText('11')).toBeInTheDocument();
    });

    it('shows "0" for zero throughput', () => {
      renderStatusBar({ throughput: 0 });
      expect(screen.getByText('0')).toBeInTheDocument();
    });

    it('shows "0" for negative throughput', () => {
      renderStatusBar({ throughput: -5 });
      expect(screen.getByText('0')).toBeInTheDocument();
    });

    it('shows "0" for non-finite throughput', () => {
      renderStatusBar({ throughput: Number.POSITIVE_INFINITY });
      expect(screen.getByText('0')).toBeInTheDocument();
    });

    it('displays "jobs/min" label', () => {
      renderStatusBar();
      expect(screen.getByText('jobs/min')).toBeInTheDocument();
    });

    it('renders throughput sparkline', () => {
      renderStatusBar();
      expect(screen.getByRole('img', { name: 'Throughput trend' })).toBeInTheDocument();
    });
  });

  describe('Latency metrics', () => {
    it('displays formatted P50 latency', () => {
      renderStatusBar({ latencyStats: { avgMs: 100, p50Ms: 95, p95Ms: 150 } });
      expect(screen.getByText('95ms')).toBeInTheDocument();
    });

    it('shows "—" for zero latency', () => {
      renderStatusBar({ latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 } });
      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('displays "P50" label', () => {
      renderStatusBar();
      expect(screen.getByText('P50')).toBeInTheDocument();
    });

    it('renders latency sparkline', () => {
      renderStatusBar();
      expect(screen.getByRole('img', { name: 'Latency trend' })).toBeInTheDocument();
    });
  });

  describe('Queue counts', () => {
    it('displays queue count label', () => {
      renderStatusBar();
      expect(screen.getByText('Q:')).toBeInTheDocument();
    });

    it('displays queued and running counts', () => {
      renderStatusBar({ queueCounts: { queued: 5, running: 2, failed: 0, succeeded: 0 } });
      // The format is "Q: 5 / 2"
      expect(screen.getByText('5')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('displays failed count when > 0', () => {
      renderStatusBar({ queueCounts: { queued: 0, running: 0, failed: 3, succeeded: 0 } });
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('does not display failed count when 0', () => {
      const { container } = renderStatusBar({
        queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 10 },
      });
      // Check that there's no destructive (red) text for failed count
      const destructiveText = container.querySelector('.text-destructive');
      expect(destructiveText).toBeNull();
    });

    it('displays succeeded count with checkmark when > 0', () => {
      renderStatusBar({ queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 50 } });
      expect(screen.getByText('✓50')).toBeInTheDocument();
    });

    it('does not display succeeded count when 0', () => {
      renderStatusBar({ queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 } });
      expect(screen.queryByText(/✓/)).not.toBeInTheDocument();
    });
  });

  describe('Sparkline rendering', () => {
    it('handles empty telemetry trend', () => {
      renderStatusBar({ telemetryTrend: [] });
      // Should still render sparklines with default single-point data
      expect(screen.getByRole('img', { name: 'Throughput trend' })).toBeInTheDocument();
      expect(screen.getByRole('img', { name: 'Latency trend' })).toBeInTheDocument();
    });

    it('handles single-point telemetry trend', () => {
      renderStatusBar({
        telemetryTrend: [{ timestamp: Date.now(), throughput: 5, latencyP95: 100, errorCount: 0 }],
      });
      expect(screen.getByRole('img', { name: 'Throughput trend' })).toBeInTheDocument();
    });

    it('handles non-finite values in telemetry trend', () => {
      renderStatusBar({
        telemetryTrend: [
          {
            timestamp: Date.now(),
            throughput: Number.NaN,
            latencyP95: Number.NEGATIVE_INFINITY,
            errorCount: 0,
          },
        ],
      });
      // Should render without errors
      expect(screen.getByRole('img', { name: 'Throughput trend' })).toBeInTheDocument();
    });
  });
});
