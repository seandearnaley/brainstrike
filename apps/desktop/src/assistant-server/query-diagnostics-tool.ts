import { fitItemsToCharBudget, type QueryDiagnosticsInput } from '@brainstrike/agent';
import { NATIVE_TOOL_ID, ToolInputError } from '@brainstrike/assistant-contract';
import {
  type DiagnosticEventsQueryFilter,
  DiagnosticEventsRepository,
  type DiagnosticFingerprintGroup,
} from '@brainstrike/db';
import { type DiagnosticEvent, scrubLikelySecretValues } from '@brainstrike/utils/diagnostics';
import { getDatabase } from '../db-main';

export const QUERY_DIAGNOSTICS_TOOL_ID = NATIVE_TOOL_ID.queryDiagnostics;

const DEFAULT_QUERY_LIMIT = 50;
const MAX_MESSAGE_CHARS = 1000;
const MAX_STACK_CHARS = 1500;
const MAX_STRUCTURED_FIELD_CHARS = 1500;

interface TruncatedText {
  text: string;
  truncated: boolean;
}

export interface QueryDiagnosticEventItem {
  causeChainJson: string | null;
  causeChainTruncated: boolean;
  code: string | null;
  contextJson: string | null;
  contextTruncated: boolean;
  fingerprint: string;
  id: string;
  message: string;
  messageTruncated: boolean;
  occurredAt: number;
  resourceId: string | null;
  rootId: string | null;
  runId: string | null;
  scope: string | null;
  sessionId: string;
  severity: DiagnosticEvent['severity'];
  source: string;
  stack: string | null;
  stackTruncated: boolean;
  threadId: string | null;
}

export interface QueryDiagnosticFingerprintItem extends DiagnosticFingerprintGroup {
  latestMessageTruncated: boolean;
}

interface QueryDiagnosticsResultBase {
  hint?: string;
  requestedLimit: number;
  returned: number;
  totalMatchedWithinCap: number;
  truncated: boolean;
}

export interface QueryDiagnosticEventsResult extends QueryDiagnosticsResultBase {
  items: QueryDiagnosticEventItem[];
  kind: 'events';
}

export interface QueryDiagnosticFingerprintsResult extends QueryDiagnosticsResultBase {
  items: QueryDiagnosticFingerprintItem[];
  kind: 'fingerprints';
}

export type QueryDiagnosticsResult =
  | QueryDiagnosticEventsResult
  | QueryDiagnosticFingerprintsResult;

function truncateText(value: string, maxChars: number): TruncatedText {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: `${value.slice(0, maxChars)}…`, truncated: true };
}

function serializeStructuredField(value: unknown): TruncatedText | null {
  if (value === null) {
    return null;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Diagnostic structured field could not be serialized');
  }
  return truncateText(serialized, MAX_STRUCTURED_FIELD_CHARS);
}

function projectEvent(event: DiagnosticEvent): QueryDiagnosticEventItem {
  const message = truncateText(event.message, MAX_MESSAGE_CHARS);
  const stack = event.stack === null ? null : truncateText(event.stack, MAX_STACK_CHARS);
  const causeChain = serializeStructuredField(event.causeChain);
  const context = serializeStructuredField(event.context);
  return {
    causeChainJson: causeChain?.text ?? null,
    causeChainTruncated: causeChain?.truncated ?? false,
    code: event.code,
    contextJson: context?.text ?? null,
    contextTruncated: context?.truncated ?? false,
    fingerprint: event.fingerprint,
    id: event.id,
    message: message.text,
    messageTruncated: message.truncated,
    occurredAt: event.occurredAt,
    resourceId: event.resourceId,
    rootId: event.rootId,
    runId: event.runId,
    scope: event.scope,
    sessionId: event.sessionId,
    severity: event.severity,
    source: event.source,
    stack: stack?.text ?? null,
    stackTruncated: stack?.truncated ?? false,
    threadId: event.threadId,
  };
}

function projectFingerprintGroup(
  group: DiagnosticFingerprintGroup
): QueryDiagnosticFingerprintItem {
  const message = truncateText(group.latestMessage, MAX_MESSAGE_CHARS);
  return {
    ...group,
    latestMessage: message.text,
    latestMessageTruncated: message.truncated,
  };
}

function scrubProjectedItems<TItem>(items: readonly TItem[]): TItem[] {
  const serialized = JSON.stringify(items);
  return JSON.parse(scrubLikelySecretValues(serialized).text) as TItem[];
}

function toFilter(input: QueryDiagnosticsInput): DiagnosticEventsQueryFilter {
  const sinceMs = input.since === undefined ? undefined : Date.parse(input.since);
  const untilMs = input.until === undefined ? undefined : Date.parse(input.until);
  if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
    throw new ToolInputError('since must be earlier than or equal to until');
  }
  return {
    ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
    limit: input.limit ?? DEFAULT_QUERY_LIMIT,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.severity === undefined ? {} : { severity: input.severity }),
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    ...(untilMs === undefined ? {} : { untilMs }),
  };
}

function fitResult<TItem>(
  kind: QueryDiagnosticsResult['kind'],
  items: readonly TItem[],
  requestedLimit: number
): QueryDiagnosticsResult {
  const capReached = items.length === requestedLimit;
  const build = (kept: TItem[]): QueryDiagnosticsResult => {
    const outputTruncated = kept.length < items.length;
    const truncated = capReached || outputTruncated;
    return {
      ...(truncated
        ? {
            hint: outputTruncated
              ? `Showing ${kept.length} of ${items.length} matched ${kind} (output budget). Narrow the filters or lower the limit.`
              : `The ${requestedLimit}-${kind === 'events' ? 'row' : 'group'} cap was reached; more diagnostics may match. Narrow the filters.`,
          }
        : {}),
      items: kept,
      kind,
      requestedLimit,
      returned: kept.length,
      totalMatchedWithinCap: items.length,
      truncated,
    } as QueryDiagnosticsResult;
  };
  return fitItemsToCharBudget(items, build).result;
}

export async function runQueryDiagnostics(
  input: QueryDiagnosticsInput
): Promise<QueryDiagnosticsResult> {
  const filter = toFilter(input);
  const requestedLimit = filter.limit ?? DEFAULT_QUERY_LIMIT;
  const repository = new DiagnosticEventsRepository(await getDatabase());

  if (input.mode === 'events') {
    const events = await repository.queryEvents(filter);
    return fitResult(
      'events',
      scrubProjectedItems(events.map((event) => projectEvent(event))),
      requestedLimit
    );
  }

  const groups = await repository.queryFingerprintGroups(filter);
  return fitResult(
    'fingerprints',
    scrubProjectedItems(groups.map((group) => projectFingerprintGroup(group))),
    requestedLimit
  );
}
