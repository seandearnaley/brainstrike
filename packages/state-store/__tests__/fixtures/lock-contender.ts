// D5 race contender: report READY after startup, acquire on the parent's
// ACQUIRE command, and retain a won lock until every contender has decided.
import { createInterface } from 'node:readline';
import { processStartTime, RootLock, RootLockedError } from '../../src/lock.js';

const [root] = process.argv.slice(2) as [string];
const acquire = Promise.withResolvers<number>();
const release = Promise.withResolvers<void>();
const commands = createInterface({ input: process.stdin });
commands.on('line', (line: string) => {
  if (line === 'RELEASE') {
    release.resolve();
    return;
  }
  const match = /^ACQUIRE (\d+)$/.exec(line);
  if (match) {
    acquire.resolve(Number(match[1]));
    return;
  }
  throw new Error(`Unexpected race command: ${line}`);
});
// Startup and process identity lookup finish before the parent opens the race.
if (processStartTime(process.pid) === null) {
  throw new Error('cannot read own start time');
}
process.stdout.write('READY\n');
const at = await acquire.promise;
try {
  const lateMs = Date.now() - at;
  const l = await RootLock.acquire(root);
  const acquiredAt = Date.now();
  process.stdout.write('DECIDED WON\n');
  await release.promise;
  const releasedAt = Date.now();
  l.release();
  process.stdout.write(`WON ${process.pid} late=${lateMs}ms held=${acquiredAt}..${releasedAt}\n`);
  process.exit(0);
} catch (e) {
  if (e instanceof RootLockedError) {
    process.stdout.write(
      `REFUSED ${e.owner.pid} late=${Date.now() - at}ms decided=${Date.now()}\nDECIDED REFUSED\n`
    );
    process.exit(0);
  }
  process.stdout.write(`ERROR ${(e as Error)?.message ?? String(e)}\nDECIDED ERROR\n`);
  process.exit(1);
}
