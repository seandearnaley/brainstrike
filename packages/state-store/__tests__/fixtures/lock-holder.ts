// D5 holder (spike scripts/dur/d5-holder.ts on the state store): open the store on <root> (taking the root lock), append
// one row, print READY, hold until a clean close is requested (stdin CLOSE or SIGTERM) or SIGKILL (a stale lock).
// With argv[3] === 'try': attempt to open and report the outcome.
import { RootLockedError } from '../../src/lock.js';
import { StateStore } from '../../src/state-store.js';

const [root, mode] = process.argv.slice(2) as [string, string | undefined];
let store: StateStore;
try {
  store = await StateStore.open(root);
} catch (e) {
  if (e instanceof RootLockedError) {
    process.stdout.write(`REFUSED owner=${e.owner.pid}\n`);
    process.exit(3);
  }
  throw e;
}
if (mode === 'try') {
  process.stdout.write('OPENED\n');
  await store.close();
  process.exit(0);
}
await store.append([
  { event: { text: `written by ${process.pid}`, type: 'note' }, threadId: 'held' },
]);
const closeCleanly = (): void => {
  void store.close().then(() => {
    process.stdout.write('CLOSED\n');
    process.exit(0);
  });
};
process.on('SIGTERM', closeCleanly);
// Windows has no catchable SIGTERM (Node maps it to TerminateProcess), so a clean close is also requested on stdin.
process.stdin.on('data', (d) => {
  if (String(d).includes('CLOSE')) {
    closeCleanly();
  }
});
process.stdout.write(`READY pid=${process.pid}\n`);
setInterval(() => undefined, 1000);
