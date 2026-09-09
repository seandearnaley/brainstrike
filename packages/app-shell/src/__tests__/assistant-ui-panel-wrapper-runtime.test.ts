import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAgentLoopSettings,
  buildAssistantMemoryOptions,
  buildAssistantRequestData,
  buildAssistantTapestryRange,
  buildDraftRuntimeForProvider,
  buildEffectiveModelSettings,
  buildEnabledModelIdSet,
  buildModelSettings,
  buildProviderOptions,
  buildProviderOptionsWhenReady,
  createAssistantThreadRunPromise,
  extractPreparedRunId,
  formatToolLabel,
  getEnabledBuiltInLocalRegistryModelIds,
  hasContextBreakdownChannel,
  hasValidProviderModelSelection,
  isLocalRuntimeProvider,
  type LocalRuntimeModelCatalogMap,
  pickContextMeterUsage,
  reconcileProviderSettingsForModel,
  resolveAdvertisedNativeToolIds,
  resolveAssistantMemoryDisabledReason,
  resolveAssistantOperatingRootBinding,
  resolveAssistantProviderDisabledReason,
  resolveComposerAttachmentsAvailability,
  resolveHostedMemoryBackendAvailable,
  resolveModelNameFromComposite,
  resolveOpenRouterMetadataDisabledReason,
  resolveProviderModelSelection,
  toRuntimeProviderModels,
} from '../assistant-ui-panel-wrapper-runtime';

describe('pickContextMeterUsage', () => {
  it('uses the latest provider step while retaining aggregate run usage for billing', () => {
    expect(
      pickContextMeterUsage({
        contextInputTokens: 28_400,
        contextOutputTokens: 900,
        inputTokens: 138_800,
        outputTokens: 4100,
      })
    ).toEqual({ inputTokens: 28_400, outputTokens: 900 });
  });

  it('uses aggregate usage when a transport has no per-step context fields', () => {
    expect(pickContextMeterUsage({ inputTokens: 50, outputTokens: 20 })).toEqual({
      inputTokens: 50,
      outputTokens: 20,
    });
  });
});

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
    deleteThread: async () => {},
    getCrossRootUsage: async () => [],
    getThreadCumulativeUsage: async () => null,
    listLatestThreadRuns: async () => [],
    listMessages: async () => [],
    listThreadCheckpoints: vi.fn(async () => []),
    listThreadRunEvents: async () => [],
    listThreads: async () => [],
    recordRunUsage: async () => {},
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
  memoryLoadState: { status: 'ready' as const },
  memorySettings: DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  providerKeySources: [{ provider: 'openai' as const, source: 'stored' as const }],
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
  it('advertises only runtime-available eager-core tools for local desktop chat', () => {
    const localToolIds = resolveAdvertisedNativeToolIds({
      desktopBridgeAvailable: true,
      selectedProvider: 'local',
    });

    expect(localToolIds).toEqual([
      'brainstrike.executeCommand',
      'brainstrike.globWorkspace',
      'brainstrike.grepSearch',
      'brainstrike.readWorkspaceFile',
      'brainstrike.stringReplaceWorkspaceFile',
    ]);
  });

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
        memoryLoadState: { error: 'bad schema', status: 'error' },
      })
    ).toBe('Assistant memory failed to load: bad schema');
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        desktopAssistantBackendAvailable: false,
      })
    ).toBe('Assistant memory for hosted providers requires the desktop assistant backend.');
  });

  it('blocks hosted providers without a memory backend when no workspace root is open', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        desktopAssistantBackendAvailable: false,
        workspaceRootPath: null,
      })
    ).toBe('Assistant memory for hosted providers requires the desktop assistant backend.');
  });

  it('shares one capability predicate between the composer gate and request data', () => {
    expect(
      resolveHostedMemoryBackendAvailable({
        desktopAssistantBackendAvailable: false,
        selectedProvider: 'local',
      })
    ).toBe(true);
    expect(
      resolveHostedMemoryBackendAvailable({
        desktopAssistantBackendAvailable: false,
        selectedProvider: 'openai',
      })
    ).toBe(false);
    expect(
      resolveHostedMemoryBackendAvailable({
        desktopAssistantBackendAvailable: true,
        selectedProvider: 'openai',
      })
    ).toBe(true);
  });

  it('surfaces thread-memory failures even when no workspace root is open', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        memoryLoadState: { error: 'bad schema', status: 'error' },
        workspaceRootPath: null,
      })
    ).toBe('Assistant memory failed to load: bad schema');
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        selectedMemoryThreadId: undefined,
        workspaceRootPath: null,
      })
    ).toBe('Assistant memory has no selected thread for this workspace.');
  });

  it('leaves provider selection guidance authoritative when no provider is selected', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        desktopAssistantBackendAvailable: false,
        selectedProvider: null,
        workspaceRootPath: null,
      })
    ).toBeUndefined();
  });

  it.each(['idle', 'loading'] as const)(
    'keeps assistant memory disabled while restored thread metadata is %s',
    (status) => {
      expect(
        resolveAssistantMemoryDisabledReason({
          ...baseMemoryReasonArgs,
          memoryLoadState: { status },
        })
      ).toBe('Assistant memory is loading from PGlite.');
    }
  );

  it.each(['idle', 'loading'] as const)(
    'keeps zero-root restored threads disabled while thread metadata is %s',
    (status) => {
      expect(
        resolveAssistantMemoryDisabledReason({
          ...baseMemoryReasonArgs,
          memoryLoadState: { status },
          workspaceRootPath: null,
        })
      ).toBe('Assistant memory is loading from PGlite.');
    }
  );

  it.each(['idle', 'loading'] as const)(
    'surfaces database failures while thread metadata is %s',
    (status) => {
      expect(
        resolveAssistantMemoryDisabledReason({
          ...baseMemoryReasonArgs,
          dbError: new Error('open failed'),
          memoryLoadState: { status },
        })
      ).toBe('Assistant memory database failed to initialize: open failed');
    }
  );

  it('blocks unsupported semantic recall embedding providers', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        memorySettings: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          semanticRecall: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
            embeddingModelTarget: 'cohere/embed-english-v3.0',
            enabled: true,
          },
        },
      })
    ).toBe(
      'Semantic recall requires an OpenAI, Google, or built-in local embedding model. Reconfigure Assistant Memory settings.'
    );
  });

  it('blocks an enabled hosted observer whose provider has no configured key', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        memorySettings: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          observationalMemory: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
            enabled: true,
            modelTarget: 'anthropic/claude-haiku-4-5',
          },
        },
        providerKeySources: [{ provider: 'openai', source: 'stored' }],
      })
    ).toBe(
      'Observational memory requires a configured Anthropic API key. Configure it in Settings → Providers, choose a keyless local observer, or turn observations off.'
    );
  });

  it('surfaces an observer credential read failure before missing-key guidance', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        memorySettings: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          observationalMemory: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
            enabled: true,
            modelTarget: 'anthropic/claude-haiku-4-5',
          },
        },
        providerKeySources: [{ provider: 'openai', source: 'stored' }],
        providerReadErrors: {
          anthropic: 'The Anthropic API key could not be read from secure storage.',
        },
      })
    ).toBe('The Anthropic API key could not be read from secure storage.');
  });

  it('prefers the hosted-web backend reason when key provenance is unavailable', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        desktopAssistantBackendAvailable: false,
        memorySettings: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          observationalMemory: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
            enabled: true,
          },
        },
        providerKeySources: undefined,
      })
    ).toBe('Assistant memory for hosted providers requires the desktop assistant backend.');
  });

  it('does not treat unavailable key provenance as a validated empty key set', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        memorySettings: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          observationalMemory: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
            enabled: true,
          },
        },
        providerKeySources: undefined,
      })
    ).toBeUndefined();
  });

  it('blocks enabled semantic recall when its hosted embedder has no configured key', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        memorySettings: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          semanticRecall: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
            embeddingModelTarget: 'openai/text-embedding-3-small',
            enabled: true,
          },
        },
        providerKeySources: [{ provider: 'google', source: 'stored' }],
      })
    ).toBe(
      'Semantic recall requires a configured OpenAI API key. Configure it in Settings → Providers, choose a keyless local embedder, or turn semantic recall off.'
    );
  });

  it('surfaces an embedder credential read failure before missing-key guidance', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        memorySettings: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          semanticRecall: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
            embeddingModelTarget: 'google/gemini-embedding-001',
            enabled: true,
          },
        },
        providerKeySources: [{ provider: 'openai', source: 'stored' }],
        providerReadErrors: {
          google: 'The Google API key could not be read from secure storage.',
        },
      })
    ).toBe('The Google API key could not be read from secure storage.');
  });

  it('allows enabled semantic recall with a keyless local embedder', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        memorySettings: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          semanticRecall: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
            embeddingModelTarget: 'local/Xenova/all-MiniLM-L6-v2',
            enabled: true,
          },
        },
        providerKeySources: [],
      })
    ).toBeUndefined();
  });

  it('allows an enabled keyless local observer without a provider key source', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        memorySettings: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          observationalMemory: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
            enabled: true,
            modelTarget: 'local/onnx-community/gemma-4-E2B-it-ONNX',
          },
        },
        providerKeySources: [],
      })
    ).toBeUndefined();
  });

  it('blocks an enabled local observer when the desktop memory backend is unavailable', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        desktopAssistantBackendAvailable: false,
        memorySettings: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          observationalMemory: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
            enabled: true,
            modelTarget: 'local/onnx-community/gemma-4-E2B-it-ONNX',
          },
        },
        providerKeySources: [],
        selectedProvider: 'local',
      })
    ).toBe('Observational memory requires the desktop assistant backend.');
  });

  it('fails visibly when an enabled observer model target is malformed', () => {
    expect(
      resolveAssistantMemoryDisabledReason({
        ...baseMemoryReasonArgs,
        memorySettings: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          observationalMemory: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
            enabled: true,
            modelTarget: 'anthropic',
          },
        },
      })
    ).toBe(
      'Observational memory requires a valid provider/model target. Reconfigure Assistant Memory settings.'
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
            enabled: true,
            retrievalMode: 'vector',
          },
          semanticRecall: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
            embeddingModelTarget: 'cohere/embed-english-v3.0',
            enabled: false,
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
            enabled: true,
            retrievalMode: 'vector',
          },
          semanticRecall: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
            embeddingModelTarget: 'local/Xenova/all-MiniLM-L6-v2',
            enabled: false,
          },
        },
      })
    ).toBeUndefined();
  });

  it('creates assistant thread run records with copied settings', async () => {
    const createThreadRun = vi.fn(async (input) => ({
      completedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      error: null,
      id: input.id,
      model: input.model,
      provider: input.provider,
      resourceId: input.resourceId,
      runtimeKind: input.runtimeKind,
      startedAt: input.startedAt ?? new Date('2026-01-01T00:00:00Z'),
      status: input.status ?? 'running',
      threadId: input.threadId,
      turnMessageId: input.turnMessageId ?? null,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    }));
    const modelSettings = {
      frequencyPenalty: -0.25,
      maxOutputTokens: 512,
      presencePenalty: 0.5,
      temperature: 0.3,
      topP: 0.9,
    };
    const providerOptions = { openai: { reasoningEffort: 'high' } };

    const runId = await createAssistantThreadRunPromise({
      assistantThreadRepository: createRepositoryStub(createThreadRun),
      memoryResourceId: 'workspace-a',
      modelSettings,
      providerOptions,
      resolvedModelName: 'gpt-5.2',
      selectedMemoryThreadId: 'thread-1',
      selectedProvider: 'openai',
      turnMessageId: 'msg-user-7',
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
        // BST-1163: the run-turn link rides the sole-runId-producer seam.
        turnMessageId: 'msg-user-7',
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
        turnMessageId: null,
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

  // BST-1652: the render-time builder must never produce a permission snapshot.
  // `prepareRequestData` (use-assistant-request-lifecycle.ts) is the sole
  // producer — it reads the live store at request-composition time and sets the
  // field unconditionally, so anything built here would be overwritten while
  // still costing the wrapper a store subscription. Its own suite
  // ("permission-policy freshness at the request-composition seam") pins the
  // producing half; this pins that no second producer reappears here.
  it('never attaches permissionPolicyRequest (owned by the request-composition seam)', () => {
    const data = buildAssistantRequestData({
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
    });

    expect(data).not.toHaveProperty('permissionPolicyRequest');
  });

  it('attaches planMode only when true (presence-means-on, no false residue)', () => {
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

    expect(buildAssistantRequestData(baseArgs)).not.toHaveProperty('planMode');
    expect(buildAssistantRequestData({ ...baseArgs, planMode: false })).not.toHaveProperty(
      'planMode'
    );
    expect(buildAssistantRequestData({ ...baseArgs, planMode: true })['planMode']).toBe(true);
  });

  it('attaches workspaceInstructionsPreference only when provided (desktop transport gate)', () => {
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

    // Absent (web / non-data-stream) → nothing attached.
    expect(buildAssistantRequestData(baseArgs)).not.toHaveProperty(
      'workspaceInstructionsPreference'
    );

    const preference = { masterEnabled: true, oversizedOptInByRootId: { 'root-a': true } };
    expect(
      buildAssistantRequestData({ ...baseArgs, workspaceInstructionsPreference: preference })[
        'workspaceInstructionsPreference'
      ]
    ).toEqual(preference);

    // Agent Skills preference rides the same opt-in gate: absent → nothing
    // attached; present → the exact snapshot.
    expect(buildAssistantRequestData(baseArgs)).not.toHaveProperty('skillsPreference');
    const skillsPreference = {
      disabledSkillKeys: ['root:root-a:pdf-processing'],
      masterEnabled: true,
    };
    expect(
      buildAssistantRequestData({ ...baseArgs, skillsPreference })['skillsPreference']
    ).toEqual(skillsPreference);

    // Self-improvement signal preference rides the same desktop-only request
    // attachment seam: absent on web/non-data-stream, exact snapshot when opted in.
    expect(buildAssistantRequestData(baseArgs)).not.toHaveProperty(
      'selfImprovementSignalPreference'
    );
    const selfImprovementSignalPreference = { enabled: true };
    expect(
      buildAssistantRequestData({ ...baseArgs, selfImprovementSignalPreference })[
        'selfImprovementSignalPreference'
      ]
    ).toEqual(selfImprovementSignalPreference);

    // Experiment enrollment (BST-1251) rides the same opt-in seam: absent →
    // nothing attached (un-enrolled); present → the exact complete pair.
    expect(buildAssistantRequestData(baseArgs)).not.toHaveProperty('experimentAssignment');
    const experimentAssignment = { experimentId: 'search-policy-v1', variant: 'control' };
    expect(
      buildAssistantRequestData({ ...baseArgs, experimentAssignment })['experimentAssignment']
    ).toEqual(experimentAssignment);
  });

  it('attaches mainRootId/mainRootPath only when provided (multi-root main declaration)', () => {
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

    // No mounted roots (or single-root legacy) → neither field rides the wire.
    const withoutMain = buildAssistantRequestData(baseArgs);
    expect(withoutMain).not.toHaveProperty('mainRootId');
    expect(withoutMain).not.toHaveProperty('mainRootPath');

    // Main root declared → both fields attach verbatim.
    const withMain = buildAssistantRequestData({
      ...baseArgs,
      mainRootId: 'root-a',
      mainRootPath: '/Users/me/ProjectA',
    });
    expect(withMain['mainRootId']).toBe('root-a');
    expect(withMain['mainRootPath']).toBe('/Users/me/ProjectA');

    // The id can attach without a path (web FSA descriptor with no absolute
    // path) — the server's path fallback simply has nothing to match.
    const idOnly = buildAssistantRequestData({ ...baseArgs, mainRootId: 'root-a' });
    expect(idOnly['mainRootId']).toBe('root-a');
    expect(idOnly).not.toHaveProperty('mainRootPath');
  });

  it('attaches the durable thread root binding only when provided', () => {
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

    expect(buildAssistantRequestData(baseArgs)).not.toHaveProperty('boundWorkspaceRootId');
    expect(
      buildAssistantRequestData({
        ...baseArgs,
        boundWorkspaceRootId: 'root-a',
      })['boundWorkspaceRootId']
    ).toBe('root-a');
  });

  it('keeps a persisted thread root when the workspace Main root later changes', () => {
    expect(
      resolveAssistantOperatingRootBinding({
        currentMainRoot: {
          displayName: 'ProjectB',
          path: '/Users/me/ProjectB',
          rootId: 'root-b',
        },
        threadMetadata: {
          operatingRootDisplayName: 'ProjectA',
          operatingRootId: 'root-a',
          operatingRootPath: '/Users/me/ProjectA',
        },
      })
    ).toEqual({
      displayName: 'ProjectA',
      path: '/Users/me/ProjectA',
      persisted: true,
      rootId: 'root-a',
    });
  });

  it('rejects incomplete persisted thread-root metadata instead of retargeting to Main', () => {
    expect(() =>
      resolveAssistantOperatingRootBinding({
        currentMainRoot: {
          displayName: 'ProjectB',
          path: '/Users/me/ProjectB',
          rootId: 'root-b',
        },
        threadMetadata: {
          operatingRootId: 'root-a',
        },
      })
    ).toThrow('Assistant thread operating-root metadata is incomplete.');
  });

  it('attaches subagentPersonasRequest only when provided (desktop transport gate)', () => {
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

    // Absent (defaults / web / non-data-stream) -> nothing attached.
    expect(buildAssistantRequestData(baseArgs)).not.toHaveProperty('subagentPersonasRequest');

    const request = { delegationEnabled: false, disabledPersonaIds: ['explore'] };
    expect(
      buildAssistantRequestData({ ...baseArgs, subagentPersonasRequest: request })[
        'subagentPersonasRequest'
      ]
    ).toEqual(request);
  });

  it('attaches hookTrustRequest only when provided (desktop transport gate)', () => {
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

    // Absent (web / non-data-stream) → nothing attached.
    expect(buildAssistantRequestData(baseArgs)).not.toHaveProperty('hookTrustRequest');

    const request = { approvals: [{ approvedAt: 1, rootId: 'r1', sha256: 'hash-1' }] };
    expect(
      buildAssistantRequestData({ ...baseArgs, hookTrustRequest: request })['hookTrustRequest']
    ).toEqual(request);
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
      providerOptions: undefined,
      selectedMemoryThreadId: undefined,
      selectionData: { filePaths: ['src/a.ts'], folderId: 'root-a', otherRootsCount: 0 },
      workspaceContext: null,
      workspaceIndex: baseWorkspaceIndex,
      workspaceRootPath: '/workspace',
    });
    expect(dataWithoutOthers).not.toHaveProperty('selectionFilePathsFromOtherRoots');
  });

  it('resolves provider model selections', () => {
    const models = [
      {
        contextWindow: 200_000,
        default: false,
        id: 'fast',
        label: 'Fast',
        type: 'llm' as const,
        vision: 'supported' as const,
      },
    ];
    expect(
      resolveProviderModelSelection({
        getProviderLlmModels: () => models,
        isModelEnabled: (_provider, modelId) => modelId === 'fast',
        provider: 'openai',
      })
    ).toBe('fast');
    expect(
      hasValidProviderModelSelection({
        currentProvider: 'openai',
        currentSelectedModel: 'openai::fast',
        isModelEnabled: (_provider, modelId) => modelId === 'fast',
        providerModelIds: ['fast'],
      })
    ).toBe(true);
    expect(
      hasValidProviderModelSelection({
        currentProvider: 'openai',
        currentSelectedModel: 'openai::stale',
        isModelEnabled: () => true,
        providerModelIds: ['fixed'],
      })
    ).toBe(false);
  });

  it('maps loaded local runtime catalogs into LLM provider models', () => {
    const catalog: LocalRuntimeModelCatalogMap = {
      ollama: {
        availability: {
          checkedAt: 1,
          endpoint: 'http://localhost',
          latencyMs: 1,
          state: 'available',
        },
        checkedAt: 1,
        endpoint: 'http://localhost',
        freshness: 'live',
        models: [
          {
            capabilities: { embeddings: 'unsupported', llm: true, vision: 'supported' },
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
            capabilities: { embeddings: 'supported', llm: false, vision: 'unsupported' },
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
        runtime: 'ollama',
        source: 'ollama_api_tags',
        state: 'loaded_non_empty',
      },
    };

    // Vision rides through from the runtime-reported capability so the
    // composer attachment gate can read it off the synthesized definition.
    expect(toRuntimeProviderModels('ollama', catalog)).toEqual([
      expect.objectContaining({ default: true, id: 'llama', vision: 'supported' }),
    ]);
    expect(
      buildEnabledModelIdSet({
        configuredProviders: ['local'],
        enabledModelsByProvider: {
          anthropic: [],
          bedrock: [],
          cohere: [],
          google: [],
          lmstudio: [],
          local: ['local-gemma'],
          ollama: [],
          openai: [],
          'openai-codex': [],
          openrouter: [],
          voyage: [],
        },
        localRuntimeModels: catalog,
        registryEnabledModelIds: new Set(['registry-model']),
        shouldFallbackToPreferences: false,
      })
    ).toEqual(new Set(['registry-model', 'local-gemma', 'llama']));
  });

  it('filters built-in local registry model ids and extracts prepared run ids', () => {
    expect(isLocalRuntimeProvider('lmstudio')).toBe(true);
    expect(
      getEnabledBuiltInLocalRegistryModelIds({ 'local-a': true, 'local-b': false }, [
        {
          capabilities: { type: 'llm' },
          id: 'local-a',
          isEnabled: true,
          providerId: 'local',
        },
        {
          capabilities: { type: 'llm' },
          id: 'local-b',
          isEnabled: true,
          providerId: 'local',
        },
      ])
    ).toEqual(['local-a']);
    expect(extractPreparedRunId({ memory: { runId: ' run-1 ' } })).toBe(' run-1 ');
    expect(extractPreparedRunId({ memory: { runId: ' ' } })).toBeNull();
  });

  /**
   * BST-1699: OpenAI `gpt-6-astra`, the latest Gemini models and Anthropic
   * Opus 4.7+ (and its Bedrock Fable 5.1 route) reject or deprecate
   * non-default `temperature` / `top_p` / `top_k`. `buildModelSettings` is the
   * ONLY producer of `RuntimeData.modelSettings` for an ordinary assistant
   * run, so this is where a sampling default would enter every provider's
   * request at once. It must stay an output-budget-only projection: the key
   * SET is asserted, not just the values, so a new sampling key cannot be
   * added without this failing. (A user CAN still set `temperature`/`topP`
   * deliberately through a Prompt Workbench prompt item — that path is
   * explicit and separate.)
   */
  it('projects only the output budget into model settings (no sampling params)', () => {
    const populated = {
      agentInputTokenLimit: 2048,
      agentMaxSteps: 4,
      anthropicEffort: 'high',
      maxOutputTokens: 4096,
      reasoningEffort: 'high',
      reasoningSummary: 'detailed',
    } as unknown as Parameters<typeof buildModelSettings>[0];
    expect(buildModelSettings(populated)).toEqual({ maxOutputTokens: 4096 });
    expect(Object.keys(buildModelSettings(populated) ?? {})).toEqual(['maxOutputTokens']);
    expect(buildModelSettings(undefined)).toBeUndefined();
    expect(buildModelSettings({} as Parameters<typeof buildModelSettings>[0])).toBeUndefined();
  });

  it('builds provider-specific model, agent loop, and provider options', () => {
    expect(buildModelSettings({ maxOutputTokens: 42.9 })).toEqual({ maxOutputTokens: 42 });
    expect(buildAgentLoopSettings({ agentInputTokenLimit: 2048.2, agentMaxSteps: 4.8 })).toEqual({
      inputTokenLimit: 2048,
      maxSteps: 4,
    });
    expect(
      buildProviderOptions('anthropic', 'claude-sonnet-4-6', {
        anthropicEffort: 'high',
        anthropicThinkingBudgetTokens: 1024.8,
      })
    ).toEqual({
      anthropic: { effort: 'high', thinking: { budgetTokens: 1024, type: 'enabled' } },
    });
    expect(
      buildProviderOptions('openrouter', 'meta/muse-spark-1.1', {
        reasoningEffort: 'high',
        reasoningSummary: 'detailed',
      })
    ).toEqual({
      openrouter: {
        provider: { require_parameters: true },
        reasoning: { effort: 'high', summary: 'detailed' },
      },
    });
    expect(
      buildProviderOptions('openrouter', 'moonshotai/kimi-k3', {
        reasoningEffort: 'max',
      })
    ).toEqual({
      openrouter: {
        provider: { require_parameters: true },
        reasoning: { effort: 'max' },
      },
    });
    expect(buildProviderOptions('openrouter', 'moonshotai/kimi-k3', {})).toEqual({
      openrouter: {
        provider: { require_parameters: true },
        reasoning: { effort: 'low' },
      },
    });
    // Auto now follows GLM's declared `defaultEffort` instead of being coerced
    // to `none` because it advertises no low tier (BST-833).
    expect(buildProviderOptions('openrouter', 'z-ai/glm-5.2', {})).toEqual({
      openrouter: {
        provider: { require_parameters: true },
        reasoning: { effort: 'high' },
      },
    });
    expect(
      buildProviderOptionsWhenReady(
        'OpenRouter Auto output limit cannot reserve a final answer.',
        'openrouter',
        'moonshotai/kimi-k3',
        {},
        {
          snapshot: {
            freshness: 'live',
            metadata: {
              checkedAt: 42,
              contextWindow: 32_768,
              id: 'moonshotai/kimi-k3',
              maxOutputTokens: 8192,
              reasoning: {
                defaultEffort: 'minimal',
                defaultEnabled: true,
                mandatory: false,
                supportedEfforts: ['minimal'],
                supportsMaxTokens: false,
              },
              source: 'openrouter-models-api',
              supportedParameters: ['reasoning', 'max_tokens'],
            },
          },
          state: 'resolved',
        }
      )
    ).toBeUndefined();
    expect(
      buildProviderOptions(
        'openrouter',
        'moonshotai/kimi-k3',
        {},
        {
          checkedAt: 42,
          contextWindow: 1_048_576,
          id: 'moonshotai/kimi-k3',
          reasoning: {
            defaultEffort: 'max',
            defaultEnabled: true,
            mandatory: false,
            supportedEfforts: ['max', 'high', 'low'],
            supportsMaxTokens: false,
          },
          source: 'openrouter-models-api',
          supportedParameters: ['reasoning', 'max_tokens'],
        }
      )
    ).toEqual({
      openrouter: {
        provider: { require_parameters: true },
        reasoning: { effort: 'low' },
      },
    });
    expect(
      buildProviderOptions('openrouter', 'z-ai/glm-5.2', {
        reasoningEffort: 'none',
      })
    ).toEqual({
      openrouter: {
        provider: { require_parameters: true },
        reasoning: { enabled: false },
      },
    });
    expect(
      buildProviderOptions('openrouter', 'moonshotai/kimi-k3', {
        reasoningEffort: 'high',
      })
    ).toEqual({
      openrouter: {
        provider: { require_parameters: true },
        reasoning: { effort: 'high' },
      },
    });
    const partialKimiMetadata = {
      checkedAt: 42,
      contextWindow: 1_048_576,
      id: 'moonshotai/kimi-k3',
      reasoning: {
        defaultEnabled: true,
        mandatory: false,
        supportsMaxTokens: false,
      },
      source: 'openrouter-models-api' as const,
      supportedParameters: ['reasoning'],
    };
    expect(() =>
      buildProviderOptions(
        'openrouter',
        'moonshotai/kimi-k3',
        { reasoningEffort: 'high' },
        partialKimiMetadata
      )
    ).toThrow(/does not declare support.*high/i);
    expect(
      buildProviderOptions(
        'openrouter',
        'moonshotai/kimi-k3',
        { reasoningEffort: 'none' },
        partialKimiMetadata
      )
    ).toEqual({
      openrouter: {
        provider: { require_parameters: true },
        reasoning: { enabled: false },
      },
    });
    expect(() =>
      buildProviderOptions('openrouter', 'meta/muse-spark-1.1', {
        reasoningEffort: 'none',
      })
    ).toThrow(/Muse Spark 1\.1.*does not support.*none/i);
    expect(() =>
      buildProviderOptions('openrouter', 'moonshotai/kimi-k2.6', {
        reasoningEffort: 'max',
      })
    ).toThrow(/Kimi K2\.6.*does not declare.*reasoning effort/i);
    expect(
      reconcileProviderSettingsForModel('openrouter', 'moonshotai/kimi-k3', {
        maxOutputTokens: 2048,
        reasoningEffort: 'high',
      })
    ).toEqual({ maxOutputTokens: 2048, reasoningEffort: 'high' });
    expect(
      reconcileProviderSettingsForModel('openrouter', 'moonshotai/kimi-k3', {
        reasoningEffort: 'max',
      })
    ).toEqual({ reasoningEffort: 'max' });
    expect(
      reconcileProviderSettingsForModel('openrouter', 'moonshotai/kimi-k2.6', {
        maxOutputTokens: 2048,
        reasoningEffort: 'max',
      })
    ).toEqual({ maxOutputTokens: 2048 });
    expect(
      reconcileProviderSettingsForModel('openrouter', 'nvidia/nemotron-3.5-lightning', {
        reasoningEffort: 'none',
      })
    ).toEqual({ reasoningEffort: 'none' });
    expect(
      reconcileProviderSettingsForModel('openrouter', 'google/gemini-2.5-flash', {
        maxOutputTokens: 128_000,
      })
    ).toEqual({});
    expect(
      reconcileProviderSettingsForModel('openrouter', 'google/gemini-2.5-flash', {
        maxOutputTokens: 65_536,
      })
    ).toEqual({ maxOutputTokens: 65_536 });
    expect(
      reconcileProviderSettingsForModel('openrouter', 'custom/unknown-model', {
        maxOutputTokens: 128_000,
      })
    ).toEqual({ maxOutputTokens: 128_000 });
    expect(
      reconcileProviderSettingsForModel('google', 'gemini-3.7-flash', {
        googleThinkingLevel: 'minimal',
        maxOutputTokens: 2048,
      })
    ).toEqual({ maxOutputTokens: 2048 });
    expect(
      reconcileProviderSettingsForModel('google', 'gemini-3.7-flash', {
        googleThinkingLevel: 'low',
      })
    ).toEqual({ googleThinkingLevel: 'low' });
    expect(
      reconcileProviderSettingsForModel('google', 'gemini-3.5-flash', {
        googleThinkingLevel: 'minimal',
      })
    ).toEqual({ googleThinkingLevel: 'minimal' });
    expect(
      buildProviderOptions('ollama', 'llama', {
        localRuntimeBaseUrl: ' http://127.0.0.1:11434 ',
      })
    ).toEqual({ ollama: { baseUrl: 'http://127.0.0.1:11434' } });
  });

  it('builds an OpenRouter thread draft from the same live metadata used by its settings UI', () => {
    expect(
      buildDraftRuntimeForProvider({
        model: 'openai/gpt-5.6-terra',
        openRouterLookup: {
          snapshot: {
            freshness: 'live',
            metadata: {
              checkedAt: 42,
              contextWindow: 1_050_000,
              id: 'openai/gpt-5.6-terra',
              maxOutputTokens: 128_000,
              reasoning: {
                defaultEffort: 'medium',
                defaultEnabled: true,
                mandatory: false,
                supportedEfforts: ['max', 'xhigh', 'high', 'medium', 'low', 'none'],
                supportsMaxTokens: false,
              },
              source: 'openrouter-models-api',
              supportedParameters: ['reasoning', 'max_tokens'],
            },
          },
          state: 'resolved',
        },
        provider: 'openrouter',
        providerSettingsMap: {
          openrouter: { reasoningEffort: 'medium' },
        },
      })
    ).toMatchObject({
      providerOptions: {
        openrouter: {
          provider: { require_parameters: true },
          reasoning: { effort: 'medium' },
        },
      },
    });
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
    expect(
      resolveAssistantProviderDisabledReason({
        configuredProviders: ['openrouter'],
        currentModel: 'openrouter::openai/gpt-5.4-mini',
        getProviderLlmModels: () => [],
        localRuntimeHint: undefined,
        providerHasEnabledModels: () => true,
        providerReadErrors: {
          openrouter: 'Stored OpenRouter key is unreadable. Re-enter it to repair access.',
        },
        selectedProvider: 'openrouter',
      })
    ).toBe('Stored OpenRouter key is unreadable. Re-enter it to repair access.');
  });
});

describe('buildAgentLoopSettings input-token budget', () => {
  it('reserves the model-aware OpenRouter coding default instead of the model maximum', () => {
    const settings = buildAgentLoopSettings(
      undefined,
      { contextWindow: 400_000, maxOutputTokens: 128_000 },
      'openrouter'
    );

    // The coding default is min(model output limit, 32,000). The 5% safety margin is 20,000.
    expect(settings?.inputTokenLimit).toBe(348_000);
  });

  it('caps the OpenRouter coding default to a smaller model output limit', () => {
    const settings = buildAgentLoopSettings(
      undefined,
      { contextWindow: 64_000, maxOutputTokens: 16_000 },
      'openrouter'
    );

    expect(settings?.inputTokenLimit).toBe(44_800);
  });

  it('reserves the configured OpenRouter output limit in the input budget', () => {
    const settings = buildAgentLoopSettings(
      { maxOutputTokens: 8192 },
      { contextWindow: 400_000, maxOutputTokens: 128_000 },
      'openrouter'
    );

    expect(settings?.inputTokenLimit).toBe(371_808);
  });

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
      { agentInputTokenLimit: 50_000, agentMaxSteps: 5 },
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

describe('buildEffectiveModelSettings', () => {
  it('applies the OpenRouter coding default when the user leaves output on Auto', () => {
    expect(
      buildEffectiveModelSettings('openrouter', undefined, {
        contextWindow: 262_144,
        maxOutputTokens: 128_000,
      })
    ).toEqual({ maxOutputTokens: 32_000 });
  });

  it('caps Auto to the selected OpenRouter model and preserves explicit overrides', () => {
    const model = { contextWindow: 32_768, maxOutputTokens: 16_384 };
    expect(buildEffectiveModelSettings('openrouter', undefined, model)).toEqual({
      maxOutputTokens: 16_384,
    });
    expect(buildEffectiveModelSettings('openrouter', { maxOutputTokens: 2048 }, model)).toEqual({
      maxOutputTokens: 2048,
    });
  });

  it('uses the coding output default without claiming a reasoning/final split', () => {
    expect(
      buildEffectiveModelSettings(
        'openrouter',
        undefined,
        { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
        {
          checkedAt: 42,
          contextWindow: 1_048_576,
          id: 'z-ai/glm-5.2',
          maxOutputTokens: 131_072,
          reasoning: {
            defaultEffort: 'high',
            defaultEnabled: true,
            mandatory: false,
            supportedEfforts: ['xhigh', 'high'],
            supportsMaxTokens: false,
          },
          source: 'openrouter-models-api',
          supportedParameters: ['reasoning', 'max_tokens'],
        }
      )
    ).toEqual({ maxOutputTokens: 32_000 });
  });

  it('uses the same coding output default while live metadata is pending', () => {
    expect(
      buildEffectiveModelSettings(
        'openrouter',
        undefined,
        { contextWindow: 1_048_576, maxOutputTokens: 131_072 },
        undefined,
        'z-ai/glm-5.2'
      )
    ).toEqual({ maxOutputTokens: 32_000 });
  });

  it('does not inject OpenRouter defaults into other providers', () => {
    expect(buildEffectiveModelSettings('anthropic', undefined)).toBeUndefined();
  });

  it('opens the vendor window for Kimi K3 whenever its reasoning is active (BST-1170)', () => {
    const model = { contextWindow: 1_048_576 };
    // Auto: the catalog's recorded low effort still reasons, so the window is
    // Moonshot's documented 131,072 — the 32K ceiling starved thinking+answer
    // and killed runs at `finishReason: length`.
    expect(
      buildEffectiveModelSettings('openrouter', undefined, model, undefined, 'moonshotai/kimi-k3')
    ).toEqual({ maxOutputTokens: 131_072 });
    // An explicit effort must size the same window — the run that motivated
    // this fix sent effort high with a 32,000 window.
    expect(
      buildEffectiveModelSettings(
        'openrouter',
        undefined,
        model,
        undefined,
        'moonshotai/kimi-k3',
        'high'
      )
    ).toEqual({ maxOutputTokens: 131_072 });
  });

  it('keeps the coding ceiling when Kimi K3 reasoning is explicitly off', () => {
    expect(
      buildEffectiveModelSettings(
        'openrouter',
        undefined,
        { contextWindow: 1_048_576 },
        undefined,
        'moonshotai/kimi-k3',
        'none'
      )
    ).toEqual({ maxOutputTokens: 32_000 });
  });

  it('merges the catalog vendor window over a live snapshot that cannot carry it', () => {
    expect(
      buildEffectiveModelSettings(
        'openrouter',
        undefined,
        { contextWindow: 1_048_576 },
        {
          checkedAt: 42,
          contextWindow: 1_048_576,
          id: 'moonshotai/kimi-k3',
          reasoning: {
            defaultEffort: 'max',
            defaultEnabled: true,
            mandatory: false,
            supportedEfforts: ['max', 'high', 'low'],
            supportsMaxTokens: false,
          },
          source: 'openrouter-models-api',
          supportedParameters: ['reasoning', 'max_tokens'],
        },
        'moonshotai/kimi-k3',
        'high'
      )
    ).toEqual({ maxOutputTokens: 131_072 });
  });

  it('still honours an explicit output limit over the vendor window', () => {
    expect(
      buildEffectiveModelSettings(
        'openrouter',
        { maxOutputTokens: 48_000 },
        { contextWindow: 1_048_576 },
        undefined,
        'moonshotai/kimi-k3',
        'high'
      )
    ).toEqual({ maxOutputTokens: 48_000 });
  });
});

describe('resolveOpenRouterMetadataDisabledReason', () => {
  it('reserves the reasoning window when validating the input budget (BST-1170)', () => {
    // Kimi K3: context 1,048,576, margin 52,429, vendor window 131,072 when
    // reasoning is active → effective input budget 865,075. Against the old
    // 32K reservation this input limit (900,000) would have passed, silently
    // promising context the run cannot actually use.
    expect(
      resolveOpenRouterMetadataDisabledReason(
        'openrouter',
        { agentInputTokenLimit: 900_000, reasoningEffort: 'high' },
        {
          snapshot: {
            freshness: 'live',
            metadata: {
              checkedAt: 42,
              contextWindow: 1_048_576,
              id: 'moonshotai/kimi-k3',
              reasoning: {
                defaultEffort: 'max',
                defaultEnabled: true,
                mandatory: false,
                supportedEfforts: ['max', 'high', 'low'],
                supportsMaxTokens: false,
              },
              source: 'openrouter-models-api',
              supportedParameters: ['reasoning', 'max_tokens'],
            },
          },
          state: 'resolved',
        }
      )
    ).toBe(
      'Configured input limit 900,000 exceeds OpenRouter live effective input budget 865,075.'
    );
  });

  it('blocks an explicitly configured output limit above the live model maximum', () => {
    expect(
      resolveOpenRouterMetadataDisabledReason(
        'openrouter',
        { maxOutputTokens: 200_000 },
        {
          snapshot: {
            freshness: 'live',
            metadata: {
              checkedAt: 42,
              contextWindow: 1_000_000,
              id: 'anthropic/claude-sonnet-4.6',
              maxOutputTokens: 128_000,
              source: 'openrouter-models-api',
              supportedParameters: [],
            },
          },
          state: 'resolved',
        }
      )
    ).toBe('Configured output limit 200,000 exceeds OpenRouter live maximum 128,000.');
  });

  it('does not block Auto output or a metadata lookup failure', () => {
    expect(
      resolveOpenRouterMetadataDisabledReason('openrouter', undefined, {
        message: 'unavailable',
        state: 'error',
      })
    ).toBeUndefined();
  });

  it('does not invent a final-answer reserve for effort-only models', () => {
    expect(
      resolveOpenRouterMetadataDisabledReason(
        'openrouter',
        { maxOutputTokens: 32_000 },
        {
          snapshot: {
            freshness: 'live',
            metadata: {
              checkedAt: 42,
              contextWindow: 1_048_576,
              id: 'z-ai/glm-5.2',
              maxOutputTokens: 131_072,
              reasoning: {
                defaultEffort: 'high',
                defaultEnabled: true,
                mandatory: false,
                supportedEfforts: ['xhigh', 'high'],
                supportsMaxTokens: false,
              },
              source: 'openrouter-models-api',
              supportedParameters: ['reasoning', 'max_tokens'],
            },
          },
          state: 'resolved',
        }
      )
    ).toBeUndefined();
  });

  it('blocks an explicitly configured input limit above the live effective budget', () => {
    expect(
      resolveOpenRouterMetadataDisabledReason(
        'openrouter',
        { agentInputTokenLimit: 390_000 },
        {
          snapshot: {
            freshness: 'live',
            metadata: {
              checkedAt: 42,
              contextWindow: 400_000,
              id: 'openai/gpt-5.4-mini',
              maxOutputTokens: 128_000,
              source: 'openrouter-models-api',
              supportedParameters: [],
            },
          },
          state: 'resolved',
        }
      )
    ).toBe(
      'Configured input limit 390,000 exceeds OpenRouter live effective input budget 348,000.'
    );
  });

  it('prefers a prompt draft output override over provider settings', () => {
    expect(
      resolveOpenRouterMetadataDisabledReason(
        'openrouter',
        { maxOutputTokens: 1024 },
        {
          snapshot: {
            freshness: 'live',
            metadata: {
              checkedAt: 42,
              contextWindow: 1_000_000,
              id: 'anthropic/claude-sonnet-4.6',
              maxOutputTokens: 128_000,
              source: 'openrouter-models-api',
              supportedParameters: [],
            },
          },
          state: 'resolved',
        },
        { maxOutputTokens: 200_000 }
      )
    ).toBe('Configured output limit 200,000 exceeds OpenRouter live maximum 128,000.');
  });
});

describe('resolveComposerAttachmentsAvailability', () => {
  it('hides the affordance entirely when the provider gate fails (built-in local provider)', () => {
    expect(
      resolveComposerAttachmentsAvailability({
        providerGateAvailable: false,
        selectedModel: { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', vision: 'supported' },
      })
    ).toBeUndefined();
  });

  it('enables attachments for a vision-capable model', () => {
    expect(
      resolveComposerAttachmentsAvailability({
        providerGateAvailable: true,
        selectedModel: { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', vision: 'supported' },
      })
    ).toEqual({ state: 'enabled' });
  });

  it('disables with a visible reason naming the model when vision is unsupported', () => {
    const availability = resolveComposerAttachmentsAvailability({
      providerGateAvailable: true,
      selectedModel: {
        id: 'qwen/qwen3-coder-next',
        label: 'Qwen3 Coder Next (OpenRouter)',
        vision: 'unsupported',
      },
    });
    expect(availability?.state).toBe('disabled');
    if (availability?.state !== 'disabled') {
      throw new Error('Expected disabled availability');
    }
    expect(availability.reason).toContain('Qwen3 Coder Next (OpenRouter)');
    expect(availability.reason).toMatch(/image/i);
  });

  it('falls back to the model id in the reason when no label exists', () => {
    const availability = resolveComposerAttachmentsAvailability({
      providerGateAvailable: true,
      selectedModel: { id: 'mystery-text-model', vision: 'unsupported' },
    });
    if (availability?.state !== 'disabled') {
      throw new Error('Expected disabled availability');
    }
    expect(availability.reason).toContain('mystery-text-model');
  });

  it('hasContextBreakdownChannel: false only for a local provider on the local-runtime transport', () => {
    expect(hasContextBreakdownChannel('local', 'local-runtime')).toBe(false);
  });

  it('hasContextBreakdownChannel: true for a local provider routed through data-stream (desktop)', () => {
    expect(hasContextBreakdownChannel('local', 'data-stream')).toBe(true);
  });

  it('hasContextBreakdownChannel: true for a hosted provider regardless of the local-runtime transport value', () => {
    expect(hasContextBreakdownChannel('openai', 'local-runtime')).toBe(true);
    expect(hasContextBreakdownChannel('openai', 'data-stream')).toBe(true);
  });

  it('hasContextBreakdownChannel: true with no selected provider', () => {
    expect(hasContextBreakdownChannel(null, 'local-runtime')).toBe(true);
  });

  it('stays optimistic for unknown vision support and unresolved model definitions', () => {
    // 'unknown' (runtime-discovered model with no capability signal) and a
    // missing definition (e.g. runtime catalog still loading) both enable the
    // affordance: a wrong guess surfaces as a visible provider error, never a
    // silently blocked composer.
    expect(
      resolveComposerAttachmentsAvailability({
        providerGateAvailable: true,
        selectedModel: { id: 'mystery-7b', label: 'Mystery 7B', vision: 'unknown' },
      })
    ).toEqual({ state: 'enabled' });
    expect(
      resolveComposerAttachmentsAvailability({
        providerGateAvailable: true,
        selectedModel: undefined,
      })
    ).toEqual({ state: 'enabled' });
  });
});

describe('reasoning visibility is consistent across providers', () => {
  // Reasoning DEPTH and reasoning VISIBILITY are orthogonal. Every provider
  // used to default to silence for a different reason, so a thinking
  // disclosure was empty on one provider and populated on another with no
  // explanation the user could act on.

  it('asks OpenAI for a reasoning summary by default', () => {
    expect(buildProviderOptions('openai', 'gpt-5.6-terra', { reasoningEffort: 'high' })).toEqual({
      openai: { reasoningEffort: 'high', reasoningSummary: 'auto' },
    });
  });

  it('asks Anthropic to return adaptive thinking by default', () => {
    expect(
      buildProviderOptions('anthropic', 'claude-sonnet-5', { anthropicEffort: 'high' })
    ).toEqual({
      anthropic: { effort: 'high', thinking: { display: 'summarized', type: 'adaptive' } },
    });
  });

  it('asks Google to include thoughts by default', () => {
    const options = buildProviderOptions('google', 'gemini-3-pro-preview', {
      googleThinkingLevel: 'high',
    });
    expect(options).toEqual({
      google: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } },
    });
  });

  it('adds nothing to a visible OpenRouter request — reasoning already returns', () => {
    // `provider.require_parameters` narrows routing to endpoints supporting
    // every supplied parameter, so the default path must not grow a field.
    expect(
      buildProviderOptions('openrouter', 'moonshotai/kimi-k3', { reasoningEffort: 'high' })
    ).toEqual({
      openrouter: {
        provider: { require_parameters: true },
        reasoning: { effort: 'high' },
      },
    });
  });

  it('suppresses OpenRouter reasoning with the documented exclude on opt-out', () => {
    expect(
      buildProviderOptions('openrouter', 'moonshotai/kimi-k3', {
        reasoningEffort: 'high',
        reasoningVisible: false,
      })
    ).toEqual({
      openrouter: {
        provider: { require_parameters: true },
        reasoning: { effort: 'high', exclude: true },
      },
    });
  });

  it('never excludes reasoning that is already switched off', () => {
    // Suppressing output for reasoning that will not happen is an incoherent
    // request, not a harmless one.
    const options = buildProviderOptions('openrouter', 'z-ai/glm-5.2', {
      reasoningEffort: 'none',
    });
    expect(options).toEqual({
      openrouter: {
        provider: { require_parameters: true },
        reasoning: { enabled: false },
      },
    });
  });

  it('honours an explicit opt-out on every provider', () => {
    expect(
      buildProviderOptions('openai', 'gpt-5.6-terra', {
        reasoningEffort: 'high',
        reasoningVisible: false,
      })
    ).toEqual({ openai: { reasoningEffort: 'high' } });
    expect(
      buildProviderOptions('anthropic', 'claude-sonnet-5', {
        anthropicEffort: 'high',
        reasoningVisible: false,
      })
    ).toEqual({
      anthropic: { effort: 'high', thinking: { display: 'omitted', type: 'adaptive' } },
    });
    expect(
      buildProviderOptions('google', 'gemini-3-pro-preview', {
        googleThinkingLevel: 'high',
        reasoningVisible: false,
      })
    ).toEqual({ google: { thinkingConfig: { includeThoughts: false, thinkingLevel: 'high' } } });
    expect(
      buildProviderOptions('openrouter', 'moonshotai/kimi-k3', {
        reasoningEffort: 'high',
        reasoningVisible: false,
      })
    ).toEqual({
      openrouter: {
        provider: { require_parameters: true },
        reasoning: { effort: 'high', exclude: true },
      },
    });
  });

  it('lets a provider-specific setting win over the cross-provider default', () => {
    expect(
      buildProviderOptions('openai', 'gpt-5.6-terra', {
        reasoningEffort: 'high',
        reasoningSummary: 'detailed',
      })
    ).toEqual({ openai: { reasoningEffort: 'high', reasoningSummary: 'detailed' } });
    expect(
      buildProviderOptions('anthropic', 'claude-sonnet-5', {
        anthropicThinkingBudgetTokens: 2048,
      })
    ).toEqual({ anthropic: { thinking: { budgetTokens: 2048, type: 'enabled' } } });
    expect(
      buildProviderOptions('google', 'gemini-3-pro-preview', {
        googleIncludeThoughts: false,
        googleThinkingLevel: 'high',
      })
    ).toEqual({ google: { thinkingConfig: { includeThoughts: false, thinkingLevel: 'high' } } });
  });
});
