import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_HUB_PREFERENCES_STORE_NAME,
  useAgentHubPreferencesStore,
} from '../stores/agent-hub-preferences-store';

describe('agent hub preferences store', () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentHubPreferencesStore.setState({
      authToken: null,
      bindAddress: '127.0.0.1',
      enabled: false,
      maxMessagesPerChannel: 1000,
      port: 4519,
    });
  });

  it('exposes safe defaults', () => {
    const state = useAgentHubPreferencesStore.getState();
    expect(state.enabled).toBe(false);
    expect(state.port).toBe(4519);
    expect(state.bindAddress).toBe('127.0.0.1');
    expect(state.authToken).toBeNull();
    expect(state.maxMessagesPerChannel).toBe(1000);
  });

  it('updates fields through setters', () => {
    const state = useAgentHubPreferencesStore.getState();
    state.setEnabled(true);
    state.setPort(5000);
    state.setBindAddress('0.0.0.0');
    state.setAuthToken('tok');
    state.setMaxMessagesPerChannel(50);
    const next = useAgentHubPreferencesStore.getState();
    expect(next.enabled).toBe(true);
    expect(next.port).toBe(5000);
    expect(next.bindAddress).toBe('0.0.0.0');
    expect(next.authToken).toBe('tok');
    expect(next.maxMessagesPerChannel).toBe(50);
  });

  it('normalizes blank auth tokens to null', () => {
    useAgentHubPreferencesStore.getState().setAuthToken('   ');
    expect(useAgentHubPreferencesStore.getState().authToken).toBeNull();
  });

  it('assembles a runtime config object', () => {
    const state = useAgentHubPreferencesStore.getState();
    state.setEnabled(true);
    expect(useAgentHubPreferencesStore.getState().getRuntimeConfig()).toEqual({
      authToken: null,
      bindAddress: '127.0.0.1',
      enabled: true,
      maxMessagesPerChannel: 1000,
      port: 4519,
    });
  });

  it('persists under a versioned store name without hydration flags', () => {
    expect(AGENT_HUB_PREFERENCES_STORE_NAME).toBe('agent-hub-preferences.v1');
    useAgentHubPreferencesStore.getState().setEnabled(true);
    const raw = localStorage.getItem(AGENT_HUB_PREFERENCES_STORE_NAME);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? '{}') as { state: Record<string, unknown> };
    expect(parsed.state['enabled']).toBe(true);
    expect('hasHydrated' in parsed.state).toBe(false);
  });
});
