import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentMessage, RuntimeData, StreamChunk } from '@brainstrike/agent';
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

vi.mock('../provider-api-key', () => ({
  readProviderSecretKey: vi.fn(),
  resolveProviderEnvKey: vi.fn(),
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

describe('registerAgentIpcHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const g = globalThis as { __agentModule?: typeof import('@brainstrike/agent') };
    g.__agentModule = undefined;
    mockSecretsService.getKey.mockResolvedValue('test-api-key');
    mockSecretsService.listProviders.mockResolvedValue(['openai']);
  });

  describe('handler registration', () => {
    it('registers through the typed desktop IPC registry', () => {
      const source = readFileSync(path.resolve(process.cwd(), 'src/ipc-agent.ts'), 'utf8');

      expect(source).toContain('createDesktopIpcRegistry');
      expect(source).not.toMatch(/ipcMain\.(handle|on)\(/);
      expect(source).not.toMatch(/ipcMain\.remove(Handler|Listener)\(/);
    });

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
        { type: 'finish', usage: { completionTokens: 5, promptTokens: 10 } },
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
          parts: [{ text: 'Hello', type: 'text' as const }],
          role: 'user' as const,
        },
      ];

      const runtime = {
        mcpEnabled: true,
        model: 'gpt-5.2',
        projectId: 'test-project',
        provider: 'openai',
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
      } as unknown as typeof import('@brainstrike/agent');

      const { loadMcpConfig } = await import('../mcp-loader');
      const { readOpenAIApiKey } = await import('../openai-api-key');

      vi.mocked(loadMcpConfig).mockResolvedValue({ config: {} } as never);
      vi.mocked(readOpenAIApiKey).mockResolvedValue('fallback-key');

      const messages = [
        {
          id: '1',
          parts: [{ text: 'Test', type: 'text' as const }],
          role: 'user' as const,
        },
      ];

      const result = await chatHandler({} as IpcMainInvokeEvent, messages, {
        provider: 'openai',
      });

      expect(result).toEqual(mockStreamChunks);
    });

    it('should handle tool events in the stream', async () => {
      const mockStreamChunks = [
        { name: 'search', payload: {}, status: 'start', type: 'tool-event' },
        { name: 'search', payload: { progress: 50 }, status: 'progress', type: 'tool-event' },
        { name: 'search', payload: { results: [] }, status: 'success', type: 'tool-event' },
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
      } as unknown as typeof import('@brainstrike/agent');

      const { loadMcpConfig } = await import('../mcp-loader');
      const { readOpenAIApiKey } = await import('../openai-api-key');

      vi.mocked(loadMcpConfig).mockResolvedValue({ config: {} } as never);
      vi.mocked(readOpenAIApiKey).mockResolvedValue('key');

      const messages = [
        {
          id: '1',
          parts: [{ text: 'Using tool', type: 'text' as const }],
          role: 'assistant' as const,
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
          finishReason: 'stop' as const,
          path: [0, 1, 2],
          type: 'message-finish',
          usage: { completionTokens: 10, promptTokens: 20 },
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
      } as unknown as typeof import('@brainstrike/agent');

      const { loadMcpConfig } = await import('../mcp-loader');
      const { readOpenAIApiKey } = await import('../openai-api-key');

      vi.mocked(loadMcpConfig).mockResolvedValue({ config: {} } as never);
      vi.mocked(readOpenAIApiKey).mockResolvedValue('fallback-key');

      const messages = [
        {
          id: '1',
          parts: [{ text: 'Query', type: 'text' as const }],
          role: 'user' as const,
        },
      ];

      const result = await chatHandler({} as IpcMainInvokeEvent, messages, {
        provider: 'openai',
      });

      expect(result).toEqual(mockStreamChunks);
    });

    it('passes pending tool approval chunks through the IPC bridge', async () => {
      const mockStreamChunks: StreamChunk[] = [
        {
          args: { mode: 'replace', paths: ['src/index.ts'] },
          resumeSchema: '{}',
          runId: 'run-approval-1',
          toolCallId: 'approval-1',
          toolName: 'brainstrike.updateWorkspaceContextSelection',
          type: 'tool-approval-required',
        },
        {
          finishReason: 'tool-calls',
          path: [],
          type: 'message-finish',
          usage: { completionTokens: 0, promptTokens: 0 },
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
      } as unknown as typeof import('@brainstrike/agent');

      const { loadMcpConfig } = await import('../mcp-loader');
      const { readOpenAIApiKey } = await import('../openai-api-key');

      vi.mocked(loadMcpConfig).mockResolvedValue({ config: {} } as never);
      vi.mocked(readOpenAIApiKey).mockResolvedValue('fallback-key');

      const messages: AgentMessage[] = [
        {
          id: '1',
          parts: [{ text: 'Update selected context', type: 'text' }],
          role: 'user',
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
      } as unknown as typeof import('@brainstrike/agent');

      const { loadMcpConfig } = await import('../mcp-loader');
      const { readOpenAIApiKey } = await import('../openai-api-key');
      const { readProviderSecretKey, resolveProviderEnvKey } = await import('../provider-api-key');

      const mcpConfig = { servers: { testServer: {} } };
      vi.mocked(loadMcpConfig).mockResolvedValue({ config: mcpConfig } as never);
      vi.mocked(readOpenAIApiKey).mockResolvedValue(undefined);
      vi.mocked(resolveProviderEnvKey).mockReturnValue(undefined);
      vi.mocked(readProviderSecretKey).mockResolvedValue('secret-key');

      const messages = [
        {
          id: '1',
          parts: [{ text: 'System prompt', type: 'text' as const }],
          role: 'system' as const,
        },
      ];

      const runtime = {
        mcpEnabled: false,
        model: 'claude-sonnet-4-6',
        projectId: 'proj-123',
        provider: 'anthropic',
      };

      await chatHandler({} as IpcMainInvokeEvent, messages, runtime);

      expect(mockStreamMastraAgent).toHaveBeenCalledWith(messages, {
        runtime: {
          apiKey: 'secret-key',
          mcpConfig,
          mcpEnabled: false,
          model: 'claude-sonnet-4-6',
          projectId: 'proj-123',
          provider: 'anthropic',
        },
      });
    });

    it('passes filesystem MCP config through to the agent runtime', async () => {
      const mockStreamMastraAgent = vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          async next() {
            return { done: true, value: undefined };
          },
        }),
      });

      const g = globalThis as { __agentModule?: typeof import('@brainstrike/agent') };
      g.__agentModule = {
        streamMastraAgent: mockStreamMastraAgent,
      } as unknown as typeof import('@brainstrike/agent');

      const { loadMcpConfig } = await import('../mcp-loader');
      const { readOpenAIApiKey } = await import('../openai-api-key');
      const rawConfig = {
        servers: [{ args: ['/tmp'], command: 'npx', name: 'filesystem', transport: 'stdio' }],
      };
      vi.mocked(loadMcpConfig).mockResolvedValue({ config: rawConfig } as never);
      vi.mocked(readOpenAIApiKey).mockResolvedValue('fallback-key');

      const messages = [
        {
          id: '1',
          parts: [{ text: 'Hello', type: 'text' as const }],
          role: 'user' as const,
        },
      ];

      await chatHandler({} as IpcMainInvokeEvent, messages, { provider: 'openai' });

      expect(mockStreamMastraAgent).toHaveBeenCalledWith(
        messages,
        expect.objectContaining({
          runtime: expect.objectContaining({ mcpConfig: rawConfig }),
        })
      );
    });

    it('ignores runtime-supplied MCP config and uses the loaded desktop config', async () => {
      const mockStreamMastraAgent = vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          async next() {
            return { done: true, value: undefined };
          },
        }),
      });

      const g = globalThis as { __agentModule?: typeof import('@brainstrike/agent') };
      g.__agentModule = {
        streamMastraAgent: mockStreamMastraAgent,
      } as unknown as typeof import('@brainstrike/agent');

      const { loadMcpConfig } = await import('../mcp-loader');
      const { readOpenAIApiKey } = await import('../openai-api-key');
      const rawConfig = {
        servers: [{ args: ['/tmp'], command: 'npx', name: 'filesystem', transport: 'stdio' }],
      };
      vi.mocked(loadMcpConfig).mockResolvedValue({ config: rawConfig } as never);
      vi.mocked(readOpenAIApiKey).mockResolvedValue('fallback-key');

      const messages = [
        {
          id: '1',
          parts: [{ text: 'Hello', type: 'text' as const }],
          role: 'user' as const,
        },
      ];

      await chatHandler({} as IpcMainInvokeEvent, messages, {
        mcpConfig: rawConfig as never,
        provider: 'openai',
      });

      expect(mockStreamMastraAgent).toHaveBeenCalledTimes(1);
      const [, options] = mockStreamMastraAgent.mock.calls[0] as [
        unknown,
        { runtime: Record<string, unknown> },
      ];
      expect(options.runtime.provider).toBe('openai');
      expect(options.runtime.mcpConfig).toEqual(rawConfig);
    });

    it('throws when provider is missing or unsupported', async () => {
      const { readOpenAIApiKey } = await import('../openai-api-key');
      vi.mocked(readOpenAIApiKey).mockResolvedValue('fallback');

      const messages = [
        {
          id: '1',
          parts: [{ text: 'Hello', type: 'text' as const }],
          role: 'user' as const,
        },
      ];

      await expect(chatHandler({} as IpcMainInvokeEvent, messages, {})).rejects.toThrow(
        'missing_provider'
      );

      await expect(
        chatHandler({} as IpcMainInvokeEvent, messages, { provider: 'invalid' })
      ).rejects.toThrow('missing_provider');
    });

    it('throws when API key resolution fails', async () => {
      const { readOpenAIApiKey } = await import('../openai-api-key');
      const { resolveProviderEnvKey, readProviderSecretKey } = await import('../provider-api-key');

      vi.mocked(readOpenAIApiKey).mockResolvedValue(undefined);
      vi.mocked(resolveProviderEnvKey).mockReturnValue(undefined);
      vi.mocked(readProviderSecretKey).mockResolvedValue(undefined);

      const messages = [
        {
          id: '1',
          parts: [{ text: 'Hello', type: 'text' as const }],
          role: 'user' as const,
        },
      ];

      await expect(
        chatHandler({} as IpcMainInvokeEvent, messages, { provider: 'openai' })
      ).rejects.toThrow('missing_api_key:openai');
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
