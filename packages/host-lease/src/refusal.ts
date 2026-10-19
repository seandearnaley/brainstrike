/**
 * The host lease's typed refusals (BST-2158). A refusal crosses the process
 * boundary as a frame, where `instanceof` cannot work, so callers classify it
 * by `code`, never by its message: rewording a message must not change what
 * the launcher does.
 */

/** The owner is closing: it refuses new attachments and runs until it exits. */
export const HOST_LEASE_CLOSING = 'host-lease.host-closing';
/** The owner's connection closed before the handshake was answered. */
export const HOST_LEASE_CONNECTION_CLOSED = 'host-lease.connection-closed';

export type HostLeaseRefusalCode = typeof HOST_LEASE_CLOSING | typeof HOST_LEASE_CONNECTION_CLOSED;

export class HostLeaseRefusalError extends Error {
  readonly code: HostLeaseRefusalCode;

  constructor(code: HostLeaseRefusalCode, message: string) {
    super(message);
    this.name = 'HostLeaseRefusalError';
    this.code = code;
  }
}
