// A truth reader in its own process (the indexer's side of M0-A2 item 7): reads <thread> through SqliteReader every
// 20 ms until stdin says `stop`, then reports how many events it last saw.
import { readAll, SqliteReader } from '../../src/sqlite-reader.js';

const [root, thread] = process.argv.slice(2) as [string, string];
const reader = new SqliteReader(root);
let seen = 0;
let announced = false;
const tick = setInterval(() => {
  seen = [...readAll(reader, thread)].filter((i) => i.kind === 'event').length;
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
  reader.close();
  process.stdout.write(`read ${seen}\n`);
  process.exit(0);
});
