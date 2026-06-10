import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createBrowserJsonStorage } from './browser-json-storage';

export const AGENT_HUB_PREFERENCES_STORE_NAME = 'agent-hub-preferences.v1' as const;

const STORE_VERSION = 1;

export type AgentHubBindAddressPreference = '0.0.0.0' | '127.0.0.1';

/** Mirrors AgentHubRuntimeConfig in apps/desktop/src/agent-hub/agent-hub-config.ts. */
export interface AgentHubRuntimeConfigPreference {
  authToken: string | null;
  bindAddress: AgentHubBindAddressPreference;
  enabled: boolean;
  maxMessagesPerChannel: number;
  port: number;
}

interface AgentHubPreferencesData extends AgentHubRuntimeConfigPreference {
  hasHydrated: boolean;
}

interface AgentHubPreferencesActions {
  getRuntimeConfig: () => AgentHubRuntimeConfigPreference;
  setAuthToken: (token: string | null) => void;
  setBindAddress: (bindAddress: AgentHubBindAddressPreference) => void;
  setEnabled: (enabled: boolean) => void;
  setMaxMessagesPerChannel: (value: number) => void;
  setPort: (port: number) => void;
}

export type AgentHubPreferencesStore = AgentHubPreferencesData & AgentHubPreferencesActions;

export const DEFAULT_AGENT_HUB_PREFERENCES: AgentHubRuntimeConfigPreference = {
  authToken: null,
  bindAddress: '127.0.0.1',
  enabled: false,
  maxMessagesPerChannel: 1000,
  port: 4519,
};

interface ElectronStorageBridge {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly removeItem: (key: string) => Promise<void>;
  readonly setItem: (key: string, value: string) => Promise<void>;
}

function getElectronStorageBridge(): ElectronStorageBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return (
    (window as Window & { electronAPI?: { storage?: ElectronStorageBridge } }).electronAPI
      ?.storage ?? null
  );
}

function createAgentHubPreferencesStorage() {
  const electronStorage = getElectronStorageBridge();
  if (electronStorage) {
    return {
      getItem: (key: string) => electronStorage.getItem(key),
      removeItem: (key: string) => electronStorage.removeItem(key),
      setItem: (key: string, value: string) => electronStorage.setItem(key, value),
    };
  }
  return createBrowserJsonStorage();
}

const storage = createJSONStorage(() => createAgentHubPreferencesStorage());

export const useAgentHubPreferencesStore = create<AgentHubPreferencesStore>()(
  persist(
    (set, get) => ({
      ...DEFAULT_AGENT_HUB_PREFERENCES,
      hasHydrated: false,
      getRuntimeConfig: () => {
        const { authToken, bindAddress, enabled, maxMessagesPerChannel, port } = get();
        return { authToken, bindAddress, enabled, maxMessagesPerChannel, port };
      },
      setAuthToken: (token: string | null) => {
        const trimmed = token?.trim() ?? '';
        set({ authToken: trimmed.length === 0 ? null : trimmed });
      },
      setBindAddress: (bindAddress: AgentHubBindAddressPreference) => set({ bindAddress }),
      setEnabled: (enabled: boolean) => set({ enabled }),
      setMaxMessagesPerChannel: (value: number) => set({ maxMessagesPerChannel: value }),
      setPort: (port: number) => set({ port }),
    }),
    {
      name: AGENT_HUB_PREFERENCES_STORE_NAME,
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
          return;
        }
        useAgentHubPreferencesStore.setState({ hasHydrated: true });
      },
      partialize: (state) => ({
        authToken: state.authToken,
        bindAddress: state.bindAddress,
        enabled: state.enabled,
        maxMessagesPerChannel: state.maxMessagesPerChannel,
        port: state.port,
      }),
      storage,
      version: STORE_VERSION,
    }
  )
);
