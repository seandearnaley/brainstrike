import type { ProviderAuthStartMethod, ProviderAuthStatus } from '@brainstrike/assistant-contract';
import { ipcMain } from 'electron';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  createDesktopIpcRegistry,
  type DesktopIpcSenderPolicy,
} from '../platform/desktop-ipc-registry';

/**
 * Typed `provider-auth` IPC domain (BST-1355).
 *
 * Every channel is a sensitive invoke registered with the fail-closed
 * visible-ui-only sender policy (the legal gate's interactive-desktop-only
 * constraint, enforced by the registry BEFORE the handler sees renderer
 * arguments). Each call is forwarded to the agent host's sign-in engine over
 * Main's private desktop client; the renderer sees ONLY token-free
 * {@link ProviderAuthStatus} payloads and tokens never enter Main.
 */

const INTERACTIVE_POLICY: DesktopIpcSenderPolicy = { roles: ['visible-ui'] };

/** The host's sign-in engine as Main's private desktop client reaches it. */
export interface DesktopProviderAuth {
  cancel(provider: string): Promise<ProviderAuthStatus>;
  connect(
    provider: string,
    method: ProviderAuthStartMethod | undefined
  ): Promise<ProviderAuthStatus>;
  disconnect(provider: string): Promise<ProviderAuthStatus>;
  status(provider: string): Promise<ProviderAuthStatus>;
}

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

export function registerProviderAuthIpcHandlers({
  auth,
}: {
  readonly auth: DesktopProviderAuth;
}): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerAuthorizedInvoke(
    'providerAuth',
    DESKTOP_IPC_CHANNELS.providerAuth.start,
    INTERACTIVE_POLICY,
    async (_event, provider: unknown, method?: unknown): Promise<ProviderAuthStatus> =>
      await auth.connect(assertProviderId(provider), assertStartMethod(method))
  );

  registry.registerAuthorizedInvoke(
    'providerAuth',
    DESKTOP_IPC_CHANNELS.providerAuth.cancel,
    INTERACTIVE_POLICY,
    async (_event, provider: unknown): Promise<ProviderAuthStatus> =>
      await auth.cancel(assertProviderId(provider))
  );

  registry.registerAuthorizedInvoke(
    'providerAuth',
    DESKTOP_IPC_CHANNELS.providerAuth.status,
    INTERACTIVE_POLICY,
    async (_event, provider: unknown): Promise<ProviderAuthStatus> =>
      await auth.status(assertProviderId(provider))
  );

  registry.registerAuthorizedInvoke(
    'providerAuth',
    DESKTOP_IPC_CHANNELS.providerAuth.disconnect,
    INTERACTIVE_POLICY,
    async (_event, provider: unknown): Promise<ProviderAuthStatus> =>
      await auth.disconnect(assertProviderId(provider))
  );

  return () => registry.unregisterAll();
}
