import type http from 'node:http';
import {
  type DelegatedDecisionRequest,
  isAssistantPermissionPolicyRequest,
  resolveRequestPermissionPolicy,
} from '@brainstrike/agent';
import { isAssistantToolApprovalAction } from '@brainstrike/assistant-contract/tool-approval';
import { isAssistantToolResumeAction } from '@brainstrike/assistant-contract/tool-suspend';
import { respondJson } from '@brainstrike/assistant-service/http';
import { DelegatedConversationIdentityError } from '@brainstrike/db';
import { deliverDesktopDelegatedDecision } from './delegated-execution-controls';
import { readRequestBody } from './http';
import type { LiveDecisionLog } from './live-decision-log';
import { desktopAssistantServerLogger as logger } from './logger';
import type { LiveDecisionRecord } from './swarm-diagnostics-records';

/** Transport ceiling shared with approval/resume action identifiers. */
const DECIDE_RUN_ID_MAX_CHARS = 512;
/** An action plus a permission snapshot; a typed answer may carry a short plan or answer. */
const DECIDE_BODY_LIMIT_BYTES = 64 * 1024;
const DECIDE_BODY_KEYS = new Set(['action', 'permissionPolicyRequest', 'runId']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reject(res: http.ServerResponse, message: string): void {
  respondJson(res, 400, { error: 'invalid_decide_action', message });
}

export interface DecideRequestDependencies {
  /**
   * The outcomes only this endpoint sees — no live run, a host refusal, a
   * failed resume — recorded for the debug pack (swarm diagnostics, migration
   * 139). A delivered decision is recorded by the running leg, which also sees
   * its task and the parked siblings the request answered.
   */
  readonly recordLiveDecision: LiveDecisionLog;
}

function endpointDecisionRecord(
  request: DelegatedDecisionRequest,
  outcome: 'no-live-run' | 'refused' | 'failed',
  reason?: string
): LiveDecisionRecord {
  const { action } = request;
  return {
    ...(isAssistantToolApprovalAction(action)
      ? { decision: action.action, kind: 'approval' as const }
      : { decision: 'resume' as const, kind: 'resume' as const }),
    ...(action.delegation ? { delegationToolCallId: action.delegation.toolCallId } : {}),
    outcome,
    ...(request.permissionPolicy ? { policySnapshot: request.permissionPolicy } : {}),
    ...(reason === undefined ? {} : { reason }),
    source: 'user',
    toolCallId: action.toolCallId,
  };
}

/**
 * Live decision endpoint (settled 2026-09-14): POST /assistant/decide with
 * `{ runId, action, permissionPolicyRequest? }` delivers an approval or typed
 * resume for a parked background child INTO the running leg `runId`, the way
 * Claude Code answers a subagent's permission prompt inside the live
 * session. The renderer's policy request is resolved into the trusted
 * snapshot exactly as a stream request's is, so a lasting grant recorded
 * with the click answers parked siblings in the same leg. 404 means no live
 * leg owns that decision (the leg settled, or the decision is not a parked
 * background child) and the renderer takes the ordinary new-leg path; 409
 * means the host refused it (already answered, stale, unauthorized) and the
 * card must say so; a failed native resume is a 500 the card reports. Each
 * non-delivered outcome is recorded BEFORE the answer, so a debug pack taken
 * on that answer holds the row.
 */
export async function handleDecideRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: DecideRequestDependencies
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readRequestBody(req, { maxBodyBytes: DECIDE_BODY_LIMIT_BYTES }));
  } catch {
    reject(res, 'Decide request body must be a JSON object.');
    return;
  }
  if (!(isRecord(parsed) && Object.keys(parsed).every((key) => DECIDE_BODY_KEYS.has(key)))) {
    reject(res, 'Decide request accepts only runId, action and permissionPolicyRequest.');
    return;
  }
  const { action, permissionPolicyRequest, runId } = parsed;
  if (
    typeof runId !== 'string' ||
    runId.trim().length === 0 ||
    runId.length > DECIDE_RUN_ID_MAX_CHARS
  ) {
    reject(
      res,
      `Decide runId must be a non-empty string of at most ${DECIDE_RUN_ID_MAX_CHARS} characters.`
    );
    return;
  }
  if (!(isAssistantToolApprovalAction(action) || isAssistantToolResumeAction(action))) {
    reject(res, 'Decide action must be a tool approval or tool resume action.');
    return;
  }
  if (
    permissionPolicyRequest !== undefined &&
    !isAssistantPermissionPolicyRequest(permissionPolicyRequest)
  ) {
    reject(res, 'Decide permissionPolicyRequest is malformed.');
    return;
  }
  const permissionPolicy = resolveRequestPermissionPolicy(permissionPolicyRequest);
  const request: DelegatedDecisionRequest = {
    action,
    ...(permissionPolicy ? { permissionPolicy } : {}),
  };
  let outcome: 'delivered' | 'no-live-run';
  try {
    outcome = await deliverDesktopDelegatedDecision(runId, request);
  } catch (error) {
    if (error instanceof DelegatedConversationIdentityError) {
      logger.warn('Live decision refused by the host', {
        code: 'live_decision_refused',
        reason: error.reason,
        runId,
        toolCallId: action.toolCallId,
      });
      await deps.recordLiveDecision(
        runId,
        endpointDecisionRecord(request, 'refused', error.reason)
      );
      respondJson(res, 409, {
        error: 'decision_refused',
        message: error.actionableMessage ?? `The host refused this decision (${error.reason}).`,
        reason: error.reason,
      });
      return;
    }
    logger.error('Live decision failed', { error, runId, toolCallId: action.toolCallId });
    await deps.recordLiveDecision(
      runId,
      endpointDecisionRecord(
        request,
        'failed',
        error instanceof Error ? error.message : String(error)
      )
    );
    respondJson(res, 500, {
      error: 'decision_failed',
      message: 'The decision could not be applied to the running turn.',
    });
    return;
  }
  if (outcome === 'no-live-run') {
    await deps.recordLiveDecision(runId, endpointDecisionRecord(request, 'no-live-run'));
    respondJson(res, 404, {
      error: 'no_live_run',
      message: 'No running turn owns that decision; it may have already settled.',
    });
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 200;
  res.end(JSON.stringify({ delivered: true, runId }));
}
