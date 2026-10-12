import { fileURLToPath } from 'node:url';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';
import { launchHost } from '../../src/launcher.js';
import { createNodeHostSpawner } from '../../src/node-spawner.js';

async function main(): Promise<void> {
  const root = makeThrowingDecoder(Schema.String)(process.argv[2]);
  const lifetime = makeThrowingDecoder(Schema.Literals(['app', 'cli']))(process.argv[3]);
  const client = await launchHost(root, {
    lifetime,
    spawn: createNodeHostSpawner({
      entrypoint: fileURLToPath(new URL('../../src/process-entry.ts', import.meta.url)),
      execArgv: ['--import', 'tsx'],
    }),
  });
  const done = Promise.withResolvers<void>();
  const stop = (): void => done.resolve();
  process.on('message', (message: unknown) => {
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
main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exitCode = 1;
  if (process.connected) {
    process.disconnect();
  }
});
