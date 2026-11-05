// @ts-check
// The memory calculator: Mastra's memory calculation on its own worker thread (BST-2398), so the writer thread never
// imports or runs it. It opens no database and writes nothing. It receives a resource's snapshot, or its shared
// observation records, and returns the calculated delta; StateStore commits that delta on the writer, against the
// revision the input was read at (memory-calculator.ts).
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { detachThreadObservations } from './memory-detach.mjs';

const port = parentPort;
if (!port) {
  throw new Error('memory-calculator-worker must run on a worker thread');
}
// The configured calculator module (StateStoreOptions.memoryCalculatorModule). A module that fails to load fails this
// worker and any request it holds; the next request starts a fresh worker.
const module = await import(pathToFileURL(String(workerData)).href);

/** @param {{ op: string; [k: string]: unknown }} m */
async function handle(m) {
  if (m.op === 'calculate') {
    if (typeof module.calculateMemoryMutation !== 'function') {
      throw new Error('Configured native memory calculator is unavailable');
    }
    const calculate = /** @type {import('./memory-types.ts').MemoryNativeCalculator} */ (
      module.calculateMemoryMutation
    );
    return {
      calculation: await calculate(
        /** @type {import('./memory-types.ts').MemorySnapshot} */ (m['snapshot']),
        /** @type {import('./memory-types.ts').MemoryNativeRequest} */ (m['request'])
      ),
    };
  }
  if (m.op === 'detach') {
    // Mastra OM's observation token counter recounts each text it changes; a record that needs no recount needs none.
    const count =
      typeof module.countObservationTokens === 'function'
        ? /** @type {import('./memory-types.ts').ObservationTokenCounter} */ (
            module.countObservationTokens
          )
        : undefined;
    const shared = /** @type {import('./memory-types.ts').MemorySharedObservations[]} */ (
      m['shared']
    );
    return {
      detached: shared.map((entry) => ({
        ...entry,
        records: detachThreadObservations(entry.records, String(m['threadId']), count),
      })),
    };
  }
  throw new Error(`unknown memory calculator op ${m.op}`);
}

port.on('message', (/** @type {{ op: string; id: number }} */ m) => {
  handle(m).then(
    (result) => port.postMessage({ id: m.id, ...result }),
    (cause) => port.postMessage({ error: String(cause?.stack ?? cause), id: m.id })
  );
});
