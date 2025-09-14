import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import { callTool } from './mcp-clients';

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
  callTool?: (name: string, params?: Record<string, unknown>) => Promise<unknown>;
};
type StreamChunk =
  | { type: 'text-delta'; value: string }
  | {
      type: 'tool-event';
      name: string;
      status: 'start' | 'progress' | 'success' | 'error';
      payload?: unknown;
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

      // Provide a tool dispatcher to the agent workflow
      const rt: RuntimeData = {
        ...(runtime ?? {}),
        callTool: (
          name: string,
          params?: Record<string, unknown>,
          opts?: { onProgress?: (payload: unknown) => void }
        ) => callTool(name, params, opts),
      };

      const maybeIter = mod.streamPlanThenAct(messages, rt);
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
