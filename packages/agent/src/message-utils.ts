import {
  ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES,
  ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE,
  AssistantAttachmentValidationError,
  dataUrlByteLength,
  validateImageAttachmentPart,
} from '@brainstrike/assistant-contract';
import { assertAssistantMessageGraphWithinLimits } from './assistant-message-boundary';
import type { MastraAgentRuntimeOptions } from './mastra/agent-runtime';
import { streamMastraAgent } from './mastra/agent-runtime';
import { createRandomId } from './stream/data-stream';
import type {
  AgentMessage,
  AgentMessagePartFile,
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

interface ExtractedMessageContent {
  fileParts: AgentMessagePartFile[];
  segments: string[];
}

function readWireFileAttachmentCandidate(
  record: AssistantUiNodeObject
): AgentMessagePartFile | null {
  if (record['type'] !== 'file') {
    return null;
  }

  const data = record['data'];
  const filename = record['filename'];
  const mediaType = record['mediaType'];
  if (
    typeof data !== 'string' ||
    typeof mediaType !== 'string' ||
    (filename !== undefined && typeof filename !== 'string')
  ) {
    throw new AssistantAttachmentValidationError(
      'invalid-file-part',
      'Assistant file parts require string data and mediaType fields plus an optional string filename.'
    );
  }

  const part: AgentMessagePartFile = {
    data,
    ...(filename === undefined ? {} : { filename }),
    mediaType,
    type: 'file',
  };
  validateImageAttachmentPart(part);
  return part;
}

function assertAttachmentCollectionWithinLimits(collected: AgentMessagePartFile[]): void {
  if (collected.length > ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE) {
    throw new AssistantAttachmentValidationError(
      'too-many-attachments',
      `Message carries ${collected.length} attachments; the limit is ${ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE} per message.`
    );
  }
  let combinedBytes = 0;
  for (const part of collected) {
    combinedBytes += dataUrlByteLength(part.data);
  }
  if (combinedBytes > ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES) {
    throw new AssistantAttachmentValidationError(
      'oversized-combined',
      `Combined attachments are ${combinedBytes} bytes; the limit is ${ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES} bytes per message.`
    );
  }
}

/**
 * Walk a message exactly once to extract text and attachments. Every object
 * whose discriminator is `type: "file"` is an attachment candidate: validate
 * it before returning from that branch so malformed data can never fall
 * through into scalar text extraction. The generic unknown-key traversal is
 * intentional compatibility behavior, so valid nested files are collected
 * everywhere text extraction can reach instead of being silently dropped.
 */
function extractMessageContent(
  source: AssistantUiMessage | AssistantUiMessageStrict
): ExtractedMessageContent {
  const fileParts: AgentMessagePartFile[] = [];
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
    if (typeof value === 'number') {
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

    const filePart = readWireFileAttachmentCandidate(record);
    if (filePart) {
      fileParts.push(filePart);
      return;
    }

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

  assertAttachmentCollectionWithinLimits(fileParts);
  return { fileParts, segments };
}

function toAgentMessage(
  message: AssistantUiMessage | AssistantUiMessageStrict | null | undefined,
  fallbackRole?: NormalizedRole
): AgentMessage | null {
  if (!message) {
    return null;
  }
  const role = normalizeRole(message.role, fallbackRole);
  const content = extractMessageContent(message);
  // Attachments are a USER-message concept (composer-sent images); file parts
  // on other roles are still validated but are not forwarded.
  const fileParts = role === 'user' ? content.fileParts : [];
  if (content.segments.length === 0 && fileParts.length === 0) {
    return null;
  }
  if (!role) {
    return null;
  }
  return {
    id: ensureMessageId(message.id),
    parts: [
      ...content.segments.map((text) => ({ text, type: 'text' }) satisfies AgentMessagePartText),
      ...fileParts,
    ],
    role,
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
  assertAssistantMessageGraphWithinLimits(messages);
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
  optionsOverride: Pick<MastraAgentRuntimeOptions, 'memory' | 'storage'> = {}
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
  if (runtime?.personas) {
    options.personas = runtime.personas;
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
