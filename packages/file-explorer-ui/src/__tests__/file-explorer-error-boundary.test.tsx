import { ConcurrentLoadingError, FileContentError, PartialRefreshError } from '@brainstrike/types';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentPropsWithoutRef } from 'react';
import { describe, expect, vi } from 'vitest';
import FileExplorerErrorBoundary from '../file-explorer-error-boundary';

// Mock icons
vi.mock('lucide-react', () => ({
  AlertTriangle: () => <div data-testid="icon-alert">AlertTriangle</div>,
  ArrowLeft: () => <div data-testid="icon-arrow-left">ArrowLeft</div>,
  Bug: () => <div data-testid="icon-bug">Bug</div>,
  FileWarning: () => <div data-testid="icon-file-warning">FileWarning</div>,
  RefreshCw: () => <div data-testid="icon-refresh">RefreshCw</div>,
  Server: () => <div data-testid="icon-server">Server</div>,
  X: () => <div data-testid="icon-x">X</div>,
}));

// Mock Button component from @brainstrike/ui
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...mod,
    Button: ({
      children,
      onClick,
      variant,
      className,
      size,
      title,
      ...rest
    }: ComponentPropsWithoutRef<'button'> & { variant?: string; size?: string }) => (
      <button
        onClick={onClick}
        data-variant={variant}
        className={className}
        data-size={size}
        title={title}
        type="button"
        {...rest}
      >
        {children}
      </button>
    ),
  };
});

describe('FileExplorerErrorBoundary', () => {
  beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  const ErrorThrowingComponent = ({ error }: { error: Error }) => {
    throw error;
  };

  test('renders specialized UI for FileContentError', () => {
    const errorMessage = 'File is too large';
    const filePath = '/path/to/large/file.txt';
    render(
      <FileExplorerErrorBoundary>
        <ErrorThrowingComponent error={new FileContentError(errorMessage, filePath, 'TOO_LARGE')} />
      </FileExplorerErrorBoundary>
    );
    expect(screen.getByText('File Content Error')).toBeInTheDocument();
    expect(screen.getByText('Retry Loading')).toBeInTheDocument();
    expect(screen.getByText('Skip File')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Failed to load file '${filePath}'`))).toBeInTheDocument();
  });

  test('renders specialized UI for ConcurrentLoadingError', () => {
    const errorMessage = 'Too many concurrent operations';
    const failedPaths = ['/path/to/file1.txt', '/path/to/file2.txt'];
    render(
      <FileExplorerErrorBoundary>
        <ErrorThrowingComponent error={new ConcurrentLoadingError(errorMessage, failedPaths)} />
      </FileExplorerErrorBoundary>
    );
    expect(screen.getByText('Loading Error')).toBeInTheDocument();
    expect(screen.getByText('Retry with Fewer Concurrent Operations')).toBeInTheDocument();
    expect(screen.getByText(/Failed to load 2 files/)).toBeInTheDocument();
  });

  test('renders specialized UI for PartialRefreshError', () => {
    const errorMessage = 'Some operations failed';
    const successCount = 5;
    const failCount = 3;
    render(
      <FileExplorerErrorBoundary>
        <ErrorThrowingComponent
          error={new PartialRefreshError(errorMessage, successCount, failCount)}
        />
      </FileExplorerErrorBoundary>
    );
    expect(screen.getByText('Partial Refresh Error')).toBeInTheDocument();
    expect(screen.getByText('Retry Failed Operations')).toBeInTheDocument();
    expect(screen.getByText(/Refresh partially failed: 5 succeeded, 3 failed/)).toBeInTheDocument();
  });

  test('toggles error details visibility', () => {
    render(
      <FileExplorerErrorBoundary showDetails={true}>
        <ErrorThrowingComponent error={new Error('Toggle error')} />
      </FileExplorerErrorBoundary>
    );

    const toggleButton = screen.getByRole('button', { name: /show details/i });
    expect(screen.queryByText('Error Details')).not.toBeInTheDocument();

    fireEvent.click(toggleButton);
    expect(screen.getByText('Error Details')).toBeInTheDocument();
    expect(toggleButton.textContent).toMatch(/hide details/i);

    fireEvent.click(toggleButton);
    expect(screen.queryByText('Error Details')).not.toBeInTheDocument();
    expect(toggleButton.textContent).toMatch(/show details/i);
  });

  test('copies error details to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // @ts-expect-error - allow assigning clipboard for test
    navigator.clipboard = { writeText };
    const alertSpy = vi.fn();
    window.alert = alertSpy as unknown as typeof window.alert;

    render(
      <FileExplorerErrorBoundary showDetails={true}>
        <ErrorThrowingComponent error={new Error('Copy error')} />
      </FileExplorerErrorBoundary>
    );

    fireEvent.click(screen.getByText('Copy Details'));
    // wait for promise resolution
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith('Error details copied to clipboard');
  });

  test('renders generic error message for unknown error', () => {
    render(
      <FileExplorerErrorBoundary>
        <ErrorThrowingComponent error={new Error('Unknown')} />
      </FileExplorerErrorBoundary>
    );
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });
});
