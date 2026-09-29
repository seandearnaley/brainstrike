import { getPermissionToolGateSnapshotInput } from '@brainstrike/app-state/stores/permission-policy-store';
import {
  isAssistantToolApprovalAction,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  isAssistantToolResumeAction,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-suspend';
import type { LiveDecisionTransport } from '@brainstrike/assistant-ui';
import { useCallback } from 'react';
import {
  resolveAssistantAuthHeaders,
  resolveAssistantBaseUrl,
} from './hooks/use-assistant-availability';

/** The decision message the notices append (assistant-ui's `CreateAppendMessage`). */
type DecisionMessage = Parameters<LiveDecisionTransport>[0];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The canonical action a decision message carries in its run-config marker. */
export function readDecisionAction(message: DecisionMessage): unknown {
  // `CreateAppendMessage` is `string | {...}`; a decision is always the object form.
  const runConfig = isRecord(message) ? message['runConfig'] : undefined;
  const custom = isRecord(runConfig) ? runConfig['custom'] : undefined;
  if (!isRecord(custom)) {
    return;
  }
  for (const key of [TOOL_APPROVAL_RUN_CONFIG_KEY, TOOL_SUSPEND_RUN_CONFIG_KEY]) {
    const action = custom[key];
    if (isAssistantToolApprovalAction(action) || isAssistantToolResumeAction(action)) {
      return action;
    }
  }
  return;
}

/**
 * Live decision transport (desktop `POST /assistant/decide`): deliver a
 * decision message INTO the running root turn instead of behind it. The
 * action is the message's own run-config marker; the permission policy is
 * read FRESH from the store exactly as the request composer reads it, so a
 * grant recorded in the same click travels with the decision and answers
 * parked siblings in the running leg. 404 (no live leg owns the decision)
 * reports `'no-live-run'` so the caller queues the message; 409/500 reject
 * with the host's message so the card reports it.
 */
export function useDeliverLiveDecision(
  getActiveRunId: () => string | null | undefined,
  permissionEnforceable: boolean
): LiveDecisionTransport {
  return useCallback(
    async (message) => {
      const runId = getActiveRunId();
      if (!runId) {
        return 'no-live-run';
      }
      const action = readDecisionAction(message);
      if (!action) {
        throw new Error('A live decision requires a tool approval or resume action message.');
      }
      const snapshot = getPermissionToolGateSnapshotInput();
      const permissionPolicyRequest =
        permissionEnforceable && snapshot.enforce ? snapshot : undefined;
      const [base, authHeaders] = await Promise.all([
        resolveAssistantBaseUrl(),
        resolveAssistantAuthHeaders(),
      ]);
      const response = await fetch(`${base}/assistant/decide`, {
        body: JSON.stringify({
          action,
          ...(permissionPolicyRequest ? { permissionPolicyRequest } : {}),
          runId,
        }),
        headers: { ...authHeaders, 'content-type': 'application/json' },
        method: 'POST',
      });
      if (response.status === 404) {
        return 'no-live-run';
      }
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const body: unknown = await response.json();
          if (isRecord(body) && typeof body['message'] === 'string') {
            detail = body['message'];
          }
        } catch {
          // The status alone names the failure.
        }
        throw new Error(`The decision was not applied: ${detail}`);
      }
      return 'delivered';
    },
    [getActiveRunId, permissionEnforceable]
  );
}
