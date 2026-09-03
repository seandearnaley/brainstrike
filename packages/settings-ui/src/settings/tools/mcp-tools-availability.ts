import type { McpServerInfo } from './types';

/**
 * Whether a CONNECTED server's tool list actually loaded (BST-1603).
 *
 * `connected` is a transport fact. It says the handshake succeeded — not that
 * `tools/list` returned. The two come apart routinely: discovery can lose its
 * race, or the server can answer the handshake and fail to enumerate. The
 * Settings row previously showed one green dot for both, which is why an E2E
 * could not rely on it either and why a user whose tools silently vanished from
 * a run had nowhere to look.
 *
 * - `'available'` — tools loaded, or the server does not advertise tools at
 *   all. A prompts-only or resources-only server is HEALTHY and must not be
 *   flagged; that is what the `features.tools` check below is for.
 * - `'catalog-unavailable'` — connected, but no catalog at all. Nothing is
 *   known about its tools, prompts or resources.
 * - `'tools-unavailable'` — connected, advertises tools, and the tool list
 *   specifically failed or is absent.
 *
 * Pure and snapshot-only: it reads the host snapshot the row already has, and
 * introduces no second source of truth for connection state.
 */
export type McpToolsAvailability = 'available' | 'catalog-unavailable' | 'tools-unavailable';

export function resolveMcpToolsAvailability(server: McpServerInfo): McpToolsAvailability {
  if (server.state !== 'connected') {
    // Only a connected server can MISLEAD about its tools. Every other state
    // already renders honestly (error shows its error, pending shows pending),
    // so they are reported available and left to their own indicator.
    return 'available';
  }

  if (!server.catalog) {
    return 'catalog-unavailable';
  }

  if (!server.catalog.features.tools) {
    // Advertises no tools capability: having no tools is correct, not degraded.
    return 'available';
  }

  if (server.catalog.errors.tools || !server.catalog.tools) {
    return 'tools-unavailable';
  }

  return 'available';
}

/**
 * Short suffix for the row, or `undefined` when there is nothing to say.
 * Deliberately terse: it sits beside the existing transport/policy/generation
 * line rather than becoming its own alert.
 */
export function describeMcpToolsAvailability(
  availability: McpToolsAvailability
): string | undefined {
  switch (availability) {
    case 'catalog-unavailable':
      return 'catalog unavailable';
    case 'tools-unavailable':
      return 'tools unavailable';
    default:
      return;
  }
}
