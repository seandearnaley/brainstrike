import { ConcurrentLoadingError, FileContentError, PartialRefreshError } from '@brainstrike/types';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentPropsWithoutRef } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import FileExplorerErrorBoundary from '../file-explorer-error-boundary';

const mockToast = vi.fn();

// Mock icons - use importOriginal to include all icons transitively imported by @brainstrike/ui
vi.mock('lucide-react', async (importOriginal) => {
  const original = await importOriginal<typeof import('lucide-react')>();
  return {
    ...original,
    AlertTriangle: () => <div data-testid="icon-alert">AlertTriangle</div>,
    ArrowLeft: () => <div data-testid="icon-arrow-left">ArrowLeft</div>,
    Bug: () => <div data-testid="icon-bug">Bug</div>,
    FileWarning: () => <div data-testid="icon-file-warning">FileWarning</div>,
    RefreshCw: () => <div data-testid="icon-refresh">RefreshCw</div>,
    Server: () => <div data-testid="icon-server">Server</div>,
    X: () => <div data-testid="icon-x">X</div>,
  };
});

// Mock Button component and useToast from @brainstrike/ui
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
        className={className}
        data-size={size}
        data-variant={variant}
        onClick={onClick}
        title={title}
        type="button"
        {...rest}
      >
        {children}
      </button>
    ),
    useToast: () => ({ toast: mockToast }),
  };
});

describe('FileExplorerErrorBoundary', () => {
  const suppressConsoleNoise = () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    return () => {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    };
  };

  beforeEach(() => {
    mockToast.mockClear();
  });

  const ErrorThrowingComponent = ({ error }: { error: Error }) => {
    throw error;
  };

  test('renders specialized UI for FileContentError', () => {
    const errorMessage = 'File is too large';
    const filePath = '/path/to/large/file.txt';
    const restoreConsole = suppressConsoleNoise();
    try {
      render(
        <FileExplorerErrorBoundary>
          <ErrorThrowingComponent
            error={new FileContentError(errorMessage, filePath, 'TOO_LARGE')}
          />
        </FileExplorerErrorBoundary>
      );
    } finally {
      restoreConsole();
    }
    expect(screen.getByText('File Content Error')).toBeInTheDocument();
    expect(screen.getByText('Retry Loading')).toBeInTheDocument();
    expect(screen.getByText('Skip File')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Failed to load file '${filePath}'`))).toBeInTheDocument();
  });

  test('renders specialized UI for ConcurrentLoadingError', () => {
    const errorMessage = 'Too many concurrent operations';
    const failedPaths = ['/path/to/file1.txt', '/path/to/file2.txt'];
    const restoreConsole = suppressConsoleNoise();
    try {
      render(
        <FileExplorerErrorBoundary>
          <ErrorThrowingComponent error={new ConcurrentLoadingError(errorMessage, failedPaths)} />
        </FileExplorerErrorBoundary>
      );
    } finally {
      restoreConsole();
    }
    expect(screen.getByText('Loading Error')).toBeInTheDocument();
    expect(screen.getByText('Retry with Fewer Concurrent Operations')).toBeInTheDocument();
    expect(screen.getByText(/Failed to load 2 files/)).toBeInTheDocument();
  });

  test('renders specialized UI for PartialRefreshError', () => {
    const errorMessage = 'Some operations failed';
    const successCount = 5;
    const failCount = 3;
    const restoreConsole = suppressConsoleNoise();
    try {
      render(
        <FileExplorerErrorBoundary>
          <ErrorThrowingComponent
            error={new PartialRefreshError(errorMessage, successCount, failCount)}
          />
        </FileExplorerErrorBoundary>
      );
    } finally {
      restoreConsole();
    }
    expect(screen.getByText('Partial Refresh Error')).toBeInTheDocument();
    expect(screen.getByText('Retry Failed Operations')).toBeInTheDocument();
    expect(screen.getByText(/Refresh partially failed: 5 succeeded, 3 failed/)).toBeInTheDocument();
  });

  test('toggles error details visibility', () => {
    const restoreConsole = suppressConsoleNoise();
    try {
      render(
        <FileExplorerErrorBoundary showDetails={true}>
          <ErrorThrowingComponent error={new Error('Toggle error')} />
        </FileExplorerErrorBoundary>
      );
    } finally {
      restoreConsole();
    }

    const toggleButton = screen.getByRole('button', { name: /show details/i });
    expect(screen.queryByText('Error Details')).not.toBeInTheDocument();

    act(() => {
      fireEvent.click(toggleButton);
    });
    expect(screen.getByText('Error Details')).toBeInTheDocument();
    expect(toggleButton.textContent).toMatch(/hide details/i);

    act(() => {
      fireEvent.click(toggleButton);
    });
    expect(screen.queryByText('Error Details')).not.toBeInTheDocument();
    expect(toggleButton.textContent).toMatch(/show details/i);
  });

  test('copies error details to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // @ts-expect-error - allow assigning clipboard for test
    navigator.clipboard = { writeText };

    const restoreConsole = suppressConsoleNoise();
    try {
      render(
        <FileExplorerErrorBoundary showDetails={true}>
          <ErrorThrowingComponent error={new Error('Copy error')} />
        </FileExplorerErrorBoundary>
      );
    } finally {
      restoreConsole();
    }

    await act(async () => {
      fireEvent.click(screen.getByText('Copy Details'));
      await Promise.resolve();
    });
    // synchronous assertion after act

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith({
      description: 'Error details copied to clipboard',
      title: 'Success',
    });
  });

  test('handles clipboard error in handleCopyErrorDetails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard error'));
    // @ts-expect-error - allow assigning clipboard for test
    navigator.clipboard = { writeText };

    const restoreConsole = suppressConsoleNoise();
    try {
      render(
        <FileExplorerErrorBoundary showDetails={true}>
          <ErrorThrowingComponent error={new Error('Copy error')} />
        </FileExplorerErrorBoundary>
      );

      await act(async () => {
        fireEvent.click(screen.getByText('Copy Details'));
        await Promise.resolve();
      });
    } finally {
      restoreConsole();
    }

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(mockToast).not.toHaveBeenCalledWith({
      description: 'Error details copied to clipboard',
      title: 'Success',
    });
  });

  test('renders generic error message for unknown error', () => {
    const restoreConsole = suppressConsoleNoise();
    try {
      render(
        <FileExplorerErrorBoundary>
          <ErrorThrowingComponent error={new Error('Unknown')} />
        </FileExplorerErrorBoundary>
      );
    } finally {
      restoreConsole();
    }
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });
});
/**
 * @vitest-environment jsdom
 */
