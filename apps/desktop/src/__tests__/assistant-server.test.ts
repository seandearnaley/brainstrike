import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  desktopAssistantServerLogger,
  getDesktopMastraMemoryForTests,
  handleAssistantRequest,
  resetDesktopMastraMemoryCacheForTests,
  startAssistantServer,
} from '../assistant-server';
import { DESKTOP_DEV_RENDERER_URL } from '../desktop-renderer-url';

const desktopRendererOrigin = new URL(DESKTOP_DEV_RENDERER_URL).origin;

// Mock dependencies
vi.mock('../assistant-server/http', async () => {
  const actual = await vi.importActual<typeof import('../assistant-server/http')>(
    '../assistant-server/http'
  );
  return {
    ...actual,
    streamResponse: vi.fn(),
    writeHeaders: vi.fn(),
  };
});

vi.mock('../mcp-loader', () => ({
  loadMcpConfig: vi.fn(() => Promise.resolve({ config: undefined })),
}));

vi.mock('../openai-api-key', () => ({
  readOpenAIApiKey: vi.fn(() => Promise.resolve('test-api-key')),
}));

const mockSecretsService = {
  saveKey: vi.fn(),
  getKey: vi.fn(() => Promise.resolve('test-api-key')),
  deleteKey: vi.fn(),
  listProviders: vi.fn(() => Promise.resolve(['openai'])),
};

vi.mock('../secrets', () => ({
  getSecretsService: vi.fn(() => mockSecretsService),
}));

vi.mock('@brainstrike/agent', () => ({
  assistantDataStreamSessions: {
    create: vi.fn(() => ({
      createResponse: vi.fn(() => ({
        status: 200,
        headers: new Headers(),
        body: null,
      })),
    })),
  },
  convertAssistantUiMessages: vi.fn((messages) => messages),
  resolveDataStreamSession: vi.fn(() => {}),
  sanitizeAssistantRunEventMetadata: vi.fn((metadata) => metadata),
  toAiSdkStyleStream: vi.fn(async () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'text', content: 'test' };
    },
  })),
  isSupportedProvider: (provider: string) =>
    ['openai', 'anthropic', 'google', 'openrouter'].includes(provider),
}));

const mockPgliteMastraMemory = { id: 'desktop-memory' };
const mockDesktopDatabase = {
  exec: vi.fn(),
  query: vi.fn(),
};

vi.mock('@brainstrike/agent/pglite-mastra-memory', () => ({
  createPgliteMastraMemory: vi.fn(() =>
    Promise.resolve({
      memory: mockPgliteMastraMemory,
      storage: {},
      store: {},
      vector: {},
    })
  ),
}));

vi.mock('../assistant-server/assistant-tools', () => ({
  buildDesktopAssistantTools: vi.fn(() => ({})),
}));

vi.mock('../db-main', () => ({
  getDatabase: vi.fn(() => Promise.resolve(mockDesktopDatabase)),
}));

describe('assistant-server', () => {
  let server: { url: string; stop: () => Promise<void> } | undefined;
  interface RequestInput {
    body?: string;
    headers?: http.IncomingHttpHeaders;
    method: string;
    url: string;
  }

  class MockRequest extends Readable {
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    private payload?: string;

    constructor(input: RequestInput) {
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
    destroyed = false;

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

  async function runRequest(input: RequestInput): Promise<{
    status: number;
    body: string;
    headers: Record<string, string>;
  }> {
    const req = new MockRequest(input);
    const res = new MockResponse();
    const finished = new Promise<void>((resolve) => res.once('finish', resolve));

    await handleAssistantRequest(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse
    );
    await finished;

    return {
      status: res.statusCode,
      body: Buffer.concat(res.bodyChunks).toString('utf-8'),
      headers: res.headers,
    };
  }

  afterEach(async () => {
    if (server) {
      try {
        // Add timeout to prevent hanging
        await Promise.race([
          server.stop(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Server stop timeout')), 5000)
          ),
        ]).catch(() => {
          // Ignore stop errors in cleanup
        });
      } catch {
        // Ignore stop errors in cleanup
      }
      server = undefined;
    }
    vi.clearAllMocks();
    mockDesktopDatabase.exec.mockReset();
    mockDesktopDatabase.query.mockReset();
    resetDesktopMastraMemoryCacheForTests();
    mockSecretsService.getKey.mockResolvedValue('test-api-key');
    mockSecretsService.listProviders.mockResolvedValue(['openai']);
  }, 15_000);

  describe('startAssistantServer', () => {
    it('should start server on dynamic port by default', async () => {
      server = await startAssistantServer(undefined, { listen: false });

      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(server.stop).toBeInstanceOf(Function);
    });

    it('should start server on specified port hint', async () => {
      server = await startAssistantServer(0, { listen: false }); // Use 0 for dynamic port

      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it('should respect BS_ASSISTANT_PORT environment variable', async () => {
      const originalEnv = process.env['BS_ASSISTANT_PORT'];
      process.env['BS_ASSISTANT_PORT'] = '0'; // Use 0 for dynamic port

      server = await startAssistantServer(undefined, { listen: false });

      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      if (originalEnv === undefined) {
        process.env['BS_ASSISTANT_PORT'] = undefined;
      } else {
        process.env['BS_ASSISTANT_PORT'] = originalEnv;
      }
    });

    it('should allow stopping the server', async () => {
      server = await startAssistantServer(undefined, { listen: false });
      await expect(server.stop()).resolves.not.toThrow();
      server = undefined; // Mark as stopped
    });
  });

  describe('HTTP request handling', () => {
    it('should handle status route with API key present', async () => {
      const { readOpenAIApiKey } = await import('../openai-api-key');
      (readOpenAIApiKey as Mock).mockResolvedValueOnce('test-key');
      mockSecretsService.listProviders.mockResolvedValueOnce(['openai']);
      mockSecretsService.getKey.mockResolvedValueOnce('test-key');

      const response = await runRequest({
        method: 'GET',
        url: '/assistant/status',
        headers: { origin: desktopRendererOrigin },
      });

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(desktopRendererOrigin);
      expect(response.headers['access-control-allow-methods']).toContain('OPTIONS');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      const data = JSON.parse(response.body) as { enabled: boolean; providers: string[] };
      // 'local' provider is always available (no API key required)
      expect(data).toEqual({ enabled: true, providers: ['openai', 'local'] });
    }, 10_000);

    it('should handle status route with query parameters', async () => {
      const response = await runRequest({
        method: 'GET',
        url: '/assistant/status?source=healthcheck',
        headers: { origin: desktopRendererOrigin },
      });

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(desktopRendererOrigin);
    });

    it('should handle CORS preflight for assistant routes', async () => {
      const response = await runRequest({
        method: 'OPTIONS',
        url: '/assistant/status?source=test',
        headers: {
          origin: desktopRendererOrigin,
          'access-control-request-method': 'POST',
        },
      });

      expect(response.status).toBe(204);
      expect(response.body).toBe('');
      expect(response.headers['access-control-allow-origin']).toBe(desktopRendererOrigin);
      expect(response.headers['access-control-allow-headers']).toContain('Content-Type');
      expect(response.headers['access-control-allow-methods']).toContain('POST');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('should return 204 for OPTIONS on unknown routes', async () => {
      const response = await runRequest({
        method: 'OPTIONS',
        url: '/unknown?source=test',
        headers: {
          origin: desktopRendererOrigin,
          'access-control-request-method': 'POST',
        },
      });

      expect(response.status).toBe(204);
      expect(response.body).toBe('');
    });

    it('should return null CORS origin for preflight requests from disallowed origins', async () => {
      const response = await runRequest({
        method: 'OPTIONS',
        url: '/assistant/status?source=test',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'POST',
        },
      });

      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBe('null');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      const data = JSON.parse(response.body) as { error: string };
      expect(data.error).toBe('forbidden_origin');
    });

    it('should not treat non-preflight OPTIONS requests as CORS preflight', async () => {
      const response = await runRequest({
        method: 'OPTIONS',
        url: '/assistant/status',
        headers: { origin: desktopRendererOrigin },
      });

      expect(response.status).toBe(404);
      expect(response.body).toBe('not found');
    });

    it('should allow null origin for packaged Electron renderer requests', async () => {
      const response = await runRequest({
        method: 'GET',
        url: '/assistant/status',
        headers: { origin: 'null' },
      });

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('null');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('should reject assistant POST requests from disallowed origins', async () => {
      const response = await runRequest({
        method: 'POST',
        url: '/assistant',
        headers: {
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: { provider: 'openai' },
        }),
      });

      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBe('null');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      const data = JSON.parse(response.body) as { error: string };
      expect(data.error).toBe('forbidden_origin');
    });

    it('should default missing Origin header to null CORS origin', async () => {
      const response = await runRequest({
        method: 'GET',
        url: '/assistant/status',
      });

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('null');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('should reject requests from disallowed origins', async () => {
      const response = await runRequest({
        method: 'GET',
        url: '/assistant/status',
        headers: { origin: 'https://evil.example' },
      });

      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBe('null');
      const data = JSON.parse(response.body) as { error: string };
      expect(data.error).toBe('forbidden_origin');
    });

    it('should reject malformed origin headers', async () => {
      const response = await runRequest({
        method: 'GET',
        url: '/assistant/status',
        headers: { origin: 'not-a-url' },
      });

      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBe('null');
      const data = JSON.parse(response.body) as { error: string };
      expect(data.error).toBe('forbidden_origin');
    });

    it('should reject comma-separated multi-origin header values', async () => {
      const response = await runRequest({
        method: 'GET',
        url: '/assistant/status',
        headers: { origin: `${desktopRendererOrigin}, https://evil.example` },
      });

      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBe('null');
      const data = JSON.parse(response.body) as { error: string };
      expect(data.error).toBe('forbidden_origin');
    });

    it('should reject localhost origins over https', async () => {
      const response = await runRequest({
        method: 'GET',
        url: '/assistant/status',
        headers: { origin: `https://localhost:${new URL(DESKTOP_DEV_RENDERER_URL).port}` },
      });

      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBe('null');
    });

    it('should handle status route with missing API key', async () => {
      const { readOpenAIApiKey } = await import('../openai-api-key');
      (readOpenAIApiKey as Mock).mockResolvedValueOnce(undefined);
      mockSecretsService.listProviders.mockResolvedValueOnce([]);
      mockSecretsService.getKey.mockResolvedValueOnce(null);

      const response = await runRequest({ method: 'GET', url: '/status' });

      expect(response.status).toBe(200);
      const data = JSON.parse(response.body) as { enabled: boolean; providers: string[] };
      // 'local' provider is always available (no API key required)
      expect(data).toEqual({ enabled: true, providers: ['local'] });
    }, 10_000);

    it('should handle status route errors', async () => {
      const { readOpenAIApiKey } = await import('../openai-api-key');
      (readOpenAIApiKey as Mock).mockRejectedValueOnce(new Error('API key read failed'));

      const response = await runRequest({ method: 'GET', url: '/status' });

      expect(response.status).toBe(500);
      const data = JSON.parse(response.body) as { error: string; message: string };
      expect(data.error).toBe('assistant_status_failed');
      expect(data.message).toBe('API key read failed');
    }, 10_000);

    it('should return 404 for unknown routes', async () => {
      const response = await runRequest({ method: 'GET', url: '/unknown' });

      expect(response.status).toBe(404);
      expect(response.body).toBe('not found');
    }, 10_000);

    it('should handle POST to assistant route with empty prompt', async () => {
      const response = await runRequest({
        method: 'POST',
        url: '/assistant',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: '   ' }] }],
          data: { provider: 'openai' },
        }),
      });

      expect(response.status).toBe(400);
      const data = JSON.parse(response.body) as { error: string };
      expect(data.error).toBe('empty_prompt');
    }, 10_000);

    it('should reject assistant route when provider is missing', async () => {
      const response = await runRequest({
        method: 'POST',
        url: '/assistant',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
        }),
      });

      expect(response.status).toBe(400);
      const data = JSON.parse(response.body) as { error: string };
      expect(data.error).toBe('missing_provider');
    }, 10_000);

    it('should reject assistant route when provider API key is missing', async () => {
      mockSecretsService.getKey.mockResolvedValueOnce(null);

      const response = await runRequest({
        method: 'POST',
        url: '/assistant',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: { provider: 'openai' },
        }),
      });

      expect(response.status).toBe(400);
      const data = JSON.parse(response.body) as { error: string; message: string };
      expect(data.error).toBe('missing_api_key');
      expect(data.message).toContain('openai');
    }, 10_000);

    it('should reject assistant route with invalid JSON payload', async () => {
      const response = await runRequest({
        method: 'POST',
        url: '/assistant',
        headers: { 'content-type': 'application/json' },
        body: '{"messages":[{"role":"user","parts":[{"type":"text","text":"Hello"}]}],',
      });

      expect(response.status).toBe(400);
      const data = JSON.parse(response.body) as { error: string; message: string };
      expect(data.error).toBe('invalid_json');
      expect(data.message).toBe('Request body must be valid JSON.');
    }, 10_000);

    it('should handle POST to assistant route with valid message', async () => {
      const loggerInfoSpy = vi
        .spyOn(desktopAssistantServerLogger, 'info')
        .mockImplementation(() => {});
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
      const { streamResponse } = await import('../assistant-server/http');

      // Make sure convertAssistantUiMessages actually returns messages
      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);

      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text', content: 'Response' };
        },
      });

      // Ensure streamResponse resolves immediately
      (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
        const response = res as { end?: () => void };
        response.end?.();
      });

      const requestPromise = runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: { provider: 'openai' },
        }),
      });

      await vi.waitUntil(
        () =>
          loggerInfoSpy.mock.calls.some(
            ([message, payload]) =>
              message === 'Assistant request received' &&
              Boolean((payload as { hasApiKey?: boolean })?.hasApiKey)
          ),
        { timeout: 2000 }
      );

      expect(loggerInfoSpy).toHaveBeenCalledWith(
        'Assistant request received',
        expect.objectContaining({ hasApiKey: true })
      );

      loggerInfoSpy.mockRestore();

      await Promise.race([requestPromise, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }, 15_000);

    it('passes filesystem MCP config through to the Mastra runtime', async () => {
      const { loadMcpConfig } = await import('../mcp-loader');
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
      const { streamResponse } = await import('../assistant-server/http');

      vi.mocked(loadMcpConfig).mockResolvedValueOnce({
        config: {
          servers: [
            {
              name: 'filesystem',
              transport: 'stdio',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            },
          ],
        },
      } as never);

      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);

      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text', content: 'Response' };
        },
      });

      (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
        const response = res as { end?: () => void };
        response.end?.();
      });

      await runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: { provider: 'openai' },
        }),
      });

      expect(toAiSdkStyleStream).toHaveBeenCalledTimes(1);
      const [, runtime] = (toAiSdkStyleStream as Mock).mock.calls[0] as [
        unknown,
        Record<string, unknown>,
      ];
      expect(runtime.mcpConfig).toEqual({
        servers: [
          {
            name: 'filesystem',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          },
        ],
      });
    });

    it('does not prepend selected-file context as a hidden system message', async () => {
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
      const { streamResponse } = await import('../assistant-server/http');

      mockDesktopDatabase.query.mockResolvedValueOnce({
        rows: [{ path: '/src/main.ts', content: 'const hidden = true;' }],
      });
      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);
      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text', content: 'Response' };
        },
      });
      (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
        const response = res as { end?: () => void };
        response.end?.();
      });

      await runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: {
            provider: 'openai',
            selectionFilePaths: ['/src/main.ts'],
            includeFileReport: true,
          },
        }),
      });

      const [messages] = (toAiSdkStyleStream as Mock).mock.calls[0] as [Array<{ role: string }>];
      expect(messages).toEqual([{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }]);
      expect(mockDesktopDatabase.query).not.toHaveBeenCalled();
    });

    it('initializes PGlite Mastra memory when memory runtime context is present', async () => {
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
      const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
      const { getDatabase } = await import('../db-main');
      const { streamResponse } = await import('../assistant-server/http');

      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);
      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text', content: 'Response' };
        },
      });
      (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
        const response = res as { end?: () => void };
        response.end?.();
      });

      await runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: {
            provider: 'openai',
            memory: {
              threadId: 'thread-1',
              resourceId: 'workspace-a',
              memorySettings: {
                observationalMemory: {
                  enabled: true,
                  modelTarget: 'anthropic/claude-haiku-4-5',
                  scope: 'thread',
                  messageTokens: 20_000,
                  observationTokens: 40_000,
                  retrievalMode: 'off',
                },
                semanticRecall: {
                  enabled: false,
                  embeddingModelTarget: 'openai/text-embedding-3-small',
                  scope: 'resource',
                  topK: 5,
                  messageRange: 2,
                },
              },
            },
          },
        }),
      });

      expect(getDatabase).toHaveBeenCalledTimes(1);
      expect(createPgliteMastraMemory).toHaveBeenCalledWith({
        database: expect.anything(),
        memorySettings: {
          observationalMemory: {
            enabled: true,
            modelTarget: 'anthropic/claude-haiku-4-5',
            scope: 'thread',
            messageTokens: 20_000,
            observationTokens: 40_000,
            retrievalMode: 'off',
          },
          semanticRecall: {
            enabled: false,
            embeddingModelTarget: 'openai/text-embedding-3-small',
            scope: 'resource',
            topK: 5,
            messageRange: 2,
          },
        },
      });
      expect(toAiSdkStyleStream).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          memory: expect.objectContaining({ threadId: 'thread-1', resourceId: 'workspace-a' }),
        }),
        { memory: mockPgliteMastraMemory }
      );
    });

    it('retries desktop Mastra memory initialization after a transient failure', async () => {
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
      const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
      const { streamResponse } = await import('../assistant-server/http');
      const memoryContext = {
        threadId: 'thread-retry',
        resourceId: 'workspace-retry',
        memorySettings: {
          observationalMemory: {
            enabled: false,
            modelTarget: 'openai/gpt-5.2',
            scope: 'thread',
            messageTokens: 12_000,
            observationTokens: 24_000,
            retrievalMode: 'off',
          },
          semanticRecall: {
            enabled: false,
            embeddingModelTarget: 'openai/text-embedding-3-small',
            scope: 'resource',
            topK: 3,
            messageRange: 1,
          },
        },
      };

      (convertAssistantUiMessages as Mock).mockReturnValue([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);
      (createPgliteMastraMemory as Mock)
        .mockRejectedValueOnce(new Error('temporary memory init failure'))
        .mockResolvedValueOnce({
          memory: mockPgliteMastraMemory,
          storage: {},
          store: {},
          vector: {},
        });
      (toAiSdkStyleStream as Mock).mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text', content: 'Response' };
        },
      });
      (streamResponse as Mock).mockImplementation(async (res: unknown) => {
        const response = res as { end?: () => void };
        response.end?.();
      });

      const failedResponse = await runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: { provider: 'openai', memory: memoryContext },
        }),
      });
      const retriedResponse = await runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: { provider: 'openai', memory: memoryContext },
        }),
      });

      expect(failedResponse.status).toBe(502);
      expect(retriedResponse.status).toBe(200);
      expect(createPgliteMastraMemory).toHaveBeenCalledTimes(2);
    });

    it('keeps separate in-flight Mastra memory initializations keyed by settings', async () => {
      mockDesktopDatabase.exec.mockResolvedValue(undefined);
      const memorySettingsA = {
        observationalMemory: {
          enabled: true,
          modelTarget: 'openai/gpt-5.2',
          scope: 'thread',
          messageTokens: 10_000,
          observationTokens: 20_000,
          retrievalMode: 'off',
        },
        semanticRecall: {
          enabled: false,
          embeddingModelTarget: 'openai/text-embedding-3-small',
          scope: 'resource',
          topK: 3,
          messageRange: 1,
        },
      };
      const memorySettingsB = {
        ...memorySettingsA,
        observationalMemory: {
          ...memorySettingsA.observationalMemory,
          messageTokens: 12_000,
        },
      };

      const firstRequest = getDesktopMastraMemoryForTests(memorySettingsA);
      const secondRequest = getDesktopMastraMemoryForTests(memorySettingsB);
      const thirdRequest = getDesktopMastraMemoryForTests(memorySettingsA);
      const [firstMemory, secondMemory, thirdMemory] = await Promise.all([
        firstRequest,
        secondRequest,
        thirdRequest,
      ]);

      expect(firstMemory).toBe(thirdMemory);
      expect(firstMemory).not.toBe(secondMemory);
    });

    it('reuses desktop Mastra memory for semantically identical settings with different key order', async () => {
      mockDesktopDatabase.exec.mockResolvedValue(undefined);
      const memorySettingsA = {
        observationalMemory: {
          enabled: true,
          modelTarget: 'openai/gpt-5.2',
          scope: 'thread',
          messageTokens: 10_000,
          observationTokens: 20_000,
          retrievalMode: 'off',
        },
        semanticRecall: {
          enabled: false,
          embeddingModelTarget: 'openai/text-embedding-3-small',
          scope: 'resource',
          topK: 3,
          messageRange: 1,
        },
      };
      const memorySettingsB = {
        semanticRecall: {
          messageRange: 1,
          topK: 3,
          scope: 'resource',
          embeddingModelTarget: 'openai/text-embedding-3-small',
          enabled: false,
        },
        observationalMemory: {
          retrievalMode: 'off',
          observationTokens: 20_000,
          messageTokens: 10_000,
          scope: 'thread',
          modelTarget: 'openai/gpt-5.2',
          enabled: true,
        },
      };

      const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
      const firstMemory = await getDesktopMastraMemoryForTests(memorySettingsA);
      const secondMemory = await getDesktopMastraMemoryForTests(memorySettingsB);

      expect(firstMemory).toBe(secondMemory);
      expect(createPgliteMastraMemory).toHaveBeenCalledTimes(1);
    });

    it('evicts the oldest desktop Mastra memory cache entries', async () => {
      mockDesktopDatabase.exec.mockResolvedValue(undefined);
      const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');

      for (let index = 0; index < 17; index += 1) {
        await getDesktopMastraMemoryForTests({
          observationalMemory: {
            enabled: true,
            modelTarget: 'openai/gpt-5.2',
            scope: 'thread',
            messageTokens: 10_000 + index,
            observationTokens: 20_000,
            retrievalMode: 'off',
          },
          semanticRecall: {
            enabled: false,
            embeddingModelTarget: 'openai/text-embedding-3-small',
            scope: 'resource',
            topK: 3,
            messageRange: 1,
          },
        });
      }

      await getDesktopMastraMemoryForTests({
        observationalMemory: {
          enabled: true,
          modelTarget: 'openai/gpt-5.2',
          scope: 'thread',
          messageTokens: 10_000,
          observationTokens: 20_000,
          retrievalMode: 'off',
        },
        semanticRecall: {
          enabled: false,
          embeddingModelTarget: 'openai/text-embedding-3-small',
          scope: 'resource',
          topK: 3,
          messageRange: 1,
        },
      });

      expect(createPgliteMastraMemory).toHaveBeenCalledTimes(18);
    });

    it('marks assistant thread runs completed after desktop streams finish', async () => {
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
      const { streamResponse } = await import('../assistant-server/http');

      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);
      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text', content: 'Response' };
        },
      });
      (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
        const response = res as { end?: () => void };
        response.end?.();
      });

      await runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: {
            provider: 'openai',
            memory: {
              threadId: 'thread-1',
              resourceId: 'workspace-a',
              runId: 'run-1',
            },
          },
        }),
      });

      expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE brainstrike_assistant_thread_runs'),
        expect.arrayContaining(['run-1', 'completed', null])
      );
    });

    it('persists run-event chunks while desktop streams are consumed', async () => {
      const { assistantDataStreamSessions, toAiSdkStyleStream, convertAssistantUiMessages } =
        await import('@brainstrike/agent');
      const { streamResponse } = await import('../assistant-server/http');
      let capturedStream: AsyncIterable<unknown> | null = null;

      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);
      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'run-event',
            event: {
              id: 'event-1',
              kind: 'run.started',
              label: 'Assistant run started',
              status: 'running',
              sequence: 5,
              timestamp: '2026-04-24T10:00:00.000Z',
            },
          };
          yield {
            type: 'run-event',
            event: {
              id: 'event-2',
              kind: 'run.step.started',
              label: 'Step started',
              status: 'running',
              timestamp: '2026-04-24T10:00:01.000Z',
            },
          };
          yield { type: 'text-delta', value: 'Response' };
        },
      });
      (assistantDataStreamSessions.create as Mock).mockImplementationOnce(
        (stream: AsyncIterable<unknown>) => {
          capturedStream = stream;
          return {
            createResponse: vi.fn(() => ({
              status: 200,
              headers: new Headers(),
              body: null,
            })),
          };
        }
      );
      (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
        if (!capturedStream) {
          throw new Error('Expected stream to be captured.');
        }
        for await (const _chunk of capturedStream) {
          // consume stream to trigger run-event persistence
        }
        const response = res as { end?: () => void };
        response.end?.();
      });

      await runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: {
            provider: 'openai',
            memory: {
              threadId: 'thread-1',
              resourceId: 'workspace-a',
              runId: 'run-1',
            },
          },
        }),
      });

      expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO brainstrike_assistant_run_events'),
        expect.arrayContaining(['event-1', 'run-1', 5, 'run.started', 'running'])
      );
      expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO brainstrike_assistant_run_events'),
        expect.arrayContaining(['event-2', 'run-1', 6, 'run.step.started', 'running'])
      );
    });

    it('streams run-event chunks before desktop persistence settles', async () => {
      const { assistantDataStreamSessions, toAiSdkStyleStream, convertAssistantUiMessages } =
        await import('@brainstrike/agent');
      const { streamResponse } = await import('../assistant-server/http');
      let capturedStream: AsyncIterable<unknown> | null = null;
      let resolveInsert: (() => void) | undefined;
      let insertSettled = false;
      let eventYieldedBeforeInsertSettled = false;

      mockDesktopDatabase.query.mockImplementation((sql: unknown) => {
        if (
          typeof sql === 'string' &&
          sql.includes('INSERT INTO brainstrike_assistant_run_events')
        ) {
          return new Promise<void>((resolve) => {
            resolveInsert = () => {
              insertSettled = true;
              resolve();
            };
          });
        }
        return Promise.resolve({ rows: [] });
      });
      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);
      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'run-event',
            event: {
              id: 'event-nonblocking',
              kind: 'run.started',
              label: 'Assistant run started',
              status: 'running',
              timestamp: '2026-04-24T10:00:00.000Z',
            },
          };
        },
      });
      (assistantDataStreamSessions.create as Mock).mockImplementationOnce(
        (stream: AsyncIterable<unknown>) => {
          capturedStream = stream;
          return {
            createResponse: vi.fn(() => ({
              status: 200,
              headers: new Headers(),
              body: null,
            })),
          };
        }
      );
      (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
        if (!capturedStream) {
          throw new Error('Expected stream to be captured.');
        }
        for await (const chunk of capturedStream) {
          if (
            typeof chunk === 'object' &&
            chunk !== null &&
            'type' in chunk &&
            chunk.type === 'run-event'
          ) {
            eventYieldedBeforeInsertSettled = !insertSettled;
            resolveInsert?.();
          }
        }
        const response = res as { end?: () => void };
        response.end?.();
      });

      await runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: {
            provider: 'openai',
            memory: {
              threadId: 'thread-1',
              resourceId: 'workspace-a',
              runId: 'run-1',
            },
          },
        }),
      });

      expect(eventYieldedBeforeInsertSettled).toBe(true);
    });

    it('logs suppressed run-event persistence failures before failing the run', async () => {
      const loggerErrorSpy = vi
        .spyOn(desktopAssistantServerLogger, 'error')
        .mockImplementation(() => {});
      const { assistantDataStreamSessions, toAiSdkStyleStream, convertAssistantUiMessages } =
        await import('@brainstrike/agent');
      const { streamResponse } = await import('../assistant-server/http');
      let capturedStream: AsyncIterable<unknown> | null = null;
      let insertAttempt = 0;

      mockDesktopDatabase.query.mockImplementation((sql: unknown) => {
        if (
          typeof sql === 'string' &&
          sql.includes('INSERT INTO brainstrike_assistant_run_events')
        ) {
          insertAttempt += 1;
          return Promise.reject(new Error(`insert failed ${insertAttempt}`));
        }
        return Promise.resolve({ rows: [] });
      });
      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);
      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'run-event',
            event: {
              id: 'event-failure-1',
              kind: 'run.started',
              label: 'Assistant run started',
              status: 'running',
              timestamp: '2026-04-24T10:00:00.000Z',
            },
          };
          yield {
            type: 'run-event',
            event: {
              id: 'event-failure-2',
              kind: 'run.step.started',
              label: 'Step started',
              status: 'running',
              timestamp: '2026-04-24T10:00:01.000Z',
            },
          };
        },
      });
      (assistantDataStreamSessions.create as Mock).mockImplementationOnce(
        (stream: AsyncIterable<unknown>) => {
          capturedStream = stream;
          return {
            createResponse: vi.fn(() => ({
              status: 200,
              headers: new Headers(),
              body: null,
            })),
          };
        }
      );
      (streamResponse as Mock).mockImplementationOnce(async () => {
        if (!capturedStream) {
          throw new Error('Expected stream to be captured.');
        }
        for await (const _chunk of capturedStream) {
          // consume stream to trigger run-event persistence
        }
      });

      const response = await runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: {
            provider: 'openai',
            memory: {
              threadId: 'thread-1',
              resourceId: 'workspace-a',
              runId: 'run-persistence-failed',
            },
          },
        }),
      });

      expect(response.status).toBe(500);
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Multiple assistant run events failed to persist',
        expect.objectContaining({
          failureCount: 2,
          runId: 'run-persistence-failed',
          suppressedFailureCount: 1,
        })
      );
    });

    it('flushes run-event persistence failures when the source stream throws', async () => {
      const loggerErrorSpy = vi
        .spyOn(desktopAssistantServerLogger, 'error')
        .mockImplementation(() => {});
      const { assistantDataStreamSessions, toAiSdkStyleStream, convertAssistantUiMessages } =
        await import('@brainstrike/agent');
      const { streamResponse } = await import('../assistant-server/http');
      let capturedStream: AsyncIterable<unknown> | null = null;

      mockDesktopDatabase.query.mockImplementation((sql: unknown) => {
        if (
          typeof sql === 'string' &&
          sql.includes('INSERT INTO brainstrike_assistant_run_events')
        ) {
          return Promise.reject(new Error('insert failed before stream error'));
        }
        return Promise.resolve({ rows: [] });
      });
      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);
      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'run-event',
            event: {
              id: 'event-before-source-error',
              kind: 'run.started',
              label: 'Assistant run started',
              status: 'running',
              timestamp: '2026-04-24T10:00:00.000Z',
            },
          };
          throw new Error('agent stream failed');
        },
      });
      (assistantDataStreamSessions.create as Mock).mockImplementationOnce(
        (stream: AsyncIterable<unknown>) => {
          capturedStream = stream;
          return {
            createResponse: vi.fn(() => ({
              status: 200,
              headers: new Headers(),
              body: null,
            })),
          };
        }
      );
      (streamResponse as Mock).mockImplementationOnce(async () => {
        if (!capturedStream) {
          throw new Error('Expected stream to be captured.');
        }
        for await (const _chunk of capturedStream) {
          // consume stream until source error
        }
      });

      const response = await runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: {
            provider: 'openai',
            memory: {
              threadId: 'thread-1',
              resourceId: 'workspace-a',
              runId: 'run-source-error',
            },
          },
        }),
      });

      expect(response.status).toBe(500);
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Failed to flush assistant run event persistence after stream error',
        expect.objectContaining({
          runId: 'run-source-error',
          sourceError: expect.any(Error),
        })
      );
      expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE brainstrike_assistant_thread_runs'),
        expect.arrayContaining(['run-source-error', 'failed', 'agent stream failed'])
      );
    });

    it('marks assistant thread runs failed when response streaming fails', async () => {
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
      const { streamResponse } = await import('../assistant-server/http');

      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);
      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text', content: 'Response' };
        },
      });
      (streamResponse as Mock).mockRejectedValueOnce(new Error('stream pipeline failed'));

      const response = await runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: {
            provider: 'openai',
            memory: {
              threadId: 'thread-1',
              resourceId: 'workspace-a',
              runId: 'run-failed',
            },
          },
        }),
      });

      expect(response.status).toBe(500);
      expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE brainstrike_assistant_thread_runs'),
        expect.arrayContaining(['run-failed', 'failed', 'stream pipeline failed'])
      );
    });

    it('preserves the stream error when failing to mark an assistant thread run failed', async () => {
      const loggerErrorSpy = vi
        .spyOn(desktopAssistantServerLogger, 'error')
        .mockImplementation(() => {});
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
      const { streamResponse } = await import('../assistant-server/http');

      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);
      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text', content: 'Response' };
        },
      });
      (streamResponse as Mock).mockRejectedValueOnce(new Error('stream pipeline failed'));
      mockDesktopDatabase.query.mockRejectedValueOnce(new Error('run status write failed'));

      const response = await runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: {
            provider: 'openai',
            memory: {
              threadId: 'thread-1',
              resourceId: 'workspace-a',
              runId: 'run-failed-status-write',
            },
          },
        }),
      });

      expect(response.status).toBe(500);
      const data = JSON.parse(response.body) as { error: string; message: string };
      expect(data).toEqual({
        error: 'assistant_stream_failed',
        message: 'stream pipeline failed',
      });
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'Failed to update assistant thread run status',
        expect.objectContaining({
          runId: 'run-failed-status-write',
          status: 'failed',
        })
      );

      loggerErrorSpy.mockRestore();
    });

    it('should handle stream initialization failure', async () => {
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');

      // Make sure convertAssistantUiMessages returns messages with non-empty text
      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);

      (toAiSdkStyleStream as Mock).mockRejectedValueOnce(new Error('Stream initialization failed'));

      const response = await runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: { provider: 'openai' },
        }),
      });

      expect(response.status).toBe(502);
      const data = JSON.parse(response.body) as { error: string; message: string };
      expect(data.error).toBe('agent_stream_init_failed');
      expect(data.message).toBe('Stream initialization failed');
    }, 10_000);
  });
});
