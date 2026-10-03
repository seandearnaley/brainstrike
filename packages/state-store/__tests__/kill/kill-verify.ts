// Restart + check after a SIGKILL (M0-A1 scripts/m0/kill-verify.ts), in a fresh process: reopen the killed host's store
// (stale-lock recovery, SQLite WAL recovery), run integrity_check + per-thread seq contiguity, and compare every chunk the
// recorder was shown against the store. The spike's run-host boot sweep (marking interrupted runs) belongs to M3.
// usage: node --import tsx kill-verify.ts <root> <recorderFile> <trial>
import { readFileSync } from 'node:fs';
import type { RunChunk } from '../../src/coalescer.js';
import { StateStore } from '../../src/state-store.js';
import { checkShownInLog, type ShownChunk } from './shown-check.js';

const [root, recFile, trial] = process.argv.slice(2) as [string, string, string];
const shown = readFileSync(recFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as ShownChunk);
let brokeStale = 0;
const t0 = performance.now();
let store: StateStore;
try {
  store = await StateStore.open(root, {
    onStaleBroken: () => {
      brokeStale++;
    },
  });
} catch (e) {
  process.stdout.write(
    `M0VERIFY ${JSON.stringify({ openError: String((e as Error)?.stack ?? e), trial })}\n`
  );
  process.exit(0);
}
const openMs = performance.now() - t0;
const validity = await store.check();
const prefix = `trial-${trial}`;
const threads = (await store.threads()).filter((t) => t === prefix || t.startsWith(`${prefix}/`));
const logged: ShownChunk[] = [];
let rows = 0;
for (const t of threads) {
  for (const row of await store.read(t)) {
    rows++;
    if (row.event.type !== 'ui.chunk') {
      continue;
    }
    for (const c of row.event['chunks'] as RunChunk[]) {
      logged.push({ c, r: String(row.event['runId']), t });
    }
  }
}
const check = checkShownInLog(
  shown.filter((s) => s.t === prefix || s.t.startsWith(`${prefix}/`)),
  logged
);
await store.close();
process.stdout.write(
  `M0VERIFY ${JSON.stringify({ brokeStale, check, loggedChunks: logged.length, openMs: Number(openMs.toFixed(1)), rows, shownLines: shown.length, threads: threads.length, trial, validity })}\n`
);
