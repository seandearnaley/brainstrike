import type { HostClient } from '@brainstrike/agent-host/browser';
import type { StateHealthCapability } from '@brainstrike/app-shell';
import { callBoundary } from '@brainstrike/assistant-contract/boundary-result';
import {
  type DesktopHostConnection,
  type DesktopHostConnectionState,
  windowHostConnection,
} from './desktop-host-connection';

/** How long a restart may take to bring a new host back before the notice says so. */
const RESTART_RECONNECT_TIMEOUT_MS = 60_000;

/** The connection once it is past `lost`: connected to another client, failed, or closed. */
function settledAfter(
  connection: DesktopHostConnection,
  lost: HostClient
): Promise<DesktopHostConnectionState> {
  return new Promise((resolve) => {
    const check = (): void => {
      const state = connection.getSnapshot();
      if (
        (state.kind === 'connected' && state.client !== lost) ||
        state.kind === 'failed' ||
        state.kind === 'closed'
      ) {
        unsubscribe();
        resolve(state);
      }
    };
    const unsubscribe = connection.subscribe(check);
    check();
  });
}

async function withRestartDeadline(work: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('The agent host did not come back. Use Reconnect, then check again.')),
          RESTART_RECONNECT_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Desktop's state-store health (BST-1880): the running host's `state/health/read`
 * over this frame's shared connection, and Main's restart and data-folder
 * actions. A restart resolves once this frame has reconnected to the relaunched
 * host, so the next read is that host's own check.
 */
export function createDesktopStateHealth(): StateHealthCapability | null {
  const recovery = window.agentHostRecovery;
  if (!(recovery && window.agentHost)) {
    return null;
  }
  const connection = windowHostConnection();
  return {
    read: async () => await (await connection.current()).request('state/health/read', {}),
    restartHost: async () => {
      const before = await connection.current();
      const replaced = connection.replacement(before);
      await callBoundary(() => recovery.restartHost());
      // Main resolves once the old host has exited, but this frame may still be
      // reconnecting: its automatic attempt can reach the stopping host and fail.
      // Wait for it to settle; when it failed, retry once.
      await withRestartDeadline(async () => {
        if ((await settledAfter(connection, before)).kind === 'failed') {
          connection.reconnect();
        }
        await replaced;
      });
    },
    showDataFolder: () => callBoundary(() => recovery.showDataFolder()),
  };
}
