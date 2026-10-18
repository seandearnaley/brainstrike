import type { McpServerInfo } from './types';

/**
 * What a CONNECTED server's tool list says about the tools it contributes
 * (BST-1603, BST-1632).
 *
 * `connected` is a transport fact. It says the handshake succeeded, not that
 * `tools/list` returned, and the Settings row once showed one green dot for
 * both. So this reports only what the host snapshot PROVES:
 *
 * - `tools-unavailable`: `catalog.errors.tools`, a settled failure.
 * - `unsupported`: the server advertises no tools capability, as a
 *   prompts-only or resources-only server does. That server is healthy.
 * - `empty`: the list settled with zero tools.
 * - `loading`: the host reports `tools` listing (`catalog.listing`) and no
 *   list has arrived yet.
 * - `available`: tools listed, or nothing provable.
 *
 * The host lists every advertised section before it publishes `connected`
 * (`connectClient` awaits the feature owner's first enumeration) and publishes
 * `listing` around every later refresh, so each state above is a host fact.
 * Absence alone is never read as empty: a UI timer or a second poller would
 * only guess.
 */
export type McpToolsAvailability =
  | 'available'
  | 'empty'
  | 'loading'
  | 'tools-unavailable'
  | 'unsupported';

export function resolveMcpToolsAvailability(server: McpServerInfo): McpToolsAvailability {
  if (server.state !== 'connected' || !server.catalog) {
    // Only a connected server can MISLEAD about its tools. Every other state
    // renders honestly through its own indicator: error shows its error,
    // pending shows pending. A client that publishes no catalog proves nothing.
    return 'available';
  }
  const { catalog } = server;
  if (catalog.errors.tools) {
    return 'tools-unavailable';
  }
  if (!catalog.features.tools) {
    return 'unsupported';
  }
  if (catalog.tools) {
    return catalog.tools.tools.length === 0 ? 'empty' : 'available';
  }
  return catalog.listing?.includes('tools') ? 'loading' : 'available';
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
    case 'tools-unavailable':
      return 'tools unavailable';
    case 'loading':
      return 'loading tools';
    case 'empty':
      return 'no tools';
    case 'unsupported':
      return 'offers no tools';
    case 'available':
      return;
  }
}
