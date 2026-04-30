import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockToast = vi.fn();
const mockUseToast = vi.fn(() => ({ toast: mockToast }));
const mockUseFactoryReset = vi.fn(() => null);
const mockClearPersistentUiState = vi.fn(() => Promise.resolve());

// Mock dependencies
vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useFactoryReset: mockUseFactoryReset,
}));

vi.mock('@brainstrike/ui', () => ({
  Button: ({ children, onClick, disabled, ...props }: React.ComponentProps<'button'>) => (
    <button disabled={disabled} onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Label: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  useToast: mockUseToast,
}));

vi.mock('../settings/system/factory-reset-helpers', () => ({
  clearPersistentUiState: mockClearPersistentUiState,
}));

// Import after mocks are set up
const { FactoryResetPanel } = await import('../settings/system/factory-reset-panel');

// Mock window.location.reload at the module level
const mockReload = vi.fn();
const originalLocation = window.location;

describe('FactoryResetPanel', () => {
  let mockConfirm: Mock<(message?: string) => boolean>;

  beforeAll(() => {
    // Mock window.location with our custom reload function
    vi.stubGlobal('location', {
      ...originalLocation,
      reload: mockReload,
    });
  });

  afterAll(() => {
    // Restore original location
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: undefined,
      writable: true,
    });

    // Reset default mocks
    mockUseFactoryReset.mockReturnValue(null);
    mockClearPersistentUiState.mockResolvedValue();

    // Setup window.confirm mock
    mockConfirm = vi.fn<(message?: string) => boolean>();
    window.confirm = mockConfirm;
    mockConfirm.mockReturnValue(true);
  });

  describe('rendering', () => {
    it('renders factory reset panel with button', () => {
      render(<FactoryResetPanel />);

      expect(screen.getByText('Factory Reset')).toBeInTheDocument();
      expect(
        screen.getByText(
          /Irreversibly deletes local data, stored folders, API keys, tool settings, runtime caches, and UI state from this device\. Diagnostic logs may be preserved\./
        )
      ).toBeInTheDocument();
      expect(screen.getByTestId('factory-reset-button')).toBeInTheDocument();
      expect(screen.getByText('Factory Reset Brainstrike')).toBeInTheDocument();
    });

    it('shows warning when no reset function is available', () => {
      mockUseFactoryReset.mockReturnValue(null);

      render(<FactoryResetPanel />);

      expect(
        screen.getByText(
          /Factory reset is unavailable until the database is ready\. Restart the app if this does not clear\./
        )
      ).toBeInTheDocument();
      expect(screen.getByTestId('factory-reset-button')).toBeDisabled();
    });

    it('hides warning when provider reset is available', () => {
      const mockProviderReset = vi.fn();
      mockUseFactoryReset.mockReturnValue(mockProviderReset as never);

      render(<FactoryResetPanel />);

      expect(
        screen.queryByText(
          /Factory reset is unavailable until the database is ready\. Restart the app if this does not clear\./
        )
      ).not.toBeInTheDocument();
    });

    it('hides warning when doFactoryReset prop is provided', () => {
      const mockDoFactoryReset = vi.fn();
      render(<FactoryResetPanel doFactoryReset={mockDoFactoryReset} />);

      expect(
        screen.queryByText(
          /Factory reset is unavailable until the database is ready\. Restart the app if this does not clear\./
        )
      ).not.toBeInTheDocument();
    });
  });

  describe('user interactions', () => {
    it('shows confirmation dialog when button is clicked', () => {
      render(<FactoryResetPanel doFactoryReset={vi.fn().mockResolvedValue(undefined)} />);

      const button = screen.getByTestId('factory-reset-button');
      fireEvent.click(button);

      expect(mockConfirm).toHaveBeenCalledWith(
        'Factory Reset will irreversibly delete local files, chunks, embeddings, queues, stored folders, API keys, tool settings, model/runtime caches, and UI state from this device. Diagnostic logs may be preserved. Continue?'
      );
    });

    it('does not proceed when user cancels confirmation', async () => {
      mockConfirm.mockReturnValue(false);
      const mockDoFactoryReset = vi.fn();

      render(<FactoryResetPanel doFactoryReset={mockDoFactoryReset} />);

      const button = screen.getByTestId('factory-reset-button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockDoFactoryReset).not.toHaveBeenCalled();
        expect(mockReload).not.toHaveBeenCalled();
      });
    });
  });

  describe('reset flow with doFactoryReset prop', () => {
    it('uses doFactoryReset prop when provided', async () => {
      const mockDoFactoryReset = vi.fn().mockResolvedValue(undefined);

      render(<FactoryResetPanel doFactoryReset={mockDoFactoryReset} />);

      const button = screen.getByTestId('factory-reset-button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockDoFactoryReset).toHaveBeenCalled();
        expect(mockClearPersistentUiState).toHaveBeenCalledWith({ skipIndexedDb: true });
        expect(mockReload).toHaveBeenCalled();
      });
    });

    it('disables button while reset is running', async () => {
      const mockDoFactoryReset = vi
        .fn()
        .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

      render(<FactoryResetPanel doFactoryReset={mockDoFactoryReset} />);

      const button = screen.getByTestId('factory-reset-button') as HTMLButtonElement;
      expect(button.disabled).toBe(false);

      fireEvent.click(button);

      await waitFor(() => {
        expect(button.disabled).toBe(true);
      });
    });

    it('clears UI state after reset completes', async () => {
      const mockDoFactoryReset = vi.fn().mockResolvedValue(undefined);

      render(<FactoryResetPanel doFactoryReset={mockDoFactoryReset} />);

      const button = screen.getByTestId('factory-reset-button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockDoFactoryReset).toHaveBeenCalled();
      });

      expect(mockClearPersistentUiState).toHaveBeenCalledWith({ skipIndexedDb: true });
    });

    it('clears renderer storage after the desktop reset bridge succeeds', async () => {
      const resetLocal = vi.fn().mockResolvedValue({ success: true });
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: {
          db: { resetLocal },
        },
        writable: true,
      });
      mockUseFactoryReset.mockReturnValue(null);

      render(<FactoryResetPanel doFactoryReset={null} />);

      fireEvent.click(screen.getByTestId('factory-reset-button'));

      await waitFor(() => {
        expect(resetLocal).toHaveBeenCalled();
        expect(mockClearPersistentUiState).toHaveBeenCalledWith({ skipIndexedDb: false });
      });
      const clearOrder = mockClearPersistentUiState.mock.invocationCallOrder[0];
      const resetOrder = resetLocal.mock.invocationCallOrder[0];
      if (clearOrder === undefined || resetOrder === undefined) {
        throw new Error('Expected clear and reset invocation order to be recorded');
      }
      expect(resetOrder).toBeLessThan(clearOrder);
    });

    it('does not clear renderer storage when the desktop reset bridge fails', async () => {
      const resetLocal = vi.fn().mockResolvedValue({
        success: false,
        message: 'desktop reset failed',
      });
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: {
          db: { resetLocal },
        },
        writable: true,
      });
      mockUseFactoryReset.mockReturnValue(null);

      render(<FactoryResetPanel doFactoryReset={null} />);

      fireEvent.click(screen.getByTestId('factory-reset-button'));

      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith({
          title: 'Factory Reset Failed',
          description: 'Error: desktop reset failed',
          variant: 'destructive',
        });
      });

      expect(mockClearPersistentUiState).not.toHaveBeenCalled();
      expect(mockReload).not.toHaveBeenCalled();
    });

    it('reloads the page after successful reset', async () => {
      const mockDoFactoryReset = vi.fn().mockResolvedValue(undefined);

      render(<FactoryResetPanel doFactoryReset={mockDoFactoryReset} />);

      const button = screen.getByTestId('factory-reset-button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockReload).toHaveBeenCalled();
      });
    });

    it('swallows reload errors and continues', async () => {
      const mockDoFactoryReset = vi.fn().mockResolvedValue(undefined);
      mockReload.mockImplementation(() => {
        throw new Error('Reload failed');
      });

      render(<FactoryResetPanel doFactoryReset={mockDoFactoryReset} />);

      const button = screen.getByTestId('factory-reset-button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockReload).toHaveBeenCalled();
      });

      // Should not show toast error for reload failures
      expect(mockToast).not.toHaveBeenCalled();
    });
  });

  describe('reset flow with provider reset', () => {
    it('uses provider reset when doFactoryReset prop is null', async () => {
      const mockProviderReset = vi.fn().mockResolvedValue(undefined);
      mockUseFactoryReset.mockReturnValue(mockProviderReset as never);

      render(<FactoryResetPanel doFactoryReset={null} />);

      const button = screen.getByTestId('factory-reset-button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockProviderReset).toHaveBeenCalled();
        expect(mockClearPersistentUiState).toHaveBeenCalledWith({ skipIndexedDb: true });
        expect(mockReload).toHaveBeenCalled();
      });
    });

    it('prefers doFactoryReset prop over provider reset', async () => {
      const mockDoFactoryReset = vi.fn().mockResolvedValue(undefined);
      const mockProviderReset = vi.fn().mockResolvedValue(undefined);
      mockUseFactoryReset.mockReturnValue(mockProviderReset as never);

      render(<FactoryResetPanel doFactoryReset={mockDoFactoryReset} />);

      const button = screen.getByTestId('factory-reset-button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockDoFactoryReset).toHaveBeenCalled();
        expect(mockProviderReset).not.toHaveBeenCalled();
      });
    });
  });

  describe('reset flow without any reset function', () => {
    it('does not offer a UI-only fallback when no reset function is available', async () => {
      mockUseFactoryReset.mockReturnValue(null);

      render(<FactoryResetPanel doFactoryReset={null} />);

      const button = screen.getByTestId('factory-reset-button');
      fireEvent.click(button);

      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockClearPersistentUiState).not.toHaveBeenCalled();
      expect(mockReload).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('shows error toast when reset fails', async () => {
      const mockError = new Error('Reset failed');
      const mockDoFactoryReset = vi.fn().mockRejectedValue(mockError);

      render(<FactoryResetPanel doFactoryReset={mockDoFactoryReset} />);

      const button = screen.getByTestId('factory-reset-button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith({
          title: 'Factory Reset Failed',
          description: 'Error: Reset failed',
          variant: 'destructive',
        });
      });
    });

    it('re-enables button after reset fails', async () => {
      const mockError = new Error('Reset failed');
      const mockDoFactoryReset = vi.fn().mockRejectedValue(mockError);

      render(<FactoryResetPanel doFactoryReset={mockDoFactoryReset} />);

      const button = screen.getByTestId('factory-reset-button') as HTMLButtonElement;
      fireEvent.click(button);

      // Button should be disabled during reset
      await waitFor(() => {
        expect(button.disabled).toBe(true);
      });

      // Button should be re-enabled after error
      await waitFor(() => {
        expect(button.disabled).toBe(false);
      });
    });

    it('shows error toast when clearPersistentUiState fails', async () => {
      const mockDoFactoryReset = vi.fn().mockResolvedValue(undefined);
      const mockError = new Error('Failed to clear UI state');
      mockClearPersistentUiState.mockRejectedValue(mockError);

      render(<FactoryResetPanel doFactoryReset={mockDoFactoryReset} />);

      const button = screen.getByTestId('factory-reset-button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith({
          title: 'Factory Reset Failed',
          description: 'Error: Failed to clear UI state',
          variant: 'destructive',
        });
      });
    });

    it('does not reload page when reset fails', async () => {
      const mockError = new Error('Reset failed');
      const mockDoFactoryReset = vi.fn().mockRejectedValue(mockError);

      render(<FactoryResetPanel doFactoryReset={mockDoFactoryReset} />);

      const button = screen.getByTestId('factory-reset-button');
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockToast).toHaveBeenCalled();
      });

      expect(mockReload).not.toHaveBeenCalled();
    });
  });
});
