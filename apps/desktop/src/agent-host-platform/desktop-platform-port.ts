import { MessageChannelMain, type MessagePortMain } from 'electron';
import { mainPlatformConnection } from './connection';
import { type DesktopPlatformCapabilities, serveDesktopPlatform } from './main-platform';

/** Allocated only for a newly forked app-owned Root, after lease arbitration. */
export function createDesktopPlatformPort(capabilities: DesktopPlatformCapabilities): {
  readonly port: MessagePortMain;
  close(): Promise<void>;
} {
  const channel = new MessageChannelMain();
  const connection = mainPlatformConnection(channel.port1);
  const owner = serveDesktopPlatform(connection, capabilities);
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= owner.close().then(() => {
        channel.port1.close();
        channel.port2.close();
      })),
    port: channel.port2,
  };
}
