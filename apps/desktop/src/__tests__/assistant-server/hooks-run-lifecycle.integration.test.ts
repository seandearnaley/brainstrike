/**
 * Tool-lifecycle hooks P2: the Stop-hook notice on the live stream +
 * persistence (FINDING A, direct-drive with the REAL AssistantDataStreamSession
 * — the @brainstrike/agent partial mock spreading `actual` is load-bearing for
 * that), and the hook-blocked turn's failed run status over HTTP (FINDING B).
 * Moved verbatim from the pre-split assistant-server.integration.test.ts
 * (BST-1028 slice 4). Integration lane: both tests write real files and run
 * real shell commands through the hook runner.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AssistantDataStreamSession,
  type AssistantRunEvent,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  type RuntimeData,
  type StreamChunk,
} from '@brainstrike/agent';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { desktopAssistantServerLogger, handleAssistantRequest } from '../../assistant-server';
import { createDesktopHookRunner } from '../../assistant-server/hooks/hook-runner-impl';
import {
  buildHookManager,
  finalizeHookedStream,
  hookRunEventToAssistant,
} from '../../assistant-server/hooks/server-integration';
import { resetDesktopMastraMemoryCacheForTests } from '../../assistant-server/mastra-memory';
import { observeDesktopAssistantRunEvents } from '../../assistant-server/run-persistence';
import { createRunRequest } from './_harness';

// Mock dependencies
vi.mock('../../assistant-server/http', async () => {
  const actual = await vi.importActual<typeof import('../../assistant-server/http')>(
    '../../assistant-server/http'
  );
  return {
    ...actual,
    streamResponse: vi.fn(),
    writeHeaders: vi.fn(),
  };
});

vi.mock('../../mcp-loader', () => ({
  loadMcpConfig: vi.fn(() => Promise.resolve({ config: undefined })),
}));

vi.mock('../../agent-client-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-client-loader')>();
  return {
    ...actual,
    getAgentProviderEnvKeys: vi.fn(() => []),
  };
});

const mockSecretsService = {
  deleteKey: vi.fn(),
  getKey: vi.fn((_provider: string) => Promise.resolve('test-api-key')),
  listProviders: vi.fn(() => Promise.resolve(['openai'])),
  saveKey: vi.fn(),
};

vi.mock('../../secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../secrets')>();
  return {
    ...actual,
    getSecretsService: vi.fn(() => mockSecretsService),
  };
});

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  const convertAssistantUiMessages = vi.fn((messages) => messages);
  return {
    ...actual,
    assistantDataStreamSessions: {
      create: vi.fn(() => ({
        createResponse: vi.fn(() => ({
          body: null,
          headers: new Headers(),
          status: 200,
        })),
        getTerminalOutcome: vi.fn(() => ({ error: null, status: 'completed' })),
        id: 'session-test',
        messageId: 'assistant-message-test',
        whenClosed: vi.fn(() => Promise.resolve()),
      })),
    },
    convertAssistantUiMessages,
    convertAssistantUiMessagesWithFinalInput: vi.fn(
      (
        messages: Parameters<typeof actual.convertAssistantUiMessagesWithFinalInput>[0]
      ): ReturnType<typeof actual.convertAssistantUiMessagesWithFinalInput> => {
        const finalRawMessage = messages.at(-1);
        const { finalInputMessage } = actual.convertAssistantUiMessagesWithFinalInput(
          finalRawMessage ? [finalRawMessage] : []
        );
        return {
          finalInputMessage,
          messages: convertAssistantUiMessages(messages),
        };
      }
    ),
    createEmbeddingProvider: vi.fn((provider: string, apiKey: string, model: string) => ({
      apiKey,
      model,
      provider,
      type: 'embedding-model',
    })),
    createLanguageModelProvider: vi.fn((provider: string, apiKey: string, model: string) => ({
      apiKey,
      model,
      provider,
    })),
    isSupportedProvider: (provider: string) =>
      ['openai', 'anthropic', 'google', 'openrouter', 'local', 'ollama'].includes(provider),
    listSuspendedMastraRuns: vi.fn(() => Promise.resolve({ approvals: [] })),
    resolveDataStreamSession: vi.fn(() => {}),
    sanitizeAssistantRunEventMetadata: vi.fn((metadata) => metadata),
    streamMastraToolApprovalAction: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'approval resumed' };
      },
    })),
    streamMastraToolResumeAction: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'suspend resumed' };
      },
    })),
    toAiSdkStyleStream: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { content: 'test', type: 'text' };
      },
    })),
  };
});

const mockPgliteMastraMemory = { id: 'desktop-memory' };
const mockPgliteMastraStorage = { id: 'desktop-storage' };
const mockDesktopDatabase = {
  exec: vi.fn(),
  query: vi.fn(),
};

vi.mock('@brainstrike/agent/pglite-mastra-memory', () => ({
  createPgliteMastraMemory: vi.fn(() =>
    Promise.resolve({
      memory: mockPgliteMastraMemory,
      storage: mockPgliteMastraStorage,
      store: {},
      vector: {},
      workflows: {},
    })
  ),
}));

vi.mock('../../assistant-server/assistant-tools', () => ({
  buildDesktopAssistantTools: vi.fn(() => ({})),
}));

// The "@file" context injector resolves referenced files through this reader.
// None of these tests send a file directive, so it is never invoked — but it
// must exist on the mock so the server's named import resolves.
vi.mock('../../assistant-server/workspace-text-file-reader', () => ({
  readWorkspaceTextFile: vi.fn(async () => ({ content: '', path: '', size: 0 })),
}));

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(() => Promise.resolve(mockDesktopDatabase)),
}));

const runRequest = createRunRequest(handleAssistantRequest);

beforeEach(() => {
  mockDesktopDatabase.exec.mockReset();
  mockDesktopDatabase.query.mockReset();
  // Default: workspace-roots enrichment (runs first on every assistant
  // stream init) sees no roots and cleanly falls back. Tests that exercise
  // other queries override this.
  mockDesktopDatabase.query.mockResolvedValue({ rows: [] });
  resetDesktopMastraMemoryCacheForTests();
  mockSecretsService.getKey.mockReset().mockResolvedValue('test-api-key');
  mockSecretsService.listProviders.mockReset().mockResolvedValue(['openai']);
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: false });
});

afterEach(() => {
  vi.clearAllMocks();
  resetDesktopMastraMemoryCacheForTests();
}, 15_000);
describe('tool-lifecycle hooks P2 (Stop notice + blocked-run status)', () => {
  function writeHooksFile(rootAbsPath: string, config: Record<string, unknown>): string {
    const dir = join(rootAbsPath, '.brainstrike');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'hooks.json');
    writeFileSync(file, JSON.stringify(config), 'utf8');
    return file;
  }

  function sha256OfFile(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  }

  // FINDING A: the live data-stream consumer (AssistantDataStreamSession) stops
  // pulling the source the moment the mapper emits `finish`. If the terminal
  // Stop hook only runs AFTER the finish chunk is yielded, its queued
  // hook.notice never reaches EITHER the live stream or persistence. Drive the
  // REAL consumer chain (session + finalizeHookedStream + real observer) and
  // assert the notice lands on both.
  it('FINDING A: a Stop-hook notice reaches the live stream and persistence', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bs-hooks-a-'));
    try {
      const noteText = 'stop-note-visible-xyz';
      const file = writeHooksFile(tmp, {
        Stop: [{ command: `echo '{"additionalContext":"${noteText}"}'`, type: 'command' }],
      });
      const runId = 'run-A';
      const queuedRunEvents: AssistantRunEvent[] = [];
      const manager = buildHookManager({
        emitRunEvent: (event) => queuedRunEvents.push(hookRunEventToAssistant(event)),
        hookTrustRequest: {
          approvals: [{ approvedAt: 1, rootId: 'root-1', sha256: sha256OfFile(file) }],
        },
        logger: desktopAssistantServerLogger,
        runtimeData: {
          provider: 'openai',
          workspaceRoots: [{ displayName: 'root', path: tmp, rootId: 'root-1' }],
        } as RuntimeData,
        sessionId: runId,
      });
      expect(manager.hasHooks()).toBe(true);
      const runner = createDesktopHookRunner(manager);

      async function* model(): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', value: 'answer' };
        yield {
          finishReason: 'stop',
          path: [],
          type: 'message-finish',
          usage: { completionTokens: 0, promptTokens: 0 },
        };
      }

      const controller = new AbortController();
      const source = finalizeHookedStream(model(), {
        manager,
        observe: (src) =>
          observeDesktopAssistantRunEvents(
            src,
            runId,
            queuedRunEvents,
            async () => mockDesktopDatabase
          ),
        runner,
        signal: controller.signal,
      });
      const session = new AssistantDataStreamSession(source, () => {});
      const body = await session.createResponse().text();

      // (a) live data-stream output carries the Stop notice.
      expect(body).toContain(noteText);
      // (b) the notice was persisted as a run event (detail is an INSERT param).
      const persistedValues = mockDesktopDatabase.query.mock.calls
        .map((call) => call[1])
        .filter((params): params is unknown[] => Array.isArray(params))
        .flat();
      expect(persistedValues).toContain(noteText);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  }, 15_000);

  // FINDING B: a UserPromptSubmit hook that blocks a fresh turn short-circuits
  // with a visible message + run.failed but returns an `ok:true` stream, so the
  // run row was persisted as `completed`. Drive the real POST path and assert
  // the persisted terminal status is `failed`.
  it('FINDING B: a hook-blocked turn records a failed run status', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bs-hooks-b-'));
    try {
      const file = writeHooksFile(tmp, {
        UserPromptSubmit: [
          { command: `echo '{"reason":"nope-blocked"}'; exit 2`, type: 'command' },
        ],
      });
      const { streamResponse } = await import('../../assistant-server/http');
      (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
        (res as { end?: () => void }).end?.();
      });
      mockDesktopDatabase.query.mockImplementation(async (sql: unknown) =>
        typeof sql === 'string' && sql.includes('FROM roots')
          ? {
              rows: [{ displayName: 'root', id: 'root-1', path: tmp }],
            }
          : { rows: [] }
      );

      await runRequest({
        body: JSON.stringify({
          data: {
            hookTrustRequest: {
              approvals: [{ approvedAt: 1, rootId: 'root-1', sha256: sha256OfFile(file) }],
            },
            memory: {
              // OM enabled-by-default resolves a provider model target; disable
              // it so run-scoped memory constructs from the mock alone.
              memorySettings: {
                ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
                observationalMemory: {
                  ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
                  enabled: false,
                },
              },
              resourceId: 'res-B',
              runId: 'run-B',
              threadId: 'thread-B',
            },
            provider: 'openai',
            workspaceRoots: [{ displayName: 'root', path: tmp, rootId: 'root-1' }],
          },
          messages: [{ parts: [{ text: 'do a thing', type: 'text' }], role: 'user' }],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/',
      });

      const statusUpdate = mockDesktopDatabase.query.mock.calls.find(
        ([sql]) =>
          typeof sql === 'string' &&
          sql.includes('brainstrike_assistant_thread_runs') &&
          sql.includes('SET status')
      );
      expect(statusUpdate).toBeDefined();
      const params = statusUpdate?.[1] as unknown[] | undefined;
      // completeDesktopAssistantThreadRun params: [runId, status, error, now, now]
      expect(params?.[0]).toBe('run-B');
      expect(params?.[1]).toBe('failed');
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  }, 15_000);
});
