import type { MastraAgentRuntimeOptions, StreamChunk } from '@brainstrike/agent';
import {
  getProviderDefaultModel,
  resolveScaledToolResultBudget,
  resolveToolResultBudgetForModel,
  TOOL_RESULT_BUDGET_ANCHOR_CONTEXT_WINDOW,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import type { ScopedLogger } from '@brainstrike/logging';
import { describe, expect, it, vi } from 'vitest';
import {
  type AgentStreamMemoryResult,
  initializeAgentStream,
  resolveToolBuildBudget,
} from '../stream-init';

interface CapturedMemoryOptions {
  conversationBinding?: unknown;
  getDelegatedSystemContext?: () => readonly unknown[];
  toolOutputArtifactInlineMaxSerializedCharsByToolName?: ReadonlyMap<string, number>;
}

function requireCapturedMemoryOptions(
  value: CapturedMemoryOptions | undefined
): CapturedMemoryOptions {
  if (!value) {
    throw new Error('expected stream initialization to capture memory options');
  }
  return value;
}

const streamCapture = vi.hoisted(
  (): {
    approvalError: Error | undefined;
    memoryOptions: CapturedMemoryOptions | undefined;
  } => ({
    approvalError: undefined,
    memoryOptions: undefined,
  })
);

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return {
    ...actual,
    streamMastraChildFollowup: vi.fn((_input: unknown, options: CapturedMemoryOptions) => {
      streamCapture.memoryOptions = options;
      return (async function* emptyStream() {})();
    }),
    streamMastraToolApprovalAction: vi.fn(async (input, options: MastraAgentRuntimeOptions) => {
      streamCapture.memoryOptions = options;
      if (streamCapture.approvalError) {
        throw streamCapture.approvalError;
      }
      return actual.streamMastraToolApprovalAction(input, options);
    }),
    toAiSdkStyleStream: vi.fn(
      (
        _messages: unknown,
        _runtime: unknown,
        memoryOptions: typeof streamCapture.memoryOptions
      ) => {
        streamCapture.memoryOptions = memoryOptions;
        return (async function* emptyStream() {
          // The test only observes initialization options.
        })();
      }
    ),
  };
});

const logger = {
  warn: vi.fn(),
} as unknown as ScopedLogger;

const GENERATION_RECOVERY_MESSAGE =
  'This approval predates the background ledger upgrade and cannot resume safely. Stop or cancel the pending work, then start a new request.';

describe('resolveToolBuildBudget', () => {
  it('matches the runtime resolver for the same normalized provider and model', () => {
    const model = 'gpt-5.4-mini';

    expect(resolveToolBuildBudget({ model, provider: ' OpenAI ' }, logger)).toEqual(
      resolveToolResultBudgetForModel('openai', model)
    );
  });

  it('uses the same provider default model fallback as the runtime', () => {
    const model = getProviderDefaultModel('openai');
    expect(model).toBeDefined();

    expect(resolveToolBuildBudget({ provider: ' OPENAI ' }, logger)).toEqual(
      resolveToolResultBudgetForModel('openai', model ?? '')
    );
  });

  it.each([undefined, '', 'not-a-provider'])(
    'falls back visibly to the anchor for invalid provider %j',
    (provider) => {
      logger.warn = vi.fn();

      expect(resolveToolBuildBudget(provider === undefined ? {} : { provider }, logger)).toEqual(
        resolveScaledToolResultBudget(TOOL_RESULT_BUDGET_ANCHOR_CONTEXT_WINDOW)
      );
      expect(logger.warn).toHaveBeenCalledWith(
        'Cannot resolve tool-result budget for tool construction; using anchor fallback.',
        expect.objectContaining({
          code: 'tool_result_budget_invalid_provider_fallback',
        })
      );
    }
  );
});

describe('webExtract artifact settlement budget', () => {
  it.each([
    'fresh',
    'approval',
    'resume',
    'child-followup',
    'approval-unavailable',
    'resume-unavailable',
  ] as const)('threads host memory capabilities through %s initialization', async (kind) => {
    const unavailable = kind.endsWith('-unavailable');
    const approval = kind === 'approval' || kind === 'approval-unavailable';
    const resume = kind === 'resume' || kind === 'resume-unavailable';
    streamCapture.memoryOptions = undefined;
    streamCapture.approvalError = undefined;
    const passthroughStream = (stream: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> =>
      stream;
    const identity = {
      childRuntimeRunId: 'child-run',
      parentRuntimeRunId: 'parent-run',
      parentToolCallId: 'parent-call',
      personaId: 'worker',
    };
    const resolveToolAction = vi.fn(async () => [
      {
        configuration: unavailable
          ? {
              maxSteps: 3,
              persona: {
                allowedToolIds: ['brainstrike.readWorkspaceFile'],
                description: 'Inspect evidence',
                id: 'worker',
                instructions: 'PRIVATE_ADMITTED_INSTRUCTIONS',
                label: 'Worker',
                maxSteps: 3,
                mode: 'worker',
              },
            }
          : undefined,
        identity,
        resourceId: 'child-owner',
        threadId: 'child-thread',
      },
    ]);
    const conversationBinding = {
      bindRun: vi.fn(),
      inputProcessor: {},
      prepare: vi.fn(),
      resolveToolAction,
    };
    const memoryResult = {
      conversationBinding,
      memory: {},
      storage: {},
    } as unknown as AgentStreamMemoryResult;
    const target = {
      delegation: { path: [identity], toolCallId: 'leaf-call' },
      runId: 'parent-run',
      toolCallId: 'parent-call',
    };
    const capabilities = {
      artifacts: {
        createRepository: () => ({ readRange: vi.fn(), store: vi.fn() }),
      },
      compaction: {
        createContextOverflowRecovery: vi.fn(),
        runPreRequest: vi.fn(async () => ({ kind: 'noop' as const })),
      },
      contextInjectors: {
        activatedSkills: vi.fn(async (messages) => messages),
        referencedFiles: vi.fn(async (messages) => messages),
        selfImprovementSignal: vi.fn(async (messages) => messages),
        workspaceInstructions: vi.fn(async (messages) => [
          {
            id: 'trusted-workspace',
            parts: [{ text: 'TRUSTED_WORKSPACE_1723', type: 'text' }],
            role: 'system',
          },
          ...messages,
        ]),
      },
      hooks: {
        eventToAssistant: vi.fn(),
        finalize: vi.fn(passthroughStream),
        makeBlockedStream: vi.fn(),
        prepare: vi.fn(async () => ({ manager: {}, runner: undefined })),
        runUserPromptSubmitGate: vi.fn(async (_manager, messages) => ({
          kind: 'proceed' as const,
          messages,
        })),
      },
      memory: {
        create: vi.fn(async () => memoryResult),
        matchCredentialMissingError: vi.fn(),
      },
      personas: {
        createScanDeps: vi.fn(() => ({ dispose: vi.fn() })),
        resolve: vi.fn(async () => ({ personas: [] })),
        scan: vi.fn(),
      },
      readWorkspaceTextFile: vi.fn(),
      runPersistence: {
        observeRunEvents: passthroughStream,
        persistChildRunUsage: passthroughStream,
        persistTokenEstimateCalibration: passthroughStream,
        persistToolCallTelemetry: passthroughStream,
        recordHookRunOutcome: vi.fn(),
      },
      skills: {
        createFs: vi.fn(() => ({})),
        prepare: vi.fn(() => ({})),
      },
      taskList: { read: vi.fn(async () => []) },
      tools: { build: vi.fn(() => ({})) },
      webExtractInlineMaxSerializedChars: 2400,
      workspaceRoots: {
        enrich: vi.fn(async (runtimeData) => runtimeData),
        matchBoundRootUnavailableError: vi.fn(),
      },
    };

    const result = await initializeAgentStream({
      apiKey: undefined,
      capabilities,
      childFollowupAction:
        kind === 'child-followup'
          ? { id: 'followup', text: 'Inspect @evidence.md', threadId: 'child' }
          : undefined,
      getDatabase: vi.fn(async () => ({})),
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      } as unknown as ScopedLogger,
      mcpConfig: undefined,
      messages:
        kind === 'child-followup'
          ? [
              {
                id: 'client-system',
                parts: [{ text: 'CLIENT_SUPPLIED_SYSTEM_MUST_NOT_CROSS', type: 'text' }],
                role: 'system',
              },
            ]
          : [],
      resolveProviderApiKey: vi.fn(async () => undefined),
      runId: 'run-1',
      runtimeData: {
        memory: { resourceId: 'resource-1', threadId: 'thread-1' },
        model: 'runtime-model',
        provider: 'ollama',
      },
      signal: new AbortController().signal,
      toolApprovalAction: approval ? { ...target, action: 'approve' } : undefined,
      toolDependencies: {},
      toolResumeAction: resume ? { ...target, resumeData: { answer: 'yes' } } : undefined,
    });

    if (approval || resume) {
      expect(resolveToolAction).toHaveBeenCalledWith(expect.objectContaining(target));
      expect(result).toMatchObject({
        ok: false,
        payload: { code: unavailable ? 'model-or-tools-unavailable' : 'invalid-configuration' },
        status: 409,
      });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_ADMITTED_INSTRUCTIONS');
      return;
    }
    expect(result).toMatchObject({ ok: true });
    const capturedMemoryOptions = requireCapturedMemoryOptions(streamCapture.memoryOptions);
    expect(capturedMemoryOptions.conversationBinding).toBe(conversationBinding);
    if (kind === 'child-followup') {
      expect(capabilities.contextInjectors.referencedFiles).toHaveBeenCalledWith(
        [
          {
            id: 'followup',
            parts: [{ text: 'Inspect @evidence.md', type: 'text' }],
            role: 'user',
          },
        ],
        expect.anything(),
        capabilities.readWorkspaceTextFile
      );
      expect(capturedMemoryOptions.getDelegatedSystemContext?.()).toEqual([
        { content: 'TRUSTED_WORKSPACE_1723', role: 'system' },
      ]);
    }
    expect(
      capturedMemoryOptions.toolOutputArtifactInlineMaxSerializedCharsByToolName?.get(
        NATIVE_TOOL_ID.webExtract
      )
    ).toBe(resolveScaledToolResultBudget(32_768).domainModelResultCharBudget);

    if (kind === 'fresh') {
      const initializeRootApproval = async (error: Error) => {
        streamCapture.approvalError = error;
        return initializeAgentStream({
          apiKey: undefined,
          capabilities,
          getDatabase: vi.fn(async () => ({})),
          logger: {
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
          } as unknown as ScopedLogger,
          mcpConfig: undefined,
          messages: [],
          resolveProviderApiKey: vi.fn(async () => undefined),
          runId: 'approval-leg',
          runtimeData: {
            memory: { resourceId: 'resource-1', threadId: 'thread-1' },
            model: 'runtime-model',
            provider: 'ollama',
          },
          signal: new AbortController().signal,
          toolApprovalAction: {
            action: 'approve',
            runId: 'root-native-run',
            toolCallId: 'root-write',
          },
          toolDependencies: {},
          toolResumeAction: undefined,
        });
      };
      const identityError = Object.assign(new Error('generic identity failure'), {
        actionableMessage: GENERATION_RECOVERY_MESSAGE,
        name: 'DelegatedConversationIdentityError',
        reason: 'background-generation-unmapped',
      });
      expect(
        await initializeRootApproval(
          new Error('mastra_agent_stream_failure', { cause: identityError })
        )
      ).toEqual({
        ok: false,
        payload: {
          code: 'background-generation-unmapped',
          error: 'decision_refused',
          message: GENERATION_RECOVERY_MESSAGE,
          stage: 'stream_construction',
        },
        status: 409,
      });

      const genericFailure = {
        ok: false,
        payload: {
          correlationId: expect.any(String),
          error: 'agent_stream_init_failed',
          message: 'Assistant stream initialization failed.',
          stage: 'stream_construction',
        },
        status: 502,
      };
      for (const rejected of [
        new Error('ordinary nested error'),
        Object.assign(new Error('wrong reason'), {
          actionableMessage: GENERATION_RECOVERY_MESSAGE,
          name: 'DelegatedConversationIdentityError',
          reason: 'host-scope-invalid',
        }),
        Object.assign(new Error('oversize message'), {
          actionableMessage: 'x'.repeat(501),
          name: 'DelegatedConversationIdentityError',
          reason: 'background-generation-unmapped',
        }),
      ]) {
        expect(
          await initializeRootApproval(
            new Error('mastra_agent_stream_failure', { cause: rejected })
          )
        ).toEqual(genericFailure);
      }
    }
  });
});
