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
  readonly enabledNativeToolIds: readonly string[];
  readonly hostedMemoryBackendAvailable: boolean;
  readonly memoryOptions: RuntimeMemoryOptions;
  readonly memoryResourceId: string | undefined;
  readonly modelSettings: RuntimeData['modelSettings'] | undefined;
  readonly observationalMemorySettings: RuntimeAssistantObservationalMemorySettings;
  readonly providerOptions: Record<string, unknown> | undefined;
  readonly runtimeWorkspaceContext: RuntimeData['workspaceContext'] | null;
  readonly selectedMemoryThreadId: string | undefined;
  readonly selectionData: {
    readonly filePaths: string[];
    readonly folderId: string | null | undefined;
  };
  readonly semanticRecallSettings: RuntimeAssistantSemanticRecallSettings;
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
  memoryOptions,
  memoryResourceId,
  modelSettings,
  observationalMemorySettings,
  providerOptions,
  runtimeWorkspaceContext,
  selectedMemoryThreadId,
  selectionData,
  semanticRecallSettings,
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
        hostedMemoryBackendAvailable,
        memoryOptions,
        memoryResourceId,
        memorySettings: runtimeMemorySettings,
        modelSettings,
        providerOptions,
        selectedMemoryThreadId,
        selectionData,
        workspaceContext: runtimeWorkspaceContext,
        workspaceIndex,
        workspaceRootPath,
      }),
    [
      agentLoopSettings,
      enabledNativeToolIds,
      hostedMemoryBackendAvailable,
      memoryOptions,
      memoryResourceId,
      modelSettings,
      providerOptions,
      runtimeMemorySettings,
      selectedMemoryThreadId,
      selectionData,
      runtimeWorkspaceContext,
      workspaceIndex,
      workspaceRootPath,
    ]
  );

  return { requestData, runtimeMemorySettings };
}
