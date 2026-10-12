import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureCoalescer, MeasurementCoalescer, stateAdapter } from './adapters.mjs';
import { verifyRuntime, verifySettings, verifyStateSource } from './prepare.mjs';

if (process.env.BRAINSTRIKE_M0_A1_QUALIFICATION !== '1') {
  throw new Error('Native row validation is held until heavy-slot allocation');
}
const entry = verifyStateSource(process.argv[2]);
const runtime = verifyRuntime(entry);
const { StateStore, Coalescer } = await import(pathToFileURL(entry).href);
configureCoalescer(Coalescer);
const root = mkdtempSync(join(tmpdir(), 'm0-a1-row-'));
const syncs = [];
let store;
let co;
try {
  store = await StateStore.open(root, { onSyncSpan: (span) => syncs.push(span) });
  verifySettings(store.settings);
  const adapter = stateAdapter(store);
  let committed = false;
  await adapter.append(
    [
      /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
        threadId: 'row',
        event:
          /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
            type: 'run.started',
            runId: 'run',
          },
      },
      /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
        threadId: 'row',
        event:
          /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
            type: 'run.finished',
            runId: 'run',
            status: 'complete',
          },
      },
    ],
    () => {
      committed = true;
    }
  );
  assert.equal(committed, true);
  assert.deepEqual(
    (await adapter.read('row')).map((row) => row.seq),
    [1, 2]
  );
  assert.deepEqual(
    (await adapter.read('row', 1)).map((row) => row.seq),
    [2]
  );
  assert.deepEqual(await adapter.read('row', 2), []);
  const delivered = [];
  co = new MeasurementCoalescer(adapter, 20, 'after-commit', (...chunk) => delivered.push(chunk));
  co.push('coalescer', 'run', { type: 'finish-step' });
  co.show('coalescer', 'run', { type: 'finish-step' });
  await co.flush();
  assert.equal(delivered.length, 1);
  const rows = await adapter.read('coalescer');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event.type, 'ui.chunk');
  assert.equal(rows[0].rawCount, 1);
  await co.drainSyncs();
  assert.equal(co.syncFailures.length, 0);
  assert.equal(co.boundarySyncs.length, 1);
  assert.equal(syncs.length, 1);
  assert.equal(syncs[0].thread, 'coalescer');
  assert.deepEqual(
    await store.check(),
    /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
      integrity: 'ok',
      gaps: 0,
    }
  );
  // biome-ignore lint/suspicious/noConsole: CLI result/progress output preserves the measured protocol.
  console.log(
    JSON.stringify(
      /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
        nativeRow: 'pass',
        runtime,
        settings: store.settings,
        kernelTrace: 'not performed',
      }
    )
  );
} finally {
  try {
    if (co) {
      await co.drainSyncs();
    }
  } finally {
    if (store) {
      await store.close();
    }
    rmSync(
      root,
      /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
        recursive: true,
        force: true,
      }
    );
  }
}
