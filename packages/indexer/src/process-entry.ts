// BST-2246: first, before this process creates anything, so everything it
// creates is owned by the user even when an elevated token defaults to
// BUILTIN\Administrators.
import '@brainstrike/secure-fs-native/default-owner';
import { runIndexerProcess } from './process-core.ts';

process.once('message', (input: unknown) => {
  void runIndexerProcess(input, {
    finish: () => {
      process.disconnect();
    },
    onDisconnect: (listener) => {
      process.on('disconnect', listener);
    },
    onMessage: (listener) => {
      process.on('message', listener);
    },
    send: (value) => {
      if (!process.send) {
        throw new Error('Indexer requires a Node IPC channel.');
      }
      process.send(value);
    },
  }).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
    if (process.connected) {
      process.disconnect();
    }
  });
});
