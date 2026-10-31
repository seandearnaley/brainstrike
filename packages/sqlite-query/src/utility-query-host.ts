import { createMessageConnection } from 'vscode-jsonrpc/node';
import { EndpointMessageReader, EndpointMessageWriter } from './endpoint-transport.ts';
import { serveQueryHost } from './host-core.ts';

if (!('parentPort' in process)) {
  throw new Error('SQLite query utility host requires an Electron parent port.');
}
const port = process.parentPort;
if (
  !(
    typeof port === 'object' &&
    port !== null &&
    'on' in port &&
    typeof port.on === 'function' &&
    'postMessage' in port &&
    typeof port.postMessage === 'function'
  )
) {
  throw new Error('SQLite query utility host has an invalid Electron parent port.');
}
const postMessage = port.postMessage.bind(port);
const reader = new EndpointMessageReader();
const connection = createMessageConnection(
  reader,
  new EndpointMessageWriter((message) => postMessage(message))
);
// A malformed parent protocol cannot be served safely.
connection.onError(() => {
  process.exit(1);
});
serveQueryHost(connection);
connection.listen();
port.on('message', (event: unknown): void => {
  reader.deliver(
    typeof event === 'object' && event !== null && 'data' in event ? event.data : event
  );
});
