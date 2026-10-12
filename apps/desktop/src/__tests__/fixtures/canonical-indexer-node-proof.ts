import { runCanonicalIndexerProcess } from '../../canonical-indexer-process';

if (!process.send) {
  throw new Error('Canonical process proof requires explicit Node IPC.');
}
const send = process.send.bind(process);
process.once('message', (input: unknown) => {
  void runCanonicalIndexerProcess(input, {
    finish: () => setImmediate(() => process.exit()),
    onMessage: (listener) => {
      process.on('message', listener);
    },
    send: (value) => {
      send(value);
    },
  });
});
