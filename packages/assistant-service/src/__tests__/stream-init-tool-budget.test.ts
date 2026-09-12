import {
  getProviderDefaultModel,
  resolveScaledToolResultBudget,
  resolveToolResultBudgetForModel,
  TOOL_RESULT_BUDGET_ANCHOR_CONTEXT_WINDOW,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import type { ScopedLogger } from '@brainstrike/logging';
import { describe, expect, it, vi } from 'vitest';
import { initializeAgentStream, resolveToolBuildBudget } from '../stream-init';

interface CapturedMemoryOptions {
  conversationBinding?: unknown;
  getDelegatedSystemContext?: () => readonly { role: string; content: string }[];
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

const streamCapture = vi.hoisted((): { memoryOptions: CapturedMemoryOptions | undefined } => ({
  memoryOptions: undefined,
}));

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return {
    ...actual,
    streamMastraChildFollowup: vi.fn((_input: unknown, options: CapturedMemoryOptions) => {
      streamCapture.memoryOptions = options;
      return (async function* emptyStream() {})();
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
  it.each(['fresh', 'approval', 'resume', 'child-followup'] as const)(
    'threads host memory capabilities through %s initialization',
    async (kind) => {
      streamCapture.memoryOptions = undefined;
      const passthroughStream = <T>(stream: T): T => stream;
      const identity = {
        childRuntimeRunId: 'child-run',
        parentRuntimeRunId: 'parent-run',
        parentToolCallId: 'parent-call',
        personaId: 'worker',
      };
      const resolveToolAction = vi.fn(async () => [
        {
          configuration: undefined,
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
          runPreRequest: vi.fn(async () => ({ kind: 'noop' })),
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
          prepare: vi.fn(() => ({ manager: {}, runner: undefined })),
          runUserPromptSubmitGate: vi.fn(async (_manager, messages) => ({
            kind: 'proceed' as const,
            messages,
          })),
        },
        memory: {
          create: vi.fn(async () => ({ conversationBinding, memory: {}, storage: {} })),
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
        toolApprovalAction: kind === 'approval' ? { ...target, action: 'approve' } : undefined,
        toolDependencies: {},
        toolResumeAction:
          kind === 'resume' ? { ...target, resumeData: { answer: 'yes' } } : undefined,
      } as never);

      if (kind === 'approval' || kind === 'resume') {
        expect(resolveToolAction).toHaveBeenCalledWith(expect.objectContaining(target));
        expect(result).toMatchObject({
          ok: false,
          payload: { code: 'invalid-configuration' },
          status: 409,
        });
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
    }
  );
});
