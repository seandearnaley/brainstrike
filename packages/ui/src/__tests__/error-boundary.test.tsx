import {
  ConcurrentLoadingError,
  FSInitializationError,
  FileContentError,
  GitOperationError,
  PartialRefreshError,
} from '@brainstrike/types';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentPropsWithoutRef } from 'react';
import { describe, expect, vi } from 'vitest';
import ErrorBoundary from '../error-boundary';

// Mock Lucide icons
vi.mock('lucide-react', () => ({
  AlertTriangle: () => <div data-testid="icon-alert">AlertTriangle</div>,
  ArrowLeft: () => <div data-testid="icon-arrow-left">ArrowLeft</div>,
  Bug: () => <div data-testid="icon-bug">Bug</div>,
  FileWarning: () => <div data-testid="icon-file-warning">FileWarning</div>,
  FolderOpen: () => <div data-testid="icon-folder-open">FolderOpen</div>,
  GitBranch: () => <div data-testid="icon-git-branch">GitBranch</div>,
  RefreshCw: () => <div data-testid="icon-refresh">RefreshCw</div>,
  Server: () => <div data-testid="icon-server">Server</div>,
  X: () => <div data-testid="icon-x">X</div>,
}));

// Mock UI components
vi.mock('../button', () => ({
  Button: ({
    children,
    onClick,
    variant,
    className,
    size,
    title,
    ...rest
  }: ComponentPropsWithoutRef<'button'> & {
    variant?: string;
    size?: string;
  }) => (
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
}));

// Mock utility functions
vi.mock('../lib/utils', () => ({
  cn: (...args: (string | boolean | undefined)[]) => args.filter(Boolean).join(' '),
  isDevEnv: () => true,
}));

// Mock component that throws an error
const ErrorThrowingComponent = ({ error }: { error: Error }) => {
  throw error;
};

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  test('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <div data-testid="child">Child Content</div>
      </ErrorBoundary>
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  test('renders error UI when an error occurs', () => {
    const errorMessage = 'Test error message';
    render(
      <ErrorBoundary>
        <ErrorThrowingComponent error={new Error(errorMessage)} />
      </ErrorBoundary>
    );
    expect(screen.getByText(errorMessage)).toBeInTheDocument();
    expect(screen.getByText('Reload Page')).toBeInTheDocument();
  });

  test('renders specialized UI for FSInitializationError', () => {
    const errorMessage = 'Permission denied';
    render(
      <ErrorBoundary>
        <ErrorThrowingComponent
          error={new FSInitializationError(errorMessage, 'PERMISSION_DENIED')}
        />
      </ErrorBoundary>
    );
    expect(screen.getByText('File System Error')).toBeInTheDocument();
    expect(screen.getByText('Request Permissions Again')).toBeInTheDocument();
    expect(
      screen.getByText(/Failed to initialize file system: Permission denied/)
    ).toBeInTheDocument();
  });

  test('renders specialized UI for FileContentError', () => {
    const errorMessage = 'File is too large';
    const filePath = '/path/to/large/file.txt';
    render(
      <ErrorBoundary>
        <ErrorThrowingComponent error={new FileContentError(errorMessage, filePath, 'TOO_LARGE')} />
      </ErrorBoundary>
    );
    expect(screen.getByText('File Content Error')).toBeInTheDocument();
    expect(screen.getByText('Retry Loading')).toBeInTheDocument();
    expect(screen.getByText('Skip File')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Failed to load file '${filePath}'`))).toBeInTheDocument();
  });

  test('renders specialized UI for GitOperationError', () => {
    const errorMessage = 'Failed to pull from remote';
    const operation = 'pull';
    render(
      <ErrorBoundary>
        <ErrorThrowingComponent error={new GitOperationError(errorMessage, operation)} />
      </ErrorBoundary>
    );
    expect(screen.getByText('Git Operation Error')).toBeInTheDocument();
    expect(screen.getByText('Retry Git Operation')).toBeInTheDocument();
    expect(screen.getByText(/Git operation 'pull' failed/)).toBeInTheDocument();
  });

  test('calls onReset when reset button is clicked', () => {
    const onReset = vi.fn();
    render(
      <ErrorBoundary onReset={onReset}>
        <ErrorThrowingComponent error={new Error('Test error')} />
      </ErrorBoundary>
    );
    fireEvent.click(screen.getByText('Go Back'));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  test('shows error details when Show Details button is clicked', () => {
    render(
      <ErrorBoundary showDetails={true}>
        <ErrorThrowingComponent error={new Error('Test error')} />
      </ErrorBoundary>
    );
    const showDetailsButton = screen.queryByText('Show Details');
    expect(showDetailsButton).toBeInTheDocument();
    if (showDetailsButton) {
      fireEvent.click(showDetailsButton);
    }
    expect(screen.getByText('Error Details')).toBeInTheDocument();
    expect(screen.getByText('Name:')).toBeInTheDocument();
    expect(screen.getByText('Message:')).toBeInTheDocument();
  });

  test('uses custom fallback when provided', () => {
    const customFallback = <div data-testid="custom-fallback">Custom Fallback UI</div>;
    render(
      <ErrorBoundary fallback={customFallback}>
        <ErrorThrowingComponent error={new Error('Test error')} />
      </ErrorBoundary>
    );
    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
    expect(screen.queryByText('Reload Page')).not.toBeInTheDocument();
  });

  test('renders specialized UI for ConcurrentLoadingError', () => {
    const errorMessage = 'Too many concurrent operations';
    const failedPaths = ['/path/to/file1.txt', '/path/to/file2.txt'];
    render(
      <ErrorBoundary>
        <ErrorThrowingComponent error={new ConcurrentLoadingError(errorMessage, failedPaths)} />
      </ErrorBoundary>
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
      <ErrorBoundary>
        <ErrorThrowingComponent
          error={new PartialRefreshError(errorMessage, successCount, failCount)}
        />
      </ErrorBoundary>
    );
    expect(screen.getByText('Partial Refresh Error')).toBeInTheDocument();
    expect(screen.getByText('Retry Failed Operations')).toBeInTheDocument();
    expect(screen.getByText(/Refresh partially failed: 5 succeeded, 3 failed/)).toBeInTheDocument();
  });
});
