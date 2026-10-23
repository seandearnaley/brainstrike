import '@testing-library/jest-dom/vitest';
import type { ClearPersistentUiStateResult } from '@brainstrike/app-state/factory-reset';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrepareFactoryReset = vi.fn<() => Promise<void>>(async () => {});
const mockClearPersistentUiState = vi.fn<() => Promise<ClearPersistentUiStateResult>>(() =>
  Promise.resolve({
    failures: [],
    success: true,
  })
);
const mockClearPersistentUiStateIncompleteError = class extends Error {
  readonly result: ClearPersistentUiStateResult;

  constructor(result: ClearPersistentUiStateResult) {
    super('Factory reset storage cleanup incomplete');
    this.name = 'ClearPersistentUiStateIncompleteError';
    this.result = result;
  }
};

// Mock dependencies
vi.mock('@brainstrike/ui', () => ({
  Button: ({ children, onClick, disabled, ...props }: React.ComponentProps<'button'>) => (
    <button disabled={disabled} onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Label: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock('@brainstrike/app-state/factory-reset', () => ({
  ClearPersistentUiStateIncompleteError: mockClearPersistentUiStateIncompleteError,
  clearPersistentUiStateWithResult: mockClearPersistentUiState,
  prepareFactoryReset: mockPrepareFactoryReset,
}));

// Import after mocks are set up
const { FactoryResetPanel } = await import('../settings/system/factory-reset-panel');

// Mock window.location.reload at the module level
const mockReload = vi.fn();
const originalLocation = window.location;

function installDesktopReset(resetLocal: () => Promise<{ message?: string; success: boolean }>) {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { factoryReset: { resetLocal } },
    writable: true,
  });
}

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
    Object.defineProperty(window, 'desktopLifecycle', {
      configurable: true,
      value: undefined,
      writable: true,
    });

    // Reset default mocks
    mockPrepareFactoryReset.mockResolvedValue(undefined);
    mockClearPersistentUiState.mockResolvedValue({
      failures: [],
      success: true,
    });

    // Setup window.confirm mock
    mockConfirm = vi.fn<(message?: string) => boolean>();
    window.confirm = mockConfirm;
    mockConfirm.mockReturnValue(true);
  });

  it('disables an explicitly unavailable desktop reset', () => {
    const resetLocal = vi.fn(async () => ({ success: true }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        factoryReset: {
          resetLocal,
          unavailableReason: 'Factory reset is unavailable on Windows in this version.',
        },
      },
      writable: true,
    });
    render(<FactoryResetPanel />);
    expect(
      screen.getByText('Factory reset is unavailable on Windows in this version.')
    ).toBeVisible();
    expect(screen.getByTestId('factory-reset-button')).toBeDisabled();
    fireEvent.click(screen.getByTestId('factory-reset-button'));
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockPrepareFactoryReset).not.toHaveBeenCalled();
    expect(mockClearPersistentUiState).not.toHaveBeenCalled();
    expect(resetLocal).not.toHaveBeenCalled();
  });

  it('joins renderer preparation before clearing stores or calling desktop reset', async () => {
    const preparation = Promise.withResolvers<void>();
    mockPrepareFactoryReset.mockReturnValueOnce(preparation.promise);
    const resetLocal = vi.fn(async () => ({ success: true }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { factoryReset: { resetLocal } },
      writable: true,
    });
    render(<FactoryResetPanel />);
    fireEvent.click(screen.getByTestId('factory-reset-button'));
    expect(mockClearPersistentUiState).not.toHaveBeenCalled();
    expect(resetLocal).not.toHaveBeenCalled();
    preparation.resolve();
    await waitFor(() => expect(resetLocal).toHaveBeenCalledOnce());
    expect(mockClearPersistentUiState).toHaveBeenCalledOnce();
  });

  it('reloads without deleting storage when renderer preparation fails', async () => {
    mockPrepareFactoryReset.mockRejectedValueOnce(new Error('workspace write failed'));
    const resetLocal = vi.fn(async () => ({ success: true }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { factoryReset: { resetLocal } },
      writable: true,
    });
    render(<FactoryResetPanel />);
    fireEvent.click(screen.getByTestId('factory-reset-button'));
    await waitFor(() => expect(mockReload).toHaveBeenCalledOnce());
    expect(mockClearPersistentUiState).not.toHaveBeenCalled();
    expect(resetLocal).not.toHaveBeenCalled();
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

    it('shows warning when no desktop reset bridge is available', () => {
      render(<FactoryResetPanel />);

      expect(
        screen.getByText(
          /Factory reset is unavailable until the database is ready\. Restart the app if this does not clear\./
        )
      ).toBeInTheDocument();
      expect(screen.getByTestId('factory-reset-button')).toBeDisabled();
    });

    it('hides warning when the desktop reset bridge is available', () => {
      installDesktopReset(vi.fn(async () => ({ success: true })));

      render(<FactoryResetPanel />);

      expect(
        screen.queryByText(
          /Factory reset is unavailable until the database is ready\. Restart the app if this does not clear\./
        )
      ).not.toBeInTheDocument();
    });
  });

  describe('user interactions', () => {
    it('shows confirmation dialog when button is clicked', () => {
      mockConfirm.mockReturnValue(false);
      installDesktopReset(vi.fn(async () => ({ success: true })));
      render(<FactoryResetPanel />);

      fireEvent.click(screen.getByTestId('factory-reset-button'));

      expect(mockConfirm).toHaveBeenCalledWith(
        'Factory Reset will irreversibly delete local files, chunks, embeddings, queues, stored folders, API keys, tool settings, model/runtime caches, and UI state from this device. Diagnostic logs may be preserved. Continue?'
      );
    });

    it('does not proceed when user cancels confirmation', async () => {
      mockConfirm.mockReturnValue(false);
      const resetLocal = vi.fn(async () => ({ success: true }));
      installDesktopReset(resetLocal);

      render(<FactoryResetPanel />);

      fireEvent.click(screen.getByTestId('factory-reset-button'));

      await waitFor(() => {
        expect(mockPrepareFactoryReset).not.toHaveBeenCalled();
        expect(resetLocal).not.toHaveBeenCalled();
        expect(mockReload).not.toHaveBeenCalled();
      });
    });
  });

  describe('desktop reset flow', () => {
    it('disables button while reset is running', async () => {
      const reset = Promise.withResolvers<{ success: boolean }>();
      installDesktopReset(vi.fn(() => reset.promise));

      render(<FactoryResetPanel />);

      const button = screen.getByTestId('factory-reset-button') as HTMLButtonElement;
      expect(button.disabled).toBe(false);

      fireEvent.click(button);

      await waitFor(() => {
        expect(button.disabled).toBe(true);
      });
      reset.resolve({ success: true });
      await waitFor(() => {
        expect(mockReload).toHaveBeenCalled();
      });
    });

    it('clears renderer storage before the desktop reset bridge purges userData', async () => {
      const resetLocal = vi.fn().mockResolvedValue({ success: true });
      installDesktopReset(resetLocal);

      render(<FactoryResetPanel />);

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
      expect(clearOrder).toBeLessThan(resetOrder);
    });

    it('reloads after a desktop reset bridge failure once renderer storage has already cleared', async () => {
      installDesktopReset(
        vi.fn().mockResolvedValue({
          message: 'desktop reset failed',
          success: false,
        })
      );

      render(<FactoryResetPanel />);

      fireEvent.click(screen.getByTestId('factory-reset-button'));

      await waitFor(() => {
        expect(mockReload).toHaveBeenCalled();
      });

      expect(mockClearPersistentUiState).toHaveBeenCalledWith({ skipIndexedDb: false });
    });

    it('attempts the desktop reset bridge before failing incomplete renderer storage cleanup', async () => {
      const resetLocal = vi.fn().mockResolvedValue({ success: true });
      const noteReloadIntent = vi.fn().mockResolvedValue(undefined);
      mockClearPersistentUiState.mockResolvedValue({
        failures: [
          {
            error: new Error('locked opfs directory'),
            name: 'app-pg18',
            operation: 'removeEntry',
            target: 'opfs-pglite',
          },
        ],
        success: false,
      });
      installDesktopReset(resetLocal);
      Object.defineProperty(window, 'desktopLifecycle', {
        configurable: true,
        value: { noteReloadIntent },
        writable: true,
      });

      render(<FactoryResetPanel />);

      fireEvent.click(screen.getByTestId('factory-reset-button'));

      await waitFor(() => {
        expect(mockReload).toHaveBeenCalled();
      });

      expect(mockClearPersistentUiState).toHaveBeenCalledWith({ skipIndexedDb: false });
      expect(resetLocal).toHaveBeenCalled();
      const clearOrder = mockClearPersistentUiState.mock.invocationCallOrder[0];
      const resetOrder = resetLocal.mock.invocationCallOrder[0];
      if (clearOrder === undefined || resetOrder === undefined) {
        throw new Error('Expected clear and reset invocation order to be recorded');
      }
      expect(clearOrder).toBeLessThan(resetOrder);
      expect(noteReloadIntent).toHaveBeenCalledWith('factory-reset-failed-after-renderer-clear');
    });

    it('reloads the page after successful reset', async () => {
      installDesktopReset(vi.fn().mockResolvedValue({ success: true }));

      render(<FactoryResetPanel />);

      fireEvent.click(screen.getByTestId('factory-reset-button'));

      await waitFor(() => {
        expect(mockReload).toHaveBeenCalled();
      });
    });

    it('still reloads after a successful reset when recording the reload intent fails', async () => {
      installDesktopReset(vi.fn().mockResolvedValue({ success: true }));
      Object.defineProperty(window, 'desktopLifecycle', {
        configurable: true,
        value: { noteReloadIntent: vi.fn().mockRejectedValue(new Error('lifecycle closed')) },
        writable: true,
      });

      render(<FactoryResetPanel />);

      fireEvent.click(screen.getByTestId('factory-reset-button'));

      await waitFor(() => {
        expect(mockReload).toHaveBeenCalled();
      });
    });

    it('logs a failed reload and continues', async () => {
      installDesktopReset(vi.fn().mockResolvedValue({ success: true }));
      mockReload.mockImplementation(() => {
        throw new Error('Reload failed');
      });

      render(<FactoryResetPanel />);

      fireEvent.click(screen.getByTestId('factory-reset-button'));

      await waitFor(() => {
        expect(mockReload).toHaveBeenCalled();
      });
    });

    it('reloads when clearing renderer storage fails after reset work starts', async () => {
      installDesktopReset(vi.fn().mockResolvedValue({ success: true }));
      mockClearPersistentUiState.mockRejectedValue(new Error('Failed to clear UI state'));

      render(<FactoryResetPanel />);

      fireEvent.click(screen.getByTestId('factory-reset-button'));

      await waitFor(() => {
        expect(mockReload).toHaveBeenCalled();
      });
    });
  });

  describe('reset flow without a desktop reset bridge', () => {
    it('does not offer a UI-only fallback', () => {
      render(<FactoryResetPanel />);

      fireEvent.click(screen.getByTestId('factory-reset-button'));

      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockClearPersistentUiState).not.toHaveBeenCalled();
      expect(mockReload).not.toHaveBeenCalled();
    });
  });
});
