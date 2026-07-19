import type { ToolRiskCategory } from './tool-risk.js';

export const TOOL_APPROVAL_DATA_NAME = 'brainstrike.tool-approval';
export const TOOL_APPROVAL_RUN_CONFIG_KEY = 'brainstrikeToolApproval';

/**
 * Run ids and tool-call ids share the assistant transport's 512-character
 * identifier ceiling. Keeping the number here makes approval actions safe to
 * validate without importing the agent package back into this browser-safe
 * contract.
 */
export const ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS = 512;

/**
 * Approval actions carry a display-only tool identity. Bound it to the same
 * transport identifier ceiling while allowing Brainstrike's namespaced tool
 * ids (which are not limited to the provider-facing 64-character name form).
 */
export const ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS = 512;

export interface AssistantToolApprovalRequest {
  args?: unknown;
  /**
   * The permission decision that caused the pause. Only `'ask'` is meaningful
   * here (an approval pause is, by definition, an `'ask'`); present so the UI can
   * say WHY the tool needs approval. Absent for a pause not driven by the
   * permission policy (e.g. an explicit global `requireToolApproval`).
   */
  policyDecision?: 'ask';
  resumeSchema?: unknown;
  /**
   * The risk bucket that resolved to `'ask'` for this tool (edit | execute | …),
   * surfaced so the approval notice can name the reason ("requires approval:
   * edit"). Absent when the pause was not driven by a permission policy.
   */
  riskCategory?: ToolRiskCategory;
  runId: string;
  toolCallId: string;
  toolName: string;
}

/**
 * An approval re-discovered from workflow storage after a restart/reload (via
 * `agent.listSuspendedRuns`). Extends the live-stream {@link
 * AssistantToolApprovalRequest} additively so the SAME notice + resume seam can
 * render it — the only additions are the suspend instant and an advisory
 * staleness flag (see D5: surface, never auto-decline).
 */
export interface RediscoveredToolApproval extends AssistantToolApprovalRequest {
  /** True when older than BRAINSTRIKE_APPROVAL_STALE_MS (advisory only). */
  readonly stale: boolean;
  /** ISO-8601 instant the run suspended (AgentRun.suspendedAt). */
  readonly suspendedAt: string;
}

export interface SuspendedApprovalsResponse {
  readonly approvals: readonly RediscoveredToolApproval[];
}

export function isRediscoveredToolApproval(value: unknown): value is RediscoveredToolApproval {
  return (
    isRecord(value) &&
    typeof value['runId'] === 'string' &&
    value['runId'].trim().length > 0 &&
    typeof value['toolCallId'] === 'string' &&
    value['toolCallId'].trim().length > 0 &&
    typeof value['toolName'] === 'string' &&
    value['toolName'].trim().length > 0 &&
    typeof value['suspendedAt'] === 'string' &&
    typeof value['stale'] === 'boolean'
  );
}

export type AssistantToolApprovalDecision = 'approve' | 'decline';

export interface AssistantToolApprovalAction {
  action: AssistantToolApprovalDecision;
  runId: string;
  toolCallId: string;
  toolName?: string;
}

export type ToolApprovalRunConfigActionReadResult =
  | { readonly action: AssistantToolApprovalAction }
  | { readonly invalid: true };

const TOOL_APPROVAL_ACTION_OWN_KEYS = new Set<PropertyKey>([
  'action',
  'runId',
  'toolCallId',
  'toolName',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isBoundedIdentifier(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxChars;
}

export function isAssistantToolApprovalAction(
  value: unknown
): value is AssistantToolApprovalAction {
  return (
    isRecord(value) &&
    Reflect.ownKeys(value).every((key) => TOOL_APPROVAL_ACTION_OWN_KEYS.has(key)) &&
    Object.hasOwn(value, 'action') &&
    Object.hasOwn(value, 'runId') &&
    Object.hasOwn(value, 'toolCallId') &&
    (value['action'] === 'approve' || value['action'] === 'decline') &&
    isBoundedIdentifier(value['runId'], ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS) &&
    isBoundedIdentifier(value['toolCallId'], ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS) &&
    (!('toolName' in value) ||
      (Object.hasOwn(value, 'toolName') &&
        isBoundedIdentifier(value['toolName'], ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS)))
  );
}

export function readToolApprovalRunConfigAction(
  runConfig: unknown
): ToolApprovalRunConfigActionReadResult | undefined {
  if (!isRecord(runConfig)) {
    return;
  }
  const custom = runConfig['custom'];
  if (!isRecord(custom)) {
    return;
  }
  const rawAction = custom[TOOL_APPROVAL_RUN_CONFIG_KEY];
  if (rawAction === undefined) {
    return;
  }
  if (!isAssistantToolApprovalAction(rawAction)) {
    return { invalid: true };
  }
  return { action: rawAction };
}
