import { useAgentHubPreferencesStore } from '@brainstrike/preferences/stores/agent-hub-preferences-store';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentHubAutostart } from '../use-agent-hub-autostart';

function installBridge() {
  const bridge = {
    applyConfig: vi.fn().mockResolvedValue({
      connectionCount: 0,
      error: null,
      state: 'running',
      url: 'http://127.0.0.1:4519/mcp',
    }),
  };
  (window as unknown as { agentHub: typeof bridge }).agentHub = bridge;
  return bridge;
}

describe('useAgentHubAutostart', () => {
  beforeEach(() => {
    useAgentHubPreferencesStore.setState({
      authToken: null,
      bindAddress: '127.0.0.1',
      enabled: false,
      hasHydrated: false,
      maxMessagesPerChannel: 1000,
      port: 4519,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window as Window & { agentHub?: unknown }, 'agentHub');
    vi.restoreAllMocks();
  });

  it('starts the hub once the store hydrates with enabled=true', async () => {
    const bridge = installBridge();
    useAgentHubPreferencesStore.setState({ enabled: true, hasHydrated: true });
    renderHook(() => useAgentHubAutostart());
    await waitFor(() => {
      expect(bridge.applyConfig).toHaveBeenCalledTimes(1);
    });
    expect(bridge.applyConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, port: 4519 })
    );
  });

  it('does nothing when disabled', async () => {
    const bridge = installBridge();
    useAgentHubPreferencesStore.setState({ enabled: false, hasHydrated: true });
    renderHook(() => useAgentHubAutostart());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.applyConfig).not.toHaveBeenCalled();
  });

  it('waits for hydration before starting', async () => {
    const bridge = installBridge();
    useAgentHubPreferencesStore.setState({ enabled: true, hasHydrated: false });
    const { rerender } = renderHook(() => useAgentHubAutostart());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.applyConfig).not.toHaveBeenCalled();
    useAgentHubPreferencesStore.setState({ hasHydrated: true });
    rerender();
    await waitFor(() => {
      expect(bridge.applyConfig).toHaveBeenCalledTimes(1);
    });
  });
});
