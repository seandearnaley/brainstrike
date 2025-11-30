declare module '@brainstrike/agent' {
  export type AgentMessagePartText = {
    type: 'text';
    text: string;
  };
  export type AgentMessagePartTool = {
    type: `tool-${string}`;
    state: 'input-available' | 'input-streaming' | 'output-available' | 'output-error';
    input?: unknown;
    output?: unknown;
    errorText?: string;
  };
  export type AgentMessagePart = AgentMessagePartText | AgentMessagePartTool;

  export type AgentMessage = {
    id: string;
    role: 'user' | 'assistant' | 'system';
    parts: AgentMessagePart[];
  };

  export type RuntimeData = {
    projectId?: string;
    provider?: string;
    model?: string;
    mcpEnabled?: boolean;
    mcpConfig?: unknown;
    mastraTools?: unknown;
  };

  export type StreamChunkText = {
    type: 'text-delta';
    value: string;
  };
  export type StreamChunkTool = {
    type: 'tool-event';
    name: string;
    status: 'start' | 'progress' | 'success' | 'error';
    payload?: unknown;
  };
  export type StreamChunkFinish = {
    type: 'finish';
    usage: { promptTokens: number; completionTokens: number };
  };
  export type StreamChunkMessageFinish = {
    type: 'message-finish';
    finishReason: 'stop';
    usage: { promptTokens: number; completionTokens: number };
    path: readonly number[];
  };
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
