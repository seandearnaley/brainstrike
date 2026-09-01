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
    reason: 'ephemeral-loopback-redirect-uri-changed',
  });
}
