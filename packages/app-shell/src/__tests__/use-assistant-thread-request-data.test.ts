import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildAssistantMemoryOptions } from '../assistant-ui-panel-wrapper-runtime';
import { useAssistantThreadRequestData } from '../hooks/use-assistant-thread-request-data';

const baseWorkspaceIndex = {
  blockedReason: null,
  embeddingSetId: 'embedding-set-a',
  enabled: true,
  lastError: null,
  mode: 'automatic',
  paused: false,
  queueProgress: null,
  statusState: 'idle' as const,
};

const baseArgs = {
  agentLoopSettings: undefined,
  enabledNativeToolIds: ['filesystem.read_file'],
  hostedMemoryBackendAvailable: true,
  memoryOptions: buildAssistantMemoryOptions(undefined),
  memoryResourceId: 'workspace-a',
  modelSettings: {
    frequencyPenalty: -0.25,
    maxOutputTokens: 512,
    presencePenalty: 0.5,
    temperature: 0.3,
    topP: 0.9,
  },
  observationalMemorySettings: DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
  permissionPolicyRequest: undefined,
  providerOptions: { openai: { reasoningEffort: 'medium' } },
  runtimeWorkspaceContext: null,
  selectedMemoryThreadId: 'thread-a',
  selectionData: {
    filePaths: ['/workspace-a/src/app.ts'],
    folderId: null,
  },
  semanticRecallSettings: DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
  workspaceIndex: baseWorkspaceIndex,
  workspaceRootPath: '/workspace-a',
};

describe('useAssistantThreadRequestData', () => {
  it('builds request data with runtime memory settings when hosted memory is available', () => {
    const { result } = renderHook(() => useAssistantThreadRequestData(baseArgs));

    expect(result.current.runtimeMemorySettings).toEqual(DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS);
    expect(result.current.requestData).toMatchObject({
      enabledNativeToolIds: ['filesystem.read_file'],
      memory: {
        memoryOptions: buildAssistantMemoryOptions(undefined),
        memorySettings: DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
        resourceId: 'workspace-a',
        threadId: 'thread-a',
      },
      modelSettings: {
        frequencyPenalty: -0.25,
        maxOutputTokens: 512,
        presencePenalty: 0.5,
        temperature: 0.3,
        topP: 0.9,
      },
      providerOptions: { openai: { reasoningEffort: 'medium' } },
      selectionFilePaths: ['/workspace-a/src/app.ts'],
      workspaceIndexEmbeddingSetId: 'embedding-set-a',
      workspaceIndexingEnabled: true,
      workspaceIndexingMode: 'automatic',
      workspaceIndexingPaused: false,
      workspaceIndexStatusState: 'idle',
      workspaceRootPath: '/workspace-a',
    });
  });

  it('omits memory context when hosted memory is unavailable', () => {
    const { result } = renderHook(() =>
      useAssistantThreadRequestData({
        ...baseArgs,
        hostedMemoryBackendAvailable: false,
      })
    );

    expect(result.current.requestData['memory']).toBeUndefined();
    expect(result.current.runtimeMemorySettings).toEqual(DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS);
  });
});
