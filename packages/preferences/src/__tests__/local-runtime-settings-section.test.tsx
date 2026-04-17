import '@testing-library/jest-dom/vitest';
import { LocalRuntimeDiscoveryService } from '@brainstrike/agent/local-runtime';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalRuntimeSettingsSection } from '../settings/runtimes/local-runtime-settings-section';
import {
  __resetAssistantPreferencesStoreForTests,
  useAssistantPreferencesStore,
} from '../stores/assistant-preferences-store';

interface MockSecretsBridge {
  deleteKey: ReturnType<typeof vi.fn>;
  getKey: ReturnType<typeof vi.fn>;
  saveKey: ReturnType<typeof vi.fn>;
}

function installSecretsBridge(overrides?: Partial<MockSecretsBridge>): MockSecretsBridge {
  const bridge: MockSecretsBridge = {
    getKey: overrides?.getKey ?? vi.fn().mockResolvedValue(null),
    saveKey: overrides?.saveKey ?? vi.fn().mockResolvedValue(true),
    deleteKey: overrides?.deleteKey ?? vi.fn().mockResolvedValue(true),
  };
  (window as unknown as { secrets: MockSecretsBridge }).secrets = bridge;
  return bridge;
}

function removeSecretsBridge() {
  const target = window as Window & { secrets?: unknown };
  Reflect.deleteProperty(target, 'secrets');
}

describe('LocalRuntimeSettingsSection', () => {
  beforeEach(() => {
    __resetAssistantPreferencesStoreForTests();
    vi.spyOn(LocalRuntimeDiscoveryService.prototype, 'probeRuntime').mockResolvedValue({
      state: 'available',
      checkedAt: 1000,
      endpoint: 'http://127.0.0.1:11434/api/tags',
      latencyMs: 3,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeSecretsBridge();
  });

  it('renders a card per local runtime with an availability status badge', async () => {
    render(<LocalRuntimeSettingsSection />);

    expect(screen.getByText('Ollama')).toBeInTheDocument();
    expect(screen.getByText('LM Studio')).toBeInTheDocument();

    // Probe runs on mount; both cards should show "Available" once resolved.
    await waitFor(() => {
      const available = screen.getAllByText('Available');
      expect(available.length).toBe(2);
    });
  });

  it('persists activation changes to the preferences store', async () => {
    const user = userEvent.setup();
    render(<LocalRuntimeSettingsSection />);

    const ollamaGroup = screen.getByTestId('local-runtime-activation-ollama');
    const offRadio = within(ollamaGroup).getByRole('radio', { name: /^Off/ });
    await user.click(offRadio);

    expect(
      useAssistantPreferencesStore.getState().providerSettings.ollama.localRuntimeEnabled
    ).toBe('off');
  });

  it('saves a baseUrl edit to the store and triggers a re-probe', async () => {
    const probeSpy = vi.mocked(LocalRuntimeDiscoveryService.prototype.probeRuntime);
    const user = userEvent.setup();
    render(<LocalRuntimeSettingsSection />);

    const input = screen.getByTestId('local-runtime-url-input-ollama');
    await user.clear(input);
    await user.type(input, 'http://gpu.lan:11434');

    const saveButton = screen.getByTestId('local-runtime-url-save-ollama');
    await user.click(saveButton);

    expect(
      useAssistantPreferencesStore.getState().providerSettings.ollama.localRuntimeBaseUrl
    ).toBe('http://gpu.lan:11434');

    // The save handler forces a re-probe with the new endpoint config.
    await waitFor(() => {
      const forcedCall = probeSpy.mock.calls.find(
        ([runtime, options]) =>
          runtime === 'ollama' && options?.endpoint?.baseUrl === 'http://gpu.lan:11434'
      );
      expect(forcedCall).toBeTruthy();
    });
  });

  it('hides the token section when the secrets bridge is unavailable (web build)', () => {
    removeSecretsBridge();
    render(<LocalRuntimeSettingsSection />);
    expect(screen.queryByTestId('local-runtime-token-input-ollama')).not.toBeInTheDocument();
  });

  it('saves an API token via the secrets bridge when present (desktop build)', async () => {
    const saveKey = vi.fn().mockResolvedValue(true);
    installSecretsBridge({ saveKey });
    const user = userEvent.setup();
    render(<LocalRuntimeSettingsSection />);

    const tokenInput = await screen.findByTestId('local-runtime-token-input-ollama');
    await user.type(tokenInput, 'tok_abc');

    const saveButton = screen.getByTestId('local-runtime-token-save-ollama');
    await user.click(saveButton);

    await waitFor(() => {
      expect(saveKey).toHaveBeenCalledWith('ollama', 'tok_abc');
    });
  });

  it('does not probe when activation is off', async () => {
    useAssistantPreferencesStore
      .getState()
      .setProviderSettings('ollama', { localRuntimeEnabled: 'off' });
    const probeSpy = vi.mocked(LocalRuntimeDiscoveryService.prototype.probeRuntime);

    render(<LocalRuntimeSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Disabled')).toBeInTheDocument();
    });
    // LM Studio still probes because its activation is auto; ollama should not.
    const ollamaCalls = probeSpy.mock.calls.filter(([runtime]) => runtime === 'ollama');
    expect(ollamaCalls).toHaveLength(0);
  });
});
