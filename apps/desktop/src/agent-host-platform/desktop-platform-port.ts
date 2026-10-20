import type { MessagePortMain } from 'electron';
import { mainPlatformConnection } from './connection';
import { type DesktopPlatformCapabilities, serveDesktopPlatform } from './main-platform';

/** Full Main binds the port bootstrap allocated before loading its service graph. */
export function bindDesktopPlatformPort(
  port: MessagePortMain,
  capabilities: DesktopPlatformCapabilities
): { close(): Promise<void> } {
  const connection = mainPlatformConnection(port);
  const owner = serveDesktopPlatform(connection, capabilities);
  return {
    close: async () => {
      await owner.close();
    },
  };
}
