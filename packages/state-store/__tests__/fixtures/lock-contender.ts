// D5 race contender: report READY after startup, acquire on the parent's
// ACQUIRE command, and retain a won lock until every contender has decided.
import { createInterface } from 'node:readline';
import { processStartTime, RootLock, RootLockedError } from '../../src/lock.js';

const [root, clockOffset = '0'] = process.argv.slice(2) as [string, string?];
const offsetMs = Number(clockOffset);
if (!Number.isSafeInteger(offsetMs)) {
  throw new Error('invalid contender clock offset');
}
// Test-only reporting clock: the lock still uses its real process identity.
const now = () => Date.now() + offsetMs;
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
  const lateMs = now() - at;
  const l = await RootLock.acquire(root);
  const acquiredAt = now();
  process.stdout.write('DECIDED WON\n');
  await release.promise;
  const releasedAt = now();
  l.release();
  process.stdout.write(`WON ${process.pid} late=${lateMs}ms held=${acquiredAt}..${releasedAt}\n`);
  process.exit(0);
} catch (e) {
  if (e instanceof RootLockedError) {
    process.stdout.write(
      `REFUSED ${e.owner.pid} late=${now() - at}ms decided=${now()}\nDECIDED REFUSED\n`
    );
    process.exit(0);
  }
  process.stdout.write(`ERROR ${(e as Error)?.message ?? String(e)}\nDECIDED ERROR\n`);
  process.exit(1);
}
