import type { ToolProjectionRewriteEntry, ToolProjectionRewriteLookup } from '@brainstrike/agent';
import { denormalizeNativeToolName } from '@brainstrike/assistant-contract';
import {
  ASSISTANT_MESSAGE_TOMBSTONES_TABLE,
  ASSISTANT_TOOL_PROJECTION_REWRITES_TABLE,
  MASTRA_MEMORY_TABLES,
} from '@brainstrike/assistant-contract/mastra-memory-schema';
import type { PersistedToolInvocation } from '@brainstrike/host-capabilities/native-tools';

export interface ProjectionRewriteDatabaseTransaction {
  readonly query: <T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ) => Promise<{ rows: T[] }>;
}

export interface ProjectionRewriteDatabase extends ProjectionRewriteDatabaseTransaction {
  readonly transaction: <T>(
    callback: (tx: ProjectionRewriteDatabaseTransaction) => Promise<T>
  ) => Promise<T>;
}

export type ProjectionRewriteDatabaseProvider = () => Promise<ProjectionRewriteDatabase>;

export type { PersistedToolInvocation };

export interface PriorInvocationScan {
  readonly currentTurnToolCallIds: ReadonlySet<string>;
  readonly invocations: PersistedToolInvocation[];
}

type ProjectionRewriteCommitCandidate = ToolProjectionRewriteEntry & {
  readonly originalChars: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readContentParts(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return;
  }
  if (Array.isArray(value['content'])) {
    return value['content'];
  }
  return Array.isArray(value['parts']) ? value['parts'] : undefined;
}

/** Parse the exact persisted Mastra v2 invocation dialect used by both layers. */
export function parsePersistedInvocation(value: unknown): PersistedToolInvocation | undefined {
  if (!isRecord(value) || value['type'] !== 'tool-invocation') {
    return;
  }
  const invocation = value['toolInvocation'];
  if (!isRecord(invocation)) {
    return;
  }
  const args = invocation['args'];
  const toolCallId = invocation['toolCallId'];
  const toolName = invocation['toolName'];
  if (
    !isRecord(args) ||
    typeof toolCallId !== 'string' ||
    toolCallId.length === 0 ||
    typeof toolName !== 'string' ||
    toolName.length === 0 ||
    !Object.hasOwn(invocation, 'result')
  ) {
    return;
  }
  const providerMetadata = value['providerMetadata'];
  const mastraMetadata = isRecord(providerMetadata) ? providerMetadata['mastra'] : undefined;
  return {
    args,
    modelOutput: isRecord(mastraMetadata) ? mastraMetadata['modelOutput'] : undefined,
    result: invocation['result'],
    toolCallId,
    toolName: denormalizeNativeToolName(toolName),
  };
}

function collectReferencedToolCallIds(value: unknown, target: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectReferencedToolCallIds(entry, target);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (typeof value['toolCallId'] === 'string' && value['toolCallId'].length > 0) {
    target.add(value['toolCallId']);
  }
  for (const entry of Object.values(value)) {
    collectReferencedToolCallIds(entry, target);
  }
}

export async function listPriorInvocations(
  database: ProjectionRewriteDatabase,
  threadId: string
): Promise<PriorInvocationScan> {
  const result = await database.query<{ content: unknown; isCurrentTurn: boolean }>(
    `WITH current_turn AS (
       SELECT user_message."createdAt", user_message.id
       FROM ${MASTRA_MEMORY_TABLES.messages} AS user_message
       WHERE user_message.thread_id = $1
         AND user_message.role = 'user'
         AND NOT EXISTS (
           SELECT 1 FROM ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE} AS tombstones
           WHERE tombstones.message_id = user_message.id
         )
       ORDER BY user_message."createdAt" DESC, user_message.id DESC
       LIMIT 1
     )
     SELECT messages.content AS content,
            (current_turn.id IS NULL OR
             (messages."createdAt", messages.id) >
             (current_turn."createdAt", current_turn.id)) AS "isCurrentTurn"
     FROM ${MASTRA_MEMORY_TABLES.messages} AS messages
     LEFT JOIN current_turn ON TRUE
     WHERE messages.thread_id = $1
       AND messages.role = 'assistant'
       AND NOT EXISTS (
         SELECT 1 FROM ${ASSISTANT_MESSAGE_TOMBSTONES_TABLE} AS tombstones
         WHERE tombstones.message_id = messages.id
       )
     ORDER BY messages."createdAt" ASC, messages.id ASC`,
    [threadId]
  );
  const invocations: PersistedToolInvocation[] = [];
  const currentTurnToolCallIds = new Set<string>();
  for (const row of result.rows) {
    for (const part of readContentParts(row.content) ?? []) {
      if (row.isCurrentTurn) {
        collectReferencedToolCallIds(part, currentTurnToolCallIds);
      }
      const invocation = parsePersistedInvocation(part);
      if (invocation) {
        invocations.push(invocation);
      }
    }
  }
  const existing = await database.query<{ toolCallId: string }>(
    `SELECT tool_call_id AS "toolCallId"
     FROM ${ASSISTANT_TOOL_PROJECTION_REWRITES_TABLE} WHERE thread_id = $1`,
    [threadId]
  );
  const existingIds = new Set(existing.rows.map((row) => row.toolCallId));
  return {
    currentTurnToolCallIds,
    invocations: invocations.filter((invocation) => !existingIds.has(invocation.toolCallId)),
  };
}

export async function commitProjectionRewriteCandidates(
  database: ProjectionRewriteDatabase,
  threadId: string,
  candidates: readonly ProjectionRewriteCommitCandidate[]
): Promise<ReadonlySet<string>> {
  const rewriteId = crypto.randomUUID();
  return await database.transaction(async (tx) => {
    const result = await tx.query<{ toolCallId: string }>(
      `INSERT INTO ${ASSISTANT_TOOL_PROJECTION_REWRITES_TABLE}
        (tool_call_id, thread_id, rewrite_id, kind, superseded_by_tool_call_id,
         marker_text, original_chars)
       SELECT batch.tool_call_id, $1, $2, batch.kind, batch.superseded_by_tool_call_id,
              batch.marker_text, batch.original_chars
       FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::integer[])
         AS batch(tool_call_id, kind, superseded_by_tool_call_id, marker_text, original_chars)
       ON CONFLICT (tool_call_id) DO NOTHING
       RETURNING tool_call_id AS "toolCallId"`,
      [
        threadId,
        rewriteId,
        candidates.map((candidate) => candidate.toolCallId),
        candidates.map((candidate) => candidate.kind),
        candidates.map((candidate) => candidate.supersededByToolCallId),
        candidates.map((candidate) => candidate.markerText),
        candidates.map((candidate) => candidate.originalChars),
      ]
    );
    return new Set(result.rows.map((row) => row.toolCallId));
  });
}

export function createToolProjectionRewriteLookup(
  databaseProvider: ProjectionRewriteDatabaseProvider
): ToolProjectionRewriteLookup {
  return {
    listActiveRewrites: async (threadId) => {
      const database = await databaseProvider();
      const result = await database.query<{
        kind: string;
        markerText: string;
        supersededByToolCallId: string | null;
        toolCallId: string;
      }>(
        `SELECT tool_call_id AS "toolCallId", kind,
                superseded_by_tool_call_id AS "supersededByToolCallId",
                marker_text AS "markerText"
         FROM ${ASSISTANT_TOOL_PROJECTION_REWRITES_TABLE}
         WHERE thread_id = $1`,
        [threadId]
      );
      return new Map(
        result.rows.map((row): [string, ToolProjectionRewriteEntry] => {
          const common = { markerText: row.markerText, toolCallId: row.toolCallId };
          if (row.kind === 'prune' && row.supersededByToolCallId === null) {
            return [row.toolCallId, { ...common, kind: 'prune', supersededByToolCallId: null }];
          }
          if (
            row.kind === 'supersession' &&
            typeof row.supersededByToolCallId === 'string' &&
            row.supersededByToolCallId.length > 0
          ) {
            return [
              row.toolCallId,
              {
                ...common,
                kind: 'supersession',
                supersededByToolCallId: row.supersededByToolCallId,
              },
            ];
          }
          throw new TypeError(`Malformed tool projection rewrite row for ${row.toolCallId}.`);
        })
      );
    },
  };
}
