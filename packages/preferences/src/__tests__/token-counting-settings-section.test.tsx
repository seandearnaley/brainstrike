import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTokenPreferencesStoreForTests,
  useTokenPreferencesStore,
} from '../stores/token-preferences-store';

const { TokenCountingSettingsSection } = await import(
  '../settings/system/token-counting-settings-section'
);

describe('TokenCountingSettingsSection', () => {
  beforeEach(() => {
    __resetTokenPreferencesStoreForTests();
    useTokenPreferencesStore.setState({ accurateCounting: true });
    vi.clearAllMocks();
  });

  it('shows preference-disabled status when accurate counting is off', async () => {
    useTokenPreferencesStore.setState({ accurateCounting: false });

    render(<TokenCountingSettingsSection accurateRuntimeAvailable={true} />);

    expect(screen.queryByText('Heuristic mode (preference)')).not.toBeNull();
    expect(screen.queryByText(/Accurate counting is disabled globally/i)).not.toBeNull();
  });

  it('renders fallback status when runtime does not support WASM tokenizer', async () => {
    render(<TokenCountingSettingsSection accurateRuntimeAvailable={false} />);

    expect(await screen.findByText('Heuristic fallback active')).not.toBeNull();
    expect(screen.queryByText(/Runtime cannot load the WASM tokenizer/i)).not.toBeNull();
  });

  it('disables accurate counting via toggle', async () => {
    render(<TokenCountingSettingsSection accurateRuntimeAvailable={true} />);

    const toggle = await screen.findByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(useTokenPreferencesStore.getState().accurateCounting).toBe(false);
    });
    expect(screen.queryByText(/Heuristic mode/)).not.toBeNull();
  });

  it('shows checking state when runtime availability is unresolved', async () => {
    render(<TokenCountingSettingsSection accurateRuntimeAvailable={null} />);

    expect(await screen.findByText('Checking runtime…')).not.toBeNull();
  });
});
