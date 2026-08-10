import type { AgentMessage, RuntimeData } from '@brainstrike/agent';
import { AgentSqlService } from '@brainstrike/db';
import { createLogger } from '@brainstrike/logging';
import { getDatabase } from '../db-main';

const logger = createLogger('AssistantSelfImprovementSignal');

/**
 * App-owned copy of the shipped self-improvement-signal lens SQL body.
 *
 * Never execute a workspace-scanned lens for automatic context injection: a
 * mounted repository could shadow the filename and feed attacker-shaped text
 * into the prompt. The parity test pins this byte-for-byte to the shipped lens.
 */
export const SELF_IMPROVEMENT_SIGNAL_SQL = `WITH normalized AS (
  SELECT
    CASE
      WHEN tool_id LIKE 'brainstrike.%' THEN substr(tool_id, 13)
      ELSE tool_id
    END AS tool_id,
    model_facing_chars,
    truncated,
    zero_match
  FROM brainstrike_tool_call_telemetry
  WHERE occurred_at >= $1::timestamptz
    AND occurred_at <= $2::timestamptz
)
SELECT
  tool_id,
  count(*)::int AS calls,
  sum(model_facing_chars)::float8 AS total_model_facing_chars,
  sum(truncated::int)::float8 / count(*) AS truncation_hit_rate,
  avg(zero_match::int)::float8 AS zero_match_rate,
  sum(model_facing_chars)::float8
    * (sum(truncated::int)::float8 / count(*) + COALESCE(avg(zero_match::int)::float8, 0))
    AS waste_score
FROM normalized
GROUP BY tool_id
ORDER BY waste_score DESC, tool_id
LIMIT $3;`;

const EXPECTED_COLUMNS = [
  'tool_id',
  'calls',
  'total_model_facing_chars',
  'truncation_hit_rate',
  'zero_match_rate',
  'waste_score',
] as const;

const SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const SIGNAL_TOP_N = 5;

interface NormalizedSelfImprovementSignalPreference {
  readonly enabled: boolean;
}

/**
 * Strictly parse the renderer preference. Unlike workspace instructions, whose
 * malformed-input fail-safe is ON, this opt-in feature fails safe to OFF.
 */
export function readSelfImprovementSignalPreference(
  runtimeData: RuntimeData | undefined
): NormalizedSelfImprovementSignalPreference {
  const raw: unknown = runtimeData?.selfImprovementSignalPreference;
  if (raw === undefined) {
    return { enabled: false };
  }
  if (raw === null || typeof raw !== 'object') {
    logger.warn('Ignoring malformed selfImprovementSignalPreference (not an object)', {
      received: raw === null ? 'null' : typeof raw,
    });
    return { enabled: false };
  }

  const enabled = (raw as Record<string, unknown>)['enabled'];
  if (enabled === undefined) {
    return { enabled: false };
  }
  if (typeof enabled !== 'boolean') {
    logger.warn('Ignoring malformed selfImprovementSignalPreference.enabled; defaulting OFF', {
      received: typeof enabled,
    });
    return { enabled: false };
  }
  return { enabled };
}

function isLocalProvider(runtimeData: RuntimeData | undefined): boolean {
  const provider = typeof runtimeData?.provider === 'string' ? runtimeData.provider.trim() : '';
  return provider.toLowerCase() === 'local';
}

interface SignalQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}

export interface SelfImprovementSignalContextDeps {
  readonly now?: () => Date;
  readonly runSignalQuery?: (sql: string, params: readonly unknown[]) => Promise<SignalQueryResult>;
}

interface SignalRow {
  readonly calls: number;
  readonly toolId: string;
  readonly truncationHitRate: number;
  readonly wasteScore: number;
  readonly zeroMatchRate: number | null;
}

function columnsMatchExpected(columns: readonly string[]): boolean {
  return (
    columns.length === EXPECTED_COLUMNS.length &&
    columns.every((column, index) => column === EXPECTED_COLUMNS[index])
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readSignalRow(row: readonly unknown[]): SignalRow | null {
  const toolId = row[0];
  const calls = row[1];
  const totalModelFacingChars = row[2];
  const truncationHitRate = row[3];
  const zeroMatchRate = row[4];
  const wasteScore = row[5];
  if (
    typeof toolId !== 'string' ||
    !isFiniteNumber(calls) ||
    !isFiniteNumber(totalModelFacingChars) ||
    !isFiniteNumber(truncationHitRate) ||
    !(zeroMatchRate === null || isFiniteNumber(zeroMatchRate)) ||
    !isFiniteNumber(wasteScore)
  ) {
    return null;
  }
  return { calls, toolId, truncationHitRate, wasteScore, zeroMatchRate };
}

function buildSignalContent(rows: readonly SignalRow[]): string {
  const lines = rows.map((row) => {
    const zeroMatchClause =
      row.zeroMatchRate === null ? '' : `, ${Math.round(row.zeroMatchRate * 100)}% zero-match`;
    return `- ${row.toolId}: ${row.calls} calls, ${Math.round(row.truncationHitRate * 100)}% truncated${zeroMatchClause}`;
  });
  return [
    '## Self-assessment signal (agent tool telemetry, last 24h)',
    'Top tool waste, ranked (truncation = output cut to budget; zero-match = call found nothing):',
    ...lines,
    'Adapt: scope searches (filePaths/narrower patterns) and read selectively to reduce this waste.',
  ].join('\n');
}

async function runProductionSignalQuery(
  sql: string,
  params: readonly unknown[]
): Promise<SignalQueryResult> {
  const db = await getDatabase();
  return await new AgentSqlService(db).query(sql, { maxRows: SIGNAL_TOP_N, params });
}

/**
 * Prepend one telemetry-derived system message for opted-in hosted-provider
 * runs. Every no-op returns the original message array identity.
 */
export async function injectSelfImprovementSignalContext(
  messages: AgentMessage[],
  runtimeData: RuntimeData | undefined,
  deps: SelfImprovementSignalContextDeps = {}
): Promise<AgentMessage[]> {
  if (!readSelfImprovementSignalPreference(runtimeData).enabled || isLocalProvider(runtimeData)) {
    return messages;
  }

  const now = deps.now ?? (() => new Date());
  const until = now();
  const since = new Date(until.getTime() - SIGNAL_WINDOW_MS);
  const params = [since.toISOString(), until.toISOString(), SIGNAL_TOP_N] as const;
  const runSignalQuery = deps.runSignalQuery ?? runProductionSignalQuery;

  let result: SignalQueryResult;
  try {
    result = await runSignalQuery(SELF_IMPROVEMENT_SIGNAL_SQL, params);
  } catch (error) {
    logger.warn('self_improvement_signal_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return messages;
  }

  if (!columnsMatchExpected(result.columns)) {
    logger.warn('self_improvement_signal_unexpected_columns', {
      columns: result.columns,
      expected: EXPECTED_COLUMNS,
    });
    return messages;
  }

  const parsedRows: SignalRow[] = [];
  for (const row of result.rows) {
    const parsed = readSignalRow(row);
    if (!parsed) {
      logger.warn('self_improvement_signal_malformed_row');
      return messages;
    }
    if (parsed.wasteScore > 0) {
      parsedRows.push(parsed);
    }
  }

  if (parsedRows.length === 0) {
    logger.debug('self_improvement_signal_no_positive_waste');
    return messages;
  }

  const contextMessage: AgentMessage = {
    id: `self-improvement-signal-${until.getTime()}`,
    parts: [{ text: buildSignalContent(parsedRows), type: 'text' }],
    role: 'system',
  };
  return [contextMessage, ...messages];
}
