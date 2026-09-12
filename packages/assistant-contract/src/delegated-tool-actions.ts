import type { DelegatedRunIdentity } from './delegated-conversation-stream.js';

export const ASSISTANT_TOOL_ACTION_ID_MAX_CHARS = 512;
/** Wire-size ceiling only; the runtime's delegation budget may be stricter. */
const MAX_DELEGATED_ACTION_PATH_LENGTH = 32;

/**
 * The leaf call whose decision the user saw, plus its observed native ancestry.
 * Parent delegation call ids can be reused by successive leaf pauses. They are
 * routing coordinates, not sufficient identity for an approval decision.
 * The host must verify every edge against its persisted conversation graph.
 */
export interface DelegatedToolActionIdentity {
  readonly path: readonly DelegatedRunIdentity[];
  readonly toolCallId: string;
}

const IDENTITY_KEYS = new Set<PropertyKey>([
  'childRuntimeRunId',
  'parentRuntimeRunId',
  'parentToolCallId',
  'personaId',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= ASSISTANT_TOOL_ACTION_ID_MAX_CHARS;

function isRunIdentity(value: unknown): value is DelegatedRunIdentity {
  return (
    isRecord(value) &&
    Reflect.ownKeys(value).every((key) => IDENTITY_KEYS.has(key)) &&
    [...IDENTITY_KEYS].every((key) =>
      typeof key === 'string' ? Object.hasOwn(value, key) && isIdentifier(value[key]) : false
    )
  );
}

export function isDelegatedToolActionIdentity(
  value: unknown
): value is DelegatedToolActionIdentity {
  if (
    !(
      isRecord(value) &&
      Reflect.ownKeys(value).every((key) => key === 'path' || key === 'toolCallId') &&
      Object.hasOwn(value, 'path') &&
      Object.hasOwn(value, 'toolCallId') &&
      isIdentifier(value['toolCallId']) &&
      Array.isArray(value['path'])
    ) ||
    value['path'].length === 0 ||
    value['path'].length > MAX_DELEGATED_ACTION_PATH_LENGTH
  ) {
    return false;
  }
  const runs = new Set<string>();
  let previousRunId: string | undefined;
  for (const edge of value['path']) {
    if (!isRunIdentity(edge)) {
      return false;
    }
    if (previousRunId === undefined) {
      runs.add(edge.parentRuntimeRunId);
    } else if (edge.parentRuntimeRunId !== previousRunId) {
      return false;
    }
    if (runs.has(edge.childRuntimeRunId)) {
      return false;
    }
    runs.add(edge.childRuntimeRunId);
    previousRunId = edge.childRuntimeRunId;
  }
  return true;
}

/** Validate optional delegation without accepting inherited or partial identity. */
export function hasValidDelegatedToolActionTarget(value: Record<string, unknown>): boolean {
  if (
    'continuationId' in value &&
    !(Object.hasOwn(value, 'continuationId') && isIdentifier(value['continuationId']))
  ) {
    return false;
  }
  if (!('delegation' in value)) {
    return true;
  }
  const delegation = value['delegation'];
  if (!(Object.hasOwn(value, 'delegation') && isDelegatedToolActionIdentity(delegation))) {
    return false;
  }
  const root = delegation.path[0];
  return (
    root?.parentRuntimeRunId === value['runId'] && root?.parentToolCallId === value['toolCallId']
  );
}

interface ToolActionCoordinates {
  readonly continuationId?: string;
  readonly delegation?: DelegatedToolActionIdentity;
  readonly runId: string;
  readonly toolCallId: string;
}

/** Shared by root/child notices; the native parent owns the resume transport. */
export function getToolActionTarget(request: ToolActionCoordinates): ToolActionCoordinates {
  if (!request.delegation) {
    return {
      ...(request.continuationId ? { continuationId: request.continuationId } : {}),
      runId: request.runId,
      toolCallId: request.toolCallId,
    };
  }
  const root = request.delegation.path[0];
  if (!root) {
    throw new Error('Delegated tool decision is missing its parent.');
  }
  return {
    ...(request.continuationId ? { continuationId: request.continuationId } : {}),
    delegation: request.delegation,
    runId: root.parentRuntimeRunId,
    toolCallId: root.parentToolCallId,
  };
}

export function getToolActionIdentityKey(request: ToolActionCoordinates): string {
  const delegation = request.delegation;
  return JSON.stringify(
    delegation
      ? [delegation.path.at(-1)?.childRuntimeRunId, delegation.toolCallId]
      : request.continuationId
        ? [request.continuationId, request.runId, request.toolCallId]
        : [request.runId, request.toolCallId]
  );
}

export function isMatchingToolAction(value: unknown, request: ToolActionCoordinates): boolean {
  if (!(isRecord(value) && hasValidDelegatedToolActionTarget(value))) {
    return false;
  }
  const target = getToolActionTarget(request);
  if (
    value['continuationId'] !== target.continuationId ||
    value['runId'] !== target.runId ||
    value['toolCallId'] !== target.toolCallId
  ) {
    return false;
  }
  const delegation = value['delegation'];
  if (!request.delegation) {
    return delegation === undefined;
  }
  return (
    isDelegatedToolActionIdentity(delegation) &&
    delegation.path.at(-1)?.childRuntimeRunId ===
      request.delegation.path.at(-1)?.childRuntimeRunId &&
    delegation.toolCallId === request.delegation.toolCallId
  );
}
/** Observed parent invocation input, distinct from the leaf approval payload. */
export interface DelegatedOriginalToolCall {
  readonly args: unknown;
  readonly toolName: string;
}

/** Durable admission state, never a claim that the tool effect succeeded. */
export type DelegatedToolDecisionState = 'claimed' | 'consumed' | 'interrupted' | 'cancelled';

export function isDelegatedToolDecisionState(value: unknown): value is DelegatedToolDecisionState {
  return (
    value === 'claimed' || value === 'consumed' || value === 'interrupted' || value === 'cancelled'
  );
}

/** An absent state is resumable; a present unknown state must fail validation. */
export function hasValidDelegatedDecisionState(value: Record<string, unknown>): boolean {
  // Inherited and explicitly undefined states are present-but-invalid, not absent.
  if (!('decisionState' in value)) {
    return true;
  }
  return (
    Object.hasOwn(value, 'decisionState') &&
    isDelegatedToolDecisionState(value['decisionState']) &&
    (isDelegatedToolActionIdentity(value['delegation']) || isIdentifier(value['continuationId'])) &&
    hasValidDelegatedToolActionTarget(value)
  );
}
