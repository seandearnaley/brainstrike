// The process the SIGKILL harness kills (M0-A1 scripts/m0/kill-host.ts): a root run streams while 3 children stream;
// every run has 4 steps of 500 unique token deltas (+ a read_file call, last step without), so step-boundary syncs are
// in flight when the harness kills this process. Every chunk handed to the UI goes to the recorder process over a local
// socket (Unix socket / Windows named pipe), and is only handed over after its batch committed.
// usage: node --import tsx kill-host.ts <root> <socket> <trial>
import { once } from 'node:events';
import net from 'node:net';
import { Coalescer } from '../../src/coalescer.js';
import { StateStore } from '../../src/state-store.js';
import { streamRun, tokens } from './workload.js';

const [root, sock, trial] = process.argv.slice(2) as [string, string, string];
const STEPS = 4;
const DELTAS = 500;
const store = await StateStore.open(root);
const conn = net.createConnection(sock);
await once(conn, 'connect');
let first = true;
const co = new Coalescer(store, 20, (threadId, runId, c) => {
  conn.write(`${JSON.stringify({ c, r: runId, t: threadId })}\n`);
  if (first) {
    first = false;
    process.stdout.write('STREAMING\n');
  }
});
const rootThread = `trial-${trial}`;
const runs = [
  { runId: `R${trial}`, threadId: rootThread },
  ...['A', 'B', 'C'].map((l) => ({
    runId: `${l}${trial}`,
    threadId: `${rootThread}/child:${l}${trial}`,
  })),
];
await Promise.all(
  runs.map((r) =>
    streamRun(co, { ...r, steps: STEPS, text: (step) => tokens(`${r.runId}.${step}`, DELTAS) })
  )
);
await co.drainSyncs();
process.stdout.write('DONE\n');
await store.close();
conn.end();
