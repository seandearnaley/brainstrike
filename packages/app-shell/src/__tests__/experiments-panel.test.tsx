import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExperimentsPanel } from '../settings/experiments-panel';

// Define mocks in a hoisted block so they are available
// to the vi.mock factory (which Vitest hoists to file top).
const { mockIsEnabled, mockSetEnabled } = vi.hoisted(() => ({
  mockIsEnabled: vi.fn(),
  mockSetEnabled: vi.fn(),
}));

const { mockReload } = vi.hoisted(() => ({
  mockReload: vi.fn(),
}));

vi.mock('../feature-flags', () => ({
  FEATURE_KEYS: { fileExplorerV2: 'FEATURE_FILE_EXPLORER_V2' },
  isFileExplorerV2Enabled: mockIsEnabled,
  setFileExplorerV2Enabled: mockSetEnabled,
}));

vi.mock('../utils/window-utils', () => ({
  reloadWindow: mockReload,
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

    render(<ExperimentsPanel />);
    const toggle = screen.getByTestId('ff-explorer-v2-toggle');
    await user.click(toggle);

    expect(mockSetEnabled).toHaveBeenCalledWith(true);
    expect(mockReload).toHaveBeenCalled();
  });

  it('Reset clears local override', async () => {
    const user = userEvent.setup();
    mockIsEnabled.mockReturnValueOnce(true);

    // Seed localStorage with override
    localStorage.setItem('FEATURE_FILE_EXPLORER_V2', '1');

    render(<ExperimentsPanel />);
    const reset = screen.getByRole('button', { name: /reset/i });
    await user.click(reset);

    expect(localStorage.getItem('FEATURE_FILE_EXPLORER_V2')).toBeNull();
    expect(mockReload).toHaveBeenCalled();
  });
});
