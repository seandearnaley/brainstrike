declare module '@brainstrike/agent' {
  export interface AgentMessagePartText {
    text: string;
    type: 'text';
  }
  export interface AgentMessagePartTool {
    errorText?: string;
    input?: unknown;
    output?: unknown;
    state: 'input-available' | 'input-streaming' | 'output-available' | 'output-error';
    type: `tool-${string}`;
  }
  export type AgentMessagePart = AgentMessagePartText | AgentMessagePartTool;

  export interface AgentMessage {
    id: string;
    parts: AgentMessagePart[];
    role: 'user' | 'assistant' | 'system';
  }

  export interface RuntimeData {
    mastraTools?: unknown;
    mcpConfig?: unknown;
    mcpEnabled?: boolean;
    model?: string;
    projectId?: string;
    provider?: string;
  }

  export interface StreamChunkText {
    type: 'text-delta';
    value: string;
  }
  export interface StreamChunkTool {
    name: string;
    payload?: unknown;
    status: 'start' | 'progress' | 'success' | 'error';
    type: 'tool-event';
  }
  export interface StreamChunkFinish {
    type: 'finish';
    usage: { promptTokens: number; completionTokens: number };
  }
  export interface StreamChunkMessageFinish {
    finishReason: 'stop';
    path: readonly number[];
    type: 'message-finish';
    usage: { promptTokens: number; completionTokens: number };
  }
  export type StreamChunk =
    | StreamChunkText
    | StreamChunkTool
    | StreamChunkFinish
    | StreamChunkMessageFinish;

  export function streamMastraAgent(
    messages: AgentMessage[],
    options?: unknown
  ): Promise<AsyncIterable<StreamChunk>>;
}
