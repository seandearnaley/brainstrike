// @vitest-environment node
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-resource';
import { expect, test, vi } from 'vitest';
import { borrowedLocalInference } from '../agent-host-platform/desktop-node-platform';
import type { DesktopRunSelection } from '../agent-host-platform/desktop-run-admission';

const settings: DesktopRunSelection['memory']['settings'] = {
  observationalMemory: {
    enabled: true,
    messageTokens: 30_000,
    modelTarget: 'local/gemma-observer',
    observationTokens: 40_000,
    retrievalMode: 'off',
    scope: 'thread',
  },
  semanticRecall: {
    embeddingModelTarget: null,
    enabled: false,
    messageRange: 0,
    scope: 'resource',
    topK: 1,
  },
};

/** A hosted chat run whose observer is local: only the observer may borrow the llm-host. */
function selection(): DesktopRunSelection {
  return {
    close: async () => undefined,
    configuration: { model: 'gpt-6-sol', provider: 'openai' },
    contextWindow: 128_000,
    durableConfiguration: {},
    freshWorkspaceRoots: async () => [],
    inputTokenLimit: 64_000,
    maxSteps: 1,
    memory: {
      options: {
        lastMessages: 4,
        workingMemory: { enabled: false, scope: 'thread', template: '' },
      },
      settings,
    },
    nativeRuntime: { provider: 'openai', workspaceRoots: [] },
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    tools: {},
    toolTimeoutMs: 5000,
  };
}

/**
 * BST-1930 stage e: the host's admission decides which local models may borrow
 * Main's hidden hosts (ADR-0007); Main no longer holds the selection to check.
 */
test('only the admission’s own local observer or chat model borrows the llm-host, and recall needs its plan', async () => {
  const request = vi.fn(async () => ({
    finishReason: 'stop',
    text: 'observed',
    usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 },
  }));
  const local = borrowedLocalInference(request, new Map(), selection());

  await expect(local.llm.warmup('another-local-model')).rejects.toThrow(
    'Local generation is not part of this admitted thread selection'
  );
  await expect(
    local.llm.generate({ messages: [], modelId: 'another-local-model' })
  ).rejects.toThrow('Local generation is not part of this admitted thread selection');
  await expect(
    local.embedding.queryEmbedding({
      dimensions: 8,
      modelId: 'recall-model',
      modelKey: 'local::recall-model',
      query: 'recall',
    })
  ).rejects.toThrow('Local embedding is not part of this admitted thread selection');
  expect(request).not.toHaveBeenCalled();

  await local.llm.generate({ messages: [], modelId: 'gemma-observer' });
  expect(request).toHaveBeenCalledWith(
    'platform/llm/generate',
    expect.objectContaining({ modelId: 'gemma-observer' }),
    undefined
  );
});
