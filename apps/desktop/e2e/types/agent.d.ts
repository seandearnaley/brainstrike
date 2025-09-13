declare module '@brainstrike/agent' {
  export interface AgentMessagePartText {
    type: 'text';
    text: string;
  }
  export interface AgentMessagePartTool {
    type: `tool-${string}`;
    state: 'input-available' | 'input-streaming' | 'output-available' | 'output-error';
    input?: unknown;
    output?: unknown;
    errorText?: string;
  }
  export type AgentMessagePart = AgentMessagePartText | AgentMessagePartTool;

  export interface AgentMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    parts: AgentMessagePart[];
  }

  export interface RuntimeData {
    projectId?: string;
    provider?: string;
    model?: string;
    mcpEnabled?: boolean;
  }

  export interface StreamChunkText {
    type: 'text-delta';
    value: string;
  }
  export interface StreamChunkTool {
    type: 'tool-event';
    name: string;
    status: 'start' | 'progress' | 'success' | 'error';
    payload?: unknown;
  }
  export type StreamChunk = StreamChunkText | StreamChunkTool;

  export function streamPlanThenAct(
    messages: AgentMessage[],
    runtime?: RuntimeData
  ): AsyncIterable<StreamChunk> | Promise<AsyncIterable<StreamChunk>>;
}
