import {
  buildAgentLoopSettings,
  buildAssistantMemoryOptions,
  buildDraftRuntimeForProvider,
} from '@brainstrike/app-shell';
import { useAssistantMemoryPreferencesStore } from '@brainstrike/app-state/stores/assistant-memory-preferences-store';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { useAssistantSubagentPreferencesStore } from '@brainstrike/app-state/stores/assistant-subagent-preferences-store';
import { useNativeToolPreferencesStore } from '@brainstrike/app-state/stores/native-tool-preferences-store';
import { getPermissionToolGateSnapshotInput } from '@brainstrike/app-state/stores/permission-policy-store';
import {
  buildSkillsContextRequest,
  useSkillsPreferencesStore,
} from '@brainstrike/app-state/stores/skills-preferences-store';
import { useSubagentPersonasStore } from '@brainstrike/app-state/stores/subagent-personas-store';
import { useWorkspaceInstructionsPreferencesStore } from '@brainstrike/app-state/stores/workspace-instructions-preferences-store';
import {
  DESKTOP_NATIVE_TOOL_IDS,
  isSupportedProvider,
  LOCAL_DESKTOP_NATIVE_TOOL_IDS,
  type OpenRouterModelMetadataLookup,
} from '@brainstrike/assistant-contract';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import {
  captureDesktopHostIntent,
  type DesktopHostModelProjection,
} from '../agent-host-platform/desktop-host-intent';

export type { DesktopHostModelProjection } from '../agent-host-platform/desktop-host-intent';

/**
 * Capture intent for the composer's model (`provider::model`, ADR-0019: the
 * host thread's selection or the user's pick) from the same stores used by the
 * existing assistant. `openRouterLookup` is the composer's OpenRouter metadata:
 * the efforts it offered are validated against that same metadata, as the
 * legacy Send did.
 */
export function readDesktopHostConfiguration(
  threadId: string,
  composite: string,
  selectionFolderId: string | null,
  projection?: DesktopHostModelProjection,
  openRouterLookup?: OpenRouterModelMetadataLookup
): Record<string, unknown> {
  const preferences = useAssistantPreferencesStore.getState();
  const separator = composite.indexOf('::');
  const provider = composite.slice(0, separator);
  if (separator < 1 || !isSupportedProvider(provider)) {
    throw new Error('The selected model has no supported provider');
  }
  const threadDraft = useAssistantThreadStore.getState().draftRuntimeByThreadId[threadId];
  const providerSettings = { ...preferences.providerSettings, ...threadDraft?.providerSettings };
  const draft = buildDraftRuntimeForProvider({
    model: composite.slice(separator + 2),
    openRouterLookup,
    provider,
    providerSettingsMap: providerSettings,
  });
  // The raw settings map contains transport credentials in some integrations;
  // only the existing generation-option projection belongs in the event log.
  const { providerSettings: _providerSettings, ...modelConfiguration } = draft;
  // Session grants on host threads are host facts, never captured from this store.
  const { sessionGrants: _sessionGrants, ...permission } = getPermissionToolGateSnapshotInput();
  const personas = useSubagentPersonasStore.getState();
  const instructions = useWorkspaceInstructionsPreferencesStore.getState();
  // The built-in local model gets its own small tool surface, as the legacy composer offers it.
  const offeredNativeToolIds: readonly string[] =
    provider === 'local' ? LOCAL_DESKTOP_NATIVE_TOOL_IDS : DESKTOP_NATIVE_TOOL_IDS;
  return captureDesktopHostIntent({
    agentLoop: projection?.agentLoop ?? buildAgentLoopSettings(providerSettings[provider]),
    enabledNativeToolIds: offeredNativeToolIds.filter((id) =>
      useNativeToolPreferencesStore.getState().isToolEnabled(id)
    ),
    memoryOptions: buildAssistantMemoryOptions(providerSettings[provider]),
    memorySettings: useAssistantMemoryPreferencesStore.getState().getRuntimeMemorySettings(),
    modelConfiguration,
    permission,
    projection,
    selectionFolderId,
    skillsPreference: buildSkillsContextRequest(useSkillsPreferencesStore.getState()),
    subagents: {
      delegationEnabled: personas.delegationEnabled,
      disabledPersonaIds: [...personas.disabledPersonaIds],
      settings: useAssistantSubagentPreferencesStore.getState().settings,
    },
    threadDraft,
    workspaceInstructionsPreference: {
      masterEnabled: instructions.masterEnabled,
      oversizedOptInByRootId: instructions.oversizedOptInByRootId,
    },
  });
}
