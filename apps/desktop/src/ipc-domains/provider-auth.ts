import type { ProviderAuthStartMethod, ProviderAuthStatus } from '@brainstrike/assistant-contract';
import { ipcMain } from 'electron';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  createDesktopIpcRegistry,
  type DesktopIpcSenderPolicy,
} from '../platform/desktop-ipc-registry';
import {
  PROVIDER_AUTH_INTERACTIVE_ROLES,
  type ProviderAuthEngine,
} from '../provider-auth/provider-auth-engine';

/**
 * Typed `provider-auth` IPC domain (BST-1355).
 *
 * Every channel is a sensitive invoke registered with the fail-closed
 * visible-ui-only sender policy ({@link PROVIDER_AUTH_INTERACTIVE_ROLES} —
 * the legal gate's interactive-desktop-only constraint, enforced by the
 * registry BEFORE the handler sees renderer arguments). The renderer sees
 * ONLY token-free {@link ProviderAuthStatus} payloads; tokens live and die in
 * the main process.
 */

const INTERACTIVE_POLICY: DesktopIpcSenderPolicy = {
  roles: PROVIDER_AUTH_INTERACTIVE_ROLES,
};

function assertProviderId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('provider-auth IPC requires a non-empty provider id string.');
  }
  return value;
}

function assertStartMethod(value: unknown): ProviderAuthStartMethod | undefined {
  if (value === undefined || value === 'loopback' || value === 'device') {
    return value;
  }
  // NO SILENT FALLBACKS: an unrecognized method is a caller bug, not a
  // default-to-loopback situation.
  throw new TypeError('provider-auth IPC start method must be "loopback" or "device".');
}

export interface RegisterProviderAuthIpcHandlersOptions {
  readonly engine: ProviderAuthEngine;
}

export function registerProviderAuthIpcHandlers({
  engine,
}: RegisterProviderAuthIpcHandlersOptions): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerAuthorizedInvoke(
    'providerAuth',
    DESKTOP_IPC_CHANNELS.providerAuth.start,
    INTERACTIVE_POLICY,
    async (_event, provider: unknown, method?: unknown): Promise<ProviderAuthStatus> => {
      const resolvedMethod = assertStartMethod(method);
      return await engine.start(
        assertProviderId(provider),
        ...(resolvedMethod === undefined ? [] : ([resolvedMethod] as const))
      );
    }
  );

  registry.registerAuthorizedInvoke(
    'providerAuth',
    DESKTOP_IPC_CHANNELS.providerAuth.cancel,
    INTERACTIVE_POLICY,
    async (_event, provider: unknown): Promise<ProviderAuthStatus> =>
      await engine.cancel(assertProviderId(provider))
  );

  registry.registerAuthorizedInvoke(
    'providerAuth',
    DESKTOP_IPC_CHANNELS.providerAuth.status,
    INTERACTIVE_POLICY,
    async (_event, provider: unknown): Promise<ProviderAuthStatus> =>
      await engine.getStatus(assertProviderId(provider))
  );

  registry.registerAuthorizedInvoke(
    'providerAuth',
    DESKTOP_IPC_CHANNELS.providerAuth.disconnect,
    INTERACTIVE_POLICY,
    async (_event, provider: unknown): Promise<ProviderAuthStatus> =>
      await engine.disconnect(assertProviderId(provider))
  );

  return () => registry.unregisterAll();
}
