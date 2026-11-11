// A truth reader in its own process (the indexer's side of M0-A2 item 7): reads <thread> through SqliteReader every
// 20 ms until stdin says `stop`, then reads once more and reports how many events it saw.
import { readAll, SqliteReader } from '../../src/sqlite-reader.js';

const [root, thread] = process.argv.slice(2) as [string, string];
const reader = new SqliteReader(root);
const countEvents = (): number =>
  [...readAll(reader, thread)].filter((i) => i.kind === 'event').length;
let seen = 0;
let announced = false;
const tick = setInterval(() => {
  seen = countEvents();
  if (!announced && seen > 0) {
    announced = true;
    process.stdout.write(`reading ${process.pid}\n`);
  }
}, 20);
process.stdin.on('data', (d) => {
  if (!String(d).includes('stop')) {
    return;
  }
  clearInterval(tick);
  // The count is what was committed when the test said stop, whenever the timer last fired.
  seen = countEvents();
  reader.close();
  process.stdout.write(`read ${seen}\n`);
  process.exit(0);
});
