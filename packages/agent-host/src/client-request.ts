import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import type { MessageConnection } from 'vscode-jsonrpc';
import { type BoundaryLog, fromBoundaryResponseError } from './boundary-wire.ts';

const retired = new WeakMap<MessageConnection, BoundaryFailureError>();

/**
 * RPC and catalog commands share this connection's admission. An explicit
 * host.closing refusal is terminal: earlier replies still join, but sending
 * another command races the host's physical transport close (BST-2282).
 */
export async function sendHostRequest(
  connection: MessageConnection,
  send: () => Promise<unknown>,
  log: BoundaryLog
): Promise<unknown> {
  const refusal = retired.get(connection);
  if (refusal !== undefined) {
    throw refusal;
  }
  try {
    return await send();
  } catch (cause) {
    const failure = fromBoundaryResponseError(cause, log, connection);
    if (
      failure instanceof BoundaryFailureError &&
      failure.failure.kind === 'refusal' &&
      failure.code === 'host.closing'
    ) {
      retired.set(connection, failure);
    }
    throw failure;
  }
}
