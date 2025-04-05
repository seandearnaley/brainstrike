import { render, screen } from '@testing-library/react';
import { FileExplorerStrings } from '../constants/file-explorer-constants';
import { LoadingOverlay } from '../loading-overlay';

describe('LoadingOverlay', () => {
  it('should not render when isLoading is false', () => {
    render(<LoadingOverlay isLoading={false} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('should render with default props when isLoading is true', () => {
    render(<LoadingOverlay isLoading={true} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(FileExplorerStrings.LOADING.REFRESHING)).toBeInTheDocument();
  });

  it('should show root directory loading message for initial load', () => {
    render(<LoadingOverlay isLoading={true} isInitialLoad={true} />);
    expect(screen.getByText(FileExplorerStrings.LOADING.ROOT_DIRECTORY)).toBeInTheDocument();
  });

  it('should show refreshing message for non-initial load', () => {
    render(<LoadingOverlay isLoading={true} isInitialLoad={false} />);
    expect(screen.getByText(FileExplorerStrings.LOADING.REFRESHING)).toBeInTheDocument();
  });

  it('should show custom message when provided', () => {
    const customMessage = 'Custom loading message';
    render(<LoadingOverlay isLoading={true} message={customMessage} />);
    expect(screen.getByText(customMessage)).toBeInTheDocument();
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
    expect(screen.getByText('Processing files (50/100 - 50%)')).toBeInTheDocument();
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
    expect(progressBar.querySelector('div')).toHaveStyle({ transform: 'translateX(-70%)' });
  });

  it('should handle zero progress', () => {
    render(<LoadingOverlay isLoading={true} progressLoaded={0} progressTotal={100} />);
    const progressBar = screen.getByTestId('progress-bar');
    expect(progressBar).toHaveAttribute('data-progress', '0');
    expect(progressBar.querySelector('div')).toHaveStyle({ transform: 'translateX(-100%)' });
  });

  it('should handle undefined progress values', () => {
    render(<LoadingOverlay isLoading={true} />);
    const progressBar = screen.getByTestId('progress-bar');
    expect(progressBar).toHaveAttribute('data-progress', '0');
    expect(progressBar.querySelector('div')).toHaveStyle({ transform: 'translateX(-100%)' });
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
        const message = screen.getByText(
          (content) =>
            content.includes('Processing files (2/10 - 20%)') && content.includes('singlefile')
        );
        expect(message).toBeInTheDocument();
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
        const baseMessage = screen.getByText(/Processing files \(2\/10 - 20%\)/);
        expect(baseMessage).toBeInTheDocument();
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
      // The message is displayed on two lines: progress info and path
      const message = screen.getByText((content) => {
        return content.includes('Processing files (2/10 - 20%)') && content.includes('bar/baz');
      });
      expect(message).toBeInTheDocument();
    });

    it('should handle loaded values exceeding total', () => {
      render(
        <LoadingOverlay
          isLoading={true}
          progressState={{
            loaded: 150,
            total: 100,
            phase: 'loading',
            currentPath: 'some/path',
          }}
        />
      );
      // Expect the text to show 150% in the progress message
      expect(screen.getByText(/Processing files \(150\/100 - 150%\)/)).toBeInTheDocument();

      // Also check the progress bar data attribute
      const progressBar = screen.getByTestId('progress-bar');
      // The code does not clamp, so we expect data-progress="150"
      expect(progressBar).toHaveAttribute('data-progress', '150');
    });
  });
});
