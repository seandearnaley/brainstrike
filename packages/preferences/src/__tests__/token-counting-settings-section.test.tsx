import { render, screen } from '@testing-library/react';
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

  it('describes local estimated token sizing without a runtime toggle', async () => {
    render(<TokenCountingSettingsSection accurateRuntimeAvailable={false} />);

    expect(await screen.findByText('Using local estimator')).not.toBeNull();
    expect(screen.queryByText(/local estimated token sizing/i)).not.toBeNull();
    expect(screen.queryByText(/proprietary provider tokenizers/i)).not.toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByTestId('token-counting-accurate-toggle')).toBeNull();
  });

  it('does not render old accurate runtime status copy', async () => {
    render(<TokenCountingSettingsSection accurateRuntimeAvailable={null} />);

    expect(await screen.findByText('Using local estimator')).not.toBeNull();
    expect(screen.queryByText(/accurate tokenizer/i)).toBeNull();
    expect(screen.queryByText(/WASM tokenizer/i)).toBeNull();
    expect(screen.queryByText(/tiktoken/i)).toBeNull();
    expect(screen.queryByText(/unavailable/i)).toBeNull();
  });

  it('leaves the legacy stored preference untouched while rendering estimator mode', async () => {
    useTokenPreferencesStore.setState({ accurateCounting: false });

    render(<TokenCountingSettingsSection accurateRuntimeAvailable={true} />);

    expect(await screen.findByText('Using local estimator')).not.toBeNull();
    expect(useTokenPreferencesStore.getState().accurateCounting).toBe(false);
  });
});
