import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QueryDiagnosticsInput } from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import type {
  DiagnosticEventsQueryFilter,
  DiagnosticEventsRepository,
  DiagnosticFingerprintGroup,
} from '@brainstrike/db';
import {
  type DiagnosticEvent,
  parseDiagnosticEventLine,
  scrubLikelySecretValues,
} from '@brainstrike/utils/diagnostics';
import { ERROR_LOG_FILE_NAME, listErrorLogFilePaths } from '../diagnostics/error-log-sink';
import {
  type DiagnosticsReader,
  type QueryDiagnosticEventItem,
  type QueryDiagnosticFingerprintItem,
  type QueryDiagnosticsResult,
  runQueryDiagnosticsWith,
} from './query-diagnostics-core';

export const QUERY_DIAGNOSTICS_TOOL_ID = NATIVE_TOOL_ID.queryDiagnostics;

const MAX_MESSAGE_CHARS = 1000;
const MAX_STACK_CHARS = 1500;
const MAX_STRUCTURED_FIELD_CHARS = 1500;

interface TruncatedText {
  text: string;
  truncated: boolean;
}

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

function matchesFilter(event: DiagnosticEvent, filter: DiagnosticEventsQueryFilter): boolean {
  return !(
    (filter.fingerprint !== undefined && event.fingerprint !== filter.fingerprint) ||
    (filter.runId !== undefined && event.runId !== filter.runId) ||
    (filter.threadId !== undefined && event.threadId !== filter.threadId) ||
    (filter.severity !== undefined && event.severity !== filter.severity) ||
    (filter.sinceMs !== undefined && event.occurredAt < filter.sinceMs) ||
    (filter.untilMs !== undefined && event.occurredAt > filter.untilMs)
  );
}

/** Read the existing Main log owner's retained files; never open a second database. */
async function retainedEvents(filter: DiagnosticEventsQueryFilter): Promise<DiagnosticEvent[]> {
  const { app } = await import('electron');
  const events: DiagnosticEvent[] = [];
  for (const path of listErrorLogFilePaths(join(app.getPath('logs'), ERROR_LOG_FILE_NAME))) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const event = parseDiagnosticEventLine(line);
      if (!event) {
        throw new Error('Malformed diagnostic record in the retained log; query is incomplete.');
      }
      if (!matchesFilter(event, filter)) {
        continue;
      }
      events.push(event);
    }
  }
  return events.sort(
    (left, right) => right.occurredAt - left.occurredAt || right.id.localeCompare(left.id)
  );
}

/** Main's retained diagnostic log, projected and scrubbed before any event leaves it. */
export const mainDiagnosticsReader: DiagnosticsReader = {
  events: async (filter) => {
    const events = await retainedEvents(filter);
    return scrubProjectedItems(events.slice(0, filter.limit).map(projectEvent));
  },
  fingerprints: async (filter) => {
    const groups = new Map<string, DiagnosticFingerprintGroup>();
    for (const event of await retainedEvents(filter)) {
      const group = groups.get(event.fingerprint);
      if (group) {
        group.count += 1;
        group.firstSeenMs = Math.min(group.firstSeenMs, event.occurredAt);
      } else {
        groups.set(event.fingerprint, {
          code: event.code,
          count: 1,
          fingerprint: event.fingerprint,
          firstSeenMs: event.occurredAt,
          lastSeenMs: event.occurredAt,
          latestMessage: event.message,
          severity: event.severity,
          source: event.source,
        });
      }
    }
    const ordered = [...groups.values()].sort(
      (left, right) =>
        right.count - left.count ||
        right.lastSeenMs - left.lastSeenMs ||
        left.fingerprint.localeCompare(right.fingerprint)
    );
    return scrubProjectedItems(ordered.slice(0, filter.limit).map(projectFingerprintGroup));
  },
};

/** Full event shape for the user-requested debug bundle; same retained writer and scrubber. */
export const mainDiagnosticEventsReader: Pick<
  DiagnosticEventsRepository,
  'queryEvents' | 'countByFingerprint'
> & { getUnseenCounts(sinceMs: number): Promise<{ errorCount: number; warningCount: number }> } = {
  countByFingerprint: async (fingerprint, sinceMs) => {
    const groups = await mainDiagnosticsReader.fingerprints({ fingerprint, limit: 1, sinceMs });
    const group = groups[0];
    return {
      count: group?.count ?? 0,
      firstSeenMs: group?.firstSeenMs ?? null,
      lastSeenMs: group?.lastSeenMs ?? null,
    };
  },
  getUnseenCounts: async (sinceMs) => {
    let errorCount = 0;
    let warningCount = 0;
    for (const event of await retainedEvents({ sinceMs })) {
      if (event.occurredAt <= sinceMs) {
        continue;
      }
      if (event.severity === 'warn') {
        warningCount += 1;
      } else {
        errorCount += 1;
      }
    }
    return { errorCount, warningCount };
  },
  queryEvents: async (filter) =>
    scrubProjectedItems(
      (await retainedEvents(filter)).slice(0, Math.min(filter.limit ?? 200, 200))
    ),
};

export function runQueryDiagnostics(input: QueryDiagnosticsInput): Promise<QueryDiagnosticsResult> {
  return runQueryDiagnosticsWith(input, mainDiagnosticsReader);
}
