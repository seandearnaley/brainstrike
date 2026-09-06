import { createContext, use } from 'react';

/**
 * Per-server MCP Apps enablement (BST-1604). The host that owns the MCP
 * connection state answers, for one configured server id, whether the Apps
 * extension is EFFECTIVELY advertised for its live generation — the global
 * settings dial AND the server's own config override.
 *
 * A host that never provides one has no extension state to report, so the
 * shipped default (enabled) stands; the Apps bridge itself is still the
 * capability gate. Kept out of the provider module so that file stays a Fast
 * Refresh boundary.
 */
export type McpAppsServerEnablement = (configuredServerId: string) => boolean;

export const McpAppsEnablementContext = createContext<McpAppsServerEnablement | null>(null);

/**
 * True while MCP Apps are advertised for this server. Turning the dial off
 * flips this to `false`, which unmounts the live app and runs its ordinary
 * teardown: frame bridge close, authority close, generation retirement and
 * sandbox shell release.
 */
export function useMcpAppsEnabled(configuredServerId: string): boolean {
  const resolve = use(McpAppsEnablementContext);
  return resolve === null ? true : resolve(configuredServerId);
}
