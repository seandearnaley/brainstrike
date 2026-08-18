import { randomUUID } from 'node:crypto';
import { createCodexFetch } from './codex-fetch';
import { buildCodexUserAgent, OPENAI_CODEX_PROVIDER_ID } from './descriptors/openai-codex';
import { assertInteractiveProviderAuthSender } from './provider-auth-engine';
import type { FreshAccessTokenResult } from './refresh';

/**
 * Interactive-desktop-only credential resolution for subscription OAuth —
 * BST-1356, legal gate BST-1351 constraint 4.
 *
 * This factory is the capability the shared credential projection
 * (`providerAuthInputFromCredential`) requires before it will mint a
 * subscription auth input. Two independent gates hold the constraint:
 *
 * 1. STRUCTURAL — only the interactive desktop assistant-server constructs
 *    this factory at all. Web and any headless host inject nothing, so the
 *    projection rejects the credential outright.
 * 2. LIVE — every resolution re-checks that an interactive `visible-ui`
 *    window actually exists, so a desktop process running without visible UI
 *    (a future scheduled or background mode) fails closed even though it
 *    shares this code path. It is re-checked PER RESOLUTION rather than
 *    captured once, so a window closing mid-session cannot leave a stale
 *    "yes" behind.
 *
 * The assistant server's own bearer token is already `visible-ui`-only
 * (`assistant:get-auth` is a role-gated IPC channel), so gate 2 is a second
 * lock on a door that is already bolted — deliberately, because the gate doc
 * requires the enforcement to live at the credential-resolution layer.
 */

interface SubscriptionOAuthCredential {
  readonly accountId?: string;
  readonly type: 'oauth';
}

export interface InteractiveSubscriptionFetchDeps {
  /** `app.getVersion()`; used for honest client identification. */
  readonly appVersion: string;
  /** Wired to the shared engine's single-flight, refresh-aware accessor. */
  readonly getFreshAccessToken: (providerId: string) => Promise<FreshAccessTokenResult>;
  /** True when at least one interactive `visible-ui` window is tracked. */
  readonly hasInteractiveWindow: () => boolean;
  /** Test seam for the per-session correlation id Codex expects. */
  readonly newSessionId?: () => string;
}

export function createInteractiveSubscriptionFetchFactory(
  deps: InteractiveSubscriptionFetchDeps
): (provider: string, credential: SubscriptionOAuthCredential) => typeof globalThis.fetch {
  const newSessionId = deps.newSessionId ?? (() => randomUUID());

  return function buildSubscriptionFetch(
    provider: string,
    credential: SubscriptionOAuthCredential
  ): typeof globalThis.fetch {
    // Gate 2 (live). Throws with the engine's canonical constraint-4 message.
    assertInteractiveProviderAuthSender(deps.hasInteractiveWindow() ? 'visible-ui' : undefined);

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
