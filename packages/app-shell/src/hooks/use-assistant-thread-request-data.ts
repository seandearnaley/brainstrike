import { useAssistantSubagentPreferencesStore } from '@brainstrike/app-state/stores/assistant-subagent-preferences-store';
import type { RuntimeData } from '@brainstrike/assistant-contract';
import type {
  RuntimeAssistantMemorySettings,
  RuntimeAssistantObservationalMemorySettings,
  RuntimeAssistantSemanticRecallSettings,
} from '@brainstrike/assistant-contract/memory-settings';
import { useMemo } from 'react';
import {
  buildAssistantRequestData,
  type RuntimeMemoryOptions,
} from '../assistant-ui-panel-wrapper-runtime';

interface UseAssistantThreadRequestDataArgs {
  readonly agentLoopSettings: RuntimeData['agentLoop'] | undefined;
  readonly boundWorkspaceRootId?: string | undefined;
  readonly enabledNativeToolIds: readonly string[];
  /**
   * Opt-in experiment enrollment (desktop data-stream only, BST-1251).
   * Attribution metadata recorded on the run's treatment row; requires both
   * fields, so callers pass a complete pair or nothing.
   */
  readonly experimentAssignment?: RuntimeData['experimentAssignment'];
  readonly hostedMemoryBackendAvailable: boolean;
  /**
   * The client's declared MAIN root (activeRootIds[0]); ordering hint for the
   * server's workspace-root enrichment. Never a path; never a security
   * boundary. Absent when no roots are mounted.
   */
  readonly mainRootId?: string | undefined;
  /** Absolute path of the declared main root (server path-fallback matcher). */
  readonly mainRootPath?: string | undefined;
  readonly memoryOptions: RuntimeMemoryOptions;
  readonly memoryResourceId: string | undefined;
  readonly modelSettings: RuntimeData['modelSettings'] | undefined;
  readonly observationalMemorySettings: RuntimeAssistantObservationalMemorySettings;
  /** Plan mode (opt-in); forwarded to the request only when `true`. */
  readonly planMode?: boolean;
  readonly providerOptions: Record<string, unknown> | undefined;
  /** Explicit selection only; absent means Auto. */
  readonly requestedReasoningEffort?: RuntimeData['requestedReasoningEffort'];
  readonly runtimeWorkspaceContext: RuntimeData['workspaceContext'] | null;
  readonly selectedMemoryThreadId: string | undefined;
  readonly selectionData: {
    readonly filePaths: string[];
    readonly folderId: string | null | undefined;
  };
  /** Desktop-only opt-in self-improvement signal preference. */
  readonly selfImprovementSignalPreference?: RuntimeData['selfImprovementSignalPreference'];
  readonly semanticRecallSettings: RuntimeAssistantSemanticRecallSettings;
  /**
   * Opt-in Agent Skills preference; only set on the desktop data-stream
   * transport (web has no skills engine). Passthrough otherwise.
   */
  readonly skillsPreference?: RuntimeData['skillsPreference'];
  /**
   * Opt-in workspace instructions preference; only set on the desktop
   * data-stream transport (web has no injection path). Passthrough otherwise.
   */
  readonly subagentPersonasRequest?: RuntimeData['subagentPersonasRequest'];
  readonly workspaceIndex: {
    readonly blockedReason: RuntimeData['workspaceIndexBlockedReason'] | null;
    readonly enabled: boolean;
    readonly embeddingSetId: string | null;
    readonly lastError: RuntimeData['workspaceIndexLastError'] | null;
    readonly mode: string;
    readonly paused: boolean;
    readonly queueProgress: RuntimeData['workspaceIndexQueueProgress'] | null;
    readonly statusState: RuntimeData['workspaceIndexStatusState'];
  };
  readonly workspaceInstructionsPreference?: RuntimeData['workspaceInstructionsPreference'];
  readonly workspaceRootPath: string | null;
}

interface UseAssistantThreadRequestDataResult {
  readonly requestData: Record<string, unknown>;
  readonly runtimeMemorySettings: RuntimeAssistantMemorySettings;
}

export function useAssistantThreadRequestData({
  agentLoopSettings,
  boundWorkspaceRootId,
  enabledNativeToolIds,
  experimentAssignment,
  hostedMemoryBackendAvailable,
  mainRootId,
  mainRootPath,
  memoryOptions,
  memoryResourceId,
  modelSettings,
  observationalMemorySettings,
  planMode,
  providerOptions,
  requestedReasoningEffort,
  runtimeWorkspaceContext,
  selectedMemoryThreadId,
  selectionData,
  semanticRecallSettings,
  selfImprovementSignalPreference,
  skillsPreference,
  subagentPersonasRequest,
  workspaceInstructionsPreference,
  workspaceIndex,
  workspaceRootPath,
}: UseAssistantThreadRequestDataArgs): UseAssistantThreadRequestDataResult {
  // Per-child subagent budgets ride every request (`runtimeData.subagentSettings`).
  // Read here, not in the panel wrapper, which holds a shrink-only line budget.
  const subagentSettings = useAssistantSubagentPreferencesStore((state) => state.settings);
  const runtimeMemorySettings = useMemo(
    () => ({
      observationalMemory: observationalMemorySettings,
      semanticRecall: semanticRecallSettings,
    }),
    [observationalMemorySettings, semanticRecallSettings]
  );

  const requestData = useMemo(
    () =>
      buildAssistantRequestData({
        agentLoopSettings,
        ...(boundWorkspaceRootId ? { boundWorkspaceRootId } : {}),
        enabledNativeToolIds,
        ...(experimentAssignment ? { experimentAssignment } : {}),
        hostedMemoryBackendAvailable,
        ...(mainRootId ? { mainRootId } : {}),
        ...(mainRootPath ? { mainRootPath } : {}),
        memoryOptions,
        memoryResourceId,
        memorySettings: runtimeMemorySettings,
        modelSettings,
        ...(planMode ? { planMode: true } : {}),
        providerOptions,
        requestedReasoningEffort,
        selectedMemoryThreadId,
        selectionData,
        ...(selfImprovementSignalPreference ? { selfImprovementSignalPreference } : {}),
        workspaceContext: runtimeWorkspaceContext,
        ...(skillsPreference ? { skillsPreference } : {}),
        ...(subagentPersonasRequest ? { subagentPersonasRequest } : {}),
        subagentSettings,
        ...(workspaceInstructionsPreference ? { workspaceInstructionsPreference } : {}),
        workspaceIndex,
        workspaceRootPath,
      }),
    [
      agentLoopSettings,
      boundWorkspaceRootId,
      enabledNativeToolIds,
      experimentAssignment,
      hostedMemoryBackendAvailable,
      mainRootId,
      mainRootPath,
      memoryOptions,
      memoryResourceId,
      modelSettings,
      planMode,
      providerOptions,
      requestedReasoningEffort,
      runtimeMemorySettings,
      selectedMemoryThreadId,
      selectionData,
      runtimeWorkspaceContext,
      selfImprovementSignalPreference,
      skillsPreference,
      subagentPersonasRequest,
      subagentSettings,
      workspaceInstructionsPreference,
      workspaceIndex,
      workspaceRootPath,
    ]
  );

  return { requestData, runtimeMemorySettings };
}
