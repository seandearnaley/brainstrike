import {
  isRediscoveredToolApproval,
  type RediscoveredToolApproval,
} from '@brainstrike/assistant-contract/tool-approval';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('SuspendedApprovals');

/**
 * Rediscover pending tool approvals for a thread from the desktop assistant
 * server (`GET /assistant/suspended-runs`). Best-effort UI enhancement: the run
 * is still resumable once the user re-sends, so a transport failure returns `[]`
 * — but the failure is LOGGED, never swallowed as a silent success.
 */
export type SuspendedApprovalDiscovery = (
  threadId: string,
  resourceId: string
) => Promise<readonly RediscoveredToolApproval[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

function parseSuspendedApprovals(payload: unknown): readonly RediscoveredToolApproval[] {
  if (!(isRecord(payload) && Array.isArray(payload['approvals']))) {
    logger.warn('Suspended approval response is missing an approvals array', {
      payloadType: typeof payload,
    });
    return [];
  }
  const approvals: RediscoveredToolApproval[] = [];
  for (const entry of payload['approvals']) {
    if (isRediscoveredToolApproval(entry)) {
      approvals.push(entry);
      continue;
    }
    logger.warn('Dropping a malformed suspended approval entry from discovery response');
  }
  return approvals;
}

export function createSuspendedApprovalDiscovery(
  resolveBaseUrl: () => Promise<string>,
  fetchImpl: typeof fetch = globalThis.fetch
): SuspendedApprovalDiscovery {
  return async (threadId, resourceId) => {
    if (!(threadId && resourceId)) {
      return [];
    }
    try {
      const base = trimTrailingSlash(await resolveBaseUrl());
      const url = `${base}/assistant/suspended-runs?threadId=${encodeURIComponent(
        threadId
      )}&resourceId=${encodeURIComponent(resourceId)}`;
      const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        logger.error('Suspended approval discovery request failed', { status: response.status });
        return [];
      }
      return parseSuspendedApprovals(await response.json());
    } catch (error) {
      logger.error('Suspended approval discovery failed', { error });
      return [];
    }
  };
}
