import {
  ASSISTANT_TASK_STATUSES,
  type AssistantTaskItem,
  type AssistantTaskListSummary,
  type ManageTaskListResult,
} from '@brainstrike/assistant-contract';
import { Predicate } from 'effect';

/** Matches the manageTaskList tool name as `brainstrike.manageTaskList` or the Mastra-sanitized `brainstrike_manageTaskList`. */
const MANAGE_TASK_LIST_NAME = /^brainstrike[._]manageTaskList$/iu;

function isToolCallPart(part: unknown): part is Record<string, unknown> {
  return Predicate.isObject(part) && part['type'] === 'tool-call';
}

function isAssistantTaskItem(value: unknown): value is AssistantTaskItem {
  if (!Predicate.isObject(value)) {
    return false;
  }
  return (
    typeof value['id'] === 'string' &&
    typeof value['content'] === 'string' &&
    typeof value['activeForm'] === 'string' &&
    typeof value['status'] === 'string' &&
    (ASSISTANT_TASK_STATUSES as readonly string[]).includes(value['status'])
  );
}

function isSummary(value: unknown): value is AssistantTaskListSummary {
  return (
    Predicate.isObject(value) &&
    typeof value['total'] === 'number' &&
    typeof value['completed'] === 'number' &&
    typeof value['inProgress'] === 'number' &&
    typeof value['pending'] === 'number'
  );
}

function asManageTaskListResult(result: unknown): ManageTaskListResult | null {
  if (!Predicate.isObject(result)) {
    return null;
  }
  const tasks = result['tasks'];
  const summary = result['summary'];
  if (!(Array.isArray(tasks) && tasks.every(isAssistantTaskItem) && isSummary(summary))) {
    return null;
  }
  return {
    summary,
    tasks,
    ...(result['truncated'] === true ? { truncated: true } : {}),
    ...(typeof result['hint'] === 'string' ? { hint: result['hint'] } : {}),
  };
}

/**
 * Scan a message's parts for the LATEST `brainstrike.manageTaskList` tool result
 * and return it as a {@link ManageTaskListResult}. Works identically for live
 * tool-call parts and reloaded/hydrated parts (both normalize to
 * `{ type: 'tool-call', toolName, result }`). Malformed payloads and structured
 * `{ ok:false }` errors are ignored (return `null`) — never a bad render.
 */
export function deriveTaskListFromParts(parts: readonly unknown[]): ManageTaskListResult | null {
  let latest: ManageTaskListResult | null = null;
  for (const part of parts) {
    if (!isToolCallPart(part)) {
      continue;
    }
    const toolName = part['toolName'];
    if (typeof toolName !== 'string' || !MANAGE_TASK_LIST_NAME.test(toolName)) {
      continue;
    }
    const result = asManageTaskListResult(part['result']);
    if (result) {
      latest = result;
    }
  }
  return latest;
}
