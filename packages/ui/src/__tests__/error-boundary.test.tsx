import { addLogListener, LogLevel } from '@brainstrike/logging';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentPropsWithoutRef } from 'react';
import { afterAll, beforeAll, describe, expect, vi } from 'vitest';
import ErrorBoundary from '../error-boundary';

// Mock Lucide icons - use importOriginal to include all icons from the library
vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lucide-react')>();
  return {
    ...actual,
    AlertTriangle: () => <div data-testid="icon-alert">AlertTriangle</div>,
    ArrowLeft: () => <div data-testid="icon-arrow-left">ArrowLeft</div>,
    Bug: () => <div data-testid="icon-bug">Bug</div>,
    RefreshCw: () => <div data-testid="icon-refresh">RefreshCw</div>,
    X: () => <div data-testid="icon-x">X</div>,
  };
});

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
}));

// Mock utility functions
vi.mock('@brainstrike/utils', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils')>('@brainstrike/utils');
  return {
    ...actual,
    isDevEnv: vi.fn(() => false),
  };
});

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

  test('logs the caught error through the central logger', () => {
    const records: unknown[] = [];
    const unsubscribe = addLogListener((record) => records.push(record));

    render(
      <ErrorBoundary>
        <ErrorThrowingComponent error={new Error('Test error')} />
      </ErrorBoundary>
    );

    expect(
      records.some(
        (record) =>
          (record as { level: LogLevel; scope?: string }).level === LogLevel.ERROR &&
          (record as { scope?: string }).scope === 'ErrorBoundary'
      )
    ).toBe(true);
    unsubscribe();
  });
});
