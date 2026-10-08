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
import {
  buildSkillsContextRequest,
  useSkillsPreferencesStore,
} from '@brainstrike/app-state/stores/skills-preferences-store';
import { useWorkspaceInstructionsPreferencesStore } from '@brainstrike/app-state/stores/workspace-instructions-preferences-store';
import { DESKTOP_NATIVE_TOOL_IDS, isSupportedProvider } from '@brainstrike/assistant-contract';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import { useWorkspaceContextCurationStore } from '@brainstrike/file-explorer-ui/preview';
import {
  captureDesktopHostIntent,
  type DesktopHostModelProjection,
} from '../agent-host-platform/desktop-host-intent';

export type { DesktopHostModelProjection } from '../agent-host-platform/desktop-host-intent';

export function readDesktopHostModel(threadId: string): string {
  const draft = useAssistantThreadStore.getState().draftRuntimeByThreadId[threadId];
  const composite =
    draft?.provider && draft.model
      ? `${draft.provider}::${draft.model}`
      : useAssistantPreferencesStore.getState().selectedModel;
  if (!composite) {
    throw new Error('Select a provider and model before sending');
  }
  const separator = composite.indexOf('::');
  const provider = composite.slice(0, separator);
  if (separator < 1 || !isSupportedProvider(provider)) {
    throw new Error('The selected model has no supported provider');
  }
  return composite;
}

/** Capture intent at Send from the same stores used by the existing assistant. */
export function readDesktopHostConfiguration(
  threadId: string,
  selectionFolderId: string | null,
  projection?: DesktopHostModelProjection
): Record<string, unknown> {
  const preferences = useAssistantPreferencesStore.getState();
  const composite = readDesktopHostModel(threadId);
  const separator = composite.indexOf('::');
  const provider = composite.slice(0, separator);
  if (!isSupportedProvider(provider)) {
    throw new Error('The selected model has no supported provider');
  }
  const threadDraft = useAssistantThreadStore.getState().draftRuntimeByThreadId[threadId];
  const providerSettings = { ...preferences.providerSettings, ...threadDraft?.providerSettings };
  const draft = buildDraftRuntimeForProvider({
    model: composite.slice(separator + 2),
    provider,
    providerSettingsMap: providerSettings,
  });
  // The raw settings map contains transport credentials in some integrations;
  // only the existing generation-option projection belongs in the event log.
  const { providerSettings: _providerSettings, ...modelConfiguration } = draft;
  const permission = getPermissionToolGateSnapshotInput();
  const instructions = useWorkspaceInstructionsPreferencesStore.getState();
  const workspaceContext = toRuntimeWorkspaceContext(
    useWorkspaceContextCurationStore.getState().contextSnapshot,
    selectionFolderId
  );
  return captureDesktopHostIntent({
    agentLoop: projection?.agentLoop ?? buildAgentLoopSettings(providerSettings[provider]),
    enabledNativeToolIds: DESKTOP_NATIVE_TOOL_IDS.filter((id) =>
      useNativeToolPreferencesStore.getState().isToolEnabled(id)
    ),
    memoryOptions: buildAssistantMemoryOptions(providerSettings[provider]),
    memorySettings: useAssistantMemoryPreferencesStore.getState().getRuntimeMemorySettings(),
    modelConfiguration,
    permission,
    projection,
    selectionFolderId,
    skillsPreference: buildSkillsContextRequest(useSkillsPreferencesStore.getState()),
    threadDraft,
    workspaceContext,
    workspaceInstructionsPreference: {
      masterEnabled: instructions.masterEnabled,
      oversizedOptInByRootId: instructions.oversizedOptInByRootId,
    },
  });
}
