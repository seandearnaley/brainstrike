import type http from 'node:http';
import type {
  AssistantRunStatusProjection,
  AssistantRunStatusResponse,
} from '@brainstrike/assistant-contract';
import { respondJson } from '@brainstrike/assistant-service/http';
import { desktopAssistantServerLogger as logger } from './logger';
import { readDesktopAssistantThreadRunStatus } from './run-persistence';

type RunStatusDatabaseProvider = Parameters<typeof readDesktopAssistantThreadRunStatus>[1];

const KNOWN_RUN_STATUSES: readonly AssistantRunStatusProjection[] = [
  'cancelled',
  'completed',
  'failed',
  'running',
];

/**
 * GET /assistant/run-status?runId=… — the durable-run-row projection behind
 * the renderer's reattachment-record reclaim (2026-08-18 field failure: a
 * dev-reload orphaned record blocked every new run until app restart). The
 * durable row is the same authority the Threads-panel projection reads
 * (BST-1244); `unknown` means no row exists. Read failures and unexpected
 * stored statuses 500 — a fabricated or coerced status could reclaim a live
 * run, so this endpoint never degrades silently.
 */
export async function handleRunStatusRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  getDatabase: RunStatusDatabaseProvider
): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
  const runId = query.get('runId')?.trim() ?? '';
  if (!runId) {
    respondJson(res, 400, {
      error: 'missing_run_id',
      message: 'The runId query parameter is required.',
    });
    return;
  }

  let status: string | undefined;
  try {
    status = await readDesktopAssistantThreadRunStatus(runId, getDatabase);
  } catch (error: unknown) {
    logger.error('Failed to read assistant run status', { error, runId });
    respondJson(res, 500, {
      error: 'run_status_unavailable',
      message: 'The assistant run status could not be read.',
    });
    return;
  }

  if (status !== undefined && !(KNOWN_RUN_STATUSES as readonly string[]).includes(status)) {
    logger.error('Assistant run has an unexpected durable status', { runId, status });
    respondJson(res, 500, {
      error: 'run_status_unrecognized',
      message: 'The assistant run has an unrecognized durable status.',
    });
    return;
  }

  const payload: AssistantRunStatusResponse = {
    runId,
    status: status === undefined ? 'unknown' : (status as AssistantRunStatusProjection),
  };
  // Success writes mirror the other status endpoints: respondJson is the
  // error writer (its payload requires error+message).
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 200;
  res.end(JSON.stringify(payload));
}
