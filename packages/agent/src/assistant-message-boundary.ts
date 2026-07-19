import { ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES } from '@brainstrike/assistant-contract';

export const MAX_ASSISTANT_MESSAGE_ID_CHARS = 512;
export const MAX_ASSISTANT_MESSAGE_GRAPH_DEPTH = 32;
export const MAX_ASSISTANT_MESSAGE_GRAPH_NODES = 50_000;
export const MAX_ASSISTANT_MESSAGES = 1000;
export const MAX_ASSISTANT_MESSAGE_ARRAY_ITEMS = 2000;
export const MAX_ASSISTANT_MESSAGE_OBJECT_FIELDS = 1000;
export const MAX_ASSISTANT_MESSAGE_STRING_CHARS = 1_000_000;

const MAX_ASSISTANT_MESSAGE_KEY_CHARS = 512;
const MAX_ASSISTANT_MESSAGE_METADATA_CHARS = 4096;
const MAX_ASSISTANT_MESSAGE_TOTAL_STRING_CHARS = 16 * 1024 * 1024;
const MAX_ATTACHMENT_DATA_URL_CHARS =
  Math.ceil((ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES * 4) / 3) + 1024;
const METADATA_STRING_KEYS = new Set(['filename', 'mediaType', 'role', 'type']);

export type AssistantMessageValidationReason =
  | 'cyclic-object'
  | 'empty-messages'
  | 'invalid-message-id'
  | 'invalid-messages'
  | 'invalid-node'
  | 'too-deep'
  | 'too-many-array-items'
  | 'too-many-messages'
  | 'too-many-nodes'
  | 'too-many-object-fields'
  | 'too-many-string-chars'
  | 'oversized-key'
  | 'oversized-string';

const VALIDATION_MESSAGES: Record<AssistantMessageValidationReason, string> = {
  'cyclic-object': 'Assistant message payload contains a cyclic object graph.',
  'empty-messages': 'Assistant chat requests must contain at least one message.',
  'invalid-message-id': 'Assistant message id must be a non-empty bounded string.',
  'invalid-messages': 'Assistant messages must be an array.',
  'invalid-node': 'Assistant message payload contains an unsupported value.',
  'oversized-key': 'Assistant message payload contains an oversized object key.',
  'oversized-string': 'Assistant message payload contains an oversized string.',
  'too-deep': 'Assistant message payload exceeds the nesting depth limit.',
  'too-many-array-items': 'Assistant message payload exceeds the array item limit.',
  'too-many-messages': 'Assistant message payload exceeds the message count limit.',
  'too-many-nodes': 'Assistant message payload exceeds the node count limit.',
  'too-many-object-fields': 'Assistant message payload exceeds the object field limit.',
  'too-many-string-chars': 'Assistant message payload exceeds the total string limit.',
};

export class AssistantMessageValidationError extends Error {
  readonly code = 'invalid_messages';

  constructor(readonly reason: AssistantMessageValidationReason) {
    super(VALIDATION_MESSAGES[reason]);
    this.name = 'AssistantMessageValidationError';
  }
}

interface PendingMessageNode {
  depth: number;
  isAttachmentData: boolean;
  key?: string;
  kind: 'value';
  value: unknown;
}

interface PendingObjectExit {
  kind: 'exit';
  value: object;
}

type PendingTraversalNode = PendingMessageNode | PendingObjectExit;

interface MessageGraphState {
  nodeCount: number;
  totalStringChars: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function stringLimitForNode(node: PendingMessageNode): number {
  if (node.isAttachmentData) {
    return MAX_ATTACHMENT_DATA_URL_CHARS;
  }
  if (node.key === 'id') {
    return MAX_ASSISTANT_MESSAGE_ID_CHARS;
  }
  if (node.key && METADATA_STRING_KEYS.has(node.key)) {
    return MAX_ASSISTANT_MESSAGE_METADATA_CHARS;
  }
  return MAX_ASSISTANT_MESSAGE_STRING_CHARS;
}

function assertStringWithinLimits(node: PendingMessageNode, state: MessageGraphState): void {
  const value = node.value as string;
  if (value.length > stringLimitForNode(node)) {
    throw new AssistantMessageValidationError('oversized-string');
  }
  if (node.isAttachmentData) {
    return;
  }
  state.totalStringChars += value.length;
  if (state.totalStringChars > MAX_ASSISTANT_MESSAGE_TOTAL_STRING_CHARS) {
    throw new AssistantMessageValidationError('too-many-string-chars');
  }
}

function handleScalarNode(node: PendingMessageNode, state: MessageGraphState): boolean {
  if (node.value === null || node.value === undefined || typeof node.value === 'boolean') {
    return true;
  }
  if (typeof node.value === 'string') {
    assertStringWithinLimits(node, state);
    return true;
  }
  if (typeof node.value === 'number') {
    if (!Number.isFinite(node.value)) {
      throw new AssistantMessageValidationError('invalid-node');
    }
    return true;
  }
  if (typeof node.value === 'object') {
    return false;
  }
  throw new AssistantMessageValidationError('invalid-node');
}

function appendArrayItems(node: PendingMessageNode, pending: PendingTraversalNode[]): void {
  const items = node.value as readonly unknown[];
  if (items.length > MAX_ASSISTANT_MESSAGE_ARRAY_ITEMS) {
    throw new AssistantMessageValidationError('too-many-array-items');
  }
  for (const item of items) {
    pending.push({
      depth: node.depth + 1,
      isAttachmentData: false,
      kind: 'value',
      value: item,
    });
  }
}

function appendObjectFields(node: PendingMessageNode, pending: PendingTraversalNode[]): void {
  if (!isPlainRecord(node.value)) {
    throw new AssistantMessageValidationError('invalid-node');
  }
  const entries = Object.entries(node.value);
  if (entries.length > MAX_ASSISTANT_MESSAGE_OBJECT_FIELDS) {
    throw new AssistantMessageValidationError('too-many-object-fields');
  }
  const isFilePart = node.value['type'] === 'file';
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_ASSISTANT_MESSAGE_KEY_CHARS) {
      throw new AssistantMessageValidationError('oversized-key');
    }
    pending.push({
      depth: node.depth + 1,
      isAttachmentData: isFilePart && key === 'data',
      key,
      kind: 'value',
      value,
    });
  }
}

/**
 * Iteratively enforces the assistant message wire budget before any recursive
 * compatibility normalizer sees the graph. It validates limits only; it never
 * drops, truncates, or coerces attacker-controlled values.
 */
export function assertAssistantMessageGraphWithinLimits(
  messages: unknown
): asserts messages is readonly unknown[] {
  if (!Array.isArray(messages)) {
    throw new AssistantMessageValidationError('invalid-messages');
  }
  if (messages.length > MAX_ASSISTANT_MESSAGES) {
    throw new AssistantMessageValidationError('too-many-messages');
  }

  const pending: PendingTraversalNode[] = messages.map((value) => ({
    depth: 0,
    isAttachmentData: false,
    kind: 'value',
    value,
  }));
  const activeObjects = new WeakSet<object>();
  const state: MessageGraphState = { nodeCount: 0, totalStringChars: 0 };

  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      throw new AssistantMessageValidationError('invalid-node');
    }
    if (node.kind === 'exit') {
      activeObjects.delete(node.value);
      continue;
    }
    state.nodeCount += 1;
    if (state.nodeCount > MAX_ASSISTANT_MESSAGE_GRAPH_NODES) {
      throw new AssistantMessageValidationError('too-many-nodes');
    }
    if (node.depth > MAX_ASSISTANT_MESSAGE_GRAPH_DEPTH) {
      throw new AssistantMessageValidationError('too-deep');
    }
    if (handleScalarNode(node, state)) {
      continue;
    }

    const objectValue = node.value as object;
    if (activeObjects.has(objectValue)) {
      throw new AssistantMessageValidationError('cyclic-object');
    }
    activeObjects.add(objectValue);
    pending.push({ kind: 'exit', value: objectValue });
    if (Array.isArray(node.value)) {
      appendArrayItems(node, pending);
      continue;
    }
    appendObjectFields(node, pending);
  }
}
