import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { startAssistantServer } from '../assistant-server';

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
  resolveDataStreamSession: vi.fn(() => undefined),
  toAiSdkStyleStream: vi.fn(async () => ({
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'text', content: 'test' };
    },
  })),
  webTools: [],
  isSupportedProvider: (provider: string) =>
    ['openai', 'anthropic', 'google', 'openrouter'].includes(provider),
}));

describe('assistant-server', () => {
  let server: { url: string; stop: () => Promise<void> } | undefined;

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
  }, 15000);

  describe('startAssistantServer', () => {
    it('should start server on dynamic port by default', async () => {
      server = await startAssistantServer();

      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(server.stop).toBeInstanceOf(Function);
    });

    it('should start server on specified port hint', async () => {
      server = await startAssistantServer(0); // Use 0 for dynamic port

      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it('should respect BS_ASSISTANT_PORT environment variable', async () => {
      const originalEnv = process.env['BS_ASSISTANT_PORT'];
      process.env['BS_ASSISTANT_PORT'] = '0'; // Use 0 for dynamic port

      server = await startAssistantServer();

      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      if (originalEnv !== undefined) {
        process.env['BS_ASSISTANT_PORT'] = originalEnv;
      } else {
        process.env['BS_ASSISTANT_PORT'] = undefined;
      }
    });

    it('should allow stopping the server', async () => {
      server = await startAssistantServer();
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

      server = await startAssistantServer();
      const response = await fetch(`${server.url}/assistant/status`);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ enabled: true, providers: ['openai'] });
    }, 10000);

    it('should handle status route with missing API key', async () => {
      const { readOpenAIApiKey } = await import('../openai-api-key');
      (readOpenAIApiKey as Mock).mockResolvedValueOnce(undefined);
      mockSecretsService.listProviders.mockResolvedValueOnce([]);
      mockSecretsService.getKey.mockResolvedValueOnce(null);

      server = await startAssistantServer();
      const response = await fetch(`${server.url}/status`);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ enabled: false, reason: 'no_providers_configured', providers: [] });
    }, 10000);

    it('should handle status route errors', async () => {
      const { readOpenAIApiKey } = await import('../openai-api-key');
      (readOpenAIApiKey as Mock).mockRejectedValueOnce(new Error('API key read failed'));

      server = await startAssistantServer();
      const response = await fetch(`${server.url}/status`);

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe('assistant_status_failed');
      expect(data.message).toBe('API key read failed');
    }, 10000);

    it('should return 404 for unknown routes', async () => {
      server = await startAssistantServer();
      const response = await fetch(`${server.url}/unknown`);

      expect(response.status).toBe(404);
      const text = await response.text();
      expect(text).toBe('not found');
    }, 10000);

    it('should handle POST to assistant route with empty prompt', async () => {
      server = await startAssistantServer();
      const response = await fetch(`${server.url}/assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: '   ' }] }],
          data: { provider: 'openai' },
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('empty_prompt');
    }, 10000);

    it('should reject assistant route when provider is missing', async () => {
      server = await startAssistantServer();
      const response = await fetch(`${server.url}/assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('missing_provider');
    }, 10000);

    it('should handle POST to assistant route with valid message', async () => {
      const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
      const { streamResponse } = await import('../assistant-server/http');

      // Make sure convertAssistantUiMessages actually returns messages
      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);

      (toAiSdkStyleStream as Mock).mockResolvedValueOnce({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'text', content: 'Response' };
        },
      });

      // Ensure streamResponse resolves immediately
      (streamResponse as Mock).mockResolvedValueOnce(undefined);

      server = await startAssistantServer();
      const fetchPromise = fetch(`${server.url}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: { provider: 'openai' },
        }),
      });

      await vi.waitUntil(
        () =>
          consoleInfoSpy.mock.calls.some(
            ([message, payload]) =>
              message === '[assistant-server] request received' &&
              Boolean((payload as { hasApiKey?: boolean })?.hasApiKey)
          ),
        { timeout: 2000 }
      );

      expect(consoleInfoSpy).toHaveBeenCalledWith(
        '[assistant-server] request received',
        expect.objectContaining({ hasApiKey: true })
      );

      consoleInfoSpy.mockRestore();

      // Don't await the fetch as the response may not complete
      await Promise.race([fetchPromise, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }, 15000);

    it('should handle stream initialization failure', async () => {
      const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');

      // Make sure convertAssistantUiMessages returns messages with non-empty text
      (convertAssistantUiMessages as Mock).mockReturnValueOnce([
        { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ]);

      (toAiSdkStyleStream as Mock).mockRejectedValueOnce(new Error('Stream initialization failed'));

      server = await startAssistantServer();
      const response = await fetch(`${server.url}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
          data: { provider: 'openai' },
        }),
      });

      expect(response.status).toBe(502);
      const data = await response.json();
      expect(data.error).toBe('agent_stream_init_failed');
      expect(data.message).toBe('Stream initialization failed');
    }, 10000);
  });
});
