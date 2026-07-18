import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  AssistantDataStreamSession,
  type AssistantRunEvent,
  DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  type RuntimeData,
  type StreamChunk,
} from '@brainstrike/agent';
import { app } from 'electron';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  desktopAssistantServerLogger,
  getDesktopMastraMemoryForTests,
  handleAssistantRequest,
  observeDesktopAssistantRunEvents,
  resetDesktopMastraMemoryCacheForTests,
  startAssistantServer,
} from '../assistant-server';
import { createDesktopHookRunner } from '../assistant-server/hooks/hook-runner-impl';
import {
  buildHookManager,
  finalizeHookedStream,
  hookRunEventToAssistant,
} from '../assistant-server/hooks/server-integration';
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
  deleteKey: vi.fn(),
  getKey: vi.fn(() => Promise.resolve('test-api-key')),
  listProviders: vi.fn(() => Promise.resolve(['openai'])),
  saveKey: vi.fn(),
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
          body: null,
          headers: new Headers(),
          status: 200,
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

vi.mock('../assistant-server/assistant-tools', () => ({
  buildDesktopAssistantTools: vi.fn(() => ({})),
  // The "@file" context injector resolves referenced files through this reader.
  // None of these tests send a file directive, so it is never invoked — but it
  // must exist on the mock so the server's named import resolves.
  readWorkspaceTextFile: vi.fn(async () => ({ content: '', path: '', size: 0 })),
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
      body: Buffer.concat(res.bodyChunks).toString('utf-8'),
      headers: res.headers,
      status: res.statusCode,
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
    // Default: workspace-roots enrichment (runs first on every assistant
    // stream init) sees no roots and cleanly falls back. Tests that exercise
    // other queries override this.
    mockDesktopDatabase.query.mockResolvedValue({ rows: [] });
    resetDesktopMastraMemoryCacheForTests();
    mockSecretsService.getKey.mockResolvedValue('test-api-key');
    mockSecretsService.listProviders.mockResolvedValue(['openai']);
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: false });
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
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/status',
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
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/status?source=healthcheck',
      });

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(desktopRendererOrigin);
    });

    it('should handle CORS preflight for assistant routes', async () => {
      const response = await runRequest({
        headers: {
          'access-control-request-method': 'POST',
          origin: desktopRendererOrigin,
        },
        method: 'OPTIONS',
        url: '/assistant/status?source=test',
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
        headers: {
          'access-control-request-method': 'POST',
          origin: desktopRendererOrigin,
        },
        method: 'OPTIONS',
        url: '/unknown?source=test',
      });

      expect(response.status).toBe(204);
      expect(response.body).toBe('');
    });

    it('should return null CORS origin for preflight requests from disallowed origins', async () => {
      const response = await runRequest({
        headers: {
          'access-control-request-method': 'POST',
          origin: 'https://evil.example',
        },
        method: 'OPTIONS',
        url: '/assistant/status?source=test',
      });

      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBe('null');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      const data = JSON.parse(response.body) as { error: string };
      expect(data.error).toBe('forbidden_origin');
    });

    it('should not treat non-preflight OPTIONS requests as CORS preflight', async () => {
      const response = await runRequest({
        headers: { origin: desktopRendererOrigin },
        method: 'OPTIONS',
        url: '/assistant/status',
      });

      expect(response.status).toBe(404);
      expect(response.body).toBe('not found');
    });

    it('should allow null origin for packaged Electron renderer requests', async () => {
      const response = await runRequest({
        headers: { origin: 'null' },
        method: 'GET',
        url: '/assistant/status',
      });

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('null');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('should reject assistant POST requests from disallowed origins', async () => {
      const response = await runRequest({
        body: JSON.stringify({
          data: { provider: 'openai' },
          messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        }),
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
        },
        method: 'POST',
        url: '/assistant',
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
        headers: { origin: 'https://evil.example' },
        method: 'GET',
        url: '/assistant/status',
      });

      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBe('null');
      const data = JSON.parse(response.body) as { error: string };
      expect(data.error).toBe('forbidden_origin');
    });

    it('should reject malformed origin headers', async () => {
      const response = await runRequest({
        headers: { origin: 'not-a-url' },
        method: 'GET',
        url: '/assistant/status',
      });

      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBe('null');
      const data = JSON.parse(response.body) as { error: string };
      expect(data.error).toBe('forbidden_origin');
    });

    it('should reject comma-separated multi-origin header values', async () => {
      const response = await runRequest({
        headers: { origin: `${desktopRendererOrigin}, https://evil.example` },
        method: 'GET',
        url: '/assistant/status',
      });

      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBe('null');
      const data = JSON.parse(response.body) as { error: string };
      expect(data.error).toBe('forbidden_origin');
    });

    it('should reject arbitrary localhost origins on other ports', async () => {
      const response = await runRequest({
        headers: { origin: 'http://localhost:3000' },
        method: 'GET',
        url: '/assistant/status',
      });

      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBe('null');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      const data = JSON.parse(response.body) as { error: string };
      expect(data.error).toBe('forbidden_origin');
    });

    it('should reject the dev renderer origin in packaged builds', async () => {
      Object.defineProperty(app, 'isPackaged', { configurable: true, value: true });

      const response = await runRequest({
        headers: { origin: desktopRendererOrigin },
        method: 'GET',
        url: '/assistant/status',
      });

      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBe('null');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      const data = JSON.parse(response.body) as { error: string };
      expect(data.error).toBe('forbidden_origin');
    });

    it('should reject localhost origins over https', async () => {
      const response = await runRequest({
        headers: { origin: `https://localhost:${new URL(DESKTOP_DEV_RENDERER_URL).port}` },
        method: 'GET',
        url: '/assistant/status',
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
        body: JSON.stringify({
          data: { provider: 'openai' },
          messages: [{ parts: [{ text: '   ', type: 'text' }], role: 'user' }],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/assistant',
      });

      expect(response.status).toBe(400);
      const data = JSON.parse(response.body) as { error: string };
      expect(data.error).toBe('empty_prompt');
    }, 10_000);

    it('should reject assistant route when provider is missing', async () => {
      const response = await runRequest({
        body: JSON.stringify({
          messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/assistant',
      });

      expect(response.status).toBe(400);
      const data = JSON.parse(response.body) as { error: string };
      expect(data.error).toBe('missing_provider');
    }, 10_000);

    it('should reject assistant route when provider API key is missing', async () => {
      mockSecretsService.getKey.mockResolvedValueOnce(null);

      const response = await runRequest({
        body: JSON.stringify({
          data: { provider: 'openai' },
          messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/assistant',
      });

      expect(response.status).toBe(400);
      const data = JSON.parse(response.body) as { error: string; message: string };
      expect(data.error).toBe('missing_api_key');
      expect(data.message).toContain('openai');
    }, 10_000);

    it('should reject assistant route with invalid JSON payload', async () => {
      const response = await runRequest({
        body: '{"messages":[{"role":"user","parts":[{"type":"text","text":"Hello"}]}],',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/assistant',
      });

      expect(response.status).toBe(400);
      const data = JSON.parse(response.body) as { error: string; message: string };
      expect(data.error).toBe('invalid_json');
      expect(data.message).toBe('Request body must be valid JSON.');
    }, 10_000);

    it('should return JSON 413 when the request body exceeds the default byte limit', async () => {
      const response = await runRequest({
        body: 'x'.repeat(DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES + 1),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/assistant',
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
        { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
      ]);

      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield { content: 'Response', type: 'text' };
        },
      });

      // Ensure streamResponse resolves immediately
      (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
        const response = res as { end?: () => void };
        response.end?.();
      });

      const requestPromise = runRequest({
        body: JSON.stringify({
          data: { provider: 'openai' },
          messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/',
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
              args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
              command: 'npx',
              name: 'filesystem',
              transport: 'stdio',
            },
          ],
        },
      } as never);

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
      expect(runtime.mcpConfig).toEqual({
        servers: [
          {
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            command: 'npx',
            name: 'filesystem',
            transport: 'stdio',
          },
        ],
      });
    });

    it('threads the built-in subagent personas onto the runtime for a hosted provider', async () => {
      const { BUILT_IN_PERSONAS, toAiSdkStyleStream, convertAssistantUiMessages } = await import(
        '@brainstrike/agent'
      );
      const { streamResponse } = await import('../assistant-server/http');

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
      expect(runtime.personas).toEqual(BUILT_IN_PERSONAS);
    });

    it('routes provider "local" through the injected llm-host manager (warmup + proxy client)', async () => {
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
      const { streamResponse } = await import('../assistant-server/http');

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
      expect(runtime.localLlmHostClient).toBeDefined();
      expect(typeof (runtime.localLlmHostClient as { generate: unknown }).generate).toBe(
        'function'
      );
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
      const payload = JSON.parse(response.body) as { error: string };
      expect(payload.error).toBe('agent_stream_init_failed');
    });

    it('does not prepend selected-file context as a hidden system message', async () => {
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
      const { streamResponse } = await import('../assistant-server/http');

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

    it('initializes PGlite Mastra memory when memory runtime context is present', async () => {
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
      const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
      const { getDatabase } = await import('../db-main');
      const { streamResponse } = await import('../assistant-server/http');

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

      const { createProvider } = await import('@brainstrike/agent');

      // Once for workspace-roots enrichment, once for PGlite Mastra memory init.
      expect(getDatabase).toHaveBeenCalledTimes(2);
      expect(createProvider).toHaveBeenCalledWith(
        'anthropic',
        'test-api-key',
        'claude-haiku-4-5',
        expect.objectContaining({ apiKey: 'test-api-key', provider: 'openai' })
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
      expect(createProvider).toHaveBeenCalledWith(
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
      const { streamResponse } = await import('../assistant-server/http');

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
      const { streamResponse } = await import('../assistant-server/http');

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
          memory: mockPgliteMastraMemory,
          requireToolApproval: true,
          runtime: expect.objectContaining({
            apiKey: 'test-api-key',
            memory: expect.objectContaining({
              resourceId: 'workspace-a',
              threadId: 'thread-1',
            }),
            provider: 'openai',
          }),
          storage: mockPgliteMastraStorage,
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
      const { streamResponse } = await import('../assistant-server/http');

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
          memory: mockPgliteMastraMemory,
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
      expect(approveResumeOptions.runtime.planMode).toBeUndefined();
    });

    it('preserves planMode on a REJECT resume so the model can revise in plan mode', async () => {
      const { streamMastraToolResumeAction, convertAssistantUiMessages } = await import(
        '@brainstrike/agent'
      );
      const { streamResponse } = await import('../assistant-server/http');

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
      expect(rejectResumeOptions.runtime.planMode).toBe(true);
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

    it('GET /assistant/suspended-runs returns rediscovered approvals with recomputed risk + staleness', async () => {
      const { listSuspendedMastraRuns } = await import('@brainstrike/agent');
      // NAME-FORM CONTRACT: `listSuspendedMastraRuns` returns the ORIGINAL
      // dotted tool name (it maps Mastra's registered/sanitized id back via the
      // runtime toolNameMap + the static native map) — the SAME form
      // `buildNativeToolRiskMap()` is keyed by. The live proof is
      // packages/agent/src/__tests__/mastra-suspended-runs-discovery.integration.spec.ts;
      // this mock must mirror that contract, never a sanitized id.
      (listSuspendedMastraRuns as Mock).mockResolvedValueOnce({
        approvals: [
          {
            args: { command: 'echo hi' },
            runId: 'run-restart-1',
            suspendedAt: new Date().toISOString(),
            toolCallId: 'call-restart-1',
            toolName: 'brainstrike.executeCommand',
          },
        ],
      });

      const response = await runRequest({
        headers: { 'content-type': 'application/json' },
        method: 'GET',
        url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
      });

      expect(response.status).toBe(200);
      expect(listSuspendedMastraRuns).toHaveBeenCalledWith(
        { resourceId: 'workspace-a', threadId: 'thread-1' },
        expect.objectContaining({
          runtime: expect.objectContaining({ provider: 'ollama' }),
          storage: mockPgliteMastraStorage,
        })
      );
      const body = JSON.parse(response.body);
      expect(body).toEqual({
        approvals: [
          {
            args: { command: 'echo hi' },
            policyDecision: 'ask',
            riskCategory: 'execute',
            runId: 'run-restart-1',
            stale: false,
            suspendedAt: expect.any(String),
            toolCallId: 'call-restart-1',
            toolName: 'brainstrike.executeCommand',
          },
        ],
      });
    });

    it('GET /assistant/suspended-runs flags a run older than the staleness threshold', async () => {
      const { listSuspendedMastraRuns } = await import('@brainstrike/agent');
      (listSuspendedMastraRuns as Mock).mockResolvedValueOnce({
        approvals: [
          {
            runId: 'run-old-1',
            // Two days ago — beyond the 24h default BRAINSTRIKE_APPROVAL_STALE_MS.
            suspendedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
            toolCallId: 'call-old-1',
            toolName: 'brainstrike.writeWorkspaceFile',
          },
        ],
      });

      const response = await runRequest({
        method: 'GET',
        url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
      });

      expect(response.status).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.approvals[0]).toMatchObject({
        riskCategory: 'edit',
        stale: true,
        toolName: 'brainstrike.writeWorkspaceFile',
      });
    });

    it('GET /assistant/suspended-runs omits riskCategory for a tool absent from the risk map and warns LOUDLY', async () => {
      // An MCP (or no-longer-registered) tool has no entry in
      // buildNativeToolRiskMap(): the response must omit riskCategory /
      // policyDecision HONESTLY (the notice then renders no grant buttons) and
      // the degradation must be observable — never a silent metadata drop.
      const { listSuspendedMastraRuns } = await import('@brainstrike/agent');
      (listSuspendedMastraRuns as Mock).mockResolvedValueOnce({
        approvals: [
          {
            args: { query: 'hello' },
            runId: 'run-mcp-1',
            suspendedAt: new Date().toISOString(),
            toolCallId: 'call-mcp-1',
            toolName: 'someServer.someTool',
          },
        ],
      });
      const warnSpy = vi.spyOn(desktopAssistantServerLogger, 'warn').mockImplementation(() => {
        // Silence expected warning output.
      });

      try {
        const response = await runRequest({
          method: 'GET',
          url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
        });

        expect(response.status).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.approvals[0]).toMatchObject({ toolName: 'someServer.someTool' });
        expect(body.approvals[0]).not.toHaveProperty('riskCategory');
        expect(body.approvals[0]).not.toHaveProperty('policyDecision');
        expect(warnSpy).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            code: 'assistant_suspended_approval_risk_unresolved',
            toolName: 'someServer.someTool',
          })
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('GET /assistant/suspended-runs returns 400 when thread context is missing', async () => {
      const { listSuspendedMastraRuns } = await import('@brainstrike/agent');
      const response = await runRequest({
        method: 'GET',
        url: '/assistant/suspended-runs?resourceId=workspace-a',
      });

      expect(response.status).toBe(400);
      expect(JSON.parse(response.body).error).toBe('missing_thread_context');
      expect(listSuspendedMastraRuns).not.toHaveBeenCalled();
    });

    it('GET /assistant/suspended-runs returns 503 when workflow storage is unavailable', async () => {
      const { listSuspendedMastraRuns } = await import('@brainstrike/agent');
      const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
      (createPgliteMastraMemory as Mock).mockResolvedValueOnce({
        memory: mockPgliteMastraMemory,
        store: {},
        vector: {},
        workflows: {},
      });

      const response = await runRequest({
        method: 'GET',
        url: '/assistant/suspended-runs?threadId=thread-1&resourceId=workspace-a',
      });

      expect(response.status).toBe(503);
      expect(JSON.parse(response.body).error).toBe('tool_approval_storage_unavailable');
      expect(listSuspendedMastraRuns).not.toHaveBeenCalled();
    });

    it('retries desktop Mastra memory initialization after a transient failure', async () => {
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
      const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
      const { streamResponse } = await import('../assistant-server/http');
      const memoryContext = {
        memorySettings: {
          observationalMemory: {
            enabled: false,
            messageTokens: 12_000,
            modelTarget: 'openai/gpt-5.2',
            observationTokens: 24_000,
            retrievalMode: 'off',
            scope: 'thread',
          },
          semanticRecall: {
            embeddingModelTarget: 'openai/text-embedding-3-small',
            enabled: false,
            messageRange: 1,
            scope: 'resource',
            topK: 3,
          },
        },
        resourceId: 'workspace-retry',
        threadId: 'thread-retry',
      };

      (convertAssistantUiMessages as Mock).mockReturnValue([
        { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
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
          yield { content: 'Response', type: 'text' };
        },
      });
      (streamResponse as Mock).mockImplementation(async (res: unknown) => {
        const response = res as { end?: () => void };
        response.end?.();
      });

      const failedResponse = await runRequest({
        body: JSON.stringify({
          data: { memory: memoryContext, provider: 'openai' },
          messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/',
      });
      const retriedResponse = await runRequest({
        body: JSON.stringify({
          data: { memory: memoryContext, provider: 'openai' },
          messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/',
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
          messageTokens: 10_000,
          modelTarget: 'openai/gpt-5.2',
          observationTokens: 20_000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: 'openai/text-embedding-3-small',
          enabled: false,
          messageRange: 1,
          scope: 'resource',
          topK: 3,
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
          messageTokens: 10_000,
          modelTarget: 'openai/gpt-5.2',
          observationTokens: 20_000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: 'openai/text-embedding-3-small',
          enabled: false,
          messageRange: 1,
          scope: 'resource',
          topK: 3,
        },
      };
      const memorySettingsB = {
        observationalMemory: {
          enabled: true,
          messageTokens: 10_000,
          modelTarget: 'openai/gpt-5.2',
          observationTokens: 20_000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: 'openai/text-embedding-3-small',
          enabled: false,
          messageRange: 1,
          scope: 'resource',
          topK: 3,
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
            messageTokens: 10_000 + index,
            modelTarget: 'openai/gpt-5.2',
            observationTokens: 20_000,
            retrievalMode: 'off',
            scope: 'thread',
          },
          semanticRecall: {
            embeddingModelTarget: 'openai/text-embedding-3-small',
            enabled: false,
            messageRange: 1,
            scope: 'resource',
            topK: 3,
          },
        });
      }

      await getDesktopMastraMemoryForTests({
        observationalMemory: {
          enabled: true,
          messageTokens: 10_000,
          modelTarget: 'openai/gpt-5.2',
          observationTokens: 20_000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: 'openai/text-embedding-3-small',
          enabled: false,
          messageRange: 1,
          scope: 'resource',
          topK: 3,
        },
      });

      expect(createPgliteMastraMemory).toHaveBeenCalledTimes(18);
    });

    it('marks assistant thread runs completed after desktop streams finish', async () => {
      const { assistantDataStreamSessions, toAiSdkStyleStream, convertAssistantUiMessages } =
        await import('@brainstrike/agent');
      const { streamResponse } = await import('../assistant-server/http');

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
            memory: {
              resourceId: 'workspace-a',
              runId: 'run-1',
              threadId: 'thread-1',
            },
            provider: 'openai',
          },
          messages: [
            {
              id: 'user-client-id',
              parts: [{ text: 'Hello', type: 'text' }],
              role: 'user',
            },
          ],
          unstable_assistantMessageId: 'assistant-client-id',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        url: '/',
      });

      expect(mockDesktopDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE brainstrike_assistant_thread_runs'),
        expect.arrayContaining(['run-1', 'completed', null])
      );
      expect(toAiSdkStyleStream).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ assistantMessageId: 'assistant-client-id' }),
        expect.any(Object)
      );
      expect(convertAssistantUiMessages).toHaveBeenCalledWith([
        {
          id: 'user-client-id',
          parts: [{ text: 'Hello', type: 'text' }],
          role: 'user',
        },
      ]);
      expect(assistantDataStreamSessions.create).toHaveBeenCalledWith(expect.any(Object), {
        messageId: 'assistant-client-id',
      });
    });

    it('persists run-event chunks while desktop streams are consumed', async () => {
      const { assistantDataStreamSessions, toAiSdkStyleStream, convertAssistantUiMessages } =
        await import('@brainstrike/agent');
      const { streamResponse } = await import('../assistant-server/http');
      let capturedStream: AsyncIterable<unknown> | null = null;

      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
      ]);
      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield {
            event: {
              id: 'event-1',
              kind: 'run.started',
              label: 'Assistant run started',
              sequence: 5,
              status: 'running',
              timestamp: '2026-04-24T10:00:00.000Z',
            },
            type: 'run-event',
          };
          yield {
            event: {
              id: 'event-2',
              kind: 'run.step.started',
              label: 'Step started',
              status: 'running',
              timestamp: '2026-04-24T10:00:01.000Z',
            },
            type: 'run-event',
          };
          yield {
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
            type: 'run-event',
          };
          yield { type: 'text-delta', value: 'Response' };
        },
      });
      (assistantDataStreamSessions.create as Mock).mockImplementationOnce(
        (stream: AsyncIterable<unknown>) => {
          capturedStream = stream;
          return {
            createResponse: vi.fn(() => ({
              body: null,
              headers: new Headers(),
              status: 200,
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
        body: JSON.stringify({
          data: {
            memory: {
              resourceId: 'workspace-a',
              runId: 'run-1',
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
        { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
      ]);
      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield {
            event: {
              id: 'event-nonblocking',
              kind: 'run.started',
              label: 'Assistant run started',
              status: 'running',
              timestamp: '2026-04-24T10:00:00.000Z',
            },
            type: 'run-event',
          };
        },
      });
      (assistantDataStreamSessions.create as Mock).mockImplementationOnce(
        (stream: AsyncIterable<unknown>) => {
          capturedStream = stream;
          return {
            createResponse: vi.fn(() => ({
              body: null,
              headers: new Headers(),
              status: 200,
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
        body: JSON.stringify({
          data: {
            memory: {
              resourceId: 'workspace-a',
              runId: 'run-1',
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
        { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
      ]);
      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield {
            event: {
              id: 'event-failure-1',
              kind: 'run.started',
              label: 'Assistant run started',
              status: 'running',
              timestamp: '2026-04-24T10:00:00.000Z',
            },
            type: 'run-event',
          };
          yield {
            event: {
              id: 'event-failure-2',
              kind: 'run.step.started',
              label: 'Step started',
              status: 'running',
              timestamp: '2026-04-24T10:00:01.000Z',
            },
            type: 'run-event',
          };
        },
      });
      (assistantDataStreamSessions.create as Mock).mockImplementationOnce(
        (stream: AsyncIterable<unknown>) => {
          capturedStream = stream;
          return {
            createResponse: vi.fn(() => ({
              body: null,
              headers: new Headers(),
              status: 200,
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
        body: JSON.stringify({
          data: {
            memory: {
              resourceId: 'workspace-a',
              runId: 'run-persistence-failed',
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
        { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
      ]);
      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield {
            event: {
              id: 'event-before-source-error',
              kind: 'run.started',
              label: 'Assistant run started',
              status: 'running',
              timestamp: '2026-04-24T10:00:00.000Z',
            },
            type: 'run-event',
          };
          throw new Error('agent stream failed');
        },
      });
      (assistantDataStreamSessions.create as Mock).mockImplementationOnce(
        (stream: AsyncIterable<unknown>) => {
          capturedStream = stream;
          return {
            createResponse: vi.fn(() => ({
              body: null,
              headers: new Headers(),
              status: 200,
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
        body: JSON.stringify({
          data: {
            memory: {
              resourceId: 'workspace-a',
              runId: 'run-source-error',
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
        { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
      ]);
      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield { content: 'Response', type: 'text' };
        },
      });
      (streamResponse as Mock).mockRejectedValueOnce(new Error('stream pipeline failed'));

      const response = await runRequest({
        body: JSON.stringify({
          data: {
            memory: {
              resourceId: 'workspace-a',
              runId: 'run-failed',
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
        { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
      ]);
      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield { content: 'Response', type: 'text' };
        },
      });
      (streamResponse as Mock).mockRejectedValueOnce(new Error('stream pipeline failed'));
      // Roots enrichment queries first and must succeed; only the run-status
      // write should fail (SQL-aware so the rejection targets the right query).
      mockDesktopDatabase.query.mockImplementation((sql: unknown) =>
        typeof sql === 'string' && sql.includes('FROM roots')
          ? Promise.resolve({ rows: [] })
          : Promise.reject(new Error('run status write failed'))
      );

      const response = await runRequest({
        body: JSON.stringify({
          data: {
            memory: {
              resourceId: 'workspace-a',
              runId: 'run-failed-status-write',
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
      const data = JSON.parse(response.body) as { error: string; message: string };
      expect(data).toEqual({
        error: 'agent_stream_init_failed',
        message: 'Assistant stream initialization failed.',
      });
      expect(response.body).not.toContain('Stream initialization failed');
    }, 10_000);
  });

  // Two deferred P2 findings from the tool-lifecycle hooks PR (#1556).
  describe('run-event persistence tap transience', () => {
    it('passes a context-breakdown chunk through UNPERSISTED (transient, shell-output precedent)', async () => {
      const runId = 'run-breakdown-transience';
      const breakdownChunk = {
        breakdown: {
          attachmentsCount: 0,
          historyMessagesTokens: 9,
          provenance: 'heuristic',
          systemInstructionsTokens: 1234,
        },
        type: 'context-breakdown',
      } as unknown as StreamChunk;

      async function* source(): AsyncIterable<StreamChunk> {
        yield breakdownChunk;
        yield {
          event: {
            id: 'ev-1',
            kind: 'run.finished',
            label: 'Assistant run finished',
            status: 'completed',
            timestamp: '2026-07-18T00:00:00.000Z',
          },
          type: 'run-event',
        } as unknown as StreamChunk;
      }

      const seen: StreamChunk[] = [];
      for await (const chunk of observeDesktopAssistantRunEvents(source(), runId, [])) {
        seen.push(chunk);
      }

      // Pass-through: the breakdown chunk reaches the mapper untouched.
      expect(seen[0]).toBe(breakdownChunk);
      // Never persisted: no INSERT parameter carries the breakdown figures,
      // while the run-event on the same stream WAS persisted.
      const persistedValues = mockDesktopDatabase.query.mock.calls
        .map((call) => call[1])
        .filter((params): params is unknown[] => Array.isArray(params))
        .flat();
      expect(persistedValues).not.toContain(1234);
      expect(persistedValues).toContain('run.finished');
    });
  });

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
          observe: (src) => observeDesktopAssistantRunEvents(src, runId, queuedRunEvents),
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
        const { streamResponse } = await import('../assistant-server/http');
        (streamResponse as Mock).mockImplementationOnce(async (res: unknown) => {
          (res as { end?: () => void }).end?.();
        });

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
});
