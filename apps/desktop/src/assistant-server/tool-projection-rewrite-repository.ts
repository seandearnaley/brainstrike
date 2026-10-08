import {
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  NATIVE_TOOL_INPUT_SCHEMAS,
  type RuntimeData,
} from '@brainstrike/agent';
import { isNativeToolId, NATIVE_TOOL_ID, type NativeToolId } from '@brainstrike/assistant-contract';
import {
  collectSupersessionCandidates,
  type PersistedToolInvocation,
  parseFileIdentity,
  parseReadProjectionResult,
  type RecencyPruneInvocation,
  readStateScope,
  readToolCallId,
  redactToolErrorForLog,
  resetToolCallLoopGuards,
  resolveToolExecuteInputCandidate,
  selectRecencyPruneCandidates,
  TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS,
  type ToolExecuteRunContext,
} from '@brainstrike/host-capabilities/native-tools';
import { createLogger } from '@brainstrike/logging';
import { getDatabase } from '../db-main';
import {
  commitProjectionRewriteCandidates,
  listPriorInvocations,
  type ProjectionRewriteDatabaseProvider,
} from './tool-projection-rewrite-store';
import { projectGrepSearchModelOutput } from './workspace-search-model-projections';

const logger = createLogger('ToolProjectionRewriteRepository');

export { createToolProjectionRewriteLookup } from './tool-projection-rewrite-store';

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

interface RecencyPruneScanDependencies extends ToolProjectionRewriteDependencies {
  readonly excludeToolCallIds?: ReadonlySet<string>;
  readonly priorScan?: Awaited<ReturnType<typeof listPriorInvocations>>;
}

export interface RunRecencyPruneScanInput {
  readonly runtimeData: RuntimeData | undefined;
  readonly threadId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * `modelOutput === undefined` happens for native invocations persisted
 * before `providerMetadata.mastra.modelOutput` existed. Every other consumer
 * of this field (`projection-safe-tool-call-filter.ts`,
 * `projection-aware-token-limiter.ts`) treats absence as normal and skips
 * the part; skipping here (excluding the invocation from the size walk
 * entirely) is strictly safer than throwing, which would abort recency
 * pruning for the WHOLE thread on every later native-tool call (BST-1200
 * review PRRT_kwDOONNKB86XkXki).
 */
export function toRecencyPruneInvocation(
  invocation: PersistedToolInvocation
): RecencyPruneInvocation | undefined {
  if (!isNativeToolId(invocation.toolName)) {
    return;
  }
  if (invocation.modelOutput === undefined) {
    return;
  }
  return {
    args: invocation.args,
    modelOutput: invocation.modelOutput,
    toolCallId: invocation.toolCallId,
    toolName: invocation.toolName,
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
  const scan = await listPriorInvocations(database, threadId);
  if (!isRecord(current.input)) {
    throw new TypeError('Tracked tool projection input and tool-call id must be present.');
  }
  const candidates = collectSupersessionCandidates({
    current: {
      args: current.input,
      modelOutput: undefined,
      result: current.result,
      toolCallId: current.toolCallId,
      toolName: current.toolId,
    },
    invocations: scan.invocations,
    reprojectLegacyGrep: (result) =>
      projectGrepSearchModelOutput(
        result,
        CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget
      ).value,
  });
  const reclaimableChars = candidates.reduce(
    (total, candidate) => total + candidate.reclaimableChars,
    0
  );
  const supersessionCandidateIds = new Set<string>();
  if (reclaimableChars >= TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS) {
    for (const candidate of candidates) {
      supersessionCandidateIds.add(candidate.toolCallId);
    }
    const insertedIds = await commitProjectionRewriteCandidates(database, threadId, candidates);
    if (insertedIds.size > 0) {
      (dependencies.resetLoopGuards ?? resetToolCallLoopGuards)(
        readStateScope(current.runtimeData)
      );
      logger.info(
        {
          code: 'tool_projection_rewrite_batch_committed',
          inserted: insertedIds.size,
          reclaimableChars,
          threadId,
        },
        'committed superseded native-tool projection rewrite batch'
      );
    }
  }

  await runRecencyPruneScan(
    { runtimeData: current.runtimeData, threadId },
    { ...dependencies, excludeToolCallIds: supersessionCandidateIds, priorScan: scan }
  );
}

/** Run Layer 2's recency-prune scan for a thread without a synthetic tool event. */
export async function runRecencyPruneScan(
  input: RunRecencyPruneScanInput,
  dependencies: RecencyPruneScanDependencies = {}
): Promise<{ prunedCount: number }> {
  if (!input.threadId.trim()) {
    throw new Error('Recency-prune scan requires a non-empty thread id.');
  }
  const databaseProvider =
    dependencies.getDatabase ?? (getDatabase as ProjectionRewriteDatabaseProvider);
  const database = await databaseProvider();
  const scan = dependencies.priorScan ?? (await listPriorInvocations(database, input.threadId));
  const pruneEligibleInvocations: RecencyPruneInvocation[] = [];
  for (const invocation of scan.invocations) {
    if (dependencies.excludeToolCallIds?.has(invocation.toolCallId)) {
      continue;
    }
    const pruneInvocation = toRecencyPruneInvocation(invocation);
    if (pruneInvocation) {
      pruneEligibleInvocations.push(pruneInvocation);
    }
  }
  const pruneCandidates = selectRecencyPruneCandidates({
    currentTurnToolCallIds: scan.currentTurnToolCallIds,
    invocations: pruneEligibleInvocations,
  });
  if (pruneCandidates.length === 0) {
    return { prunedCount: 0 };
  }
  const prunedIds = await commitProjectionRewriteCandidates(
    database,
    input.threadId,
    pruneCandidates
  );
  if (prunedIds.size === 0) {
    return { prunedCount: 0 };
  }
  const prunedReclaimableChars = pruneCandidates.reduce(
    (total, candidate) =>
      prunedIds.has(candidate.toolCallId) ? total + candidate.reclaimableChars : total,
    0
  );
  (dependencies.resetLoopGuards ?? resetToolCallLoopGuards)(readStateScope(input.runtimeData));
  logger.info(
    {
      code: 'tool_projection_prune_batch_committed',
      prunedRows: prunedIds.size,
      reclaimableChars: prunedReclaimableChars,
      threadId: input.threadId,
    },
    'committed recency-pruned native-tool projection rewrite batch'
  );
  return { prunedCount: prunedIds.size };
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
          try {
            await recordSuccessfulToolProjection({
              input: resolveToolExecuteInputCandidate(NATIVE_TOOL_INPUT_SCHEMAS[toolId], input),
              result,
              runtimeData,
              toolCallId: readToolCallId(context),
              toolId,
            });
          } catch (error) {
            logger.error('Tool projection rewrite bookkeeping failed; tool result preserved', {
              code: 'tool_projection_rewrite_recording_failed',
              error: redactToolErrorForLog(error),
              toolId,
            });
          }
        }
        return result;
      },
    } as typeof tool;
  }
  return decorated;
}
