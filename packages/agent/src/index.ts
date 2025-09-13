import { streamPlanThenAct } from './workflows/plan-then-act';

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

export type StreamIterator = AsyncIterable<StreamChunk>;

// Minimal placeholder agent: echoes user text in a streamed fashion.
export async function* streamEcho(messages: AgentMessage[]): StreamIterator {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const text = last?.parts.find((p) => p.type === 'text') as AgentMessagePartText | undefined;
  const content = text?.text ?? '';
  yield { type: 'tool-event', name: 'plan', status: 'start' } satisfies StreamChunkTool;
  for (const token of content.split(/(\s+)/)) {
    if (token.length === 0) continue;
    yield { type: 'text-delta', value: token } satisfies StreamChunkText;
    await new Promise((r) => setTimeout(r, 5));
  }
  yield {
    type: 'tool-event',
    name: 'plan',
    status: 'success',
    payload: { tokens: content.length },
  } satisfies StreamChunkTool;
}

// Memory store for early development
export { InMemoryMemoryStore } from './memory/in-memory';
// Plan-then-act workflow
export { streamPlanThenAct } from './workflows/plan-then-act';

export interface ChatAgent {
  id: string;
  instructions: string;
  stream: (
    messages: AgentMessage[],
    runtime?: RuntimeData
  ) => StreamIterator | Promise<StreamIterator>;
}

export function createDevChatAgent(): ChatAgent {
  return {
    id: 'chat',
    instructions: 'You are a helpful, step-by-step assistant.',
    stream: (messages, runtime) => streamPlanThenAct(messages, runtime),
  };
}

// Adapter to Vercel AI SDK v5 style data stream if needed by routes
export async function toAiSdkStyleStream(
  messages: AgentMessage[],
  runtime?: RuntimeData
): Promise<StreamIterator> {
  // For now, use the plan-then-act workflow to demonstrate multi-step output.
  return streamPlanThenAct(messages, runtime);
}
