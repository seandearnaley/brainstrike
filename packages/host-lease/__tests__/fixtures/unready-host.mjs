// A host starter that owns its root and publishes its record but never reports
// ready, so its launcher gives up while it owns the root (BST-2167). `honour`
// closes on the launcher's cancel-startup, as the real host entries do;
// `ignore` ignores both cancel-startup and SIGTERM, so only its starter's
// bounded SIGKILL can end it. It runs the built package under plain Node.
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';
import { decodeStartOptions, startHost } from '../../src/index.ts';

const options = decodeStartOptions(JSON.parse(process.argv[2] ?? 'null'));
const mode = makeThrowingDecoder(Schema.Literals(['honour', 'ignore']))(process.argv[3]);
const startup = new AbortController();
/** @type {import('../../src/index.ts').HostRuntime | undefined} */
let host;
process.on('SIGTERM', () => {
  if (mode !== 'honour') {
    return;
  }
  if (host) {
    void host.close();
  } else {
    process.exit(1);
  }
});
// Installed before startHost, as the real host entries install theirs (BST-2228):
// the launcher sends cancel-startup once the record is on disk, while startHost
// may still be syncing its directory, and Node drops an IPC message that arrives
// before any 'message' listener exists.
process.on('message', (/** @type {unknown} */ message) => {
  if (
    mode === 'honour' &&
    typeof message === 'object' &&
    message !== null &&
    Reflect.get(message, 'event') === 'cancel-startup'
  ) {
    startup.abort(new Error('Host process cancelled'));
    void host?.close();
  }
});
try {
  host = await startHost(options, undefined, startup.signal);
} catch (cause) {
  if (!startup.signal.aborted) {
    throw cause;
  }
  // startHost closed what it had acquired as it refused; the cancelled host exits failed.
  process.exitCode = 1;
}
if (host && startup.signal.aborted) {
  // The cancel arrived after startHost's last abort check, before `host` was set.
  await host.close();
}
await host?.closed;
