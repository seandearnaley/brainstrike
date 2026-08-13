import type { AgentMessage, RuntimeData } from '@brainstrike/agent';
import { AgentSqlService } from '@brainstrike/db';
import { createLogger } from '@brainstrike/logging';
import { getDatabase } from '../db-main';
import {
  hashSignalContent,
  type RecordRunTreatment,
  type RunInjectionStatus,
  readExperimentAssignment,
  recordDesktopRunTreatment,
} from './run-treatment-persistence';

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
    (COALESCE(engine IN ('js-walk', 'skipped'), false) OR scan_limited OR candidates_truncated)
      AS substrate_degraded
  FROM brainstrike_tool_call_telemetry
  WHERE occurred_at >= $1::timestamptz
    AND occurred_at <= $2::timestamptz
)
SELECT
  tool_id,
  count(*)::int AS calls,
  sum(model_facing_chars)::float8 AS total_model_facing_chars,
  (count(*) FILTER (WHERE truncated AND NOT substrate_degraded))::float8
    / NULLIF(count(*) FILTER (WHERE NOT substrate_degraded), 0)
    AS truncation_hit_rate,
  (avg(zero_match::int) FILTER (WHERE NOT substrate_degraded))::float8 AS zero_match_rate,
  avg(substrate_degraded::int)::float8 AS substrate_degraded_rate,
  sum(model_facing_chars)::float8
    * (COALESCE((count(*) FILTER (WHERE truncated AND NOT substrate_degraded))::float8
        / NULLIF(count(*) FILTER (WHERE NOT substrate_degraded), 0), 0)
      + COALESCE((avg(zero_match::int) FILTER (WHERE NOT substrate_degraded))::float8, 0))
    AS waste_score
FROM normalized
GROUP BY tool_id
ORDER BY waste_score DESC, substrate_degraded_rate DESC, tool_id
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
  readonly recordTreatment?: RecordRunTreatment;
  readonly runSignalQuery?: (sql: string, params: readonly unknown[]) => Promise<SignalQueryResult>;
}

interface SignalRow {
  readonly calls: number;
  readonly substrateDegradedRate: number;
  readonly toolId: string;
  /** NULL when every call was substrate-degraded (no model-controllable denominator). */
  readonly truncationHitRate: number | null;
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
    !(truncationHitRate === null || isFiniteNumber(truncationHitRate)) ||
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
    // BST-1247 review: a degraded-only tool (zero model-controllable waste)
    // renders as a pure environment line — before this, waste_score = 0
    // filtered it out entirely and the model never learned its search
    // substrate was degraded (the exact BST-1246 situation).
    if (row.wasteScore <= 0) {
      return `- ${sanitizeSignalToolId(row.toolId)}: ${row.calls} calls, ${Math.round(row.substrateDegradedRate * 100)}% substrate-degraded (environment; not your behavior)`;
    }
    const truncationClause =
      row.truncationHitRate === null
        ? ''
        : `, ${Math.round(row.truncationHitRate * 100)}% truncated`;
    const zeroMatchClause =
      row.zeroMatchRate === null ? '' : `, ${Math.round(row.zeroMatchRate * 100)}% zero-match`;
    // Substrate degradation is environment information, not a model behavior
    // signal — rendered separately so the model neither ignores a degraded
    // search substrate nor tries to "fix" it by changing behavior.
    const substrateClause =
      row.substrateDegradedRate > 0
        ? `, ${Math.round(row.substrateDegradedRate * 100)}% substrate-degraded`
        : '';
    return `- ${sanitizeSignalToolId(row.toolId)}: ${row.calls} calls${truncationClause}${zeroMatchClause}${substrateClause}`;
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
    // Positive-waste rows rank; degraded-only rows (waste 0, substrate > 0)
    // are kept as environment signal (BST-1247 review — filtering them hid
    // exactly the substrate failure the legend describes).
    if (parsed.wasteScore > 0 || parsed.substrateDegradedRate > 0) {
      collected.push(parsed);
    }
  }
  signalMemo = { hourKey, rows: collected };
  return collected;
}

interface ResolvedSignalContent {
  readonly hourKey?: number;
  readonly status: Extract<RunInjectionStatus, 'injected' | 'no_waste' | 'query_failed'>;
  readonly text?: string;
}

/**
 * BST-1250: persist the per-run treatment record from the ONE seam that knows
 * whether injection actually happened and what exact text was injected. Runs
 * without a runId (older callers, ad-hoc invocations) are skipped at debug.
 * Callers fire this DETACHED (`void`) — the write must never block prompt
 * assembly on the single-connection PGlite (review), and the recorder logs
 * its own failures.
 */
async function recordTreatmentForRun(
  runtimeData: RuntimeData | undefined,
  resolved: { status: RunInjectionStatus; text?: string },
  deps: SelfImprovementSignalContextDeps
): Promise<void> {
  const memory = runtimeData?.memory;
  const runId = memory?.runId;
  if (!(memory && typeof runId === 'string' && runId.length > 0)) {
    logger.debug('self_improvement_treatment_skipped_no_run_id');
    return;
  }
  const assignment = readExperimentAssignment(runtimeData);
  const recordTreatment = deps.recordTreatment ?? recordDesktopRunTreatment;
  await recordTreatment({
    experimentId: assignment.experimentId,
    injectionStatus: resolved.status,
    resourceId: memory.resourceId,
    runId,
    signalContentHash: resolved.text === undefined ? null : hashSignalContent(resolved.text),
    threadId: memory.threadId,
    variant: assignment.variant,
  });
}

/**
 * Prepend one telemetry-derived system message for opted-in hosted-provider
 * runs. Every no-op returns the original message array identity. Hosted runs
 * ALWAYS record a treatment row (BST-1250) with the injection STATUS —
 * preference-off, no-waste, and query-failed are distinct states (an enrolled
 * run whose signal query failed is NOT control evidence); only local-provider
 * runs skip entirely (outside the experiment surface, like injection itself).
 */
export async function injectSelfImprovementSignalContext(
  messages: AgentMessage[],
  runtimeData: RuntimeData | undefined,
  deps: SelfImprovementSignalContextDeps = {}
): Promise<AgentMessage[]> {
  if (isLocalProvider(runtimeData)) {
    return messages;
  }
  const resolved: ResolvedSignalContent | { status: 'preference_off' } =
    readSelfImprovementSignalPreference(runtimeData).enabled
      ? await resolveSignalContent(deps)
      : { status: 'preference_off' };
  // Detached on purpose: the treatment write is evidence bookkeeping, not a
  // prompt dependency, and it must not add a serialized DB round-trip to
  // every hosted run's latency path (the recorder logs its own failures).
  void recordTreatmentForRun(runtimeData, resolved, deps);
  if (!('text' in resolved) || resolved.text === undefined) {
    return messages;
  }
  const contextMessage: AgentMessage = {
    id: `self-improvement-signal-${resolved.hourKey}`,
    parts: [{ text: resolved.text, type: 'text' }],
    role: 'system',
  };
  return [contextMessage, ...messages];
}

/**
 * Resolve the hour's injected signal text, distinguishing the three
 * non-injection outcomes the treatment record must keep apart (review):
 * a failed/malformed lens query is NOT the same evidence as a no-waste hour.
 */
async function resolveSignalContent(
  deps: SelfImprovementSignalContextDeps
): Promise<ResolvedSignalContent> {
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
    return { status: 'query_failed' };
  }
  if (parsedRows.length === 0) {
    logger.debug('self_improvement_signal_no_positive_waste');
    return { status: 'no_waste' };
  }
  return { hourKey, status: 'injected', text: buildSignalContent(parsedRows) };
}
