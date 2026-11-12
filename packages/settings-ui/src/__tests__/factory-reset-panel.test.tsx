import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrepareFactoryReset = vi.fn<() => Promise<void>>(async () => {});

vi.mock('@brainstrike/app-state/factory-reset', () => ({
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

/** Opens the reset dialog and confirms it. */
function confirmReset(): void {
  fireEvent.click(screen.getByTestId('factory-reset-button'));
  fireEvent.click(screen.getByTestId('factory-reset-confirm'));
}

describe('FactoryResetPanel', () => {
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
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockPrepareFactoryReset).not.toHaveBeenCalled();
    expect(resetLocal).not.toHaveBeenCalled();
  });

  // ADR-0034: the reset archives the managed worktrees, forcing past their ignored files.
  it('says before the person confirms that worktrees are archived and their ignored files deleted', () => {
    installDesktopReset(vi.fn(async () => ({ success: true })));
    render(<FactoryResetPanel />);

    fireEvent.click(screen.getByTestId('factory-reset-button'));

    expect(
      screen.getByText(
        'Managed worktrees are archived into their repositories first: uncommitted work is kept as a snapshot ref and their branches stay, but their ignored files, such as .env files and installed dependencies, are deleted.'
      )
    ).toBeVisible();
  });

  it('joins renderer preparation before calling desktop reset', async () => {
    const preparation = Promise.withResolvers<void>();
    mockPrepareFactoryReset.mockReturnValueOnce(preparation.promise);
    const resetLocal = vi.fn(async () => ({ success: true }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { factoryReset: { resetLocal } },
      writable: true,
    });
    render(<FactoryResetPanel />);
    confirmReset();
    expect(resetLocal).not.toHaveBeenCalled();
    preparation.resolve();
    await waitFor(() => expect(resetLocal).toHaveBeenCalledOnce());
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
    confirmReset();
    await waitFor(() => expect(mockReload).toHaveBeenCalledOnce());
    expect(resetLocal).not.toHaveBeenCalled();
  });

  describe('rendering', () => {
    it('renders factory reset panel with button', () => {
      render(<FactoryResetPanel />);

      expect(screen.getByRole('heading', { name: 'Factory reset' })).toBeInTheDocument();
      expect(
        screen.getByText(
          /Irreversibly deletes local data, stored folders, API keys, tool settings, runtime caches, and UI state from this device\. Diagnostic logs may be preserved\./u
        )
      ).toBeInTheDocument();
      expect(screen.getByTestId('factory-reset-button')).toBeInTheDocument();
      expect(screen.getByTestId('factory-reset-button')).toHaveTextContent('Factory reset…');
    });

    it('shows warning when no desktop reset bridge is available', () => {
      render(<FactoryResetPanel />);

      expect(
        screen.getByText(
          /Factory reset is unavailable until the database is ready\. Restart the app if this does not clear\./u
        )
      ).toBeInTheDocument();
      expect(screen.getByTestId('factory-reset-button')).toBeDisabled();
    });

    it('hides warning when the desktop reset bridge is available', () => {
      installDesktopReset(vi.fn(async () => ({ success: true })));

      render(<FactoryResetPanel />);

      expect(
        screen.queryByText(
          /Factory reset is unavailable until the database is ready\. Restart the app if this does not clear\./u
        )
      ).not.toBeInTheDocument();
    });
  });

  describe('user interactions', () => {
    it('asks for confirmation in a dialog before resetting', () => {
      const resetLocal = vi.fn(async () => ({ success: true }));
      installDesktopReset(resetLocal);
      render(<FactoryResetPanel />);

      fireEvent.click(screen.getByTestId('factory-reset-button'));

      expect(screen.getByRole('dialog', { name: 'Factory reset' })).toHaveTextContent(
        'This cannot be undone.'
      );
      expect(mockPrepareFactoryReset).not.toHaveBeenCalled();
      expect(resetLocal).not.toHaveBeenCalled();
    });

    it('does not proceed when user cancels confirmation', async () => {
      const resetLocal = vi.fn(async () => ({ success: true }));
      installDesktopReset(resetLocal);

      render(<FactoryResetPanel />);

      fireEvent.click(screen.getByTestId('factory-reset-button'));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(mockPrepareFactoryReset).not.toHaveBeenCalled();
      expect(resetLocal).not.toHaveBeenCalled();
      expect(mockReload).not.toHaveBeenCalled();
    });
  });

  describe('desktop reset flow', () => {
    it('shows the reset running and keeps the dialog open', async () => {
      const reset = Promise.withResolvers<{ success: boolean }>();
      installDesktopReset(vi.fn(() => reset.promise));

      render(<FactoryResetPanel />);

      confirmReset();

      const confirm = screen.getByTestId('factory-reset-confirm');
      await waitFor(() => {
        expect(confirm).toBeDisabled();
      });
      expect(confirm).toHaveTextContent('Resetting…');
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      reset.resolve({ success: true });
      await waitFor(() => {
        expect(mockReload).toHaveBeenCalled();
      });
    });

    it("clears this window's session storage before Main resets the profile", async () => {
      window.sessionStorage.setItem('assistant-composer-drafts.v1', '{"state":{}}');
      let storedAtReset: string | null = 'unset';
      const resetLocal = vi.fn(async () => {
        storedAtReset = window.sessionStorage.getItem('assistant-composer-drafts.v1');
        return { success: true };
      });
      installDesktopReset(resetLocal);
      render(<FactoryResetPanel />);

      confirmReset();

      await waitFor(() => expect(resetLocal).toHaveBeenCalledOnce());
      expect(storedAtReset).toBeNull();
    });

    it('reloads after a desktop reset bridge failure', async () => {
      installDesktopReset(
        vi.fn().mockResolvedValue({
          message: 'desktop reset failed',
          success: false,
        })
      );

      render(<FactoryResetPanel />);

      confirmReset();

      await waitFor(() => {
        expect(mockReload).toHaveBeenCalled();
      });
    });

    it('reloads the page after successful reset', async () => {
      installDesktopReset(vi.fn().mockResolvedValue({ success: true }));

      render(<FactoryResetPanel />);

      confirmReset();

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

      confirmReset();

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

      confirmReset();

      await waitFor(() => {
        expect(mockReload).toHaveBeenCalled();
      });
    });
  });

  describe('reset flow without a desktop reset bridge', () => {
    it('does not offer a UI-only fallback', () => {
      render(<FactoryResetPanel />);

      expect(screen.getByTestId('factory-reset-button')).toBeDisabled();
      fireEvent.click(screen.getByTestId('factory-reset-button'));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mockReload).not.toHaveBeenCalled();
    });
  });
});
