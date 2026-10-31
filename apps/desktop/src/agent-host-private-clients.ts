import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract/boundary-failure';
import type { HostRecord } from '@brainstrike/host-lease';
import { MessageChannelMain, type MessagePortMain } from 'electron';
import type { DesktopHostChild } from './host-lease-manager';

/** One end of a channel whose other end the launched host holds as a desktop-origin client. */
export interface AgentHostPrivateClientPort {
  /** Settles once Main holds that host as gone (its lifetime channel closed, or its exit). */
  readonly hostGone: Promise<unknown>;
  /** Kept by Main for its own client, or transferred whole to a renderer frame. */
  readonly port: MessagePortMain;
}

/**
 * The host this app launched is gone and the profile has not admitted its replacement yet:
 * the same unavailability as a host lost just before quit, so its owner relaunches it on
 * the next request.
 */
const LAUNCHED_HOST_GONE = refusal({
  category: 'availability',
  code: 'host.stopped',
  message: 'The agent host stopped. It starts again on the next request.',
});

/** Tracks the host child this app launched, the only one that receives private client ports. */
export function createAgentHostPrivateClients(): {
  readonly attach: (child: DesktopHostChild) => void;
  /**
   * A private port to the host `record` names when this app launched it; undefined for a
   * host it did not launch (a CLI `host start`). A launched host that is gone refuses.
   */
  readonly open: (record: HostRecord) => AgentHostPrivateClientPort | undefined;
  /**
   * Stops the live host this app launched for a relaunch and resolves with its joined exit;
   * undefined when there is none (a CLI `host start`), so nothing is stopped.
   */
  readonly stopForRelaunch: () => Promise<number> | undefined;
} {
  let launched:
    | { readonly child: DesktopHostChild; readonly gone: Promise<unknown>; live: boolean }
    | undefined;
  return {
    attach: (child) => {
      // Its lifetime channel often closes before Electron reports the exit.
      const entry = { child, gone: Promise.race([child.exited, child.lost]), live: true };
      launched = entry;
      void entry.gone.then(() => {
        entry.live = false;
      });
    },
    open: (record) => {
      const { pid, start } = launched?.child.record ?? {};
      if (!launched || pid !== record.pid || start !== record.start) {
        return;
      }
      if (!launched.live) {
        throw new BoundaryFailureError(LAUNCHED_HOST_GONE);
      }
      const channel = new MessageChannelMain();
      launched.child.postClientPort(channel.port2);
      return { hostGone: launched.gone, port: channel.port1 };
    },
    stopForRelaunch: () => (launched?.live ? launched.child.stopForRelaunch() : undefined),
  };
}
