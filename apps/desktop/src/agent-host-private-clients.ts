import { MessageChannelMain, type MessagePortMain } from 'electron';
import type { DesktopHostChild } from './host-lease-manager';

/** One end of a channel whose other end the launched host holds as a desktop-origin client. */
export interface AgentHostPrivateClientPort {
  /** Settles when the host holding the other end exits, which closes that end. */
  readonly hostExited: Promise<unknown>;
  /** Kept by Main for its own client, or transferred whole to a renderer frame. */
  readonly port: MessagePortMain;
}

/** Tracks the host child this app launched, the only one that receives private client ports. */
export function createAgentHostPrivateClients(): {
  readonly attach: (child: DesktopHostChild) => void;
  readonly open: () => AgentHostPrivateClientPort | undefined;
  /**
   * Stops the live host this app launched for a relaunch and resolves with its joined exit;
   * undefined when there is none (a CLI `host start`), so nothing is stopped.
   */
  readonly stopForRelaunch: () => Promise<number> | undefined;
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
      return { hostExited: child.exited, port: channel.port1 };
    },
    stopForRelaunch: () => current?.stopForRelaunch(),
  };
}
