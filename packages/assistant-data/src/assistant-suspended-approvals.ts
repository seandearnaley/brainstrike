import type { SuspendedRunDiscoveryError } from '@brainstrike/assistant-contract';
import {
  isRediscoveredToolApproval,
  type RediscoveredToolApproval,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  isRediscoveredToolSuspend,
  type RediscoveredToolSuspend,
} from '@brainstrike/assistant-contract/tool-suspend';
import { createLogger } from '@brainstrike/logging';
import { resolveAssistantAuthHeaders } from './assistant-auth-headers';

const logger = createLogger('SuspendedRuns');

/**
 * Deadline for the discovery fetch and response body. Resolving the local
 * endpoint and auth headers is owned by their bridge calls; this signal does
 * not cancel those promises. Request failure remains visible beside history.
 */
const DISCOVERY_TIMEOUT_MS = 3000;

export interface SuspendedRunDiscoveryResult {
  readonly approvals: readonly RediscoveredToolApproval[];
  readonly error?: SuspendedRunDiscoveryError;
  /** Non-approval suspend() pauses (BST-1084) — plan/question cards. */
  readonly suspends: readonly RediscoveredToolSuspend[];
}

/**
 * Rediscover pending tool approvals AND suspend() pauses for a thread from the
 * desktop assistant server (`GET /assistant/suspended-runs`). A transport or
 * validation failure is explicit so hydration can retain the conversation and
 * show that pending decisions could not be completely recovered.
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
    return { ...EMPTY_DISCOVERY, error: { reason: 'invalid-response' } };
  }
  let malformed = false;
  const approvals: RediscoveredToolApproval[] = [];
  for (const entry of payload['approvals']) {
    if (isRediscoveredToolApproval(entry)) {
      approvals.push(entry);
      continue;
    }
    malformed = true;
    logger.warn('Dropping a malformed suspended approval entry from discovery response');
  }
  // `suspends` is ADDITIVE (BST-1084): ABSENT from an older server is simply
  // empty, but a PRESENT malformed value — non-array or malformed entries —
  // is reported loudly like approvals, never silently treated as empty.
  const suspends: RediscoveredToolSuspend[] = [];
  const rawSuspends = payload['suspends'];
  if (rawSuspends !== undefined && !Array.isArray(rawSuspends)) {
    malformed = true;
    logger.warn('Suspended-runs response has a non-array suspends field', {
      suspendsType: typeof rawSuspends,
    });
  } else if (Array.isArray(rawSuspends)) {
    for (const entry of rawSuspends) {
      if (isRediscoveredToolSuspend(entry)) {
        suspends.push(entry);
        continue;
      }
      malformed = true;
      logger.warn('Dropping a malformed suspended pause entry from discovery response');
    }
  }
  return {
    approvals,
    ...(malformed ? { error: { reason: 'invalid-response' as const } } : {}),
    suspends,
  };
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
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const base = trimTrailingSlash(await resolveBaseUrl());
      const url = `${base}/assistant/suspended-runs?threadId=${encodeURIComponent(
        threadId
      )}&resourceId=${encodeURIComponent(resourceId)}`;
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json', ...(await resolveAuthHeaders()) },
        signal,
      });
      if (!response.ok) {
        logger.warn('Suspended-runs discovery request failed', { status: response.status });
        return { ...EMPTY_DISCOVERY, error: { reason: 'request-failed' } };
      }
      return parseSuspendedRuns(await response.json());
    } catch (error) {
      // Keep operational details in logs; callers receive a bounded UI reason.
      logger.warn('Suspended-runs discovery failed', { error });
      return {
        ...EMPTY_DISCOVERY,
        error: {
          reason: signal.aborted
            ? 'timed-out'
            : error instanceof SyntaxError
              ? 'invalid-response'
              : 'request-failed',
        },
      };
    }
  };
}
