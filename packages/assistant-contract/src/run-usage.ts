/**
 * Run-usage attribution contract (BST-953).
 *
 * Every durable `brainstrike_assistant_run_usage` row is tagged with the KIND
 * of model call that produced it, so the thread-total meter can break spend
 * down by source. Parent chat rows are written by the renderer at message
 * finish (the `handleUsage` tap); child rows ('subagent', 'om-observation',
 * 'om-reflection') are written by the desktop server when a
 * `child-run-usage` StreamChunk crosses the run-event observer, then
 * forwarded to the renderer as a TRANSIENT `brainstrike.child-run-usage`
 * aui-data part (display refresh only — the renderer never writes child rows,
 * so the two writers can never double-count).
 *
 * TOKEN PROVENANCE HONESTY: subagent and compaction-summary figures are
 * provider-exact aggregate usage from their Mastra calls; OM figures are LOCAL
 * ESTIMATES (Mastra sizes observer input/output with tokenx, excluding the
 * observer's own system prompt) — `estimated` carries that distinction and the
 * UI must label OM rows as estimates, never present them as billed truth.
 */
export const ASSISTANT_RUN_USAGE_KINDS = [
  'chat',
  'subagent',
  'compaction-summary',
  'om-observation',
  'om-reflection',
] as const;

export type AssistantRunUsageKind = (typeof ASSISTANT_RUN_USAGE_KINDS)[number];

/** Child (non-'chat') usage sources — the kinds a `child-run-usage` chunk may carry. */
export type AssistantChildRunUsageSource = Exclude<AssistantRunUsageKind, 'chat'>;

export const CHILD_RUN_USAGE_DATA_NAME = 'brainstrike.child-run-usage';

/** Native completion identity; ownership is resolved independently by the host. */
export interface AssistantDelegatedUsageIdentity {
  readonly parentRuntimeRunId: string;
  readonly parentToolCallId: string;
  readonly resourceId: string;
  readonly threadId: string;
}

export interface AssistantChildRunUsage {
  readonly delegation?: AssistantDelegatedUsageIdentity;
  /**
   * True when the token figures are local estimates (OM cycles), false when
   * they are provider-reported (subagent or compaction-summary aggregate usage).
   */
  readonly estimated: boolean;
  readonly inputTokens: number;
  /**
   * Model/provider that served the child call. ABSENT when the emitter cannot
   * attribute it (the desktop server then attributes OM rows from the run's
   * resolved observer target; an unattributable row is DROPPED VISIBLY via a
   * warn log, never written under a guessed model).
   */
  readonly model?: string;
  readonly outputTokens: number;
  /** Persona id for 'subagent' usage. */
  readonly personaId?: string;
  readonly provider?: string;
  readonly source: AssistantChildRunUsageSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0);
}

export function isAssistantDelegatedUsageIdentity(
  value: unknown
): value is AssistantDelegatedUsageIdentity {
  return (
    isRecord(value) &&
    ['parentRuntimeRunId', 'parentToolCallId', 'resourceId', 'threadId'].every(
      (key) => typeof value[key] === 'string' && value[key].trim().length > 0
    )
  );
}

/** True when the value is a well-formed {@link AssistantChildRunUsage}. */
export function isAssistantChildRunUsage(value: unknown): value is AssistantChildRunUsage {
  return (
    isRecord(value) &&
    (ASSISTANT_RUN_USAGE_KINDS as readonly string[]).includes(String(value['source'])) &&
    value['source'] !== 'chat' &&
    typeof value['estimated'] === 'boolean' &&
    isCount(value['inputTokens']) &&
    isCount(value['outputTokens']) &&
    isOptionalNonEmptyString(value['model']) &&
    isOptionalNonEmptyString(value['provider']) &&
    isOptionalNonEmptyString(value['personaId']) &&
    (value['delegation'] === undefined ||
      (value['source'] === 'subagent' && isAssistantDelegatedUsageIdentity(value['delegation'])))
  );
}
