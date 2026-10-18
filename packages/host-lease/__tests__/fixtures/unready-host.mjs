// A host starter that owns its root and publishes its record but never reports
// ready, so its launcher gives up while it owns the root (BST-2167). `honour`
// closes on the launcher's cancel-startup, as the real host entries do;
// `ignore` ignores both cancel-startup and SIGTERM, so only its starter's
// bounded SIGKILL can end it. It runs the built package under plain Node.
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';
import { decodeStartOptions, startHost } from '../../dist/index.js';

const options = decodeStartOptions(JSON.parse(process.argv[2] ?? 'null'));
const mode = makeThrowingDecoder(Schema.Literals(['honour', 'ignore']))(process.argv[3]);
/** @type {import('../../dist/index.js').HostRuntime | undefined} */
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
host = await startHost(options);
process.on('message', (/** @type {unknown} */ message) => {
  if (
    mode === 'honour' &&
    typeof message === 'object' &&
    message !== null &&
    Reflect.get(message, 'event') === 'cancel-startup'
  ) {
    void host?.close();
  }
});
await host.closed;
