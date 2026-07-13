import type { HookTrustRequest, RuntimeData } from '@brainstrike/assistant-contract';
import type {
  RuntimeAssistantMemorySettings,
  RuntimeAssistantObservationalMemorySettings,
  RuntimeAssistantSemanticRecallSettings,
} from '@brainstrike/assistant-contract/memory-settings';
import type { PermissionToolGateSnapshotInput } from '@brainstrike/preferences/stores/permission-policy-store';
import { useMemo } from 'react';
import {
  buildAssistantRequestData,
  type RuntimeMemoryOptions,
} from '../assistant-ui-panel-wrapper-runtime';

interface UseAssistantThreadRequestDataArgs {
  readonly agentLoopSettings: RuntimeData['agentLoop'] | undefined;
  readonly enabledNativeToolIds: readonly string[];
  /**
   * Opt-in hook-trust attestation; only set on the desktop data-stream
   * transport (web has no hook runner). The server re-hashes disk independently.
   */
  readonly hookTrustRequest?: HookTrustRequest | undefined;
  readonly hostedMemoryBackendAvailable: boolean;
  readonly memoryOptions: RuntimeMemoryOptions;
  readonly memoryResourceId: string | undefined;
  readonly modelSettings: RuntimeData['modelSettings'] | undefined;
  readonly observationalMemorySettings: RuntimeAssistantObservationalMemorySettings;
  /**
   * Opt-in permission snapshot; only set (non-undefined) when the user enabled
   * enforcement AND this is the desktop data-stream transport. Passthrough
   * otherwise.
   */
  readonly permissionPolicyRequest: PermissionToolGateSnapshotInput | undefined;
  /** Plan mode (opt-in); forwarded to the request only when `true`. */
  readonly planMode?: boolean;
  readonly providerOptions: Record<string, unknown> | undefined;
  readonly runtimeWorkspaceContext: RuntimeData['workspaceContext'] | null;
  readonly selectedMemoryThreadId: string | undefined;
  readonly selectionData: {
    readonly filePaths: string[];
    readonly folderId: string | null | undefined;
  };
  readonly semanticRecallSettings: RuntimeAssistantSemanticRecallSettings;
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
  enabledNativeToolIds,
  hostedMemoryBackendAvailable,
  hookTrustRequest,
  memoryOptions,
  memoryResourceId,
  modelSettings,
  observationalMemorySettings,
  permissionPolicyRequest,
  planMode,
  providerOptions,
  runtimeWorkspaceContext,
  selectedMemoryThreadId,
  selectionData,
  semanticRecallSettings,
  subagentPersonasRequest,
  workspaceInstructionsPreference,
  workspaceIndex,
  workspaceRootPath,
}: UseAssistantThreadRequestDataArgs): UseAssistantThreadRequestDataResult {
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
        enabledNativeToolIds,
        hookTrustRequest,
        hostedMemoryBackendAvailable,
        memoryOptions,
        memoryResourceId,
        memorySettings: runtimeMemorySettings,
        modelSettings,
        permissionPolicyRequest,
        ...(planMode ? { planMode: true } : {}),
        providerOptions,
        selectedMemoryThreadId,
        selectionData,
        workspaceContext: runtimeWorkspaceContext,
        ...(subagentPersonasRequest ? { subagentPersonasRequest } : {}),
        ...(workspaceInstructionsPreference ? { workspaceInstructionsPreference } : {}),
        workspaceIndex,
        workspaceRootPath,
      }),
    [
      agentLoopSettings,
      enabledNativeToolIds,
      hookTrustRequest,
      hostedMemoryBackendAvailable,
      memoryOptions,
      memoryResourceId,
      modelSettings,
      permissionPolicyRequest,
      planMode,
      providerOptions,
      runtimeMemorySettings,
      selectedMemoryThreadId,
      selectionData,
      runtimeWorkspaceContext,
      subagentPersonasRequest,
      workspaceInstructionsPreference,
      workspaceIndex,
      workspaceRootPath,
    ]
  );

  return { requestData, runtimeMemorySettings };
}
