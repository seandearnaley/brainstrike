import {
  APPROX_CHARS_PER_TOKEN,
  type CompactionRangeEntry,
  type CompactionRangeLookup,
  collectCompactionToolCallIds,
  decodedTextModelOutputChars,
  type RuntimeData,
  resetFileReadState,
} from '@brainstrike/agent';
import { denormalizeNativeToolName, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import {
  COMPACTION_SUMMARY_METADATA_KEY,
  isCompactionSummaryPayload,
} from '@brainstrike/assistant-contract/compaction-summary';
import { ASSISTANT_COMPACTION_RANGES_TABLE } from '@brainstrike/assistant-contract/mastra-memory-schema';
import {
  readStateScope,
  resetToolCallLoopGuards,
} from '@brainstrike/host-capabilities/native-tools';
import { createLogger } from '@brainstrike/logging';
import { getDatabase } from '../db-main';

const logger = createLogger('CompactionRangeRepository');

/** Newest estimated conversation tokens that compaction must preserve. */
export const COMPACTION_PROTECT_WINDOW_TOKENS = 20_000;
const COMPACTION_PROTECT_WINDOW_CHARS = COMPACTION_PROTECT_WINDOW_TOKENS * APPROX_CHARS_PER_TOKEN;

/** Narrow future-facing pin marker; no pinning UI or persistence feature exists yet. */
export const COMPACTION_PINNED_METADATA_KEY = 'brainstrikePinned';
const HOOK_CONTEXT_MESSAGE_ID_PREFIX = 'hook-context-';

export interface CompactionSelectionMessage {
  readonly content: unknown;
  readonly id: string;
  readonly role: 'assistant' | 'signal' | 'system' | 'tool' | 'user' | string;
}

export interface CompactionRangeDatabaseTransaction {
  readonly query: <T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ) => Promise<{ rows: T[] }>;
}

export interface CompactionRangeDatabase extends CompactionRangeDatabaseTransaction {
  readonly transaction: <T>(
    callback: (tx: CompactionRangeDatabaseTransaction) => Promise<T>
  ) => Promise<T>;
}

export type CompactionRangeDatabaseProvider = () => Promise<CompactionRangeDatabase>;

export interface RecordCompactionRangeInput {
  readonly compactedMessageIds: readonly string[];
  readonly compactionMessageId: string;
  readonly kind: 'agentic' | 'deterministic';
  readonly rewriteId: string;
  readonly runtimeData: RuntimeData | undefined;
}

export interface CompactionRangeDependencies {
  readonly getDatabase?: CompactionRangeDatabaseProvider;
  readonly resetFileReads?: () => void;
  readonly resetLoopGuards?: (threadScope: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function contentParts(content: unknown): readonly unknown[] {
  if (!isRecord(content)) {
    return [];
  }
  const parts = content['parts'];
  if (Array.isArray(parts)) {
    return parts;
  }
  return Array.isArray(content['content']) ? content['content'] : [];
}

function customMetadata(content: unknown): Record<string, unknown> | undefined {
  if (!isRecord(content)) {
    return;
  }
  const metadata = content['metadata'];
  if (!isRecord(metadata)) {
    return;
  }
  const custom = metadata['custom'];
  return isRecord(custom) ? custom : undefined;
}

function decodedMessageChars(content: unknown): number {
  let chars = 0;
  const pending: unknown[] = [content];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      chars += decodedTextModelOutputChars(value);
      continue;
    }
    if (!(value && typeof value === 'object')) {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    pending.push(...(Array.isArray(value) ? value : Object.values(value)));
  }
  return chars;
}

function containsToolName(content: unknown, protectedNames: ReadonlySet<string>): boolean {
  const pending = [...contentParts(content)];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isRecord(value)) {
      continue;
    }
    const invocation = isRecord(value['toolInvocation']) ? value['toolInvocation'] : undefined;
    const rawToolName = invocation?.['toolName'] ?? value['toolName'];
    if (
      typeof rawToolName === 'string' &&
      protectedNames.has(denormalizeNativeToolName(rawToolName))
    ) {
      return true;
    }
    pending.push(...Object.values(value));
  }
  return false;
}

function isSystemSkillActivation(message: CompactionSelectionMessage): boolean {
  if (message.role !== 'system') {
    return false;
  }
  const text = contentParts(message.content)
    .flatMap((part) => (isRecord(part) && typeof part['text'] === 'string' ? [part['text']] : []))
    .join('\n');
  return (
    text.includes('The user explicitly activated the following Agent Skills for this turn.') &&
    text.includes('### Skill:')
  );
}

function isCompactionSummary(message: CompactionSelectionMessage): boolean {
  return (
    message.role === 'assistant' &&
    isCompactionSummaryPayload(customMetadata(message.content)?.[COMPACTION_SUMMARY_METADATA_KEY])
  );
}

const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set([NATIVE_TOOL_ID.skill]);
const PLAN_TOOL_NAMES: ReadonlySet<string> = new Set([
  NATIVE_TOOL_ID.askUser,
  NATIVE_TOOL_ID.submitPlan,
  'askUser',
  'submitPlan',
]);

function protectCurrentTurn(
  messages: readonly CompactionSelectionMessage[],
  protectedIds: Set<string>
): void {
  let currentTurnStart = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      currentTurnStart = index;
      break;
    }
  }
  let firstProtectedIndex = currentTurnStart < 0 ? 0 : currentTurnStart;
  while (firstProtectedIndex > 0) {
    const preceding = messages[firstProtectedIndex - 1];
    if (preceding?.role !== 'system' || !preceding.id.startsWith(HOOK_CONTEXT_MESSAGE_ID_PREFIX)) {
      break;
    }
    firstProtectedIndex -= 1;
  }
  for (let index = firstProtectedIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message) {
      protectedIds.add(message.id);
    }
  }
}

function closeProtectedToolCallPairs(
  messages: readonly CompactionSelectionMessage[],
  protectedIds: Set<string>
): void {
  const entries = messages.map((message) => ({
    message,
    toolCallIds: collectCompactionToolCallIds(message.content),
  }));
  const protectedToolCallIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const { message, toolCallIds } of entries) {
      if (!protectedIds.has(message.id)) {
        continue;
      }
      for (const toolCallId of toolCallIds) {
        if (!protectedToolCallIds.has(toolCallId)) {
          protectedToolCallIds.add(toolCallId);
          changed = true;
        }
      }
    }
    for (const { message, toolCallIds } of entries) {
      if (
        !protectedIds.has(message.id) &&
        [...toolCallIds].some((toolCallId) => protectedToolCallIds.has(toolCallId))
      ) {
        protectedIds.add(message.id);
        changed = true;
      }
    }
  }
}

/** Select every message that a compaction pass must leave standing. */
export function selectProtectedMessageIds(input: {
  readonly messages: readonly CompactionSelectionMessage[];
}): Set<string> {
  const protectedIds = new Set<string>();

  let recentChars = 0;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    if (recentChars >= COMPACTION_PROTECT_WINDOW_CHARS) {
      break;
    }
    const message = input.messages[index];
    if (!message) {
      continue;
    }
    protectedIds.add(message.id);
    recentChars += decodedMessageChars(message.content);
  }

  protectCurrentTurn(input.messages, protectedIds);

  for (const message of input.messages) {
    const custom = customMetadata(message.content);
    if (
      isSystemSkillActivation(message) ||
      containsToolName(message.content, SKILL_TOOL_NAMES) ||
      containsToolName(message.content, PLAN_TOOL_NAMES) ||
      custom?.[COMPACTION_PINNED_METADATA_KEY] === true ||
      isCompactionSummary(message)
    ) {
      protectedIds.add(message.id);
    }
  }
  closeProtectedToolCallPairs(input.messages, protectedIds);
  return protectedIds;
}

function requireCompactedMessageIds(value: unknown, summaryId: string): readonly string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((id) => typeof id !== 'string' || id.trim().length === 0) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new TypeError(`Malformed compacted message id set for ${summaryId}.`);
  }
  return parsed as string[];
}

export function createCompactionRangeLookup(
  databaseProvider: CompactionRangeDatabaseProvider
): CompactionRangeLookup {
  return {
    listActiveCompactionRanges: async (threadId) => {
      const database = await databaseProvider();
      const result = await database.query<{
        compactedMessageIds: unknown;
        compactionMessageId: string;
      }>(
        `SELECT compaction_message_id AS "compactionMessageId",
                compacted_message_ids AS "compactedMessageIds"
         FROM ${ASSISTANT_COMPACTION_RANGES_TABLE}
         WHERE thread_id = $1
         ORDER BY created_at ASC, compaction_message_id ASC`,
        [threadId]
      );
      return result.rows.map(
        (row): CompactionRangeEntry => ({
          compactedMessageIds: requireCompactedMessageIds(
            row.compactedMessageIds,
            row.compactionMessageId
          ),
          compactionMessageId: row.compactionMessageId,
        })
      );
    },
  };
}

export async function recordCompactionRange(
  current: RecordCompactionRangeInput,
  dependencies: CompactionRangeDependencies = {}
): Promise<void> {
  const threadId = current.runtimeData?.memory?.threadId;
  if (!threadId) {
    return;
  }
  if (!(current.compactionMessageId.trim() && current.rewriteId.trim())) {
    throw new Error('Compaction message id and rewrite id must be non-empty.');
  }
  const compactedMessageIds = requireCompactedMessageIds(
    current.compactedMessageIds,
    current.compactionMessageId
  );
  if (compactedMessageIds.includes(current.compactionMessageId)) {
    throw new Error('A compaction summary cannot compact itself.');
  }
  const databaseProvider =
    dependencies.getDatabase ?? (getDatabase as CompactionRangeDatabaseProvider);
  const database = await databaseProvider();
  const inserted = await database.transaction(async (tx) => {
    const result = await tx.query<{ compactionMessageId: string }>(
      `INSERT INTO ${ASSISTANT_COMPACTION_RANGES_TABLE}
        (compaction_message_id, thread_id, compacted_message_ids, kind)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (compaction_message_id) DO NOTHING
       RETURNING compaction_message_id AS "compactionMessageId"`,
      [current.compactionMessageId, threadId, JSON.stringify(compactedMessageIds), current.kind]
    );
    return result.rows.length > 0;
  });
  if (!inserted) {
    return;
  }
  (dependencies.resetLoopGuards ?? resetToolCallLoopGuards)(readStateScope(current.runtimeData));
  (dependencies.resetFileReads ?? resetFileReadState)();
  logger.info(
    {
      code: 'compaction_batch_committed',
      compactedMessages: compactedMessageIds.length,
      compactionMessageId: current.compactionMessageId,
      kind: current.kind,
      rewriteId: current.rewriteId,
      threadId,
    },
    'committed conversation compaction range'
  );
}
