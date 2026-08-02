import {
  isRediscoveredToolApproval,
  type RediscoveredToolApproval,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  isRediscoveredToolSuspend,
  type RediscoveredToolSuspend,
} from '@brainstrike/assistant-contract/tool-suspend';
import { createLogger } from '@brainstrike/utils/logger';
import { resolveAssistantAuthHeaders } from './hooks/use-assistant-availability';

const logger = createLogger('SuspendedRuns');

/**
 * Hard ceiling on the discovery round-trip. The endpoint is a local loopback GET,
 * so a few seconds is generous; the cap exists so a wedged/mid-stream assistant
 * server can never hang thread hydration indefinitely (the run stays resumable
 * once the user re-sends, so a timeout degrades to zero cards, never a failure).
 */
const DISCOVERY_TIMEOUT_MS = 3000;

export interface SuspendedRunDiscoveryResult {
  readonly approvals: readonly RediscoveredToolApproval[];
  /** Non-approval suspend() pauses (BST-1084) — plan/question cards. */
  readonly suspends: readonly RediscoveredToolSuspend[];
}

/**
 * Rediscover pending tool approvals AND suspend() pauses for a thread from the
 * desktop assistant server (`GET /assistant/suspended-runs`). Best-effort UI
 * enhancement: the run is still resumable once the user re-sends, so a
 * transport failure returns empty arrays — but the failure is LOGGED, never
 * swallowed as a silent success.
 */
export type SuspendedRunDiscovery = (
  threadId: string,
  resourceId: string
) => Promise<SuspendedRunDiscoveryResult>;

const EMPTY_DISCOVERY: SuspendedRunDiscoveryResult = { approvals: [], suspends: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

function parseSuspendedRuns(payload: unknown): SuspendedRunDiscoveryResult {
  if (!(isRecord(payload) && Array.isArray(payload['approvals']))) {
    logger.warn('Suspended-runs response is missing an approvals array', {
      payloadType: typeof payload,
    });
    return EMPTY_DISCOVERY;
  }
  const approvals: RediscoveredToolApproval[] = [];
  for (const entry of payload['approvals']) {
    if (isRediscoveredToolApproval(entry)) {
      approvals.push(entry);
      continue;
    }
    logger.warn('Dropping a malformed suspended approval entry from discovery response');
  }
  // `suspends` is ADDITIVE (BST-1084): absent from an older server is simply
  // empty, but a present-and-malformed entry is dropped loudly like approvals.
  const suspends: RediscoveredToolSuspend[] = [];
  const rawSuspends = payload['suspends'];
  if (Array.isArray(rawSuspends)) {
    for (const entry of rawSuspends) {
      if (isRediscoveredToolSuspend(entry)) {
        suspends.push(entry);
        continue;
      }
      logger.warn('Dropping a malformed suspended pause entry from discovery response');
    }
  }
  return { approvals, suspends };
}

export function createSuspendedRunDiscovery(
  resolveBaseUrl: () => Promise<string>,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = DISCOVERY_TIMEOUT_MS,
  resolveAuthHeaders: () => Promise<Record<string, string>> = resolveAssistantAuthHeaders
): SuspendedRunDiscovery {
  return async (threadId, resourceId) => {
    if (!(threadId && resourceId)) {
      return EMPTY_DISCOVERY;
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
        logger.warn('Suspended-runs discovery request failed', { status: response.status });
        return EMPTY_DISCOVERY;
      }
      return parseSuspendedRuns(await response.json());
    } catch (error) {
      // Best-effort enhancement: a transport failure/timeout yields zero cards and
      // a single warning — never an error state for the thread (still resumable).
      logger.warn('Suspended-runs discovery failed', { error });
      return EMPTY_DISCOVERY;
    }
  };
}
