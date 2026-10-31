import { createMessageConnection, IPCMessageReader, IPCMessageWriter } from 'vscode-jsonrpc/node';
import { serveQueryHost } from './host-core.ts';

if (!process.send) {
  throw new Error('Node SQLite query host must have a parent IPC channel.');
}
const connection = createMessageConnection(
  new IPCMessageReader(process),
  new IPCMessageWriter(process)
);
// A malformed parent protocol cannot be served safely.
connection.onError(() => {
  process.exit(1);
});
serveQueryHost(connection);
connection.listen();
process.on('disconnect', (): void => {
  process.exit(0);
});
