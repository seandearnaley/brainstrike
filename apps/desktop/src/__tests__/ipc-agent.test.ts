import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAgentIpcHandlers } from '../ipc-agent';

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

// Mock dependencies
vi.mock('../mcp-loader', () => ({
  loadMcpConfig: vi.fn(),
}));

vi.mock('../openai-api-key', () => ({
  readOpenAIApiKey: vi.fn(),
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

describe('registerAgentIpcHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const g = globalThis as { __agentModule?: typeof import('@brainstrike/agent') };
    g.__agentModule = undefined;
    mockSecretsService.getKey.mockResolvedValue('test-api-key');
    mockSecretsService.listProviders.mockResolvedValue(['openai']);
  });

  describe('handler registration', () => {
    it('should register the agent:chat handler', () => {
      registerAgentIpcHandlers();
      expect(ipcMain.handle).toHaveBeenCalledWith('agent:chat', expect.any(Function));
    });

    it('should only register one handler', () => {
      registerAgentIpcHandlers();
      expect(ipcMain.handle).toHaveBeenCalledTimes(1);
    });
  });

  describe('agent:chat handler', () => {
    // Local minimal types mirroring ipc-agent.ts
    type AgentMessage = {
      id: string;
      role: 'user' | 'assistant' | 'system';
      parts: Array<{ type: 'text'; text: string }>;
    };
    type RuntimeData = {
      projectId?: string;
      provider?: string;
      model?: string;
      mcpEnabled?: boolean;
      mcpConfig?: unknown;
    };
    type StreamChunk =
      | { type: 'text-delta'; value: string }
      | {
          type: 'tool-event';
          name: string;
          status: 'start' | 'progress' | 'success' | 'error';
          payload?: unknown;
        }
      | {
          type: 'finish';
          usage: { promptTokens: number; completionTokens: number };
        }
      | {
          type: 'message-finish';
          finishReason: 'stop';
          usage: { promptTokens: number; completionTokens: number };
          path: ReadonlyArray<number>;
        };

    let chatHandler: (
      e: IpcMainInvokeEvent,
      messages: AgentMessage[],
      runtime?: RuntimeData
    ) => Promise<StreamChunk[]> = async () => {
      throw new Error('chatHandler not initialized');
    };

    beforeEach(() => {
      registerAgentIpcHandlers();
      // Coerce to a Vitest Mock without using `any`
      const handleMock = ipcMain.handle as unknown as vi.Mock;
      chatHandler = handleMock.mock.calls[0][1];
    });

    it('should handle chat messages and return stream chunks', async () => {
      const mockStreamChunks = [
        { type: 'text-delta', value: 'Hello' },
        { type: 'text-delta', value: ' world!' },
        { type: 'finish', usage: { promptTokens: 10, completionTokens: 5 } },
      ];

      // Mock agent module
      const mockAsyncIterator = {
        [Symbol.asyncIterator]: () => {
          let index = 0;
          return {
            async next() {
              if (index < mockStreamChunks.length) {
                return { done: false, value: mockStreamChunks[index++] };
              }
              return { done: true, value: undefined };
            },
          };
        },
      };
      const streamMastraAgent = vi.fn().mockReturnValue(mockAsyncIterator);
      const g = globalThis as { __agentModule?: typeof import('@brainstrike/agent') };
      g.__agentModule = {
        streamMastraAgent,
        webTools: { someTool: {} },
      } as unknown as typeof import('@brainstrike/agent');

      const { loadMcpConfig } = await import('../mcp-loader');
      const { readOpenAIApiKey } = await import('../openai-api-key');

      vi.mocked(loadMcpConfig).mockResolvedValue({
        config: { servers: {} },
      } as never);
      vi.mocked(readOpenAIApiKey).mockResolvedValue('test-api-key');

      const messages = [
        {
          id: '1',
          role: 'user' as const,
          parts: [{ type: 'text' as const, text: 'Hello' }],
        },
      ];

      const runtime = {
        projectId: 'test-project',
        provider: 'openai',
        model: 'gpt-4',
        mcpEnabled: true,
      };

      const result = await chatHandler({} as IpcMainInvokeEvent, messages, runtime);

      expect(result).toEqual(mockStreamChunks);
    });

    it('should handle async iterable that needs awaiting', async () => {
      const mockStreamChunks = [{ type: 'text-delta' as const, value: 'Test' }];

      const mockAsyncIterator = {
        [Symbol.asyncIterator]: () => {
          let index = 0;
          return {
            async next() {
              if (index < mockStreamChunks.length) {
                return { done: false, value: mockStreamChunks[index++] };
              }
              return { done: true, value: undefined };
            },
          };
        },
      };

      // Return a promise that resolves to an async iterable
      const streamMastraAgent = vi.fn().mockResolvedValue(mockAsyncIterator);
      const g = globalThis as { __agentModule?: typeof import('@brainstrike/agent') };
      g.__agentModule = {
        streamMastraAgent,
        webTools: {},
      } as unknown as typeof import('@brainstrike/agent');

      const { loadMcpConfig } = await import('../mcp-loader');
      const { readOpenAIApiKey } = await import('../openai-api-key');

      vi.mocked(loadMcpConfig).mockResolvedValue({ config: {} } as never);
      vi.mocked(readOpenAIApiKey).mockResolvedValue('fallback-key');

      const messages = [
        {
          id: '1',
          role: 'user' as const,
          parts: [{ type: 'text' as const, text: 'Test' }],
        },
      ];

      const result = await chatHandler({} as IpcMainInvokeEvent, messages, {
        provider: 'openai',
      });

      expect(result).toEqual(mockStreamChunks);
    });

    it('should handle tool events in the stream', async () => {
      const mockStreamChunks = [
        { type: 'tool-event', name: 'search', status: 'start', payload: {} },
        { type: 'tool-event', name: 'search', status: 'progress', payload: { progress: 50 } },
        { type: 'tool-event', name: 'search', status: 'success', payload: { results: [] } },
      ];

      const mockAsyncIterator = {
        [Symbol.asyncIterator]: () => {
          let index = 0;
          return {
            async next() {
              if (index < mockStreamChunks.length) {
                return { done: false, value: mockStreamChunks[index++] };
              }
              return { done: true, value: undefined };
            },
          };
        },
      };

      const streamMastraAgent = vi.fn().mockReturnValue(mockAsyncIterator);
      const g = globalThis as { __agentModule?: typeof import('@brainstrike/agent') };
      g.__agentModule = {
        streamMastraAgent,
        webTools: {},
      } as unknown as typeof import('@brainstrike/agent');

      const { loadMcpConfig } = await import('../mcp-loader');
      const { readOpenAIApiKey } = await import('../openai-api-key');

      vi.mocked(loadMcpConfig).mockResolvedValue({ config: {} } as never);
      vi.mocked(readOpenAIApiKey).mockResolvedValue('key');

      const messages = [
        {
          id: '1',
          role: 'assistant' as const,
          parts: [{ type: 'text' as const, text: 'Using tool' }],
        },
      ];

      const result = await chatHandler({} as IpcMainInvokeEvent, messages, {
        provider: 'openai',
      });

      expect(result).toEqual(mockStreamChunks);
    });

    it('should handle message-finish chunks', async () => {
      const mockStreamChunks = [
        { type: 'text-delta', value: 'Response' },
        {
          type: 'message-finish',
          finishReason: 'stop' as const,
          usage: { promptTokens: 20, completionTokens: 10 },
          path: [0, 1, 2],
        },
      ];

      const mockAsyncIterator = {
        [Symbol.asyncIterator]: () => {
          let index = 0;
          return {
            async next() {
              if (index < mockStreamChunks.length) {
                return { done: false, value: mockStreamChunks[index++] };
              }
              return { done: true, value: undefined };
            },
          };
        },
      };

      const streamMastraAgent = vi.fn().mockReturnValue(mockAsyncIterator);
      const g = globalThis as { __agentModule?: typeof import('@brainstrike/agent') };
      g.__agentModule = {
        streamMastraAgent,
        webTools: {},
      } as unknown as typeof import('@brainstrike/agent');

      const { loadMcpConfig } = await import('../mcp-loader');
      const { readOpenAIApiKey } = await import('../openai-api-key');

      vi.mocked(loadMcpConfig).mockResolvedValue({ config: {} } as never);
      vi.mocked(readOpenAIApiKey).mockResolvedValue(undefined);

      const messages = [
        {
          id: '1',
          role: 'user' as const,
          parts: [{ type: 'text' as const, text: 'Query' }],
        },
      ];

      const result = await chatHandler({} as IpcMainInvokeEvent, messages, {
        provider: 'openai',
      });

      expect(result).toEqual(mockStreamChunks);
    });

    it('should pass runtime data and API key to streamMastraAgent', async () => {
      const mockStreamMastraAgent = vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          async next() {
            return { done: true, value: undefined };
          },
        }),
      });

      const g1 = globalThis as { __agentModule?: typeof import('@brainstrike/agent') };
      g1.__agentModule = {
        streamMastraAgent: mockStreamMastraAgent,
        webTools: { tool1: {}, tool2: {} },
      } as unknown as typeof import('@brainstrike/agent');

      const { loadMcpConfig } = await import('../mcp-loader');
      const { readOpenAIApiKey } = await import('../openai-api-key');

      const mcpConfig = { servers: { testServer: {} } };
      vi.mocked(loadMcpConfig).mockResolvedValue({ config: mcpConfig } as never);
      vi.mocked(readOpenAIApiKey).mockResolvedValue(undefined);
      mockSecretsService.getKey.mockImplementation(async (provider) =>
        provider === 'anthropic' ? 'secret-key' : 'test-api-key'
      );

      const messages = [
        {
          id: '1',
          role: 'system' as const,
          parts: [{ type: 'text' as const, text: 'System prompt' }],
        },
      ];

      const runtime = {
        projectId: 'proj-123',
        provider: 'anthropic',
        model: 'claude-3',
        mcpEnabled: false,
      };

      await chatHandler({} as IpcMainInvokeEvent, messages, runtime);

      expect(mockStreamMastraAgent).toHaveBeenCalledWith(messages, {
        runtime: {
          projectId: 'proj-123',
          provider: 'anthropic',
          model: 'claude-3',
          mcpEnabled: false,
          mcpConfig,
          apiKey: 'secret-key',
        },
        tools: { tool1: {}, tool2: {} },
      });
    });

    it('should handle empty runtime data', async () => {
      const mockStreamMastraAgent = vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          async next() {
            return { done: true, value: undefined };
          },
        }),
      });

      const g2 = globalThis as { __agentModule?: typeof import('@brainstrike/agent') };
      g2.__agentModule = {
        streamMastraAgent: mockStreamMastraAgent,
        webTools: {},
      } as unknown as typeof import('@brainstrike/agent');

      const { loadMcpConfig } = await import('../mcp-loader');
      const { readOpenAIApiKey } = await import('../openai-api-key');

      const mcpConfig = { servers: {} };
      vi.mocked(loadMcpConfig).mockResolvedValue({ config: mcpConfig } as never);
      vi.mocked(readOpenAIApiKey).mockResolvedValue(null);

      const messages = [];

      await expect(chatHandler({} as IpcMainInvokeEvent, messages)).rejects.toThrow(
        'missing_provider'
      );
    });
  });
});
