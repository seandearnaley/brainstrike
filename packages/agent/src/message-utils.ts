import {
  ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES,
  ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE,
  AssistantAttachmentValidationError,
  dataUrlByteLength,
  validateImageAttachmentPart,
} from '@brainstrike/assistant-contract';
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

/**
 * A wire `file` content part (the shape assistant-stream produces for
 * composer attachments and inline image parts alike). Detected STRUCTURALLY so
 * the text walk can refuse to flatten its base64 body into prompt text even on
 * roles/paths that do not collect attachments.
 */
function isWireFileAttachmentPart(
  record: AssistantUiNodeObject
): record is AssistantUiNodeObject & { data: string; mediaType: string } {
  return (
    record['type'] === 'file' &&
    typeof record['data'] === 'string' &&
    typeof record['mediaType'] === 'string'
  );
}

/**
 * Collect wire file parts from a USER message, mirroring the container keys
 * the text walk traverses. Validates against the shared attachment contract —
 * an unsupported media type, an oversized payload, or too many attachments
 * THROWS (surfaced as a request failure), never a silent drop.
 */
function collectFileAttachmentParts(
  source: AssistantUiMessage | AssistantUiMessageStrict
): AgentMessagePartFile[] {
  const collected: AgentMessagePartFile[] = [];
  const seenObjects = new Set<AssistantUiNodeObject>();

  const visit = (value: AssistantUiNode | undefined): void => {
    if (value === null || value === undefined || typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    const record = value as AssistantUiNodeObject;
    if (seenObjects.has(record)) {
      return;
    }
    seenObjects.add(record);
    if (isWireFileAttachmentPart(record)) {
      const filename = typeof record['filename'] === 'string' ? record['filename'] : undefined;
      collected.push({
        data: record.data,
        ...(filename === undefined ? {} : { filename }),
        mediaType: record.mediaType,
        type: 'file',
      });
      return;
    }
    visit(record.content);
    visit(record.parts);
    visit(record.children);
    visit(record.values);
    visit(record.message);
    visit(record.messages);
  };

  visit((source as { content?: AssistantUiNode }).content);
  visit((source as { parts?: AssistantUiNode }).parts);

  if (collected.length > ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE) {
    throw new AssistantAttachmentValidationError(
      'too-many-attachments',
      `Message carries ${collected.length} attachments; the limit is ${ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE} per message.`
    );
  }
  let combinedBytes = 0;
  for (const part of collected) {
    validateImageAttachmentPart(part);
    combinedBytes += dataUrlByteLength(part.data);
  }
  if (combinedBytes > ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES) {
    throw new AssistantAttachmentValidationError(
      'oversized-combined',
      `Combined attachments are ${combinedBytes} bytes; the limit is ${ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES} bytes per message.`
    );
  }
  return collected;
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
    'type',
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

    // A file part's `data` is a base64 body and its `mediaType` is transport
    // metadata — neither is prompt text. Handled by
    // collectFileAttachmentParts (user messages); on every other role the
    // part is deliberately ignored rather than leaked as text.
    if (isWireFileAttachmentPart(record)) {
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

  return segments;
}

function toAgentMessage(
  message: AssistantUiMessage | AssistantUiMessageStrict | null | undefined,
  fallbackRole?: NormalizedRole
): AgentMessage | null {
  if (!message) {
    return null;
  }
  const role = normalizeRole(message.role, fallbackRole);
  const segments = extractTextSegments(message);
  // Attachments are a USER-message concept (composer-sent images); file parts
  // on other roles are excluded from the text walk but not forwarded.
  const fileParts = role === 'user' ? collectFileAttachmentParts(message) : [];
  if (segments.length === 0 && fileParts.length === 0) {
    return null;
  }
  if (!role) {
    return null;
  }
  return {
    id: ensureMessageId(message.id),
    parts: [
      ...segments.map((text) => ({ text, type: 'text' }) satisfies AgentMessagePartText),
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
