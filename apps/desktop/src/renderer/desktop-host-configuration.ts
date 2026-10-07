import {
  buildAgentLoopSettings,
  buildAssistantMemoryOptions,
  buildDraftRuntimeForProvider,
  toRuntimeWorkspaceContext,
} from '@brainstrike/app-shell';
import { useAssistantMemoryPreferencesStore } from '@brainstrike/app-state/stores/assistant-memory-preferences-store';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { useNativeToolPreferencesStore } from '@brainstrike/app-state/stores/native-tool-preferences-store';
import { getPermissionToolGateSnapshotInput } from '@brainstrike/app-state/stores/permission-policy-store';
import { useWorkspaceInstructionsPreferencesStore } from '@brainstrike/app-state/stores/workspace-instructions-preferences-store';
import { DESKTOP_NATIVE_TOOL_IDS, isSupportedProvider } from '@brainstrike/assistant-contract';
import { useWorkspaceContextCurationStore } from '@brainstrike/file-explorer-ui/preview';
import { PlatformClientConfigurationSchema } from '../agent-host-platform/platform-wire';

/** Capture intent at Send from the same stores used by the existing assistant. */
export function readDesktopHostConfiguration(
  selectionFolderId: string | null
): Record<string, unknown> {
  const preferences = useAssistantPreferencesStore.getState();
  const composite = preferences.selectedModel;
  if (!composite) {
    throw new Error('Select a provider and model before sending');
  }
  const separator = composite.indexOf('::');
  const provider = composite.slice(0, separator);
  if (separator < 1 || !isSupportedProvider(provider)) {
    throw new Error('The selected model has no supported provider');
  }
  const draft = buildDraftRuntimeForProvider({
    model: composite.slice(separator + 2),
    provider,
    providerSettingsMap: preferences.providerSettings,
  });
  // The raw settings map contains transport credentials in some integrations;
  // only the existing generation-option projection belongs in the event log.
  const { providerSettings: _providerSettings, ...modelConfiguration } = draft;
  const permission = getPermissionToolGateSnapshotInput();
  const { enforce, ...policy } = permission;
  const instructions = useWorkspaceInstructionsPreferencesStore.getState();
  const workspaceContext = toRuntimeWorkspaceContext(
    useWorkspaceContextCurationStore.getState().contextSnapshot,
    selectionFolderId
  );
  return PlatformClientConfigurationSchema.parse({
    agentLoop: buildAgentLoopSettings(preferences.providerSettings[provider]),
    enabledNativeToolIds: DESKTOP_NATIVE_TOOL_IDS.filter((id) =>
      useNativeToolPreferencesStore.getState().isToolEnabled(id)
    ),
    memoryOptions: buildAssistantMemoryOptions(preferences.providerSettings[provider]),
    memorySettings: useAssistantMemoryPreferencesStore.getState().getRuntimeMemorySettings(),
    modelConfiguration,
    permissionPolicy: { ...policy, yolo: policy.yolo || !enforce },
    ...(workspaceContext ? { workspaceContext } : {}),
    workspaceInstructionsPreference: {
      masterEnabled: instructions.masterEnabled,
      oversizedOptInByRootId: instructions.oversizedOptInByRootId,
    },
  });
}
