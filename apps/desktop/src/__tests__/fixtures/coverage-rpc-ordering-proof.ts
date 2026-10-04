import { existsSync } from 'node:fs';
import { openConnection } from '@brainstrike/sqlite-native';
import { createQueryHost } from '@brainstrike/sqlite-query/host';

if (!process.send) {
  throw new Error('Coverage ordering proof requires Node IPC.');
}
const send = process.send.bind(process);
const releasePath = process.env['COVERAGE_ORDERING_RELEASE_PATH'];
if (!releasePath) {
  throw new Error('Coverage ordering proof requires its external release latch.');
}
const probe = openConnection(':memory:');
const prototype = Object.getPrototypeOf(probe) as { prepare: typeof probe.prepare };
const originalPrepare = prototype.prepare;
probe.close();
let held = false;
const cell = new Int32Array(new SharedArrayBuffer(4));
prototype.prepare = new Proxy(originalPrepare, {
  apply(target, receiver: unknown, parameters: unknown[]) {
    const statement: ReturnType<typeof originalPrepare> = Reflect.apply(
      target,
      receiver,
      parameters
    );
    if (parameters[0] === 'SELECT dimensions,emb FROM scoped_vectors WHERE profile_hash=?') {
      const iterate = statement.iterate.bind(statement);
      statement.iterate = function* (...values: unknown[]) {
        // Enter AFTER the actual iterator establishes its WAL snapshot.
        const rows: IterableIterator<unknown> = Reflect.apply(iterate, statement, values);
        for (const row of rows) {
          if (!held) {
            held = true;
            send({ kind: 'ordering-held' });
            while (!existsSync(releasePath)) {
              Atomics.wait(cell, 0, 0, 10);
            }
            send({ kind: 'ordering-released' });
          }
          yield row;
        }
      };
    }
    return statement;
  },
});
process.on(
  'message',
  createQueryHost((response) => send(response))
);
process.on('disconnect', () => process.exit(0));
