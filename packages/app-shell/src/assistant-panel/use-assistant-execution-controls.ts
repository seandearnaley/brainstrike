import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { hasDurableAssistantUsageCapability } from '@brainstrike/assistant-data';
import { hasDesktopLlmHost } from '@brainstrike/assistant-ui';

export function hasDesktopRuntimeBridge(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const desktopWindow = window as Window & {
    desktopLifecycle?: unknown;
  };
  return (
    typeof desktopWindow.desktopLifecycle === 'object' && desktopWindow.desktopLifecycle !== null
  );
}

function hasDesktopAssistantBackend(): boolean {
  // Single source of truth for "durable assistant usage is recorded here"
  // (shared with the cost panel's read-side gate) — see
  // assistant-durable-usage-capability.ts.
  return hasDurableAssistantUsageCapability();
}

interface AssistantExecutionControls {
  readonly desktopAssistantBackendAvailable: boolean;
  readonly localChatTransport: 'data-stream' | 'local-runtime';
  readonly planMode: boolean;
  readonly planModeAvailable: boolean;
  readonly planModeEnabledPref: boolean;
  readonly setPlanModeEnabled: (enabled: boolean) => void;
  readonly togglePlanMode: () => void;
}

export function useAssistantExecutionControls(
  selectedProvider: SupportedProvider | null
): AssistantExecutionControls {
  const desktopAssistantBackendAvailable = hasDesktopAssistantBackend();
  // Desktop routes built-in local chat through the assistant server (real
  // Mastra loop with persistence/run events; inference proxied to the hidden
  // llm-host). Web has neither bridge and keeps the in-renderer local runtime.
  const localChatTransport: 'data-stream' | 'local-runtime' =
    hasDesktopRuntimeBridge() && desktopAssistantBackendAvailable && hasDesktopLlmHost()
      ? 'data-stream'
      : 'local-runtime';
  // Plan mode (OPT-IN, persisted). Desktop-hosted-first: only the data-stream
  // transport reaches the assistant server that enforces the plan-mode tool gate
  // (web's in-renderer local runtime has no server). Presence-means-on downstream.
  const planModeEnabledPref = useAssistantPreferencesStore((state) => state.planModeEnabled);
  const togglePlanMode = useAssistantPreferencesStore((state) => state.togglePlanMode);
  const setPlanModeEnabled = useAssistantPreferencesStore((state) => state.setPlanModeEnabled);
  // Plan mode is never offered for the built-in local provider (its server gate
  // ignores planMode — see O3), so the composer toggle is hidden there rather
  // than silently no-opping.
  const planModeAvailable = localChatTransport === 'data-stream' && selectedProvider !== 'local';
  const planMode = planModeEnabledPref && planModeAvailable;
  return {
    desktopAssistantBackendAvailable,
    localChatTransport,
    planMode,
    planModeAvailable,
    planModeEnabledPref,
    setPlanModeEnabled,
    togglePlanMode,
  };
}
