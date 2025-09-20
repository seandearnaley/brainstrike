import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import type { McpConfig } from './mcp-loader';
import { loadMcpConfig } from './mcp-loader';
import { readOpenAIApiKey } from './openai-api-key';

// Minimal local types to avoid cross-project TS coupling during type-check
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
  mcpConfig?: McpConfig;
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

export function registerAgentIpcHandlers() {
  ipcMain.handle(
    'agent:chat',
    async (
      _e: IpcMainInvokeEvent,
      messages: AgentMessage[],
      runtime?: RuntimeData
    ): Promise<StreamChunk[]> => {
      // Safe load for CommonJS main process with test hook override
      const injected = (
        globalThis as {
          __agentModule?: typeof import('@brainstrike/agent');
        }
      ).__agentModule;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = (injected ??
        require('@brainstrike/agent')) as typeof import('@brainstrike/agent');
      const out: StreamChunk[] = [];

      const config = await loadMcpConfig();
      const apiKey = await readOpenAIApiKey();
      const maybeIter = mod.streamMastraAgent(messages, {
        runtime: {
          ...(runtime ?? {}),
          mcpConfig: config.config,
          ...(apiKey ? { apiKey } : {}),
        },
        tools: mod.webTools,
      });
      const asyncIter: AsyncIterable<StreamChunk> =
        maybeIter && typeof maybeIter[Symbol.asyncIterator] === 'function'
          ? maybeIter
          : await maybeIter;
      for await (const chunk of asyncIter) {
        out.push(chunk);
      }
      return out;
    }
  );
}
