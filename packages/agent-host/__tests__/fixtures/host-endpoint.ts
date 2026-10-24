import { Server } from 'node:net';
import { onTestFinished, vi } from 'vitest';

/**
 * Resolves once the host closes the server listening on `endpoint`: its transport is retiring.
 * Arm it before the close starts. A refused connect cannot be the signal: on Windows a closed
 * pipe server keeps its name while an accepted connection is open, so a new connect waits
 * instead of failing until the held request settles (BST-2295).
 */
export function whenServerCloses(endpoint: string): Promise<void> {
  const closed = Promise.withResolvers<void>();
  const close = Server.prototype.close;
  const spy = vi.spyOn(Server.prototype, 'close').mockImplementation(function (
    this: Server,
    callback?: (error?: Error) => void
  ) {
    if (this.address() === endpoint) {
      spy.mockRestore();
      closed.resolve();
    }
    return close.call(this, callback);
  });
  onTestFinished(() => spy.mockRestore());
  return closed.promise;
}
