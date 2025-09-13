import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';

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
      // Dynamic import to keep TS type-check decoupled from workspace resolution
      const mod = await import('@brainstrike/agent');
      const out: StreamChunk[] = [];
      const maybeIter = mod.streamPlanThenAct(messages, runtime);
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
