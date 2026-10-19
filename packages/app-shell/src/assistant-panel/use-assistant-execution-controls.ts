import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { hasDurableAssistantUsageCapability } from '@brainstrike/assistant-data';

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
  readonly assistantServerAvailable: boolean;
  readonly desktopAssistantBackendAvailable: boolean;
  readonly planMode: boolean;
  readonly planModeAvailable: boolean;
  readonly planModeEnabledPref: boolean;
  readonly setPlanModeEnabled: (enabled: boolean) => void;
  readonly togglePlanMode: () => void;
}

export function useAssistantExecutionControls(): AssistantExecutionControls {
  const desktopAssistantBackendAvailable = hasDesktopAssistantBackend();
  // Is DESKTOP's own assistant server behind this panel? Every panel streams
  // over the same data-stream transport, but only the desktop server runs the
  // workspace scan, the skills engine, subagent personas and the permission
  // gate; web's `/api/assistant` implements none of them. Features that need
  // those gate on this capability, never on which provider is selected.
  const assistantServerAvailable = hasDesktopRuntimeBridge() && desktopAssistantBackendAvailable;
  // Plan mode (OPT-IN, persisted). Desktop-hosted-first: only the desktop
  // assistant server enforces the plan-mode tool gate. Presence-means-on
  // downstream.
  const planModeEnabledPref = useAssistantPreferencesStore((state) => state.planModeEnabled);
  const togglePlanMode = useAssistantPreferencesStore((state) => state.togglePlanMode);
  const setPlanModeEnabled = useAssistantPreferencesStore((state) => state.setPlanModeEnabled);
  const planModeAvailable = assistantServerAvailable;
  const planMode = planModeEnabledPref && planModeAvailable;
  return {
    assistantServerAvailable,
    desktopAssistantBackendAvailable,
    planMode,
    planModeAvailable,
    planModeEnabledPref,
    setPlanModeEnabled,
    togglePlanMode,
  };
}
