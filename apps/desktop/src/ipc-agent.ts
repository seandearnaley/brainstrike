import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import type { McpConfig } from './mcp-loader';
import { loadMcpConfig } from './mcp-loader';

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
      // Dynamic import via eval to avoid bundler/TS resolution issues in tests/build
      // eslint-disable-next-line no-eval
      // biome-ignore lint/security/noGlobalEval: Required for dynamic imports in Electron main process
      const mod = (await eval(
        "import('@brainstrike/agent')"
      )) as typeof import('@brainstrike/agent');
      const out: StreamChunk[] = [];

      const config = await loadMcpConfig();
      const maybeIter = mod.streamMastraAgent(messages, {
        runtime: {
          ...(runtime ?? {}),
          mcpConfig: config.config,
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
