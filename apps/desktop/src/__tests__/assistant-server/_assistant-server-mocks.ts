import { MASTRA_WORKFLOW_TABLE } from '@brainstrike/assistant-contract/mastra-memory-schema';
import { type Mock, vi } from 'vitest';

/**
 * Shared mock factory bodies + fixtures for the four big assistant-server
 * suites (BST-1029): agent-stream-init-and-memory, mastra-memory-cache,
 * run-persistence-http, hooks-run-lifecycle.
 *
 * Only the `vi.mock(<literal path>)` CALL SITES must stay per-file (hoisting
 * is per-importing-module), and — verified empirically — neither a bare
 * imported factory reference nor a lazy arrow over the STATIC import works:
 * the first throws "Cannot access __vi_import before initialization" at hoist
 * time, and the second still breaks because '../../assistant-server'
 * initializes first in import order and triggers the factories before this
 * module's bindings exist. Call sites therefore reach these factories through
 * a `vi.hoisted` dynamic-import accessor — `const mocks = vi.hoisted(() => ()
 * => import('./_assistant-server-mocks'))`, then `vi.mock('<path>', async ()
 * => (await mocks()).makeXMock())` — which exists before the mocks fire,
 * resolves lazily, and shares the same per-file module instance as the static
 * fixture imports. Each factory resolves its own actuals via vi.importActual
 * (specifiers resolve from THIS directory, which is the suites' directory).
 * Vitest gives every test FILE its own module registry, so the module-scope
 * fixtures below are per-suite instances, never cross-file shared state; each
 * suite's beforeEach still owns resetting them.
 */

interface MockSecretsService {
  deleteKey: Mock<(provider: string) => Promise<boolean>>;
  /** BST-1352: the assistant POST + memory paths read the TYPED credential. */
  getCredential: Mock<(provider: string) => Promise<{ key: string; type: 'api_key' } | null>>;
  getKey: Mock<(provider: string) => Promise<string | null>>;
  listProviders: Mock<() => Promise<string[]>>;
  saveKey: Mock<(provider: string, value: string) => Promise<boolean>>;
}

export const mockSecretsService: MockSecretsService = {
  deleteKey: vi.fn<(provider: string) => Promise<boolean>>(),
  getCredential: vi.fn<(provider: string) => Promise<{ key: string; type: 'api_key' } | null>>(
    (_provider: string) => Promise.resolve({ key: 'test-api-key', type: 'api_key' })
  ),
  getKey: vi.fn<(provider: string) => Promise<string | null>>((_provider: string) =>
    Promise.resolve('test-api-key')
  ),
  listProviders: vi.fn<() => Promise<string[]>>(() => Promise.resolve(['openai'])),
  saveKey: vi.fn<(provider: string, value: string) => Promise<boolean>>(),
};

export const mockPgliteMastraMemory = { id: 'desktop-memory' };
export const mockPgliteMastraStorage = { id: 'desktop-storage' };

interface MockDesktopDatabase {
  exec: Mock<(...args: unknown[]) => Promise<unknown>>;
  query: Mock<(...args: unknown[]) => Promise<{ rows: unknown[] }>>;
}

export const mockDesktopDatabase: MockDesktopDatabase = {
  exec: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  query: vi.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(),
};

/**
 * Pass-through message-conversion spy shared by the root-specifier and
 * hosted-web factories (previously per-file `vi.hoisted`): prep imports
 * conversion from the slim hosted-web subpath (BST-973-2), and the SAME spy
 * is exported from the root factory so existing assertions observe every
 * call regardless of which specifier a test inspects.
 */
export const convertAssistantUiMessages = vi.fn(
  (messages: readonly unknown[]): unknown[] => messages as unknown[]
);

export async function makeAssistantServerHttpMock() {
  const actual = await vi.importActual<typeof import('../../assistant-server/http')>(
    '../../assistant-server/http'
  );
  return {
    ...actual,
    streamResponse: vi.fn(),
    writeHeaders: vi.fn(),
  };
}

export async function makeAgentClientLoaderMock() {
  const actual = await vi.importActual<typeof import('../../agent-client-loader')>(
    '../../agent-client-loader'
  );
  return {
    ...actual,
    getAgentProviderEnvKeys: vi.fn(() => []),
  };
}

export async function makeSecretsMock() {
  const actual = await vi.importActual<typeof import('../../secrets')>('../../secrets');
  return {
    ...actual,
    getSecretsService: vi.fn(() => mockSecretsService),
  };
}

export async function makeHostedWebAgentMock() {
  const actual = await vi.importActual<typeof import('@brainstrike/agent/hosted-web')>(
    '@brainstrike/agent/hosted-web'
  );
  return {
    ...actual,
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
          messages: convertAssistantUiMessages(messages) as ReturnType<
            typeof actual.convertAssistantUiMessagesWithFinalInput
          >['messages'],
        };
      }
    ),
  };
}

export async function makeAgentMock() {
  const actual = await vi.importActual<typeof import('@brainstrike/agent')>('@brainstrike/agent');
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
}

export function makePgliteMastraMemoryMock() {
  return {
    createPgliteMastraMemory: vi.fn(() =>
      Promise.resolve({
        memory: mockPgliteMastraMemory,
        storage: mockPgliteMastraStorage,
        store: {},
        vector: {},
        workflows: {},
      })
    ),
    // The run-critical database wrapper reads it to classify snapshot reads.
    MASTRA_WORKFLOW_TABLE,
  };
}

export function makeAssistantToolsMock() {
  return {
    buildDesktopAssistantTools: vi.fn(() => ({})),
  };
}

/**
 * The "@file" context injector resolves referenced files through this reader.
 * None of the four suites send a file directive, so it is never invoked — but
 * it must exist on the mock so the server's named import resolves.
 */
export function makeWorkspaceTextFileReaderMock() {
  return {
    readWorkspaceTextFile: vi.fn(async () => ({ content: '', path: '', size: 0 })),
  };
}

export function makeDbMainMock(): {
  getDatabase: Mock<() => Promise<MockDesktopDatabase>>;
} {
  return {
    getDatabase: vi.fn(() => Promise.resolve(mockDesktopDatabase)),
  };
}
