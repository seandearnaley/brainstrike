import { MessageChannelMain, type MessagePortMain } from 'electron';
import type { DesktopHostChild } from './host-lease-manager';

/** One end of a channel whose other end the launched host holds as a desktop-origin client. */
export interface AgentHostPrivateClientPort {
  /**
   * Settles once Main holds that host as gone (its lifetime channel closed, or its exit),
   * after which it hands out no more ports: a client that reconnects then reaches the
   * replacement.
   */
  readonly hostGone: Promise<unknown>;
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
  let current: { readonly child: DesktopHostChild; readonly gone: Promise<unknown> } | undefined;
  return {
    attach: (child) => {
      // Its lifetime channel often closes before Electron reports the exit.
      const gone = Promise.race([child.exited, child.lost]);
      const attached = { child, gone };
      current = attached;
      void gone.then(() => {
        if (current === attached) {
          current = undefined;
        }
      });
    },
    open: () => {
      if (!current) {
        return;
      }
      const channel = new MessageChannelMain();
      current.child.postClientPort(channel.port2);
      return { hostGone: current.gone, port: channel.port1 };
    },
    stopForRelaunch: () => current?.child.stopForRelaunch(),
  };
}
