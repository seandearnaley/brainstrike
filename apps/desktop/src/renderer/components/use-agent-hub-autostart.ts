import {
  type AgentHubRuntimeConfigPreference,
  useAgentHubPreferencesStore,
} from '@brainstrike/preferences/stores/agent-hub-preferences-store';
import { createLogger } from '@brainstrike/utils';
import { useEffect, useRef } from 'react';

const logger = createLogger('AgentHubAutostart');

interface AgentHubAutostartBridge {
  applyConfig: (config: AgentHubRuntimeConfigPreference) => Promise<unknown>;
}

/**
 * Starts the Agent Hub MCP server once the renderer-persisted preferences
 * hydrate with `enabled: true`. Main constructs the server but never starts
 * it on its own because the persisted settings live in renderer storage.
 */
export function useAgentHubAutostart(): void {
  const enabled = useAgentHubPreferencesStore((state) => state.enabled);
  const hasHydrated = useAgentHubPreferencesStore((state) => state.hasHydrated);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!(hasHydrated && enabled) || startedRef.current) {
      return;
    }
    const bridge =
      typeof window === 'undefined'
        ? null
        : ((window as Window & { agentHub?: AgentHubAutostartBridge }).agentHub ?? null);
    if (!bridge) {
      return;
    }
    startedRef.current = true;
    const config = useAgentHubPreferencesStore.getState().getRuntimeConfig();
    bridge.applyConfig(config).catch((error: unknown) => {
      startedRef.current = false;
      logger.warn('Agent hub autostart failed', { error: String(error) });
    });
  }, [enabled, hasHydrated]);
}
