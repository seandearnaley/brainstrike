import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { extractPrimaryArg } from './tool-fallback';

export type SubAgentToolRowStatus = 'error' | 'running' | 'success';

export interface SubAgentToolRow {
  argSummary: string | undefined;
  key: string;
  status: SubAgentToolRowStatus;
  toolName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Persisted per-child rows from a delegation result's `subAgentToolResults`.
 * Authoritative at completion and on reload (see SUBAGENTS in AGENTS.md).
 */
export function readSubAgentToolRows(result: unknown): SubAgentToolRow[] {
  if (!isRecord(result)) {
    return [];
  }
  const list = result['subAgentToolResults'];
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((entry, index) => {
    const record = isRecord(entry) ? entry : {};
    const toolName = typeof record['toolName'] === 'string' ? record['toolName'] : 'tool';
    const toolCallId = typeof record['toolCallId'] === 'string' ? record['toolCallId'] : undefined;
    return {
      argSummary: extractPrimaryArg(record['args'], undefined),
      key: toolCallId ?? `${toolName}-${index}`,
      status: record['isError'] === true ? 'error' : 'success',
      toolName,
    };
  });
}

const SUBAGENT_TOOL_KIND_STATUS: Record<string, SubAgentToolRowStatus> = {
  'subagent.tool.completed': 'success',
  'subagent.tool.failed': 'error',
  'subagent.tool.started': 'running',
};

/**
 * LIVE in-flight per-child rows derived from `subagent.tool.*` run-event message
 * parts whose `metadata.parentToolCallId` matches this delegation. Later events
 * for the same child toolCallId supersede earlier ones (started → completed),
 * so a running delegation shows its in-progress tool count instead of zero.
 */
export function readLiveSubagentToolRows(
  parts: readonly unknown[],
  parentToolCallId: string
): SubAgentToolRow[] {
  const byChild = new Map<string, SubAgentToolRow>();
  for (const part of parts) {
    if (!(isRecord(part) && part['name'] === ASSISTANT_RUN_EVENT_DATA_NAME)) {
      continue;
    }
    const data = part['data'];
    if (!isRecord(data)) {
      continue;
    }
    const status =
      typeof data['kind'] === 'string' ? SUBAGENT_TOOL_KIND_STATUS[data['kind']] : undefined;
    if (!status) {
      continue;
    }
    const metadata = data['metadata'];
    if (!(isRecord(metadata) && metadata['parentToolCallId'] === parentToolCallId)) {
      continue;
    }
    const toolCallId =
      typeof metadata['toolCallId'] === 'string' ? metadata['toolCallId'] : undefined;
    if (!toolCallId) {
      continue;
    }
    const toolName =
      typeof metadata['childToolName'] === 'string' ? metadata['childToolName'] : 'tool';
    byChild.set(toolCallId, { argSummary: undefined, key: toolCallId, status, toolName });
  }
  return Array.from(byChild.values());
}

/**
 * Union of live + persisted rows, keyed by child toolCallId; a persisted row
 * (terminal, authoritative) supersedes the matching live row while preserving
 * its position, and persisted-only rows append.
 */
export function mergeSubagentToolRows(
  persisted: readonly SubAgentToolRow[],
  live: readonly SubAgentToolRow[]
): SubAgentToolRow[] {
  const byKey = new Map<string, SubAgentToolRow>();
  for (const row of live) {
    byKey.set(row.key, row);
  }
  for (const row of persisted) {
    byKey.set(row.key, row);
  }
  return Array.from(byKey.values());
}
