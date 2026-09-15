export const ASSISTANT_RUN_EVENT_DATA_NAME = 'brainstrike.run-event';

export const ASSISTANT_RUN_EVENT_KINDS = [
  // The pre-request conversation-compaction pass THREW, so this turn reached
  // the provider uncompacted and over budget (BST-1737). The turn still
  // answers — keeping it alive is correct — but before this kind the only
  // evidence was a `warn` log, and the user's next visible symptom was a
  // provider context-overflow error naming an unrelated cause. That silence is
  // what let BST-1707's live defect (a recommended coding model whose budget
  // derivation threw on EVERY turn) survive from `2966627ff` until someone read
  // the arithmetic.
  //
  // Modelled on `mcp.tools.unavailable` below, and filed for the same class of
  // problem: a configured capability that silently did not run while the turn
  // still answered. Standalone breadcrumb — no `.started` counterpart and no
  // terminal, so it can never leave a row spinning — status `'failed'` rather
  // than the `worktree.*` `'info'`, which records operations that SUCCEEDED.
  //
  // Deliberately NOT `run.failed`: the run is healthy and completes, and
  // `data-stream-mapper` derives `thread_runs.error` from `run.failed`, so that
  // spelling would persist a degraded turn as a failed one. Deliberately ONE
  // kind rather than a `compaction.budget.failed` / `compaction.schema.failed`
  // taxonomy: the discriminating fact is already written at each throw site and
  // travels in `detail` / `metadata.reason`, whereas a hand-maintained
  // classifier would bucket the NEXT unanticipated throw into "other" and
  // re-create this ticket. It is in `isAlwaysVisibleRunEvent` for the
  // load-bearing reason spelled out on `mcp.tools.unavailable`, and carries no
  // `toolCallId`, so it needs no exemption from the card-suppression rule.
  'compaction.failed',
  // A delegated child's durable budget (steps / child output / tree output)
  // forced its reserved synthesis step (BST-1749 follow-up, GLM pack
  // 2026-09-15). Standalone breadcrumb, status 'info', emitted by the stream
  // projection on the CHILD conversation from the budget processor's transient
  // part; metadata carries `cap`, `limit`, `used`, `synthesisForced` and
  // `truncated` (whether the model then cut the summary). Deliberately NOT
  // `.started`: nothing runs and nothing pairs. In `isAlwaysVisibleRunEvent`
  // for the load-bearing reason on `mcp.tools.unavailable`: without it the
  // child tab would show silence where the user needs "ran out of steps".
  'delegation.budget.exhausted',
  // The ledger of a run's background (delegated) invocations, settled
  // 2026-09-15: "3 of 4 specialists returned · 1 running". Emitted by the
  // host idle loop and the resume stream on every task lifecycle change, with
  // a FRESH id each time and the same `metadata.ledgerId` (the parent run
  // that dispatched the work); the renderer shows the LATEST row of a ledger
  // and hides the earlier ones, and the desktop persists every row like any
  // run event, so reload shows the final state. `status` is `'running'`
  // while anything runs and `'completed'` otherwise — a failed specialist is
  // a count in the label, not a failed turn (deliberately NOT `run.failed`).
  // Content-free: persona labels and states only; prompts and failure
  // reasons stay in the model-facing wakeup. It is in
  // `isAlwaysVisibleRunEvent`: it IS the user-facing status the approach plan
  // asked for and must show at default detail.
  'delegation.ledger',
  'hook.blocked',
  'hook.notice',
  'memory.configured',
  'memory.history.loaded',
  'memory.observation.completed',
  // A background observation/buffering cycle FAILED (streamed by Mastra as a
  // `data-om-*-failed` chunk). Deliberately its own kind: this was the only
  // runtime evidence of the BST-940 field failure (a broken observer failing
  // every cycle) and must stay visible in the run timeline, never dropped as
  // an unrecognized chunk.
  'memory.observation.failed',
  'memory.observation.started',
  'memory.reflection.completed',
  'memory.reflection.started',
  'memory.semantic.completed',
  'memory.semantic.started',
  'memory.working.loaded',
  'memory.working.updated',
  // One MCP server — or the whole client — contributed ZERO tools to this run
  // (BST-1602): discovery lost its timeout race, or that server's `listTools`
  // failed. The run still answers, with a materially reduced tool surface.
  //
  // Deliberately NOT `tool.failed`: no tool ran and none failed. The tool never
  // entered the map at all, so `search_tools` reports "0 results" and the
  // model's follow-up call fails fast — a `tool.failed` spelling would invent a
  // failed call in the Task Ledger and double-count the one the model does
  // make. Deliberately NOT `run.failed`: the turn is healthy and completes.
  //
  // Standalone breadcrumb, like the `worktree.*` kinds: no `.started`
  // counterpart and no terminal, so it never leaves a row spinning. Status is
  // `'failed'` rather than the `worktree.*` `'info'` — those record operations
  // that SUCCEEDED, this records a configured capability that did not load.
  //
  // It is in `isAlwaysVisibleRunEvent`, and that is load-bearing rather than
  // incidental: run-event rows are hidden at default detail, so without the
  // allowlist entry this kind would reproduce the silent degradation it exists
  // to report. It passes that allowlist's own test — nothing else cards this
  // fact. An ordinary tool failure is excluded there because its ToolFallback
  // card reports it; a skipped server has no card at all, and the "Tool
  // execution failed." card the user does see belongs to the model's doomed
  // follow-up call and names the wrong cause. Carrying no `toolCallId`, it needs
  // no exemption from the card-suppression rule (unlike that allowlist's two
  // `tool.*` entries).
  'mcp.tools.unavailable',
  // Forge (pull request) observations (BST-1391, W4). These are the ONLY run
  // events not produced by the agent stream: the main-process ForgeService
  // observes them out of band and the renderer appends them to the thread's
  // MOST RECENT run — the run whose push produced the pull request.
  //
  // `run_id` is NOT NULL with an FK to the renderer-bootstrapped thread-runs
  // table, so a thread with no runs gets no row: there is no turn to attach
  // the observation to, and `appendThreadRunEvent`'s INSERT … SELECT no-ops.
  // The chip and the thread pill still show the PR — only the timeline row is
  // absent, and the writer logs that it was.
  //
  // Deliberately three kinds rather than one `pr.updated`: the timeline reads
  // as a history ("Opened #2574", "Checks failed", "Merged"), and the
  // notification gate is per-kind.
  'pr.checks',
  'pr.merged',
  'pr.opened',
  // The provider reported that it did NOT carry this request out as written
  // (BST-1701). Every AI SDK adapter answers a rejected setting by DROPPING it
  // and listing it on the call's `warnings` array rather than returning 400 -
  // a user-set `temperature` on a model that refuses one is simply ignored.
  // The whole array is consumed, not the sampling keys: the spec's warning
  // union also carries `compatibility`, `deprecated` and `other`.
  //
  // Deliberately NOT `run.failed`: the turn is healthy and answers normally.
  // Deliberately NOT `hook.notice`: that is the workspace-hook channel, and
  // this is the provider's own report about the request it just served.
  //
  // Standalone breadcrumb like `mcp.tools.unavailable`: no `.started`
  // counterpart and no terminal, so it never leaves a row spinning. Status is
  // `'failed'` rather than the `worktree.*` `'info'` - those record operations
  // that SUCCEEDED, this records a setting that did not apply. It is in
  // `isAlwaysVisibleRunEvent` for the same load-bearing reason: run-event rows
  // are hidden at default detail, so without the allowlist entry this kind
  // would reproduce the silent degradation it exists to report. It carries no
  // `toolCallId` and is not `tool.*`, so it needs no card-suppression
  // exemption.
  'provider.request.warned',
  'run.cancelled',
  'run.database.retried',
  'run.failed',
  'run.finished',
  // A stalled ATTEMPT that the turn recovered from, and the continuation that
  // followed (BST-1409). Deliberately NOT `run.failed`/`run.started`: the turn
  // never failed and never restarted — one provider attempt went silent and was
  // replaced, with every completed step carried forward. Reusing the terminal
  // kinds would report a healthy turn as a failure in the durable timeline.
  //
  // A continuation IS a fresh `agent.stream`, so Mastra re-emits its `start`
  // part; the turn runner drops that duplicate (`withoutDuplicateRunStarted`)
  // precisely so this stays true and one turn reports one `run.started`.
  'run.resumed',
  'run.stalled',
  'run.started',
  'run.steered',
  'run.step.finished',
  'run.step.started',
  'subagent.failed',
  'subagent.finished',
  'subagent.started',
  'subagent.tool.completed',
  'subagent.tool.failed',
  'subagent.tool.started',
  // The approval PAUSE itself, as a durable event (BST-1402). The pause is NOT
  // otherwise unrecorded: a STILL-PENDING one is rediscovered on load from the
  // Mastra suspended-workflow snapshot (`listSuspendedMastraRuns` +
  // `appendSuspendedPauseMessages`), which re-appends the real actionable
  // `brainstrike.tool-approval` notice. This row exists for the two things that
  // rediscovery cannot do:
  //   1. It is a CHEAP CROSS-THREAD PROJECTION SURFACE. The Threads panel's
  //      "needs you" column is one SQL query over
  //      `brainstrike_assistant_run_events`; rediscovery is a per-thread round
  //      trip through workflow storage and cannot be run for every thread in a
  //      list.
  //   2. It records pauses that were LATER ANSWERED. Rediscovery only ever
  //      surfaces snapshots that are still suspended, so without this row the
  //      history of "this run stopped and asked" disappears the moment the user
  //      answers.
  //
  // Deliberately NOT spelled `.started`, and deliberately WITHOUT a resolution
  // counterpart. No tool ran: a `.started` spelling would make
  // `collectToolDurations` clock the USER's deliberation as tool execution and
  // would pair the pause against `tool.completed` as if a call had run, while
  // `RUN_LEDGER_AGGREGATION_SQL` counts only `tool.completed`/`tool.failed`, so
  // this is never a tool call in the Task Ledger either. Resolution is DERIVED
  // from events that already exist — the next event for the SAME
  // `metadata.toolCallId` (approve => the resumed stream re-yields the tool
  // start and eventually `tool.completed`; decline => `tool.failed`, "Tool call
  // declined"; unanswerable => `tool.resume.unsupported`). The run status is
  // NOT a resolution signal: the paused leg is recorded `completed` (it returns
  // `finished` at the pause), so "the run left `status = 'running'`" is true the
  // instant the pause is written. A `tool.approval.resolved` kind would be a second
  // source of truth for a fact those terminals already carry.
  'tool.approval.requested',
  'tool.completed',
  'tool.failed',
  // A suspending tool paused a run this build has no registered resume UI for
  // (BST-558). Deliberately NOT `tool.failed`: no tool ran and none failed, the
  // Mastra snapshot stays suspended, and a build that later registers the tool
  // resumes the SAME toolCallId and emits the real `tool.completed`. Reusing
  // `tool.failed` would invent a failed tool call in the Task Ledger AND
  // double-count that one call, and would close out `tool.started` in the
  // timeline / duration pairings while the tool is still suspended.
  'tool.resume.unsupported',
  'tool.started',
  // Managed-worktree lifecycle (BST-1390). Standalone breadcrumbs, emitted
  // `status: 'info'` (or `'failed'` for a failed setup) — deliberately NOT
  // `.started` kinds: a worktree create/archive is atomic from the timeline's
  // point of view and has no terminal to pair against, so a `.started`
  // spelling would leave a row spinning for the rest of the run.
  //
  // They exist ONLY for operations that happen inside a run. A worktree created
  // before the thread's first request has no run row to attach to, and no
  // orphan event is invented for it: the create sheet reports the outcome and
  // `brainstrike_worktrees` is the durable record. See
  // docs/agents/assistant-persistence.md.
  'worktree.archived',
  'worktree.created',
  'worktree.setup',
] as const;

export type AssistantRunEventKind = (typeof ASSISTANT_RUN_EVENT_KINDS)[number];

export const ASSISTANT_RUN_EVENT_STATUSES = [
  'cancelled',
  'completed',
  'failed',
  'info',
  'running',
] as const;

export type AssistantRunEventStatus = (typeof ASSISTANT_RUN_EVENT_STATUSES)[number];

export type AssistantRunEventJson =
  | AssistantRunEventJson[]
  | boolean
  | null
  | number
  | string
  | { [key: string]: AssistantRunEventJson };

export type AssistantRunEventMetadata = Record<string, AssistantRunEventJson>;

export interface AssistantRunEvent {
  readonly detail?: string;
  readonly durationMs?: number;
  readonly id: string;
  readonly kind: AssistantRunEventKind;
  readonly label: string;
  readonly metadata?: AssistantRunEventMetadata;
  readonly runId?: string;
  readonly sequence?: number;
  readonly status: AssistantRunEventStatus;
  readonly timestamp: string;
}

export type AssistantRunEventSink = (event: AssistantRunEvent) => Promise<void> | void;

/** Total length of a bounded reason, INCLUDING the ellipsis it may end with. */
export const MAX_RUN_EVENT_REASON_CHARS = 200;

const REDACTED = '[redacted]';
/**
 * ANY URI scheme, not just http(s). The scheme class was defensible while the
 * only caller was MCP discovery, whose transports are HTTP; BST-1737 routes
 * compaction failures through here, and those reach `memoryStore` reads/writes,
 * `runRecencyPruneScan`, and `recordCompactionRange` — a driver error quoting
 * `postgres://user:pass@host/db` would otherwise pass BOTH patterns untouched
 * into durable metadata and an always-visible row.
 */
const SCHEME = '[a-z][a-z0-9+.-]*:\\/\\/';
/** `postgres://user:pass@host` — credentials in the URI's userinfo section. */
const URL_USERINFO = new RegExp(`(${SCHEME})[^/\\s@]+@`, 'gi');
/** `https://host/mcp?api_key=…` — credentials in a URI query string. */
const URL_QUERY = new RegExp(`(${SCHEME}[^\\s?]+)\\?\\S*`, 'gi');

/**
 * Prepare a failure message for DURABLE run-event metadata and for an
 * always-visible timeline `detail`.
 *
 * Introduced for BST-1602's MCP discovery skips (as `boundMcpDiscoveryReason`)
 * and promoted here by BST-1737, which needs the identical treatment for
 * compaction failures: this is a SECURITY control, and a second copy of these
 * regexes is a second thing to forget to fix.
 *
 * Two separate jobs, and the ordering matters:
 *
 * 1. REDACT. `sanitizeAssistantRunEventMetadata` redacts by KEY, not by value,
 *    so nothing downstream inspects this string. These reasons used to reach at
 *    most a `debug`/`warn` log line; they are now persisted and rendered, so a
 *    transport error like `fetch failed: 401 for https://host/mcp?api_key=…`
 *    would be a real disclosure. Truncation does NOT prevent that — such a
 *    message is comfortably under the bound (PR #2938 review) — so URL userinfo
 *    and query strings are stripped first.
 * 2. BOUND. Only then cap the length, to keep the row small.
 *
 * Sliced by CODE POINT, not UTF-16 code unit: `slice` can split a surrogate
 * pair and put a lone surrogate into durable JSON.
 */
/**
 * Job 1 on its own: extract the message text and strip credentials from it,
 * WITHOUT bounding the length.
 *
 * Split out by BST-1744 for the compaction-failure latch key, which has to be
 * built from the UNTRUNCATED text — truncation collapses two failures that
 * agree on their first 199 characters — while still getting the identical
 * redaction and, just as importantly, the identical EXTRACTION. Reusing this
 * rather than re-deriving it keeps ONE copy of the credential patterns (the
 * whole reason they were promoted here) and keeps the key describing the same
 * text the row renders: a second `value instanceof Error ? …` would be free to
 * drift from this one the moment either grows a case, and the latch would then
 * merge or split rows the user sees differently.
 */
export function redactRunEventReason(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw.replace(URL_USERINFO, `$1${REDACTED}@`).replace(URL_QUERY, `$1?${REDACTED}`);
}

export function boundRunEventReason(value: unknown): string {
  const redacted = redactRunEventReason(value);
  const points = Array.from(redacted);
  if (points.length <= MAX_RUN_EVENT_REASON_CHARS) {
    return redacted;
  }
  return `${points.slice(0, MAX_RUN_EVENT_REASON_CHARS - 1).join('')}…`;
}

export function emitAssistantRunEventSafely(input: {
  readonly event: {
    readonly detail?: string;
    readonly durationMs?: number;
    readonly kind: AssistantRunEventKind;
    readonly label: string;
    readonly metadata?: AssistantRunEventMetadata;
    readonly status: AssistantRunEventStatus;
  };
  readonly eventSink: AssistantRunEventSink | undefined;
  readonly onError: (error: unknown, event: AssistantRunEvent) => void;
  readonly runId: string | undefined;
}): void {
  if (!(input.eventSink && input.runId)) {
    return;
  }

  const event = createAssistantRunEvent({
    ...input.event,
    runId: input.runId,
  });
  try {
    void Promise.resolve(input.eventSink(event)).catch((error: unknown) => {
      input.onError(error, event);
    });
  } catch (error) {
    input.onError(error, event);
  }
}

const UNSAFE_RUN_EVENT_METADATA_KEYS = new Set([
  'apikey',
  'authorization',
  'bearer',
  'content',
  'cookie',
  'credential',
  'memory',
  'output',
  'password',
  'prompt',
  'reasoning',
  'result',
  'secret',
  'session',
  'text',
  'token',
]);

const MAX_RUN_EVENT_METADATA_DEPTH = 8;

const UNSAFE_RUN_EVENT_METADATA_KEY_FRAGMENTS = [
  'apikey',
  'accesstoken',
  'authorization',
  'authtoken',
  'bearer',
  'cookie',
  'credential',
  'idtoken',
  'password',
  'refreshtoken',
  'secret',
  'session',
] as const;

export function createAssistantRunEvent(input: {
  readonly detail?: string;
  readonly durationMs?: number;
  readonly kind: AssistantRunEventKind;
  readonly label: string;
  readonly metadata?: AssistantRunEventMetadata;
  readonly runId?: string;
  readonly sequence?: number;
  readonly status: AssistantRunEventStatus;
}): AssistantRunEvent {
  return {
    id: `run-event-${crypto.randomUUID()}`,
    kind: input.kind,
    label: input.label,
    status: input.status,
    timestamp: new Date().toISOString(),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
  };
}

export function sanitizeAssistantRunEventMetadata(
  metadata: AssistantRunEventMetadata | Record<string, unknown> | undefined
): AssistantRunEventMetadata | undefined {
  // Must be idempotent: publication and durable storage each enforce this boundary.
  if (!metadata) {
    return;
  }

  const sanitized = sanitizeRunEventJsonValue(metadata, 0);
  return isPlainRecord(sanitized) ? sanitized : undefined;
}

function sanitizeRunEventJsonValue(value: unknown, depth: number): AssistantRunEventJson {
  if (depth > MAX_RUN_EVENT_METADATA_DEPTH) {
    return null;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRunEventJsonValue(item, depth + 1));
  }
  if (!isPlainRecord(value)) {
    return null;
  }

  const sanitized: Record<string, AssistantRunEventJson> = {};
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = normalizeRunEventMetadataKey(key);
    if (isUnsafeRunEventMetadataKey(normalizedKey)) {
      continue;
    }
    sanitized[key] = sanitizeRunEventJsonValue(nested, depth + 1);
  }
  return sanitized;
}

function isUnsafeRunEventMetadataKey(normalizedKey: string): boolean {
  if (UNSAFE_RUN_EVENT_METADATA_KEYS.has(normalizedKey)) {
    return true;
  }
  return UNSAFE_RUN_EVENT_METADATA_KEY_FRAGMENTS.some((unsafeKey) =>
    normalizedKey.includes(unsafeKey)
  );
}

function normalizeRunEventMetadataKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

function isPlainRecord(value: unknown): value is Record<string, AssistantRunEventJson> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const ASSISTANT_RUN_EVENT_KIND_SET: ReadonlySet<string> = new Set(ASSISTANT_RUN_EVENT_KINDS);
const ASSISTANT_RUN_EVENT_STATUS_SET: ReadonlySet<string> = new Set(ASSISTANT_RUN_EVENT_STATUSES);

/**
 * Exact mirror of `sanitizeRunEventJsonValue`'s shape rules (same start depth,
 * same `> MAX` boundary): every tree the sanitizer can emit passes, including
 * the `null` leaves it writes one level past the cap. Pinned by the
 * round-trip test in run-events-inbound-guard.test.ts.
 */
function isAssistantRunEventJson(value: unknown, depth: number): value is AssistantRunEventJson {
  if (depth > MAX_RUN_EVENT_METADATA_DEPTH) {
    return value === null;
  }
  if (value === null) {
    return true;
  }
  const kind = typeof value;
  if (kind === 'boolean' || kind === 'string') {
    return true;
  }
  if (kind === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isAssistantRunEventJson(entry, depth + 1));
  }
  if (kind === 'object') {
    return Object.values(value as Record<string, unknown>).every((entry) =>
      isAssistantRunEventJson(entry, depth + 1)
    );
  }
  return false;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isAssistantRunEventCore(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['label'] === 'string' &&
    typeof record['timestamp'] === 'string' &&
    typeof record['kind'] === 'string' &&
    ASSISTANT_RUN_EVENT_KIND_SET.has(record['kind']) &&
    typeof record['status'] === 'string' &&
    ASSISTANT_RUN_EVENT_STATUS_SET.has(record['status']) &&
    isOptionalString(record['detail']) &&
    isOptionalString(record['runId']) &&
    isOptionalFiniteNumber(record['durationMs']) &&
    isOptionalFiniteNumber(record['sequence'])
  );
}

function isValidRunEventMetadata(metadata: unknown): metadata is AssistantRunEventMetadata {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return false;
  }
  return isAssistantRunEventJson(metadata, 0);
}

/**
 * STRICT inbound wire validity (BST-978 slice 2): required fields present and
 * typed, `kind`/`status` members of the closed unions, metadata (when
 * present) a JSON record within the sanitizer's exact depth rules. Use
 * `readAssistantRunEvent` for consumer narrowing — this predicate rejects an
 * event outright over a metadata defect, which inbound consumers should not.
 */
export function isAssistantRunEvent(value: unknown): value is AssistantRunEvent {
  if (!isAssistantRunEventCore(value)) {
    return false;
  }
  const metadata = value['metadata'];
  return metadata === undefined || isValidRunEventMetadata(metadata);
}

/**
 * Consumer-side inbound narrow, mirroring the OUTBOUND degrade-don't-drop
 * policy: a core-field defect returns undefined (skip the part, never throw),
 * but a metadata-only defect keeps the event and drops just the metadata —
 * the sanitizer never discards an event over its metadata either.
 */
export function readAssistantRunEvent(value: unknown): AssistantRunEvent | undefined {
  if (!isAssistantRunEventCore(value)) {
    return;
  }
  const metadata = value['metadata'];
  if (metadata === undefined || isValidRunEventMetadata(metadata)) {
    return value as unknown as AssistantRunEvent;
  }
  const { metadata: _dropped, ...withoutMetadata } = value;
  return withoutMetadata as unknown as AssistantRunEvent;
}

/**
 * Narrow an assistant-ui data part to its run event: a record named
 * `ASSISTANT_RUN_EVENT_DATA_NAME` whose `data` passes `readAssistantRunEvent`
 * (metadata-degrading, never throwing — a notification trigger must never
 * crash the panel over a shape mismatch).
 */
export function readAssistantRunEventDataPart(part: unknown): AssistantRunEvent | undefined {
  if (typeof part !== 'object' || part === null || Array.isArray(part)) {
    return;
  }
  const record = part as Record<string, unknown>;
  if (record['name'] !== ASSISTANT_RUN_EVENT_DATA_NAME) {
    return;
  }
  return readAssistantRunEvent(record['data']);
}
