import {
  AssistantRunErrorRepository,
  type DiagnosticEventsDatabase,
  DiagnosticEventsRepository,
} from '@brainstrike/db';
import { redactSensitiveLogValue } from '@brainstrike/logging';
import type { DiagnosticEvent } from '@brainstrike/utils/diagnostics';
import { getDiagnosticSessionId } from './diagnostic-sink-session';
import { scrubLikelySecretValues } from './secret-scrub';

/**
 * Thread debug-bundle collector + formatter (design §5.2, "Flight Recorder").
 *
 * `collectThreadDebugBundleData` joins the run/event/usage tables owned by
 * `assistant-memory-repository.ts`, the Mastra transcript, and correlated
 * `brainstrike_diagnostic_events` rows into one `ThreadDebugBundleData`
 * object. `formatThreadDebugBundle` is a PURE function (no I/O, no
 * `Date.now()` — the timestamp travels in via `data.environment.generatedAt`)
 * that renders that object into a bounded, redacted Markdown document
 * optimized for pasting into an LLM. `buildThreadDebugBundle` is the
 * collect-then-format convenience wrapper Task 9's Copy button calls.
 */

export const DEBUG_BUNDLE_FORMAT_VERSION = 2;
export const DEBUG_BUNDLE_DEFAULT_MAX_BYTES = 200_000;

const CORRELATION_WINDOW_MS = 5 * 60 * 1000;
const PRIOR_FAILURE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DIAGNOSTIC_EVENTS_CAP = 100;
const TOOL_RESULT_PREVIEW_CHARS = 200;
const PROTECTED_WINDOW_RADIUS = 2;

/** Structurally identical to `DiagnosticEventsDatabase` — re-exported under
 * the collector's own name per the brief's consumed-interface contract. */
export type DebugBundleDatabase = DiagnosticEventsDatabase;
export type DebugBundleDiagnosticsReader = Pick<
  DiagnosticEventsRepository,
  'queryEvents' | 'countByFingerprint'
>;

export interface ThreadDebugBundleData {
  readonly diagnosticEvents: readonly DiagnosticEvent[]; // run/thread-correlated ±5min
  readonly environment: {
    readonly appVersion: string;
    readonly generatedAt: string; // ISO
    readonly platform: string;
    readonly sessionId: string;
  };
  readonly messages: readonly {
    readonly content: unknown;
    readonly createdAt: string;
    readonly id: string;
    readonly role: string;
  }[];
  readonly priorFailures: {
    readonly count: number;
    readonly firstSeenMs: number | null;
    readonly lastSeenMs: number | null;
  } | null;
  readonly run: {
    readonly completedAt: string | null;
    readonly error: string | null;
    readonly id: string;
    readonly model: string;
    readonly modelSettings: unknown;
    readonly provider: string;
    readonly providerOptions: unknown;
    readonly runtimeKind: string | null;
    readonly startedAt: string | null;
    readonly status: string;
  } | null;
  readonly runError: {
    readonly causeChain: unknown;
    readonly code: string;
    readonly httpStatus: number | null;
    readonly message: string | null;
    readonly occurredAt: string;
    readonly providerRequestId: string | null;
    readonly responseHeaders: unknown;
  } | null;
  readonly runEvents: readonly {
    readonly detail: string | null;
    readonly durationMs: number | null;
    readonly kind: string;
    readonly label: string | null;
    readonly metadata: unknown;
    readonly occurredAt: string;
    readonly sequence: number;
    readonly status: string | null;
  }[];
  readonly threadId: string;
  readonly usage: readonly {
    readonly billedCostUsd: string | null;
    readonly inputTokens: number;
    readonly model: string;
    readonly outputTokens: number;
    readonly provider: string;
  }[];
}

export interface CollectThreadDebugBundleInput {
  readonly runId?: string;
  readonly threadId: string;
}

export interface FormatThreadDebugBundleOptions {
  readonly maxBytes?: number;
}

type BundleMessage = ThreadDebugBundleData['messages'][number];
type BundleRunEvent = ThreadDebugBundleData['runEvents'][number];

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

// Row interfaces mirror the brief's verbatim SQL column names (snake_case,
// unaliased) — each field is immediately mapped to a camelCase
// ThreadDebugBundleData property below, so the snake_case never escapes this
// module.
interface RunRow {
  // biome-ignore lint/style/useNamingConvention: brainstrike_assistant_thread_runs column name.
  completed_at: string | Date | null;
  error: string | null;
  id: string;
  model: string;
  // biome-ignore lint/style/useNamingConvention: brainstrike_assistant_thread_runs column name.
  model_settings: unknown;
  provider: string;
  // biome-ignore lint/style/useNamingConvention: brainstrike_assistant_thread_runs column name.
  provider_options: unknown;
  // biome-ignore lint/style/useNamingConvention: brainstrike_assistant_thread_runs column name.
  runtime_kind: string | null;
  // biome-ignore lint/style/useNamingConvention: brainstrike_assistant_thread_runs column name.
  started_at: string | Date | null;
  status: string;
}

interface RunEventRow {
  detail: string | null;
  // biome-ignore lint/style/useNamingConvention: brainstrike_assistant_run_events column name.
  duration_ms: number | null;
  kind: string;
  label: string | null;
  metadata: unknown;
  // biome-ignore lint/style/useNamingConvention: brainstrike_assistant_run_events column name.
  occurred_at: string | Date;
  sequence: number;
  status: string | null;
}

interface RunUsageRow {
  // biome-ignore lint/style/useNamingConvention: brainstrike_assistant_run_usage column name.
  billed_cost_usd: string | null;
  // biome-ignore lint/style/useNamingConvention: brainstrike_assistant_run_usage column name.
  input_tokens: number;
  model: string;
  // biome-ignore lint/style/useNamingConvention: brainstrike_assistant_run_usage column name.
  output_tokens: number;
  provider: string;
}

interface MessageRow {
  content: unknown;
  createdAt: string | Date;
  id: string;
  role: string;
}

function mapMessageRow(value: unknown): MessageRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Debug bundle message row must be an object.');
  }
  return value as MessageRow;
}

function mapRunEventRow(value: unknown): RunEventRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Debug bundle run event row must be an object.');
  }
  return value as RunEventRow;
}

function mapRunRow(value: unknown): RunRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Debug bundle run row must be an object.');
  }
  return value as RunRow;
}

function mapRunUsageRow(value: unknown): RunUsageRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Debug bundle run usage row must be an object.');
  }
  return value as RunUsageRow;
}

function toIsoOrNull(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function readAppVersion(): string {
  const env = (import.meta as { env?: Record<string, unknown> }).env;
  return typeof env?.['VITE_APP_VERSION'] === 'string'
    ? (env['VITE_APP_VERSION'] as string)
    : 'dev';
}

function readPlatform(): string {
  return typeof navigator !== 'undefined' && navigator.platform ? navigator.platform : 'unknown';
}

function dedupeById(events: readonly DiagnosticEvent[]): DiagnosticEvent[] {
  const seen = new Set<string>();
  const deduped: DiagnosticEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) {
      continue;
    }
    seen.add(event.id);
    deduped.push(event);
  }
  return deduped;
}

function mapRun(value: unknown): ThreadDebugBundleData['run'] {
  if (value === undefined) {
    return null;
  }
  const row = mapRunRow(value);
  return {
    completedAt: toIsoOrNull(row.completed_at),
    error: row.error,
    id: row.id,
    model: row.model,
    modelSettings: row.model_settings,
    provider: row.provider,
    providerOptions: row.provider_options,
    runtimeKind: row.runtime_kind,
    startedAt: toIsoOrNull(row.started_at),
    status: row.status,
  };
}

/** Joins run/event/usage/transcript/diagnostic data for one thread (and
 * optionally one run) into the bundle shape the formatter renders. When
 * `runId` is omitted the SQL itself picks the thread's latest failed run,
 * falling back to the latest run of any status (`ORDER BY (status = 'failed')
 * DESC, created_at DESC LIMIT 1`) — this function trusts that ordering and
 * never re-sorts rows in JS. */
export async function collectThreadDebugBundleData(
  db: DebugBundleDatabase,
  input: CollectThreadDebugBundleInput
): Promise<ThreadDebugBundleData> {
  const { threadId } = input;
  const runId = input.runId ?? null;

  const runResult = await db.query(
    `SELECT id, provider, model, model_settings, provider_options, runtime_kind,
            status, error, started_at, completed_at
     FROM brainstrike_assistant_thread_runs
     WHERE thread_id = $1 AND ($2::text IS NULL OR id = $2)
     ORDER BY (status = 'failed') DESC, created_at DESC
     LIMIT 1`,
    [threadId, runId]
  );
  const run = mapRun(runResult.rows[0]);

  const runErrorRepository = new AssistantRunErrorRepository(db);
  const [eventsResult, usageResult, runErrorRecord] = run
    ? await Promise.all([
        db.query(
          `SELECT sequence, kind, status, label, detail, duration_ms, metadata, occurred_at
           FROM brainstrike_assistant_run_events WHERE run_id = $1 ORDER BY sequence ASC LIMIT 500`,
          [run.id]
        ),
        db.query(
          `SELECT provider, model, input_tokens, output_tokens, billed_cost_usd
           FROM brainstrike_assistant_run_usage WHERE run_id = $1 ORDER BY created_at ASC`,
          [run.id]
        ),
        runErrorRepository.getByRunId(run.id),
      ])
    : [{ rows: [] }, { rows: [] }, null];

  const runEvents: BundleRunEvent[] = eventsResult.rows.map((value) => {
    const row = mapRunEventRow(value);
    return {
      detail: row.detail,
      durationMs: row.duration_ms,
      kind: row.kind,
      label: row.label,
      metadata: row.metadata,
      occurredAt: toIsoOrNull(row.occurred_at) as string,
      sequence: row.sequence,
      status: row.status,
    };
  });

  const usage: ThreadDebugBundleData['usage'] = usageResult.rows.map((value) => {
    const row = mapRunUsageRow(value);
    return {
      billedCostUsd: row.billed_cost_usd,
      inputTokens: row.input_tokens,
      model: row.model,
      outputTokens: row.output_tokens,
      provider: row.provider,
    };
  });
  const runError: ThreadDebugBundleData['runError'] = runErrorRecord
    ? {
        causeChain: runErrorRecord.causeChain,
        code: runErrorRecord.code,
        httpStatus: runErrorRecord.httpStatus,
        message: runErrorRecord.message,
        occurredAt: runErrorRecord.occurredAt.toISOString(),
        providerRequestId: runErrorRecord.providerRequestId,
        responseHeaders: runErrorRecord.responseHeaders,
      }
    : null;

  const transcriptResult = await db.query(
    `SELECT id, role, content, "createdAt" FROM mastra_messages WHERE thread_id = $1 ORDER BY "createdAt" DESC LIMIT 40`,
    [threadId]
  );
  // Query returns newest-first (bounded window); the transcript section
  // reads oldest-first, and stage-1 elision removes the oldest turns first.
  const messages: BundleMessage[] = [...transcriptResult.rows].reverse().map((value) => {
    const row = mapMessageRow(value);
    return {
      content: row.content,
      createdAt: toIsoOrNull(row.createdAt) as string,
      id: row.id,
      role: row.role,
    };
  });

  const { diagnosticEvents, priorFailures } = await collectCorrelatedDiagnostics(
    new DiagnosticEventsRepository(db),
    {
      run,
      threadId,
    }
  );

  return {
    diagnosticEvents,
    environment: readDebugBundleEnvironment(),
    messages,
    priorFailures,
    run,
    runError,
    runEvents,
    threadId,
    usage,
  };
}

/**
 * The renderer's diagnostic events correlated to a thread and its selected
 * run (by run id, thread id and the run's ±5 minute window), and the prior
 * failures sharing the run's newest correlated fingerprint. Shared by every
 * bundle source, whichever owner recorded the run.
 */
export async function collectCorrelatedDiagnostics(
  repository: DebugBundleDiagnosticsReader,
  input: {
    readonly run: Pick<
      NonNullable<ThreadDebugBundleData['run']>,
      'completedAt' | 'id' | 'startedAt'
    > | null;
    readonly threadId: string;
  }
): Promise<Pick<ThreadDebugBundleData, 'diagnosticEvents' | 'priorFailures'>> {
  const { run, threadId } = input;
  const runIdCorrelated = run ? await repository.queryEvents({ runId: run.id }) : [];
  const threadCorrelated = await repository.queryEvents({ threadId });
  const startedAtMs = run?.startedAt ? new Date(run.startedAt).getTime() : null;
  const completedAtMs = run?.completedAt ? new Date(run.completedAt).getTime() : null;
  const windowCorrelated =
    startedAtMs === null
      ? []
      : await repository.queryEvents({
          limit: 50,
          sinceMs: startedAtMs - CORRELATION_WINDOW_MS,
          untilMs: (completedAtMs ?? Date.now()) + CORRELATION_WINDOW_MS,
        });

  const diagnosticEvents = dedupeById([
    ...runIdCorrelated,
    ...threadCorrelated,
    ...windowCorrelated,
  ]).slice(0, DIAGNOSTIC_EVENTS_CAP);

  // Prior-failures fingerprint source: the newest diagnostic event correlated
  // to the SELECTED run (events with runId === run.id), if any; else null.
  const selectedRunEvent = runIdCorrelated[0] ?? null;
  const priorFailures = selectedRunEvent
    ? await repository.countByFingerprint(
        selectedRunEvent.fingerprint,
        Date.now() - PRIOR_FAILURE_LOOKBACK_MS
      )
    : null;
  return { diagnosticEvents, priorFailures };
}

/** The bundle's environment section, stamped when it is collected. */
export function readDebugBundleEnvironment(): ThreadDebugBundleData['environment'] {
  return {
    appVersion: readAppVersion(),
    generatedAt: new Date().toISOString(),
    platform: readPlatform(),
    sessionId: getDiagnosticSessionId(),
  };
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Real persisted parts (see `projectToolInvocationPartForTranscript` in
 * `packages/agent/src/pglite-mastra-memory/memory-store.ts` and
 * `docs/agents/assistant-persistence.md` §1) are shaped
 * `{ type: 'tool-invocation', toolInvocation: { toolCallId, toolName, args,
 * state, result } }` — the result lives NESTED under `toolInvocation`, not at
 * the part's top level. */
function isToolInvocationPart(
  part: unknown
): part is Record<string, unknown> & { toolInvocation: Record<string, unknown> } {
  return isRecord(part) && part['type'] === 'tool-invocation' && isRecord(part['toolInvocation']);
}

function isToolResultPart(part: unknown): part is Record<string, unknown> {
  if (!isRecord(part)) {
    return false;
  }
  if (isToolInvocationPart(part) && 'result' in part['toolInvocation']) {
    return true;
  }
  const type = part['type'];
  if (typeof type === 'string' && type.includes('tool-result')) {
    return true;
  }
  return 'result' in part || 'output' in part;
}

/** Reads the parts array out of a message's `content`, accepting both the
 * legacy bare-array shape (old data / fixtures) and the real persisted
 * Mastra V2 shape `{ format: 2, parts: [...] }` (see
 * `packages/agent/src/pglite-mastra-memory/memory-store.ts` and
 * `docs/agents/assistant-persistence.md` §1). Returns `null` when `content`
 * has no readable parts array at all. Every part-walking branch below
 * (stage-2 detection + elision) goes through this so both shapes are
 * handled identically. */
function readContentParts(content: unknown): unknown[] | null {
  if (Array.isArray(content)) {
    return content;
  }
  if (isRecord(content) && content['format'] === 2 && Array.isArray(content['parts'])) {
    return content['parts'];
  }
  return null;
}

function hasToolResultParts(content: unknown): boolean {
  const parts = readContentParts(content);
  return parts?.some(isToolResultPart) ?? false;
}

function stringifyResultValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value) ?? String(value);
}

/** Stage 2: keeps args/input intact, truncates the result/output body to a
 * visibly-marked preview. Rebuilds whatever shape `content` came in as (bare
 * array, or `{ format: 2, parts: [...] }`) with only the parts replaced. */
function elideToolResultBodies(content: unknown): unknown {
  const parts = readContentParts(content);
  if (parts === null) {
    return content;
  }
  const elidedParts = parts.map((part) => {
    if (!isToolResultPart(part)) {
      return part;
    }
    if (isToolInvocationPart(part) && 'result' in part['toolInvocation']) {
      const invocation = part['toolInvocation'];
      const serialized = stringifyResultValue(invocation['result']);
      const preview = serialized.slice(0, TOOL_RESULT_PREVIEW_CHARS);
      const suffix = serialized.length > TOOL_RESULT_PREVIEW_CHARS ? '…' : '';
      return {
        ...part,
        // toolCallId/toolName/args/state (and any other toolInvocation keys)
        // are preserved verbatim — only `result` is replaced.
        toolInvocation: {
          ...invocation,
          result: `${preview}${suffix} _[tool result elided — ${serialized.length} chars]_`,
        },
      };
    }
    const resultKey = 'result' in part ? 'result' : 'output' in part ? 'output' : null;
    if (!resultKey) {
      return part;
    }
    const serialized = stringifyResultValue(part[resultKey]);
    const preview = serialized.slice(0, TOOL_RESULT_PREVIEW_CHARS);
    const suffix = serialized.length > TOOL_RESULT_PREVIEW_CHARS ? '…' : '';
    return {
      ...part,
      [resultKey]: `${preview}${suffix} _[tool result elided — ${serialized.length} chars]_`,
    };
  });
  if (Array.isArray(content)) {
    return elidedParts;
  }
  // readContentParts only returns non-null for arrays or isRecord(content)
  // with a `parts` array, so this branch is always a record here.
  return { ...(content as Record<string, unknown>), parts: elidedParts };
}

function serializedContentLength(content: unknown): number {
  const serialized = JSON.stringify(content);
  return typeof serialized === 'string' ? serialized.length : String(content).length;
}

/** The protected window: the newest 'assistant' message (else the newest
 * message overall) +- 2 by array position. `messages` is oldest-first. */
function computeProtectedIndices(messages: readonly BundleMessage[]): Set<number> {
  const protectedIndices = new Set<number>();
  if (messages.length === 0) {
    return protectedIndices;
  }
  let anchor = messages.length - 1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') {
      anchor = index;
      break;
    }
  }
  for (let offset = -PROTECTED_WINDOW_RADIUS; offset <= PROTECTED_WINDOW_RADIUS; offset += 1) {
    const index = anchor + offset;
    if (index >= 0 && index < messages.length) {
      protectedIndices.add(index);
    }
  }
  return protectedIndices;
}

interface ElisionState {
  readonly elidedMessageIds: Set<string>;
  readonly elidedRunEventSequences: Set<number>;
  readonly toolResultElidedMessageIds: Set<string>;
}

interface ElisionCounts {
  messages: number;
  runEventMetadata: number;
  toolResults: number;
}

function nextStage1Candidate(
  messages: readonly BundleMessage[],
  protectedIndices: ReadonlySet<number>,
  elided: ReadonlySet<string>
): number | null {
  for (let index = 0; index < messages.length; index += 1) {
    if (protectedIndices.has(index)) {
      continue;
    }
    const message = messages[index];
    if (message && !elided.has(message.id)) {
      return index;
    }
  }
  return null;
}

function nextStage2Candidate(
  messages: readonly BundleMessage[],
  elidedMessageIds: ReadonlySet<string>,
  toolResultElidedMessageIds: ReadonlySet<string>
): number | null {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      !message ||
      elidedMessageIds.has(message.id) ||
      toolResultElidedMessageIds.has(message.id)
    ) {
      continue;
    }
    if (hasToolResultParts(message.content)) {
      return index;
    }
  }
  return null;
}

function nextStage3Candidate(
  runEvents: readonly BundleRunEvent[],
  elided: ReadonlySet<number>
): number | null {
  for (const event of runEvents) {
    if (event.metadata !== null && event.metadata !== undefined && !elided.has(event.sequence)) {
      return event.sequence;
    }
  }
  return null;
}

/** Applies exactly one elision step (stage 1, then 2, then 3), mutating
 * `state` and `counts`. Returns false once no candidate remains in any
 * stage — the caller then accepts whatever size remains (never throws). */
function applyNextElisionStep(
  data: ThreadDebugBundleData,
  protectedIndices: ReadonlySet<number>,
  state: ElisionState,
  counts: ElisionCounts
): boolean {
  const stage1 = nextStage1Candidate(data.messages, protectedIndices, state.elidedMessageIds);
  if (stage1 !== null) {
    const message = data.messages[stage1];
    if (message) {
      state.elidedMessageIds.add(message.id);
      counts.messages += 1;
      return true;
    }
  }
  const stage2 = nextStage2Candidate(
    data.messages,
    state.elidedMessageIds,
    state.toolResultElidedMessageIds
  );
  if (stage2 !== null) {
    const message = data.messages[stage2];
    if (message) {
      state.toolResultElidedMessageIds.add(message.id);
      counts.toolResults += 1;
      return true;
    }
  }
  const stage3 = nextStage3Candidate(data.runEvents, state.elidedRunEventSequences);
  if (stage3 !== null) {
    state.elidedRunEventSequences.add(stage3);
    counts.runEventMetadata += 1;
    return true;
  }
  return false;
}

function renderHeader(data: ThreadDebugBundleData): string {
  return [
    '# BrainStrike Debug Bundle',
    `bundle_format: ${DEBUG_BUNDLE_FORMAT_VERSION}`,
    `generated_at: ${data.environment.generatedAt}`,
    `thread_id: ${data.threadId}`,
    `run_id: ${data.run?.id ?? '(none)'}`,
    `app: ${data.environment.appVersion} · ${data.environment.platform} · session ${data.environment.sessionId}`,
  ].join('\n');
}

function renderFailureSummary(
  run: ThreadDebugBundleData['run'],
  runError: ThreadDebugBundleData['runError']
): string {
  if (!run) {
    return ['## 1. Failure summary', '', '_No failed run found for this thread._'].join('\n');
  }
  const lines = [
    '## 1. Failure summary',
    '',
    `- status: ${run.status}`,
    `- provider: ${run.provider}`,
    `- model: ${run.model}`,
    `- runtime_kind: ${run.runtimeKind ?? '(unknown)'}`,
    `- started_at: ${run.startedAt ?? '(unknown)'}`,
    `- completed_at: ${run.completedAt ?? '(unknown)'}`,
    `- error: ${run.error ?? '(none)'}`,
  ];
  if (!runError) {
    return lines.join('\n');
  }
  lines.push(
    `- code: ${runError.code}`,
    `- http_status: ${runError.httpStatus ?? '(none)'}`,
    `- provider_request_id: ${runError.providerRequestId ?? '(none)'}`,
    `- provider_error_at: ${runError.occurredAt}`,
    '',
    '```json',
    JSON.stringify(
      {
        causeChain: runError.causeChain,
        message: runError.message,
        responseHeaders: runError.responseHeaders,
      },
      null,
      2
    ),
    '```'
  );
  return lines.join('\n');
}

function renderRunConfiguration(run: ThreadDebugBundleData['run']): string {
  if (!run) {
    return [
      '## 2. Run configuration',
      '',
      '_No run configuration available — no run was found for this thread._',
    ].join('\n');
  }
  const payload = {
    modelSettings: run.modelSettings,
    providerOptions: run.providerOptions,
    runtimeKind: run.runtimeKind,
  };
  return ['## 2. Run configuration', '', '```json', JSON.stringify(payload, null, 2), '```'].join(
    '\n'
  );
}

function renderRunTimeline(
  runEvents: readonly BundleRunEvent[],
  elidedSequences: ReadonlySet<number>
): string {
  if (runEvents.length === 0) {
    return ['## 3. Run timeline', '', '_No run events recorded for this run._'].join('\n');
  }
  const blocks = runEvents.map((event) => {
    const header = [
      `### Event ${event.sequence} — ${event.kind} / ${event.status ?? '(no status)'}`,
      `- occurred_at: ${event.occurredAt}`,
      `- label: ${event.label ?? '(none)'}`,
      `- detail: ${event.detail ?? '(none)'}`,
      `- duration_ms: ${event.durationMs ?? '(none)'}`,
    ].join('\n');
    const metadataBlock = elidedSequences.has(event.sequence)
      ? '_[metadata elided]_'
      : ['```json', JSON.stringify(event.metadata ?? null, null, 2), '```'].join('\n');
    return `${header}\n\n${metadataBlock}`;
  });
  return ['## 3. Run timeline', '', blocks.join('\n\n')].join('\n');
}

function renderResilienceHistory(): string {
  return [
    '## 4. Resilience history',
    '',
    '_Retry-attempt history is intentionally absent: the current Mastra error-processor seam has no honest producer for terminal-attempt counts or actual provider-directed wait time._',
  ].join('\n');
}

function renderDiagnosticEvents(events: readonly DiagnosticEvent[]): string {
  if (events.length === 0) {
    return [
      '## 5. Correlated diagnostic events',
      '',
      '_No correlated diagnostic events in the ± 5 minute window._',
    ].join('\n');
  }
  const blocks = events.map((event) => {
    const header = [
      `### Event ${event.id} — ${event.severity} / ${event.source}`,
      `- occurred_at: ${new Date(event.occurredAt).toISOString()}`,
      `- scope: ${event.scope ?? '(none)'}`,
      `- code: ${event.code ?? '(none)'}`,
      `- fingerprint: ${event.fingerprint}`,
      `- message: ${event.message}`,
    ].join('\n');
    const payload = { causeChain: event.causeChain, context: event.context, stack: event.stack };
    return `${header}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  });
  return ['## 5. Correlated diagnostic events', '', blocks.join('\n\n')].join('\n');
}

function renderTranscript(
  messages: readonly BundleMessage[],
  elidedMessageIds: ReadonlySet<string>,
  toolResultElidedMessageIds: ReadonlySet<string>
): string {
  if (messages.length === 0) {
    return ['## 6. Transcript', '', '_No transcript messages available for this thread._'].join(
      '\n'
    );
  }
  const blocks = messages.map((message) => {
    if (elidedMessageIds.has(message.id)) {
      const chars = serializedContentLength(message.content);
      return `_[elided message ${message.id} — ${chars} chars]_`;
    }
    const content = toolResultElidedMessageIds.has(message.id)
      ? elideToolResultBodies(message.content)
      : message.content;
    return [
      `### Message ${message.id} — ${message.role} — ${message.createdAt}`,
      '```json',
      JSON.stringify(content, null, 2) ?? 'null',
      '```',
    ].join('\n');
  });
  return ['## 6. Transcript', '', blocks.join('\n\n')].join('\n');
}

function renderUsage(usage: ThreadDebugBundleData['usage']): string {
  if (usage.length === 0) {
    return ['## 7. Usage & cost', '', '_No usage recorded for this run._'].join('\n');
  }
  return ['## 7. Usage & cost', '', '```json', JSON.stringify(usage, null, 2), '```'].join('\n');
}

function renderEnvironment(environment: ThreadDebugBundleData['environment']): string {
  return [
    '## 8. Environment',
    '',
    '```json',
    JSON.stringify(environment, null, 2),
    '```',
    '',
    `_Extended OS/architecture, DB-diagnostics, and crash-recovery snapshots are not collected by bundle format ${DEBUG_BUNDLE_FORMAT_VERSION}._`,
  ].join('\n');
}

function renderPriorFailures(priorFailures: ThreadDebugBundleData['priorFailures']): string {
  if (!priorFailures) {
    return [
      '## 9. Prior related failures',
      '',
      '_No prior related failures found (or no terminal diagnostic event correlated to this run)._',
    ].join('\n');
  }
  return [
    '## 9. Prior related failures',
    '',
    `- count (last 7 days): ${priorFailures.count}`,
    `- first_seen: ${priorFailures.firstSeenMs === null ? '(unknown)' : new Date(priorFailures.firstSeenMs).toISOString()}`,
    `- last_seen: ${priorFailures.lastSeenMs === null ? '(unknown)' : new Date(priorFailures.lastSeenMs).toISOString()}`,
  ].join('\n');
}

function renderDocument(data: ThreadDebugBundleData, state: ElisionState): string {
  const sections = [
    renderFailureSummary(data.run, data.runError),
    renderRunConfiguration(data.run),
    renderRunTimeline(data.runEvents, state.elidedRunEventSequences),
    renderResilienceHistory(),
    renderDiagnosticEvents(data.diagnosticEvents),
    renderTranscript(data.messages, state.elidedMessageIds, state.toolResultElidedMessageIds),
    renderUsage(data.usage),
    renderEnvironment(data.environment),
    renderPriorFailures(data.priorFailures),
  ];
  return [renderHeader(data), ...sections].join('\n\n');
}

function appendElisionLog(text: string, counts: ElisionCounts, stillOverBudget: boolean): string {
  const hasAnyElision =
    counts.messages > 0 || counts.toolResults > 0 || counts.runEventMetadata > 0;
  if (!hasAnyElision) {
    return text;
  }
  const lines = ['## Elision log', ''];
  if (counts.messages > 0) {
    lines.push(
      `- Elided ${counts.messages} transcript message(s) (stage 1: oldest-first, outside the protected window).`
    );
  }
  if (counts.toolResults > 0) {
    lines.push(
      `- Elided tool-result bodies in ${counts.toolResults} message(s) (stage 2: kept args, first ${TOOL_RESULT_PREVIEW_CHARS} chars of the result).`
    );
  }
  if (counts.runEventMetadata > 0) {
    lines.push(
      `- Elided metadata in ${counts.runEventMetadata} run event(s) (stage 3: kept kind/status/detail).`
    );
  }
  if (stillOverBudget) {
    lines.push(
      '- _Still over the byte budget after exhausting all elision stages; bundle kept as-is._'
    );
  }
  return `${text}\n\n${lines.join('\n')}`;
}

/** Renders the document PLUS the elision-log footer as it would currently
 * appear — the budget loop below measures THIS (not the bare document), since
 * the footer's own bytes count against `maxBytes` too. */
function buildCandidate(
  data: ThreadDebugBundleData,
  state: ElisionState,
  counts: ElisionCounts,
  stillOverBudget: boolean
): string {
  return appendElisionLog(renderDocument(data, state), counts, stillOverBudget);
}

/** Pure: no I/O, no `Date.now()` — `data.environment.generatedAt` is the only
 * source of "now" in the output. Runs a final `redactSensitiveLogValue` pass
 * over the whole data object before rendering (belt-and-braces; sources are
 * already redacted upstream — this pass is KEY-NAME-based, matching
 * `isSensitiveLogKey`: a secret value stored under an innocuous key, e.g.
 * `{ note: 'password is sk-live-123' }`, is not caught), then elides
 * deterministically until the rendered byte size — document AND footer
 * together — is under `maxBytes`, or all elision stages are exhausted (never
 * throws — see `appendElisionLog`).
 *
 * After the budget loop settles (on EITHER exit path — under-budget or
 * elision-exhausted), a value-shape secret scrub (`scrubLikelySecretValues`,
 * key-name-independent) runs over the final rendered string — this is the
 * single place all output flows through, so every return path is covered.
 * The scrub can only shrink-or-hold the document's size (matches are
 * replaced with a shorter placeholder), except for the one summary line it
 * may append — that append never pushes the result back over `maxBytes` in
 * practice since the scrub itself only shrinks the body it's appended to. */
export function formatThreadDebugBundle(
  data: ThreadDebugBundleData,
  options?: FormatThreadDebugBundleOptions
): string {
  const maxBytes = options?.maxBytes ?? DEBUG_BUNDLE_DEFAULT_MAX_BYTES;
  // Key-name-based redaction (see isSensitiveLogKey) — a secret under an innocuous key slips through.
  const redacted = redactSensitiveLogValue(data) as ThreadDebugBundleData;

  const protectedIndices = computeProtectedIndices(redacted.messages);
  const state: ElisionState = {
    elidedMessageIds: new Set<string>(),
    elidedRunEventSequences: new Set<number>(),
    toolResultElidedMessageIds: new Set<string>(),
  };
  const counts: ElisionCounts = { messages: 0, runEventMetadata: 0, toolResults: 0 };

  let candidate = buildCandidate(redacted, state, counts, false);
  while (byteLength(candidate) > maxBytes) {
    const applied = applyNextElisionStep(redacted, protectedIndices, state, counts);
    if (!applied) {
      candidate = buildCandidate(redacted, state, counts, true);
      break;
    }
    candidate = buildCandidate(redacted, state, counts, false);
  }

  const scrubbed = scrubLikelySecretValues(candidate);
  if (scrubbed.redactedCount === 0) {
    return scrubbed.text;
  }
  return `${scrubbed.text}\n\n_Secret scan: ${scrubbed.redactedCount} value(s) redacted (${scrubbed.kinds.join(', ')})._`;
}

/** Collect then format in one call — the convenience wrapper Task 9's Copy
 * button calls. */
export async function buildThreadDebugBundle(
  db: DebugBundleDatabase,
  input: CollectThreadDebugBundleInput,
  options?: FormatThreadDebugBundleOptions
): Promise<string> {
  const data = await collectThreadDebugBundleData(db, input);
  return formatThreadDebugBundle(data, options);
}
