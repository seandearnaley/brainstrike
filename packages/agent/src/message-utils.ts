import {
  ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES,
  ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE,
  AssistantAttachmentValidationError,
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

function normalizeRole(role: AssistantUiMessage['role']): NormalizedRole | undefined {
  if (typeof role === 'string') {
    const lower = role.toLowerCase();
    if (lower === 'user' || lower === 'assistant' || lower === 'system') {
      return lower;
    }
  }
  return;
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
    combinedBytes += validateImageAttachmentPart(part);
  }
  if (combinedBytes > ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES) {
    throw new AssistantAttachmentValidationError(
      'oversized-combined',
      `Combined attachments are ${combinedBytes} bytes; the limit is ${ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES} bytes per message.`
    );
  }
}

/**
 * Parse only the assistant transport's documented message/part positions.
 * User attachments are direct `content`/`parts` file parts. Tool inputs,
 * outputs, data parts, and other nested domain payloads stay opaque: a domain
 * object that happens to use `type: "file"` is not an image attachment and its
 * scalar fields are never flattened into prompt text.
 */
function extractMessageContent(
  source: AssistantUiMessage | AssistantUiMessageStrict,
  role: NormalizedRole
): ExtractedMessageContent {
  const fileParts: AgentMessagePartFile[] = [];
  const segments: string[] = [];
  const seenValues = new Set<string>();

  const pushText = (raw: string): void => {
    const text = raw.trim();
    if (text.length === 0 || seenValues.has(text)) {
      return;
    }
    seenValues.add(text);
    segments.push(text);
  };

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

  const visitDirectPart = (value: AssistantUiNode): void => {
    if (value === null || typeof value !== 'object') {
      pushScalar(value as AssistantUiScalar);
      return;
    }
    if (Array.isArray(value)) {
      // Nested arrays are not assistant message parts. Keeping them opaque
      // avoids manufacturing a second, undocumented attachment position.
      return;
    }
    const record = value as AssistantUiNodeObject;
    const partType = record['type'];
    if (partType === 'file') {
      if (role === 'user') {
        const filePart = readWireFileAttachmentCandidate(record);
        if (filePart) {
          fileParts.push(filePart);
        }
      }
      return;
    }
    if (partType === 'text') {
      pushScalar(record.text);
      return;
    }
    if (partType !== undefined) {
      // Tool calls/results, data parts, near-miss file discriminators, and all
      // other typed parts are opaque at this conversion boundary.
      return;
    }
    // Compatibility for the legacy untyped text/value part dialect. Only the
    // two explicit scalar fields are read; nested objects remain opaque.
    pushScalar(record.text);
    pushScalar(record.value);
  };

  const visitDirectParts = (value: AssistantUiNode | undefined): void => {
    if (value === null || value === undefined) {
      return;
    }
    if (!Array.isArray(value)) {
      visitDirectPart(value);
      return;
    }
    for (const part of value) {
      visitDirectPart(part);
    }
  };

  // source.text may be string in strict or scalar in permissive shape
  pushScalar(source.text as AssistantUiScalar | undefined);
  const maybeContent = (source as { content?: AssistantUiNode }).content;
  const maybeParts = (source as { parts?: AssistantUiNode }).parts;
  visitDirectParts(maybeContent);
  visitDirectParts(maybeParts);

  assertAttachmentCollectionWithinLimits(fileParts);
  return { fileParts, segments };
}

function toAgentMessage(
  message: AssistantUiMessage | AssistantUiMessageStrict | null | undefined
): AgentMessage | null {
  if (!message) {
    return null;
  }
  const role = normalizeRole(message.role);
  if (!role) {
    return null;
  }
  const content = extractMessageContent(message, role);
  // Attachments are a USER-message concept (composer-sent images); file parts
  // on other roles stay opaque and are not forwarded.
  const fileParts = role === 'user' ? content.fileParts : [];
  if (content.segments.length === 0 && fileParts.length === 0) {
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
  return convertAssistantUiMessagesWithFinalInput(messages).messages;
}

export interface AssistantUiMessageConversionResult {
  finalInputMessage: AgentMessage | null;
  messages: AgentMessage[];
}

export function convertAssistantUiMessagesWithFinalInput(
  messages: ReadonlyArray<AssistantUiMessage | AssistantUiMessageStrict | null | undefined>
): AssistantUiMessageConversionResult {
  assertAssistantMessageGraphWithinLimits(messages);
  const converted: AgentMessage[] = [];
  let finalInputMessage: AgentMessage | null = null;
  for (const [index, message] of messages.entries()) {
    const agentMessage = toAgentMessage(message);
    if (index === messages.length - 1) {
      finalInputMessage = agentMessage;
    }
    if (agentMessage) {
      converted.push(agentMessage);
    }
  }
  return { finalInputMessage, messages: converted };
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
