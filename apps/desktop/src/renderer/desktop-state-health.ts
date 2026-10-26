import type { HostClient } from '@brainstrike/agent-host/browser';
import type { StateHealthCapability } from '@brainstrike/app-shell';
import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import { callBoundary } from '@brainstrike/assistant-contract/boundary-result';
import { createLogger } from '@brainstrike/logging';
import { type DesktopHostConnection, windowHostConnection } from './desktop-host-connection';

const logger = createLogger('DesktopStateHealth');
/** JSON-RPC's MethodNotFound, the raw cause the client keeps under its typed fault. */
const METHOD_NOT_FOUND = -32_601;

function isMethodNotFound(cause: unknown): boolean {
  const inner = cause instanceof BoundaryFailureError ? cause.cause : cause;
  return (
    typeof inner === 'object' && inner !== null && Reflect.get(inner, 'code') === METHOD_NOT_FOUND
  );
}

/** The connection's next state past `lost`: connected to another client, failed, or closed. */
function settledAfter(connection: DesktopHostConnection, lost: HostClient): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      const state = connection.getSnapshot();
      if (
        (state.kind === 'connected' && state.client !== lost) ||
        state.kind === 'failed' ||
        state.kind === 'closed'
      ) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = connection.subscribe(check);
    check();
  });
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
    read: async () => {
      try {
        return await (await connection.current()).request('state/health/read', {});
      } catch (cause) {
        // A host left running by an older build lacks the method: it cannot
        // report health, which is neither a damaged store nor a healthy one.
        if (isMethodNotFound(cause)) {
          logger.warn('The running agent host cannot report its state store health');
          return null;
        }
        throw cause;
      }
    },
    restartHost: async () => {
      const before = await connection.current();
      await callBoundary(() => recovery.restartHost());
      // Main replies once the old host has exited and the new one is running, so
      // one attempt reaches it: Reconnect when the automatic attempt has already
      // failed, otherwise that automatic attempt. Its outcome is the restart's.
      if (connection.getSnapshot().kind === 'failed') {
        connection.reconnect();
      }
      await settledAfter(connection, before);
      // Connected resolves; failed rejects with that attempt's own cause.
      await connection.current();
    },
    showDataFolder: () => callBoundary(() => recovery.showDataFolder()),
  };
}
