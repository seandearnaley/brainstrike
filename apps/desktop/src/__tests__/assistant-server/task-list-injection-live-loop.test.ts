/**
 * LIVE-loop proof for the task-list read→inject seam.
 *
 * Prior assistant-server coverage (assistant-server.test.ts) mocks
 * `toAiSdkStyleStream` to a canned stream, so the REAL instructions-assembly
 * code in `createMastraAgentRuntime` (packages/agent/src/mastra/agent-runtime.ts)
 * never actually runs in that suite — a break in EITHER half of the seam (the
 * DB read + `RuntimeData.taskList` assembly in assistant-server.ts, or the
 * `<current-task-list>` note injection in agent-runtime.ts) could regress
 * silently while every mocked test stayed green. This file closes that gap: it
 * persists a task list through the REAL repository (`writeThreadTaskList`),
 * drives the REAL `handleAssistantRequest` → `initializeAgentStream` wiring,
 * and overrides ONLY `toAiSdkStyleStream` to call through to the REAL
 * `createMastraAgentRuntime` (via `importOriginal`) so the actual built
 * instructions can be captured and asserted on. Everything else — the
 * per-turn DB read, the RuntimeData assembly, and the instructions builder —
 * runs unmocked.
 */
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { Readable } from 'node:stream';
import type { RuntimeData } from '@brainstrike/agent';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAssistantRequest } from '../../assistant-server';
import { writeThreadTaskList } from '../../assistant-server/task-list-repository';

let capturedInstructions: string | undefined;

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

const mockSecretsService = {
  deleteKey: vi.fn(),
  getKey: vi.fn(() => Promise.resolve('test-api-key')),
  listProviders: vi.fn(() => Promise.resolve(['openai'])),
  saveKey: vi.fn(),
};

vi.mock('../../secrets', () => ({
  getSecretsService: vi.fn(() => mockSecretsService),
}));

vi.mock('../../assistant-server/assistant-tools', () => ({
  buildDesktopAssistantTools: vi.fn(() => ({})),
  readWorkspaceTextFile: vi.fn(async () => ({ content: '', path: '', size: 0 })),
}));

const mockPgliteMastraMemory = { id: 'desktop-memory' };
const mockPgliteMastraStorage = { id: 'desktop-storage' };

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

// Restores the REAL @brainstrike/agent module (the global test setup mocks
// createMastraAgentRuntime/streamMastraAgent to inert stubs) and overrides
// ONLY toAiSdkStyleStream: instead of a canned stream, it calls through to the
// REAL createMastraAgentRuntime with the runtime this seam actually built, so
// the produced Agent's instructions can be captured. No network call is made
// — the returned stream is a trivial static iterable, never consumed for
// generation.
vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return {
    ...actual,
    assistantDataStreamSessions: {
      create: vi.fn(() => ({
        createResponse: vi.fn(() => ({
          body: null,
          headers: new Headers(),
          status: 200,
        })),
      })),
    },
    convertAssistantUiMessages: vi.fn((messages) => messages),
    resolveDataStreamSession: vi.fn(() => undefined),
    sanitizeAssistantRunEventMetadata: vi.fn((metadata) => metadata),
    toAiSdkStyleStream: vi.fn(async (_messages: unknown, runtime?: RuntimeData) => {
      const runtimeResult = await actual.createMastraAgentRuntime({ runtime });
      capturedInstructions = runtimeResult.agent.getInstructions();
      await runtimeResult.dispose();
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', value: 'ok' };
        },
      };
    }),
  };
});

interface TaskListTableRow {
  resource_id: string;
  tasks: unknown;
}

const taskListRows = new Map<string, TaskListTableRow>();

const mockDesktopDatabase = {
  exec: vi.fn(),
  query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    if (/brainstrike_assistant_task_lists/i.test(sql)) {
      if (/^\s*SELECT/i.test(sql)) {
        const threadId = String(params[0]);
        const row = taskListRows.get(threadId);
        return { rows: row ? [{ tasks: row.tasks }] : [] };
      }
      if (/^\s*INSERT/i.test(sql)) {
        const threadId = String(params[0]);
        const resourceId = String(params[1]);
        const tasks = JSON.parse(String(params[2]));
        taskListRows.set(threadId, { resource_id: resourceId, tasks });
        return { rows: [] };
      }
    }
    // Workspace-roots enrichment (and anything else) sees no rows and falls
    // back cleanly — only the task-list table is exercised for real here.
    return { rows: [] };
  }),
};

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(() => Promise.resolve(mockDesktopDatabase)),
}));

class MockRequest extends Readable {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  private payload?: string;

  constructor(input: {
    body?: string;
    headers?: http.IncomingHttpHeaders;
    method: string;
    url: string;
  }) {
    super();
    this.method = input.method;
    this.url = input.url;
    this.headers = input.headers ?? {};
    this.payload = input.body;
  }

  _read(): void {
    if (this.payload !== undefined) {
      this.push(this.payload);
    }
    this.payload = undefined;
    this.push(null);
  }
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  bodyChunks: Buffer[] = [];

  setHeader(name: string, value: string | number | readonly string[]): void {
    this.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value);
  }

  removeHeader(name: string): void {
    delete this.headers[name.toLowerCase()];
  }

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        this.setHeader(key, value);
      }
    }
    return this;
  }

  write(chunk: unknown): boolean {
    if (chunk === undefined || chunk === null) {
      return true;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.bodyChunks.push(buffer);
    return true;
  }

  end(chunk?: unknown): void {
    if (chunk !== undefined) {
      this.write(chunk);
    }
    this.emit('finish');
  }
}

async function runRequest(input: {
  body?: string;
  headers?: http.IncomingHttpHeaders;
  method: string;
  url: string;
}): Promise<{ status: number; body: string }> {
  const req = new MockRequest(input);
  const res = new MockResponse();
  const finished = new Promise<void>((resolve) => res.once('finish', resolve));

  // Auth explicitly disabled: this harness exercises the task-list seam, not
  // the token gate (covered in assistant-server.integration.test.ts).
  await handleAssistantRequest(
    req as unknown as http.IncomingMessage,
    res as unknown as http.ServerResponse,
    { auth: 'disabled' }
  );
  await finished;

  return { body: Buffer.concat(res.bodyChunks).toString('utf-8'), status: res.statusCode };
}

const DISABLED_MEMORY_SETTINGS = {
  observationalMemory: {
    enabled: false,
    messageTokens: 20_000,
    modelTarget: 'openai/gpt-5.4-mini',
    observationTokens: 40_000,
    retrievalMode: 'off',
    scope: 'thread',
  },
  semanticRecall: {
    embeddingModelTarget: null,
    enabled: false,
    messageRange: 2,
    scope: 'resource',
    topK: 5,
  },
};

describe('task-list read→inject seam', () => {
  beforeEach(async () => {
    // The real streamResponse pumps the AI-SDK Response's body into `res`; our
    // mocked toAiSdkStyleStream never produces a real body, so this stand-in
    // just ends the response so `runRequest`'s 'finish' await resolves.
    const { streamResponse } = await import('../../assistant-server/http');
    (streamResponse as ReturnType<typeof vi.fn>).mockImplementation(async (res: unknown) => {
      (res as { end?: () => void }).end?.();
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    mockDesktopDatabase.query.mockClear();
    taskListRows.clear();
    capturedInstructions = undefined;
    mockSecretsService.getKey.mockResolvedValue('test-api-key');
    mockSecretsService.listProviders.mockResolvedValue(['openai']);
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: false });
  });

  it('threads a persisted task list into the REAL built instructions for a hosted provider', async () => {
    await writeThreadTaskList(mockDesktopDatabase, {
      resourceId: 'workspace-a',
      tasks: [
        {
          activeForm: 'Writing the seam test',
          content: 'Write the seam test',
          id: 'task-1',
          status: 'in_progress',
        },
      ],
      threadId: 'thread-with-plan',
    });

    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            memorySettings: DISABLED_MEMORY_SETTINGS,
            resourceId: 'workspace-a',
            threadId: 'thread-with-plan',
          },
          provider: 'openai',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(200);
    expect(capturedInstructions).toContain('<current-task-list count="1">');
    expect(capturedInstructions).toContain('[in_progress] Write the seam test');
  });

  it('injects no task-list block for a hosted provider with no persisted list', async () => {
    const response = await runRequest({
      body: JSON.stringify({
        data: {
          memory: {
            memorySettings: DISABLED_MEMORY_SETTINGS,
            resourceId: 'workspace-a',
            threadId: 'thread-without-plan',
          },
          provider: 'openai',
        },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(response.status).toBe(200);
    expect(capturedInstructions).toBeDefined();
    expect(capturedInstructions).not.toContain('<current-task-list');
  });
});
