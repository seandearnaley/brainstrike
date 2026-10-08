import { randomUUID } from 'node:crypto';
import type { HostClientOrigin } from '@brainstrike/agent-host';
import { createCodexFetch } from './codex-fetch.js';
import { buildCodexUserAgent, OPENAI_CODEX_PROVIDER_ID } from './descriptors/openai-codex.js';
import { assertInteractiveProviderAuthOrigin } from './provider-auth-engine.js';
import type { FreshAccessTokenResult } from './refresh.js';

/**
 * Interactive-desktop-only credential resolution for subscription OAuth —
 * BST-1356, legal gate BST-1351 constraint 4.
 *
 * This factory is the capability the shared credential projection
 * (`providerAuthInputFromCredential`) requires before it will mint a
 * subscription auth input. Two independent gates hold the constraint:
 *
 * 1. STRUCTURAL — only a host the desktop launched has an engine with a
 *    browser opener and a private desktop client; the CLI never resolves one.
 * 2. PER-ORIGIN — each factory is built for one resolution's client origin
 *    and refuses anything but `desktop-ui`: a port the launching desktop
 *    handed the host privately. A CLI attached to the desktop's own host, or
 *    restart recovery with no live client, fails closed EVEN WHILE a normal
 *    window is open.
 */

interface SubscriptionOAuthCredential {
  readonly accountId?: string;
  readonly type: 'oauth';
}

export interface InteractiveSubscriptionFetchDeps {
  /** The host's version; used for honest client identification. */
  readonly appVersion: string;
  /** Wired to the shared engine's single-flight, refresh-aware accessor. */
  readonly getFreshAccessToken: (providerId: string) => Promise<FreshAccessTokenResult>;
  /** Test seam for the per-session correlation id Codex expects. */
  readonly newSessionId?: () => string;
  /** The client origin this resolution is performed FOR; `undefined` fails closed. */
  readonly origin: HostClientOrigin | undefined;
}

export function createInteractiveSubscriptionFetchFactory(
  deps: InteractiveSubscriptionFetchDeps
): (provider: string, credential: SubscriptionOAuthCredential) => typeof globalThis.fetch {
  const newSessionId = deps.newSessionId ?? (() => randomUUID());

  return function buildSubscriptionFetch(
    provider: string,
    credential: SubscriptionOAuthCredential
  ): typeof globalThis.fetch {
    // Gate 2 (per resolution). Throws with the engine's canonical
    // constraint-4 message for any origin but a private desktop client.
    assertInteractiveProviderAuthOrigin(deps.origin);

    if (provider !== OPENAI_CODEX_PROVIDER_ID) {
      throw new Error(
        `Subscription OAuth fetch is only defined for "${OPENAI_CODEX_PROVIDER_ID}"; got "${provider}".`
      );
    }

    return createCodexFetch({
      getAccessToken: async () => {
        const result = await deps.getFreshAccessToken(provider);
        if (result.ok) {
          return result.accessToken;
        }
        // NO SILENT FALLBACKS: never send an unauthenticated or stale request.
        // Neither branch echoes token material.
        if (result.status === 'reconnect_required') {
          throw new Error(
            `The ChatGPT subscription session for "${provider}" expired and needs to be reconnected. Reconnect the account in Settings.`
          );
        }
        throw new Error(
          `No ChatGPT subscription is connected for "${provider}". Connect an account in Settings.`
        );
      },
      getAccountId: () => credential.accountId,
      sessionId: newSessionId(),
      userAgent: buildCodexUserAgent(deps.appVersion),
    });
  };
}
