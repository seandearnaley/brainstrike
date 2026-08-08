import {
  GrepSearchInputSchema,
  NATIVE_TOOL_INPUT_SCHEMAS,
  type RuntimeData,
  type ToolProjectionRewriteEntry,
  type ToolProjectionRewriteLookup,
} from '@brainstrike/agent';
import {
  denormalizeNativeToolName,
  NATIVE_TOOL_ID,
  type NativeToolId,
} from '@brainstrike/assistant-contract';
import {
  ASSISTANT_MESSAGE_TOMBSTONES_TABLE,
  ASSISTANT_TOOL_PROJECTION_REWRITES_TABLE,
  MASTRA_MEMORY_TABLES,
} from '@brainstrike/assistant-contract/mastra-memory-schema';
import { createLogger } from '@brainstrike/logging';
import { getDatabase } from '../db-main';
import {
  type GrepToolResult,
  grepProjectionHeaderPrefix,
  parseGrepToolResult,
} from './grep-search-result-contract';
import { readProjectionHeaderPrefix } from './read-workspace-file-result-contract';
import { resetToolCallLoopGuards } from './tool-call-loop-guards';
import {
  readToolCallId,
  resolveToolExecuteInputCandidate,
  type ToolExecuteRunContext,
} from './tool-execute-support';
import { readStateScope } from './workspace-file-staleness';
import { escapeProjectionPathLineBreaks } from './workspace-model-projection-helpers';
import { projectGrepSearchModelOutput } from './workspace-search-model-projections';

const logger = createLogger('ToolProjectionRewriteRepository');

/** Cline's 64 KiB stale-read compaction trigger, measured in projected chars. */
export const TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS = 65_536;

interface ProjectionRewriteDatabaseTransaction {
  readonly query: <T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ) => Promise<{ rows: T[] }>;
}

interface ProjectionRewriteDatabase extends ProjectionRewriteDatabaseTransaction {
  readonly transaction: <T>(
    callback: (tx: ProjectionRewriteDatabaseTransaction) => Promise<T>
  ) => Promise<T>;
}

type ProjectionRewriteDatabaseProvider = () => Promise<ProjectionRewriteDatabase>;

interface PersistedToolInvocation {
  readonly args: Record<string, unknown>;
  readonly result: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}

interface ReadProjectionResult {
  readonly endLine: number;
  readonly path: string;
  readonly rootName: string;
  readonly startLine: number;
  readonly totalLines: number;
}

interface RewriteCandidate extends ToolProjectionRewriteEntry {
  readonly originalChars: number;
  readonly reclaimableChars: number;
}

export interface SuccessfulToolProjection {
  readonly input: unknown;
  readonly result: unknown;
  readonly runtimeData: RuntimeData | undefined;
  readonly toolCallId: string | undefined;
  readonly toolId: NativeToolId;
}

export interface ToolProjectionRewriteDependencies {
  readonly getDatabase?: ProjectionRewriteDatabaseProvider;
  readonly resetLoopGuards?: (threadScope: string) => void;
}

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
  if (Array.isArray(value['parts'])) {
    return value['parts'];
  }
  return;
}

function parsePersistedInvocation(value: unknown): PersistedToolInvocation | undefined {
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
  return {
    args,
    result: invocation['result'],
    toolCallId,
    toolName: denormalizeNativeToolName(toolName),
  };
}

function parseReadProjectionResult(value: unknown): ReadProjectionResult | undefined {
  if (!isRecord(value)) {
    return;
  }
  const { endLine, path, rootName, startLine, totalLines } = value;
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    typeof rootName !== 'string' ||
    rootName.length === 0 ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    !Number.isInteger(totalLines)
  ) {
    return;
  }
  return {
    endLine: endLine as number,
    path,
    rootName,
    startLine: startLine as number,
    totalLines: totalLines as number,
  };
}

export function buildReadSupersededMarker(result: ReadProjectionResult): string {
  // Mirrors read-workspace-file-model-projection.ts's own `read ` header
  // convention (PR #2322, merged) so a collapsed marker still reads as a
  // natural continuation of that format; the path is escaped the same way
  // that live projector escapes it so an embedded newline in a filename can
  // never break the marker's single-line invariant.
  const escapedPath = escapeProjectionPathLineBreaks(result.path);
  return `${readProjectionHeaderPrefix()}${escapedPath} lines ${result.startLine}-${result.endLine}/${result.totalLines} [superseded — see the later read of this file]`;
}

export function buildGrepSupersededMarker(outputMode: GrepToolResult['outputMode']): string {
  return `${grepProjectionHeaderPrefix(outputMode)}[superseded — results for this pattern were refreshed later]`;
}

function serializedChars(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Tool projection cannot be serialized as JSON.');
  }
  return serialized.length;
}

function readCandidate(invocation: PersistedToolInvocation): RewriteCandidate | undefined {
  const result = parseReadProjectionResult(invocation.result);
  if (!result) {
    logger.warn('Skipping malformed persisted read result during supersession detection', {
      code: 'tool_projection_rewrite_malformed_read_history',
      toolCallId: invocation.toolCallId,
    });
    return;
  }
  const markerText = buildReadSupersededMarker(result);
  const originalChars = serializedChars({ type: 'json', value: invocation.result });
  const markerChars = serializedChars({ type: 'text', value: markerText });
  return {
    markerText,
    originalChars,
    reclaimableChars: Math.max(0, originalChars - markerChars),
    supersededByToolCallId: '',
    toolCallId: invocation.toolCallId,
  };
}

function grepCandidate(invocation: PersistedToolInvocation): RewriteCandidate | undefined {
  let result: GrepToolResult;
  try {
    result = parseGrepToolResult(invocation.result);
  } catch (error) {
    logger.warn('Skipping malformed persisted grep result during supersession detection', {
      code: 'tool_projection_rewrite_malformed_grep_history',
      error,
      toolCallId: invocation.toolCallId,
    });
    return;
  }
  const markerText = buildGrepSupersededMarker(result.outputMode);
  const originalChars = serializedChars(projectGrepSearchModelOutput(invocation.result));
  const markerChars = serializedChars({ type: 'text', value: markerText });
  return {
    markerText,
    originalChars,
    reclaimableChars: Math.max(0, originalChars - markerChars),
    supersededByToolCallId: '',
    toolCallId: invocation.toolCallId,
  };
}

function normalizeGrepKey(args: Record<string, unknown>): string | undefined {
  const parsed = GrepSearchInputSchema.safeParse(args);
  if (!parsed.success) {
    return;
  }
  const input = parsed.data;
  return JSON.stringify({
    caseSensitive: input.caseSensitive ?? false,
    contextLines: input.contextLines ?? 0,
    filePaths: input.filePaths ? [...input.filePaths].sort() : [],
    isRegex: input.isRegex ?? false,
    maxResults: input.maxResults ?? 50,
    offset: input.offset ?? 0,
    outputMode: input.outputMode ?? 'files',
    pattern: input.pattern,
    root: input.root ?? null,
  });
}

function parseFileIdentity(
  value: unknown
): Pick<ReadProjectionResult, 'path' | 'rootName'> | undefined {
  if (!isRecord(value)) {
    return;
  }
  const { path, rootName } = value;
  if (
    !(
      typeof path === 'string' &&
      path.length > 0 &&
      typeof rootName === 'string' &&
      rootName.length > 0
    )
  ) {
    return;
  }
  return { path, rootName };
}

function rangesOverlap(first: ReadProjectionResult, second: ReadProjectionResult): boolean {
  return first.startLine <= second.endLine && second.startLine <= first.endLine;
}

function readWasSuperseded(args: {
  readonly earlierRead: ReadProjectionResult;
  readonly later: PersistedToolInvocation;
}): boolean {
  const currentFile = parseFileIdentity(args.later.result);
  if (
    currentFile?.path !== args.earlierRead.path ||
    currentFile.rootName !== args.earlierRead.rootName
  ) {
    return false;
  }
  if (
    args.later.toolName === NATIVE_TOOL_ID.writeWorkspaceFile ||
    args.later.toolName === NATIVE_TOOL_ID.stringReplaceWorkspaceFile
  ) {
    return true;
  }
  const currentRead = parseReadProjectionResult(args.later.result);
  return Boolean(
    args.later.toolName === NATIVE_TOOL_ID.readWorkspaceFile &&
      currentRead &&
      rangesOverlap(args.earlierRead, currentRead)
  );
}

function readRewriteCandidate(args: {
  readonly earlier: PersistedToolInvocation;
  readonly later: PersistedToolInvocation;
}): RewriteCandidate | undefined {
  if (args.earlier.toolName !== NATIVE_TOOL_ID.readWorkspaceFile) {
    return;
  }
  const earlierRead = parseReadProjectionResult(args.earlier.result);
  if (!earlierRead) {
    readCandidate(args.earlier);
    return;
  }
  if (!readWasSuperseded({ earlierRead, later: args.later })) {
    return;
  }
  const candidate = readCandidate(args.earlier);
  return candidate ? { ...candidate, supersededByToolCallId: args.later.toolCallId } : undefined;
}

function grepRewriteCandidate(args: {
  readonly earlier: PersistedToolInvocation;
  readonly later: PersistedToolInvocation;
}): RewriteCandidate | undefined {
  if (
    args.earlier.toolName !== NATIVE_TOOL_ID.grepSearch ||
    args.later.toolName !== NATIVE_TOOL_ID.grepSearch ||
    normalizeGrepKey(args.earlier.args) === undefined ||
    normalizeGrepKey(args.earlier.args) !== normalizeGrepKey(args.later.args)
  ) {
    return;
  }
  const candidate = grepCandidate(args.earlier);
  return candidate ? { ...candidate, supersededByToolCallId: args.later.toolCallId } : undefined;
}

function collectCandidates(args: {
  readonly current: SuccessfulToolProjection;
  readonly invocations: readonly PersistedToolInvocation[];
}): RewriteCandidate[] {
  if (!(isRecord(args.current.input) && args.current.toolCallId)) {
    throw new TypeError('Tracked tool projection input and tool-call id must be present.');
  }
  const history: PersistedToolInvocation[] = [
    ...args.invocations,
    {
      args: args.current.input,
      result: args.current.result,
      toolCallId: args.current.toolCallId,
      toolName: args.current.toolId,
    },
  ];
  const candidates: RewriteCandidate[] = [];
  for (let earlierIndex = 0; earlierIndex < history.length - 1; earlierIndex += 1) {
    const earlier = history[earlierIndex];
    if (!earlier) {
      continue;
    }
    const later = history
      .slice(earlierIndex + 1)
      .find(
        (candidate) =>
          readRewriteCandidate({ earlier, later: candidate }) !== undefined ||
          grepRewriteCandidate({ earlier, later: candidate }) !== undefined
      );
    if (!later) {
      continue;
    }
    const candidate =
      readRewriteCandidate({ earlier, later }) ?? grepRewriteCandidate({ earlier, later });
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

async function listPriorInvocations(
  database: ProjectionRewriteDatabase,
  threadId: string
): Promise<PersistedToolInvocation[]> {
  const result = await database.query<{ content: unknown }>(
    `SELECT messages.content AS content
     FROM ${MASTRA_MEMORY_TABLES.messages} AS messages
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
  for (const row of result.rows) {
    for (const part of readContentParts(row.content) ?? []) {
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
  return invocations.filter((invocation) => !existingIds.has(invocation.toolCallId));
}

async function commitCandidates(
  database: ProjectionRewriteDatabase,
  threadId: string,
  candidates: readonly RewriteCandidate[]
): Promise<number> {
  const rewriteId = crypto.randomUUID();
  return await database.transaction(async (tx) => {
    const result = await tx.query<{ toolCallId: string }>(
      `INSERT INTO ${ASSISTANT_TOOL_PROJECTION_REWRITES_TABLE}
        (tool_call_id, thread_id, rewrite_id, superseded_by_tool_call_id, marker_text, original_chars)
       SELECT batch.tool_call_id, $1, $2, batch.superseded_by_tool_call_id,
              batch.marker_text, batch.original_chars
       FROM unnest($3::text[], $4::text[], $5::text[], $6::integer[])
         AS batch(tool_call_id, superseded_by_tool_call_id, marker_text, original_chars)
       ON CONFLICT (tool_call_id) DO NOTHING
       RETURNING tool_call_id AS "toolCallId"`,
      [
        threadId,
        rewriteId,
        candidates.map((candidate) => candidate.toolCallId),
        candidates.map((candidate) => candidate.supersededByToolCallId),
        candidates.map((candidate) => candidate.markerText),
        candidates.map((candidate) => candidate.originalChars),
      ]
    );
    return result.rows.length;
  });
}

export function createToolProjectionRewriteLookup(
  databaseProvider: ProjectionRewriteDatabaseProvider
): ToolProjectionRewriteLookup {
  return {
    listActiveRewrites: async (threadId) => {
      const database = await databaseProvider();
      const result = await database.query<{
        markerText: string;
        supersededByToolCallId: string;
        toolCallId: string;
      }>(
        `SELECT tool_call_id AS "toolCallId",
                superseded_by_tool_call_id AS "supersededByToolCallId",
                marker_text AS "markerText"
         FROM ${ASSISTANT_TOOL_PROJECTION_REWRITES_TABLE}
         WHERE thread_id = $1`,
        [threadId]
      );
      return new Map(
        result.rows.map((row) => [
          row.toolCallId,
          {
            markerText: row.markerText,
            supersededByToolCallId: row.supersededByToolCallId,
            toolCallId: row.toolCallId,
          },
        ])
      );
    },
  };
}

export async function recordSuccessfulToolProjection(
  current: SuccessfulToolProjection,
  dependencies: ToolProjectionRewriteDependencies = {}
): Promise<void> {
  const threadId = current.runtimeData?.memory?.threadId;
  if (!threadId) {
    return;
  }
  if (!current.toolCallId?.trim()) {
    throw new Error('Tool projection supersession requires the current tool-call id.');
  }
  const databaseProvider =
    dependencies.getDatabase ?? (getDatabase as ProjectionRewriteDatabaseProvider);
  const database = await databaseProvider();
  const invocations = await listPriorInvocations(database, threadId);
  const candidates = collectCandidates({ current, invocations });
  const reclaimableChars = candidates.reduce(
    (total, candidate) => total + candidate.reclaimableChars,
    0
  );
  if (reclaimableChars < TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS) {
    return;
  }
  const inserted = await commitCandidates(database, threadId, candidates);
  if (inserted === 0) {
    return;
  }
  (dependencies.resetLoopGuards ?? resetToolCallLoopGuards)(readStateScope(current.runtimeData));
  logger.info(
    {
      code: 'tool_projection_rewrite_batch_committed',
      inserted,
      reclaimableChars,
      threadId,
    },
    'committed superseded native-tool projection rewrite batch'
  );
}

type MastraTools = NonNullable<RuntimeData['mastraTools']>;

interface ExecutableTool {
  readonly execute: (input: unknown, context?: ToolExecuteRunContext) => Promise<unknown> | unknown;
}

const REWRITE_TRACKED_TOOL_IDS = [
  NATIVE_TOOL_ID.grepSearch,
  NATIVE_TOOL_ID.readWorkspaceFile,
  NATIVE_TOOL_ID.stringReplaceWorkspaceFile,
  NATIVE_TOOL_ID.writeWorkspaceFile,
] as const;

function shouldRecordResult(
  toolId: (typeof REWRITE_TRACKED_TOOL_IDS)[number],
  result: unknown
): boolean {
  if (!isRecord(result)) {
    return false;
  }
  if (toolId === NATIVE_TOOL_ID.readWorkspaceFile) {
    return result['dedup'] !== true && parseReadProjectionResult(result) !== undefined;
  }
  if (toolId === NATIVE_TOOL_ID.grepSearch) {
    return result['outputMode'] === 'files' || result['outputMode'] === 'content';
  }
  return parseFileIdentity(result) !== undefined;
}

/** Decorate only the four desktop tools that can supersede persisted reads. */
export function applyToolProjectionRewriteRecording(
  tools: MastraTools,
  runtimeData: RuntimeData | undefined
): MastraTools {
  if (!runtimeData?.toolProjectionRewriteLookup) {
    return tools;
  }
  const decorated: MastraTools = { ...tools };
  for (const toolId of REWRITE_TRACKED_TOOL_IDS) {
    const tool = tools[toolId];
    if (!tool) {
      continue;
    }
    if (!(typeof tool === 'object' && 'execute' in tool && typeof tool.execute === 'function')) {
      throw new TypeError(`${toolId} must expose an execute function for projection rewriting.`);
    }
    const executable = tool as unknown as ExecutableTool;
    decorated[toolId] = {
      ...tool,
      execute: async (input: unknown, context?: ToolExecuteRunContext) => {
        const result = await executable.execute(input, context);
        if (shouldRecordResult(toolId, result)) {
          await recordSuccessfulToolProjection({
            input: resolveToolExecuteInputCandidate(NATIVE_TOOL_INPUT_SCHEMAS[toolId], input),
            result,
            runtimeData,
            toolCallId: readToolCallId(context),
            toolId,
          });
        }
        return result;
      },
    } as typeof tool;
  }
  return decorated;
}
