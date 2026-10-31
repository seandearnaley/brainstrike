import type { HostRecord } from '@brainstrike/host-lease';
import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/browser';
import { authenticateHostClient, type HostClient } from './client-connection.ts';

export type { HostClient } from './client-connection.ts';
/**
 * The owning bridge supplies the private record and reports when the host side is
 * gone. The port this client closes is closed too: nothing on the far side reports it.
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
