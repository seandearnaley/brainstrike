import type { QueryDiagnosticsInput } from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { DiagnosticEventsRepository, type DiagnosticFingerprintGroup } from '@brainstrike/db';
import { type DiagnosticEvent, scrubLikelySecretValues } from '@brainstrike/utils/diagnostics';
import { getDatabase } from '../db-main';
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

/** Main's diagnostic events store, projected and scrubbed before any row leaves it. */
export const mainDiagnosticsReader: DiagnosticsReader = {
  events: async (filter) => {
    const repository = new DiagnosticEventsRepository(await getDatabase());
    const events = await repository.queryEvents(filter);
    return scrubProjectedItems(events.map((event) => projectEvent(event)));
  },
  fingerprints: async (filter) => {
    const repository = new DiagnosticEventsRepository(await getDatabase());
    const groups = await repository.queryFingerprintGroups(filter);
    return scrubProjectedItems(groups.map((group) => projectFingerprintGroup(group)));
  },
};

export function runQueryDiagnostics(input: QueryDiagnosticsInput): Promise<QueryDiagnosticsResult> {
  return runQueryDiagnosticsWith(input, mainDiagnosticsReader);
}
