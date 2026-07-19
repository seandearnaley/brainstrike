import {
  isRediscoveredToolApproval,
  type RediscoveredToolApproval,
} from '@brainstrike/assistant-contract/tool-approval';
import { createLogger } from '@brainstrike/utils/logger';
import { resolveAssistantAuthHeaders } from './hooks/use-assistant-availability';

const logger = createLogger('SuspendedApprovals');

/**
 * Hard ceiling on the discovery round-trip. The endpoint is a local loopback GET,
 * so a few seconds is generous; the cap exists so a wedged/mid-stream assistant
 * server can never hang thread hydration indefinitely (the run stays resumable
 * once the user re-sends, so a timeout degrades to zero cards, never a failure).
 */
const DISCOVERY_TIMEOUT_MS = 3000;

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
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = DISCOVERY_TIMEOUT_MS,
  resolveAuthHeaders: () => Promise<Record<string, string>> = resolveAssistantAuthHeaders
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
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json', ...(await resolveAuthHeaders()) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        logger.warn('Suspended approval discovery request failed', { status: response.status });
        return [];
      }
      return parseSuspendedApprovals(await response.json());
    } catch (error) {
      // Best-effort enhancement: a transport failure/timeout yields zero cards and
      // a single warning — never an error state for the thread (still resumable).
      logger.warn('Suspended approval discovery failed', { error });
      return [];
    }
  };
}
