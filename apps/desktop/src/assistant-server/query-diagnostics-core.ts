/**
 * queryDiagnostics over a caller-supplied reader: Main reads its diagnostic
 * events store (projected and secret-scrubbed before anything leaves it), the
 * desktop agent host reads the same projection over a typed read. This module
 * must not import Electron or Main's database: the host bundle loads it.
 */
import { fitItemsToCharBudget, type QueryDiagnosticsInput } from '@brainstrike/agent';
import { ToolInputError } from '@brainstrike/assistant-contract';
import type { DiagnosticEventsQueryFilter, DiagnosticFingerprintGroup } from '@brainstrike/db';
import type { DiagnosticEvent } from '@brainstrike/utils/diagnostics';

const DEFAULT_QUERY_LIMIT = 50;

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

/** The store's projected, scrubbed rows for one filter. */
export interface DiagnosticsReader {
  readonly events: (filter: DiagnosticEventsQueryFilter) => Promise<QueryDiagnosticEventItem[]>;
  readonly fingerprints: (
    filter: DiagnosticEventsQueryFilter
  ) => Promise<QueryDiagnosticFingerprintItem[]>;
}

function toFilter(input: QueryDiagnosticsInput): DiagnosticEventsQueryFilter {
  const parseBound = (label: string, value: string | undefined): number | undefined => {
    if (value === undefined) {
      return;
    }
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      throw new ToolInputError(`${label} must be a valid ISO-8601 timestamp`);
    }
    return parsed;
  };
  const sinceMs = parseBound('since', input.since);
  const untilMs = parseBound('until', input.until);
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
              ? `Showing ${kept.length} of ${items.length} matched ${kind} (output budget).${
                  capReached
                    ? ` The ${requestedLimit}-${kind === 'events' ? 'row' : 'group'} cap was also reached, so more may match.`
                    : ''
                } Narrow the filters or lower the limit.`
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

export async function runQueryDiagnosticsWith(
  input: QueryDiagnosticsInput,
  reader: DiagnosticsReader
): Promise<QueryDiagnosticsResult> {
  const filter = toFilter(input);
  const requestedLimit = filter.limit ?? DEFAULT_QUERY_LIMIT;
  if (input.mode === 'events') {
    return fitResult('events', await reader.events(filter), requestedLimit);
  }
  return fitResult('fingerprints', await reader.fingerprints(filter), requestedLimit);
}
