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
/**
 * The owning bridge supplies what to expect of the host and reports when the far end
 * disconnects. Closing this end closes the client too, without waiting for that report.
 */
export function attachBrowserHost(
  port: MessagePort,
  expected: HostClientExpectation,
  disconnected: Promise<void>
): Promise<HostClient> {
  const closedHere = Promise.withResolvers<void>();
  const connection = createMessageConnection(
    new BrowserMessageReader(port),
    new BrowserMessageWriter(port)
  );
  port.start();
  return authenticateHostClient(
    connection,
    expected,
    async () => {
      port.close();
      closedHere.resolve();
    },
    Promise.race([disconnected, closedHere.promise])
  );
}
