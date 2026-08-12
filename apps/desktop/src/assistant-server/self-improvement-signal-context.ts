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
    zero_match,
    (engine IS NOT DISTINCT FROM 'js-walk' OR scan_limited OR candidates_truncated)
      AS substrate_degraded
  FROM brainstrike_tool_call_telemetry
  WHERE occurred_at >= $1::timestamptz
    AND occurred_at <= $2::timestamptz
)
SELECT
  tool_id,
  count(*)::int AS calls,
  sum(model_facing_chars)::float8 AS total_model_facing_chars,
  (count(*) FILTER (WHERE truncated AND NOT substrate_degraded))::float8 / count(*)
    AS truncation_hit_rate,
  (avg(zero_match::int) FILTER (WHERE NOT substrate_degraded))::float8 AS zero_match_rate,
  avg(substrate_degraded::int)::float8 AS substrate_degraded_rate,
  sum(model_facing_chars)::float8
    * ((count(*) FILTER (WHERE truncated AND NOT substrate_degraded))::float8 / count(*)
      + COALESCE((avg(zero_match::int) FILTER (WHERE NOT substrate_degraded))::float8, 0))
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
  'substrate_degraded_rate',
  'waste_score',
] as const;

const HOUR_MS = 60 * 60 * 1000;
const SIGNAL_WINDOW_MS = 24 * HOUR_MS;
const SIGNAL_TOP_N = 5;

/**
 * tool_id is persisted VERBATIM from the original tool name — MCP servers
 * choose arbitrary strings, so telemetry data (unlike the app-owned SQL) is an
 * untrusted channel into this system message. Rendering restricts each id to a
 * bounded identifier charset so a hostile name can neither smuggle
 * newline/instruction-shaped text nor inflate the prompt.
 */
const SIGNAL_TOOL_ID_DISALLOWED = /[^A-Za-z0-9_.:-]/g;
const MAX_SIGNAL_TOOL_ID_CHARS = 40;

function sanitizeSignalToolId(toolId: string): string {
  const cleaned = toolId.replace(SIGNAL_TOOL_ID_DISALLOWED, '_');
  if (cleaned.length <= MAX_SIGNAL_TOOL_ID_CHARS) {
    return cleaned;
  }
  return `${cleaned.slice(0, MAX_SIGNAL_TOOL_ID_CHARS - 1)}…`;
}

/**
 * Hour-keyed memo of the parsed positive-waste rows. Two reasons, both from
 * review:
 * - The sandboxed query is two blocking round-trips (EXPLAIN admit + execute)
 *   on the single-connection PGlite where `statement_timeout` is inert; running
 *   it once per hour keeps it off the per-run latency path.
 * - The rendered block sits AHEAD of the whole conversation, so any per-run
 *   variation invalidates the provider's cached prompt prefix (BST-587). The
 *   window anchors to the top of the hour and the memo pins the rows, so the
 *   injected text is byte-stable within an hour and the prefix is invalidated
 *   at most hourly.
 */
let signalMemo: { readonly hourKey: number; readonly rows: readonly SignalRow[] } | null = null;

export function resetSelfImprovementSignalMemoForTests(): void {
  signalMemo = null;
}

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
  readonly substrateDegradedRate: number;
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
  const substrateDegradedRate = row[5];
  const wasteScore = row[6];
  if (
    typeof toolId !== 'string' ||
    !isFiniteNumber(calls) ||
    !isFiniteNumber(totalModelFacingChars) ||
    !isFiniteNumber(truncationHitRate) ||
    !(zeroMatchRate === null || isFiniteNumber(zeroMatchRate)) ||
    !isFiniteNumber(substrateDegradedRate) ||
    !isFiniteNumber(wasteScore)
  ) {
    return null;
  }
  return { calls, substrateDegradedRate, toolId, truncationHitRate, wasteScore, zeroMatchRate };
}

function buildSignalContent(rows: readonly SignalRow[]): string {
  const lines = rows.map((row) => {
    const zeroMatchClause =
      row.zeroMatchRate === null ? '' : `, ${Math.round(row.zeroMatchRate * 100)}% zero-match`;
    // BST-1247: substrate degradation is environment information, not a model
    // behavior signal — rendered separately so the model neither ignores a
    // degraded search substrate nor tries to "fix" it by changing behavior.
    const substrateClause =
      row.substrateDegradedRate > 0
        ? `, ${Math.round(row.substrateDegradedRate * 100)}% substrate-degraded`
        : '';
    return `- ${sanitizeSignalToolId(row.toolId)}: ${row.calls} calls, ${Math.round(row.truncationHitRate * 100)}% truncated${zeroMatchClause}${substrateClause}`;
  });
  return [
    '## Self-assessment signal (agent tool telemetry, last 24h)',
    'Top tool waste, ranked (truncation = output cut to budget; zero-match = call found nothing;',
    'substrate-degraded = the search engine degraded — an environment condition, not your behavior):',
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
 * Query, validate, and memoize the hour's signal rows. Returns null on any
 * failure (already logged) — failures are NOT memoized, so the next run
 * retries instead of pinning a silent hour-long gap; an EMPTY result IS
 * memoized so a no-waste hour cannot re-query per run.
 */
async function loadAndMemoizeSignalRows(
  hourKey: number,
  until: Date,
  deps: SelfImprovementSignalContextDeps
): Promise<readonly SignalRow[] | null> {
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
    return null;
  }

  if (!columnsMatchExpected(result.columns)) {
    logger.warn('self_improvement_signal_unexpected_columns', {
      columns: result.columns,
      expected: EXPECTED_COLUMNS,
    });
    return null;
  }

  const collected: SignalRow[] = [];
  for (const row of result.rows) {
    const parsed = readSignalRow(row);
    if (!parsed) {
      logger.warn('self_improvement_signal_malformed_row');
      return null;
    }
    if (parsed.wasteScore > 0) {
      collected.push(parsed);
    }
  }
  signalMemo = { hourKey, rows: collected };
  return collected;
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
  // Anchor the window to the top of the hour: consecutive runs inside one hour
  // render byte-identical text (prefix-cache stability) and share the memo.
  const until = new Date(Math.floor(now().getTime() / HOUR_MS) * HOUR_MS);
  const hourKey = until.getTime();

  const parsedRows =
    signalMemo && signalMemo.hourKey === hourKey
      ? signalMemo.rows
      : await loadAndMemoizeSignalRows(hourKey, until, deps);
  if (parsedRows === null) {
    return messages;
  }

  if (parsedRows.length === 0) {
    logger.debug('self_improvement_signal_no_positive_waste');
    return messages;
  }

  const contextMessage: AgentMessage = {
    id: `self-improvement-signal-${hourKey}`,
    parts: [{ text: buildSignalContent(parsedRows), type: 'text' }],
    role: 'system',
  };
  return [contextMessage, ...messages];
}
