import {
  type DelegatedConversationDatabase,
  DelegatedConversationIdentityError,
  type DelegatedConversationScope,
} from './delegated-conversation-boundary.js';
import { AUTHORIZED_DELEGATED_GRAPH } from './delegated-graph-sql.js';

/** Structural counterpart of the ordinary thread meter's model subtotal. */
export interface DelegatedCapturedModelUsage {
  readonly billedCostUsd?: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly estimatedCacheCreationTokens: number;
  readonly estimatedCacheReadTokens: number;
  readonly estimatedInputTokens?: number;
  readonly estimatedOutputTokens?: number;
  readonly inputTokens: number;
  readonly model: string;
  readonly outputTokens: number;
  readonly provider: string;
  readonly runKind: 'subagent';
}
export interface DelegatedCapturedUsage {
  readonly perModel: readonly DelegatedCapturedModelUsage[];
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
}
export interface DelegatedConversationInsights {
  readonly configuration: unknown;
  readonly depth: number;
  /** Only captured rows with retained exact identity; absence is not zero spending. */
  readonly directUsage: DelegatedCapturedUsage | null;
  /** Latest host-admitted continuation settings; null on legacy/original delegations. */
  readonly latestExecutionConfiguration: unknown | null;
  readonly latestRun: {
    readonly model: string;
    readonly modelSettings: Readonly<Record<string, unknown>> | null;
    readonly provider: string;
    readonly providerOptions: Readonly<Record<string, unknown>> | null;
  } | null;
  /** Inclusive of this conversation; never add it to directUsage. */
  readonly subtreeUsage: DelegatedCapturedUsage | null;
  readonly threadId: string;
}

const INSIGHTS_QUERY = `${AUTHORIZED_DELEGATED_GRAPH}, selected AS (
  SELECT * FROM owned_nodes WHERE thread_id = $3 AND parent_thread_id IS NOT NULL
), subtree AS (
  SELECT thread_id FROM selected
  UNION ALL
  SELECT node.thread_id FROM owned_nodes node JOIN subtree parent ON node.parent_thread_id = parent.thread_id
), attributed AS (
  SELECT usage.*, invocation.thread_id AS invocation_thread_id, continuation.thread_id AS continuation_thread_id
  FROM brainstrike_assistant_run_usage usage
  LEFT JOIN brainstrike_delegated_invocations invocation
    ON invocation.root_thread_id=usage.thread_id AND invocation.owner_resource_id=usage.resource_id
    AND invocation.parent_runtime_run_id=usage.delegation_parent_run_id AND invocation.parent_tool_call_id=usage.delegation_tool_call_id
  LEFT JOIN brainstrike_delegated_continuations continuation
    ON continuation.id=usage.continuation_id AND continuation.root_thread_id=usage.thread_id AND continuation.owner_resource_id=usage.resource_id
  WHERE usage.thread_id=$2 AND usage.resource_id=$1 AND usage.run_kind='subagent'
    AND (invocation.thread_id IN (SELECT thread_id FROM subtree) OR continuation.thread_id IN (SELECT thread_id FROM subtree))
)
SELECT selected.thread_id, selected.configuration, selected.delegation_depth,
  (SELECT continuation.execution_configuration FROM brainstrike_delegated_continuations continuation
    WHERE continuation.thread_id=selected.thread_id AND continuation.owner_resource_id=$1 AND continuation.root_thread_id=$2
    ORDER BY continuation.created_at DESC, continuation.id DESC LIMIT 1) AS execution_configuration,
  (SELECT jsonb_build_object('model', model, 'provider', provider, 'modelSettings', model_settings, 'providerOptions', provider_options)
   FROM brainstrike_assistant_thread_runs run WHERE run.thread_id=selected.thread_id AND run.resource_id=selected.resource_id
   ORDER BY run.started_at DESC, run.created_at DESC, run.id DESC LIMIT 1) AS latest_run,
  COALESCE((SELECT jsonb_agg(to_jsonb(attributed) ORDER BY id) FROM attributed), '[]'::jsonb) AS usage
FROM selected`;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored child usage is malformed.');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Stored child usage identity is malformed.');
  }
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Stored child token usage is invalid.');
  }
  return value;
}
function modelUsage(row: Record<string, unknown>): DelegatedCapturedModelUsage {
  const billed = row['billed_cost_usd'];
  if (billed !== null && (typeof billed !== 'number' || !Number.isFinite(billed) || billed < 0)) {
    throw new Error('Stored child cost is invalid.');
  }
  return {
    ...(typeof billed === 'number'
      ? { billedCostUsd: billed, estimatedInputTokens: 0, estimatedOutputTokens: 0 }
      : {}),
    cacheCreationTokens: count(row['cache_creation_input_tokens'] ?? 0),
    cacheReadTokens: count(row['cache_read_input_tokens'] ?? 0),
    estimatedCacheCreationTokens:
      typeof billed === 'number' ? 0 : count(row['cache_creation_input_tokens'] ?? 0),
    estimatedCacheReadTokens:
      typeof billed === 'number' ? 0 : count(row['cache_read_input_tokens'] ?? 0),
    inputTokens: count(row['input_tokens']),
    model: text(row['model']),
    outputTokens: count(row['output_tokens']),
    provider: text(row['provider']),
    runKind: 'subagent',
  };
}
function totals(perModel: readonly DelegatedCapturedModelUsage[]): DelegatedCapturedUsage | null {
  if (perModel.length === 0) {
    return null;
  }
  return {
    perModel,
    totalInputTokens: count(perModel.reduce((sum, row) => sum + row.inputTokens, 0)),
    totalOutputTokens: count(perModel.reduce((sum, row) => sum + row.outputTokens, 0)),
  };
}

/** One authorized read; run/continuation writers and the ordinary root rollup remain unchanged. */
export async function readDelegatedConversationInsights(
  database: DelegatedConversationDatabase,
  scope: DelegatedConversationScope,
  threadId: string
): Promise<DelegatedConversationInsights> {
  const result = await database.query(INSIGHTS_QUERY, [
    text(scope.ownerResourceId),
    text(scope.rootThreadId),
    text(threadId),
  ]);
  if (result.rows.length !== 1) {
    throw new DelegatedConversationIdentityError();
  }
  const selected = record(result.rows[0]);
  if (!Array.isArray(selected['usage'])) {
    throw new Error('Stored child usage is malformed.');
  }
  const direct: DelegatedCapturedModelUsage[] = [];
  const inclusive: DelegatedCapturedModelUsage[] = [];
  for (const value of selected['usage']) {
    const row = record(value);
    const invocation = row['invocation_thread_id'];
    const continuation = row['continuation_thread_id'];
    if (invocation !== null && continuation !== null) {
      throw new Error('Stored child usage has conflicting execution owners.');
    }
    const owner = text(invocation ?? continuation);
    const parsed = modelUsage(row);
    inclusive.push(parsed);
    if (owner === threadId) {
      direct.push(parsed);
    }
  }
  const latest = selected['latest_run'] === null ? null : record(selected['latest_run']);
  return {
    configuration: selected['configuration'],
    depth: count(selected['delegation_depth']),
    directUsage: totals(direct),
    latestExecutionConfiguration: selected['execution_configuration'] ?? null,
    latestRun: latest
      ? {
          model: text(latest['model']),
          modelSettings: latest['modelSettings'] === null ? null : record(latest['modelSettings']),
          provider: text(latest['provider']),
          providerOptions:
            latest['providerOptions'] === null ? null : record(latest['providerOptions']),
        }
      : null,
    subtreeUsage: totals(inclusive),
    threadId: text(selected['thread_id']),
  };
}
