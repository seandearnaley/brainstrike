import type { HostRecord } from '@brainstrike/host-lease';
import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/browser';
import { authenticateHostClient, type HostClient } from './client-connection.js';

export type { HostClient } from './client-connection.js';
/** The owning bridge supplies the private record and reports port lifetime. */
export function attachBrowserHost(
  port: MessagePort,
  record: HostRecord,
  closed: Promise<void>
): Promise<HostClient> {
  const connection = createMessageConnection(
    new BrowserMessageReader(port),
    new BrowserMessageWriter(port)
  );
  port.start();
  closed.then(
    () => connection.dispose(),
    () => connection.dispose()
  );
  return authenticateHostClient(
    connection,
    record,
    async () => {
      port.close();
    },
    closed
  );
}
