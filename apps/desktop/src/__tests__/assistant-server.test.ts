import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { Readable } from 'node:stream';
import { DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES } from '@brainstrike/agent';
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

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return {
    ...actual,
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
    createEmbeddingProvider: vi.fn((provider: string, apiKey: string, model: string) => ({
      apiKey,
      model,
      provider,
      type: 'embedding-model',
    })),
    createProvider: vi.fn((provider: string, apiKey: string, model: string) => ({
      apiKey,
      model,
      provider,
    })),
    resolveDataStreamSession: vi.fn(() => {}),
    sanitizeAssistantRunEventMetadata: vi.fn((metadata) => metadata),
    streamMastraToolApprovalAction: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'approval resumed' };
      },
    })),
    toAiSdkStyleStream: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text', content: 'test' };
      },
    })),
    isSupportedProvider: (provider: string) =>
      ['openai', 'anthropic', 'google', 'openrouter', 'local'].includes(provider),
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

  async function runRequest(
    input: RequestInput,
    serverOptions?: Parameters<typeof handleAssistantRequest>[2]
  ): Promise<{
    status: number;
    body: string;
    headers: Record<string, string>;
  }> {
    const req = new MockRequest(input);
    const res = new MockResponse();
    const finished = new Promise<void>((resolve) => res.once('finish', resolve));

    await handleAssistantRequest(
      req as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      serverOptions
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
      expect(data).toEqual({
        error: 'assistant_status_failed',
        message: 'Assistant status unavailable.',
      });
      expect(response.body).not.toContain('API key read failed');
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

    it('should return JSON 413 when the request body exceeds the default byte limit', async () => {
      const response = await runRequest({
        method: 'POST',
        url: '/assistant',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES + 1),
      });

      expect(response.status).toBe(413);
      const data = JSON.parse(response.body) as { error: string; message: string };
      expect(data.error).toBe('request_body_too_large');
      expect(data.message).toBe(
        `Assistant request body exceeds ${DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES} bytes.`
      );
      expect(response.headers['connection']).toBe('close');
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

    it('routes provider "local" through the injected llm-host manager (warmup + proxy client)', async () => {
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

      const llmHostManager = {
        generateForMain: vi.fn(),
        warmupForMain: vi.fn().mockResolvedValue(undefined),
      };

      const response = await runRequest(
        {
          method: 'POST',
          url: '/',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
            data: { provider: 'local', model: 'onnx-community/gemma-4-E2B-it-ONNX' },
          }),
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
      expect(runtime.localLlmHostClient).toBeDefined();
      expect(typeof (runtime.localLlmHostClient as { generate: unknown }).generate).toBe(
        'function'
      );
    });

    it('fails provider "local" with a structured error when no llm-host manager is injected', async () => {
      const { convertAssistantUiMessages } = await import('@brainstrike/agent');
      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);

      const response = await runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: { provider: 'local', model: 'onnx-community/gemma-4-E2B-it-ONNX' },
        }),
      });

      expect(response.status).toBe(502);
      const payload = JSON.parse(response.body) as { error: string };
      expect(payload.error).toBe('agent_stream_init_failed');
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

      const { createProvider } = await import('@brainstrike/agent');

      expect(getDatabase).toHaveBeenCalledTimes(1);
      expect(createProvider).toHaveBeenCalledWith(
        'anthropic',
        'test-api-key',
        'claude-haiku-4-5',
        expect.objectContaining({ provider: 'openai', apiKey: 'test-api-key' })
      );
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
        observationalMemoryModel: {
          apiKey: 'test-api-key',
          model: 'claude-haiku-4-5',
          provider: 'anthropic',
        },
      });
      expect(toAiSdkStyleStream).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          memory: expect.objectContaining({ threadId: 'thread-1', resourceId: 'workspace-a' }),
        }),
        { memory: mockPgliteMastraMemory, storage: mockPgliteMastraStorage }
      );
    });

    it('builds observational memory on the built-in local model via the llm-host proxy', async () => {
      const { createProvider, toAiSdkStyleStream, convertAssistantUiMessages } = await import(
        '@brainstrike/agent'
      );
      const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
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

      const llmHostManager = {
        generateForMain: vi.fn(),
        warmupForMain: vi.fn().mockResolvedValue(undefined),
      };

      const response = await runRequest(
        {
          method: 'POST',
          url: '/',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
            data: {
              provider: 'openai',
              memory: {
                threadId: 'thread-local-om',
                resourceId: 'workspace-local-om',
                memorySettings: {
                  observationalMemory: {
                    enabled: true,
                    modelTarget: 'local/onnx-community/gemma-4-E2B-it-ONNX',
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
      expect(createProvider).toHaveBeenCalledWith(
        'local',
        '',
        'onnx-community/gemma-4-E2B-it-ONNX',
        expect.objectContaining({ localLlmHostClient: expect.anything() })
      );
      expect(createPgliteMastraMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          observationalMemoryModel: expect.objectContaining({
            provider: 'local',
            model: 'onnx-community/gemma-4-E2B-it-ONNX',
          }),
        })
      );
    });

    it('builds semantic recall on the built-in local embedder via the embedding host', async () => {
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
      const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
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

      const embeddingHostManager = {
        queryEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
      };

      const response = await runRequest(
        {
          method: 'POST',
          url: '/',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
            data: {
              provider: 'openai',
              memory: {
                threadId: 'thread-local-recall',
                resourceId: 'workspace-local-recall',
                memorySettings: {
                  observationalMemory: {
                    enabled: false,
                    modelTarget: 'openai/gpt-5.4-mini',
                    scope: 'thread',
                    messageTokens: 20_000,
                    observationTokens: 40_000,
                    retrievalMode: 'off',
                  },
                  semanticRecall: {
                    enabled: true,
                    embeddingModelTarget: 'local/Xenova/all-MiniLM-L6-v2',
                    scope: 'resource',
                    topK: 5,
                    messageRange: 2,
                  },
                },
              },
            },
          }),
        },
        { embeddingHostManager }
      );

      expect(response.status).toBe(200);
      // The REAL local embedder (not the mocked hosted factory) reached memory
      // construction, keyless, bound to the embedding host client.
      expect(createPgliteMastraMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          embedder: expect.objectContaining({
            provider: 'local',
            modelId: 'Xenova/all-MiniLM-L6-v2',
            specificationVersion: 'v2',
          }),
        })
      );
    });

    it('resolves the recall embedder when observational vector retrieval is on but semantic recall is off', async () => {
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
      const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
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

      const embeddingHostManager = {
        queryEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
      };

      const response = await runRequest(
        {
          method: 'POST',
          url: '/',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
            data: {
              provider: 'openai',
              memory: {
                threadId: 'thread-om-vector',
                resourceId: 'workspace-om-vector',
                memorySettings: {
                  observationalMemory: {
                    enabled: true,
                    modelTarget: 'openai/gpt-5.4-mini',
                    scope: 'thread',
                    messageTokens: 20_000,
                    observationTokens: 40_000,
                    // Vector observation retrieval needs the recall embedder
                    // even though the semanticRecall toggle below is OFF.
                    retrievalMode: 'vector',
                  },
                  semanticRecall: {
                    enabled: false,
                    embeddingModelTarget: 'local/Xenova/all-MiniLM-L6-v2',
                    scope: 'resource',
                    topK: 5,
                    messageRange: 2,
                  },
                },
              },
            },
          }),
        },
        { embeddingHostManager }
      );

      expect(response.status).toBe(200);
      expect(createPgliteMastraMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          embedder: expect.objectContaining({
            provider: 'local',
            modelId: 'Xenova/all-MiniLM-L6-v2',
          }),
        })
      );
    });

    it('fails local semantic recall with a structured error when no embedding host manager is injected', async () => {
      const { convertAssistantUiMessages } = await import('@brainstrike/agent');
      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);

      const response = await runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: {
            provider: 'openai',
            memory: {
              threadId: 'thread-local-recall-missing',
              resourceId: 'workspace-local-recall-missing',
              memorySettings: {
                observationalMemory: {
                  enabled: false,
                  modelTarget: 'openai/gpt-5.4-mini',
                  scope: 'thread',
                  messageTokens: 20_000,
                  observationTokens: 40_000,
                  retrievalMode: 'off',
                },
                semanticRecall: {
                  enabled: true,
                  embeddingModelTarget: 'local/Xenova/all-MiniLM-L6-v2',
                  scope: 'resource',
                  topK: 5,
                  messageRange: 2,
                },
              },
            },
          },
        }),
      });

      expect(response.status).toBe(502);
      const payload = JSON.parse(response.body) as { error: string };
      expect(payload.error).toBe('agent_stream_init_failed');
    });

    it('fails local observational memory with a structured error when no llm-host manager is injected', async () => {
      const { convertAssistantUiMessages } = await import('@brainstrike/agent');
      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);

      const response = await runRequest({
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: {
            provider: 'openai',
            memory: {
              threadId: 'thread-local-om-missing',
              resourceId: 'workspace-local-om-missing',
              memorySettings: {
                observationalMemory: {
                  enabled: true,
                  modelTarget: 'local/onnx-community/gemma-4-E2B-it-ONNX',
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

      expect(response.status).toBe(502);
      const payload = JSON.parse(response.body) as { error: string };
      expect(payload.error).toBe('agent_stream_init_failed');
    });

    it('routes tool approval actions through Mastra approval resume without requiring a new prompt', async () => {
      const { streamMastraToolApprovalAction, toAiSdkStyleStream, convertAssistantUiMessages } =
        await import('@brainstrike/agent');
      const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
      const { streamResponse } = await import('../assistant-server/http');

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
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
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
          data: {
            provider: 'openai',
            memory: {
              threadId: 'thread-1',
              resourceId: 'workspace-a',
            },
          },
        }),
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
          memory: mockPgliteMastraMemory,
          requireToolApproval: true,
          storage: mockPgliteMastraStorage,
          runtime: expect.objectContaining({
            apiKey: 'test-api-key',
            provider: 'openai',
            memory: expect.objectContaining({
              threadId: 'thread-1',
              resourceId: 'workspace-a',
            }),
          }),
        })
      );
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
        method: 'POST',
        url: '/',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
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
          data: {
            provider: 'openai',
            memory: {
              threadId: 'thread-1',
              resourceId: 'workspace-a',
            },
          },
        }),
      });

      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        error: 'tool_approval_memory_required',
        message: 'Tool approval resume requires Mastra memory context with workflow storage.',
      });
      expect(streamMastraToolApprovalAction).not.toHaveBeenCalled();
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
          storage: mockPgliteMastraStorage,
          store: {},
          vector: {},
          workflows: {},
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
          yield {
            type: 'run-event',
            event: {
              id: 'event-3',
              kind: 'tool.completed',
              label: 'Tool completed',
              metadata: {
                toolCallId: 'call-1',
                toolName: 'brainstrike.queryEmbeddingSpace',
              },
              status: 'completed',
              timestamp: '2026-04-24T10:00:02.000Z',
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
      expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO brainstrike_assistant_run_events'),
        expect.arrayContaining(['event-3', 'run-1', 7, 'tool.completed', 'completed'])
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
        message: 'Assistant stream failed.',
      });
      expect(response.body).not.toContain('stream pipeline failed');
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
      expect(data).toEqual({
        error: 'agent_stream_init_failed',
        message: 'Assistant stream initialization failed.',
      });
      expect(response.body).not.toContain('Stream initialization failed');
    }, 10_000);
  });
});
