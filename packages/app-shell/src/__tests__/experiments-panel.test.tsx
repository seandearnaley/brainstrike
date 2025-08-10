import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExperimentsPanel } from '../settings/experiments-panel';

const mockIsEnabled = vi.fn();
const mockSetEnabled = vi.fn();

vi.mock('../feature-flags', () => ({
  FEATURE_KEYS: { fileExplorerV2: 'FEATURE_FILE_EXPLORER_V2' },
  isFileExplorerV2Enabled: mockIsEnabled,
  setFileExplorerV2Enabled: mockSetEnabled,
}));

describe('ExperimentsPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // jsdom provides localStorage; clear it before tests
    try {
      localStorage.clear();
    } catch {}
  });

  it('renders with initial state from isFileExplorerV2Enabled()', () => {
    mockIsEnabled.mockReturnValueOnce(true);
    render(<ExperimentsPanel />);
    expect(screen.getByTestId('ff-explorer-v2-state').textContent).toMatch(/Enabled/);
  });

  it('toggles switch and calls setFileExplorerV2Enabled', async () => {
    const user = userEvent.setup();
    mockIsEnabled.mockReturnValueOnce(false);

    // Prevent actual reloads
    const origReload = window.location.reload;
    // @ts-expect-error allow override in test
    window.location.reload = vi.fn();

    render(<ExperimentsPanel />);
    const toggle = screen.getByTestId('ff-explorer-v2-toggle');
    await user.click(toggle);

    expect(mockSetEnabled).toHaveBeenCalledWith(true);

    // Restore reload
    window.location.reload = origReload;
  });

  it('Reset clears local override', async () => {
    const user = userEvent.setup();
    mockIsEnabled.mockReturnValueOnce(true);

    // Seed localStorage with override
    localStorage.setItem('FEATURE_FILE_EXPLORER_V2', '1');

    // Mock reload
    const origReload = window.location.reload;
    // @ts-expect-error allow override in test
    window.location.reload = vi.fn();

    render(<ExperimentsPanel />);
    const reset = screen.getByRole('button', { name: /reset/i });
    await user.click(reset);

    expect(localStorage.getItem('FEATURE_FILE_EXPLORER_V2')).toBeNull();

    // Restore reload
    window.location.reload = origReload;
  });
});
