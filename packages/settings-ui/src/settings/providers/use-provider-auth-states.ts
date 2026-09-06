import type { ProviderAuthState } from '@brainstrike/assistant-contract/provider-auth';
import { listProviders } from '@brainstrike/assistant-contract/provider-metadata';
import { useEffect, useMemo, useState } from 'react';
import { getProviderAuthCapability } from '../secrets/credential-inventory/provider-auth-capability';

const EMPTY_STATES: ReadonlyMap<string, ProviderAuthState> = new Map();

/**
 * How often the card FACE re-asks for sign-in state.
 *
 * A poll rather than a subscription because the connect/disconnect buttons
 * live inside the composed credential row, which owns its own controller and
 * emits no change signal — and unlike a stored key, an OAuth session can also
 * expire on its own while this page is open. Matches the row's own transient
 * poll interval so the two cannot visibly disagree for long.
 */
const AUTH_POLL_INTERVAL_MS = 1500;

/** Registry providers that authenticate by sign-in. Today: `openai-codex`. */
function listOAuthProviderIds(): readonly string[] {
  const ids: string[] = [];
  for (const definition of listProviders()) {
    if (definition.authType === 'oauth_subscription') {
      ids.push(definition.id);
    }
  }
  return ids;
}

/**
 * Sign-in state per `oauth_subscription` provider, for the Provider Hub card
 * headers (BST-1358 / BST-1356).
 *
 * WHY A SEPARATE READER: subscription tokens never appear in the
 * `secrets.list()` payload that drives every other card's state, so without
 * this a signed-in ChatGPT account would render as "Not connected" forever.
 * The row's own `useProviderAuthStatus` controller cannot be reused here — it
 * is created inside `CredentialInventory` — so this asks the same bridge for
 * status only, never driving a flow.
 *
 * Absent bridge (web) yields an EMPTY map, which resolves to `unknown` rather
 * than `disconnected`: no bridge means no verdict is obtainable.
 */
export function useProviderAuthStates(): ReadonlyMap<string, ProviderAuthState> {
  // The preload bridge cannot appear mid-session, so it is resolved once.
  const bridge = useMemo(() => getProviderAuthCapability(), []);
  const providerIds = useMemo(() => listOAuthProviderIds(), []);
  const [states, setStates] = useState<ReadonlyMap<string, ProviderAuthState>>(EMPTY_STATES);

  useEffect(() => {
    if (!bridge || providerIds.length === 0) {
      return;
    }
    let active = true;
    const read = async () => {
      const entries = await Promise.all(
        providerIds.map(async (providerId): Promise<[string, ProviderAuthState] | null> => {
          try {
            const status = await bridge.status(providerId);
            return [providerId, status.state];
          } catch {
            // A transport failure is NOT evidence of being signed out; the
            // entry is omitted so the card reads "unknown".
            return null;
          }
        })
      );
      if (!active) {
        return;
      }
      setStates((previous) => {
        const next = new Map<string, ProviderAuthState>();
        for (const entry of entries) {
          if (entry) {
            next.set(entry[0], entry[1]);
          }
        }
        // Preserve identity when nothing moved, so card memos do not churn on
        // every poll tick.
        if (
          next.size === previous.size &&
          [...next].every(([key, value]) => previous.get(key) === value)
        ) {
          return previous;
        }
        return next;
      });
    };
    void read();
    const timer = setInterval(() => void read(), AUTH_POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [bridge, providerIds]);

  return states;
}
