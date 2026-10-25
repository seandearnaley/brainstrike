import type { OpenedAgentHost } from '@brainstrike/agent-host';
import { mainPlatformConnection, type PlatformMessagePort } from './connection';

/**
 * A client channel only the launching desktop can open, on the host's stdio: holding it is
 * the client's authority, as the visible-UI origin.
 */
export function bindDesktopClientPort(
  port: PlatformMessagePort,
  host: OpenedAgentHost | undefined
): void {
  if (!host) {
    // Main opens client channels only after readiness; closing tells its client.
    port.close();
    return;
  }
  host.bindClientConnection(mainPlatformConnection(port), 'desktop-ui');
}
