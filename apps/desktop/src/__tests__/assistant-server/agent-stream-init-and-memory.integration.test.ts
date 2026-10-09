import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS, type RuntimeData } from '@brainstrike/agent';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { handleAssistantRequest } from '../../assistant-server';
import { installDesktopHookApprovalReader } from '../../assistant-server/hooks/server-integration';
import { resetDesktopMastraMemoryCacheForTests } from '../../assistant-server/mastra-memory';
import {
  mockDesktopDatabase,
  mockPgliteMastraMemory,
  mockPgliteMastraStorage,
  mockSecretsService,
} from './_assistant-server-mocks';
import { createRunRequest } from './_harness';

// Mock dependencies: per-file vi.mock call sites (hoisting is
// per-importing-module) over the shared factory bodies + fixtures in
// _assistant-server-mocks.ts (BST-1029). The DYNAMIC import is LOAD-BEARING
// (both alternatives verified red): a bare imported factory reference is
// evaluated at hoist time, and even a lazy arrow over the STATIC import
// breaks because '../../assistant-server' initializes first in import order
// and triggers these factories before the mocks module's bindings exist. The
// dynamic import shares the same per-file module instance as the static
// fixture imports below.
// vi.hoisted lifts the accessor above the hoisted vi.mock calls; the dynamic
// import inside stays lazy.
const mocks = vi.hoisted(() => () => import('./_assistant-server-mocks'));
vi.mock('../../assistant-server/http', async () => (await mocks()).makeAssistantServerHttpMock());
vi.mock('../../agent-client-loader', async () => (await mocks()).makeAgentClientLoaderMock());
vi.mock('../../secrets', async () => (await mocks()).makeSecretsMock());
vi.mock('@brainstrike/agent/hosted-web', async () => (await mocks()).makeHostedWebAgentMock());
vi.mock('@brainstrike/agent', async () => (await mocks()).makeAgentMock());
vi.mock('@brainstrike/agent/pglite-mastra-memory', async () =>
  (await mocks()).makePgliteMastraMemoryMock()
);
vi.mock('../../assistant-server/assistant-tools', async () =>
  (await mocks()).makeAssistantToolsMock()
);
vi.mock(
  '../../../../../packages/host-capabilities/src/native-tools/workspace-text-file-reader',
  async () => (await mocks()).makeWorkspaceTextFileReaderMock()
);
vi.mock('../../db-main', async () => (await mocks()).makeDbMainMock());

const runRequest = createRunRequest(handleAssistantRequest);

beforeEach(() => {
  // Main installs the agent host's hook-trust reader before the server takes
  // requests; this host trusts no root's project hooks.
  installDesktopHookApprovalReader(async () => undefined);
  mockDesktopDatabase.exec.mockReset();
  mockDesktopDatabase.query.mockReset();
  // Default: workspace-roots enrichment (runs first on every assistant
  // stream init) sees no roots and cleanly falls back. Tests that exercise
  // other queries override this.
  mockDesktopDatabase.query.mockResolvedValue({ rows: [] });
  resetDesktopMastraMemoryCacheForTests();
  mockSecretsService.getCredential
    .mockReset()
    .mockResolvedValue({ key: 'test-api-key', type: 'api_key' });
  mockSecretsService.getKey.mockReset().mockResolvedValue('test-api-key');
  mockSecretsService.listProviders.mockReset().mockResolvedValue(['openai']);
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: false });
});

afterEach(() => {
  vi.clearAllMocks();
  resetDesktopMastraMemoryCacheForTests();
}, 15_000);
describe('agent-stream-init runtime composition and memory', () => {
  // BST-1930: the one MCP runtime, and its config, serve agent-host threads; a legacy turn
  // carries none.
  it('carries no MCP host, task tracking or config on a legacy turn', async () => {
    const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);

    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Response', type: 'text' };
      },
    });

    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });

    await runRequest({
      body: JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(toAiSdkStyleStream).toHaveBeenCalledTimes(1);
    const [, runtime, options] = (toAiSdkStyleStream as Mock).mock.calls[0] as [
      unknown,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(runtime['mcpConfig']).toBeUndefined();
    expect(options).not.toHaveProperty('mcpHost');
    expect(options).not.toHaveProperty('mcpTaskTracking');
  });

  it('injects the main-owned native search capability into request tools outside runtime data', async () => {
    const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');
    const { buildDesktopAssistantTools } = await import('../../assistant-server/assistant-tools');
    const nativeIndexSearch = {
      coverage: vi.fn(),
      coverageBatch: vi.fn(),
      grep: vi.fn(),
      rebuild: vi.fn(),
      search: vi.fn(),
      status: vi.fn(),
    };
    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Response', type: 'text' };
      },
    });
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      (res as { end?: () => void }).end?.();
    });
    const response = await runRequest(
      {
        body: JSON.stringify({
          data: { provider: 'openai' },
          messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/',
      },
      { nativeIndexSearch }
    );
    expect(response.status).toBe(200);
    expect(buildDesktopAssistantTools).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ nativeIndexSearch })
    );
    const call = (buildDesktopAssistantTools as Mock).mock.calls.at(-1);
    expect(call?.[1]?.nativeIndexSearch).toBe(nativeIndexSearch);
    expect((toAiSdkStyleStream as Mock).mock.calls.at(-1)?.[1]).not.toHaveProperty(
      'nativeIndexSearch'
    );
  });

  it('threads the built-in subagent personas onto the runtime for a hosted provider', async () => {
    const { BUILT_IN_PERSONAS, toAiSdkStyleStream, convertAssistantUiMessages } = await import(
      '@brainstrike/agent'
    );
    const { streamResponse } = await import('../../assistant-server/http');

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Response', type: 'text' };
      },
    });
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });

    await runRequest({
      body: JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(toAiSdkStyleStream).toHaveBeenCalledTimes(1);
    const [, runtime] = (toAiSdkStyleStream as Mock).mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    // Personas are set unconditionally on the runtime; the agent-side runtime
    // is where the local-provider skip lives (documented, tested in the agent
    // package). The server resolves built-ins + user-defined personas per
    // request (resolveRequestPersonas); with no persona files on disk and no
    // availability request, the resolved list equals the built-ins.
    expect(runtime['personas']).toEqual(BUILT_IN_PERSONAS);
  });

  it('routes provider "local" through the injected llm-host manager (warmup + proxy client)', async () => {
    const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Response', type: 'text' };
      },
    });
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });

    const llmHostManager = {
      generateForMain: vi.fn(),
      warmupForMain: vi.fn().mockResolvedValue(undefined),
    };

    const response = await runRequest(
      {
        body: JSON.stringify({
          data: { model: 'onnx-community/gemma-4-E2B-it-ONNX', provider: 'local' },
          messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/',
      },
      { llmHostManager }
    );

    expect(response.status).toBe(200);
    // The host was warmed before streaming (cold loads exceed the generate ceiling).
    expect(llmHostManager.warmupForMain).toHaveBeenCalledTimes(1);
    expect(llmHostManager.warmupForMain.mock.calls[0]?.[0]).toBe(
      'onnx-community/gemma-4-E2B-it-ONNX'
    );
    // The Mastra runtime received the injected proxy client.
    expect(toAiSdkStyleStream).toHaveBeenCalledTimes(1);
    const [, runtime] = (toAiSdkStyleStream as Mock).mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(runtime['localLlmHostClient']).toBeDefined();
    expect(typeof (runtime['localLlmHostClient'] as { generate: unknown }).generate).toBe(
      'function'
    );
  });

  it('starts a fresh local-provider stream without requiring a hosted observational-memory key', async () => {
    const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { content: 'LOCAL_SMOKE_OK', type: 'text' };
      },
    });
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });
    const getKey = mockSecretsService.getKey as unknown as Mock<
      (provider: string) => Promise<string | null>
    >;
    getKey.mockResolvedValueOnce(null);

    const llmHostManager = {
      generateForMain: vi.fn(),
      warmupForMain: vi.fn().mockResolvedValue(undefined),
    };

    const response = await runRequest(
      {
        body: JSON.stringify({
          data: {
            enabledNativeToolIds: [
              'brainstrike.readWorkspaceFile',
              'brainstrike.manageTaskList',
              'brainstrike.submitPlan',
            ],
            memory: {
              memorySettings: DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
              resourceId: 'fresh-local-workspace',
              threadId: 'fresh-local-thread',
            },
            model: 'onnx-community/gemma-4-E2B-it-ONNX',
            provider: 'local',
          },
          messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/',
      },
      { llmHostManager }
    );

    expect(response.status).toBe(200);
    expect(mockSecretsService.getKey).not.toHaveBeenCalled();
    expect(toAiSdkStyleStream).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown enabled native tool id before stream construction', async () => {
    const response = await runRequest({
      body: JSON.stringify({
        data: {
          enabledNativeToolIds: ['brainstrike.readWorkspaceFile', 'brainstrike.removedNativeTool'],
          model: 'onnx-community/gemma-4-E2B-it-ONNX',
          provider: 'local',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      error: 'invalid_enabled_native_tool_ids',
      message: 'Assistant request contains unknown enabled native tool IDs.',
      stage: 'native_tool_preferences',
    });
  });

  it('fails provider "local" with a structured error when no llm-host manager is injected', async () => {
    const { convertAssistantUiMessages } = await import('@brainstrike/agent');
    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);

    const response = await runRequest({
      body: JSON.stringify({
        data: { model: 'onnx-community/gemma-4-E2B-it-ONNX', provider: 'local' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(502);
    const payload = JSON.parse(response.body) as {
      correlationId: string;
      error: string;
      stage: string;
    };
    expect(payload.error).toBe('agent_stream_init_failed');
    expect(payload.stage).toBe('provider_model_bootstrap');
    expect(payload.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('does not prepend selected-file context as a hidden system message', async () => {
    const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');

    // The only DB query in this path is workspace-roots enrichment; if the
    // server wrongly prepended selected-file context it would issue a
    // file-content query, which this SQL-aware mock would answer (and the
    // assertion below would then catch).
    mockDesktopDatabase.query.mockImplementation((sql: unknown) =>
      typeof sql === 'string' && sql.includes('FROM roots')
        ? Promise.resolve({ rows: [] })
        : Promise.resolve({ rows: [{ content: 'const hidden = true;', path: '/src/main.ts' }] })
    );
    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Response', type: 'text' };
      },
    });
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });

    await runRequest({
      body: JSON.stringify({
        data: {
          includeFileReport: true,
          provider: 'openai',
          selectionFilePaths: ['/src/main.ts'],
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    const [messages] = (toAiSdkStyleStream as Mock).mock.calls[0] as [Array<{ role: string }>];
    expect(messages).toEqual([{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }]);
    // No selected-file content was fetched: the only DB queries are roots enrichment.
    expect(
      mockDesktopDatabase.query.mock.calls.every(([sql]) => String(sql).includes('FROM roots'))
    ).toBe(true);
  });

  it('pins the capability composition: same-signature members cannot be transposed', async () => {
    // The REAL transposition guard (review finding on #2128): `referencedFiles`
    // and `workspaceInstructions` are structurally interchangeable, and the
    // end-to-end directive case below cannot distinguish a swap (the swapped
    // impl still resolves the directive, just in the other pipeline slot —
    // verified by control-swapping the wiring). Identity is the only honest
    // instrument.
    const { desktopAgentStreamCapabilities } = await import('../../assistant-server');
    const { injectReferencedFilesContext } = await import(
      '../../assistant-server/referenced-files-context'
    );
    const { injectWorkspaceInstructionsContext } = await import(
      '../../assistant-server/workspace-instructions-context'
    );
    const { injectActivatedSkillsContext } = await import(
      '../../assistant-server/skills-activation-context'
    );

    expect(desktopAgentStreamCapabilities.contextInjectors.referencedFiles).toBe(
      injectReferencedFilesContext
    );
    expect(desktopAgentStreamCapabilities.contextInjectors.workspaceInstructions).toBe(
      injectWorkspaceInstructionsContext
    );
    expect(desktopAgentStreamCapabilities.contextInjectors.activatedSkills).toBe(
      injectActivatedSkillsContext
    );
  });

  it('resolves a :file directive through the composed referenced-files injector', async () => {
    // Composition guard (review finding on #2128): the capability members
    // `contextInjectors.referencedFiles` and `contextInjectors.workspaceInstructions`
    // are structurally interchangeable, so a transposed wiring in
    // assistant-server.ts would type-check. This end-to-end case fails on a
    // swap: the directive would never be resolved and the reader never called.
    const { encodeFileMentionId, serializeFileMentionDirective } = await import(
      '@brainstrike/assistant-contract'
    );
    const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
    const { readWorkspaceTextFile } = await import('@brainstrike/host-capabilities/native-tools');
    const { streamResponse } = await import('../../assistant-server/http');

    mockDesktopDatabase.query.mockResolvedValueOnce({
      rows: [{ displayName: 'Server Root', id: 'db-root-id', path: '/work/server-root' }],
    });
    (readWorkspaceTextFile as Mock).mockResolvedValueOnce({
      content: 'export const answer = 42;',
      path: 'src/answer.ts',
      size: 25,
    });
    const directiveText = `Explain ${serializeFileMentionDirective({
      id: encodeFileMentionId('db-root-id', 'src/answer.ts'),
      label: 'answer.ts',
    })}`;
    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: directiveText, type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Response', type: 'text' };
      },
    });
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });

    await runRequest({
      body: JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ parts: [{ text: directiveText, type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(readWorkspaceTextFile).toHaveBeenCalledWith({
      requestedPath: 'src/answer.ts',
      rootPath: '/work/server-root',
    });
    const [messages] = (toAiSdkStyleStream as Mock).mock.calls[0] as [
      Array<{ role: string; parts: Array<{ text?: string }> }>,
    ];
    const contextMessage = messages.find(
      (message) =>
        message.role === 'system' && message.parts[0]?.text?.includes('export const answer = 42;')
    );
    expect(contextMessage).toBeDefined();
    const userIndex = messages.findIndex((message) => message.role === 'user');
    expect(messages.indexOf(contextMessage as (typeof messages)[number])).toBeLessThan(userIndex);
  });

  it('replaces client-supplied workspace roots with server-resolved DB identities', async () => {
    const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');

    mockDesktopDatabase.query.mockResolvedValueOnce({
      rows: [{ displayName: 'Server Root', id: 'db-root-id', path: '/work/server-root' }],
    });
    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Read the project', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Response', type: 'text' };
      },
    });
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });

    await runRequest({
      body: JSON.stringify({
        data: {
          provider: 'openai',
          workspaceRoots: [
            {
              displayName: 'Client Root',
              path: '/work/client-root',
              rootId: 'client-root-id',
            },
          ],
        },
        messages: [{ parts: [{ text: 'Read the project', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    const [, runtime] = (toAiSdkStyleStream as Mock).mock.calls[0] as [unknown, RuntimeData];
    expect(runtime.workspaceRoots).toEqual([
      {
        displayName: 'Server Root',
        path: '/work/server-root',
        rootId: 'db-root-id',
      },
    ]);
  });

  it('returns visible reconnect guidance when a thread binding points at a disconnected root', async () => {
    const { toAiSdkStyleStream } = await import('@brainstrike/agent');
    mockDesktopDatabase.query.mockResolvedValueOnce({
      rows: [{ displayName: 'Live Root', id: 'live-root-id', path: '/work/live-root' }],
    });

    const response = await runRequest({
      body: JSON.stringify({
        data: {
          boundWorkspaceRootId: 'disconnected-root-id',
          provider: 'openai',
        },
        messages: [{ parts: [{ text: 'Continue building', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({
      error: 'bound_workspace_root_unavailable',
      message:
        'The bound workspace root (id disconnected-root-id) is no longer open. Reconnect that folder before continuing this thread.',
      stage: 'workspace_root_resolution',
    });
    expect(toAiSdkStyleStream).not.toHaveBeenCalled();
  });

  it('initializes PGlite Mastra memory when memory runtime context is present', async () => {
    const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
    const { getDatabase } = await import('../../db-main');
    const { streamResponse } = await import('../../assistant-server/http');

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Response', type: 'text' };
      },
    });
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });
    // Workspace-roots enrichment queries the DB before memory init.
    mockDesktopDatabase.query.mockResolvedValue({ rows: [] });

    await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            memorySettings: {
              observationalMemory: {
                enabled: true,
                messageTokens: 20_000,
                modelTarget: 'anthropic/claude-haiku-4-5',
                observationTokens: 40_000,
                retrievalMode: 'off',
                scope: 'thread',
              },
              semanticRecall: {
                embeddingModelTarget: 'openai/text-embedding-3-small',
                enabled: false,
                messageRange: 2,
                scope: 'resource',
                topK: 5,
              },
            },
            resourceId: 'workspace-a',
            threadId: 'thread-1',
          },
          provider: 'openai',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    const { createLanguageModelProvider } = await import('@brainstrike/agent');

    // Once each for workspace-roots enrichment, the previous-run prompt-baseline
    // lookup, and PGlite Mastra memory initialization.
    expect(getDatabase).toHaveBeenCalledTimes(3);
    expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
      expect.stringContaining('prompt_baseline_tokens'),
      ['thread-1']
    );
    expect(createLanguageModelProvider).toHaveBeenCalledWith(
      'anthropic',
      'test-api-key',
      'claude-haiku-4-5',
      // BST-1352 review: the runtime carries NO apiKey field — the memory
      // model key travels through the resolved observationalMemoryModel.
      expect.objectContaining({ provider: 'openai' })
    );
    expect(createPgliteMastraMemory).toHaveBeenCalledWith({
      database: expect.anything(),
      memorySettings: {
        observationalMemory: {
          enabled: true,
          messageTokens: 20_000,
          modelTarget: 'anthropic/claude-haiku-4-5',
          observationTokens: 40_000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: 'openai/text-embedding-3-small',
          enabled: false,
          messageRange: 2,
          scope: 'resource',
          topK: 5,
        },
      },
      observationalMemoryModel: {
        apiKey: 'test-api-key',
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
      },
    });
    expect(toAiSdkStyleStream).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        memory: expect.objectContaining({ resourceId: 'workspace-a', threadId: 'thread-1' }),
      }),
      {
        // BST-1352: the resolved auth input rides the stream OPTIONS. A legacy
        // turn carries no MCP host or task tracking (BST-1930).
        authInput: { apiKey: 'test-api-key', kind: 'api_key' },
        memory: mockPgliteMastraMemory,
        storage: mockPgliteMastraStorage,
      }
    );
  });

  it('surfaces an unreadable observational-memory key during stream initialization', async () => {
    const { SecretReadError } = await import('../../secrets');
    // BST-1352: both the chat credential and the memory model-target key
    // resolve through the TYPED reader now.
    mockSecretsService.getCredential
      .mockResolvedValueOnce({ key: 'anthropic-key', type: 'api_key' })
      .mockRejectedValueOnce(new SecretReadError('decrypt_failed', 'openai'));

    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            memorySettings: {
              observationalMemory: {
                enabled: true,
                messageTokens: 20_000,
                modelTarget: 'openai/gpt-5.4-mini',
                observationTokens: 40_000,
                retrievalMode: 'off',
                scope: 'thread',
              },
              semanticRecall: {
                embeddingModelTarget: 'openai/text-embedding-3-small',
                enabled: false,
                messageRange: 2,
                scope: 'resource',
                topK: 5,
              },
            },
            resourceId: 'workspace-memory-key-error',
            threadId: 'thread-memory-key-error',
          },
          provider: 'anthropic',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      code: 'decrypt_failed',
      error: 'api_key_unreadable',
      message:
        'Secret for "openai" is unreadable: stored secret could not be decrypted (the OS keychain entry may have changed). Re-enter the key to repair it.',
      provider: 'openai',
    });
  });

  it('surfaces an actionable missing observational-memory credential', async () => {
    mockSecretsService.getCredential.mockImplementation((provider: string) =>
      Promise.resolve(
        provider === 'anthropic' ? { key: 'anthropic-key', type: 'api_key' as const } : null
      )
    );

    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            memorySettings: {
              observationalMemory: {
                enabled: true,
                messageTokens: 20_000,
                modelTarget: 'openai/gpt-5.4-mini',
                observationTokens: 40_000,
                retrievalMode: 'off',
                scope: 'thread',
              },
              semanticRecall: {
                embeddingModelTarget: 'openai/text-embedding-3-small',
                enabled: false,
                messageRange: 2,
                scope: 'resource',
                topK: 5,
              },
            },
            resourceId: 'workspace-memory-key-missing',
            threadId: 'thread-memory-key-missing',
          },
          provider: 'anthropic',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'memory_credential_missing',
      feature: 'observational_memory',
      message:
        'Observational memory requires an API key for "openai". Add the key in Settings, then retry.',
      provider: 'openai',
    });
    expect(mockSecretsService.getCredential).toHaveBeenNthCalledWith(1, 'anthropic');
    expect(mockSecretsService.getCredential).toHaveBeenNthCalledWith(2, 'openai');
  });

  it('surfaces an actionable missing semantic-recall credential', async () => {
    mockSecretsService.getCredential.mockImplementation((provider: string) =>
      Promise.resolve(
        provider === 'anthropic' ? { key: 'anthropic-key', type: 'api_key' as const } : null
      )
    );

    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            memorySettings: {
              observationalMemory: {
                enabled: false,
                messageTokens: 20_000,
                modelTarget: 'openai/gpt-5.4-mini',
                observationTokens: 40_000,
                retrievalMode: 'off',
                scope: 'thread',
              },
              semanticRecall: {
                embeddingModelTarget: 'google/text-embedding-004',
                enabled: true,
                messageRange: 2,
                scope: 'resource',
                topK: 5,
              },
            },
            resourceId: 'workspace-recall-key-missing',
            threadId: 'thread-recall-key-missing',
          },
          provider: 'anthropic',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'memory_credential_missing',
      feature: 'semantic_recall',
      message:
        'Semantic recall requires an API key for "google". Add the key in Settings, then retry.',
      provider: 'google',
    });
    expect(mockSecretsService.getCredential).toHaveBeenNthCalledWith(1, 'anthropic');
    expect(mockSecretsService.getCredential).toHaveBeenNthCalledWith(2, 'google');
  });

  it('builds observational memory on the built-in local model via the llm-host proxy', async () => {
    const { createLanguageModelProvider, toAiSdkStyleStream, convertAssistantUiMessages } =
      await import('@brainstrike/agent');
    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
    const { streamResponse } = await import('../../assistant-server/http');

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Response', type: 'text' };
      },
    });
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });

    const llmHostManager = {
      generateForMain: vi.fn(),
      warmupForMain: vi.fn().mockResolvedValue(undefined),
    };

    const response = await runRequest(
      {
        body: JSON.stringify({
          data: {
            memory: {
              memorySettings: {
                observationalMemory: {
                  enabled: true,
                  messageTokens: 20_000,
                  modelTarget: 'local/onnx-community/gemma-4-E2B-it-ONNX',
                  observationTokens: 40_000,
                  retrievalMode: 'off',
                  scope: 'thread',
                },
                semanticRecall: {
                  embeddingModelTarget: 'openai/text-embedding-3-small',
                  enabled: false,
                  messageRange: 2,
                  scope: 'resource',
                  topK: 5,
                },
              },
              resourceId: 'workspace-local-om',
              threadId: 'thread-local-om',
            },
            provider: 'openai',
          },
          messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/',
      },
      { llmHostManager }
    );

    expect(response.status).toBe(200);
    // The memory model was warmed even though the CHAT provider is hosted.
    expect(llmHostManager.warmupForMain).toHaveBeenCalledTimes(1);
    expect(llmHostManager.warmupForMain.mock.calls[0]?.[0]).toBe(
      'onnx-community/gemma-4-E2B-it-ONNX'
    );
    // The OM model resolved through the local provider with no API key and
    // the proxy client present on the runtime.
    expect(createLanguageModelProvider).toHaveBeenCalledWith(
      'local',
      '',
      'onnx-community/gemma-4-E2B-it-ONNX',
      expect.objectContaining({ localLlmHostClient: expect.anything() })
    );
    expect(createPgliteMastraMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        observationalMemoryModel: expect.objectContaining({
          model: 'onnx-community/gemma-4-E2B-it-ONNX',
          provider: 'local',
        }),
      })
    );
  });

  it('builds semantic recall on the built-in local embedder via the embedding host', async () => {
    const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
    const { streamResponse } = await import('../../assistant-server/http');

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Response', type: 'text' };
      },
    });
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });

    const embeddingHostManager = {
      queryEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
    };

    const response = await runRequest(
      {
        body: JSON.stringify({
          data: {
            memory: {
              memorySettings: {
                observationalMemory: {
                  enabled: false,
                  messageTokens: 20_000,
                  modelTarget: 'openai/gpt-5.4-mini',
                  observationTokens: 40_000,
                  retrievalMode: 'off',
                  scope: 'thread',
                },
                semanticRecall: {
                  embeddingModelTarget: 'local/Xenova/all-MiniLM-L6-v2',
                  enabled: true,
                  messageRange: 2,
                  scope: 'resource',
                  topK: 5,
                },
              },
              resourceId: 'workspace-local-recall',
              threadId: 'thread-local-recall',
            },
            provider: 'openai',
          },
          messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/',
      },
      { embeddingHostManager }
    );

    expect(response.status).toBe(200);
    // The REAL local embedder (not the mocked hosted factory) reached memory
    // construction, keyless, bound to the embedding host client.
    expect(createPgliteMastraMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        embedder: expect.objectContaining({
          modelId: 'Xenova/all-MiniLM-L6-v2',
          provider: 'local',
          specificationVersion: 'v2',
        }),
      })
    );
  });

  it('resolves the recall embedder when observational vector retrieval is on but semantic recall is off', async () => {
    const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
    const { streamResponse } = await import('../../assistant-server/http');

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Response', type: 'text' };
      },
    });
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });

    const embeddingHostManager = {
      queryEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
    };

    const response = await runRequest(
      {
        body: JSON.stringify({
          data: {
            memory: {
              memorySettings: {
                observationalMemory: {
                  enabled: true,
                  messageTokens: 20_000,
                  modelTarget: 'openai/gpt-5.4-mini',
                  observationTokens: 40_000,
                  // Vector observation retrieval needs the recall embedder
                  // even though the semanticRecall toggle below is OFF.
                  retrievalMode: 'vector',
                  scope: 'thread',
                },
                semanticRecall: {
                  embeddingModelTarget: 'local/Xenova/all-MiniLM-L6-v2',
                  enabled: false,
                  messageRange: 2,
                  scope: 'resource',
                  topK: 5,
                },
              },
              resourceId: 'workspace-om-vector',
              threadId: 'thread-om-vector',
            },
            provider: 'openai',
          },
          messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/',
      },
      { embeddingHostManager }
    );

    expect(response.status).toBe(200);
    expect(createPgliteMastraMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        embedder: expect.objectContaining({
          modelId: 'Xenova/all-MiniLM-L6-v2',
          provider: 'local',
        }),
      })
    );
  });

  it('fails local semantic recall with a structured error when no embedding host manager is injected', async () => {
    const { convertAssistantUiMessages } = await import('@brainstrike/agent');
    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);

    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            memorySettings: {
              observationalMemory: {
                enabled: false,
                messageTokens: 20_000,
                modelTarget: 'openai/gpt-5.4-mini',
                observationTokens: 40_000,
                retrievalMode: 'off',
                scope: 'thread',
              },
              semanticRecall: {
                embeddingModelTarget: 'local/Xenova/all-MiniLM-L6-v2',
                enabled: true,
                messageRange: 2,
                scope: 'resource',
                topK: 5,
              },
            },
            resourceId: 'workspace-local-recall-missing',
            threadId: 'thread-local-recall-missing',
          },
          provider: 'openai',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(502);
    const payload = JSON.parse(response.body) as { error: string };
    expect(payload.error).toBe('agent_stream_init_failed');
  });

  it('fails local observational memory with a structured error when no llm-host manager is injected', async () => {
    const { convertAssistantUiMessages } = await import('@brainstrike/agent');
    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);

    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            memorySettings: {
              observationalMemory: {
                enabled: true,
                messageTokens: 20_000,
                modelTarget: 'local/onnx-community/gemma-4-E2B-it-ONNX',
                observationTokens: 40_000,
                retrievalMode: 'off',
                scope: 'thread',
              },
              semanticRecall: {
                embeddingModelTarget: 'openai/text-embedding-3-small',
                enabled: false,
                messageRange: 2,
                scope: 'resource',
                topK: 5,
              },
            },
            resourceId: 'workspace-local-om-missing',
            threadId: 'thread-local-om-missing',
          },
          provider: 'openai',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(502);
    const payload = JSON.parse(response.body) as { error: string };
    expect(payload.error).toBe('agent_stream_init_failed');
  });

  it('routes tool approval actions through Mastra approval resume without requiring a new prompt', async () => {
    const { streamMastraToolApprovalAction, toAiSdkStyleStream, convertAssistantUiMessages } =
      await import('@brainstrike/agent');
    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
    const { streamResponse } = await import('../../assistant-server/http');

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([]);
    (streamMastraToolApprovalAction as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'Approved and continued.' };
      },
    });
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });

    await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            resourceId: 'workspace-a',
            threadId: 'thread-1',
          },
          provider: 'openai',
        },
        messages: [],
        runConfig: {
          custom: {
            brainstrikeToolApproval: {
              action: 'approve',
              runId: 'run-approval-1',
              toolCallId: 'tool-call-1',
              toolName: 'workspace.writeFile',
            },
          },
        },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(toAiSdkStyleStream).not.toHaveBeenCalled();
    expect(createPgliteMastraMemory).toHaveBeenCalledTimes(1);
    expect(streamMastraToolApprovalAction).toHaveBeenCalledWith(
      {
        action: 'approve',
        runId: 'run-approval-1',
        toolCallId: 'tool-call-1',
        toolName: 'workspace.writeFile',
      },
      expect.objectContaining({
        // BST-1352: the resume leg receives the auth input on its OPTIONS…
        authInput: { apiKey: 'test-api-key', kind: 'api_key' },
        memory: mockPgliteMastraMemory,
        requireToolApproval: true,
        resolvePersonaApiKey: expect.any(Function),
        runtime: expect.objectContaining({
          memory: expect.objectContaining({
            resourceId: 'workspace-a',
            threadId: 'thread-1',
          }),
          provider: 'openai',
        }),
        storage: mockPgliteMastraStorage,
      })
    );
    // …and the runtime object carries NO apiKey field (regression pin for the
    // RequestContext-serialization hazard: credentials never ride RuntimeData).
    const [, approvalOptions] = (streamMastraToolApprovalAction as Mock).mock.calls[0] as [
      unknown,
      { runtime: Record<string, unknown> },
    ];
    expect(approvalOptions.runtime).not.toHaveProperty('apiKey');
    expect(JSON.stringify(approvalOptions.runtime)).not.toContain('test-api-key');
  });

  it('rejects tool approval resume when workflow storage is missing from memory', async () => {
    const { streamMastraToolApprovalAction } = await import('@brainstrike/agent');
    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');

    (createPgliteMastraMemory as Mock).mockResolvedValueOnce({
      memory: mockPgliteMastraMemory,
      store: {},
      vector: {},
      workflows: {},
    });

    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            resourceId: 'workspace-a',
            threadId: 'thread-1',
          },
          provider: 'openai',
        },
        messages: [],
        runConfig: {
          custom: {
            brainstrikeToolApproval: {
              action: 'approve',
              runId: 'run-approval-1',
              toolCallId: 'tool-call-1',
              toolName: 'workspace.writeFile',
            },
          },
        },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'tool_approval_memory_required',
      message: 'Tool approval resume requires Mastra memory context with workflow storage.',
    });
    expect(streamMastraToolApprovalAction).not.toHaveBeenCalled();
  });

  it('routes tool RESUME actions (submitPlan/askUser) through Mastra resume without a new prompt', async () => {
    const { streamMastraToolResumeAction, toAiSdkStyleStream, convertAssistantUiMessages } =
      await import('@brainstrike/agent');
    const { streamResponse } = await import('../../assistant-server/http');

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([]);
    (streamMastraToolResumeAction as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'Plan approved.' };
      },
    });
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      (res as { end?: () => void }).end?.();
    });

    await runRequest({
      body: JSON.stringify({
        data: {
          memory: { resourceId: 'workspace-a', threadId: 'thread-1' },
          provider: 'openai',
        },
        messages: [],
        runConfig: {
          custom: {
            brainstrikeToolSuspend: {
              resumeData: { action: 'approved' },
              runId: 'run-suspend-1',
              toolCallId: 'tool-call-1',
              toolName: 'brainstrike.submitPlan',
            },
          },
        },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(toAiSdkStyleStream).not.toHaveBeenCalled();
    expect(streamMastraToolResumeAction).toHaveBeenCalledWith(
      {
        resumeData: { action: 'approved' },
        runId: 'run-suspend-1',
        toolCallId: 'tool-call-1',
        toolName: 'brainstrike.submitPlan',
      },
      expect.objectContaining({
        // BST-1352: the suspend-resume leg receives the auth input on its
        // OPTIONS; the runtime carries no credential fields.
        authInput: { apiKey: 'test-api-key', kind: 'api_key' },
        memory: mockPgliteMastraMemory,
        resolvePersonaApiKey: expect.any(Function),
        runtime: expect.objectContaining({ provider: 'openai' }),
        storage: mockPgliteMastraStorage,
      })
    );
    // Approve must EXIT plan mode: the client clears the plan-mode toggle
    // before composing the resume, so the request carries no planMode and the
    // rebuilt runtime unlocks the mutation tools.
    const [, approveResumeOptions] = (streamMastraToolResumeAction as Mock).mock.calls[0] as [
      unknown,
      { runtime: Record<string, unknown> },
    ];
    expect(approveResumeOptions.runtime['planMode']).toBeUndefined();
  });

  it('preserves planMode on a REJECT resume so the model can revise in plan mode', async () => {
    const { streamMastraToolResumeAction, convertAssistantUiMessages } = await import(
      '@brainstrike/agent'
    );
    const { streamResponse } = await import('../../assistant-server/http');

    (convertAssistantUiMessages as Mock).mockReturnValueOnce([]);
    (streamMastraToolResumeAction as Mock).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'Revising the plan.' };
      },
    });
    (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
      (res as { end?: () => void }).end?.();
    });

    await runRequest({
      body: JSON.stringify({
        data: {
          memory: { resourceId: 'workspace-a', threadId: 'thread-1' },
          planMode: true,
          provider: 'openai',
        },
        messages: [],
        runConfig: {
          custom: {
            brainstrikeToolSuspend: {
              resumeData: { action: 'rejected', feedback: 'tighten step 2' },
              runId: 'run-suspend-2',
              toolCallId: 'tool-call-2',
              toolName: 'brainstrike.submitPlan',
            },
          },
        },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    const [, rejectResumeOptions] = (streamMastraToolResumeAction as Mock).mock.calls[0] as [
      unknown,
      { runtime: Record<string, unknown> },
    ];
    expect(rejectResumeOptions.runtime['planMode']).toBe(true);
  });

  it('rejects a tool resume when workflow storage is missing from memory', async () => {
    const { streamMastraToolResumeAction } = await import('@brainstrike/agent');
    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');

    (createPgliteMastraMemory as Mock).mockResolvedValueOnce({
      memory: mockPgliteMastraMemory,
      store: {},
      vector: {},
      workflows: {},
    });

    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: { resourceId: 'workspace-a', threadId: 'thread-1' },
          provider: 'openai',
        },
        messages: [],
        runConfig: {
          custom: {
            brainstrikeToolSuspend: {
              resumeData: 'San Francisco',
              runId: 'run-suspend-1',
              toolCallId: 'tool-call-1',
            },
          },
        },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'tool_resume_memory_required',
      message: 'Tool suspend resume requires Mastra memory context with workflow storage.',
    });
    expect(streamMastraToolResumeAction).not.toHaveBeenCalled();
  });

  it('rejects a malformed tool resume action with 400 before dispatch', async () => {
    const { streamMastraToolResumeAction } = await import('@brainstrike/agent');
    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: { resourceId: 'workspace-a', threadId: 'thread-1' },
          provider: 'openai',
        },
        messages: [],
        runConfig: {
          // Missing resumeData key → malformed.
          custom: { brainstrikeToolSuspend: { runId: 'r', toolCallId: 't' } },
        },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toBe('invalid_tool_resume_action');
    expect(streamMastraToolResumeAction).not.toHaveBeenCalled();
  });

  it('rejects conflicting approval and suspend-resume actions with a typed 400 before dispatch', async () => {
    const { streamMastraToolApprovalAction, streamMastraToolResumeAction } = await import(
      '@brainstrike/agent'
    );
    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: { resourceId: 'workspace-a', threadId: 'thread-1' },
          provider: 'openai',
        },
        messages: [],
        runConfig: {
          custom: {
            brainstrikeToolApproval: {
              action: 'approve',
              runId: 'run-approval-1',
              toolCallId: 'tool-call-1',
            },
            brainstrikeToolSuspend: {
              resumeData: { action: 'approved' },
              runId: 'run-suspend-1',
              toolCallId: 'tool-call-2',
            },
          },
        },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'conflicting_tool_continuation_actions',
      message: 'Assistant request must contain at most one tool continuation action.',
    });
    expect(streamMastraToolApprovalAction).not.toHaveBeenCalled();
    expect(streamMastraToolResumeAction).not.toHaveBeenCalled();
  });

  it('rejects a malformed suspend-resume action even when the approval action is valid', async () => {
    const { streamMastraToolApprovalAction, streamMastraToolResumeAction } = await import(
      '@brainstrike/agent'
    );
    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: { resourceId: 'workspace-a', threadId: 'thread-1' },
          provider: 'openai',
        },
        messages: [],
        runConfig: {
          custom: {
            brainstrikeToolApproval: {
              action: 'approve',
              runId: 'run-approval-1',
              toolCallId: 'tool-call-1',
            },
            brainstrikeToolSuspend: {
              runId: 'run-suspend-1',
              toolCallId: 'tool-call-2',
            },
          },
        },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toBe('invalid_tool_resume_action');
    expect(streamMastraToolApprovalAction).not.toHaveBeenCalled();
    expect(streamMastraToolResumeAction).not.toHaveBeenCalled();
  });

  it('rejects a malformed approval action even when the suspend-resume action is valid', async () => {
    const { streamMastraToolApprovalAction, streamMastraToolResumeAction } = await import(
      '@brainstrike/agent'
    );
    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: { resourceId: 'workspace-a', threadId: 'thread-1' },
          provider: 'openai',
        },
        messages: [],
        runConfig: {
          custom: {
            brainstrikeToolApproval: {
              action: 'approve',
              runId: 'run-approval-1',
            },
            brainstrikeToolSuspend: {
              resumeData: { action: 'approved' },
              runId: 'run-suspend-1',
              toolCallId: 'tool-call-2',
            },
          },
        },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toBe('invalid_tool_approval_action');
    expect(streamMastraToolApprovalAction).not.toHaveBeenCalled();
    expect(streamMastraToolResumeAction).not.toHaveBeenCalled();
  });

  it.each(['legacy-catalog', 'missing-configuration'])(
    'returns actionable admitted-child remediation through the shared HTTP initializer (%s)',
    async (kind) => {
      const { streamMastraToolApprovalAction } = await import('@brainstrike/agent');
      // Exercise the public package boundary, bypassing only this suite's agent mock.
      const actualAgent =
        await vi.importActual<typeof import('@brainstrike/agent')>('@brainstrike/agent');
      const identity = {
        childRuntimeRunId: 'child-run',
        parentRuntimeRunId: 'parent-run',
        parentToolCallId: 'parent-call',
        personaId: 'worker',
      };
      const action = {
        action: 'approve' as const,
        delegation: { path: [identity], toolCallId: 'leaf-call' },
        runId: 'parent-run',
        toolCallId: 'parent-call',
      };
      const configuration =
        kind === 'legacy-catalog'
          ? {
              maxSteps: 3,
              persona: {
                allowedToolIds: ['*'],
                description: 'Work',
                id: 'worker',
                instructions: 'Original workspace-private instructions',
                label: 'Worker',
                maxSteps: 3,
                mode: 'worker',
              },
            }
          : undefined;
      const error = await actualAgent
        .streamMastraToolApprovalAction(action, {
          conversationBinding: {
            ...actualAgent.createDelegatedConversationBinding(async () => {}),
            resolveToolAction: async () => [
              { configuration, identity, resourceId: 'child-owner', threadId: 'child' },
            ],
          },
          storage: mockPgliteMastraStorage as never,
        })
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: 'admitted_child_configuration_unavailable' });
      vi.mocked(streamMastraToolApprovalAction).mockRejectedValueOnce(error);
      const response = await runRequest({
        body: JSON.stringify({
          data: { memory: { resourceId: 'workspace-a', threadId: 'thread-1' }, provider: 'openai' },
          messages: [],
          runConfig: { custom: { brainstrikeToolApproval: action } },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/',
      });
      expect(response.status).toBe(409);
      expect(JSON.parse(response.body)).toMatchObject({
        error: 'admitted_child_configuration_unavailable',
        message: expect.stringContaining('Start a new delegation'),
      });
      expect(response.body).not.toContain('workspace-private');
    }
  );

  it('should handle stream initialization failure', async () => {
    const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');

    // Make sure convertAssistantUiMessages returns messages with non-empty text
    (convertAssistantUiMessages as Mock).mockReturnValueOnce([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);

    (toAiSdkStyleStream as Mock).mockRejectedValueOnce(new Error('Stream initialization failed'));

    const response = await runRequest({
      body: JSON.stringify({
        data: { provider: 'openai' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(502);
    const data = JSON.parse(response.body) as {
      correlationId: string;
      error: string;
      message: string;
      stage: string;
    };
    expect(data).toEqual({
      correlationId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      ),
      error: 'agent_stream_init_failed',
      message: 'Assistant stream initialization failed.',
      stage: 'stream_construction',
    });
    expect(response.body).not.toContain('Stream initialization failed');
  }, 10_000);
});
