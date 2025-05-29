import { FileExplorerStrings } from '@brainstrike/types';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoadingOverlay } from '../loading-overlay';

describe('LoadingOverlay', () => {
  it('should not render when isLoading is false', () => {
    render(<LoadingOverlay isLoading={false} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('should render with default props when isLoading is true', () => {
    render(<LoadingOverlay isLoading={true} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(FileExplorerStrings.loading.refreshing)).toBeInTheDocument();
  });

  it('should show root directory loading message for initial load', () => {
    render(<LoadingOverlay isLoading={true} isInitialLoad={true} />);
    expect(screen.getByText(FileExplorerStrings.loading.rootDirectory)).toBeInTheDocument();
  });

  it('should show refreshing message for non-initial load', () => {
    render(<LoadingOverlay isLoading={true} isInitialLoad={false} />);
    expect(screen.getByText(FileExplorerStrings.loading.refreshing)).toBeInTheDocument();
  });

  it('should show custom message when provided', () => {
    const customMessage = 'Custom loading message';
    render(<LoadingOverlay isLoading={true} message={customMessage} />);
    expect(screen.getByText(customMessage)).toBeInTheDocument();
  });

  it('should call onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<LoadingOverlay isLoading={true} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('should show cancelling message when isCancelling is true', () => {
    render(<LoadingOverlay isLoading={true} onCancel={() => {}} isCancelling />);
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Cancelling.../i)).toBeInTheDocument();
  });

  it('should show progress when provided', () => {
    render(
      <LoadingOverlay
        isLoading={true}
        progressState={{
          loaded: 50,
          total: 100,
          phase: 'loading',
        }}
      />
    );
    expect(screen.getByText(/Processing files \(50\/100 - 50%\)/)).toBeInTheDocument();
  });

  it('should show scanning message during counting phase', () => {
    render(
      <LoadingOverlay
        isLoading={true}
        progressState={{
          loaded: 0,
          total: 0,
          phase: 'counting',
        }}
      />
    );
    expect(screen.getByText('Scanning directory structure...')).toBeInTheDocument();
  });

  it('should render progress bar with correct percentage', () => {
    render(<LoadingOverlay isLoading={true} progressLoaded={30} progressTotal={100} />);
    const progressBar = screen.getByTestId('progress-bar');
    expect(progressBar).toHaveAttribute('data-progress', '30');
    expect(progressBar.querySelector('div')).toHaveStyle({
      transform: 'translateX(-70%)',
    });
  });

  it('should handle zero progress', () => {
    render(<LoadingOverlay isLoading={true} progressLoaded={0} progressTotal={100} />);
    const progressBar = screen.getByTestId('progress-bar');
    expect(progressBar).toHaveAttribute('data-progress', '0');
    expect(progressBar.querySelector('div')).toHaveStyle({
      transform: 'translateX(-100%)',
    });
  });

  it('should handle undefined progress values', () => {
    render(<LoadingOverlay isLoading={true} />);
    const progressBar = screen.getByTestId('progress-bar');
    expect(progressBar).toHaveAttribute('data-progress', '0');
    expect(progressBar.querySelector('div')).toHaveStyle({
      transform: 'translateX(-100%)',
    });
  });

  describe('className handling', () => {
    it('should merge custom className with default classes', () => {
      const { container } = render(<LoadingOverlay isLoading={true} className="custom-class" />);
      expect(container.firstChild).toHaveClass('custom-class');
      expect(container.firstChild).toHaveClass('fixed');
      expect(container.firstChild).toHaveClass('inset-0');
    });

    it('should handle undefined className', () => {
      const { container } = render(<LoadingOverlay isLoading={true} className={undefined} />);
      expect(container.firstChild).toHaveClass('fixed');
      expect(container.firstChild).toHaveClass('inset-0');
    });

    describe('Even more edge cases', () => {
      it('should display the single-segment path in full', () => {
        render(
          <LoadingOverlay
            isLoading={true}
            progressState={{
              loaded: 2,
              total: 10,
              phase: 'loading',
              currentPath: 'singlefile',
            }}
          />
        );
        // We expect "Processing files (2/10 - 20%)" and "singlefile"
        expect(screen.getByText(/Processing files \(2\/10 - 20%\)/)).toBeInTheDocument();
        expect(screen.getByText(/singlefile/)).toBeInTheDocument();
      });

      it('should handle empty currentPath by showing base progress message only', () => {
        render(
          <LoadingOverlay
            isLoading={true}
            progressState={{
              loaded: 2,
              total: 10,
              phase: 'loading',
              currentPath: '', // No path
            }}
          />
        );
        // Should only see the base message with no path appended
        expect(screen.getByText(/Processing files \(2\/10 - 20%\)/)).toBeInTheDocument();
        // We do NOT expect any path appended
        expect(screen.queryByText('.../')).not.toBeInTheDocument();
      });

      it('should show "Preparing..." when total=0 and phase=loading', () => {
        render(
          <LoadingOverlay
            isLoading={true}
            progressState={{
              loaded: 0,
              total: 0,
              phase: 'loading',
            }}
          />
        );
        expect(screen.getByText('Preparing...')).toBeInTheDocument();
      });

      it('should handle counting phase explicitly', () => {
        render(
          <LoadingOverlay
            isLoading={true}
            progressState={{
              loaded: 0,
              total: 0,
              phase: 'counting',
            }}
          />
        );
        // "Scanning directory structure..."
        expect(screen.getByText('Scanning directory structure...')).toBeInTheDocument();
        // The description says "This may take a moment for large directories"
        expect(
          screen.getByText('This may take a moment for large directories')
        ).toBeInTheDocument();
      });
    });
  });

  describe('Progress meter calculation tests', () => {
    it('should handle progress beyond initial estimate correctly', () => {
      render(
        <LoadingOverlay
          isLoading={true}
          progressState={{
            loaded: 150,
            total: 100, // This should not happen with the new logic, but testing edge case
            phase: 'loading',
          }}
        />
      );
      // Should still display the numbers correctly even if they exceed 100%
      expect(screen.getByText(/Processing files \(150\/100 - 150%\)/)).toBeInTheDocument();
    });

    it('should handle very large file counts', () => {
      render(
        <LoadingOverlay
          isLoading={true}
          progressState={{
            loaded: 3168,
            total: 5000,
            phase: 'loading',
          }}
        />
      );
      // Should display correct percentage calculation
      expect(screen.getByText(/Processing files \(3168\/5000 - 63%\)/)).toBeInTheDocument();
    });

    it('should handle zero total gracefully', () => {
      render(
        <LoadingOverlay
          isLoading={true}
          progressState={{
            loaded: 5,
            total: 0,
            phase: 'loading',
          }}
        />
      );
      // Should show "Preparing..." when total is 0
      expect(screen.getByText('Preparing...')).toBeInTheDocument();
    });

    it('should calculate percentage correctly for edge cases', () => {
      render(
        <LoadingOverlay
          isLoading={true}
          progressState={{
            loaded: 99,
            total: 100,
            phase: 'loading',
          }}
        />
      );
      // Should display 99%
      expect(screen.getByText(/Processing files \(99\/100 - 99%\)/)).toBeInTheDocument();
    });

    it('should handle exact completion correctly', () => {
      render(
        <LoadingOverlay
          isLoading={true}
          progressState={{
            loaded: 1000,
            total: 1000,
            phase: 'loading',
          }}
        />
      );
      // Should display 100%
      expect(screen.getByText(/Processing files \(1000\/1000 - 100%\)/)).toBeInTheDocument();
    });
  });

  describe('Additional coverage for new features', () => {
    it('should display last 2 path segments in progress message if path has multiple segments', () => {
      render(
        <LoadingOverlay
          isLoading={true}
          progressState={{
            loaded: 2,
            total: 10,
            phase: 'loading',
            currentPath: 'foo/bar/baz/qux',
          }}
        />
      );
      // The base message is "Processing files (2/10 - 20%)"
      // Expect it to show ".../baz/qux" on a new line
      expect(screen.getByText(/Processing files \(2\/10 - 20%\)/)).toBeInTheDocument();
      expect(screen.getByText(/\.\.\.\/baz\/qux/)).toBeInTheDocument();
    });

    it('should not truncate path if it has two or fewer segments', () => {
      render(
        <LoadingOverlay
          isLoading={true}
          progressState={{
            loaded: 2,
            total: 10,
            phase: 'loading',
            currentPath: 'bar/baz',
          }}
        />
      );
      // The base message is "Processing files (2/10 - 20%)"
      // Expect it to show "bar/baz" on a new line without truncation
      expect(screen.getByText(/Processing files \(2\/10 - 20%\)/)).toBeInTheDocument();
      expect(screen.getByText(/bar\/baz/)).toBeInTheDocument();
    });
  });

  describe('Progress bar percentage calculations', () => {
    it('should set progress bar to 0% during counting phase', () => {
      render(
        <LoadingOverlay
          isLoading={true}
          progressState={{
            loaded: 10,
            total: 100,
            phase: 'counting',
          }}
        />
      );
      const progressBar = screen.getByTestId('progress-bar');
      expect(progressBar).toHaveAttribute('data-progress', '0');
    });

    it('should calculate correct percentage for progressState', () => {
      render(
        <LoadingOverlay
          isLoading={true}
          progressState={{
            loaded: 75,
            total: 300,
            phase: 'loading',
          }}
        />
      );
      const progressBar = screen.getByTestId('progress-bar');
      expect(progressBar).toHaveAttribute('data-progress', '25'); // 75/300 = 25%
    });

    it('should fall back to progressLoaded/progressTotal when progressState is not provided', () => {
      render(<LoadingOverlay isLoading={true} progressLoaded={40} progressTotal={200} />);
      const progressBar = screen.getByTestId('progress-bar');
      expect(progressBar).toHaveAttribute('data-progress', '20'); // 40/200 = 20%
    });

    it('should handle division by zero in progress calculation', () => {
      render(
        <LoadingOverlay
          isLoading={true}
          progressState={{
            loaded: 50,
            total: 0,
            phase: 'loading',
          }}
        />
      );
      const progressBar = screen.getByTestId('progress-bar');
      expect(progressBar).toHaveAttribute('data-progress', '0');
    });
  });
});
