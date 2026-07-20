import { useCallback } from 'react';
import {
  resolveAssistantAuthHeaders,
  resolveAssistantBaseUrl,
} from './hooks/use-assistant-availability';

/**
 * Mid-run steering transport (BST-588). Returns the `onSteerRequest` callback
 * the panel's SteerRunButton needs: POST the ACTIVE run's id to the desktop
 * assistant server's `/assistant/steer` control endpoint so the loop stops
 * gracefully at the next step boundary.
 *
 * Resolution contract: `true` = steer accepted; `false` = no active run
 * (nothing in flight locally, or the server already finished it — the queued
 * message dispatches on the natural run end either way); any OTHER transport
 * failure THROWS so the caller logs it visibly (never a silent degrade).
 */
/**
 * The steer control endpoint exists ONLY on the desktop assistant server, so
 * the capability signal is the desktop preload bridge — NOT the PGlite repo
 * (web is PGlite-backed too and must never render a steer affordance that
 * silently cannot stop the run; review P2, BST-588).
 */
export function hasDesktopAssistantBridge(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { assistant?: unknown }).assistant)
  );
}

export function useSteerActiveRun(
  getActiveRunContext: () => { readonly runId: string } | null | undefined
): () => Promise<boolean> {
  return useCallback(async () => {
    const runContext = getActiveRunContext();
    if (!runContext?.runId) {
      return false;
    }
    const [base, authHeaders] = await Promise.all([
      resolveAssistantBaseUrl(),
      resolveAssistantAuthHeaders(),
    ]);
    const response = await fetch(`${base}/assistant/steer`, {
      body: JSON.stringify({ runId: runContext.runId }),
      headers: { ...authHeaders, 'content-type': 'application/json' },
      method: 'POST',
    });
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw new Error(`Steer control request failed with HTTP ${response.status}.`);
    }
    return true;
  }, [getActiveRunContext]);
}
