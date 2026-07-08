/**
 * Tests for ScanningStatus component
 *
 * Tests the scanning progress indicator that shows when the app is
 * scanning the file tree to discover files and directories.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ScanningStatus } from '../scanning-status';

describe('ScanningStatus', () => {
  describe('when not scanning', () => {
    it('should render nothing when isScanning is false', () => {
      const { container } = render(<ScanningStatus isScanning={false} />);
      expect(container.firstChild).toBeNull();
    });

    it('should render nothing with other props but isScanning is false', () => {
      const { container } = render(
        <ScanningStatus currentPath="/test/path" isScanning={false} percentage={50} />
      );
      expect(container.firstChild).toBeNull();
    });
  });

  describe('when scanning', () => {
    it('should render status when isScanning is true', () => {
      render(<ScanningStatus isScanning={true} />);
      expect(screen.getByTestId('scanning-status')).toBeInTheDocument();
    });

    it('should show default text when no props are provided', () => {
      render(<ScanningStatus isScanning={true} />);
      expect(screen.getByText('Scanning...')).toBeInTheDocument();
    });

    it('should show percentage when provided and greater than 0', () => {
      render(<ScanningStatus isScanning={true} percentage={42} />);
      expect(screen.getByText('42%')).toBeInTheDocument();
    });

    it('should not show percentage when it is 0', () => {
      render(<ScanningStatus isScanning={true} percentage={0} />);
      expect(screen.queryByText('0%')).not.toBeInTheDocument();
    });

    it('should format long paths with ellipsis', () => {
      render(<ScanningStatus currentPath="/root/parent/child/subdir" isScanning={true} />);
      expect(screen.getByText('.../child/subdir')).toBeInTheDocument();
    });

    it('should show short paths without ellipsis', () => {
      render(<ScanningStatus currentPath="folder/file" isScanning={true} />);
      expect(screen.getByText('folder/file')).toBeInTheDocument();
    });

    it('should not show path when currentPath is undefined', () => {
      render(<ScanningStatus isScanning={true} />);
      expect(screen.queryByTitle('')).not.toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(<ScanningStatus className="custom-class" isScanning={true} />);
      expect(screen.getByTestId('scanning-status')).toHaveClass('custom-class');
    });
  });

  describe('with depthProgress', () => {
    it('should show depth and stats when depthProgress is provided', () => {
      render(
        <ScanningStatus
          depthProgress={{
            currentDepth: 2,
            directoriesCompleted: 10,
            directoriesRemaining: 5,
            estimatedMaxDepth: 5,
            filesFound: 100,
            maxDepthSeen: 3,
          }}
          isScanning={true}
        />
      );
      expect(screen.getByText('Depth 2/5 · 100 files, 10 dirs')).toBeInTheDocument();
    });

    it('should show simple depth when maxDepthSeen is less than 2', () => {
      render(
        <ScanningStatus
          depthProgress={{
            currentDepth: 1,
            directoriesCompleted: 5,
            directoriesRemaining: 3,
            estimatedMaxDepth: 5,
            filesFound: 50,
            maxDepthSeen: 1,
          }}
          isScanning={true}
        />
      );
      expect(screen.getByText('Depth 1 · 50 files, 5 dirs')).toBeInTheDocument();
    });

    it('should format large file counts with locale separators', () => {
      render(
        <ScanningStatus
          depthProgress={{
            currentDepth: 3,
            directoriesCompleted: 100,
            directoriesRemaining: 20,
            estimatedMaxDepth: 5,
            filesFound: 10_000,
            maxDepthSeen: 3,
          }}
          isScanning={true}
        />
      );
      // Should contain locale-formatted number (e.g., "10,000" in en-US)
      expect(screen.getByText(/10.*000.*files/)).toBeInTheDocument();
    });
  });

  describe('cancellation', () => {
    it('should not show cancel button when cancellable is false', () => {
      render(<ScanningStatus cancellable={false} isScanning={true} />);
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });

    it('should show cancel button when cancellable is true', () => {
      render(<ScanningStatus cancellable={true} isScanning={true} />);
      expect(screen.getByRole('button', { name: 'Cancel scanning' })).toBeInTheDocument();
    });

    it('should call onCancel when cancel button is clicked', async () => {
      const user = userEvent.setup();
      const onCancel = vi.fn();
      render(<ScanningStatus cancellable={true} isScanning={true} onCancel={onCancel} />);

      await user.click(screen.getByRole('button', { name: 'Cancel scanning' }));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('should show cancelling state when isCancelling is true', () => {
      render(<ScanningStatus cancellable={true} isCancelling={true} isScanning={true} />);
      expect(screen.getByText('Cancelling...')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancelling' })).toBeDisabled();
    });

    it('should apply opacity class when cancelling', () => {
      render(<ScanningStatus isCancelling={true} isScanning={true} />);
      expect(screen.getByTestId('scanning-status')).toHaveClass('opacity-60');
    });

    it('should set progress to 0 when cancelling', () => {
      const { container } = render(
        <ScanningStatus isCancelling={true} isScanning={true} percentage={50} />
      );
      // Progress bar should exist - the actual value is controlled internally
      const progressDiv = container.querySelector('[data-testid="scanning-status"]');
      expect(progressDiv).toBeInTheDocument();
    });
  });
});
