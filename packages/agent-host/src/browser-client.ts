import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/browser';
import {
  authenticateHostClient,
  type HostClient,
  type HostClientExpectation,
} from './client-connection.ts';

export type { HostClient, HostClientExpectation } from './client-connection.ts';
/** The owning bridge supplies what to expect of the host and reports the port's lifetime. */
export function attachBrowserHost(
  port: MessagePort,
  expected: HostClientExpectation,
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
    expected,
    async () => {
      port.close();
    },
    closed
  );
}
