import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTokenPreferencesStoreForTests,
  useTokenPreferencesStore,
} from '../stores/token-preferences-store';

const { TokenCountingSettingsSection } = await import(
  '../settings/system/token-counting-settings-section'
);

vi.mock('@brainstrike/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils')>();
  return {
    ...actual,
    supportsAccurateTokenCountingLazy: vi.fn(() => Promise.resolve(true)),
  };
});

describe('TokenCountingSettingsSection', () => {
  beforeEach(() => {
    __resetTokenPreferencesStoreForTests();
    useTokenPreferencesStore.setState({ accurateCounting: true });
    vi.clearAllMocks();
  });

  it('shows preference-disabled status when accurate counting is off', async () => {
    useTokenPreferencesStore.setState({ accurateCounting: false });

    render(<TokenCountingSettingsSection />);

    expect(screen.queryByText('Heuristic mode (preference)')).not.toBeNull();
    expect(screen.queryByText(/Accurate counting is disabled globally/i)).not.toBeNull();
  });

  it('renders fallback status when runtime does not support WASM tokenizer', async () => {
    const utilsModule = vi.mocked(await import('@brainstrike/utils'));
    utilsModule.supportsAccurateTokenCountingLazy.mockResolvedValue(false);

    render(<TokenCountingSettingsSection />);

    expect(await screen.findByText('Heuristic fallback active')).not.toBeNull();
    expect(screen.queryByText(/Runtime cannot load the WASM tokenizer/i)).not.toBeNull();
  });

  it('disables accurate counting via toggle', async () => {
    const utilsModule = vi.mocked(await import('@brainstrike/utils'));
    utilsModule.supportsAccurateTokenCountingLazy.mockResolvedValue(true);

    render(<TokenCountingSettingsSection />);

    const toggle = await screen.findByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(useTokenPreferencesStore.getState().accurateCounting).toBe(false);
    });
    expect(screen.queryByText(/Heuristic mode/)).not.toBeNull();
  });
});
