import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { PermissionToolGateSnapshotInput } from '@brainstrike/preferences/stores/permission-policy-store';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantThreadRepository } from '../assistant-memory-repository';
import {
  buildAgentLoopSettings,
  buildAssistantMemoryOptions,
  buildAssistantRequestData,
  buildAssistantTapestryRange,
  buildEnabledModelIdSet,
  buildModelSettings,
  buildProviderOptions,
  createAssistantThreadRunPromise,
  extractPreparedRunId,
  formatToolLabel,
  getEnabledBuiltInLocalRegistryModelIds,
  hasValidProviderModelSelection,
  isLocalRuntimeProvider,
  type LocalRuntimeModelCatalogMap,
  resolveAssistantMemoryDisabledReason,
  resolveAssistantProviderDisabledReason,
  resolveLocalRuntimeSelection,
  resolveModelNameFromComposite,
  resolveProviderModelSelection,
  toRuntimeProviderModels,
} from '../assistant-ui-panel-wrapper-runtime';

function createRepositoryStub(
  createThreadRun: AssistantThreadRepository['createThreadRun']
): AssistantThreadRepository {
  return {
    appendThreadRunEvent: async () => {},
    completeThreadRun: async () => {},
    createThread: async () => {
      throw new Error('not used');
    },
    createThreadRun,
    getThreadCumulativeUsage: async () => null,
    getCrossRootUsage: async () => [],
    recordRunUsage: async () => {},
    deleteThread: async () => {},
    listLatestThreadRuns: async () => [],
    listMessages: async () => [],
    listThreadRunEvents: async () => [],
    listThreads: async () => [],
    renameThread: async () => {},
    updateThreadMetadata: async () => {},
  };
}

const baseMemoryReasonArgs = {
  assistantThreadRepository: createRepositoryStub(async () => {
    throw new Error('not used');
  }),
  dbError: null,
  dbInitializing: false,
  desktopAssistantBackendAvailable: true,
  memorySettings: DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  memoryLoadState: { status: 'ready' as const },
  selectedMemoryThreadId: 'thread-1',
  selectedProvider: 'openai' as const,
  workspaceRootPath: '/workspace',
};

const baseWorkspaceIndex = {
  blockedReason: null,
  embeddingSetId: null,
  enabled: false,
  lastError: null,
  mode: 'manual',
  paused: false,
  queueProgress: null,
  statusState: 'idle' as const,
};

describe('buildAssistantTapestryRange color', () => {
  const base = {
    compositeKey: 'folder::/a.ts',
    endLine: 3,
    index: 0,
    isActive: true,
    startLine: 1,
  };

  it('uses the resolved hex when a named color is provided', () => {
    const range = buildAssistantTapestryRange({ ...base, color: 'blue' });
    expect(range.color).toBe('#3b82f6');
  });

  it('falls back to the deterministic color when color is omitted', () => {
    const range = buildAssistantTapestryRange(base);
    expect(range.color).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('assistant runtime helpers', () => {
  it('resolves model names from provider composites and formats tool labels', () => {
    expect(resolveModelNameFromComposite(undefined)).toBeUndefined();
    expect(resolveModelNameFromComposite('openai::gpt-5.2')).toBe('gpt-5.2');
    expect(resolveModelNameFromComposite('plain-model')).toBe('plain-model');
    expect(formatToolLabel('filesystem.search_files')).toBe('Search Files');
  });

  it('reports assistant memory disabled reasons in priority order', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        workspaceRootPath: null,
      })
    ).toBeUndefined();
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        dbError: new Error('open failed'),
      })
    ).toBe('Assistant memory database failed to initialize: open failed');
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        memoryLoadState: { status: 'error', error: 'bad schema' },
      })
    ).toBe('Assistant memory failed to load: bad schema');
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        desktopAssistantBackendAvailable: false,
      })
    ).toBe('Assistant memory for hosted providers requires the desktop assistant backend.');
  });

  it('blocks unsupported semantic recall embedding providers', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        memorySettings: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          semanticRecall: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
            enabled: true,
            embeddingModelTarget: 'cohere/embed-english-v3.0',
          },
        },
      })
    ).toBe(
      'Semantic recall requires an OpenAI, Google, or built-in local embedding model. Reconfigure Assistant Memory settings.'
    );
  });

  it('blocks observational vector retrieval when the recall embedder is unsupported, even with semantic recall off', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        memorySettings: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          observationalMemory: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
            retrievalMode: 'vector',
          },
          semanticRecall: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
            enabled: false,
            embeddingModelTarget: 'cohere/embed-english-v3.0',
          },
        },
      })
    ).toBe(
      'Semantic observation recall requires an OpenAI, Google, or built-in local embedding model. Configure one under Assistant Memory settings.'
    );

    // A supported embedder satisfies vector observation retrieval.
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        memorySettings: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          observationalMemory: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
            retrievalMode: 'vector',
          },
          semanticRecall: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
            enabled: false,
            embeddingModelTarget: 'local/Xenova/all-MiniLM-L6-v2',
          },
        },
      })
    ).toBeUndefined();
  });

  it('creates assistant thread run records with copied settings', async () => {
    const createThreadRun = vi.fn(async (input) => ({
      id: input.id,
      completedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      error: null,
      model: input.model,
      provider: input.provider,
      resourceId: input.resourceId,
      runtimeKind: input.runtimeKind,
      startedAt: input.startedAt ?? new Date('2026-01-01T00:00:00Z'),
      status: input.status ?? 'running',
      threadId: input.threadId,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    }));
    const modelSettings = { maxOutputTokens: 512 };
    const providerOptions = { openai: { reasoningEffort: 'high' } };

    const runId = await createAssistantThreadRunPromise({
      assistantThreadRepository: createRepositoryStub(createThreadRun),
      memoryResourceId: 'workspace-a',
      modelSettings,
      providerOptions,
      resolvedModelName: 'gpt-5.2',
      selectedMemoryThreadId: 'thread-1',
      selectedProvider: 'openai',
    });

    expect(runId).toMatch(/^run-/);
    expect(createThreadRun).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.2',
        modelSettings,
        provider: 'openai',
        providerOptions,
        resourceId: 'workspace-a',
        runtimeKind: 'hosted',
        threadId: 'thread-1',
      })
    );
  });

  it('requires memory thread and model context before creating a run record', () => {
    expect(() =>
      createAssistantThreadRunPromise({
        assistantThreadRepository: null,
        memoryResourceId: 'workspace-a',
        modelSettings: undefined,
        providerOptions: undefined,
        resolvedModelName: 'gpt-5.2',
        selectedMemoryThreadId: 'thread-1',
        selectedProvider: 'openai',
      })
    ).toThrow('Assistant run records require an active memory thread.');
  });

  it('builds assistant request data only for available optional runtime inputs', () => {
    const data = buildAssistantRequestData({
      agentLoopSettings: { maxSteps: 6 },
      enabledNativeToolIds: ['filesystem.read_file'],
      hostedMemoryBackendAvailable: true,
      memoryOptions: buildAssistantMemoryOptions({ memoryLastMessages: 0 }),
      memoryResourceId: 'workspace-a',
      memorySettings: DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
      modelSettings: { maxOutputTokens: 512 },
      permissionPolicyRequest: undefined,
      providerOptions: { openai: { reasoningEffort: 'medium' } },
      selectedMemoryThreadId: 'thread-1',
      selectionData: { filePaths: ['src/a.ts'], folderId: 'folder-a' },
      workspaceContext: {
        files: [],
        includeProjectTree: false,
        projectTreeApproxTokens: 0,
        projectTreeTokenCountLoading: false,
        selectedOutputApproxTokens: 0,
        selectedSourceApproxTokens: 0,
        useTapestryRanges: false,
      },
      workspaceIndex: {
        ...baseWorkspaceIndex,
        blockedReason: 'paused',
        embeddingSetId: 'embeddings-a',
        lastError: 'failed',
        queueProgress: { failed: 1, pending: 2, processed: 3, totalQueued: 6 },
      },
      workspaceRootPath: '/workspace',
    });

    expect(data).toMatchObject({
      agentLoop: { maxSteps: 6 },
      enabledNativeToolIds: ['filesystem.read_file'],
      memory: {
        resourceId: 'workspace-a',
        threadId: 'thread-1',
      },
      modelSettings: { maxOutputTokens: 512 },
      providerOptions: { openai: { reasoningEffort: 'medium' } },
      selectionFilePaths: ['src/a.ts'],
      selectionFolderId: 'folder-a',
      workspaceIndexBlockedReason: 'paused',
      workspaceIndexEmbeddingSetId: 'embeddings-a',
      workspaceIndexLastError: 'failed',
      workspaceRootPath: '/workspace',
    });
    // OPT-IN: no permission snapshot was passed → none is attached (passthrough).
    expect(data).not.toHaveProperty('permissionPolicyRequest');
  });

  it('attaches permissionPolicyRequest only when an opt-in snapshot is provided', () => {
    const baseArgs = {
      agentLoopSettings: { maxSteps: 6 },
      enabledNativeToolIds: [],
      hostedMemoryBackendAvailable: false,
      memoryOptions: buildAssistantMemoryOptions({ memoryLastMessages: 0 }),
      memoryResourceId: 'workspace-a',
      memorySettings: DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
      modelSettings: undefined,
      providerOptions: undefined,
      selectedMemoryThreadId: undefined,
      selectionData: { filePaths: [] as string[], folderId: undefined },
      workspaceContext: null,
      workspaceIndex: baseWorkspaceIndex,
      workspaceRootPath: '/workspace',
    };

    const withoutSnapshot = buildAssistantRequestData({
      ...baseArgs,
      permissionPolicyRequest: undefined,
    });
    expect(withoutSnapshot).not.toHaveProperty('permissionPolicyRequest');

    const snapshot: PermissionToolGateSnapshotInput = {
      enforce: true,
      policies: { read: 'allow', edit: 'deny', execute: 'ask', mcp: 'allow' },
      yolo: false,
      sessionGrants: ['execute'],
      perToolOverrides: {},
    };
    const withSnapshot = buildAssistantRequestData({
      ...baseArgs,
      permissionPolicyRequest: snapshot,
    });
    expect(withSnapshot['permissionPolicyRequest']).toEqual(snapshot);
  });

  it('surfaces the count of selected files from OTHER roots (multi-root, never silently dropped)', () => {
    const data = buildAssistantRequestData({
      agentLoopSettings: { maxSteps: 6 },
      enabledNativeToolIds: [],
      hostedMemoryBackendAvailable: false,
      memoryOptions: buildAssistantMemoryOptions({ memoryLastMessages: 0 }),
      memoryResourceId: 'workspace-a',
      memorySettings: DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
      modelSettings: undefined,
      permissionPolicyRequest: undefined,
      providerOptions: undefined,
      selectedMemoryThreadId: undefined,
      selectionData: { filePaths: ['src/a.ts'], folderId: 'root-a', otherRootsCount: 3 },
      workspaceContext: null,
      workspaceIndex: baseWorkspaceIndex,
      workspaceRootPath: '/workspace',
    });

    expect(data['selectionFilePathsFromOtherRoots']).toBe(3);

    const dataWithoutOthers = buildAssistantRequestData({
      agentLoopSettings: { maxSteps: 6 },
      enabledNativeToolIds: [],
      hostedMemoryBackendAvailable: false,
      memoryOptions: buildAssistantMemoryOptions({ memoryLastMessages: 0 }),
      memoryResourceId: 'workspace-a',
      memorySettings: DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
      modelSettings: undefined,
      permissionPolicyRequest: undefined,
      providerOptions: undefined,
      selectedMemoryThreadId: undefined,
      selectionData: { filePaths: ['src/a.ts'], folderId: 'root-a', otherRootsCount: 0 },
      workspaceContext: null,
      workspaceIndex: baseWorkspaceIndex,
      workspaceRootPath: '/workspace',
    });
    expect(dataWithoutOthers).not.toHaveProperty('selectionFilePathsFromOtherRoots');
  });

  it('resolves provider and local runtime model selections', () => {
    const models = [
      { id: 'fast', label: 'Fast', type: 'llm' as const, default: false, contextWindow: 200_000 },
    ];
    expect(
      resolveProviderModelSelection({
        provider: 'openai',
        getProviderLlmModels: () => models,
        isModelEnabled: (_provider, modelId) => modelId === 'fast',
      })
    ).toBe('fast');
    expect(
      hasValidProviderModelSelection({
        currentProvider: 'openai',
        currentSelectedModel: 'openai::fast',
        isModelEnabled: (_provider, modelId) => modelId === 'fast',
      })
    ).toBe(true);

    const selectModelForProvider = vi.fn();
    expect(
      resolveLocalRuntimeSelection({
        currentProvider: 'ollama',
        currentSelectedModel: null,
        isModelEnabled: () => false,
        providerHasEnabledModels: () => true,
        selectModelForProvider,
      })
    ).toBe(true);
    expect(selectModelForProvider).toHaveBeenCalledWith('ollama');
  });

  it('maps loaded local runtime catalogs into LLM provider models', () => {
    const catalog: LocalRuntimeModelCatalogMap = {
      ollama: {
        availability: {
          state: 'available',
          checkedAt: 1,
          endpoint: 'http://localhost',
          latencyMs: 1,
        },
        checkedAt: 1,
        endpoint: 'http://localhost',
        freshness: 'live',
        runtime: 'ollama',
        source: 'ollama_api_tags',
        state: 'loaded_non_empty',
        models: [
          {
            capabilities: { llm: true, embeddings: 'unsupported' },
            capabilitySource: 'provider_reported',
            dimensionsKnown: { state: 'not_applicable' },
            displayName: 'Llama',
            endpoint: 'http://localhost',
            freshness: 'live',
            modelId: 'llama',
            modelKey: 'ollama/llama',
            providerId: 'ollama',
            runtime: 'ollama',
            source: 'ollama_api_tags',
          },
          {
            capabilities: { llm: false, embeddings: 'supported' },
            capabilitySource: 'provider_reported',
            dimensionsKnown: { state: 'needs_verification' },
            displayName: 'Embed',
            endpoint: 'http://localhost',
            freshness: 'live',
            modelId: 'embed',
            modelKey: 'ollama/embed',
            providerId: 'ollama',
            runtime: 'ollama',
            source: 'ollama_api_tags',
          },
        ],
      },
    };

    expect(toRuntimeProviderModels('ollama', catalog)).toEqual([
      expect.objectContaining({ id: 'llama', default: true }),
    ]);
    expect(
      buildEnabledModelIdSet({
        shouldFallbackToPreferences: false,
        configuredProviders: ['local'],
        enabledModelsByProvider: {
          anthropic: [],
          cohere: [],
          google: [],
          local: ['local-gemma'],
          lmstudio: [],
          ollama: [],
          openai: [],
          openrouter: [],
          voyage: [],
        },
        registryEnabledModelIds: new Set(['registry-model']),
        localRuntimeModels: catalog,
      })
    ).toEqual(new Set(['registry-model', 'local-gemma', 'llama']));
  });

  it('filters built-in local registry model ids and extracts prepared run ids', () => {
    expect(isLocalRuntimeProvider('lmstudio')).toBe(true);
    expect(
      getEnabledBuiltInLocalRegistryModelIds({ 'local-a': true, 'local-b': false }, [
        {
          id: 'local-a',
          providerId: 'local',
          isEnabled: true,
          capabilities: { type: 'llm' },
        },
        {
          id: 'local-b',
          providerId: 'local',
          isEnabled: true,
          capabilities: { type: 'llm' },
        },
      ])
    ).toEqual(['local-a']);
    expect(extractPreparedRunId({ memory: { runId: ' run-1 ' } })).toBe(' run-1 ');
    expect(extractPreparedRunId({ memory: { runId: ' ' } })).toBeNull();
  });

  it('builds provider-specific model, agent loop, and provider options', () => {
    expect(buildModelSettings({ maxOutputTokens: 42.9 })).toEqual({ maxOutputTokens: 42 });
    expect(buildAgentLoopSettings({ agentMaxSteps: 4.8, agentInputTokenLimit: 2048.2 })).toEqual({
      maxSteps: 4,
      inputTokenLimit: 2048,
    });
    expect(
      buildProviderOptions('anthropic', 'claude-sonnet-4-5', {
        anthropicEffort: 'high',
        anthropicThinkingBudgetTokens: 1024.8,
      })
    ).toEqual({
      anthropic: { effort: 'high', thinking: { type: 'enabled', budgetTokens: 1024 } },
    });
    expect(
      buildProviderOptions('ollama', 'llama', {
        localRuntimeBaseUrl: ' http://127.0.0.1:11434 ',
      })
    ).toEqual({ ollama: { baseUrl: 'http://127.0.0.1:11434' } });
  });

  it('reports provider disabled reasons for unavailable provider states', () => {
    expect(
      resolveAssistantProviderDisabledReason({
        configuredProviders: [],
        currentModel: null,
        getProviderLlmModels: () => [],
        localRuntimeHint: 'Detected Ollama.',
        providerHasEnabledModels: () => false,
        selectedProvider: null,
      })
    ).toContain('Detected Ollama.');
    expect(
      resolveAssistantProviderDisabledReason({
        configuredProviders: ['openai'],
        currentModel: 'missing',
        getProviderLlmModels: () => [],
        localRuntimeHint: undefined,
        providerHasEnabledModels: () => false,
        selectedProvider: 'openai',
      })
    ).toBe('Enable at least one model for OpenAI to continue.');
  });
});

describe('buildAgentLoopSettings input-token budget', () => {
  it('auto-derives inputTokenLimit from the model contextWindow when the pref is unset', () => {
    // claude-sonnet-4-6: contextWindow=200k, maxOutputTokens=64k
    // budget = 200_000 − 64_000 − max(1024, ceil(200_000 × 0.05)) = 200_000 − 64_000 − 10_000 = 126_000
    const settings = buildAgentLoopSettings(
      { agentMaxSteps: 5 },
      { contextWindow: 200_000, maxOutputTokens: 64_000 }
    );
    expect(settings?.inputTokenLimit).toBe(126_000);
  });

  it('keeps an explicit user pref over the derived value', () => {
    const settings = buildAgentLoopSettings(
      { agentMaxSteps: 5, agentInputTokenLimit: 50_000 },
      { contextWindow: 200_000, maxOutputTokens: 64_000 }
    );
    expect(settings?.inputTokenLimit).toBe(50_000);
  });

  it('returns a result even when no steps pref is set (budget is the only output)', () => {
    const settings = buildAgentLoopSettings(undefined, {
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    });
    expect(settings?.inputTokenLimit).toBe(126_000);
    expect(settings?.maxSteps).toBeUndefined();
  });

  it('omits the derived limit when no model is selected', () => {
    const settings = buildAgentLoopSettings({ agentMaxSteps: 3 }, undefined);
    expect(settings?.inputTokenLimit).toBeUndefined();
    expect(settings?.maxSteps).toBe(3);
  });

  it('omits the derived limit when both prefs and model are absent', () => {
    const settings = buildAgentLoopSettings(undefined, undefined);
    expect(settings).toBeUndefined();
  });

  it('propagates deriveEffectiveInputBudget throw for a malformed contextWindow', () => {
    expect(() => buildAgentLoopSettings(undefined, { contextWindow: -1 })).toThrow(
      /contextWindow must be a positive number/
    );
  });

  it('uses conservative floor budget for dynamic local model definitions (32k context)', () => {
    // toRuntimeProviderModels sets contextWindow: 32_768, no maxOutputTokens
    // budget = 32_768 − 4_096 (DEFAULT) − max(1024, ceil(32_768 × 0.05)) = 32_768 − 4_096 − 1_639 = 27_033
    const settings = buildAgentLoopSettings(undefined, { contextWindow: 32_768 });
    expect(settings?.inputTokenLimit).toBe(27_033);
  });
});
