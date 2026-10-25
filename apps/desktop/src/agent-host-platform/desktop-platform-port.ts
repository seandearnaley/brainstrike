import { mainPlatformConnection, type PlatformMessagePort } from './connection';
import { type DesktopPlatformCapabilities, serveDesktopPlatform } from './main-platform';

/** Full Main serves the host's platform channel, which holds the host's requests until then. */
export function bindDesktopPlatformPort(
  port: PlatformMessagePort,
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
