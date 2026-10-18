import { MessageChannelMain, type MessagePortMain } from 'electron';
import type { DesktopHostChild } from './host-lease-manager';

/** Tracks the host child this app launched, the only one that receives private client ports. */
export function createAgentHostPrivateClients(): {
  readonly attach: (child: DesktopHostChild) => void;
  /** The exit of the live host this app launched; undefined when there is none (a CLI `host start`). */
  readonly exited: () => Promise<number> | undefined;
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
    exited: () => current?.exited,
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
