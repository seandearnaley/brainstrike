import type { DesktopMcpPlatformCapabilities } from '../agent-host-platform/mcp-main-stores';
import type { MainMcpHostControl } from './main-host-control';
import { openExternalWithElectron } from './open-external';

/**
 * Main's MCP stores for the Node host's runtime (BST-1930 c1 interim):
 * Electron's external opener. Bearer references and OAuth records live in the
 * profile store the host owns, Tasks in its StateStore.
 */
export function createDesktopMcpPlatformCapabilities(
  control: MainMcpHostControl
): DesktopMcpPlatformCapabilities {
  return {
    control,
    openExternal: openExternalWithElectron,
  };
}
