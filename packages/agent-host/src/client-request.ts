import { BoundaryFailureError } from '@brainstrike/assistant-contract';
import type { MessageConnection } from 'vscode-jsonrpc';
import {
  type BoundaryLog,
  fromBoundaryResponseError,
  HOST_CLOSING,
  isConnectionLoss,
} from './boundary-wire.ts';

const retired = new WeakMap<MessageConnection, BoundaryFailureError>();
const drained = new WeakSet<MessageConnection>();

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
    const announced = retired.get(connection);
    if (announced !== undefined && drained.has(connection) && isConnectionLoss(failure)) {
      // The host answered every request it read before its drained frame.
      throw announced;
    }
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

/** `HOST_CLOSING_EVENT`: later sends are refused unsent. */
export function markHostClosing(connection: MessageConnection): void {
  if (!retired.has(connection)) {
    retired.set(connection, new BoundaryFailureError(HOST_CLOSING));
  }
}

/** `HOST_DRAINED_EVENT`: a request its close leaves unanswered was never read. */
export function markHostDrained(connection: MessageConnection): void {
  markHostClosing(connection);
  drained.add(connection);
}
