import type { HostRecord } from '@brainstrike/host-lease';
import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/browser';
import { authenticateHostClient, type HostClient } from './client-connection.ts';

export type { HostClient } from './client-connection.ts';
/**
 * The owning bridge supplies the private record and reports when its owner holds the host
 * as gone (`hostGone`), the moment a reconnect can reach a live host. The port's own
 * `close` comes first: the connection is disposed then, so a request fails at once instead
 * of waiting on a port nobody reads. A close this client makes settles `closed` itself.
 */
export function attachBrowserHost(
  port: MessagePort,
  record: HostRecord,
  hostGone: Promise<void>
): Promise<HostClient> {
  const closed = Promise.withResolvers<void>();
  hostGone.then(closed.resolve, closed.resolve);
  const connection = createMessageConnection(
    new BrowserMessageReader(port),
    new BrowserMessageWriter(port)
  );
  port.addEventListener('close', () => connection.dispose(), { once: true });
  port.start();
  closed.promise.then(() => connection.dispose());
  return authenticateHostClient(
    connection,
    record,
    async () => {
      port.close();
      closed.resolve();
    },
    closed.promise
  );
}
