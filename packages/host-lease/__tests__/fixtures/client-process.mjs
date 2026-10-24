// A real client process for start-orders. Like the host it may fork
// (src/process-entry.ts), it runs this package from source under plain Node. A tsx loader in each of eight racing clients was the
// cost that pushed the race past its attach deadline on a 2-vCPU runner
// (BST-2106).
import { fileURLToPath } from 'node:url';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';
import { createNodeHostSpawner, launchHost } from '../../src/index.ts';

async function main() {
  const root = makeThrowingDecoder(Schema.String)(process.argv[2]);
  const lifetime = makeThrowingDecoder(Schema.Literals(['app', 'cli']))(process.argv[3]);
  const client = await launchHost(root, {
    lifetime,
    spawn: createNodeHostSpawner({
      entrypoint: fileURLToPath(new URL('../../src/process-entry.ts', import.meta.url)),
    }),
  });
  const done = Promise.withResolvers();
  const stop = () => done.resolve();
  process.on('message', (/** @type {unknown} */ message) => {
    makeThrowingDecoder(Schema.Literal('close'))(message);
    stop();
  });
  process.once('SIGTERM', stop);
  process.send?.({ event: 'attached', record: client.record });
  try {
    await done.promise;
  } finally {
    process.off('SIGTERM', stop);
    await client.close();
    if (process.connected) {
      process.disconnect();
    }
  }
}
main().catch((/** @type {unknown} */ cause) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exitCode = 1;
  if (process.connected) {
    process.disconnect();
  }
});
