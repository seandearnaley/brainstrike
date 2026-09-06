import type { McpServerInfo } from './types';

/**
 * Whether a CONNECTED server's tool list is known to have FAILED (BST-1603).
 *
 * `connected` is a transport fact. It says the handshake succeeded — not that
 * `tools/list` returned. The two come apart routinely, and the Settings row
 * previously showed one green dot for both, which is why an E2E could not rely
 * on it either.
 *
 * ## This reports only what it can PROVE
 *
 * An earlier revision also reported "connected with no catalog at all" and
 * "advertises tools but has none". Both were withdrawn in review, and the
 * reasoning is worth keeping because it is the whole design:
 *
 * `McpServerActor` publishes `state: 'connected'` as soon as the handshake
 * completes, carrying whatever `client.catalog()` returns SYNCHRONOUSLY at that
 * instant (`server-actor.ts:497`), and then fills the catalog in later through a
 * `watchCatalog` subscription (`:481-491`). So "no catalog" and "tools absent"
 * are the NORMAL state of every healthy server for the window between handshake
 * and enumeration — on every launch. Reporting them would flash yellow plus a
 * "contributes no tools" line on servers that are enumerating perfectly, which
 * is precisely the noise this indicator must not create: an indicator that
 * cries wolf gets ignored, and then it is worth less than nothing.
 *
 * The snapshot carries no settled-vs-in-flight discriminator, so absence is
 * genuinely unknowable here. `catalog.errors.tools` is different in kind: it is
 * a POSITIVE, settled failure signal. It cannot be produced by a query that has
 * not finished.
 *
 * Closing the absence gap properly needs a pending/settled signal on the host
 * snapshot — tracked on BST-1603 as remaining work, not faked here.
 */
export type McpToolsAvailability = 'available' | 'tools-unavailable';

export function resolveMcpToolsAvailability(server: McpServerInfo): McpToolsAvailability {
  if (server.state !== 'connected') {
    // Only a connected server can MISLEAD about its tools. Every other state
    // renders honestly through its own indicator — error shows its error,
    // pending shows pending — so they are reported available and left alone.
    return 'available';
  }

  // `errors.tools` set means `tools/list` ran and failed. Absence of `tools`
  // means nothing: see the note above.
  return server.catalog?.errors.tools ? 'tools-unavailable' : 'available';
}

/**
 * Short suffix for the row, or `undefined` when there is nothing to say.
 * Deliberately terse: it sits beside the existing transport/policy/generation
 * line rather than becoming its own alert.
 */
export function describeMcpToolsAvailability(
  availability: McpToolsAvailability
): string | undefined {
  return availability === 'tools-unavailable' ? 'tools unavailable' : undefined;
}
