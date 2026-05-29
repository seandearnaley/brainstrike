import type { MastraAgentRuntimeOptions } from './mastra/agent-runtime';
import { streamMastraAgent } from './mastra/agent-runtime';
import { createRandomId } from './stream/data-stream';
import type {
  AgentMessage,
  AgentMessagePartText,
  AssistantUiMessage,
  AssistantUiMessageStrict,
  AssistantUiNode,
  AssistantUiNodeObject,
  AssistantUiScalar,
  RuntimeData,
  StreamIterator,
} from './types';

type NormalizedRole = 'user' | 'assistant' | 'system';

function normalizeRole(
  role: AssistantUiMessage['role'],
  fallback?: NormalizedRole
): NormalizedRole | undefined {
  if (typeof role === 'string') {
    const lower = role.toLowerCase();
    if (lower === 'user' || lower === 'assistant' || lower === 'system') {
      return lower;
    }
  }
  return fallback;
}

function ensureMessageId(value: AssistantUiMessage['id'] | AssistantUiMessageStrict['id']): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return createRandomId('msg');
}

function extractTextSegments(source: AssistantUiMessage | AssistantUiMessageStrict): string[] {
  const segments: string[] = [];
  const seenValues = new Set<string>();
  const seenObjects = new Set<AssistantUiNodeObject>();

  const pushText = (raw: string): void => {
    const text = raw.trim();
    if (text.length === 0 || seenValues.has(text)) {
      return;
    }
    seenValues.add(text);
    segments.push(text);
  };

  const knownObjectKeys: ReadonlySet<string> = new Set([
    'text',
    'type',
    'value',
    'content',
    'parts',
    'children',
    'values',
    'result',
    'message',
    'messages',
  ]);

  const pushScalar = (value: AssistantUiScalar | undefined): void => {
    if (value === null || value === undefined) {
      return;
    }
    if (typeof value === 'string') {
      pushText(value);
      return;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      pushText(String(value));
      return;
    }
    if (typeof value === 'boolean') {
      pushText(value ? 'true' : 'false');
    }
  };

  const isScalarValue = (value: AssistantUiNode | undefined): value is AssistantUiScalar =>
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean';

  const visitArray = (nodes: readonly AssistantUiNode[]): void => {
    for (const item of nodes) {
      visit(item);
    }
  };

  const visitObject = (record: AssistantUiNodeObject): void => {
    if (seenObjects.has(record)) {
      return;
    }
    seenObjects.add(record);

    pushScalar(record.text);
    pushScalar(record.value);

    visit(record.content);
    visit(record.parts);
    visit(record.children);
    visit(record.values);
    visit(record.result);
    visit(record.message);
    visit(record.messages);

    for (const [key, nested] of Object.entries(record)) {
      if (knownObjectKeys.has(key)) {
        continue;
      }
      if (isScalarValue(nested as AssistantUiNode | undefined)) {
        pushScalar(nested as AssistantUiScalar | undefined);
      } else {
        visit(nested as AssistantUiNode);
      }
    }
  };

  const visit = (value: AssistantUiNode | undefined): void => {
    if (value === null || value === undefined) {
      return;
    }
    if (isScalarValue(value)) {
      pushScalar(value);
      return;
    }
    if (Array.isArray(value)) {
      visitArray(value);
      return;
    }
    visitObject(value as AssistantUiNodeObject);
  };

  // source.text may be string in strict or scalar in permissive shape
  pushScalar(source.text as AssistantUiScalar | undefined);
  const maybeContent = (source as { content?: AssistantUiNode }).content;
  const maybeParts = (source as { parts?: AssistantUiNode }).parts;
  visit(maybeContent);
  visit(maybeParts);

  return segments;
}

function toAgentMessage(
  message: AssistantUiMessage | AssistantUiMessageStrict | null | undefined,
  fallbackRole?: NormalizedRole
): AgentMessage | null {
  if (!message) {
    return null;
  }
  const segments = extractTextSegments(message);
  if (segments.length === 0) {
    return null;
  }
  const role = normalizeRole(message.role, fallbackRole);
  if (!role) {
    return null;
  }
  return {
    id: ensureMessageId(message.id),
    role,
    parts: segments.map((text) => ({ type: 'text', text }) satisfies AgentMessagePartText),
  } satisfies AgentMessage;
}

export function convertAssistantUiMessages(
  messages:
    | ReadonlyArray<AssistantUiMessage | null | undefined>
    | ReadonlyArray<AssistantUiMessageStrict | null | undefined>
): AgentMessage[];
export function convertAssistantUiMessages(
  messages: ReadonlyArray<AssistantUiMessage | AssistantUiMessageStrict | null | undefined>
): AgentMessage[] {
  const converted: AgentMessage[] = [];
  for (const message of messages) {
    const agentMessage = toAgentMessage(message);
    if (agentMessage) {
      converted.push(agentMessage);
    }
  }
  if (converted.length > 0) {
    return converted;
  }
  const last = messages.length > 0 ? messages.at(-1) : undefined;
  const fallback = toAgentMessage(last ?? null, 'user');
  return fallback ? [fallback] : [];
}

// Adapter to Vercel AI SDK v5 style data stream if needed by routes
export async function toAiSdkStyleStream(
  messages: AgentMessage[],
  runtime?: RuntimeData,
  optionsOverride: Pick<MastraAgentRuntimeOptions, 'memory'> = {}
): Promise<StreamIterator> {
  const options: MastraAgentRuntimeOptions = { ...optionsOverride };
  if (runtime) {
    options.runtime = runtime;
  }
  if (runtime?.model) {
    options.model = runtime.model;
  }
  if (runtime?.mcpConfig) {
    options.mcpConfig = runtime.mcpConfig;
  }
  if (runtime?.mastraTools) {
    options.tools = runtime.mastraTools;
  }

  const streamMessages = runtime?.memory ? selectCurrentTurnMessages(messages) : messages;
  return streamMastraAgent(streamMessages, options);
}

function selectCurrentTurnMessages(messages: AgentMessage[]): AgentMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      const systemMessages = messages
        .slice(0, index)
        .filter((message) => message.role === 'system');
      return [...systemMessages, ...messages.slice(index)];
    }
  }
  throw new Error('Mastra memory requires a current user message');
}
