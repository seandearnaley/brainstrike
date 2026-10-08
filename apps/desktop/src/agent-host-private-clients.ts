import { MessageChannelMain, type MessagePortMain } from 'electron';
import type { DesktopHostChild } from './host-lease-manager';

/** Tracks the host child this app launched, the only one that receives private client ports. */
export function createAgentHostPrivateClients(): {
  readonly attach: (child: DesktopHostChild) => void;
  readonly open: () => MessagePortMain | undefined;
} {
  let current: DesktopHostChild | undefined;
  return {
    attach: (child) => {
      current = child;
      void child.exited.then(() => {
        if (current === child) {
          current = undefined;
        }
      });
    },
    open: () => {
      const child = current;
      if (!child) {
        return;
      }
      const channel = new MessageChannelMain();
      child.postClientPort(channel.port2);
      return channel.port1;
    },
  };
}
