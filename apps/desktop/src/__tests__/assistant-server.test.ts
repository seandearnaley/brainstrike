import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  desktopAssistantServerLogger,
  handleAssistantRequest,
  startAssistantServer,
} from '../assistant-server';

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
  toAiSdkStyleStream: vi.fn(async () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'text', content: 'test' };
    },
  })),
  webTools: [],
  isSupportedProvider: (provider: string) =>
    ['openai', 'anthropic', 'google', 'openrouter'].includes(provider),
}));

vi.mock('../assistant-server/retrieval-tool', () => ({
  buildAssistantTools: vi.fn((_runtime: unknown, base: unknown) => base),
}));

vi.mock('../assistant-server/assistant-tools', () => ({
  buildDesktopAssistantTools: vi.fn(() => ({})),
}));

describe('assistant-server', () => {
  let server: { url: string; stop: () => Promise<void> } | undefined;
  interface RequestInput {
    method: string;
    url: string;
    headers?: http.IncomingHttpHeaders;
    body?: string;
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

      if (originalEnv !== undefined) {
        process.env['BS_ASSISTANT_PORT'] = originalEnv;
      } else {
        process.env['BS_ASSISTANT_PORT'] = undefined;
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
        headers: { origin: 'http://localhost:8081' },
      });

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:8081');
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
        headers: { origin: 'http://localhost:8081' },
      });

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:8081');
    });

    it('should handle CORS preflight for assistant routes', async () => {
      const response = await runRequest({
        method: 'OPTIONS',
        url: '/assistant/status?source=test',
        headers: {
          origin: 'http://localhost:8081',
          'access-control-request-method': 'POST',
        },
      });

      expect(response.status).toBe(204);
      expect(response.body).toBe('');
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:8081');
      expect(response.headers['access-control-allow-headers']).toContain('Content-Type');
      expect(response.headers['access-control-allow-methods']).toContain('POST');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('should return 204 for OPTIONS on unknown routes', async () => {
      const response = await runRequest({
        method: 'OPTIONS',
        url: '/unknown?source=test',
        headers: {
          origin: 'http://localhost:8081',
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

      expect(response.status).toBe(204);
      expect(response.body).toBe('');
      expect(response.headers['access-control-allow-origin']).toBe('null');
    });

    it('should not treat non-preflight OPTIONS requests as CORS preflight', async () => {
      const response = await runRequest({
        method: 'OPTIONS',
        url: '/assistant/status',
        headers: { origin: 'http://localhost:8081' },
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

    it('should reject localhost origins over https', async () => {
      const response = await runRequest({
        method: 'GET',
        url: '/assistant/status',
        headers: { origin: 'https://localhost:8081' },
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
