import type {
  OAuthProviderDescriptor,
  ProviderAuthStartMethod,
  ProviderAuthStatus,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { SecretReadError, type SecretsService } from '../secrets';
import type { DesktopWindowRole } from '../window-role';
import { getOAuthProviderDescriptor } from './descriptor-registry';
import { isProviderAuthFlowCancelled, ProviderAuthFlowError } from './errors';
import type { startLoopbackServer } from './loopback-server';
import { runDeviceOAuthFlow, runLoopbackOAuthFlow } from './oauth-flow';
import { createTokenRefresher, type FreshAccessTokenResult } from './refresh';

/**
 * Provider-auth engine (BST-1355): the desktop-main state machine that owns
 * every OAuth flow and every token. The renderer talks to it exclusively
 * through the `provider-auth` IPC domain and sees ONLY token-free
 * {@link ProviderAuthStatus} payloads — token material never crosses IPC
 * (legal gate BST-1351, constraint 3).
 */

const logger = createLogger('ProviderAuthEngine');

/**
 * Interactive-desktop-only enforcement (legal gate constraint 4): OAuth
 * subscription flows and their credentials are only reachable from the
 * visible interactive UI. The provider-auth IPC channels register with
 * exactly this role set (pinned by test), and the credential-resolution layer
 * (BST-1356) must call {@link assertInteractiveProviderAuthSender} before
 * resolving an OAuth credential for a request, so any future headless,
 * scheduled, server, or multi-user execution context fails closed.
 */
export const PROVIDER_AUTH_INTERACTIVE_ROLES = [
  'visible-ui',
] as const satisfies readonly DesktopWindowRole[];

export function assertInteractiveProviderAuthSender(
  role: DesktopWindowRole | string | undefined
): void {
  if (role !== undefined && (PROVIDER_AUTH_INTERACTIVE_ROLES as readonly string[]).includes(role)) {
    return;
  }
  throw new Error(
    `Provider OAuth flows require an interactive desktop origin (${PROVIDER_AUTH_INTERACTIVE_ROLES.join(
      ', '
    )}); got ${role ?? 'no tracked role'}. Subscription auth is structurally unavailable to non-interactive contexts.`
  );
}

export interface ProviderAuthEngineDeps {
  readonly fetchFn?: typeof fetch;
  /** Per-request network timeout for the engine's fetches. */
  readonly fetchTimeoutMs?: number;
  /** Descriptor lookup; defaults to the engine registry (empty in BST-1355). */
  readonly getDescriptor?: (providerId: string) => OAuthProviderDescriptor;
  readonly loopbackTimeoutMs?: number;
  readonly now?: () => number;
  /** The app's validated external-browser opener (shell.openExternal path).
   * NEVER an embedded webview. */
  readonly openExternal: (url: string) => Promise<void>;
  readonly secrets: SecretsService;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam; defaults to the real loopback server. */
  readonly startLoopbackServerFn?: typeof startLoopbackServer;
}

export interface ProviderAuthEngine {
  readonly cancel: (providerId: string) => Promise<ProviderAuthStatus>;
  readonly disconnect: (providerId: string) => Promise<ProviderAuthStatus>;
  /** Single-flight refresh-aware token access for the credential-resolution
   * layer (BST-1356). Main-process only — the result never crosses IPC. */
  readonly getFreshAccessToken: (providerId: string) => Promise<FreshAccessTokenResult>;
  readonly getStatus: (providerId: string) => Promise<ProviderAuthStatus>;
  readonly start: (
    providerId: string,
    method?: ProviderAuthStartMethod
  ) => Promise<ProviderAuthStatus>;
}

interface ActiveFlow {
  readonly completion: Promise<void>;
  readonly controller: AbortController;
  status: ProviderAuthStatus;
}

export function createProviderAuthEngine(deps: ProviderAuthEngineDeps): ProviderAuthEngine {
  const fetchFn = deps.fetchFn ?? fetch;
  const getDescriptor = deps.getDescriptor ?? getOAuthProviderDescriptor;
  const activeFlows = new Map<string, ActiveFlow>();
  /** Sticky terminal error per provider, cleared by the next start/disconnect
   * or a successful flow. */
  const stickyErrors = new Map<string, ProviderAuthStatus & { state: 'error' }>();
  const reconnectRequired = new Set<string>();
  /** Per-provider generation; disconnect bumps it so an in-flight refresh
   * completing afterwards discards its result (security-review finding 5). */
  const epochs = new Map<string, number>();

  const refresher = createTokenRefresher({
    fetchFn,
    ...(deps.fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs: deps.fetchTimeoutMs }),
    getDescriptor,
    getEpoch: (providerId) => epochs.get(providerId) ?? 0,
    ...(deps.now ? { now: deps.now } : {}),
    onPersistFailure: (providerId) => {
      // The rotated pair lives in the refresher's memory overlay; the session
      // keeps working, but the user must learn persistence failed.
      stickyErrors.set(providerId, { code: 'credential_persist_failed', state: 'error' });
      logger.error('Provider OAuth refresh rotated but could not be persisted', { providerId });
    },
    onPersistRecovered: (providerId) => {
      const sticky = stickyErrors.get(providerId);
      if (sticky?.code === 'credential_persist_failed') {
        stickyErrors.delete(providerId);
      }
      logger.info('Provider OAuth credential persistence recovered', { providerId });
    },
    onReconnectRequired: (providerId) => {
      reconnectRequired.add(providerId);
      logger.warn('Provider OAuth refresh token rejected; reconnect required', { providerId });
    },
    secrets: deps.secrets,
  });

  async function deriveIdleStatus(providerId: string): Promise<ProviderAuthStatus> {
    let credential: Awaited<ReturnType<SecretsService['getCredential']>>;
    try {
      credential = await deps.secrets.getCredential(providerId);
    } catch (error) {
      if (error instanceof SecretReadError) {
        logger.error('Provider OAuth credential unreadable', {
          code: error.code,
          providerId,
        });
        return { code: 'credential_unreadable', state: 'error' };
      }
      throw error;
    }
    if (credential === null || credential.type !== 'oauth') {
      return { state: 'disconnected' };
    }
    return {
      state: 'connected',
      ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
    };
  }

  async function getStatus(providerId: string): Promise<ProviderAuthStatus> {
    const active = activeFlows.get(providerId);
    if (active) {
      return active.status;
    }
    const sticky = stickyErrors.get(providerId);
    if (sticky) {
      return sticky;
    }
    if (reconnectRequired.has(providerId)) {
      return { state: 'reconnect_required' };
    }
    return await deriveIdleStatus(providerId);
  }

  function toErrorStatus(error: unknown): ProviderAuthStatus & { state: 'error' } {
    if (error instanceof ProviderAuthFlowError) {
      return { code: error.code, state: 'error' };
    }
    return { code: 'flow_failed', state: 'error' };
  }

  async function start(
    providerId: string,
    method: ProviderAuthStartMethod = 'loopback'
  ): Promise<ProviderAuthStatus> {
    if (activeFlows.has(providerId)) {
      return { code: 'flow_already_active', state: 'error' };
    }

    let descriptor: OAuthProviderDescriptor;
    try {
      descriptor = getDescriptor(providerId);
    } catch (error) {
      logger.warn('Provider OAuth start rejected', { providerId });
      return toErrorStatus(error);
    }
    if (method === 'device' && !descriptor.deviceFlow) {
      return { code: 'device_flow_unsupported', state: 'error' };
    }

    const controller = new AbortController();
    let resolveFirstTransition: ((status: ProviderAuthStatus) => void) | undefined;
    const firstTransition = new Promise<ProviderAuthStatus>((resolve) => {
      resolveFirstTransition = resolve;
    });
    const announce = (status: ProviderAuthStatus): void => {
      const flow = activeFlows.get(providerId);
      if (flow) {
        flow.status = status;
      }
      resolveFirstTransition?.(status);
      resolveFirstTransition = undefined;
    };

    const flowDeps = {
      cancelSignal: controller.signal,
      fetchFn,
      ...(deps.fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs: deps.fetchTimeoutMs }),
      ...(deps.loopbackTimeoutMs === undefined
        ? {}
        : { loopbackTimeoutMs: deps.loopbackTimeoutMs }),
      ...(deps.now ? { now: deps.now } : {}),
      onAwaitingBrowser: () => announce({ state: 'awaiting_browser' }),
      onAwaitingDeviceCode: (info: { userCode: string; verificationUri: string }) =>
        announce({
          state: 'awaiting_device_code',
          userCode: info.userCode,
          verificationUri: info.verificationUri,
        }),
      openExternal: deps.openExternal,
      secrets: deps.secrets,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.startLoopbackServerFn ? { startLoopbackServerFn: deps.startLoopbackServerFn } : {}),
    };

    const completion = (async () => {
      try {
        const completed =
          method === 'device'
            ? await runDeviceOAuthFlow(descriptor, flowDeps)
            : await runLoopbackOAuthFlow(descriptor, flowDeps);
        stickyErrors.delete(providerId);
        reconnectRequired.delete(providerId);
        announce({
          state: 'connected',
          ...(completed.accountId === undefined ? {} : { accountId: completed.accountId }),
        });
        logger.info('Provider OAuth flow completed', { method, providerId });
      } catch (error) {
        if (isProviderAuthFlowCancelled(error)) {
          logger.info('Provider OAuth flow cancelled', { method, providerId });
          announce({ state: 'disconnected' });
          return;
        }
        const status = toErrorStatus(error);
        stickyErrors.set(providerId, status);
        announce(status);
        logger.error('Provider OAuth flow failed', {
          code: status.code,
          message: error instanceof Error ? error.message : String(error),
          method,
          providerId,
        });
      } finally {
        activeFlows.delete(providerId);
      }
    })();

    activeFlows.set(providerId, { completion, controller, status: { state: 'connecting' } });
    stickyErrors.delete(providerId);
    return await firstTransition;
  }

  async function cancel(providerId: string): Promise<ProviderAuthStatus> {
    const active = activeFlows.get(providerId);
    if (active) {
      active.controller.abort();
      await active.completion;
    }
    return await getStatus(providerId);
  }

  async function disconnect(providerId: string): Promise<ProviderAuthStatus> {
    const active = activeFlows.get(providerId);
    if (active) {
      active.controller.abort();
      await active.completion;
    }
    // Invalidate BEFORE deleting: an in-flight refresh that completes after
    // this point sees a stale epoch and discards its result, so it can never
    // resurrect the deleted credential (security-review finding 5).
    epochs.set(providerId, (epochs.get(providerId) ?? 0) + 1);
    refresher.invalidate(providerId);
    await deps.secrets.deleteKey(providerId);
    stickyErrors.delete(providerId);
    reconnectRequired.delete(providerId);
    logger.info('Provider OAuth credential disconnected', { providerId });
    return await getStatus(providerId);
  }

  return {
    cancel,
    disconnect,
    getFreshAccessToken: async (providerId) => {
      const result = await refresher.getFreshAccessToken(providerId);
      if (result.ok) {
        reconnectRequired.delete(providerId);
      }
      return result;
    },
    getStatus,
    start,
  };
}
