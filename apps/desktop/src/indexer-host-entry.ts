// BST-2246: first, before this process creates anything, so everything it
// creates is owned by the user even when an elevated token defaults to
// BUILTIN\Administrators.
import '@brainstrike/secure-fs-native/default-owner';
import { takeLifecycleDelays } from '@brainstrike/host-lease/lifecycle-delays';
import { indexerMessageDelivery } from './indexer-request-delay';

// The E2E delay points Main handed this utility, read once and removed from its env.
const lifecycleDelays = takeLifecycleDelays();
const parentPort = process.parentPort;
if (!parentPort || process.type !== 'utility') {
  throw new Error('Indexer host requires the explicit Electron utility-process transport.');
}
const finish = (): void => {
  setImmediate(() => process.exit());
};
parentPort.once('message', (event: Electron.MessageEvent) => {
  void import('./canonical-indexer-process')
    .then(
      ({ runCanonicalIndexerProcess }) =>
        runCanonicalIndexerProcess(event.data, {
          // Electron owns utility termination when its parent exits. There is no
          // documented ParentPort disconnect event; never emulate Node IPC here.
          finish,
          onMessage: (listener) => {
            const deliver = indexerMessageDelivery(lifecycleDelays, listener);
            parentPort.on('message', (message: Electron.MessageEvent) => deliver(message.data));
          },
          send: (value) => parentPort.postMessage(value),
        }),
      (error: unknown) => {
        parentPort.postMessage({
          error: {
            code: 'indexer-import-failed',
            message: error instanceof Error ? error.message : String(error),
          },
          kind: 'startup-error',
        });
        process.exitCode = 1;
        finish();
      }
    )
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
      );
      process.exitCode = 1;
      finish();
    });
});
