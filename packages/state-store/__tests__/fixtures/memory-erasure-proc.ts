import { StateStore } from '../../src/state-store.js';
import { TruthIndexer } from '../helpers/truth-indexer.js';
import { MEMORY_ERASURE_THREAD, seedMemoryErasure } from './memory-erasure-seed.js';

const root = process.argv[2];
const calculator = process.argv[3];
if (!(root && calculator)) {
  throw new Error('Owned erasure fixture requires root and calculator');
}
const indexer = new TruthIndexer(root);
const store = await StateStore.open(root, {
  hooks: {
    purgeAfterTruth: () => {
      process.kill(process.pid, 'SIGKILL');
    },
  },
  indexer,
  memoryCalculatorModule: calculator,
});
await seedMemoryErasure(store);
process.stdout.write('memory-seeded\n');
await store.purge(MEMORY_ERASURE_THREAD, 1);
throw new Error('Owned erasure crash point was not reached');
