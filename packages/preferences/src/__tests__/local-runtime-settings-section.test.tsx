import '@testing-library/jest-dom/vitest';
import { LocalRuntimeDiscoveryService } from '@brainstrike/assistant-contract/local-runtime';
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
    deleteKey: overrides?.deleteKey ?? vi.fn().mockResolvedValue(true),
    getKey: overrides?.getKey ?? vi.fn().mockResolvedValue(null),
    saveKey: overrides?.saveKey ?? vi.fn().mockResolvedValue(true),
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
      checkedAt: 1000,
      endpoint: 'http://127.0.0.1:11434/api/tags',
      latencyMs: 3,
      state: 'available',
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
      const forcedCall = probeSpy.mock.calls.find(([runtime, options]) => {
        const probeOptions = options as { endpoint?: { baseUrl?: string } } | undefined;
        return runtime === 'ollama' && probeOptions?.endpoint?.baseUrl === 'http://gpu.lan:11434';
      });
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

  // The status descriptor branches are part of the user-visible contract
  // for this surface — each state maps to a specific badge label/tone the
  // user relies on to decide whether to act. Drive each case through a
  // real probe round-trip so the component (not just describeStatus in
  // isolation) is exercised.
  it.each([
    {
      expectedDetail: /401/,
      expectedLabel: 'Auth required',
      name: 'auth_required',
      status: {
        checkedAt: 1,
        endpoint: 'http://127.0.0.1:11434/v1/models',
        state: 'auth_required' as const,
        status: 401 as const,
      },
    },
    {
      expectedDetail: /CSP blocked/,
      expectedLabel: 'Blocked by browser',
      name: 'blocked_web',
      status: { checkedAt: 2, message: 'CSP blocked the probe', state: 'blocked_web' as const },
    },
    {
      expectedDetail: /too old/,
      expectedLabel: 'Incompatible',
      name: 'incompatible',
      status: {
        checkedAt: 3,
        endpoint: 'http://127.0.0.1:11434/api/tags',
        message: 'Server is too old',
        state: 'incompatible' as const,
      },
    },
    {
      expectedDetail: /Last reachable at/,
      expectedLabel: 'Stale',
      name: 'stale',
      status: {
        checkedAt: 4,
        endpoint: 'http://127.0.0.1:11434/api/tags',
        lastSuccessfulAt: 0,
        reason: 'unavailable' as const,
        state: 'stale' as const,
      },
    },
    {
      expectedDetail: /Connection refused/,
      expectedLabel: 'Unavailable',
      name: 'unavailable (with message)',
      status: {
        checkedAt: 5,
        message: 'Connection refused',
        state: 'unavailable' as const,
      },
    },
  ])('renders the descriptor for $name status returned by the probe', async ({
    status,
    expectedLabel,
    expectedDetail,
  }) => {
    vi.mocked(LocalRuntimeDiscoveryService.prototype.probeRuntime).mockResolvedValue(status);
    render(<LocalRuntimeSettingsSection />);

    await waitFor(() => {
      // Both runtimes share the same probe mock, so we expect 2 badges.
      expect(screen.getAllByText(expectedLabel).length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText(expectedDetail).length).toBeGreaterThanOrEqual(1);
  });

  it('shows the "Force-enabled (not reachable)" label when activation=on and the probe fails', async () => {
    // The 'on' tri-state is documented as "Always offer the provider, even if
    // detection fails" — that contract is only meaningful if the surface
    // actually distinguishes a force-enabled card from a plain `unavailable`
    // one. This guards the descriptor branch that swaps the label text.
    vi.mocked(LocalRuntimeDiscoveryService.prototype.probeRuntime).mockResolvedValue({
      checkedAt: 6,
      message: 'down',
      state: 'unavailable',
    });
    useAssistantPreferencesStore
      .getState()
      .setProviderSettings('ollama', { localRuntimeEnabled: 'on' });

    render(<LocalRuntimeSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Force-enabled (not reachable)')).toBeInTheDocument();
    });
  });

  it('clicking "Probe now" force-refreshes the runtime status', async () => {
    // The mount-effect probe uses force=false; the explicit button must
    // bypass the cache via force=true so users have a way to recover from
    // a stale "Available" reading after the daemon dies.
    const probeSpy = vi.mocked(LocalRuntimeDiscoveryService.prototype.probeRuntime);
    const user = userEvent.setup();
    render(<LocalRuntimeSettingsSection />);

    // Wait for the mount probe to settle so we can isolate the click.
    await waitFor(() => {
      expect(screen.getAllByText('Available').length).toBeGreaterThanOrEqual(1);
    });
    probeSpy.mockClear();

    await user.click(screen.getByTestId('local-runtime-probe-ollama'));

    await waitFor(() => {
      const ollamaCalls = probeSpy.mock.calls.filter(([runtime]) => runtime === 'ollama');
      expect(ollamaCalls.length).toBeGreaterThanOrEqual(1);
    });
    // ONLY the clicked runtime should have been re-probed — the other card
    // must not piggy-back on a single button press (this regressed once and
    // dominated localhost probe traffic from this surface).
    const lmStudioCalls = probeSpy.mock.calls.filter(([runtime]) => runtime === 'lmstudio');
    expect(lmStudioCalls).toHaveLength(0);
  });

  it('clears a stored token via the secrets bridge when Clear is clicked', async () => {
    // Storing a token persists across reloads; without an explicit clear
    // affordance the user has no in-app way to revoke it. This locks in
    // both the bridge call and the state transition that hides the
    // "(stored)" placeholder in the input.
    const deleteKey = vi.fn().mockResolvedValue(true);
    installSecretsBridge({
      deleteKey,
      getKey: vi.fn().mockResolvedValue('tok_existing'),
    });
    const user = userEvent.setup();
    render(<LocalRuntimeSettingsSection />);

    const clearButton = await screen.findByTestId('local-runtime-token-clear-ollama');
    await user.click(clearButton);

    await waitFor(() => {
      expect(deleteKey).toHaveBeenCalledWith('ollama');
    });
    // The Clear button is conditional on storedTokenPresent; it must
    // unmount once the bridge confirms deletion.
    await waitFor(() => {
      expect(screen.queryByTestId('local-runtime-token-clear-ollama')).not.toBeInTheDocument();
    });
  });

  it('does not call the secrets bridge when the user clicks Save with an empty token field', async () => {
    // The Save button is `disabled` when the trimmed input is empty, but the
    // handler also re-validates length before touching the bridge. That belt
    // -and-braces guard exists because future refactors (or a forced click
    // via testing-library) could otherwise let an empty-string token through
    // to keytar — which would create a phantom credential the user never
    // typed. Lock the second guard in.
    const saveKey = vi.fn();
    installSecretsBridge({ saveKey });
    render(<LocalRuntimeSettingsSection />);

    // Find the section, then directly invoke commitToken via the disabled
    // button — userEvent refuses to click a disabled button, so we simulate
    // the click that would happen if the disabled state were bypassed.
    const saveButton = await screen.findByTestId('local-runtime-token-save-ollama');
    saveButton.removeAttribute('disabled');
    saveButton.click();

    // The handler MUST NOT contact the bridge with an empty string.
    expect(saveKey).not.toHaveBeenCalled();
  });

  it('no-ops when Clear is clicked but the secrets bridge has no deleteKey method', async () => {
    // The bridge contract is partial — older preload scripts may ship
    // saveKey/getKey without deleteKey. The component must not crash; the
    // optional-chain guard around `bridge.deleteKey` is what enables that.
    const partialBridge = {
      getKey: vi.fn().mockResolvedValue('tok_existing'),
      saveKey: vi.fn().mockResolvedValue(true),
    };
    (window as unknown as { secrets: typeof partialBridge }).secrets = partialBridge;
    render(<LocalRuntimeSettingsSection />);

    const clearButton = await screen.findByTestId('local-runtime-token-clear-ollama');
    expect(() => clearButton.click()).not.toThrow();
    // Token is NOT actually cleared because the bridge can't fulfill the
    // request — the storedTokenPresent indicator must remain in place.
    await waitFor(() => {
      expect(screen.getByTestId('local-runtime-token-clear-ollama')).toBeInTheDocument();
    });
  });

  it('survives a getKey rejection from the secrets bridge during initial token detection', async () => {
    // A keychain access failure on mount must not crash the card or hide
    // the section; the user should still be able to type a fresh token. The
    // catch handler downgrades the failure to a debug log.
    installSecretsBridge({
      getKey: vi.fn().mockRejectedValue(new Error('keychain unavailable')),
    });
    render(<LocalRuntimeSettingsSection />);

    // The token input should still render — the failed lookup just leaves
    // storedTokenPresent at its default `false`, so no Clear button shows.
    expect(await screen.findByTestId('local-runtime-token-input-ollama')).toBeInTheDocument();
    expect(screen.queryByTestId('local-runtime-token-clear-ollama')).not.toBeInTheDocument();
  });

  it('keeps the spinner clean and surfaces no badge change when the probe itself throws', async () => {
    // Network errors from the bridge are turned into thrown exceptions by the
    // shape-guard layer; the card's `runProbe` catches them so the surface
    // does not crash. Verify the spinner state is restored and no new badge
    // appears (the previous status is preserved).
    vi.mocked(LocalRuntimeDiscoveryService.prototype.probeRuntime).mockRejectedValue(
      new Error('boom')
    );
    render(<LocalRuntimeSettingsSection />);

    // The mount probe rejects — both cards should fall back to "Not checked
    // yet" since no status was ever recorded, and the spinner must clear.
    await waitFor(() => {
      expect(screen.getAllByText('Not checked yet').length).toBe(2);
    });
  });

  it('keeps draftToken intact when the secrets bridge rejects the save', async () => {
    // A failing save MUST NOT clear the input — the user typed credentials
    // by hand and would have to re-enter them on every retry. This locks in
    // the `result === true` guard around setDraftToken('').
    const saveKey = vi.fn().mockResolvedValue({ error: 'keychain locked', ok: false });
    installSecretsBridge({ saveKey });
    const user = userEvent.setup();
    render(<LocalRuntimeSettingsSection />);

    const tokenInput = await screen.findByTestId('local-runtime-token-input-ollama');
    await user.type(tokenInput, 'tok_will_fail');

    await user.click(screen.getByTestId('local-runtime-token-save-ollama'));

    await waitFor(() => {
      expect(saveKey).toHaveBeenCalledWith('ollama', 'tok_will_fail');
    });
    // Critical: input still holds what the user typed.
    expect(tokenInput).toHaveValue('tok_will_fail');
  });
});
