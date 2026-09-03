import { createLogger } from '@brainstrike/logging';
import type { StoredOAuthClientInformation } from '@modelcontextprotocol/client';

const logger = createLogger('McpOAuthClientProvider');

function normalizeUrlHref(value: unknown): string | undefined {
  if (!(typeof value === 'string' || value instanceof URL)) {
    return;
  }
  try {
    return new URL(value).href;
  } catch {
    return;
  }
}

export function persistedClientSupportsRedirect(
  client: StoredOAuthClientInformation,
  callbackUrl: string | URL
): boolean {
  const redirectUris = Reflect.get(client, 'redirect_uris');
  if (!Array.isArray(redirectUris)) {
    return true;
  }
  const callbackHref = normalizeUrlHref(callbackUrl);
  return (
    callbackHref !== undefined &&
    redirectUris.some((redirectUri) => normalizeUrlHref(redirectUri) === callbackHref)
  );
}

export function reportStaleDynamicClientRegistration(issuer: string): void {
  logger.warn('Discarding stale MCP OAuth dynamic client registration', {
    issuer,
    reason: 'loopback-redirect-uri-changed',
    remedy: 'reconnect-required',
  });
}

/**
 * The persisted loopback port keeps the dynamic-registration redirect URI stable
 * across launches. Losing it is not fatal, but it invalidates the registration,
 * so the reason is reported instead of being absorbed.
 */
export function reportUnavailableLoopbackPort(port: number, cause: unknown): void {
  logger.warn('MCP OAuth loopback port is unavailable; falling back to a fresh port', {
    cause,
    port,
    reason: 'loopback-port-bind-failed',
    remedy: 'reconnect-required',
  });
}

/**
 * A listener that fails after it is bound (accept-path faults such as EMFILE or
 * ENFILE) has no request to fail and no promise left to reject. Node throws an
 * unhandled `'error'` event, which in Electron main is a process crash rather
 * than a failed OAuth callback, so the fault is reported here instead.
 */
export function reportLoopbackListenerFault(port: number, cause: unknown): void {
  logger.warn('MCP OAuth loopback callback listener failed after binding', {
    cause,
    port,
    reason: 'loopback-listener-error',
  });
}

/**
 * Restart evidence: the packaged relaunch proof reads these records to assert
 * the listener rebinds the persisted port instead of drifting to a new one.
 */
export function reportLoopbackListenerBound(details: {
  readonly port: number;
  readonly reusedPersistedPort: boolean;
  readonly server: string;
}): void {
  logger.info('MCP OAuth loopback callback listener bound', details);
}
