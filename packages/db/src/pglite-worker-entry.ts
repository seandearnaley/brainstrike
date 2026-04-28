import type { PGliteOptions } from '@electric-sql/pglite';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { worker } from '@electric-sql/pglite/worker';

type BrainstrikePGliteWorkerInitOptions = Pick<PGliteOptions, 'dataDir' | 'relaxedDurability'> & {
  readonly id?: string;
  readonly meta?: unknown;
};

void worker({
  async init(options) {
    const workerOptions = options as BrainstrikePGliteWorkerInitOptions;
    // The worker protocol includes coordination fields; only storage/runtime options belong in PGlite.
    const pgliteOptions: PGliteOptions = {
      extensions: { vector },
    };
    if (workerOptions.dataDir !== undefined) {
      pgliteOptions.dataDir = workerOptions.dataDir;
    }
    if (workerOptions.relaxedDurability !== undefined) {
      pgliteOptions.relaxedDurability = workerOptions.relaxedDurability;
    }
    return new PGlite(pgliteOptions);
  },
});
