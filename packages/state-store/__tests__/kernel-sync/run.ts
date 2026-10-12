// One streaming run under a kernel tracer (M0-A1 scripts/m0/run.ts, the S candidate): the root and `children` more
// threads each stream `steps` steps of `deltas` text deltas through the Coalescer into the store. Writes the JS-side
// spans (display write spans, boundary sync spans, all on the uv_hrtime clock) to <rawOut> for attribute.mjs.
// usage: node --import tsx run.ts <boundary|sqlite-auto> <rawOut> [children=3] [steps=4] [deltas=500]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Coalescer } from '../../src/coalescer.js';
import { StateStore, type SyncSpan, type WriteSpan } from '../../src/state-store.js';
import { cleanupDirs, freshDir } from '../helpers/fs.js';
import { streamRun } from '../kill/workload.js';

const [mode, rawOut, childrenArg, stepsArg, deltasArg] = process.argv.slice(2) as [
  string,
  string,
  string?,
  string?,
  string?,
];
const walCheckpoint = mode === 'sqlite-auto' ? 'sqlite-auto' : 'boundary';
const CHILDREN = Number(childrenArg ?? 3);
const STEPS = Number(stepsArg ?? 4);
const DELTAS = Number(deltasArg ?? 500);
const clock = (): number => Number(process.hrtime.bigint()) / 1e6;
const body = 'lorem ipsum dolor sit amet, consectetur adipiscing elit. '
  .repeat(Math.ceil((DELTAS * 6) / 57))
  .slice(0, DELTAS * 6);
const pieces = Array.from({ length: DELTAS }, (_, i) => body.slice(i * 6, i * 6 + 6));

const writeSpans: WriteSpan[] = [];
const syncSpans: SyncSpan[] = [];
const store = await StateStore.open(join(freshDir('k'), 'store'), {
  onSyncSpan: (s) => syncSpans.push(s),
  onWriteSpan: (s) => writeSpans.push(s),
  walCheckpoint,
});
const boundariesByThread: Record<string, number> = {};
const co = new Coalescer(store, 20, undefined, {
  onBoundarySyncIssued: (t) => {
    boundariesByThread[t] = (boundariesByThread[t] ?? 0) + 1;
  },
});
const t0 = clock();
await Promise.all(
  ['root', ...Array.from({ length: CHILDREN }, (_, i) => `root/child:C${i}`)].map((threadId, i) =>
    streamRun(co, { runId: `run${i}`, steps: STEPS, text: () => pieces, threadId })
  )
);
await co.drainSyncs();
const t1 = clock();
writeFileSync(
  rawOut,
  JSON.stringify({
    out: {
      boundaries: Object.values(boundariesByThread).reduce((a, b) => a + b, 0),
      boundariesByThread,
      clock: 'uv_hrtime',
      walCheckpoint,
      window: { t0, t1 },
    },
    syncSpans,
    writeSpans,
  })
);
await store.close();
cleanupDirs();
process.stdout.write(
  `M0RUN ${JSON.stringify({ boundaries: syncSpans.length, walCheckpoint, writes: writeSpans.length })}\n`
);
