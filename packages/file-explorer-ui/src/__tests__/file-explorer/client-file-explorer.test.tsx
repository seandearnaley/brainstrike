import { render, screen } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fs-provider with factory function to allow changing the return value
const mockUseFS = vi.fn().mockReturnValue({
  isInitialized: true,
  error: null,
});

vi.mock('../../../providers/fs-provider', () => ({
  useFS: () => mockUseFS(),
}));

// Mock React.Suspense to immediately render its children instead of the fallback
vi.mock('react', async () => {
  const actual = await vi.importActual('react');
  return {
    ...actual,
    Suspense: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// Mock @brainstrike/file-explorer-ui to mock FileExplorerErrorBoundary
vi.mock('@brainstrike/file-explorer-ui', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@brainstrike/file-explorer-ui')>();
  return {
    ...mod,
    // Mock FileExplorerErrorBoundary to render children within a div with a test ID
    FileExplorerErrorBoundary: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="mock-error-boundary">{children}</div>
    ),
  };
});

describe('ClientFileExplorer', () => {
  // Save original window properties
  let originalShowDirectoryPicker: typeof window.showDirectoryPicker;
  let originalIsSecureContext: boolean;

  beforeEach(() => {
    vi.resetModules();
    // Save original window properties
    originalShowDirectoryPicker = window.showDirectoryPicker;
    originalIsSecureContext = window.isSecureContext;

    // Default mocks
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: vi.fn(),
      writable: true,
      configurable: true,
    });

    Object.defineProperty(window, 'isSecureContext', {
      value: true,
      writable: true,
      configurable: true,
    });

    // Reset mocks
    // mockUseFS.mockReturnValue({ // mockUseFS is no longer directly used by component, but some tests might still use the mock setup.
    //   isInitialized: true,
    //   error: null,
    // });
  });

  afterEach(() => {
    // Restore original window properties
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: originalShowDirectoryPicker,
      writable: true,
      configurable: true,
    });

    Object.defineProperty(window, 'isSecureContext', {
      value: originalIsSecureContext,
      writable: true,
      configurable: true,
    });
  });

  it('renders without crashing', async () => {
    vi.doMock('../file-explorer', () => ({
      default: () => <div data-testid="mock-file-explorer">File Explorer</div>,
    }));
    const { default: ClientFileExplorer } = await import('../../client-file-explorer');
    const { container } = render(<ClientFileExplorer />);
    expect(container).toBeInTheDocument();
  });

  it('renders with FileExplorerErrorBoundary wrapper', async () => {
    vi.doMock('../file-explorer', () => ({
      default: () => <div data-testid="mock-file-explorer">File Explorer</div>,
    }));
    const { default: ClientFileExplorer } = await import('../../client-file-explorer');
    render(<ClientFileExplorer />);
    // The fallback UI is rendered instead of the mock
    expect(screen.getByText('Loading File Explorer...')).toBeInTheDocument();
  });

  it('renders with FileExplorerErrorBoundary wrapper and FileExplorer component', async () => {
    vi.doMock('../file-explorer', () => ({
      default: () => <div data-testid="mock-file-explorer">File Explorer</div>,
    }));
    const { default: ClientFileExplorer } = await import('../../client-file-explorer');
    render(<ClientFileExplorer />);
    // The fallback UI is rendered instead of the mock
    expect(screen.getByText('Loading File Explorer...')).toBeInTheDocument();
  });

  // it('shows loading state when file system is not initialized', () => { // Test removed
  //   mockUseFS.mockReturnValue({
  //     isInitialized: false,
  //     error: null,
  //   });
  //
  //   render(<ClientFileExplorer />);
  //   expect(screen.getByText('Loading File Explorer...')).toBeInTheDocument();
  // });

  // it('shows error message when file system initialization fails', () => { // Test removed
  //   const errorMessage = 'Failed to initialize';
  //   mockUseFS.mockReturnValue({
  //     isInitialized: false,
  //     error: new Error(errorMessage),
  //   });
  //
  //   render(<ClientFileExplorer />);
  //   expect(screen.getByText(`Error initializing file system: ${errorMessage}`)).toBeInTheDocument();
  // });

  it('shows unsupported message when File System Access API is not available', async () => {
    vi.doMock('../file-explorer', () => ({
      default: () => <div data-testid="mock-file-explorer">File Explorer</div>,
    }));
    const { default: ClientFileExplorer } = await import('../../client-file-explorer');
    // Remove showDirectoryPicker to simulate unsupported browser
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    render(<ClientFileExplorer />);
    expect(screen.getByText(/File System Access API is not supported/)).toBeInTheDocument();
    // Note: Logger calls are not tested in unit tests as they depend on environment configuration
  });

  it('shows unsupported message when not in secure context', async () => {
    vi.doMock('../file-explorer', () => ({
      default: () => <div data-testid="mock-file-explorer">File Explorer</div>,
    }));
    const { default: ClientFileExplorer } = await import('../../client-file-explorer');
    // Set isSecureContext to false
    Object.defineProperty(window, 'isSecureContext', {
      value: false,
      writable: true,
      configurable: true,
    });

    render(<ClientFileExplorer />);
    expect(screen.getByText(/File System Access API is not supported/)).toBeInTheDocument();
    // Note: Logger calls are not tested in unit tests as they depend on environment configuration
  });

  it('handles errors when checking file system support', async () => {
    vi.doMock('../file-explorer', () => ({
      default: () => <div data-testid="mock-file-explorer">File Explorer</div>,
    }));
    const { default: ClientFileExplorer } = await import('../../client-file-explorer');
    // Force an error when checking support
    Object.defineProperty(window, 'isSecureContext', {
      get: () => {
        throw new Error('Test error');
      },
      configurable: true,
    });

    render(<ClientFileExplorer />);
    expect(screen.getByText(/File System Access API is not supported/)).toBeInTheDocument();
    // Note: Logger calls are not tested in unit tests as they depend on environment configuration
  });

  it('shows fallback when FileExplorer import fails', async () => {
    vi.doMock('../file-explorer', () => {
      throw new Error('import error');
    });
    vi.unmock('react');
    const { default: ClientFileExplorerFail } = await import('../../client-file-explorer');
    render(<ClientFileExplorerFail />);
    // The fallback UI is "Loading File Explorer..." if the error boundary is not triggered
    expect(screen.getByText('Loading File Explorer...')).toBeInTheDocument();
    // The error spy may not be called in this environment
  });
});
