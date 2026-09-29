import type http from 'node:http';
import { respondJson } from '@brainstrike/assistant-service/http';
import { requestRunSteer } from '@brainstrike/assistant-service/steering';
import { cancelDesktopAssistantRun } from './cancel-run';
import { readRequestBody } from './http';
import { desktopAssistantServerLogger as logger } from './logger';

/** Transport ceiling shared with approval/resume action identifiers. */
const STEER_RUN_ID_MAX_CHARS = 512;
const STEER_BODY_LIMIT_BYTES = 4096;

/**
 * Mid-run steering control endpoint (BST-588): POST /assistant/steer with
 * exactly `{ runId }`. Flips the registered run's control so the agent loop
 * ends gracefully at the next step boundary; the renderer then dispatches the
 * queued steer message via the follow-up queue's run-end bridge. An unknown
 * run answers a visible 404 — steering a finished run must not pretend
 * success.
 */
export async function handleSteerRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  let parsed: unknown;
  try {
    const body = await readRequestBody(req, { maxBodyBytes: STEER_BODY_LIMIT_BYTES });
    parsed = JSON.parse(body) as unknown;
  } catch {
    respondJson(res, 400, {
      error: 'invalid_steer_action',
      message: 'Steer request body must be a small JSON object.',
    });
    return;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1
  ) {
    respondJson(res, 400, {
      error: 'invalid_steer_action',
      message: 'Steer request accepts exactly one field: runId.',
    });
    return;
  }
  const runId = (parsed as Record<string, unknown>)['runId'];
  if (
    typeof runId !== 'string' ||
    runId.trim().length === 0 ||
    runId.length > STEER_RUN_ID_MAX_CHARS
  ) {
    respondJson(res, 400, {
      error: 'invalid_steer_action',
      message: `Steer runId must be a non-empty string of at most ${STEER_RUN_ID_MAX_CHARS} characters.`,
    });
    return;
  }
  if (!requestRunSteer(runId)) {
    respondJson(res, 404, {
      error: 'no_active_run',
      message: 'No active steerable run with that id; it may have already finished.',
    });
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 200;
  res.end(JSON.stringify({ accepted: true, runId }));
}

/**
 * Explicit hard-stop endpoint. Connection loss is only a subscriber detach;
 * cancellation must arrive through this route so long-running execution
 * survives renderer reloads and transient transport failures.
 */
export async function handleCancelRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  boundaries?: Parameters<typeof cancelDesktopAssistantRun>[1]
): Promise<void> {
  let parsed: unknown;
  try {
    const body = await readRequestBody(req, { maxBodyBytes: STEER_BODY_LIMIT_BYTES });
    parsed = JSON.parse(body) as unknown;
  } catch {
    respondJson(res, 400, {
      error: 'invalid_cancel_action',
      message: 'Cancel request body must be a small JSON object.',
    });
    return;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1
  ) {
    respondJson(res, 400, {
      error: 'invalid_cancel_action',
      message: 'Cancel request accepts exactly one field: runId.',
    });
    return;
  }
  const runId = (parsed as Record<string, unknown>)['runId'];
  if (
    typeof runId !== 'string' ||
    runId.trim().length === 0 ||
    runId.length > STEER_RUN_ID_MAX_CHARS
  ) {
    respondJson(res, 400, {
      error: 'invalid_cancel_action',
      message: `Cancel runId must be a non-empty string of at most ${STEER_RUN_ID_MAX_CHARS} characters.`,
    });
    return;
  }
  let cancelled: boolean;
  try {
    cancelled = await cancelDesktopAssistantRun(runId, boundaries);
  } catch (error) {
    logger.error('Failed to persist assistant cancellation', { error, runId });
    respondJson(res, 503, {
      error: 'cancel_run_unavailable',
      message: 'Cancellation could not be recorded. Reload and try again.',
    });
    return;
  }
  if (!cancelled) {
    respondJson(res, 404, {
      error: 'no_active_run',
      message: 'No active cancellable run with that id; it may have already finished.',
    });
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 200;
  res.end(JSON.stringify({ accepted: true, runId }));
}
