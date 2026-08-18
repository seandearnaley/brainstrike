import { createLogger } from '@brainstrike/logging';
import type { SecretsService } from '../secrets';
import { resolveAssistantAuthOriginRole } from './assistant-auth-origin';
import {
  clearOAuthProviderDescriptorsForTest,
  listOAuthProviderDescriptorIds,
  registerOAuthProviderDescriptor,
} from './descriptor-registry';
import { buildCodexUserAgent, createOpenAiCodexDescriptor } from './descriptors/openai-codex';
import { createProviderAuthEngine, type ProviderAuthEngine } from './provider-auth-engine';
import { createInteractiveSubscriptionFetchFactory } from './subscription-fetch';

/**
 * Desktop-main provider-auth runtime (BST-1356).
 *
 * ONE engine instance is shared by the `provider-auth` IPC domain and the
 * assistant server's credential resolution. That sharing is load-bearing, not
 * tidiness: the engine owns the single-flight refresher (`inFlight`) and the
 * rotated-pair memory overlay. A second engine would refresh concurrently and
 * REPLAY a rotating refresh token — precisely what the single-flight design
 * exists to prevent.
 *
 * The subscription-fetch factory is exposed as an OPTIONAL capability: it is
 * `undefined` until this runtime is initialized, so any context that never
 * initializes it (web, tests, a future headless mode) cannot resolve a
 * subscription credential at all (legal gate BST-1351, constraint 4).
 */

const logger = createLogger('ProviderAuthRuntime');

type SubscriptionFetchFactory = ReturnType<typeof createInteractiveSubscriptionFetchFactory>;

let engine: ProviderAuthEngine | undefined;
let subscriptionFetchFactory: SubscriptionFetchFactory | undefined;

export interface ProviderAuthRuntimeDeps {
  readonly appVersion: string;
  /** The app's validated `shell.openExternal` path — never a webview. */
  readonly openExternal: (url: string) => Promise<void>;
  readonly secrets: SecretsService;
}

export function initializeProviderAuthRuntime(deps: ProviderAuthRuntimeDeps): ProviderAuthEngine {
  if (engine) {
    throw new Error('The provider-auth runtime is already initialized.');
  }
  // The first real descriptor. Registering here (rather than at module import)
  // keeps the honest User-Agent tied to the resolved app version.
  registerOAuthProviderDescriptor(
    createOpenAiCodexDescriptor({ userAgent: buildCodexUserAgent(deps.appVersion) })
  );

  const created = createProviderAuthEngine({
    openExternal: deps.openExternal,
    secrets: deps.secrets,
  });
  engine = created;
  subscriptionFetchFactory = createInteractiveSubscriptionFetchFactory({
    appVersion: deps.appVersion,
    getFreshAccessToken: (providerId) => created.getFreshAccessToken(providerId),
    // Per-ORIGIN, re-evaluated per credential resolution and never captured:
    // the role of whoever actually holds the assistant bearer token, not a
    // process-wide window probe (PR #2527 review, finding 5).
    resolveOriginRole: resolveAssistantAuthOriginRole,
  });
  return created;
}

export function getProviderAuthEngine(): ProviderAuthEngine {
  if (!engine) {
    throw new Error('The provider-auth runtime has not been initialized.');
  }
  return engine;
}

/**
 * The subscription-fetch capability, or `undefined` when this process never
 * initialized the runtime. Handed straight to
 * `providerAuthInputFromCredential`, whose oauth arm REJECTS the credential
 * when the capability is absent — so "not initialized" fails closed.
 */
export function getSubscriptionFetchFactory(): SubscriptionFetchFactory | undefined {
  return subscriptionFetchFactory;
}

/**
 * Factory-reset hook. Wiping `brainstrike-secrets.json` is not enough: a
 * rotated access/refresh pair whose store write failed lives in the
 * refresher's in-memory overlay and would otherwise remain the ACTIVE
 * credential for the rest of the process lifetime — surviving a reset the
 * user believes wiped it. `disconnect` bumps the provider epoch, invalidates
 * that overlay, and deletes the stored credential.
 */
export async function purgeProviderAuthRuntimeState(): Promise<void> {
  if (!engine) {
    return;
  }
  const current = engine;
  await Promise.all(
    listOAuthProviderDescriptorIds().map(async (providerId) => {
      try {
        await current.disconnect(providerId);
      } catch (error) {
        // Never block a factory reset on one provider; surface it instead.
        logger.error('Failed to purge provider OAuth state during factory reset', {
          providerId,
          ...(error instanceof Error ? { message: error.message } : {}),
        });
      }
    })
  );
}

/** Test-only teardown so a fixture runtime never leaks across tests. */
export function resetProviderAuthRuntimeForTest(): void {
  engine = undefined;
  subscriptionFetchFactory = undefined;
  clearOAuthProviderDescriptorsForTest();
}
