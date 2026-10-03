// D5 race contender (spike scripts/dur/d5-contender.mjs on RootLock): wait until <atEpochMs>, then acquire <root>; hold
// <holdMs> if won. Prints WON | REFUSED | ERROR <msg>.
import { processStartTime, RootLock, RootLockedError } from '../../src/lock.js';

const [root, at, holdArg] = process.argv.slice(2) as [string, string, string | undefined];
// Must exceed the slowest contender's acquire() (PowerShell start-time reads on Windows).
const HOLD_MS = Number(holdArg ?? 1000);
// Read (and memoize) this process's own start time BEFORE the barrier: on Windows it costs a PowerShell start, which
// would otherwise smear the contenders' arrival times and weaken the race.
if (processStartTime(process.pid) === null) {
  throw new Error('cannot read own start time');
}
await new Promise((r) => {
  setTimeout(r, Math.max(0, Number(at) - Date.now() - 5));
});
while (Date.now() < Number(at)) {
  // spin the last few ms to the shared start instant (bounded by `at`)
}
try {
  const lateMs = Date.now() - Number(at); // how far after the shared instant this contender actually tried
  const l = await RootLock.acquire(root);
  const acquiredAt = Date.now();
  setTimeout(() => {
    const releasedAt = Date.now();
    l.release();
    process.stdout.write(`WON ${process.pid} late=${lateMs}ms held=${acquiredAt}..${releasedAt}\n`);
    process.exit(0);
  }, HOLD_MS);
} catch (e) {
  if (e instanceof RootLockedError) {
    process.stdout.write(
      `REFUSED ${e.owner.pid} late=${Date.now() - Number(at)}ms decided=${Date.now()}\n`
    );
    process.exit(0);
  }
  process.stdout.write(`ERROR ${(e as Error)?.message ?? String(e)}\n`);
  process.exit(1);
}
