import type { PlatformMessagePort } from './agent-host-platform/connection';
import type { DesktopHostChild } from './host-lease-manager';

/** Tracks the host child this app launched, the only one Main opens private client channels on. */
export function createAgentHostPrivateClients(): {
  readonly attach: (child: DesktopHostChild) => void;
  readonly open: () => PlatformMessagePort | undefined;
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
    open: () => current?.openClientPort(),
    stopForRelaunch: () => current?.stopForRelaunch(),
  };
}
