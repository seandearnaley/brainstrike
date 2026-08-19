import type {
  ProviderVerificationLookup,
  ProviderVerificationSnapshot,
} from '@brainstrike/assistant-contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchProviderVerification } from '../provider-verification-client';
import { resolveAssistantAuthHeaders, resolveAssistantBaseUrl } from './use-assistant-availability';

/**
 * Run one verification probe, resolving the assistant transport first.
 *
 * A plain async FUNCTION, deliberately: settings-ui owns the Provider Hub's
 * probe UI but cannot import this package (app-shell depends on settings-ui,
 * so the reverse would close a cycle). Handing it a hook would break the rules
 * of hooks at the wiring site — a hook may not be passed as a value — whereas
 * a function is just data. The React state around it lives in the component
 * that renders it (`use-provider-verification-state` in settings-ui).
 */
export function verifyProviderCredential(
  providerId: string,
  signal: AbortSignal
): Promise<ProviderVerificationSnapshot> {
  return Promise.all([resolveAssistantBaseUrl(), resolveAssistantAuthHeaders()]).then(
    ([baseUrl, authHeaders]) =>
      fetchProviderVerification({ authHeaders, baseUrl, providerId, signal })
  );
}

const MAX_VISIBLE_ERROR_CHARS = 300;

/**
 * Stable identity for the not-yet-requested state (same lesson as
 * LOADING_LOOKUP in use-openrouter-model-metadata: a per-render literal
 * invalidates downstream memos).
 */
const IDLE_LOOKUP: ProviderVerificationLookup = { state: 'idle' };

function toVisibleError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Provider verification failed';
  return message.slice(0, MAX_VISIBLE_ERROR_CHARS);
}

interface UseProviderVerificationResult {
  readonly lookup: ProviderVerificationLookup;
  /** Imperative trigger for a "Test connection" affordance (BST-1362/1358). */
  readonly verify: () => void;
}

/**
 * BST-1357 consume-side seam for the per-provider credential probe. Unlike
 * {@link useOpenRouterModelMetadata} this is BUTTON-DRIVEN, not effect-driven:
 * the probe is advisory and must never fire on mere render. Switching
 * `providerId` resets the lookup to idle; an in-flight probe for a previous
 * provider is abandoned client-side (the endpoint response is cached
 * server-side, so abandonment wastes nothing).
 */
export function useProviderVerification(
  providerId: string | undefined
): UseProviderVerificationResult {
  const [state, setState] = useState<{
    readonly lookup: ProviderVerificationLookup;
    readonly providerId: string;
  }>();
  const requestSequence = useRef(0);
  const activeController = useRef<AbortController>(undefined);

  useEffect(() => {
    return () => {
      // Unmount invalidates and aborts any in-flight request.
      requestSequence.current += 1;
      activeController.current?.abort();
    };
  }, []);

  const verify = useCallback(() => {
    if (!providerId) {
      return;
    }
    requestSequence.current += 1;
    const sequence = requestSequence.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    setState({ lookup: { state: 'loading' }, providerId });
    void Promise.all([resolveAssistantBaseUrl(), resolveAssistantAuthHeaders()])
      .then(([baseUrl, authHeaders]) =>
        fetchProviderVerification({ authHeaders, baseUrl, providerId, signal: controller.signal })
      )
      .then((snapshot) => {
        if (requestSequence.current === sequence) {
          setState({ lookup: { snapshot, state: 'resolved' }, providerId });
        }
      })
      .catch((error: unknown) => {
        if (requestSequence.current === sequence) {
          setState({ lookup: { message: toVisibleError(error), state: 'error' }, providerId });
        }
      });
  }, [providerId]);

  const lookup: ProviderVerificationLookup =
    providerId && state?.providerId === providerId ? state.lookup : IDLE_LOOKUP;
  return { lookup, verify };
}
